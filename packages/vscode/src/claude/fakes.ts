/** Test-only fakes: a fixture-driven Query, an in-memory session API and manual timers. */
import type { ClaudeEventsPush } from '@openchamber/ui/src/lib/claude/protocol';
import { Broadcaster } from './broadcaster';
import { ClaudeSessionManager, DEFAULT_MANAGER_CONFIG, type ManagerConfig } from './ClaudeSessionManager';
import type { ClaudeQuery, InitializationResult, QueryFactory, QueryParams, SdkRuntime, SdkSessionInfo, SessionApi, SDKMessage } from './sdk';
import { loadNdjson, type FixtureLine } from './testUtils';

export class ManualTimers {
  private now = 0;
  private seq = 0;
  private tasks = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.tasks.delete(h as number);
  };
  get pending(): number {
    return this.tasks.size;
  }
  /** Runs due tasks (in order) while advancing time. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.now = due[1].at;
      this.tasks.delete(due[0]);
      due[1].fn();
    }
    this.now = target;
  }
}

export const tick = (n = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, n));

export async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('until(): timeout');
    await tick(2);
  }
}

export const STUB_INIT: InitializationResult = {
  models: [
    { value: 'default', displayName: 'Default', description: 'd' },
    { value: 'haiku', displayName: 'Haiku', description: 'h' },
  ],
  commands: [{ name: 'compact', description: 'Compact', argumentHint: '', builtin: true }],
  agents: [
    { name: 'general-purpose', description: 'General' },
    { name: 'claudekei:planner', description: 'Plans (claudekei primary agent)' },
    { name: 'claudekei:orchestrator', description: 'Orchestrates (claudekei primary agent)' },
    { name: 'claudekei:sprinter', description: 'Fast (claudekei primary agent)' },
  ],
  account: { email: 'user@example.com', subscriptionType: 'Claude Team', apiProvider: 'firstParty' },
  current_permission_mode: 'default',
};

/** Splits a fixture into one segment per `_input` (a user turn). */
export function segmentsOf(name: string): FixtureLine[][] {
  const segments: FixtureLine[][] = [];
  for (const line of loadNdjson(name)) {
    if (line.type === '_options') continue;
    if (line.type === '_input') segments.push([]);
    else (segments[segments.length - 1] ??= []).push(line);
  }
  return segments;
}

export class FakeQuery implements ClaudeQuery {
  closed = false;
  interrupts = 0;
  models: Array<string | undefined> = [];
  modes: string[] = [];
  prompts: any[] = [];
  /** Results of the host's canUseTool answers, in order. */
  permissionResults: any[] = [];
  private hold?: Promise<void>;
  private release?: () => void;

  constructor(readonly params: QueryParams, private readonly segments: FixtureLine[][], private readonly init: InitializationResult = STUB_INIT) {}

