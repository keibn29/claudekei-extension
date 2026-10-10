/**
 * Skills catalog: scan a git repository (HTTPS only) for `SKILL.md` directories and install selected ones into
 * `~/.claude/skills` or `<cwd>/.claude/skills` (docs/SETTINGS_USAGE_SPEC.md section 3). vscode-free.
 *
 * Uses the `git` CLI (shallow, blobless, sparse checkout) instead of the GitHub API: no auth, no rate limits.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ClaudeRequestPayload } from '@openchamber/ui/src/lib/claude/protocol';
import { CONFIG_NAME_PATTERN, type ConfigScope, type SkillCatalogItem } from '@openchamber/ui/src/lib/claude/types';
import { defaultTrash, resolveConfigRoots, type ConfigFsOptions } from './claudeConfig';

export type SkillsCatalogOptions = ConfigFsOptions & {
  env: Record<string, string | undefined>;
  runGit?: (args: string[], cwd?: string) => Promise<{ stdout: string }>;
  /** Tests only: accept `file://` sources. */
  allowFileUrls?: boolean;
};

const DEFAULT_SOURCE = 'anthropics/skills';
const CATALOG_TTL_MS = 30 * 60 * 1000;
const GIT_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
const MAX_SKILL_DIRS = 200;

type ParsedSource = { cloneUrl: string; subpath: string; key: string };

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

/** Validates a repo-relative POSIX directory path; returns the cleaned path or throws. */
function cleanSubpath(raw: string): string {
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p === '.' || p.startsWith('-') || p.includes('\\') || p.includes('\0'))) {
    throw new Error(`Invalid repository subpath: ${raw}`);
  }
  return parts.join('/');
}

/**
 * Accepts `owner/repo[/subpath]`, `https://github.com/owner/repo` and any other `https://` git URL.
 * SSH and plain `http://` are rejected; `file://` only when `allowFileUrls` (tests).
 */
export function parseSkillsSource(input: string | undefined, allowFileUrls = false): ParsedSource {
  const raw = (input ?? '').trim() || DEFAULT_SOURCE;
  if (/^(git@|ssh:|git\+ssh:)/i.test(raw)) {
    throw new Error('SSH sources are not supported. Use an https:// URL or owner/repo.');
  }
  const url = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (url) {
    const scheme = url[1]!.toLowerCase();
    if (scheme === 'file' && allowFileUrls) return { cloneUrl: raw, subpath: '', key: `${raw}::` };
    if (scheme !== 'https') throw new Error('Only https:// repository URLs are supported.');
    const github = raw.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i);
    if (github) return githubSource(github[1]!, github[2]!, '');
    return { cloneUrl: raw, subpath: '', key: `${raw}::` };
  }
  const shorthand = raw.match(/^([A-Za-z0-9_][A-Za-z0-9_.-]*)\/([A-Za-z0-9_][A-Za-z0-9_.-]*?)(?:\.git)?(?:\/(.+))?$/);
  if (!shorthand) throw new Error('Unsupported repository source. Use owner/repo[/subpath] or an https:// URL.');
  return githubSource(shorthand[1]!, shorthand[2]!, shorthand[3] ? cleanSubpath(shorthand[3]) : '');
}

