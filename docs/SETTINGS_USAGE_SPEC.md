# Spec: Settings (Agents / Commands / Skills + catalog / MCP / Plugins) and Usage

Source: @oracle design (2026-10-10). Decision-complete; implement as written. Paths relative to repo root.

## 0. Recon corrections and main decisions
1. The `api:config/agents|commands|mcp|skills*` stubs in `packages/vscode/src/bridge-config-runtime.ts` (~78-98) are unreachable: stores call `fetch('/api/config/...')` and `packages/vscode/webview/main.tsx` (~351-518) only maps `/api/config/settings` + magic prompts; everything else 501. **Decision: new typed `claude:*` routes through `claudeClient` (Claude-native, NEXT_STEPS §5). Delete the stubs.**
2. A plugins page exists: `packages/ui/src/components/sections/plugins/PluginPage.tsx` (OpenKei oh-my-openkei via `/api/plugins/list` → 501). Rewrite it.
3. `Header.tsx`/`MainLayout.tsx` never render in ClaudeKei (`App.tsx` always uses `VSCodeLayout`). ClaudeKei's real "quota panel" = limits section of `packages/ui/src/components/layout/ContextUsagePopover.tsx`.
4. Cost bug: `result.total_cost_usd` is cumulative per `query()` (sdk.d.ts ~5714). `mapper.ts` ~1415 stores the running total each turn and `ContextSidebarTab.tsx` ~336 sums them. Fix in mapper (§2.6).
5. Keep: `sections/agents/ModelSelector.tsx`, `sections/commands/AgentSelector.tsx` (used by TodoSendDialog/DefaultsSettings). `useAgentsStore`, `useCommandsStore` also feed chat autocompletes — strip, don't delete. `ModelControls.tsx` (~1406, ~2635) OpenCode per-agent permission summaries behind `agentsSettings` must be deleted before enabling the flag.
6. Bundled CLI is the full Claude Code CLI: `plugin enable <plugin> -s`, `plugin disable [plugin] -s`, `plugin list --json`, `mcp add-json <name> <json> -s`, `mcp remove <name> -s`; `/mcp disable` persists to `disabledMcpServers` in `~/.claude.json` project entry.

Main decisions:
- Reads from disk (formats §1), except MCP status from runtime.
- Writes: agents/commands/skills → direct atomic file writes. MCP servers & plugin enable/disable → bundled `claude` CLI subcommands (Claude Code locks `~/.claude.json`/settings.json). Never write `~/.claude.json` ourselves.
- Apply to running sessions: `manager.reloadConfig()` marks live sessions `configStale` + refreshes catalog; a stale live-idle session respawns with resume on next send (reuse `effortStale` respawn path in `ClaudeSession.ts` ~274). No per-type reloadPlugins/reloadSkills, no kills.
- MCP status always from a short-lived probe query, cached 30 s. No reconnect route (Refresh re-probes).
- Agents, Commands, Skills share one generic list + editor driven by a field table, replacing the OpenCode pages.

## 1. Data sources (verified on this machine)
1.1 Roots: user `~/.claude`; project `<cwd>/.claude` with cwd = `manager.cwd`; skip project scan if realpath(cwd) === realpath(home). Host owns cwd.

1.2 Plugins: `~/.claude/plugins/installed_plugins.json` version 2: `plugins: Record<"name@marketplace", Array<{scope:'user'|'project'|'local', installPath, version, installedAt, lastUpdated, gitCommitSha, projectPath?}>>`; include install when scope==='user' or projectPath===cwd. Enabled: merge `enabledPlugins` (Record<id,boolean>) from `~/.claude/settings.json`, then `<cwd>/.claude/settings.json`, then `<cwd>/.claude/settings.local.json` (later wins; jsonc-parser); `enabled = merged[id] === true`. Manifest `<installPath>/.claude-plugin/plugin.json` {name, version, description}. Marketplaces `~/.claude/plugins/known_marketplaces.json`: `Record<name,{source:{source:'github',repo}|{source:'git'|'url',url}|{source:'directory',path}, installLocation, lastUpdated}>`.

