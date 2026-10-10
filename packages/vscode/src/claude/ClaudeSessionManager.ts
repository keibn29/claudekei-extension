/**
 * Owns every Claude session of the workspace (D1), the catalog and the live-process policy
 * (live cap with LRU idle eviction, idle timeout). Vscode-free; persistence goes through a Memento-like store.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import type { BootstrapResponse, ClaudeEvent, LiveSessionState, SessionSnapshot } from '@openchamber/ui/src/lib/claude/protocol';
import { EFFORT_LEVELS, PERMISSION_MODES, type AccountInfo, type Catalog, type ContextUsage, type EffortLevel, type PermissionMode, type PermissionResponse, type QuestionAnswer, type RevertPreview, type RevertResult, type McpServerScope, type McpStatusSnapshot, type McpTransportConfig, type Session, type SlashCommand, type UsageActivity, type UsageLimits } from '@openchamber/ui/src/lib/claude/types';
import { AgentLog } from './agentLog';
import { normalizeAgentName, resolveDefaultAgent } from './agentSettings';
import { loadAgentFrontmatter } from './agentFrontmatter';
import { readAgentPresets, type AgentPreset } from './claudekeiConfig';
import type { ContextBaseline } from './contextUsage';
import { applyRateLimitEvent, carryOverWindows, parseUsageActivity, parseUsageReport } from './usageLimits';
import type { Broadcaster } from './broadcaster';
import { buildCatalog, looksLoggedOut, probeCatalog, probeFromInit, type PrimaryAgentSetting, type ProbeResult } from './catalog';
import { createCliRunner, type CliRunner } from './claudeCli';
import { listConfig, type ConfigFsOptions } from './claudeConfig';
import { mapMcpServers, mcpConfigJson, mergeMcpConfig, validateMcpConfig } from './mcpStatus';
import type { SkillsCatalogOptions } from './skillsCatalog';
import { ClaudeSession, type ClaudeSessionDeps, type SendInput, type SessionPrefs } from './ClaudeSession';
import { buildClaudeEnv, resolveClaudeExecutable, resolveLoginShellPath, type ExecutableResolution } from './env';
import type { InitInfo, SubagentDefaults } from './mapper';
import { RevertStore } from './revertStore';
import type { ClaudeQuery, SdkRuntime, SdkSessionInfo } from './sdk';
import { loadSdkRuntime } from './sdk';
import { cutUuidBefore } from './transcriptCut';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

/** Subset of `vscode.Memento`. */
export interface KeyValueStore {
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void> | Promise<void>;
}

export type ManagerConfig = {
  maxLiveSessions: number;
  idleTimeoutMinutes: number;
  useApiKey: boolean;
  claudeExecutablePath: string;
  primaryAgents: PrimaryAgentSetting[];
  /** `claudekei.allowBypassPermissions`: without it `bypassPermissions` is rejected. */
  allowBypassPermissions: boolean;
  /** `claudekei.defaultPermissionMode`: mode of new sessions (downgraded to `default` when bypass is not allowed). */
  defaultPermissionMode: PermissionMode;
};

export type ClaudeSessionManagerOptions = {
  cwd: string;
  /** `<extension>/dist`, where the bundled SDK binary lives. */
  distDir?: string;
  store: KeyValueStore;
  broadcaster: Broadcaster;
  getConfig: () => ManagerConfig;
  runtime?: () => Promise<SdkRuntime>;
  /** Where plan usage limits are kept so they show at startup (VS Code `globalState`); defaults to `store`. */
  globalStore?: KeyValueStore;
  /** File existence check (tests); defaults to `existsSync`. */
  exists?: (path: string) => boolean;
  /** Measure per-model context windows on a background probe after the catalog is published (default true). */
  measureModelWindows?: boolean;
  /** Home directory for `~/.claude/claudekei.jsonc` (tests). */
  home?: string;
  /** Extension storage directory: file copies for `/redo` live under `<storageDir>/revert/<sessionId>`. Without it revert is unavailable. */
  storageDir?: string;
  /** Poll interval while MCP servers are connecting (tests). */
  mcpPollMs?: number;
  /** Moves a file or directory to the OS trash (vscode `workspace.fs.delete` with `useTrash`); default: `fs.rm`. */
  trash?: (absPath: string) => Promise<void>;
  /** Runs `claude` subcommands (MCP / plugin writes); default: the resolved executable through `execFile`. */
  cli?: CliRunner;
  baseEnv?: NodeJS.ProcessEnv;
  loginPath?: () => Promise<string | undefined>;
  clientApp?: string;
  log?: ClaudeSessionDeps['log'];
  now?: () => number;
  timers?: ClaudeSessionDeps['timers'];
  stderr?: (data: string) => void;
};

const AUTH_MESSAGE = 'Not logged in. Run `claude login` in a terminal (command: ClaudeKei: Claude Login).';
const CATALOG_KEY = 'claudekei.catalogCache';
const PREFS_KEY = 'claudekei.sessionPrefs';
const USAGE_KEY = 'claudekei.usageLimits';
const WINDOWS_KEY = 'claudekei.modelWindows';
const BASELINES_KEY = 'claudekei.contextBaselines';
/** A rate_limit_event triggers a full usage refresh at most this often. */
const USAGE_REFRESH_MIN_MS = 60_000;
/** Bootstrap re-probes the catalog at most this often (the probe spawns a process). */
const PROBE_MIN_INTERVAL_MS = 5 * 60_000;
/** Catalog/defaults are derived from settings files; recompute at most this often. */
const CATALOG_TTL_MS = 2000;
/** Non-live sessions kept in memory; older ones are unloaded (they reload from the transcript on demand). */
const MAX_LOADED_SESSIONS = 20;
/** MCP status is re-read at most this often unless a refresh is requested. */
const MCP_CACHE_MS = 30_000;
/** Servers that are still connecting are waited for this long. */
const MCP_SETTLE_MS = 10_000;
const MCP_PROBE_CAP_MS = 12_000;
const MCP_TOGGLE_MS = 15_000;
const USAGE_ACTIVITY_MS = 20_000;
/** No leading '-': a name must never be parsed as an option by `claude mcp`. */
const MCP_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
/** Unsent drafts nobody references are dropped after this long. */
const DRAFT_TTL_MS = 60 * 60_000;

const DEFAULT_CONFIG: ManagerConfig = { maxLiveSessions: 3, idleTimeoutMinutes: 10, useApiKey: false, claudeExecutablePath: '', primaryAgents: [], allowBypassPermissions: true, defaultPermissionMode: 'bypassPermissions' };

export const DEFAULT_MANAGER_CONFIG = DEFAULT_CONFIG;

type CatalogCache = { probe: ProbeResult; savedAt: number };

export type Diagnostics = {
  status: ConnectionStatus;
  error?: string;
  cwd: string;
  executable: ExecutableResolution;
  loginPath: string | undefined;
  nodeOnPath: string | undefined;
  account: AccountInfo | null;
  catalog: { models: number; commands: number; agents: number; primaryAgents: string[] };
  liveSessions: Array<{ id: string; lifecycle: string; agent: string | undefined; spawns: number }>;
};