function githubSource(owner: string, repo: string, subpath: string): ParsedSource {
  const normalized = `${owner}/${repo}`;
  // The curated default repository keeps its skills under `skills/`.
  const effective = subpath || (normalized.toLowerCase() === DEFAULT_SOURCE ? 'skills' : '');
  return { cloneUrl: `https://github.com/${normalized}.git`, subpath: effective, key: `${normalized.toLowerCase()}::${effective}` };
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

const AUTH_ERROR = /authentication failed|could not read (username|password)|terminal prompts disabled|repository not found|permission denied|publickey|403|401/i;

function defaultRunGit(env: Record<string, string | undefined>) {
  return (args: string[], cwd?: string): Promise<{ stdout: string }> =>
    new Promise((resolvePromise, reject) => {
      execFile(
        'git',
        args,
        { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
        (error, stdout, stderr) => {
          if (error) {
            const withCode = error as NodeJS.ErrnoException & { stderr?: string };
            reject(new Error(withCode.code === 'ENOENT' ? 'Git is not available in PATH' : String(stderr || withCode.message).trim()));
            return;
          }
          resolvePromise({ stdout: String(stdout) });
        },
      );
    });
}

type Git = (args: string[], cwd?: string) => Promise<string>;

function makeGit(o: SkillsCatalogOptions): Git {
  const run = o.runGit ?? defaultRunGit(o.env);
  return async (args, cwd) => (await run(args, cwd)).stdout;
}

const gitErrorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function cloneRepo(git: Git, source: ParsedSource, dir: string): Promise<void> {
  const base = ['clone', '--depth', '1', '--no-checkout'];
  try {
    await git([...base, '--filter=blob:none', '--', source.cloneUrl, dir]);
  } catch (first) {
    try {
      await git([...base, '--', source.cloneUrl, dir]);
    } catch (second) {
      const message = gitErrorMessage(second) || gitErrorMessage(first);
      if (AUTH_ERROR.test(message)) {
        throw new Error('Private repositories are not supported (or the repository does not exist).');
      }
      throw new Error(message || 'Failed to clone repository');
    }
  }
}

/** Escapes characters that are special in sparse-checkout (gitignore-style) patterns. */
const escapePattern = (path: string): string => `/${path.replace(/[\\*?[\]!# ]/g, (c) => `\\${c}`)}`;

async function sparseCheckout(git: Git, dir: string, mode: 'files' | 'dirs', paths: string[]): Promise<void> {
  if (mode === 'files') {
    await git(['-C', dir, 'sparse-checkout', 'set', '--no-cone', ...paths.map(escapePattern)]);
  } else {
    try {
      await git(['-C', dir, 'sparse-checkout', 'set', '--cone', ...paths]);
    } catch {
      await git(['-C', dir, 'sparse-checkout', 'init', '--cone']);
      await git(['-C', dir, 'sparse-checkout', 'set', ...paths]);
    }
  }
  await git(['-C', dir, 'checkout', '--force', 'HEAD']);
}

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

type RawSkill = { dir: string; name: string; description?: string; installable: boolean; warning?: string };

const cache = new Map<string, { expiresAt: number; items: RawSkill[] }>();

/** Drops the in-memory catalog cache (tests). */
export function clearSkillsCatalogCache(): void {
  cache.clear();
}

function readFrontmatter(text: string): { description?: string; warning?: string } {
  const match = text.replace(/^﻿/, '').match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { warning: 'SKILL.md has no YAML frontmatter' };
  try {
    const parsed: unknown = parseYaml(match[1]!);
    const description = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).description : undefined;
    return { description: typeof description === 'string' ? description.trim() || undefined : undefined };
  } catch {
    return { warning: 'SKILL.md frontmatter is not valid YAML' };
  }
}

async function scanRepo(git: Git, source: ParsedSource): Promise<RawSkill[]> {
  return withTempDir('claudekei-skills-scan-', async (dir) => {
    await cloneRepo(git, source, dir);
    const listing = await git(['-C', dir, 'ls-tree', '-r', '-z', '--name-only', 'HEAD']);
    const prefix = source.subpath ? `${source.subpath}/` : '';
    const skillDirs = listing
      .split('\0')
      .filter((p) => p.endsWith('/SKILL.md') && p.startsWith(prefix))
      .map((p) => p.slice(0, -'/SKILL.md'.length))
      .sort()
      .slice(0, MAX_SKILL_DIRS);
    if (skillDirs.length === 0) return [];
    await sparseCheckout(git, dir, 'files', skillDirs.map((d) => `${d}/SKILL.md`));

    const items: RawSkill[] = [];
    for (const skillDir of skillDirs) {
      const name = basename(skillDir);
      let text = '';
      try {
        text = await fs.readFile(join(dir, ...skillDir.split('/'), 'SKILL.md'), 'utf8');
      } catch {
        text = '';
      }
      const front = readFrontmatter(text);
      const installable = CONFIG_NAME_PATTERN.test(name);
      const warning = !installable ? `"${name}" is not a valid skill directory name (lowercase letters, digits, dashes)` : front.warning;
      items.push({ dir: skillDir, name, description: front.description, installable, ...(warning ? { warning } : {}) });
    }
    return items.sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir));
  });
}

async function installedScopes(roots: Awaited<ReturnType<typeof resolveConfigRoots>>, name: string): Promise<ConfigScope[]> {
  const scopes: ConfigScope[] = [];
  for (const root of roots) {
    const found = await fs.lstat(join(root.dir, 'skills', name)).then(() => true, () => false);
    if (found) scopes.push(root.scope);
  }
  return scopes;
}