  /** Pauses the next turn before it emits anything until `resume()` is called. */
  pause(): void {
    this.hold = new Promise((r) => (this.release = r));
  }
  resume(): void {
    this.release?.();
    this.hold = undefined;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    const it = this.params.prompt[Symbol.asyncIterator]();
    let turn = 0;
    for (;;) {
      const next = await it.next();
      if (next.done || this.closed) return;
      this.prompts.push(next.value);
      if (this.hold) await this.hold;
      const segment = this.segments[Math.min(turn, this.segments.length - 1)] ?? [];
      turn++;
      for (const line of segment) {
        if (this.closed) return;
        if (line.type === '_canUseTool') {
          const result = await this.params.options.canUseTool!(line.toolName, line.input, {
            signal: this.params.options.abortController!.signal,
            suggestions: line.options?.suggestions,
            toolUseID: line.options?.toolUseID ?? 'toolu_x',
            requestId: line.options?.requestId ?? `req_${turn}_${Math.random()}`,
            displayName: line.options?.displayName,
            description: line.options?.description,
          } as never);
          this.permissionResults.push(result);
          continue;
        }
        if (line.type.startsWith('_')) continue;
        yield line as unknown as SDKMessage;
        await Promise.resolve();
      }
    }
  }
  next(...args: [] | [unknown]): Promise<IteratorResult<SDKMessage, void>> {
    return this.gen.next(...(args as []));
  }
  private gen = this[Symbol.asyncIterator]();
  return(value?: void): Promise<IteratorResult<SDKMessage, void>> {
    return this.gen.return(value as void);
  }
  throw(error: unknown): Promise<IteratorResult<SDKMessage, void>> {
    return this.gen.throw(error);
  }
  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }
  async interrupt(): Promise<unknown> {
    this.interrupts++;
    return { still_queued: [] };
  }
  async setModel(model?: string): Promise<void> {
    this.models.push(model);
  }
  /** Responses of `getContextUsage` / the usage endpoint; unset = the method fails like an unsupported CLI. */
  contextRaw: unknown;
  /** Probe-style measurement: window per model value (the last `setModel` selects it; none = `default`). */
  windowsByModel?: Record<string, number>;
  usageRaw: unknown;
  contextCalls: Array<{ detail?: string }> = [];
  usageCalls = 0;
  async getContextUsage(options?: { detail?: 'summary' | 'full' }): Promise<unknown> {
    this.contextCalls.push({ detail: options?.detail });
    if (this.contextRaw !== undefined) return this.contextRaw;
    if (this.windowsByModel) {
      const model = this.models.at(-1) ?? 'default';
      const w = this.windowsByModel[model];
      if (w === undefined) throw new Error(`unknown model ${model}`);
      return { totalTokens: 0, maxTokens: w, rawMaxTokens: w, categories: [], model };
    }
    throw new Error('unsupported');
  }
  async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<unknown> {
    this.usageCalls++;
    if (this.usageRaw === undefined) throw new Error('unsupported');
    return this.usageRaw;
  }
  /** Effort changes pushed live (`applyFlagSettings`); `failFlags` makes them fail like an older CLI would. */
  flags: any[] = [];
  failFlags = false;
  async applyFlagSettings(settings: unknown): Promise<void> {
    if (this.failFlags) throw new Error('unsupported');
    this.flags.push(settings);
  }
  async setPermissionMode(mode: string): Promise<void> {
    this.modes.push(mode);
  }
  async initializationResult(): Promise<InitializationResult> {
    return this.init;
  }
  close(): void {
    this.closed = true;
    this.params.options.abortController?.abort();
  }
}

export class FakeSessionApi implements SessionApi {
  infos = new Map<string, SdkSessionInfo>();
  deleted: string[] = [];
  renamed: Array<[string, string]> = [];
  forks: Array<{ id: string; upToMessageId?: string }> = [];
  history = new Map<string, any[]>();
  listCalls: any[] = [];
  async listSessions(o: { dir: string; limit?: number }): Promise<SdkSessionInfo[]> {
    this.listCalls.push(o);
    return [...this.infos.values()].sort((a, b) => b.lastModified - a.lastModified);
  }
  async getSessionInfo(id: string): Promise<SdkSessionInfo | undefined> {
    return this.infos.get(id);
  }
  async renameSession(id: string, title: string): Promise<void> {
    this.renamed.push([id, title]);
    const info = this.infos.get(id);
    if (info) this.infos.set(id, { ...info, customTitle: title, summary: title });
  }
  async deleteSession(id: string): Promise<void> {
    if (!this.infos.has(id)) throw new Error(`Session ${id} not found in project directory`);
    this.infos.delete(id);
    this.deleted.push(id);
  }
  async forkSession(id: string, o: { upToMessageId?: string }): Promise<{ sessionId: string }> {
    const sessionId = `fork-${this.forks.length + 1}`;
    this.forks.push({ id, upToMessageId: o.upToMessageId });
    this.infos.set(sessionId, { sessionId, summary: 'Fork', lastModified: Date.now(), customTitle: 'Fork' });
    return { sessionId };
  }
  async getSessionMessages(id: string): Promise<any[]> {
    return this.history.get(id) ?? [];
  }
  async listSubagents(): Promise<string[]> {
    return [];
  }
  async getSubagentMessages(): Promise<any[]> {
    return [];
  }
}

