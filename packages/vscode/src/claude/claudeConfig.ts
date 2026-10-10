/**
 * Settings > Agents / Commands / Skills / Plugins: reads and writes the Claude Code config files on disk
 * (docs/SETTINGS_USAGE_SPEC.md sections 1 and 2.3). vscode-free: the host injects `trash`.
 *
 * - User items live in `<home>/.claude/{agents,commands,skills}`, project items in `<cwd>/.claude/...`
 *   (skipped when the workspace is the home directory).
 * - Enabled plugins contribute read-only items (`<plugin>:<name>`).
 * - Writes are atomic (tmp file + rename) and keep unknown frontmatter keys and comments.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { Document, isMap, parseDocument } from 'yaml';
import type { ClaudeRequestPayload } from '@openchamber/ui/src/lib/claude/protocol';
import {
  AGENT_COLORS,
  CONFIG_FIELDS,
  CONFIG_NAME_PATTERN,
  EFFORT_LEVELS,
  type ConfigField,
  type ConfigItem,
  type ConfigItemDetail,
  type ConfigItemKind,
  type ConfigScope,
  type ConfigSnapshot,
  type MarketplaceInfo,
  type PluginInfo,
} from '@openchamber/ui/src/lib/claude/types';
import { claudekeiConfigPaths } from './claudekeiConfig';

export type ConfigFsOptions = { cwd: string; home?: string; trash?: (absPath: string) => Promise<void> };

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_FILES = 200;
const MAX_WALK_DEPTH = 6;
/** Agents nest at most this many levels below `agents/` (`agents/a/b/c.md` is depth 3). */
const MAX_AGENT_DEPTH = 3;
const KIND_DIRS: Record<ConfigItemKind, string> = { agent: 'agents', command: 'commands', skill: 'skills' };
const DIR_KINDS: Record<string, ConfigItemKind> = { agents: 'agent', commands: 'command', skills: 'skill' };

type Root = { scope: ConfigScope; dir: string };

// ---------------------------------------------------------------------------
// Small fs helpers
// ---------------------------------------------------------------------------

const homeOf = (o: ConfigFsOptions): string => o.home ?? homedir();

