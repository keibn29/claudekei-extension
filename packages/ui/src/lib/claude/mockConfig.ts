/**
 * Mock handlers and fixtures for the Settings / Usage requests (docs/SETTINGS_USAGE_SPEC.md 2.2):
 * config items (agents / commands / skills), plugins, MCP servers, the skills catalog and usage activity.
 * State is in memory and mutated by save / delete / toggle / install, so UI flows round-trip like the host.
 * `createMockRuntime` spreads `createMockConfigHandlers()` into its request handlers.
 */

import type { ClaudeRequestMap } from './protocol';
import {
  AGENT_COLORS,
  CONFIG_FIELDS,
  CONFIG_NAME_PATTERN,
  type Catalog,
  type ConfigField,
  type ConfigItem,
  type ConfigItemDetail,
  type ConfigItemKind,
  type ConfigScope,
  type ConfigSnapshot,
  type McpServerInfo,
  type McpStatusSnapshot,
  type PluginInfo,
  type SkillCatalogItem,
  type UsageActivity,
} from './types';

export type MockConfigRequestType =
  | 'claude:config.list'
  | 'claude:config.read'
  | 'claude:config.save'
  | 'claude:config.delete'
  | 'claude:config.reload'
  | 'claude:plugin.setEnabled'
  | 'claude:mcp.status'
  | 'claude:mcp.save'
  | 'claude:mcp.remove'
  | 'claude:mcp.toggle'
  | 'claude:skills.catalog'
  | 'claude:skills.install'
  | 'claude:usage.activity';

export type MockConfigHandlers = {
  [K in MockConfigRequestType]: (
    payload: ClaudeRequestMap[K]['payload'],
  ) => ClaudeRequestMap[K]['response'] | Promise<ClaudeRequestMap[K]['response']>;
};

export type MockConfigOptions = {
  cwd: string;
  home?: string;
  /** Returned by `claude:config.reload` (the host rebuilds and returns its catalog). */
  getCatalog: () => Catalog;
};

const DEFAULT_SKILLS_SOURCE = 'anthropics/skills';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MAX_BODY_BYTES = 1_000_000;

const PLUGIN_CLAUDEKEI = 'claudekei@claudekei';
const PLUGIN_SUPERPOWERS = 'superpowers@superpowers-marketplace';
const PLUGIN_DESIGN = 'frontend-design@claude-plugins-official';

type StoredItem = { item: ConfigItem; detail: ConfigItemDetail };

/** Directory-style fixture for the skills catalog (`dir` is the path below the source subpath). */
const CATALOG_FIXTURE: Array<Omit<SkillCatalogItem, 'installed'>> = [
  { dir: 'pdf', name: 'pdf', description: 'Read, merge, split and fill PDF files', installable: true },
  { dir: 'docx', name: 'docx', description: 'Create and edit Word documents', installable: true },
  { dir: 'xlsx', name: 'xlsx', description: 'Create and edit spreadsheets', installable: true },
  { dir: 'pptx', name: 'pptx', description: 'Create and edit slide decks', installable: true },
  { dir: 'skill-creator', name: 'skill-creator', description: 'Guide for writing new skills', installable: true },
  { dir: 'mcp-builder', name: 'mcp-builder', description: 'Build MCP servers', installable: true },
  { dir: 'Brand Guidelines', name: 'Brand Guidelines', description: 'Apply brand colors and type', installable: false, warning: 'Directory name is not a valid skill name (use lowercase letters, digits and dashes).' },
];