export type Harness = {
  manager: ClaudeSessionManager;
  broadcaster: Broadcaster;
  timers: ManualTimers;
  queries: FakeQuery[];
  api: FakeSessionApi;
  pushes: ClaudeEventsPush[];
  store: Map<string, unknown>;
  config: ManagerConfig;
  logs: Array<{ level: string; message: string }>;
  /** Marks session ids of recorded fixtures as existing transcripts so list/resume see them. */
  addTranscript(id: string, title?: string): void;
};

/** Manager wired to fakes. `fixture` names the recording each new Query replays (per call index or constant). */
export function createHarness(
  fixture: string | ((callIndex: number) => string),
  overrides: Partial<ManagerConfig> = {},
  init: InitializationResult = STUB_INIT,
  /** `shared` simulates a window reload: a new manager over the same workspaceState and transcripts. */
  extra: { home?: string; cwd?: string; shared?: { store: Map<string, unknown>; api: FakeSessionApi }; contextRaw?: unknown; usageRaw?: unknown; windows?: Record<string, number>; distDir?: string; measureWindows?: boolean } = {},
): Harness {
  const timers = new ManualTimers();
  const broadcaster = new Broadcaster({ setTimer: timers.setTimeout, clearTimer: timers.clearTimeout });
  const queries: FakeQuery[] = [];
  const api = extra.shared?.api ?? new FakeSessionApi();
  const store = extra.shared?.store ?? new Map<string, unknown>();
  // Tests assume the classic default mode unless they ask for the product default (bypassPermissions).
  const config: ManagerConfig = { ...DEFAULT_MANAGER_CONFIG, defaultPermissionMode: 'default', ...overrides };
  const logs: Harness['logs'] = [];
  const queryFactory: QueryFactory = (params) => {
    // The catalog probe (never-yielding prompt, persistSession false) gets an inert query.
    const isProbe = params.options.persistSession === false;
    const name = typeof fixture === 'string' ? fixture : fixture(queries.length);
    // "name#2" starts the recording at its third input segment (a respawned process continuing a conversation).
    const [base, skip] = name.split('#');
    const q = new FakeQuery(params, isProbe ? [] : segmentsOf(base!).slice(Number(skip ?? 0)), init);
    // The catalog probe has no conversation: only live sessions answer with a recorded breakdown.
    q.contextRaw = isProbe ? undefined : extra.contextRaw;
    q.usageRaw = extra.usageRaw;
    q.windowsByModel = extra.windows;
    queries.push(q);
    return q;
  };
  const runtime: SdkRuntime = { queryFactory, sessions: api };
  const pushes: ClaudeEventsPush[] = [];
  broadcaster.register({ post: (m) => pushes.push(m) });
  const manager = new ClaudeSessionManager({
    cwd: extra.cwd ?? '/work/proj',
    store: { get: ((k: string, d?: unknown) => (store.has(k) ? store.get(k) : d)) as never, update: async (k, v) => void store.set(k, v) },
    broadcaster,
    getConfig: () => config,
    runtime: async () => runtime,
    home: extra.home ?? '/nonexistent-home',
    // The extra measuring probe would shift every test's query indices: only tests that give windows enable it.
    measureModelWindows: extra.measureWindows ?? extra.windows !== undefined,
    distDir: extra.distDir,
    baseEnv: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-test', HOME: '/home/x' },
    loginPath: async () => '/opt/login/bin',
    log: (level, message) => logs.push({ level, message }),
    now: () => Date.now(),
    timers,
  });
  return {
    manager, broadcaster, timers, queries, api, pushes, store, config, logs,
    addTranscript: (id, title = 'Existing') => void api.infos.set(id, { sessionId: id, summary: title, lastModified: Date.now(), createdAt: Date.now() - 1000 }),
  };
}

export const allEvents = (h: Harness) => h.pushes.flatMap((p) => p.events);