export async function scanSkillsSource(
  o: SkillsCatalogOptions,
  source?: string,
  refresh?: boolean,
): Promise<{ source: string; items: SkillCatalogItem[] }> {
  const parsed = parseSkillsSource(source, o.allowFileUrls);
  const shown = (source ?? '').trim() || DEFAULT_SOURCE;
  let entry = cache.get(parsed.key);
  if (refresh || !entry || entry.expiresAt <= Date.now()) {
    entry = { expiresAt: Date.now() + CATALOG_TTL_MS, items: await scanRepo(makeGit(o), parsed) };
    cache.set(parsed.key, entry);
  }
  const items: SkillCatalogItem[] = [];
  const roots = await resolveConfigRoots(o);
  for (const raw of entry.items) items.push({ ...raw, installed: await installedScopes(roots, raw.name) });
  return { source: shown, items };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/** Copies `src` to `dst`, rejecting symlinks and anything whose real path leaves the source tree. */
async function copySkillDir(src: string, dst: string): Promise<void> {
  const srcReal = await fs.realpath(src);
  const walk = async (from: string, to: string): Promise<void> => {
    await fs.mkdir(to, { recursive: true });
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      const nextFrom = join(from, entry.name);
      const nextTo = join(to, entry.name);
      const stat = await fs.lstat(nextFrom);
      if (stat.isSymbolicLink()) throw new Error('Symlinks are not supported in skills');
      const rel = relative(srcReal, await fs.realpath(nextFrom));
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid path in skill (outside the skill directory)');
      if (stat.isDirectory()) await walk(nextFrom, nextTo);
      else if (stat.isFile()) {
        await fs.copyFile(nextFrom, nextTo);
        await fs.chmod(nextTo, stat.mode & 0o777).catch(() => undefined);
      }
    }
  };
  await walk(src, dst);
}

export async function installSkills(
  o: SkillsCatalogOptions,
  req: ClaudeRequestPayload<'claude:skills.install'>,
): Promise<{ installed: string[]; skipped: Array<{ name: string; reason: string }> }> {
  const parsed = parseSkillsSource(req.source, o.allowFileUrls);
  if (req.scope !== 'user' && req.scope !== 'project') throw new Error(`Unknown scope "${String(req.scope)}"`);
  const root = (await resolveConfigRoots(o)).find((r) => r.scope === req.scope);
  if (!root) throw new Error('Project scope is not available when the workspace is the home directory');
  if (!Array.isArray(req.dirs) || req.dirs.length === 0) throw new Error('No skills selected');

  const installed: string[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const plans: Array<{ dir: string; name: string }> = [];
  const seen = new Set<string>();
  for (const raw of req.dirs) {
    let dir: string;
    try {
      dir = cleanSubpath(String(raw));
    } catch {
      skipped.push({ name: String(raw), reason: 'Invalid skill directory' });
      continue;
    }
    const name = basename(dir);
    if (!dir || !CONFIG_NAME_PATTERN.test(name)) skipped.push({ name: name || String(raw), reason: 'Invalid skill name' });
    else if (seen.has(name)) skipped.push({ name, reason: 'Duplicate skill name in selection' });
    else {
      seen.add(name);
      plans.push({ dir, name });
    }
  }
  // Skip existing targets up front so a repo that is only partly selected still clones once.
  const targetsDir = join(root.dir, 'skills');
  const toInstall: typeof plans = [];
  for (const plan of plans) {
    const exists = await fs.lstat(join(targetsDir, plan.name)).then(() => true, () => false);
    if (exists && !req.overwrite) skipped.push({ name: plan.name, reason: 'Already installed' });
    else toInstall.push(plan);
  }
  if (toInstall.length === 0) return { installed, skipped };

  const git = makeGit(o);
  const trash = o.trash ?? defaultTrash;
  await withTempDir('claudekei-skills-install-', async (dir) => {
    await cloneRepo(git, parsed, dir);
    await sparseCheckout(git, dir, 'dirs', toInstall.map((p) => p.dir));
    const dirReal = await fs.realpath(dir);
    await fs.mkdir(targetsDir, { recursive: true });

    for (const { dir: skillDir, name } of toInstall) {
      const src = join(dir, ...skillDir.split('/'));
      const staging = join(targetsDir, `.${name}.${process.pid}.${randomBytes(4).toString('hex')}.installing`);
      try {
        const srcStat = await fs.lstat(src).catch(() => undefined);
        if (!srcStat?.isDirectory()) {
          skipped.push({ name, reason: 'Directory not found in repository' });
          continue;
        }
        const rel = relative(dirReal, await fs.realpath(src));
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid skill path');
        const skillMd = await fs.lstat(join(src, 'SKILL.md')).catch(() => undefined);
        if (!skillMd?.isFile()) {
          skipped.push({ name, reason: 'SKILL.md not found' });
          continue;
        }
        await copySkillDir(src, staging);
        const target = join(targetsDir, name);
        if (await fs.lstat(target).then(() => true, () => false)) await trash(target);
        await fs.rename(staging, target);
        installed.push(name);
      } catch (error) {
        skipped.push({ name, reason: gitErrorMessage(error) });
      } finally {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  });
  return { installed, skipped };
}