1.3 Plugin-provided items (read-only), enabled plugins only: agents `<installPath>/agents/*.md`, commands `<installPath>/commands/**/*.md`, skills `<installPath>/skills/<dir>/SKILL.md`. Name `<manifest.name>:<item>` (e.g. `claudekei:oracle`). Custom component paths in plugin.json not scanned.

1.4 Agents: `<root>/agents/**/*.md` depth ≤3, skip dot-dirs. Name = frontmatter `name` else basename. Form edits: `description` (required), `model` (`inherit`, catalog alias or full id), `effort` (EFFORT_LEVELS), `color` (red|blue|green|yellow|purple|orange|pink|cyan), `tools` (comma-separated; empty = all). Other keys kept on save, listed as `otherKeys`. Removed from OpenKei UI: temperature, top_p, mode, disable, OpenCode permission editor (→ tools), provider/model selector (→ simple model select), prompt (→ body). Primary agent (`catalog.primaryAgents`): read-only line "ClaudeKei preset: model X, effort Y (claudekei.jsonc)" + "Open claudekei.jsonc".

1.5 Commands: `<root>/commands/**/*.md`, name = basename, `group` = relative sub-dir (display). Fields `description`, `argument-hint`, `allowed-tools`, `model`; body = template. Removed: agent, subtask, template. Create only at commands root.

1.6 Skills: `<root>/skills/<dir>/SKILL.md` depth 1, skip dot-dirs (`.trash`); `~/.claude/skills/synced/...` not listed. Fields `description` (required), `allowed-tools`; frontmatter `name` = dir name written on create. `files`: other files in skill dir (max 200, recursive, no symlinks), read-only with "Open in editor". Removed: in-webview supporting-file editor, source selector, `.opencode`/`.agents` locations.

1.7 MCP: runtime `mcpServerStatus()` only (all scopes with config+status); never parse `~/.claude.json`. Removed: local/remote types, command[] array, environment, oauth block, timeout, enabled checkbox, OAuth callback flow, import from other clients, Test connection. Replaced by: type stdio|http|sse; command + args (one per line); env (KEY=VALUE lines); url + headers (Key: Value lines); enable/disable toggle; needs-auth hint "Authenticate with `/mcp` in the Claude Code CLI".

1.8 claudekei.jsonc: no form editor. Plugins page `claudekei@claudekei` row has "Open user config" / "Open project config" (project only if exists) via `runtimeApis.editor.openFile`; paths from `ConfigSnapshot.claudekeiFiles`. Existing watcher (`vscodeHost.ts` ~51-59) rebuilds catalog.