const makeUsageActivity = (now: number): UsageActivity => ({
  updatedAt: now,
  day: {
    requests: 142,
    sessions: 6,
    behaviors: [
      { key: 'cache_miss', pct: 18 },
      { key: 'subagent_heavy', pct: 12 },
      { key: 'long_context', pct: 7 },
    ],
    agents: [
      { name: 'claudekei:orchestrator', pct: 46 },
      { name: 'claudekei:oracle', pct: 21 },
      { name: 'claudekei:explorer', pct: 17 },
      { name: 'general-purpose', pct: 9 },
      { name: 'claudekei:debugger', pct: 7 },
    ],
    skills: [
      { name: 'claudekei:simplify', pct: 52 },
      { name: 'karpathy-guidelines', pct: 31 },
      { name: 'pdf', pct: 17 },
    ],
    plugins: [
      { name: 'claudekei', pct: 88 },
      { name: 'frontend-design', pct: 12 },
    ],
    mcpServers: [
      { name: 'github', pct: 64 },
      { name: 'plugin:claudekei:grep_app', pct: 28 },
      { name: 'filesystem', pct: 8 },
    ],
  },
  week: {
    requests: 1184,
    sessions: 41,
    behaviors: [
      { key: 'cache_miss', pct: 14 },
      { key: 'high_parallel', pct: 11 },
      { key: 'long_context', pct: 9 },
      { key: 'cron', pct: 4 },
    ],
    agents: [
      { name: 'claudekei:orchestrator', pct: 41 },
      { name: 'claudekei:sprinter', pct: 22 },
      { name: 'claudekei:oracle', pct: 14 },
      { name: 'claudekei:explorer', pct: 13 },
      { name: 'claudekei:planner', pct: 10 },
    ],
    skills: [
      { name: 'claudekei:simplify', pct: 38 },
      { name: 'karpathy-guidelines', pct: 29 },
      { name: 'vercel-react-best-practices', pct: 21 },
      { name: 'pdf', pct: 12 },
    ],
    plugins: [
      { name: 'claudekei', pct: 81 },
      { name: 'superpowers', pct: 13 },
      { name: 'frontend-design', pct: 6 },
    ],
    mcpServers: [
      { name: 'github', pct: 58 },
      { name: 'plugin:claudekei:grep_app', pct: 24 },
      { name: 'filesystem', pct: 12 },
      { name: 'postgres', pct: 6 },
    ],
  },
});