const isInside = (base: string, target: string): boolean => {
  const rel = relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** `realpath`, tolerating a missing tail: the nearest existing ancestor is resolved and the rest appended. */
async function realpathLoose(path: string): Promise<string> {
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

async function sameDir(a: string, b: string): Promise<boolean> {
  return (await realpathLoose(a)) === (await realpathLoose(b));
}

async function readJson(path: string): Promise<unknown> {
  try {
    return parseJsonc(await fs.readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

async function writeFileAtomic(file: string, content: string): Promise<void> {
  // Write through a symlinked file so the link itself survives the rename.
  let dest = file;
  try {
    dest = await fs.realpath(file);
  } catch {
    // new file
  }
  await fs.mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, dest);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

export const defaultTrash = (absPath: string): Promise<void> => fs.rm(absPath, { recursive: true, force: true });

// ---------------------------------------------------------------------------
// Roots, plugins, marketplaces
// ---------------------------------------------------------------------------

/** User root first, then the project root unless the workspace is the home directory. */
export async function resolveConfigRoots(o: ConfigFsOptions): Promise<Root[]> {
  const roots: Root[] = [{ scope: 'user', dir: join(homeOf(o), '.claude') }];
  if (o.cwd && !(await sameDir(o.cwd, homeOf(o)))) roots.push({ scope: 'project', dir: join(o.cwd, '.claude') });
  return roots;
}

async function readEnabledPlugins(o: ConfigFsOptions): Promise<Record<string, boolean>> {
  const files = [
    join(homeOf(o), '.claude', 'settings.json'),
    join(o.cwd, '.claude', 'settings.json'),
    join(o.cwd, '.claude', 'settings.local.json'),
  ];
  const merged: Record<string, boolean> = {};
  for (const file of files) {
    const enabled = asRecord(asRecord(await readJson(file))?.enabledPlugins);
    if (!enabled) continue;
    for (const [id, value] of Object.entries(enabled)) if (typeof value === 'boolean') merged[id] = value;
  }
  return merged;
}

const SCOPE_PRECEDENCE: PluginInfo['scope'][] = ['local', 'project', 'user'];

async function listPlugins(o: ConfigFsOptions): Promise<PluginInfo[]> {
  const installed = asRecord(asRecord(await readJson(join(homeOf(o), '.claude', 'plugins', 'installed_plugins.json')))?.plugins);
  if (!installed) return [];
  const enabledMap = await readEnabledPlugins(o);
  const plugins: PluginInfo[] = [];
  for (const [id, installs] of Object.entries(installed)) {
    if (!Array.isArray(installs)) continue;
    const candidates: Array<{ scope: PluginInfo['scope']; installPath: string; version?: string }> = [];
    for (const raw of installs) {
      const install = asRecord(raw);
      const scope = install?.scope;
      const installPath = asString(install?.installPath);
      if (!install || !installPath || (scope !== 'user' && scope !== 'project' && scope !== 'local')) continue;
      const projectPath = asString(install.projectPath);
      if (scope !== 'user' && !(projectPath && (await sameDir(projectPath, o.cwd)))) continue;
      candidates.push({ scope, installPath, version: asString(install.version) });
    }
    // The most specific install wins (local > project > user), like Claude Code.
    candidates.sort((a, b) => SCOPE_PRECEDENCE.indexOf(a.scope) - SCOPE_PRECEDENCE.indexOf(b.scope));
    const pick = candidates[0];
    if (!pick) continue;
    const at = id.lastIndexOf('@');
    const manifest = asRecord(await readJson(join(pick.installPath, '.claude-plugin', 'plugin.json')));
    plugins.push({
      id,
      name: asString(manifest?.name) ?? (at > 0 ? id.slice(0, at) : id),
      marketplace: at > 0 ? id.slice(at + 1) : '',
      version: asString(manifest?.version) ?? pick.version,
      description: asString(manifest?.description),
      scope: pick.scope,
      enabled: enabledMap[id] === true,
      installPath: pick.installPath,
    });
  }
  return plugins.sort((a, b) => a.id.localeCompare(b.id));
}

async function listMarketplaces(o: ConfigFsOptions): Promise<MarketplaceInfo[]> {
  const known = asRecord(await readJson(join(homeOf(o), '.claude', 'plugins', 'known_marketplaces.json')));
  if (!known) return [];
  const result: MarketplaceInfo[] = [];
  for (const [name, raw] of Object.entries(known)) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const source = asRecord(entry.source);
    const sourceText =
      source?.source === 'github'
        ? asString(source.repo)
        : source?.source === 'directory'
          ? asString(source.path)
          : asString(source?.url);
    const updated = typeof entry.lastUpdated === 'string' ? Date.parse(entry.lastUpdated) : Number.NaN;
    result.push({
      name,
      source: sourceText ?? '',
      installLocation: asString(entry.installLocation) ?? '',
      lastUpdated: Number.isNaN(updated) ? undefined : updated,
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Path classification and guards
// ---------------------------------------------------------------------------

type Classified = { kind: ConfigItemKind; /** Default invocation name (basename / skill dir). */ name: string; group?: string };

/** Classifies a path relative to a config root / plugin install (segments), or `undefined` when it is not an item. */
function classify(segments: string[], plugin: boolean): Classified | undefined {
  const kind = DIR_KINDS[segments[0] ?? ''];
  if (!kind || segments.some((s) => !s || s.startsWith('.'))) return undefined;
  const last = segments[segments.length - 1]!;
  if (kind === 'skill') {
    return segments.length === 3 && last === 'SKILL.md' ? { kind, name: segments[1]! } : undefined;
  }
  if (!last.endsWith('.md') || last.length <= 3) return undefined;
  const name = last.slice(0, -3);
  if (kind === 'agent') {
    const depth = segments.length - 1;
    return depth >= 1 && depth <= (plugin ? 1 : MAX_AGENT_DEPTH) ? { kind, name } : undefined;
  }
  if (segments.length > MAX_WALK_DEPTH) return undefined;
  const group = segments.length > 2 ? segments.slice(1, -1).join('/') : undefined;
  return { kind, name, group };
}

type Located = {
  kind: ConfigItemKind;
  name: string;
  group?: string;
  /** Normalized absolute item path. */
  path: string;
  /** Where the item came from: a config root or an enabled plugin. */
  origin: { type: 'root'; root: Root } | { type: 'plugin'; plugin: PluginInfo };
  /** Path inside which the real path must stay. */
  allowedBase: string;
};

/**
 * Resolves `path` against the user/project roots (and enabled plugin install paths when `allowPlugins`), rejecting
 * anything that is not a config item and symlinks escaping the item's directory. A symlinked skill directory (as
 * created by `npx skills`) is allowed: it is the item's own base. A symlinked agent / command file must resolve
 * inside the config root (the user's own root may also symlink whole directories).
 */
async function locate(o: ConfigFsOptions, path: string, allowPlugins: boolean): Promise<Located> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Path must be absolute');
  const abs = resolve(path);
  const candidates: Array<{ base: string; origin: Located['origin'] }> = (await resolveConfigRoots(o)).map((root) => ({
    base: root.dir,
    origin: { type: 'root', root },
  }));
  if (allowPlugins) {
    for (const plugin of (await listPlugins(o)).filter((p) => p.enabled)) {
      candidates.push({ base: plugin.installPath, origin: { type: 'plugin', plugin } });
    }
  }
  for (const { base, origin } of candidates) {
    if (!isInside(base, abs) || abs === base) continue;
    const segments = relative(base, abs).split(sep);
    const info = classify(segments, origin.type === 'plugin');
    if (!info) continue;
    const kindDir = join(base, segments[0]!);
    // The user's own config may symlink whole directories (dotfiles). A project or plugin is untrusted: nothing may
    // resolve outside its config root, not even through a symlinked agents/commands directory.
    const trusted = origin.type === 'root' && origin.root.scope === 'user';
    let allowedBase = info.kind === 'skill' || trusted ? await realpathLoose(kindDir) : await realpathLoose(base);
    if (info.kind === 'skill') {
      // Only skills may be symlinks (`npx skills` links the skill directory): that directory is the item's own base.
      // A symlinked agents/commands *file* stays subject to the check below, so it cannot expose files elsewhere.
      try {
        const anchor = join(kindDir, segments[1]!);
        if ((await fs.lstat(anchor)).isSymbolicLink()) allowedBase = await fs.realpath(anchor);
      } catch {
        // missing anchor: keep the kind directory as the base
      }
    }
    if (!isInside(allowedBase, await realpathLoose(abs))) throw new Error(`Path escapes the config directory: ${path}`);
    return { ...info, path: abs, origin, allowedBase };
  }
  throw new Error(`Not a Claude config item path: ${path}`);
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

type Parsed = {
  /** `undefined` when the file has no frontmatter block. */
  doc?: Document;
  body: string;
  error?: string;
};

function splitFrontmatter(text: string): { yaml?: string; body: string } {
  const content = text.replace(/^﻿/, '');
  const open = content.match(/^---[ \t]*\r?\n/);
  if (!open) return { body: content };
  const rest = content.slice(open[0].length);
  const close = rest.match(/^---[ \t]*(?:\r?\n|$)/m);
  if (!close || close.index === undefined) return { body: content };
  return { yaml: rest.slice(0, close.index), body: rest.slice(close.index + close[0].length) };
}

function parseMarkdown(text: string): Parsed {
  const { yaml, body } = splitFrontmatter(text);
  const trimmedBody = body.replace(/^\s+/, '');
  if (yaml === undefined) return { body: trimmedBody };
  const doc = parseDocument(yaml, { prettyErrors: false });
  if (doc.errors.length > 0) return { doc, body: trimmedBody, error: `Invalid YAML frontmatter: ${doc.errors[0]!.message.split('\n')[0]}` };
  if (doc.contents !== null && !isMap(doc.contents)) return { doc, body: trimmedBody, error: 'Frontmatter must be a YAML mapping' };
  return { doc, body: trimmedBody };
}

function scalarText(value: unknown): string {
  if (Array.isArray(value)) return value.map(scalarText).filter(Boolean).join(', ');
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  return String(value).trim();
}

function frontmatterObject(doc: Document | undefined): Record<string, unknown> {
  if (!doc || !isMap(doc.contents)) return {};
  const json = doc.toJSON();
  return asRecord(json) ?? {};
}

function fieldsOf(kind: ConfigItemKind, data: Record<string, unknown>): Partial<Record<ConfigField, string>> {
  const fields: Partial<Record<ConfigField, string>> = {};
  for (const field of CONFIG_FIELDS[kind]) {
    if (!(field in data)) continue;
    const text = scalarText(data[field]);
    if (text) fields[field] = text;
  }
  return fields;
}

function otherKeysOf(kind: ConfigItemKind, data: Record<string, unknown>): string[] {
  const known = new Set<string>(['name', ...CONFIG_FIELDS[kind]]);
  return Object.keys(data).filter((key) => !known.has(key));
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

type ItemSource = Pick<ConfigItem, 'source' | 'plugin'> & { prefix?: string };

async function readItemFile(path: string, kind: ConfigItemKind, defaults: Classified, src: ItemSource): Promise<{ item: ConfigItem; parsed: Parsed }> {
  let parsed: Parsed = { body: '' };
  let error: string | undefined;
  try {
    const stat = await fs.stat(path);
    if (stat.size > MAX_FILE_BYTES) throw new Error('File is too large');
    parsed = parseMarkdown(await fs.readFile(path, 'utf8'));
    error = parsed.error;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const data = frontmatterObject(parsed.doc);
  const name = kind === 'skill' ? defaults.name : scalarText(data.name) || defaults.name;
  const item: ConfigItem = {
    kind,
    name: src.prefix ? `${src.prefix}:${name}` : name,
    source: src.source,
    description: scalarText(data.description),
    path,
  };
  if (src.plugin) item.plugin = src.plugin;
  if (defaults.group) item.group = defaults.group;
  if (error) item.error = error;
  return { item, parsed };
}

/** Walks `dir` collecting files whose path (relative to `base`) classifies as an item. */
async function walkItems(base: string, kindDir: string, plugin: boolean, trusted: boolean): Promise<Array<{ path: string; info: Classified }>> {
  const found: Array<{ path: string; info: Classified }> = [];
  // Agent / command files must resolve inside the config root (the user's own root may symlink whole directories),
  // so a repository cannot list - and thereby read - files elsewhere through a symlink.
  const limit = await realpathLoose(trusted ? join(base, kindDir) : base);
  const walk = async (dir: string, segments: string[]): Promise<void> => {
    if (segments.length > MAX_WALK_DEPTH) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      const next = [...segments, entry.name];
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        // Skill directories are commonly symlinks (`npx skills`); elsewhere only files are followed.
        const stat = await fs.stat(full).catch(() => undefined);
        isDir = !!stat?.isDirectory() && kindDir === 'skills' && segments.length === 1;
        isFile = !!stat?.isFile();
      }
      if (isDir) {
        if (kindDir === 'skills') {
          if (segments.length === 1) {
            const skillMd = join(full, 'SKILL.md');
            const info = classify([...next, 'SKILL.md'], plugin);
            if (info && (await fs.stat(skillMd).then((s) => s.isFile(), () => false))) found.push({ path: skillMd, info });
          }
        } else {
          await walk(full, next);
        }
      } else if (isFile && kindDir !== 'skills') {
        const info = classify(relative(base, full).split(sep), plugin);
        if (info && isInside(limit, await realpathLoose(full))) found.push({ path: full, info });
      }
    }
  };
  await walk(join(base, kindDir), [kindDir]);
  return found;
}

async function scanBase(base: string, source: ItemSource, plugin: boolean, trusted: boolean): Promise<ConfigItem[]> {
  const items: ConfigItem[] = [];
  for (const kindDir of Object.keys(DIR_KINDS)) {
    for (const { path, info } of await walkItems(base, kindDir, plugin, trusted)) {
      items.push((await readItemFile(path, info.kind, info, source)).item);
    }
  }
  return items;
}

const SOURCE_ORDER: Record<ConfigItem['source'], number> = { project: 0, user: 1, plugin: 2 };

export async function listConfig(o: ConfigFsOptions): Promise<ConfigSnapshot> {
  const roots = await resolveConfigRoots(o);
  const plugins = await listPlugins(o);
  const items: ConfigItem[] = [];
  for (const root of roots) items.push(...(await scanBase(root.dir, { source: root.scope }, false, root.scope === 'user')));
  for (const plugin of plugins.filter((p) => p.enabled)) {
    items.push(...(await scanBase(plugin.installPath, { source: 'plugin', plugin: plugin.id, prefix: plugin.name }, true, false)));
  }
  const projectKeys = new Set(items.filter((i) => i.source === 'project').map((i) => `${i.kind}:${i.name}`));
  for (const item of items) if (item.source === 'user' && projectKeys.has(`${item.kind}:${item.name}`)) item.shadowed = true;
  items.sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  const [userFile, projectFile] = claudekeiConfigPaths({ cwd: o.cwd, home: homeOf(o) });
  const claudekeiFiles: ConfigSnapshot['claudekeiFiles'] = [{ scope: 'user', path: userFile!, exists: await exists(userFile!) }];
  if (roots.some((r) => r.scope === 'project')) claudekeiFiles.push({ scope: 'project', path: projectFile!, exists: await exists(projectFile!) });
  const mcpPath = join(o.cwd, '.mcp.json');
  return {
    items,
    plugins,
    marketplaces: await listMarketplaces(o),
    claudekeiFiles,
    projectMcpFile: { path: mcpPath, exists: await exists(mcpPath) },
  };
}

async function listSkillFiles(skillDir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || files.length >= MAX_SKILL_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_SKILL_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && !(depth === 0 && entry.name === 'SKILL.md')) files.push(full);
    }
  };
  await walk(skillDir, 0);
  return files;
}

export async function readConfigItem(o: ConfigFsOptions, path: string): Promise<ConfigItemDetail> {
  const located = await locate(o, path, true);
  const source: ItemSource =
    located.origin.type === 'root'
      ? { source: located.origin.root.scope }
      : { source: 'plugin', plugin: located.origin.plugin.id, prefix: located.origin.plugin.name };
  const { item, parsed } = await readItemFile(located.path, located.kind, located, source);
  const data = frontmatterObject(parsed.doc);
  const detail: ConfigItemDetail = {
    ...item,
    fields: fieldsOf(located.kind, data),
    otherKeys: otherKeysOf(located.kind, data),
    body: parsed.body,
  };
  if (located.kind === 'skill') detail.files = await listSkillFiles(dirname(located.path));
  return detail;
}

// ---------------------------------------------------------------------------
// Save / delete
// ---------------------------------------------------------------------------

type SaveRequest = ClaudeRequestPayload<'claude:config.save'>;

function validateSave(req: SaveRequest): void {
  if (!(req.kind in CONFIG_FIELDS)) throw new Error(`Unknown kind "${String(req.kind)}"`);
  if (req.scope !== 'user' && req.scope !== 'project') throw new Error(`Unknown scope "${String(req.scope)}"`);
  if (typeof req.name !== 'string' || !CONFIG_NAME_PATTERN.test(req.name)) {
    throw new Error('Name must be lowercase letters, digits and dashes (max 64 characters, starting with a letter or digit)');
  }
  const allowed = CONFIG_FIELDS[req.kind] as readonly string[];
  const fields = req.fields ?? {};
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) throw new Error(`Field "${key}" is not supported for ${req.kind}`);
    if (typeof value !== 'string') throw new Error(`Field "${key}" must be a string`);
  }
  const effort = fields.effort?.trim();
  if (effort && !(EFFORT_LEVELS as readonly string[]).includes(effort)) throw new Error(`Invalid effort "${effort}"`);
  const color = fields.color?.trim();
  if (color && !(AGENT_COLORS as readonly string[]).includes(color)) throw new Error(`Invalid color "${color}"`);
  if (typeof req.body !== 'string') throw new Error('Body must be a string');
  if (Buffer.byteLength(req.body, 'utf8') > MAX_BODY_BYTES) throw new Error('Body is larger than 1 MB');
}

function targetPath(root: Root, kind: ConfigItemKind, name: string): string {
  const base = join(root.dir, KIND_DIRS[kind]);
  return kind === 'skill' ? join(base, name, 'SKILL.md') : join(base, `${name}.md`);
}

function applyFields(doc: Document, req: SaveRequest): void {
  const current = frontmatterObject(doc);
  for (const field of CONFIG_FIELDS[req.kind]) {
    if (!(field in (req.fields ?? {}))) continue;
    const next = req.fields[field]!.trim();
    // Untouched values keep their original YAML form (e.g. a `tools:` list).
    if (next === scalarText(current[field])) continue;
    if (next === '') doc.delete(field);
    else doc.set(field, next);
  }
}

function renderMarkdown(doc: Document, body: string): string {
  const empty = !isMap(doc.contents) || doc.contents.items.length === 0;
  const frontmatter = empty ? '' : doc.toString({ lineWidth: 0 });
  return `---\n${frontmatter}---\n\n${body.replace(/^\s+/, '')}`;
}

export async function saveConfigItem(o: ConfigFsOptions, req: SaveRequest): Promise<ConfigItem> {
  validateSave(req);
  const root = (await resolveConfigRoots(o)).find((r) => r.scope === req.scope);
  if (!root) throw new Error('Project scope is not available when the workspace is the home directory');
  const file = targetPath(root, req.kind, req.name);
  const located = await locate(o, file, false);
  const existing = req.kind === 'skill' ? await exists(dirname(file)) : await exists(file);
  if (req.create && existing) throw new Error(`${req.kind} ${req.name} already exists in ${req.scope}`);
  if (!req.create && !(await exists(file))) throw new Error(`${req.kind} ${req.name} does not exist in ${req.scope}`);

  let doc: Document;
  if (req.create) {
    doc = new Document({});
    if (req.kind !== 'command') doc.set('name', req.name);
  } else {
    const parsed = parseMarkdown(await fs.readFile(file, 'utf8'));
    if (parsed.error) throw new Error(`Cannot save: ${parsed.error}`);
    doc = parsed.doc ?? new Document({});
  }
  applyFields(doc, req);
  if (req.kind !== 'command' && !scalarText(frontmatterObject(doc).description)) throw new Error('Description is required');
  await writeFileAtomic(located.path, renderMarkdown(doc, req.body));

  const source: ItemSource = { source: req.scope };
  const info: Classified = { kind: req.kind, name: req.name };
  const { item } = await readItemFile(located.path, req.kind, info, source);
  if (req.scope === 'user') {
    const project = (await resolveConfigRoots(o)).find((r) => r.scope === 'project');
    if (project && (await exists(targetPath(project, req.kind, req.name)))) item.shadowed = true;
  }
  return item;
}

export async function deleteConfigItem(o: ConfigFsOptions, path: string): Promise<void> {
  const located = await locate(o, path, false);
  if (!(await exists(located.path))) throw new Error(`Not found: ${path}`);
  const trash = o.trash ?? defaultTrash;
  await trash(located.kind === 'skill' ? dirname(located.path) : located.path);
}