## 2. Host contract
### 2.1 Types — append to `packages/ui/src/lib/claude/types.ts`
```ts
export type ConfigScope = 'user' | 'project';
export type ConfigItemKind = 'agent' | 'command' | 'skill';
export type ConfigField = 'description' | 'model' | 'effort' | 'color' | 'tools' | 'argument-hint' | 'allowed-tools';
export const CONFIG_FIELDS: Readonly<Record<ConfigItemKind, readonly ConfigField[]>> = {
  agent: ['description', 'model', 'effort', 'color', 'tools'],
  command: ['description', 'argument-hint', 'allowed-tools', 'model'],
  skill: ['description', 'allowed-tools'],
};
export const CONFIG_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const AGENT_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'] as const;
export type ConfigItem = {
  kind: ConfigItemKind;
  /** Invocation name; plugin items are `<plugin>:<name>`. */
  name: string;
  source: ConfigScope | 'plugin';
  /** `name@marketplace` when source === 'plugin'. */
  plugin?: string;
  /** Commands: sub-directory under commands/ (display only). */
  group?: string;
  description: string;
  /** Absolute path of the .md / SKILL.md. */
  path: string;
  /** A project item with the same kind+name exists (project wins). */
  shadowed?: true;
  /** Frontmatter parse error; still listed, openable in editor. */
  error?: string;
};
export type ConfigItemDetail = ConfigItem & {
  fields: Partial<Record<ConfigField, string>>; // YAML arrays joined with ', '
  otherKeys: string[];
  body: string;
  files?: string[]; // skills only
};
export type PluginInfo = { id: string; name: string; marketplace: string; version?: string; description?: string; scope: 'user' | 'project' | 'local'; enabled: boolean; installPath: string };
export type MarketplaceInfo = { name: string; source: string; installLocation: string; lastUpdated?: number };
export type ConfigSnapshot = {
  items: ConfigItem[];
  plugins: PluginInfo[];
  marketplaces: MarketplaceInfo[];
  claudekeiFiles: Array<{ scope: ConfigScope; path: string; exists: boolean }>;
  projectMcpFile: { path: string; exists: boolean };
};
export type McpServerScope = 'user' | 'local' | 'project';
export type McpTransportConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };
export type McpServerInfo = {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  /** SDK `source ?? scope ?? 'unknown'`. */
  origin: string;
  /** Present iff origin is user/local/project AND config is stdio/http/sse. */
  scope?: McpServerScope;
  config?: McpTransportConfig;
  error?: string;
  serverInfo?: { name: string; version: string };
  toolCount: number;
};
export type McpStatusSnapshot = { servers: McpServerInfo[]; updatedAt: number; error?: string };
export type SkillCatalogItem = { dir: string; name: string; description?: string; installable: boolean; warning?: string; installed: ConfigScope[] };
export type UsageShare = { name: string; pct: number };
export type UsageActivityWindow = { requests: number; sessions: number; behaviors: Array<{ key: string; pct: number }>; agents: UsageShare[]; skills: UsageShare[]; plugins: UsageShare[]; mcpServers: UsageShare[] };
export type UsageActivity = { day: UsageActivityWindow; week: UsageActivityWindow; updatedAt: number };
```
### 2.2 Requests — add to `ClaudeRequestMap` in `protocol.ts`
```ts
'claude:config.list':   { payload: Record<string, never>; response: ConfigSnapshot };
'claude:config.read':   { payload: { path: string }; response: ConfigItemDetail };
'claude:config.save':   { payload: { kind: ConfigItemKind; scope: ConfigScope; name: string; create: boolean; fields: Partial<Record<ConfigField, string>>; body: string }; response: ConfigItem };
'claude:config.delete': { payload: { path: string }; response: void };
'claude:config.reload': { payload: Record<string, never>; response: Catalog };
'claude:plugin.setEnabled': { payload: { id: string; enabled: boolean }; response: void };
'claude:mcp.status':  { payload: { refresh?: boolean }; response: McpStatusSnapshot };
'claude:mcp.save':    { payload: { name: string; scope: McpServerScope; config: McpTransportConfig; create: boolean }; response: void };
'claude:mcp.remove':  { payload: { name: string; scope: McpServerScope }; response: void };
'claude:mcp.toggle':  { payload: { name: string; enabled: boolean }; response: void };
'claude:skills.catalog': { payload: { source?: string; refresh?: boolean }; response: { source: string; items: SkillCatalogItem[] } };
'claude:skills.install': { payload: { source: string; dirs: string[]; scope: ConfigScope; overwrite: boolean }; response: { installed: string[]; skipped: Array<{ name: string; reason: string }> } };
'claude:usage.activity': { payload: Record<string, never>; response: UsageActivity | null };
```
No new push events (`catalog.updated`, `usage.updated` exist). Long timeout (120 s): add to `LONG_REQUEST_TYPES` in `packages/vscode/webview/api/claude.ts`: mcp.status, mcp.toggle, mcp.save, skills.catalog, skills.install, usage.activity, config.reload.