export class ClaudeSessionManager {
  private readonly sessions = new Map<string, ClaudeSession>();
  private readonly idleTimers = new Map<string, unknown>();
  private readonly statusListeners = new Set<(status: ConnectionStatus, error?: string) => void>();
  private readonly deps: ClaudeSessionDeps;
  private readonly agentLog: AgentLog;
  private modelWindows: Record<string, number> = {};
  private modelWindowsKey = '';
  /** Fixed context cost (system prompt, tools, memory) per model value, from the last exact measurement. */
  private contextBaselines: Record<string, ContextBaseline> = {};
  /** True while the values come from another Claude Code build: shown, but every model is measured again. */
  private windowsStale = false;
  private windowsMeasuring: Promise<void> | undefined;
  private usage: UsageLimits | undefined;
  private usageRefreshing: Promise<UsageLimits> | undefined;
  private mcpCache: { value: McpStatusSnapshot; at: number } | undefined;
  private mcpInFlight: Promise<McpStatusSnapshot> | undefined;
  private lastKnownMcp: McpStatusSnapshot['servers'] | undefined;
  /** Stored config of every editable server as the last status probe reported it, keyed `<scope>:<name>`. */
  private mcpRaw = new Map<string, unknown>();
  private readonly cli: CliRunner;
  private lastUsageFetchAt = 0;
  private readonly runtimeLoader: () => Promise<SdkRuntime>;
  private probe: ProbeResult | undefined;
  private account: AccountInfo | null = null;
  private catalogPromise: Promise<void> | undefined;
  private lastCatalogJson = '';
  private lastProbeAt = 0;
  private catalogCache: { value: Catalog; at: number; key: string } | undefined;
  /** `model` / `effort` of the subagent definitions on disk (loaded in the background with the catalog). */
  private agentFrontmatter = new Map<string, AgentPreset>();
  private status: ConnectionStatus = 'connecting';
  private statusError: string | undefined;
  private readonly log: NonNullable<ClaudeSessionManagerOptions['log']>;
  private readonly now: () => number;
  private readonly timers: NonNullable<ClaudeSessionManagerOptions['timers']>;
  private disposed = false;
  /** Ids deleted during this run: a late request must not resurrect them from the not-yet-removed transcript. */
  private readonly deletedIds = new Set<string>();

  constructor(private readonly options: ClaudeSessionManagerOptions) {
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    this.runtimeLoader = options.runtime ?? loadSdkRuntime;
    const storedWindows = (options.globalStore ?? options.store).get<{ key: string; windows: Record<string, number>; stale?: boolean } | undefined>(WINDOWS_KEY, undefined);
    // Always adopt the current key, so a lazy `recordModelWindow` before the first measurement persists under it.
    this.modelWindowsKey = this.cliKey();
    if (storedWindows?.windows) {
      this.modelWindows = storedWindows.windows;
      // Another Claude Code build: keep the old values as provisional (better than a wrong static 200K) and re-measure all.
      this.windowsStale = storedWindows.stale === true || storedWindows.key !== this.modelWindowsKey;
    }
    const cached = options.store.get<CatalogCache | undefined>(CATALOG_KEY, undefined);
    if (cached?.probe) {
      this.probe = cached.probe;
      this.account = cached.probe.account;
      this.lastCatalogJson = JSON.stringify(this.catalog());
      // Cached catalog: usable right away; the background refresh corrects it.
      this.status = 'connected';
    }
    this.agentLog = new AgentLog(options.store);
    this.cli = options.cli ?? createCliRunner(() => this.executable().path ?? findOnPath('claude', (options.baseEnv ?? process.env).PATH));
    this.usage = (options.globalStore ?? options.store).get<UsageLimits | undefined>(USAGE_KEY, undefined);
    this.contextBaselines = (options.globalStore ?? options.store).get<Record<string, ContextBaseline>>(BASELINES_KEY, {});
    this.deps = {
      agentLog: this.agentLog,
      cwd: options.cwd,
      runtime: this.runtimeLoader,
      env: () => this.buildEnv(),
      executablePath: () => this.executable().path,
      emit: (events) => options.broadcaster.emit(events),
      onInit: (init, query) => void this.onSessionInit(init, query),
      onPrefsChanged: (session) => this.savePrefs(session),
      agentPreset: (agent) => this.catalog().primaryAgents.find((p) => p.name === agent),
      resolveModel: (value) => this.resolveModel(value),
      subagentDefaults: (agentType) => this.subagentDefaults(agentType),
      onActivity: (session, state) => this.onSessionActivity(session, state),
      onCommandsChanged: (commands) => this.applyCommands(commands),
      onRateLimit: (info) => this.onRateLimit(info),
      onModelWindow: (value, max) => this.recordModelWindow(value, max),
      modelWindow: (value) => this.modelWindows[value],
      contextBaseline: (value) => this.contextBaselines[value],
      onContextBaseline: (value, baseline) => this.recordContextBaseline(value, baseline),
      isModeAllowed: (mode) => mode !== 'bypassPermissions' || this.config.allowBypassPermissions,
      log: this.log,
      now: this.now,
      timers: this.timers,
      stderr: options.stderr,
      revertStore: options.storageDir ? new RevertStore(options.store, join(options.storageDir, 'revert')) : undefined,
    };
    void this.deps.revertStore?.sweep().catch((error) => this.log('warn', 'could not sweep stale revert copies', error instanceof Error ? error.message : String(error)));
  }

  // --- config / env ------------------------------------------------------------

  private get config(): ManagerConfig {
    return { ...DEFAULT_CONFIG, ...this.options.getConfig() };
  }

  executable(): ExecutableResolution {
    return resolveClaudeExecutable({ override: this.config.claudeExecutablePath, distDir: this.options.distDir, exists: this.options.exists });
  }

  private async buildEnv(): Promise<Record<string, string | undefined>> {
    const loginPath = await (this.options.loginPath ?? (() => resolveLoginShellPath()))();
    return buildClaudeEnv(this.options.baseEnv ?? process.env, { useApiKey: this.config.useApiKey, loginPath, clientApp: this.options.clientApp ?? 'claudekei' });
  }

  get cwd(): string {
    return this.options.cwd;
  }

  // --- status ------------------------------------------------------------------

  getStatus(): { status: ConnectionStatus; error?: string } {
    return { status: this.status, error: this.statusError };
  }

  onStatusChange(listener: (status: ConnectionStatus, error?: string) => void): { dispose(): void } {
    this.statusListeners.add(listener);
    return { dispose: () => this.statusListeners.delete(listener) };
  }

  private setStatus(status: ConnectionStatus, error?: string): void {
    if (status === this.status && error === this.statusError) return;
    this.status = status;
    this.statusError = error;
    for (const l of this.statusListeners) l(status, error);
  }

  // --- catalog -----------------------------------------------------------------