export function createMockConfigHandlers(options: MockConfigOptions): MockConfigHandlers {
  const home = options.home ?? '/Users/mock';
  const userRoot = `${home}/.claude`;
  const projectRoot = `${options.cwd}/.claude`;
  const pluginRoot = `${userRoot}/plugins/cache/claudekei/claudekei/0.5.3`;
  const rootOf = (scope: ConfigScope): string => (scope === 'user' ? userRoot : projectRoot);

  const pathFor = (kind: ConfigItemKind, scope: ConfigScope, name: string): string => {
    const root = rootOf(scope);
    if (kind === 'agent') return `${root}/agents/${name}.md`;
    if (kind === 'command') return `${root}/commands/${name}.md`;
    return `${root}/skills/${name}/SKILL.md`;
  };

  // --- Config items -------------------------------------------------------------------------------------------

  /** Insertion-ordered; keyed by path. Plugin items live in `pluginItems` and are listed only while enabled. */
  const files = new Map<string, StoredItem>();
  const pluginItems = new Map<string, StoredItem[]>();

  const detailOf = (
    item: ConfigItem,
    fields: Partial<Record<ConfigField, string>>,
    body: string,
    extra: { otherKeys?: string[]; files?: string[] } = {},
  ): StoredItem => ({
    item,
    detail: { ...item, fields: { description: item.description, ...fields }, otherKeys: extra.otherKeys ?? [], body, ...(extra.files ? { files: extra.files } : {}) },
  });

  const addFile = (
    kind: ConfigItemKind,
    scope: ConfigScope,
    name: string,
    description: string,
    fields: Partial<Record<ConfigField, string>>,
    body: string,
    extra: { otherKeys?: string[]; files?: string[]; group?: string } = {},
  ): void => {
    const path = pathFor(kind, scope, name);
    const item: ConfigItem = { kind, name, source: scope, description, path, ...(extra.group ? { group: extra.group } : {}) };
    files.set(path, detailOf(item, fields, body, extra));
  };

  const addPluginItem = (
    pluginId: string,
    pluginName: string,
    kind: ConfigItemKind,
    name: string,
    relativePath: string,
    description: string,
    fields: Partial<Record<ConfigField, string>>,
    body: string,
  ): void => {
    const item: ConfigItem = { kind, name: `${pluginName}:${name}`, source: 'plugin', plugin: pluginId, description, path: `${pluginRoot}/${relativePath}` };
    const list = pluginItems.get(pluginId) ?? [];
    list.push(detailOf(item, fields, body));
    pluginItems.set(pluginId, list);
  };

  addFile('agent', 'user', 'reviewer', 'Reviews diffs for correctness and style', { model: 'sonnet', effort: 'medium', color: 'blue', tools: 'Read, Grep, Glob' }, 'You are a meticulous code reviewer.\n\nFocus on correctness first, then readability.\n', { otherKeys: ['skills'] });
  addFile('agent', 'project', 'reviewer', 'Project reviewer: also checks i18n and accessibility', { model: 'inherit', color: 'green' }, 'Review the change against our UI guidelines.\n');
  addFile('agent', 'project', 'release-manager', 'Prepares release notes and version bumps', { model: 'haiku', effort: 'low', tools: '' }, 'Collect merged changes since the last tag and draft release notes.\n');
  addFile('command', 'user', 'commit', 'Create a conventional commit from the staged changes', { 'argument-hint': '[scope]', 'allowed-tools': 'Bash(git add:*), Bash(git commit:*)', model: 'haiku' }, 'Create a git commit for the staged changes. Scope: $ARGUMENTS\n');
  addFile('command', 'project', 'deploy', 'Deploy the current branch to staging', { 'argument-hint': '<environment>', 'allowed-tools': 'Bash' }, 'Deploy to $1 and report the URL.\n', { group: 'release' });
  addFile('command', 'project', 'changelog', 'Summarize changes since the last release', {}, 'Summarize the commits since the last tag.\n', { group: 'release' });
  addFile('skill', 'user', 'pdf-extract', 'Extract text and tables from PDF files', { 'allowed-tools': 'Read, Bash(pdftotext:*)' }, '# PDF extract\n\nUse `pdftotext` for text; fall back to OCR for scans.\n', { files: [`${userRoot}/skills/pdf-extract/scripts/ocr.py`, `${userRoot}/skills/pdf-extract/reference.md`] });
  addFile('skill', 'project', 'release-notes', 'Write release notes in the house style', {}, '# Release notes\n\nGroup by feature, fix and chore.\n');
  // Frontmatter parse error: still listed, only openable in the editor.
  files.set(pathFor('skill', 'user', 'broken-skill'), {
    item: { kind: 'skill', name: 'broken-skill', source: 'user', description: '', path: pathFor('skill', 'user', 'broken-skill'), error: 'Invalid YAML frontmatter: mapping values are not allowed here (line 3)' },
    detail: { kind: 'skill', name: 'broken-skill', source: 'user', description: '', path: pathFor('skill', 'user', 'broken-skill'), error: 'Invalid YAML frontmatter: mapping values are not allowed here (line 3)', fields: {}, otherKeys: [], body: '', files: [] },
  });

  addPluginItem(PLUGIN_CLAUDEKEI, 'claudekei', 'agent', 'oracle', 'agents/oracle.md', 'Deep reasoning advisor for architecture and hard bugs', { model: 'opus', effort: 'max', color: 'purple', tools: 'Read, Grep, Glob' }, 'You are the oracle: think slowly, answer once.\n');
  addPluginItem(PLUGIN_CLAUDEKEI, 'claudekei', 'agent', 'explorer', 'agents/explorer.md', 'Read-only codebase exploration', { model: 'haiku', effort: 'low', color: 'cyan' }, 'Explore the repository and report findings.\n');
  addPluginItem(PLUGIN_CLAUDEKEI, 'claudekei', 'command', 'plan', 'commands/plan.md', 'Write an implementation plan', { 'argument-hint': '<goal>' }, 'Plan: $ARGUMENTS\n');
  addPluginItem(PLUGIN_CLAUDEKEI, 'claudekei', 'skill', 'simplify', 'skills/simplify/SKILL.md', 'Simplify code for clarity without changing behavior', {}, '# Simplify\n\nReduce complexity; keep behavior.\n');
  addPluginItem(PLUGIN_SUPERPOWERS, 'superpowers', 'skill', 'brainstorming', 'skills/brainstorming/SKILL.md', 'Explore intent and design before implementing', {}, '# Brainstorming\n');
  addPluginItem(PLUGIN_DESIGN, 'frontend-design', 'skill', 'frontend-design', 'skills/frontend-design/SKILL.md', 'Build distinctive, production-grade interfaces', {}, '# Frontend design\n');

  // --- Plugins / marketplaces -----------------------------------------------------------------------------------

  const plugins: PluginInfo[] = [
    { id: PLUGIN_CLAUDEKEI, name: 'claudekei', marketplace: 'claudekei', version: '0.5.3', description: 'ClaudeKei agents, skills and MCP servers', scope: 'user', enabled: true, installPath: pluginRoot },
    { id: PLUGIN_SUPERPOWERS, name: 'superpowers', marketplace: 'superpowers-marketplace', version: '4.1.0', description: 'Core skills library: TDD, debugging, collaboration patterns', scope: 'user', enabled: false, installPath: `${userRoot}/plugins/cache/superpowers-marketplace/superpowers/4.1.0` },
    { id: PLUGIN_DESIGN, name: 'frontend-design', marketplace: 'claude-plugins-official', version: '1.0.2', description: 'Frontend design skill for distinctive interfaces', scope: 'project', enabled: true, installPath: `${userRoot}/plugins/cache/claude-plugins-official/frontend-design/1.0.2` },
  ];
  const marketplaces: ConfigSnapshot['marketplaces'] = [
    { name: 'claudekei', source: 'github:tidesquare/claudekei', installLocation: `${userRoot}/plugins/marketplaces/claudekei`, lastUpdated: Date.now() - 3_600_000 },
    { name: 'claude-plugins-official', source: 'github:anthropics/claude-plugins-official', installLocation: `${userRoot}/plugins/marketplaces/claude-plugins-official`, lastUpdated: Date.now() - 2 * 86_400_000 },
    { name: 'superpowers-marketplace', source: 'https://github.com/obra/superpowers-marketplace.git', installLocation: `${userRoot}/plugins/marketplaces/superpowers-marketplace`, lastUpdated: Date.now() - 9 * 86_400_000 },
    { name: 'local-dev', source: `directory:${home}/Projects/plugins`, installLocation: `${home}/Projects/plugins` },
  ];

  const allStored = (): StoredItem[] => {
    const stored = [...files.values()];
    for (const plugin of plugins) {
      if (plugin.enabled) stored.push(...(pluginItems.get(plugin.id) ?? []));
    }
    return stored;
  };

  const listItems = (): ConfigItem[] => {
    const stored = allStored();
    const projectKeys = new Set(stored.filter((entry) => entry.item.source === 'project').map((entry) => `${entry.item.kind}:${entry.item.name}`));
    return stored.map(({ item }) =>
      item.source === 'user' && projectKeys.has(`${item.kind}:${item.name}`) ? { ...item, shadowed: true as const } : { ...item },
    );
  };

  const findStored = (path: string): StoredItem | undefined => allStored().find((entry) => entry.item.path === path);

  const requireWritableScope = (path: string): void => {
    if (!path.startsWith(`${userRoot}/`) && !path.startsWith(`${projectRoot}/`)) {
      throw new Error('Path is outside the user and project config roots');
    }
    if (path.startsWith(`${userRoot}/plugins/`)) {
      throw new Error('Plugin items are read-only');
    }
  };

  // --- MCP ------------------------------------------------------------------------------------------------------

  type MockMcpServer = Omit<McpServerInfo, 'status'> & { baseStatus: McpServerInfo['status'] };
  const mcpServers: MockMcpServer[] = [
    { name: 'github', baseStatus: 'connected', origin: 'user', scope: 'user', config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } }, serverInfo: { name: 'github-mcp-server', version: '0.9.1' }, toolCount: 24 },
    { name: 'filesystem', baseStatus: 'connected', origin: 'local', scope: 'local', config: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', options.cwd], env: { LOG_LEVEL: 'info' } }, serverInfo: { name: 'filesystem', version: '2.0.0' }, toolCount: 11 },
    { name: 'postgres', baseStatus: 'failed', origin: 'project', scope: 'project', config: { type: 'stdio', command: 'uvx', args: ['mcp-server-postgres', '--dsn', 'postgres://localhost/app'] }, error: 'Connection closed: spawn uvx ENOENT', toolCount: 0 },
    { name: 'linear', baseStatus: 'needs-auth', origin: 'user', scope: 'user', config: { type: 'http', url: 'https://mcp.linear.app/mcp' }, toolCount: 0 },
    { name: 'sentry', baseStatus: 'connected', origin: 'user', scope: 'user', config: { type: 'sse', url: 'https://mcp.sentry.dev/sse' }, serverInfo: { name: 'sentry', version: '1.3.0' }, toolCount: 8 },
    { name: 'docs-search', baseStatus: 'pending', origin: 'project', scope: 'project', config: { type: 'http', url: 'http://localhost:8787/mcp' }, toolCount: 0 },
    { name: 'plugin:claudekei:grep_app', baseStatus: 'connected', origin: 'plugin', serverInfo: { name: 'grep_app', version: '1.0.0' }, toolCount: 1 },
    { name: 'plugin:claudekei:context7', baseStatus: 'connected', origin: 'plugin', serverInfo: { name: 'context7', version: '1.0.0' }, toolCount: 2 },
    { name: 'claude.ai Slack', baseStatus: 'needs-auth', origin: 'claudeai', toolCount: 0 },
  ];
  const disabledMcp = new Set<string>(['sentry']);

  const mcpSnapshot = (): McpStatusSnapshot => ({
    updatedAt: Date.now(),
    servers: mcpServers.map(({ baseStatus, ...server }) => ({
      ...server,
      status: disabledMcp.has(server.name) ? 'disabled' : baseStatus,
      toolCount: disabledMcp.has(server.name) ? 0 : server.toolCount,
    })),
  });

  const findMcp = (name: string): MockMcpServer | undefined => mcpServers.find((server) => server.name === name);

  // --- Skills catalog ---------------------------------------------------------------------------------------------

  const installedScopes = (dir: string): ConfigScope[] => {
    const scopes: ConfigScope[] = [];
    if (files.has(pathFor('skill', 'user', dir))) scopes.push('user');
    if (files.has(pathFor('skill', 'project', dir))) scopes.push('project');
    return scopes;
  };

  const normalizeSource = (source: string | undefined): string => {
    const trimmed = (source ?? '').trim();
    if (!trimmed) return DEFAULT_SKILLS_SOURCE;
    if (trimmed.startsWith('git@') || trimmed.startsWith('ssh://')) {
      throw new Error('Only HTTPS sources are supported (no SSH)');
    }
    if (/^https?:\/\//.test(trimmed) || /^[\w.-]+\/[\w.-]+(\/.+)?$/.test(trimmed)) return trimmed;
    throw new Error('Use owner/repo[/subpath] or an https:// git URL');
  };

  const catalogFor = (source: string): Array<Omit<SkillCatalogItem, 'installed'>> =>
    source === DEFAULT_SKILLS_SOURCE
      ? CATALOG_FIXTURE
      : [
          { dir: 'skills/code-review', name: 'code-review', description: `Review pull requests (from ${source})`, installable: true },
          { dir: 'skills/release-notes', name: 'release-notes', description: 'Release notes in the house style', installable: true },
        ];

  // --- Handlers ---------------------------------------------------------------------------------------------------

  return {
    'claude:config.list': () =>
      structuredClone({
        items: listItems(),
        plugins,
        marketplaces,
        claudekeiFiles: [
          { scope: 'user', path: `${userRoot}/claudekei.jsonc`, exists: true },
          { scope: 'project', path: `${projectRoot}/claudekei.jsonc`, exists: false },
        ],
        projectMcpFile: { path: `${options.cwd}/.mcp.json`, exists: true },
      } satisfies ConfigSnapshot),

    'claude:config.read': ({ path }) => {
      const stored = findStored(path);
      if (!stored) throw new Error(`Config item not found: ${path}`);
      return structuredClone(stored.detail);
    },

    'claude:config.save': ({ kind, scope, name, create, fields, body }) => {
      if (!CONFIG_NAME_PATTERN.test(name)) throw new Error('Name must be lowercase letters, digits and dashes (max 64)');
      const allowed = CONFIG_FIELDS[kind];
      for (const key of Object.keys(fields) as ConfigField[]) {
        if (!allowed.includes(key)) throw new Error(`Field "${key}" is not supported for ${kind}`);
      }
      if ((kind === 'agent' || kind === 'skill') && !(fields.description ?? '').trim()) throw new Error('Description is required');
      if (fields.effort && !EFFORTS.includes(fields.effort)) throw new Error(`Invalid effort: ${fields.effort}`);
      if (fields.color && !(AGENT_COLORS as readonly string[]).includes(fields.color)) throw new Error(`Invalid color: ${fields.color}`);
      if (body.length > MAX_BODY_BYTES) throw new Error('Body is too large (max 1 MB)');

      const path = pathFor(kind, scope, name);
      const existing = files.get(path);
      if (create && existing) throw new Error(`${kind} ${name} already exists in ${scope}`);
      if (!create && !existing) throw new Error(`${kind} ${name} does not exist in ${scope}`);

      const merged: Partial<Record<ConfigField, string>> = { ...(existing?.detail.fields ?? {}) };
      for (const key of allowed) {
        const value = fields[key];
        if (value === undefined) continue;
        if (value === '') delete merged[key];
        else merged[key] = value;
      }
      const description = merged.description ?? '';
      const item: ConfigItem = { kind, name, source: scope, description, path, ...(existing?.item.group ? { group: existing.item.group } : {}) };
      const extra = { otherKeys: existing?.detail.otherKeys, files: existing?.detail.files ?? (kind === 'skill' ? [] : undefined) };
      files.set(path, detailOf(item, merged, body.trimStart(), extra));
      return { ...item };
    },

    'claude:config.delete': ({ path }) => {
      requireWritableScope(path);
      if (!files.delete(path)) throw new Error(`Config item not found: ${path}`);
    },

    'claude:config.reload': () => options.getCatalog(),

    'claude:plugin.setEnabled': ({ id, enabled }) => {
      const plugin = plugins.find((candidate) => candidate.id === id);
      if (!plugin) throw new Error(`Plugin not installed: ${id}`);
      plugin.enabled = enabled;
    },

    'claude:mcp.status': ({ refresh }) => {
      if (refresh) {
        // A re-probe resolves servers that were still connecting.
        for (const server of mcpServers) {
          if (server.baseStatus === 'pending') {
            server.baseStatus = 'connected';
            server.toolCount = 5;
            server.serverInfo = { name: server.name, version: '0.1.0' };
          }
        }
      }
      return mcpSnapshot();
    },

    'claude:mcp.save': ({ name, scope, config, create }) => {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error('Server name may only contain letters, digits, dashes and underscores (max 64)');
      const existing = findMcp(name);
      if (create) {
        if (scope === 'project') throw new Error('Add project servers in .mcp.json');
        if (existing) throw new Error(`MCP server ${name} already exists`);
        mcpServers.push({ name, baseStatus: 'connected', origin: scope, scope, config, toolCount: 3 });
        return;
      }
      if (!existing || existing.scope !== scope) throw new Error(`MCP server ${name} does not exist in ${scope} scope`);
      existing.config = config;
      existing.baseStatus = 'connected';
      delete existing.error;
    },

    'claude:mcp.remove': ({ name, scope }) => {
      const index = mcpServers.findIndex((server) => server.name === name && server.scope === scope);
      if (index === -1) throw new Error(`MCP server ${name} does not exist in ${scope} scope`);
      mcpServers.splice(index, 1);
      disabledMcp.delete(name);
    },

    'claude:mcp.toggle': ({ name, enabled }) => {
      if (!findMcp(name)) throw new Error(`MCP server not found: ${name}`);
      if (enabled) disabledMcp.delete(name);
      else disabledMcp.add(name);
    },

    'claude:skills.catalog': ({ source }) => {
      const resolved = normalizeSource(source);
      return { source: resolved, items: catalogFor(resolved).map((item) => ({ ...item, installed: installedScopes(item.name) })) };
    },

    'claude:skills.install': ({ source, dirs, scope, overwrite }) => {
      const resolved = normalizeSource(source);
      const catalog = catalogFor(resolved);
      const installed: string[] = [];
      const skipped: Array<{ name: string; reason: string }> = [];
      for (const dir of dirs) {
        const entry = catalog.find((candidate) => candidate.dir === dir);
        if (!entry) {
          skipped.push({ name: dir, reason: 'Not found in source' });
          continue;
        }
        if (!entry.installable) {
          skipped.push({ name: entry.name, reason: 'Invalid skill name' });
          continue;
        }
        const path = pathFor('skill', scope, entry.name);
        if (files.has(path) && !overwrite) {
          skipped.push({ name: entry.name, reason: 'Already installed' });
          continue;
        }
        const item: ConfigItem = { kind: 'skill', name: entry.name, source: scope, description: entry.description ?? '', path };
        files.set(path, detailOf(item, {}, `# ${entry.name}\n\nInstalled from ${resolved}.\n`, { files: [] }));
        installed.push(entry.name);
      }
      return { installed, skipped };
    },

    'claude:usage.activity': () => makeUsageActivity(Date.now()),
  };
}