### 2.3 Config file semantics (`packages/vscode/src/claude/claudeConfig.ts`, vscode-free)
- Path guards: `read` only paths under `{user,project}/{agents,commands,skills}` or an enabled plugin's installPath; `delete`/`save` only user/project roots; resolve, reject `..` / symlink escapes. `save` validates name (CONFIG_NAME_PATTERN), field keys ⊆ CONFIG_FIELDS[kind], description non-empty for agent/skill, effort/color enums, body ≤ 1 MB.
- Targets: agent `<root>/agents/<name>.md`; command `<root>/commands/<name>.md`; skill `<root>/skills/<name>/SKILL.md`.
- create:true fails `"<kind> <name> already exists in <scope>"` if exists; create:false requires existing. No rename.
- Frontmatter: `yaml.parseDocument` (`yaml` dep in packages/vscode); per allowed field `''` → delete key, else set; keep other keys + comments; on create write `name: <name>` first (agents, skills). Layout `---\n${doc}---\n\n${body.trimStart()}`. File without frontmatter gets one.
- Atomic write: mkdir -p, write `<file>.<pid>.<rand>.tmp` same dir, rename.
- Delete: agents/commands file; skills dir; via injected `trash(absPath)` (vscodeHost: `vscode.workspace.fs.delete(uri,{recursive:true,useTrash:true})`; default/tests `fs.rm`).
- After save/delete/install the bridge calls `void manager.reloadConfig()` in background.
- API (fixed so Host-B can wire before Host-A finishes):
```ts
// claudeConfig.ts
export type ConfigFsOptions = { cwd: string; home?: string; trash?: (absPath: string) => Promise<void> };
export function listConfig(o: ConfigFsOptions): Promise<ConfigSnapshot>;
export function readConfigItem(o: ConfigFsOptions, path: string): Promise<ConfigItemDetail>;
export function saveConfigItem(o: ConfigFsOptions, req: ClaudeRequestPayload<'claude:config.save'>): Promise<ConfigItem>;
export function deleteConfigItem(o: ConfigFsOptions, path: string): Promise<void>;
// skillsCatalog.ts
export type SkillsCatalogOptions = ConfigFsOptions & { env: Record<string, string | undefined>; runGit?: (args: string[], cwd?: string) => Promise<{ stdout: string }>; allowFileUrls?: boolean /* tests only */ };
export function scanSkillsSource(o: SkillsCatalogOptions, source?: string, refresh?: boolean): Promise<{ source: string; items: SkillCatalogItem[] }>;
export function installSkills(o: SkillsCatalogOptions, req: ClaudeRequestPayload<'claude:skills.install'>): Promise<{ installed: string[]; skipped: Array<{ name: string; reason: string }> }>;
```

### 2.4 Manager (Host-B, `ClaudeSessionManager.ts`)
- `private runOnProbe<T>(fn: (q: ClaudeQuery) => Promise<T>, timeoutMs: number): Promise<T | undefined>` extracted from the inline probe in `refreshUsage()` (~485-495), which then uses it. Also used by mcpStatus, toggleMcp, usageActivity.
- `reloadConfig(): Promise<Catalog>`: each `isLive` session `markConfigStale()`; `mcpCache = undefined`; `return this.refreshCatalog()`. ClaudeSession: `private configStale=false`, `markConfigStale()`, add `|| this.configStale` to respawn condition (~274), reset in `spawn()` next to `effortStale = false`.
- `mcpStatus(refresh?)`: cache < 30 s unless refresh; share in-flight promise. Else runOnProbe (12 s cap): poll `q.mcpServerStatus()` every 250 ms until no `pending` or 10 s; map: `origin = source ?? scope ?? 'unknown'`; `scope = origin ∈ {user,local,project} ? origin : undefined`; config `{type?:'stdio'|undefined, command,args,env}` → stdio, `{type:'http'|'sse',url,headers}` as is, else undefined and drop scope; `toolCount = tools?.length ?? 0`. Probe failure → `{servers: lastKnown ?? [], updatedAt, error}`.
- `toggleMcp(name, enabled)`: runOnProbe(q => q.toggleMcpServer(name, enabled)) then reloadConfig (Claude persists `disabledMcpServers`/`disabledMcpjsonServers`; verify in spike S2).
- `saveMcp({name, scope, config, create})`: name `^[A-Za-z0-9_-]{1,64}$`; create only user|local (project → error "Add project servers in .mcp.json"; UI offers "Open .mcp.json"). Update: previous entry from cache (same scope + config) → CLI `mcp remove <name> -s <scope>` → `mcp add-json <name> <json> -s <scope>`; if add fails re-add previous JSON and rethrow. Create: add-json only. Then reloadConfig.
- `removeMcp({name, scope})`: `mcp remove <name> -s <scope>` then reloadConfig.
- `setPluginEnabled(id, enabled)`: scope from `listConfig().plugins`; `plugin enable|disable <id> -s <scope>` (check `--json` support in spike); reloadConfig.
- `usageActivity()`: live query else probe (20 s); call `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: false })`; `applyUsageRaw(raw)` (limits refresh + usage.updated); return `parseUsageActivity(raw)` (new in `usageLimits.ts`; null when `behaviors` null; lists sorted by pct desc, capped 5).
- `packages/vscode/src/claude/claudeCli.ts`:
```ts
export type CliRunner = (args: string[], o: { cwd: string; env: Record<string, string | undefined>; timeoutMs?: number }) => Promise<{ stdout: string; stderr: string }>;
export function createCliRunner(resolveExecutable: () => string | undefined): CliRunner;
```
execFile, default timeout 30 s, maxBuffer 4 MB, reject `new Error(stderr.trim() || message)`. Executable = `executable().path ?? findOnPath('claude', env.PATH)`, env = buildEnv(), cwd = manager.cwd. Injectable via `ClaudeSessionManagerOptions.cli`.
- `sdk.ts` ClaudeQuery: `mcpServerStatus?(): Promise<unknown[]>`, `toggleMcpServer?(name: string, enabled: boolean): Promise<void>`.