  /** Current catalog (cached probe or fallbacks). Defaults follow the settings files (2 s cache, dropped on probe). */
  catalog(): Catalog {
    const config = this.config;
    const key = JSON.stringify([config.primaryAgents, config.allowBypassPermissions, config.defaultPermissionMode]);
    const cached = this.catalogCache;
    if (cached && cached.key === key && this.now() - cached.at < CATALOG_TTL_MS) return cached.value;
    const probe = this.probe ?? { models: [], commands: [], agents: [], account: null };
    const known = probe.agents.map((a) => a.name);
    const configured = resolveDefaultAgent({ cwd: this.options.cwd, knownAgents: known });
    const presets = readAgentPresets({ cwd: this.options.cwd, home: this.options.home });
    const defaultMode: PermissionMode = config.defaultPermissionMode !== 'bypassPermissions' || config.allowBypassPermissions ? config.defaultPermissionMode : 'default';
    const draft = buildCatalog(probe, { primaryAgentsSetting: config.primaryAgents, agentPresets: presets, defaultMode });
    const wanted = configured ? normalizeAgentName(configured, known) : undefined;
    // The default agent must be one the UI can cycle; otherwise fall back to the first primary agent.
    const agent = wanted && draft.primaryAgents.some((p) => p.name === wanted) ? wanted : (draft.primaryAgents[0]?.name ?? wanted ?? '');
    // A new session starts with the default agent's preset (model / effort), like a later agent switch applies it.
    const preset = draft.primaryAgents.find((p) => p.name === agent);
    const models = draft.models.map((m) => (this.modelWindows[m.value] ? { ...m, contextWindow: this.modelWindows[m.value] } : m));
    const value: Catalog = { ...draft, models, defaults: { ...draft.defaults, agent, ...(preset?.defaultModel ? { model: preset.defaultModel } : {}), ...(preset?.defaultEffort ? { effort: preset.defaultEffort } : {}) } };
    this.catalogCache = { value, at: this.now(), key };
    return value;
  }