### 2.5 Bridge (`bridge-claude-runtime.ts`)
Add all 13 types to `CLAUDE_REQUEST_TYPES`; validate with `requireString` + enum checks (kind, scope, type). Config routes call Host-A functions with `manager.configFs()` = `{cwd: manager.cwd, home, trash}`. Delete stub cases + `NOT_AVAILABLE` in `bridge-config-runtime.ts`; update `packages/vscode/src/DOCUMENTATION.md`.

### 2.6 Cost fix (`mapper.ts`)
In `createMapper` `let costSeen = 0`; in `handleResult`:
```ts
const total = num(msg.total_cost_usd);
if (total !== undefined) { last.message.cost = Math.max(0, total - costSeen); costSeen = total; }
```

## 3. Skills catalog (host `skillsCatalog.ts`)
OpenKei reference: `/Users/kei/Projects/openkei/packages/vscode/src/skillsCatalog.ts`.
- Sources: curated default `anthropics/skills` subpath `skills`, plus user input `owner/repo[/subpath]`, `https://github.com/owner/repo`, or any `https://…` git URL. git over HTTPS only (no GitHub API, no auth, no SSH), `GIT_TERMINAL_PROMPT=0`; auth failures → "Private repositories are not supported".
- Cache in memory 30 min keyed `repo::subpath`; refresh bypasses.
- Scan: every SKILL.md below subpath, parse frontmatter; `installable = CONFIG_NAME_PATTERN.test(basename(dir))`; `installed` = scopes where `<root>/skills/<name>` exists. (git clone --depth 1 --filter=blob:none --no-checkout + sparse checkout like OpenKei.)
- Install: sparse checkout selected dirs into temp; copy to `~/.claude/skills/<name>` or `<cwd>/.claude/skills/<name>`; reject symlinks; realpath must stay inside source; existing target skipped "Already installed" unless overwrite (trash first); always remove temp dirs.
- Dropped: ClawdHub, persisted extra sources, conflict dialog. Remove `adm-zip` from `packages/vscode/package.json` if no remaining users.
- UI `SkillsCatalogPage.tsx` local state only: source input (default anthropics/skills) + Scan; checkbox list with "Installed (user/project)" badges; footer scope select + "Overwrite existing" + Install; result toast; then `useClaudeConfigStore.load(true)`.

## 4. Plugins page (`sections/plugins/PluginPage.tsx`, rewrite)
1. Installed plugins: name, @marketplace, version, scope badge, description, enabled Switch (`claude:plugin.setEnabled`, optimistic + rollback). `claudekei@claudekei` row: "Open user config" / "Open project config".
2. Marketplaces: read-only rows (name, source, "Updated <relative>").
3. Reload button → `claude:config.reload`.
4. Hint: "Running sessions pick up changes on their next message." Footnote: install/uninstall/marketplace update → use `/plugin` in the CLI.

## 5. Usage page and quota panel
5.1 Delete `useQuotaStore` and multi-provider quota code; data source = existing `useUsageLimits()` / bootstrapCache (host-pushed).
5.2 `packages/ui/src/lib/claude/usage.ts`:
```ts
export const usageWindowDurationMs = (w: Pick<UsageWindow,'kind'>): number | undefined =>
  w.kind === 'session' ? 5 * 3_600_000 : w.kind.startsWith('weekly') ? 7 * 86_400_000 : undefined;
export type UsagePace = { expected: number; status: 'on-track' | 'ahead' | 'exhausted'; runsOutAt?: number };
export function usageWindowPace(w: UsageWindow, now: number): UsagePace | undefined
```
No duration or no resetsAt → undefined. start = resetsAt − d; elapsed = clamp(now − start, 0, d); expected = elapsed/d. utilization ≥ 1 or status 'rejected' → exhausted. elapsed < 0.02d or utilization ≤ expected → on-track. Else ahead, runsOutAt = now + (1 − u)·elapsed/u, kept only if < resetsAt.
5.3 Extract `LimitRow` from `ContextUsagePopover.tsx` (~79-105) into `packages/ui/src/components/usage/UsageLimitRow.tsx` props `{window, now, showPace?}`; with showPace: 1px tick at expected·100% and second line "On pace" / "Ahead of pace · limit in ~{formatDuration}" / "Limit reached". Popover keeps using it without pace.
5.4 Quota panel = popover limits section; add "Details →" in its title row:
```ts
useUIStore.getState().setSettingsPage('usage');
window.dispatchEvent(new CustomEvent('openchamber:navigate', { detail: { view: 'settings' } }));
setOpen(false);
```
(verify the actual navigation mechanism used by VSCodeLayout for opening settings and use that.)
5.5 `sections/usage/UsagePage.tsx` single page (metadata usage kind → 'single', drop UsageSidebar):
1. Header: title + plan badge (`limits.plan`) + account email (bootstrap account); Refresh (`claudeClient.refreshUsage().then(setUsage)`); "claude.ai →" `openExternalUrl('https://claude.ai/settings/usage')`; "Updated <relative>".
2. No limits: "Plan limits are only shown when signed in with a Claude subscription (`claude login`)."
3. Windows: `UsageLimitRow showPace` each; rerender every 30 s.
4. Extra usage when `extraUsage?.enabled`: "Extra usage {used}/{limit} {currency} ({pct}%)".
5. Activity on this machine: `claudeClient.usageActivity()` on mount; spinner; Retry on error; hidden when null; toggle "24 hours / 7 days"; "{requests} requests · {sessions} sessions"; behaviors pct: cache_miss "Cache misses", long_context "Long context", subagent_heavy "Subagent-heavy", high_parallel "Parallel work", cron "Scheduled", unknown keys title-cased; four top-5 lists (Agents / Skills / Plugins / MCP servers) with pct bars; footnote "Estimated from local transcripts; excludes other devices and claude.ai."
Not shown: cost totals (subscription cost isn't a bill; transcripts don't store cost).