  /**
   * Model / effort configured for a subagent type: the claudekei.jsonc preset (the plugin applies it to the Agent call),
   * then the definition's frontmatter, then the SDK catalog's model. Unset fields mean "the parent's".
   */
  private subagentDefaults(agentType: string): SubagentDefaults | undefined {
    const preset = readAgentPresets({ cwd: this.options.cwd, home: this.options.home })[agentType];
    const frontmatter = this.agentFrontmatter.get(agentType);
    const model = preset?.model ?? frontmatter?.model ?? this.catalog().agents.find((a) => a.name === agentType)?.model;
    const effort = preset?.effort ?? frontmatter?.effort;
    return model || effort ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } : undefined;
  }

  /** Starts the startup probe (idempotent while running). Resolves when it has settled. */
  start(): Promise<void> {
    return this.refreshCatalog().then(() => undefined);
  }

  /** Re-runs the probe, updates cache/status and pushes `catalog.updated` / `account.updated` when changed. */
  refreshCatalog(): Promise<Catalog> {
    void loadAgentFrontmatter(this.configFs()).then((defs) => void (this.agentFrontmatter = defs), (e) => this.log('debug', 'agent frontmatter scan failed', String(e)));
    this.catalogPromise ??= (async () => {
      if (!this.probe) this.setStatus('connecting');
      try {
        const runtime = await this.runtimeLoader();
        const result = await probeCatalog({
          queryFactory: runtime.queryFactory,
          cwd: this.options.cwd,
          env: await this.buildEnv(),
          executablePath: this.executable().path,
          stderr: (d) => this.log('debug', `[probe stderr] ${d.trim()}`),
          // The startup probe also reads the plan limits (no model turn, ~0.4 s), so they show right away.
          afterInit: async (q) => void this.applyUsageRaw(await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?.({ skipBehaviors: true })),
        });
        this.applyProbe(result);
        if (this.options.measureModelWindows !== false) void this.measureModelWindows();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log('warn', 'catalog probe failed', message);
        this.setStatus('error', `Could not start Claude Code: ${message}`);
      } finally {
        this.catalogPromise = undefined;
      }
    })();
    return this.catalogPromise.then(() => this.catalog());
  }

  /** Probe result from the startup probe or from a live session's `initializationResult()`. */
  private applyProbe(result: ProbeResult): void {
    const accountChanged = JSON.stringify(result.account) !== JSON.stringify(this.account);
    this.probe = result;
    this.account = result.account;
    this.lastProbeAt = this.now();
    this.catalogCache = undefined;
    void this.options.store.update(CATALOG_KEY, { probe: result, savedAt: this.now() } satisfies CatalogCache);
    const events: ClaudeEvent[] = [];
    const catalog = this.catalog();
    const json = JSON.stringify(catalog);
    if (json !== this.lastCatalogJson) {
      this.lastCatalogJson = json;
      events.push({ type: 'catalog.updated', properties: { catalog } });
    }
    if (accountChanged) events.push({ type: 'account.updated', properties: { account: result.account } });
    if (events.length) this.options.broadcaster.emit(events);
    if (looksLoggedOut(result.account)) {
      this.setStatus('error', AUTH_MESSAGE);
      // Tell open webviews (they show the login banner until a non-null `account.updated` arrives).
      this.options.broadcaster.emit([this.authError()]);
    } else this.setStatus('connected');
  }

  /** `system/commands_changed` from a live process (skills/commands loaded after init). */
  private applyCommands(commands: SlashCommand[]): void {
    if (!this.probe) return;
    if (JSON.stringify(commands) === JSON.stringify(this.probe.commands)) return;
    this.probe = { ...this.probe, commands };
    this.catalogCache = undefined;
    void this.options.store.update(CATALOG_KEY, { probe: this.probe, savedAt: this.now() } satisfies CatalogCache);
    const catalog = this.catalog();
    this.lastCatalogJson = JSON.stringify(catalog);
    this.options.broadcaster.emit([{ type: 'catalog.updated', properties: { catalog } }]);
  }

  private authError(): ClaudeEvent {
    return { type: 'session.error', properties: { error: { name: 'AuthRequired', message: AUTH_MESSAGE, kind: 'auth' } } };
  }

  private async onSessionInit(_init: InitInfo, query: ClaudeQuery): Promise<void> {
    try {
      this.applyProbe(probeFromInit(await query.initializationResult()));
    } catch (error) {
      this.log('debug', 'initializationResult after init failed', error);
    }
  }

  /** Audit trail for commands the user ran from a code block (ClaudeKei output channel). */
  logCommand(command: string): void {
    this.log('info', 'terminal.run', { command: command.length > 500 ? `${command.slice(0, 500)}...` : command });
  }

  // --- model context windows ---------------------------------------------------

  /**
   * Cache key of the Claude Code build: a new CLI can change model windows. The bundled binary is identified by its
   * platform package name and version (stable across a reinstall of the extension, which re-extracts the file and
   * changes its path/mtime), plus the CLI version the SDK declares. Only a user-configured executable falls back to
   * path + size + mtime.
   */
  private cliKey(): string {
    const resolution = this.executable();
    const path = resolution.path;
    if (!path) return 'sdk-default';
    if (resolution.source === 'bundled') {
      try {
        const pkg = JSON.parse(readFileSync(join(dirname(path), 'package.json'), 'utf8')) as { name?: string; version?: string };
        if (pkg.name && pkg.version) {
          let cli = '';
          try {
            const sdk = JSON.parse(readFileSync(join(dirname(dirname(path)), 'claude-agent-sdk', 'package.json'), 'utf8')) as { claudeCodeVersion?: string };
            if (sdk.claudeCodeVersion) cli = `+cli${sdk.claudeCodeVersion}`;
          } catch {
            /* optional */
          }
          return `bundled:${pkg.name.replace(/^@anthropic-ai\//, '')}@${pkg.version}${cli}`;
        }
      } catch {
        /* no package.json next to the binary: fall through to the file identity */
      }
    }
    try {
      const st = statSync(path);
      return `${path}:${st.size}:${Math.round(st.mtimeMs)}`;
    } catch {
      return path;
    }
  }

  private persistModelWindows(): void {
    void (this.options.globalStore ?? this.options.store).update(WINDOWS_KEY, { key: this.modelWindowsKey, windows: this.modelWindows, ...(this.windowsStale ? { stale: true } : {}) });
  }

  /** Pushes `catalog.updated` when the catalog (now including new windows) changed. */
  private announceCatalogIfChanged(): void {
    this.catalogCache = undefined;
    const catalog = this.catalog();
    const json = JSON.stringify(catalog);
    if (json === this.lastCatalogJson) return;
    this.lastCatalogJson = json;
    this.options.broadcaster.emit([{ type: 'catalog.updated', properties: { catalog } }]);
  }

  /** An exact measurement of a live session: remember the model's fixed context cost to seed new sessions. */
  private recordContextBaseline(modelValue: string, baseline: ContextBaseline): void {
    if (JSON.stringify(this.contextBaselines[modelValue]) === JSON.stringify(baseline)) return;
    this.contextBaselines = { ...this.contextBaselines, [modelValue]: baseline };
    void (this.options.globalStore ?? this.options.store).update(BASELINES_KEY, this.contextBaselines);
  }

  /** Lazy fallback: a live session measured the window of its selected model. */
  private recordModelWindow(modelValue: string, maxTokens: number): void {
    if (!(maxTokens > 0) || this.modelWindows[modelValue] === maxTokens) return;
    this.modelWindows = { ...this.modelWindows, [modelValue]: maxTokens };
    this.persistModelWindows();
    this.announceCatalogIfChanged();
  }

  /**
   * Measures `ModelInfo.contextWindow` for every catalog model whose window is not cached: on a no-turn probe,
   * `setModel(value)` then `getContextUsage({detail:'summary'})` (`rawMaxTokens`, the window before any adjustment;
   * `maxTokens` is identical for every model seen). Needs ~0.65 s per model (the model switch dominates), so it runs in
   * the background after the catalog is published and only for models missing from the cache (keyed by CLI binary).
   */
  measureModelWindows(): Promise<void> {
    this.windowsMeasuring ??= (async () => {
      try {
        const key = this.cliKey();
        if (this.modelWindowsKey !== key) {
          // The binary changed while running (e.g. the executable setting): everything measured so far is provisional.
          this.modelWindowsKey = key;
          this.windowsStale = true;
        }
        const missing = (this.probe?.models ?? []).map((m) => m.value).filter((v) => this.windowsStale || this.modelWindows[v] === undefined);
        if (missing.length === 0 || this.status === 'error') return;
        const startedAt = this.now();
        const runtime = await this.runtimeLoader();
        const found: Record<string, number> = {};
        await probeCatalog({
          queryFactory: runtime.queryFactory,
          cwd: this.options.cwd,
          env: await this.buildEnv(),
          executablePath: this.executable().path,
          stderr: (d) => this.log('debug', `[probe stderr] ${d.trim()}`),
          afterInitTimeoutMs: 60_000,
          afterInit: async (q) => {
            if (!q.getContextUsage) return;
            for (const value of missing) {
              try {
                await q.setModel(value === 'default' ? undefined : value);
                const raw = (await q.getContextUsage({ detail: 'summary' })) as { rawMaxTokens?: number; maxTokens?: number } | undefined;
                const window = raw?.rawMaxTokens ?? raw?.maxTokens;
                if (typeof window === 'number' && window > 0) found[value] = window;
              } catch (error) {
                this.log('warn', 'model window measurement failed', { value, error: error instanceof Error ? error.message : String(error) });
                // setModel may be refused on this query: the lazy path (live sessions) fills in later
                if (Object.keys(found).length === 0) return;
              }
            }
            await q.setModel(undefined).catch(() => undefined);
          },
        });
        this.windowsStale = false;
        this.log('info', 'model context windows measured', { key, requested: missing.length, measured: Object.keys(found).length, ms: this.now() - startedAt });
        if (Object.keys(found).length > 0) {
          this.modelWindows = { ...this.modelWindows, ...found };
        }
        this.persistModelWindows();
        this.announceCatalogIfChanged();
      } catch (error) {
        this.log('warn', 'model window measurement failed', error instanceof Error ? error.message : String(error));
      } finally {
        this.windowsMeasuring = undefined;
      }
    })();
    return this.windowsMeasuring;
  }

  // --- usage limits ------------------------------------------------------------

  /** Last known plan limits (persisted, so they show at startup). */
  getUsage(): UsageLimits | undefined {
    return this.usage;
  }

  private setUsage(next: UsageLimits | undefined): void {
    if (!next) return;
    const changed = JSON.stringify({ ...this.usage, updatedAt: 0 }) !== JSON.stringify({ ...next, updatedAt: 0 });
    this.usage = next;
    void (this.options.globalStore ?? this.options.store).update(USAGE_KEY, next);
    if (changed) this.options.broadcaster.emit([{ type: 'usage.updated', properties: { usage: next } }]);
  }

  /** Folds an SDK usage response in; returns the new limits (undefined when the response is unusable). */
  private applyUsageRaw(raw: unknown): UsageLimits | undefined {
    if (raw === undefined || raw === null) return undefined;
    const now = this.now();
    this.lastUsageFetchAt = now;
    const parsed = parseUsageReport(raw, now, this.account);
    const previous = this.usage;
    // Only an explicit "no plan limits" (API key / third party) clears known windows; a missing or empty report is a glitch.
    const explicitNone = typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).rate_limits_available === false;
    let next = parsed;
    if (previous && previous.windows.length > 0 && !explicitNone) {
      if (parsed.windows.length === 0) {
        this.log('debug', 'usage report without windows ignored; keeping the last known limits', { kept: previous.windows.length, raw });
        return previous;
      }
      next = carryOverWindows(previous, parsed, now);
    }
    if (previous && next.windows.length < previous.windows.length) this.log('debug', 'usage report has fewer windows than before', { before: previous.windows.length, after: next.windows.length, raw });
    this.setUsage(next);
    return next;
  }

  /** `rate_limit_event` from a live turn: update that window right away, then refresh everything (throttled). */
  private onRateLimit(info: Record<string, unknown>): void {
    this.setUsage(applyRateLimitEvent(this.usage, info, this.now()));
    if (this.now() - this.lastUsageFetchAt >= USAGE_REFRESH_MIN_MS) void this.refreshUsage();
  }

  /**
   * Re-reads the plan limits without a model turn: through a live session's process when there is one, else through
   * a short-lived probe. API-key / third-party providers resolve `windows: []`. Failures keep the last known value.
   */
  refreshUsage(): Promise<UsageLimits> {
    this.usageRefreshing ??= (async () => {
      const empty = (): UsageLimits => this.usage ?? { windows: [], updatedAt: this.now(), source: 'usage' };
      try {
        const live = this.liveQuery((q) => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET);
        if (live) return this.applyUsageRaw(await live.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET!({ skipBehaviors: true })) ?? empty();
        const raw = await this.runOnProbe((q) => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET!({ skipBehaviors: true }), 8000);
        return this.applyUsageRaw(raw) ?? empty();
      } catch (error) {
        this.log('debug', 'usage refresh failed', error instanceof Error ? error.message : String(error));
        return empty();
      } finally {
        this.usageRefreshing = undefined;
      }
    })();
    return this.usageRefreshing;
  }

  /** The query of a live session that supports `has` (host-wide calls that need no turn). */
  private liveQuery(has: (q: ClaudeQuery) => unknown): ClaudeQuery | undefined {
    return [...this.sessions.values()].map((s) => s.liveQuery()).find((q) => q && has(q));
  }

  /**
   * Runs `fn` on a short-lived probe query (no model turn, no transcript). Resolves `undefined` when `fn` did not finish
   * within `timeoutMs`; rejects when the probe cannot start or `fn` throws.
   */
  private async runOnProbe<T>(fn: (q: ClaudeQuery) => Promise<T>, timeoutMs: number): Promise<T | undefined> {
    const runtime = await this.runtimeLoader();
    let result: T | undefined;
    let failure: { error: unknown } | undefined;
    await probeCatalog({
      queryFactory: runtime.queryFactory,
      cwd: this.options.cwd,
      env: await this.buildEnv(),
      executablePath: this.executable().path,
      stderr: (d) => this.log('debug', `[probe stderr] ${d.trim()}`),
      afterInitTimeoutMs: timeoutMs,
      afterInit: async (q) => {
        try {
          result = await fn(q);
        } catch (error) {
          failure = { error };
        }
      },
    });
    if (failure) throw failure.error;
    return result;
  }

  // --- config (settings pages) -----------------------------------------------------

  /** Paths and trash for `claudeConfig.ts` (agents / commands / skills / plugins on disk). */
  configFs(): ConfigFsOptions {
    return { cwd: this.options.cwd, home: this.options.home, trash: this.options.trash };
  }

  /** Options of the skills catalog (git over HTTPS needs the child environment). */
  async skillsOptions(): Promise<SkillsCatalogOptions> {
    return { ...this.configFs(), env: await this.buildEnv() };
  }

  /**
   * Agents / skills / plugins / MCP servers changed on disk: live sessions pick them up with a respawn (resume) on their
   * next idle send, and the catalog (agents, commands) is re-probed.
   */
  reloadConfig(): Promise<Catalog> {
    for (const s of this.sessions.values()) if (s.isLive) s.markConfigStale();
    this.mcpCache = undefined;
    return this.refreshCatalog();
  }

  /** MCP servers with their live status, from a short-lived probe (cached 30 s; concurrent callers share one probe). */
  mcpStatus(refresh = false): Promise<McpStatusSnapshot> {
    if (!refresh && this.mcpCache && this.now() - this.mcpCache.at < MCP_CACHE_MS) return Promise.resolve(this.mcpCache.value);
    this.mcpInFlight ??= (async () => {
      try {
        const raw = await this.runOnProbe(async (q) => {
          if (!q.mcpServerStatus) throw new Error('This Claude Code version cannot report MCP status');
          // Servers start connecting in the background: wait until none is pending (capped).
          const deadline = this.now() + MCP_SETTLE_MS;
          for (;;) {
            const entries = await q.mcpServerStatus();
            if (!mapMcpServers(entries).some((m) => m.status === 'pending') || this.now() >= deadline) return entries;
            await new Promise((resolve) => setTimeout(resolve, this.options.mcpPollMs ?? 250));
          }
        }, MCP_PROBE_CAP_MS);
        if (!raw) throw new Error('Timed out reading MCP server status');
        const servers = mapMcpServers(raw);
        this.mcpRaw = new Map(
          raw.flatMap((entry): Array<[string, unknown]> => {
            const mapped = mapMcpServers([entry])[0];
            return mapped?.scope ? [[`${mapped.scope}:${mapped.name}`, (entry as { config?: unknown }).config]] : [];
          }),
        );
        this.lastKnownMcp = servers;
        const value: McpStatusSnapshot = { servers, updatedAt: this.now() };
        this.mcpCache = { value, at: this.now() };
        return value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log('warn', 'MCP status probe failed', message);
        return { servers: this.lastKnownMcp ?? [], updatedAt: this.now(), error: message };
      } finally {
        this.mcpInFlight = undefined;
      }
    })();
    return this.mcpInFlight;
  }

  /** Enables / disables a server; Claude Code persists it (`disabledMcpServers` in `~/.claude.json`, W0 notes section 10). */
  async toggleMcp(name: string, enabled: boolean): Promise<void> {
    if (!name) throw new Error('Missing server name');
    const done = await this.runOnProbe(async (q) => {
      if (!q.toggleMcpServer) throw new Error('Enabling and disabling MCP servers is not supported by this Claude Code version');
      await q.toggleMcpServer(name, enabled);
      return true;
    }, MCP_TOGGLE_MS);
    if (!done) throw new Error('Timed out changing the MCP server');
    await this.reloadConfig();
  }

  private cliRun(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return this.buildEnv().then((env) => this.cli(args, { cwd: this.options.cwd, env }));
  }

  /**
   * Adds (`create`) or replaces a server through `claude mcp`. Projects servers live in `.mcp.json`, which the user edits.
   * An update is remove + add-json; when the add fails the previous entry is added back.
   */
  async saveMcp(req: { name: string; scope: McpServerScope; config: McpTransportConfig; create: boolean }): Promise<void> {
    const { name, scope, config, create } = req;
    if (!MCP_NAME.test(name)) throw new Error('Server names may only contain letters, digits, "-" and "_" (max 64)');
    if (scope !== 'user' && scope !== 'local' && scope !== 'project') throw new Error('Invalid scope');
    if (create && scope === 'project') throw new Error('Add project servers in .mcp.json');
    validateMcpConfig(config);
    if (create) {
      await this.cliRun(['mcp', 'add-json', '-s', scope, '--', name, mcpConfigJson(config)]);
    } else {
      // The stored config is read fresh (never from the 30 s cache) and the edit is merged onto it, so fields the form
      // does not show (oauth, headersHelper, timeout, ...) survive the replace and the rollback.
      const status = await this.mcpStatus(true);
      if (status.error) throw new Error(`Could not read the current server configuration: ${status.error}`);
      const key = `${scope}:${name}`;
      if (!this.mcpRaw.has(key) || !status.servers.some((s) => s.name === name && s.scope === scope)) throw new Error(`MCP server "${name}" was not found in ${scope} scope; refresh the list and try again`);
      const previousRaw = this.mcpRaw.get(key);
      const previous = JSON.stringify(previousRaw);
      const next = JSON.stringify(mergeMcpConfig(previousRaw, config));
      await this.cliRun(['mcp', 'remove', '-s', scope, '--', name]);
      try {
        await this.cliRun(['mcp', 'add-json', '-s', scope, '--', name, next]);
      } catch (error) {
        await this.cliRun(['mcp', 'add-json', '-s', scope, '--', name, previous]).catch((restore) => this.log('warn', 'could not restore the previous MCP server entry', { name, error: restore instanceof Error ? restore.message : String(restore) }));
        throw error;
      }
    }
    await this.reloadConfig();
  }

  async removeMcp(req: { name: string; scope: McpServerScope }): Promise<void> {
    if (!MCP_NAME.test(req.name)) throw new Error('Invalid server name');
    if (req.scope !== 'user' && req.scope !== 'local' && req.scope !== 'project') throw new Error('Invalid scope');
    await this.cliRun(['mcp', 'remove', '-s', req.scope, '--', req.name]);
    await this.reloadConfig();
  }

  /** Plugin on/off in the scope it is installed in (`claude plugin enable|disable <id> -s <scope>`). */
  async setPluginEnabled(id: string, enabled: boolean): Promise<void> {
    // The CLI happily "enables" an unknown id by writing it to settings.json (W0 notes section 10): check it is installed.
    const plugin = (await listConfig(this.configFs())).plugins.find((p) => p.id === id);
    if (!plugin) throw new Error(`Plugin "${id}" is not installed`);
    try {
      await this.cliRun(['plugin', enabled ? 'enable' : 'disable', '-s', plugin.scope, '--json', '--', id]);
    } catch (error) {
      // Asking for the state it is already in exits 1; that is the outcome the user wanted.
      if (!/already (enabled|disabled)/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
    await this.reloadConfig();
  }

  /** What contributes to the plan limits (24 h / 7 d, local transcripts); also refreshes the limits. Null = unavailable. */
  async usageActivity(): Promise<UsageActivity | null> {
    const ask = (q: ClaudeQuery) => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET!({ skipBehaviors: false });
    const live = this.liveQuery((q) => q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET);
    const raw = live ? await ask(live) : await this.runOnProbe(ask, USAGE_ACTIVITY_MS);
    if (raw === undefined) throw new Error('Timed out reading usage activity');
    this.applyUsageRaw(raw);
    return parseUsageActivity(raw, this.now());
  }

  async contextUsage(sessionId: string): Promise<ContextUsage> {
    // A subagent child session shares its parent's context window: answer with the owning session's usage.
    if (sessionId.startsWith('sub_')) {
      for (const s of this.sessions.values()) if (s.state.sessions.get(sessionId)?.info) return s.contextUsageNow();
      throw new Error(`Subagent session ${sessionId} not found`);
    }
    return (await this.resolve(sessionId)).contextUsageNow();
  }

  // --- prefs -------------------------------------------------------------------

  private storedPrefs(): Record<string, SessionPrefs> {
    return this.options.store.get<Record<string, SessionPrefs>>(PREFS_KEY, {});
  }

  private prefsFor(id: string): SessionPrefs {
    const defaults = this.catalog().defaults;
    const stored = this.storedPrefs()[id];
    // `effort: null` is an explicit "model default"; a missing value follows the catalog default.
    const effort = stored && 'effort' in stored ? stored.effort : (defaults.effort ?? null);
    return { model: stored?.model ?? defaults.model, mode: stored?.mode ?? defaults.mode, agent: stored?.agent ?? defaults.agent, effort };
  }

  /** Concrete model id for a selected `ModelInfo.value` (catalog lookup; a full id resolves to itself). */
  private resolveModel(value: string): string | undefined {
    const known = this.catalog().models.find((m) => m.value === value)?.resolvedModel;
    if (known) return known;
    return /^claude-/.test(value) ? value : undefined;
  }

  /**
   * Re-reads `claudekei.jsonc` presets (file watcher / settings change): the catalog is rebuilt and pushed when it
   * changed. Existing sessions keep their model/effort; presets apply on new sessions and agent switches.
   */
  reloadAgentPresets(): void {
    this.announceCatalogIfChanged();
  }

  private savePrefs(session: ClaudeSession): void {
    void this.options.store.update(PREFS_KEY, { ...this.storedPrefs(), [session.id]: session.prefs });
  }

  // --- sessions ----------------------------------------------------------------

  private toSession(info: SdkSessionInfo): Session {
    const prefs = this.prefsFor(info.sessionId);
    return {
      id: info.sessionId,
      title: info.customTitle ?? (info.summary || info.firstPrompt || 'New session'),
      directory: info.cwd ?? this.options.cwd,
      time: { created: info.createdAt ?? info.lastModified, updated: info.lastModified },
      agent: prefs.agent || undefined,
      mode: prefs.mode,
      model: prefs.model,
      ...(prefs.effort ? { effort: prefs.effort } : {}),
      ...(this.resolveModel(prefs.model) ? { resolvedModel: this.resolveModel(prefs.model) } : {}),
      claude: { ...(info.gitBranch ? { gitBranch: info.gitBranch } : {}), ...(info.fileSize !== undefined ? { fileSize: info.fileSize } : {}) },
    };
  }

  private adopt(info: Session, exists: boolean): ClaudeSession {
    const session = new ClaudeSession(this.deps, { info, prefs: this.prefsFor(info.id), exists });
    session.refreshInfo = (s) => this.refreshInfo(s);
    this.sessions.set(info.id, session);
    return session;
  }

  private async resolve(sessionId: string): Promise<ClaudeSession> {
    if (this.deletedIds.has(sessionId)) throw new Error('This session was deleted');
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const runtime = await this.runtimeLoader();
    const info = await runtime.sessions.getSessionInfo(sessionId, { dir: this.options.cwd });
    if (!info) throw new Error(`Session ${sessionId} not found`);
    return this.sessions.get(sessionId) ?? this.adopt(this.toSession(info), true);
  }

  private async refreshInfo(session: ClaudeSession): Promise<void> {
    if (this.disposed) return;
    try {
      const info = await (await this.runtimeLoader()).sessions.getSessionInfo(session.id, { dir: this.options.cwd });
      if (info) {
        const fresh = this.toSession(info);
        session.updateInfo({ title: fresh.title, claude: fresh.claude });
      }
    } catch {
      /* best effort */
    }
  }

  async list(limit?: number): Promise<Session[]> {
    const runtime = await this.runtimeLoader();
    const listed = await runtime.sessions.listSessions({ dir: this.options.cwd, limit });
    const result: Session[] = [];
    const seen = new Set<string>();
    for (const info of listed) {
      const session = this.toSession(info);
      seen.add(session.id);
      const live = this.sessions.get(session.id);
      if (live) {
        live.updateInfo({ title: session.title, claude: session.claude, time: session.time });
        result.push(live.info);
      } else result.push(session);
    }
    this.trimSessions();
    // Started sessions the transcript listing does not show yet.
    for (const s of this.sessions.values()) if ((s.exists || s.isLive) && !seen.has(s.id)) result.unshift(s.info);
    return result;
  }

  create(title?: string): Session {
    const id = randomUUID();
    const t = this.now();
    const info: Session = { id, title: title?.trim() || 'New session', directory: this.options.cwd, time: { created: t, updated: t } };
    return this.adopt(info, false).info;
  }

  async load(sessionId: string, sinkId?: string): Promise<SessionSnapshot> {
    if (sessionId.startsWith('sub_')) {
      for (const s of this.sessions.values()) {
        const child = s.getChildSnapshot(sessionId);
        if (child) return { ...child, eventSeq: this.options.broadcaster.flushSink(sinkId) };
      }
      throw new Error(`Subagent session ${sessionId} not found`);
    }
    const session = await this.resolve(sessionId);
    await session.ensureLoaded();
    // Synchronous from here: the requesting webview gets its queued events first, then the snapshot with its seq.
    const eventSeq = this.options.broadcaster.flushSink(sinkId);
    const snapshot = { ...session.getSnapshot(), eventSeq };
    session.lastActivity = this.now();
    this.trimSessions();
    return snapshot;
  }

  async send(sessionId: string, input: SendInput): Promise<{ messageId: string }> {
    const session = await this.resolve(sessionId);
    if (session.isDisposed) throw new Error('This session was deleted');
    const mode = input.mode === undefined ? undefined : this.validMode(input.mode);
    if (input.effort !== undefined && input.effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(input.effort)) {
      this.log('warn', 'ignoring invalid effort', { effort: input.effort });
      input = { ...input, effort: undefined };
    }
    if (!session.isLive) await this.makeRoom(session);
    return session.send({ ...input, mode });
  }

  /** Host-side validation of a permission mode coming from the webview. */
  private validMode(mode: unknown): PermissionMode | undefined {
    if (typeof mode !== 'string' || !(PERMISSION_MODES as readonly string[]).includes(mode)) {
      this.log('warn', 'ignoring invalid permission mode', { mode });
      return undefined;
    }
    if (mode === 'bypassPermissions' && !this.config.allowBypassPermissions) {
      this.log('warn', 'bypassPermissions is disabled (claudekei.allowBypassPermissions); ignored');
      return undefined;
    }
    return mode as PermissionMode;
  }

  /**
   * Live cap: close the least recently used *idle* live session(s); never a busy one (soft cap). Each close is
   * re-checked inside the session's exclusive section (`closeIfIdle`), so a send that just arrived wins.
   */
  private async makeRoom(incoming: ClaudeSession): Promise<void> {
    const max = Math.max(1, this.config.maxLiveSessions);
    const tried = new Set<string>();
    for (;;) {
      const live = [...this.sessions.values()].filter((s) => s !== incoming && s.isLive);
      if (live.length < max) return;
      const idle = live.filter((s) => !tried.has(s.id) && s.lifecycle === 'live-idle' && s.broker.size === 0).sort((a, b) => a.lastActivity - b.lastActivity);
      const victim = idle[0];
      if (!victim) {
        this.log('warn', 'live session cap reached and every live session is busy; exceeding the cap', { max });
        return;
      }
      tried.add(victim.id);
      if (await victim.closeIfIdle()) this.log('info', 'closed least recently used idle session to stay under the live cap', { id: victim.id });
    }
  }

  /** Dry run of the file rewind behind a revert to `messageId` (never interrupts). */
  async revertPreview(sessionId: string, messageId: string): Promise<RevertPreview> {
    const session = await this.revertSession(sessionId);
    return session.revertPreview(messageId);
  }

  /** Restores files and hides `messageId` and everything after it until the next send (commit) or `unrevert`. */
  async revert(sessionId: string, messageId: string): Promise<RevertResult> {
    const session = await this.revertSession(sessionId);
    return session.revert(messageId);
  }

  async unrevert(sessionId: string): Promise<void> {
    await (await this.resolve(sessionId)).unrevert();
  }

  private async revertSession(sessionId: string): Promise<ClaudeSession> {
    if (sessionId.startsWith('sub_')) throw new Error('Subagent sessions cannot be reverted');
    const session = await this.resolve(sessionId);
    if (!session.isLive) await this.makeRoom(session);
    return session;
  }

  async interrupt(sessionId: string): Promise<void> {
    // Stop in a subagent view (virtual `sub_` child) stops everything: interrupt the session that owns the child.
    const owner = this.sessions.get(sessionId) ?? (sessionId.startsWith('sub_') ? [...this.sessions.values()].find((s) => s.state.sessions.has(sessionId)) : undefined);
    await owner?.interrupt();
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    await (await this.resolve(sessionId)).setModel(model);
  }

  async setMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const valid = this.validMode(mode);
    if (!valid) return;
    await (await this.resolve(sessionId)).setMode(valid);
  }

  async setAgent(sessionId: string, agent: string): Promise<void> {
    (await this.resolve(sessionId)).setAgent(agent);
  }

  async setEffort(sessionId: string, effort: EffortLevel | null): Promise<void> {
    if (effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
      this.log('warn', 'ignoring invalid effort', { effort });
      return;
    }
    await (await this.resolve(sessionId)).setEffort(effort);
  }

  respondPermission(sessionId: string, requestId: string, response: PermissionResponse): void {
    const s = this.sessions.get(sessionId);
    if (!s || !s.respondPermission(requestId, response)) this.log('debug', 'permission response for unknown request', { sessionId, requestId });
  }

  respondQuestion(sessionId: string, requestId: string, answers: QuestionAnswer[] | { reject: true }): void {
    const s = this.sessions.get(sessionId);
    if (!s || !s.respondQuestion(requestId, answers)) this.log('debug', 'question response for unknown request', { sessionId, requestId });
  }

  async rename(sessionId: string, title: string): Promise<void> {
    const session = await this.resolve(sessionId);
    const clean = title.trim();
    if (!clean) throw new Error('Title must not be empty');
    if (session.exists) await (await this.runtimeLoader()).sessions.renameSession(sessionId, clean, { dir: this.options.cwd });
    session.updateInfo({ title: clean });
  }

  /**
   * Forks via the SDK helper (no process): the new session is a normal cold session.
   * - at an assistant message: up to the last transcript entry of that message that does not split a
   *   tool_use from its tool_result (a trailing tool call includes its result entry);
   * - at a user message: up to the entry *before* it (the fork is where that prompt can be re-written);
   *   forking at the very first message yields a fresh empty session.
   */
  async fork(sessionId: string, atMessageId?: string): Promise<Session> {
    const source = await this.resolve(sessionId);
    if (!source.exists) throw new Error('Nothing to fork yet: the session has no messages');
    let upToMessageId: string | undefined;
    if (atMessageId) {
      await source.ensureLoaded();
      const messages = source.state.sessions.get(sessionId)?.messages ?? [];
      const index = messages.findIndex((m) => m.id === atMessageId);
      if (index < 0) throw new Error('That message is not part of this session');
      const bucket = source.state.sessions.get(sessionId)!;
      const target = messages[index]!;
      upToMessageId = target.role === 'user' ? cutUuidBefore(messages, bucket.parts, index) : cutUuidBefore(messages, bucket.parts, index + 1);
      if (!upToMessageId) {
        if (target.role === 'user' && index === 0) {
          const fresh = this.create(`${source.info.title} (fork)`);
          this.sessions.get(fresh.id)!.prefs = { ...source.prefs };
          return this.sessions.get(fresh.id)!.info;
        }
        throw new Error('That message cannot be forked from (no transcript uuid)');
      }
    }
    const runtime = await this.runtimeLoader();
    const forked = await runtime.sessions.forkSession(sessionId, { dir: this.options.cwd, upToMessageId });
    const info = await runtime.sessions.getSessionInfo(forked.sessionId, { dir: this.options.cwd });
    const session = this.adopt(info ? this.toSession(info) : { id: forked.sessionId, title: `${source.info.title} (fork)`, directory: this.options.cwd, time: { created: this.now(), updated: this.now() } }, true);
    // Forks inherit the source's preferences.
    session.prefs = { ...source.prefs };
    session.syncPrefsToInfo();
    this.savePrefs(session);
    // The SDK remaps message uuids on fork, so per-turn agents cannot be carried over; the first agent still can.
    const initial = this.agentLog.forReplay(sessionId)?.initial;
    if (initial) this.agentLog.noteInitial(session.id, initial);
    this.options.broadcaster.emit([{ type: 'session.created', properties: { sessionID: session.id, info: session.info } }]);
    return session.info;
  }

  async delete(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    const info = session?.info;
    this.deletedIds.add(sessionId);
    // Unreachable first (no new sends, no idle/LRU decisions), then close, then remove the transcript.
    if (session) {
      session.markDisposed();
      this.sessions.delete(sessionId);
      this.clearIdle(sessionId);
      await session.close();
    }
    try {
      await (await this.runtimeLoader()).sessions.deleteSession(sessionId, { dir: this.options.cwd });
    } catch (error) {
      // Drafts have no transcript.
      if (session?.exists !== false && !/not found/i.test(error instanceof Error ? error.message : '')) throw error;
    }
    const prefs = this.storedPrefs();
    if (prefs[sessionId]) {
      delete prefs[sessionId];
      void this.options.store.update(PREFS_KEY, prefs);
    }
    this.agentLog.remove(sessionId);
    await this.deps.revertStore?.clear(sessionId);
    if (info) this.options.broadcaster.emit([{ type: 'session.deleted', properties: { sessionID: sessionId, info } }]);
  }

  // --- bootstrap ---------------------------------------------------------------

  async bootstrap(sinkId?: string): Promise<BootstrapResponse> {
    // A missing cache must not return fallback data: wait for the first probe. Otherwise refresh in the background,
    // at most every few minutes (each probe spawns a process).
    if (!this.probe) await this.refreshCatalog();
    else if (this.now() - this.lastProbeAt > PROBE_MIN_INTERVAL_MS && !this.catalogPromise) void this.refreshCatalog();
    const sessions = await this.list();
    const live: Record<string, LiveSessionState> = {};
    for (const s of this.sessions.values()) {
      if (s.isLive || s.broker.size > 0) live[s.id] = { status: s.status, permissions: s.broker.permissions, questions: s.broker.questions };
    }
    // Everything below is synchronous: this webview's queued events are pushed first, then the snapshot with its seq.
    const eventSeq = this.options.broadcaster.flushSink(sinkId);
    // Logged out: the response carries `account: null`; also push the auth error so the banner shows at startup.
    if (this.probe && looksLoggedOut(this.account)) this.options.broadcaster.emit([this.authError()]);
    return structuredClone({ cwd: this.options.cwd, account: this.account, catalog: this.catalog(), ...(this.usage ? { usage: this.usage } : {}), sessions, live, eventSeq });
  }

  // --- idle policy ---------------------------------------------------------------

  private clearIdle(id: string): void {
    const t = this.idleTimers.get(id);
    if (t !== undefined) {
      this.timers.clearTimeout(t);
      this.idleTimers.delete(id);
    }
  }

  private onSessionActivity(session: ClaudeSession, state: 'idle' | 'busy'): void {
    this.clearIdle(session.id);
    const minutes = this.config.idleTimeoutMinutes;
    if (state !== 'idle' || !session.isLive || minutes <= 0) return;
    this.idleTimers.set(
      session.id,
      this.timers.setTimeout(() => {
        this.idleTimers.delete(session.id);
        // Re-checked inside the session's exclusive section: a send that arrived meanwhile is never killed.
        void session.closeIfIdle().then((closed) => {
          if (closed) this.log('info', 'closed idle session process', { id: session.id });
        });
      }, minutes * 60_000),
    );
  }

  // --- lifecycle / diagnostics ---------------------------------------------------

  /** Unloads cold sessions beyond the keep limit (LRU) and stale unsent drafts. Live/pending sessions are never touched. */
  private trimSessions(): void {
    const now = this.now();
    // A session with a pending revert is never unloaded: its marker is resolved against the loaded transcript.
    const candidates = [...this.sessions.values()].filter((s) => !s.isLive && s.broker.size === 0 && !s.hasRevert && s.lifecycle !== 'starting' && s.lifecycle !== 'closing');
    for (const s of candidates) {
      if (!s.exists && now - s.lastActivity > DRAFT_TTL_MS) this.sessions.delete(s.id);
    }
    const loaded = candidates.filter((s) => this.sessions.has(s.id)).sort((a, b) => b.lastActivity - a.lastActivity);
    for (const s of loaded.slice(MAX_LOADED_SESSIONS)) {
      // Unsent drafts (no transcript) cannot be reloaded; keep them until the TTL.
      if (s.exists) this.sessions.delete(s.id);
    }
  }

  /** Warning for collaborators (bridge allowlist rejections). */
  warn(message: string, data?: unknown): void {
    this.log('warn', message, data);
  }

  /** Closes every live process (they respawn lazily on the next send) and re-probes the catalog. */
  async restartSessions(): Promise<void> {
    await Promise.all([...this.sessions.values()].filter((s) => s.isLive).map((s) => s.close()));
    await this.refreshCatalog();
  }

  async diagnostics(): Promise<Diagnostics> {
    const loginPath = await (this.options.loginPath ?? (() => resolveLoginShellPath()))();
    const env = await this.buildEnv();
    const catalog = this.catalog();
    return {
      status: this.status,
      error: this.statusError,
      cwd: this.options.cwd,
      executable: this.executable(),
      loginPath,
      nodeOnPath: findOnPath('node', env.PATH),
      account: this.account,
      catalog: { models: catalog.models.length, commands: catalog.commands.length, agents: catalog.agents.length, primaryAgents: catalog.primaryAgents.map((p) => p.name) },
      liveSessions: [...this.sessions.values()].filter((s) => s.isLive).map((s) => ({ id: s.id, lifecycle: s.lifecycle, agent: s.spawnedAgent, spawns: s.spawnCount })),
    };
  }

  /** Feeds recorded SDK messages (a fixture) into a synthetic session, as if a live process produced them. */
  async replayFixture(name: string, lines: Array<Record<string, any>>, delayMs = 4): Promise<string> {
    const id = randomUUID();
    const t = this.now();
    const session = this.adopt({ id, title: `Replay: ${name}`, directory: this.options.cwd, time: { created: t, updated: t } }, false);
    this.options.broadcaster.emit([{ type: 'session.created', properties: { sessionID: id, info: session.info } }]);
    const replay = session.attachReplay();
    void (async () => {
      for (const line of lines) {
        if (this.disposed) return;
        const type = String(line.type ?? '');
        if (type === '_input') replay.userMessage(line.message?.message?.content ?? [], line.message?.uuid);
        else if (type.startsWith('_')) continue;
        else replay.apply(line);
        if (delayMs > 0) await new Promise<void>((resolve) => this.timers.setTimeout(resolve, delayMs));
      }
      replay.finish();
    })();
    return id;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const id of [...this.idleTimers.keys()]) this.clearIdle(id);
    await Promise.all([...this.sessions.values()].map((s) => s.close().catch(() => undefined)));
  }
}

/** First directory of `PATH` containing an executable `name`. */
export function findOnPath(name: string, pathValue: string | undefined): string | undefined {
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