## 6. Cleanup (OpenCode-only code to delete)
UI files: U-A `sections/agents/AgentsPage.tsx`, `AgentsSidebar.tsx`, `sections/commands/CommandsPage.tsx`, `CommandsSidebar.tsx`, `sections/skills/SkillsPage.tsx`, `SkillsSidebar.tsx`. U-B `stores/useMcpConfigStore.ts`, `sections/mcp/mcpImport.ts`, `mcpOAuth.ts`, `McpOAuthCallbackPage.tsx`. U-C `stores/useQuotaStore.ts`, `lib/quota/**`, `sections/usage/UsageCard.tsx`, `UsageSidebar.tsx`, `UsageProgressBar.tsx`, `PaceIndicator.tsx`. U-D `stores/useSkillsCatalogStore.ts`, `sections/skills/catalog/AddCatalogDialog.tsx`, `InstallConflictsDialog.tsx`, `InstallFromRepoDialog.tsx`, `InstallSkillDialog.tsx`. X `stores/useSkillsStore.ts`, `sections/skills/skillLocations.ts`, `sections/skills/index.ts`.
Inside kept files: `useAgentsStore.ts` keep agents, loadAgents, selectedAgentName, getAgentByName, getVisibleAgents, isAgentBuiltIn, isAgentHidden, filterVisibleAgents, AgentWithExtras, AgentScope; remove CRUD/drafts/OpenCode connection/refresh and imports of skills/catalog/commands/config stores. `useCommandsStore.ts` keep commands, loadCommands, isCommandBuiltIn, Command; remove CRUD/drafts/health polling. `ModelControls.tsx` both permission blocks (C0). `App.tsx` OAuth callback route (U-B). `Header.tsx` quota imports/usage tab code (U-C), keep MCP tab. `types.ts` legacy `McpStatus`, `PermissionConfig*` if unused (X).
Host: bridge-config-runtime stubs (H-B); adm-zip (X).
i18n (X, all 5 locales): delete keys under settings.agents.*, settings.commands.*, settings.mcp.*, settings.skills.*, settings.skillsCatalog.*, settings.usage.*, settings.plugins.*, mcpDropdown.* that are no longer referenced; keep settings.page.*.title. New strings live in English dicts spread into all locales (precedent `en.subagents.ts`): `en.configPages.ts` (claudeConfig.*), `en.mcp.ts` (claudeMcp.*), `en.usage.ts` (claudeUsage.*), `en.skillsCatalog.ts` (claudeSkillsCatalog.*).
Flags: after everything works remove `agentsSettings, commandsSettings, mcp, skills, plugins, usage, quota` from features.ts with their guards (metadata.ts SETTINGS_PAGE_FEATURE, VSCodeLayout McpDropdown guard, store guards) (X). C0 flips them to true first.
Docs (X): update NEXT_STEPS.md; spike results in W0_SPIKE_NOTES.md.

## 7. Work split (exclusive ownership; C0 → parallel → X)
- C0 contracts/scaffolding (frontend): types.ts, protocol.ts (§2.1-2.2), client.ts (listConfig, readConfig, saveConfig, deleteConfig, reloadConfig, setPluginEnabled, mcpStatus, saveMcp, removeMcp, toggleMcp, skillsCatalog, installSkills, usageActivity), mockRuntime.ts + new mockConfig.ts fixtures for every handler; metadata.ts (skills.installed kind 'split', usage kind 'single'; plugins isAvailable ctx.isVSCode); features.ts 7 flags → true; ModelControls permission blocks deleted; SettingsView.tsx imports final component paths (agents/commands/skills.installed render `ConfigItemsSidebar kind` + `ConfigItemEditor kind`; mcp → McpSidebar + McpPage; usage → UsagePage no sidebar; skills.catalog → SkillsCatalogPage; plugins → PluginPage); store-loading effect → `useClaudeConfigStore.getState().load()` for agents/commands/skills.installed/plugins and `useMcpStore.getState().refresh(false)` for mcp. Stub files with final exports: `stores/useClaudeConfigStore.ts`, `components/sections/claude-config/{ConfigItemsSidebar,ConfigItemEditor}.tsx`, empty `lib/i18n/messages/en.{configPages,mcp,usage,skillsCatalog}.ts` spread into en/es/pt-BR/uk/zh-CN.
- H-A (host, vscode-free): `claudeConfig.ts` + test, `skillsCatalog.ts` + test (§1, §2.3, §3).
- H-B (host): ClaudeSessionManager.ts, ClaudeSession.ts, sdk.ts, fakes.ts, claudeCli.ts, usageLimits.ts, mapper.ts (cost fix), vscodeHost.ts (trash, cli), bridge-claude-runtime.ts, bridge-config-runtime.ts, webview/api/claude.ts + tests. Runs spikes §8 first.
- U-A: `useClaudeConfigStore.ts` (state snapshot, loading, error, `selected: Record<ConfigItemKind, {path}|{draft:ConfigScope}|null>`, detail; actions load(force?) dedupe in-flight, select, openDetail(path), save (then load(true) + select saved), remove, setPluginEnabled (optimistic), reloadClaude(); selector selectItems(kind)); `ConfigItemsSidebar.tsx` (groups Project / User / "Plugin · <name>", search, "New" menu User/Project, badges shadowed "overridden", error); `ConfigItemEditor.tsx` (name read-only after create; fields from CONFIG_FIELDS: model select inherit + catalog.models[].value + current unknown value, effort select, color select, text inputs; body textarea; skills files list with Open; otherKeys note "Also in file: skills, hooks (kept)"; Save / Delete (confirm) / Open in editor; plugin items read-only; primary agents preset line); `configFields.ts`; rewrite PluginPage.tsx; CommandAutocomplete/SkillAutocomplete get skills from useClaudeConfigStore (kind skill → {name, description, scope: source==='project'?'project':'user'}, load() on mount); strip useAgentsStore/useCommandsStore; owns en.configPages.ts.
- U-B: rewrite `stores/useMcpStore.ts` ({snapshot, loading, error, selected: string|'new'|null, refresh(force), save, remove, toggle(optimistic)}, `computeMcpHealth(servers)` → {connected,total,hasFailed,hasAuthRequired}); `sections/mcp/McpSidebar.tsx` (group by origin, status dot, New); `sections/mcp/McpPage.tsx` (form §1.7, scope select on create only User/Local, read-only when scope undefined, toggle, error/needs-auth text, Open .mcp.json); rewrite `components/mcp/McpDropdown.tsx` with one shared `McpServerList` for McpDropdown + McpDropdownContent (keep export/props), opens with refresh(false); VSCodeLayout flag check removal; App.tsx OAuth route; owns en.mcp.ts.
- U-C: `lib/claude/usage.ts` + tests, `components/usage/UsageLimitRow.tsx`, ContextUsagePopover.tsx, `sections/usage/UsagePage.tsx`, Header.tsx quota removal, U-C deletions, owns en.usage.ts.
- U-D: `sections/skills/catalog/SkillsCatalogPage.tsx`, U-D deletions, owns en.skillsCatalog.ts.
- X final sweep: §6 (X) items.

## 8. Spikes (H-B first; fixtures under `packages/vscode/src/claude/__fixtures__/config/`)
S1 no-turn probe `mcpServerStatus()` reaches non-pending for claudekei plugin HTTP servers within 10 s? record JSON. S2 probe A `toggleMcpServer('plugin:claudekei:grep_app', false)` → close → probe B shows disabled? toggle back. Not persisted ⇒ hide toggle in UI and `mcp.toggle` returns "not supported". S3 record stdout/stderr/exit codes of `plugin enable|disable <id> -s user --json`, `mcp add-json`, `mcp remove` (throwaway local server `zz-spike`). S4 temp `~/.claude/agents/zz-spike.md`; configStale session respawns on next send; `initializationResult().agents` contains zz-spike; remove after.

## 9. Tests
Host: claudeConfig.test.ts (temp HOME/cwd: scan agents/nested commands/depth-1 skills, dot-dirs skipped, synced not listed; plugin items only enabled; projectPath filter; enabledPlugins merge; shadowing; invalid YAML → error; create/update keeps unknown keys + comments; create on existing fails; update missing fails; validation; traversal + plugin writes rejected; delete calls trash (skill → dir); cwd===home dedupe). skillsCatalog.test.ts (source parsing; SSH rejected; scan/install against local bare repo with allowFileUrls; skip vs overwrite; symlink rejected; invalid names; cache/refresh). Manager fakes: mcpStatus polling/mapping/cache/dedupe/error; toggleMcp; saveMcp exact CLI args + rollback + project rejected; setPluginEnabled scope; reloadConfig stale respawn (idle yes, busy not mid-turn); usageActivity fixture (null behaviors → null). mapper.test.ts cost 0.10 then 0.25 → 0.10/0.15; new mapper restarts. Bridge: types listed; bad payloads success:false; writes trigger reloadConfig.
UI: usageWindowPace cases; useClaudeConfigStore load/save/delete vs mock; optimistic plugin rollback; useMcpStore toggle rollback + computeMcpHealth; mock-runtime-flow round-trips.
Static: `bun run type-check:ui && bun run lint:ui && bun run vscode:type-check`; tests `bun run --cwd packages/vscode test && bun test packages/ui/src`.
