/**
 * One Claude session owned by the extension host (D1): a streaming-input `Query` (spawned lazily on the first send),
 * the W2 mapper, the folded `SessionState`, pending permissions/questions and the lifecycle
 * `draft -> cold -> starting -> live-idle <-> live-busy -> closing -> cold`.
 *
 * Vscode-free: all effects go through `ClaudeSessionDeps`, so the manager and this class run headless in tests.
 */
import { randomUUID } from 'node:crypto';
import type { ClaudeEvent, SessionSnapshot } from '@openchamber/ui/src/lib/claude/protocol';
import type { ClaudeRequestPayload } from '@openchamber/ui/src/lib/claude/protocol';
import type { ContextUsage, EffortLevel, PermissionMode, PermissionResponse, QuestionAnswer, Session, SessionStatus, SlashCommand } from '@openchamber/ui/src/lib/claude/types';
import type { AgentLog } from './agentLog';
import { AsyncQueue } from './asyncQueue';
import { estimateContextUsage, toContextUsage } from './contextUsage';
import { loadHistory } from './history';
import { createMapper, type AliasResolver, type InitInfo, type Mapper } from './mapper';
import { pluginAliasResolver } from './pluginAliases';
import { PermissionBroker } from './permissions';
import type { ClaudeQuery, SdkOptions, SdkRuntime, SessionApi, SDKUserMessage } from './sdk';
import { bucketFor, createSessionState, reduceEvents, type SessionState } from './sessionState';

export type SessionLifecycle = 'draft' | 'cold' | 'starting' | 'live-idle' | 'live-busy' | 'closing';

/** Per-session preferences persisted by the manager (workspaceState). */
/** `effort`: `null`/undefined = model default. */
export type SessionPrefs = { model: string; mode: PermissionMode; agent: string; effort?: EffortLevel | null };

export type SendInput = Omit<ClaudeRequestPayload<'claude:session.send'>, 'sessionId'>;

export type SessionTimers = {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type ClaudeSessionDeps = {
  cwd: string;
  runtime: () => Promise<SdkRuntime>;
  /** Fully built child environment (login PATH merged, auth variables handled). */
  env: () => Promise<Record<string, string | undefined>>;
  executablePath: () => string | undefined;
  /** Receives every event after it was folded into the session state. */
  emit: (events: ClaudeEvent[]) => void;
  /** First `system/init` of a live process: the host refreshes its catalog from `query.initializationResult()`. */
  onInit?: (init: InitInfo, query: ClaudeQuery) => void;
  onPrefsChanged?: (session: ClaudeSession) => void;
  /** Session became idle / busy (idle timer, LRU). */
  onActivity?: (session: ClaudeSession, state: 'idle' | 'busy') => void;
  onLifecycle?: (session: ClaudeSession, lifecycle: SessionLifecycle) => void;
  /** `system/commands_changed`: the host refreshes its slash-command catalog. */
  onCommandsChanged?: (commands: SlashCommand[]) => void;
  /** `rate_limit_event` seen on a live process (raw `rate_limit_info`). */
  onRateLimit?: (info: Record<string, unknown>) => void;
  /** `bypassPermissions` is only honoured when the user enabled `claudekei.allowBypassPermissions`. */
  isModeAllowed?: (mode: PermissionMode) => boolean;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  now: () => number;
  timers: SessionTimers;
  stderr?: (data: string) => void;
  /** Plugin alias lookup; defaults to the claudekei plugin's state file. */
  aliases?: (sessionId: string) => AliasResolver;
  /** Model / effort preset of a primary agent (claudekei.jsonc, else the agent's frontmatter model). */
  agentPreset?: (agent: string) => { defaultModel?: string; defaultEffort?: EffortLevel } | undefined;
  /** Concrete model id for a selected model value (catalog lookup), when known without a live process. */
  resolveModel?: (value: string) => string | undefined;
  /** Per-turn agent record so replayed user messages keep the agent they were sent with. */
  agentLog?: AgentLog;
};

const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|javascript|typescript|x-sh|x-httpd-php|sql|toml|x-ndjson|ld\+json)|[a-z]+\/[a-z.+-]*\+(json|xml))/i;

/**
 * `data:<mime>;base64,<payload>` -> Messages API content block: images and PDFs as native blocks, text-like files
 * inlined. Anything else (binary) is rejected with a clear error rather than sent as garbled text.
 */
export function attachmentBlock(file: { mime: string; filename: string; dataUrl: string }): Record<string, unknown> {
  const match = /^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s.exec(file.dataUrl);
  if (!match) throw new Error(`Attachment "${file.filename}" is not a valid base64 data URL`);
  const mime = file.mime || match[1] || 'application/octet-stream';
  const data = match[2]!;
  if (mime.startsWith('image/')) return { type: 'image', source: { type: 'base64', media_type: mime, data } };
  if (mime === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: mime, data }, title: file.filename };
  if (!TEXT_MIME.test(mime)) throw new Error(`Unsupported attachment type "${mime}" (${file.filename}). Only images, PDFs and text files can be attached.`);
  const text = Buffer.from(data, 'base64').toString('utf8');
  return { type: 'text', text: `<file name="${file.filename}">\n${text}\n</file>` };
}

const LIVE: ReadonlySet<SessionLifecycle> = new Set(['starting', 'live-idle', 'live-busy']);

export class ClaudeSession {
  info: Session;
  prefs: SessionPrefs;
  lifecycle: SessionLifecycle;
  state: SessionState;
  lastActivity: number;
  /** A transcript exists (resume instead of `sessionId`). */
  exists: boolean;
  /** Agent the current/last process was spawned with. */
  spawnedAgent: string | undefined;
  /** How many processes this session has started (tests, diagnostics). */
  spawnCount = 0;

  private loaded: boolean;
  private query: ClaudeQuery | undefined;
  private queue: AsyncQueue<SDKUserMessage> | undefined;
  private abort: AbortController | undefined;
  private mapper: Mapper | undefined;
  private pump: Promise<void> | undefined;
  private closing = false;
  private disposed = false;
  private sendInFlight = 0;
  private pendingInterrupt = false;
  /** `system/init` model of the live process, valid while the selected model is still `value`. */
  private initResolved: { value: string; resolved: string } | undefined;
  /** Effort the live process runs with; `effortStale` = it could not be changed live (respawn on the next idle send). */
  private liveEffort: EffortLevel | null = null;
  private effortStale = false;
  private lock: Promise<unknown> = Promise.resolve();
  private initEmitted = false;
  private titleTimers: unknown[] = [];
  readonly broker: PermissionBroker;

  constructor(
    private readonly deps: ClaudeSessionDeps,
    init: { info: Session; prefs: SessionPrefs; exists: boolean },
  ) {
    this.prefs = init.prefs;
    this.info = { ...init.info, agent: init.prefs.agent || undefined, mode: init.prefs.mode, ...this.modelFields(init.prefs) };
    this.exists = init.exists;
    this.lifecycle = init.exists ? 'cold' : 'draft';
    this.loaded = !init.exists;
    this.state = createSessionState(init.info.id, this.info);
    this.lastActivity = deps.now();
    this.broker = new PermissionBroker({
      sessionId: init.info.id,
      cwd: deps.cwd,
      emit: (events) => this.publish(events),
      findTool: (callId) => this.findTool(callId),
      setPermissionMode: (mode) => this.setMode(mode),
      log: (message, data) => deps.log('warn', message, data),
    });
  }

  get id(): string {
    return this.info.id;
  }

  get isLive(): boolean {
    return LIVE.has(this.lifecycle);
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** The session was deleted: sends are rejected and the manager no longer tracks it. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  markDisposed(): void {
    this.disposed = true;
  }

  get status(): SessionStatus {
    return bucketFor(this.state, this.id).status;
  }

  // --- state / snapshot --------------------------------------------------------

  /** Loads the transcript into the state (cold sessions). Idempotent. */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const sdk = (await this.deps.runtime()).sessions;
    const snapshot = await loadHistory({ aliases: (this.deps.aliases ?? pluginAliasResolver)(this.id), sessionId: this.id, cwd: this.deps.cwd, mode: this.prefs.mode, model: this.prefs.model, agent: this.prefs.agent, effort: this.prefs.effort, userAgents: this.deps.agentLog?.forReplay(this.id), sdk, log: (l, m, d) => this.deps.log(l === 'warn' ? 'warn' : 'debug', m, d) });
    // A live process may have started meanwhile; keep its events by folding them on top of the history.
    if (this.loaded) return;
    const bucket = bucketFor(snapshot.state, this.id);
    bucket.info = this.info;
    this.state = snapshot.state;
    this.loaded = true;
    // Cold session: a rough figure from the transcript until a live measurement replaces it.
    const tokens = this.lastKnownTokens();
    if (!this.contextUsage && tokens) this.info = { ...this.info, contextUsage: estimateContextUsage(tokens, this.deps.now()) };
    bucket.info = this.info;
  }

  getSnapshot(): SessionSnapshot {
    const bucket = bucketFor(this.state, this.id);
    const children = [...this.state.sessions.entries()].filter(([id]) => id !== this.id).flatMap(([, b]) => (b.info ? [b.info] : []));
    return structuredClone({
      session: this.info,
      messages: bucket.messages,
      parts: bucket.parts,
      status: bucket.status,
      permissions: this.broker.permissions,
      questions: this.broker.questions,
      todos: bucket.todos,
      children,
    });
  }

  /** Snapshot of a virtual subagent child session. */
  getChildSnapshot(childId: string): SessionSnapshot | undefined {
    const bucket = this.state.sessions.get(childId);
    if (!bucket?.info) return undefined;
    return structuredClone({ session: bucket.info, messages: bucket.messages, parts: bucket.parts, status: bucket.status, permissions: [], questions: [], todos: bucket.todos, children: [] });
  }

  private findTool(callId: string): { messageID: string } | undefined {
    for (const bucket of this.state.sessions.values()) {
      for (const parts of Object.values(bucket.parts)) {
        for (const part of parts) if (part.type === 'tool' && part.callID === callId) return { messageID: part.messageID };
      }
    }
    return undefined;
  }

  /** Folds events into the state, then hands them to the broadcaster. */
  publish(events: ClaudeEvent[]): void {
    if (events.length === 0) return;
    reduceEvents(this.state, events);
    this.lastActivity = this.deps.now();
    this.deps.emit(events);
    this.syncLifecycle();
  }

  private setLifecycle(next: SessionLifecycle): void {
    if (this.lifecycle === next) return;
    this.lifecycle = next;
    this.deps.onLifecycle?.(this, next);
  }

  /** live-busy / live-idle follows the folded main-session status. */
  private syncLifecycle(): void {
    if (this.lifecycle !== 'live-idle' && this.lifecycle !== 'live-busy') return;
    const busy = this.status.type !== 'idle' || this.broker.size > 0;
    const next: SessionLifecycle = busy ? 'live-busy' : 'live-idle';
    if (next === this.lifecycle) return;
    this.setLifecycle(next);
    this.deps.onActivity?.(this, busy ? 'busy' : 'idle');
    if (!busy) this.onTurnIdle();
  }

  // --- sending -----------------------------------------------------------------

  /** Serializes operations that spawn/close the process. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  send(input: SendInput): Promise<{ messageId: string }> {
    if (this.disposed) return Promise.reject(new Error('This session was deleted'));
    if (this.sendInFlight === 0) this.pendingInterrupt = false;
    this.sendInFlight += 1;
    return this.exclusive(async () => {
      if (this.disposed) throw new Error('This session was deleted');
      // Validate attachments before anything is spawned or emitted.
      const attachments = (input.files ?? []).map(attachmentBlock);
      await this.ensureLoaded();
      if (input.mode && this.modeAllowed(input.mode)) this.prefs.mode = input.mode;
      // The agent first: switching applies its model/effort preset, which explicit values sent with it then override.
      if (input.agent !== undefined) this.applyAgent(input.agent);
      if (input.model) this.prefs.model = input.model;
      if (input.effort !== undefined) this.prefs.effort = input.effort;
      this.deps.onPrefsChanged?.(this);
      if (this.isLive) await this.applyLiveSettings();

      // Agent switch (or an effort change the live process could not take): respawn with `resume`, only between
      // turns; a busy turn keeps its agent.
      if (this.lifecycle === 'live-idle' && (this.spawnedAgent !== (this.prefs.agent || undefined) || this.effortStale)) {
        this.deps.log('info', 'agent or effort changed, respawning session process', { id: this.id, from: this.spawnedAgent, to: this.prefs.agent, effortStale: this.effortStale });
        await this.closeProcess();
      }
      if (!this.isLive) await this.spawn();
      if (this.disposed) throw new Error('This session was deleted');
      if (this.pendingInterrupt) {
        // The user pressed stop while the process was still starting: do not send the message.
        this.pendingInterrupt = false;
        throw new Error('Interrupted before the message was sent');
      }

      const text = input.command ? `/${input.command.name}${input.command.args ? ` ${input.command.args}` : ''}` : input.text;
      const blocks: Array<Record<string, unknown>> = [{ type: 'text', text }, ...attachments];
      const uuid = randomUUID();
      // The label is the agent the message is actually processed by (a queued message keeps the running agent).
      // Effort: what the live process runs with (a change it could not take yet is not in effect for this turn).
      this.mapper!.configure({ model: this.prefs.model, mode: this.prefs.mode, agent: this.spawnedAgent, effort: this.liveEffort });
      const { messageId, events } = this.mapper!.startUserMessage({ content: blocks, uuid });
      this.setLifecycle('live-busy');
      this.deps.onActivity?.(this, 'busy');
      this.publish(events);
      this.recordTurnAgent(uuid, events);
      this.syncPrefsToInfo();
      this.queue!.push({ type: 'user', message: { role: 'user', content: blocks as never }, parent_tool_use_id: null, uuid } as SDKUserMessage);
      this.touchInfo();
      return { messageId };
    }).finally(() => {
      this.sendInFlight -= 1;
    });
  }

  /** Persists agent / effort / model the UI shows on this turn's user message (survives reloads). */
  private recordTurnAgent(uuid: string, events: ClaudeEvent[]): void {
    for (const event of events) {
      if (event.type === 'message.updated' && event.properties.info.role === 'user' && event.properties.info.claudeUuid === uuid) {
        const info = event.properties.info;
        this.deps.agentLog?.record(this.id, uuid, { agent: String(info.agent), effort: (info.model.variant as EffortLevel | undefined) ?? null, model: info.model.modelID });
        return;
      }
    }
  }

  private modeAllowed(mode: PermissionMode): boolean {
    const ok = this.deps.isModeAllowed?.(mode) ?? true;
    if (!ok) this.deps.log('warn', `permission mode "${mode}" is not allowed (see claudekei.allowBypassPermissions); ignored`, { id: this.id });
    return ok;
  }

  private liveMode: PermissionMode | undefined;
  private liveModel: string | undefined;

  private async applyLiveSettings(): Promise<void> {
    if (!this.query) return;
    if (this.liveModel !== this.prefs.model) {
      await this.query.setModel(this.prefs.model === 'default' ? undefined : this.prefs.model);
      this.liveModel = this.prefs.model;
    }
    if (this.liveMode !== this.prefs.mode) {
      await this.query.setPermissionMode(this.prefs.mode);
      this.liveMode = this.prefs.mode;
    }
    const effort = this.prefs.effort ?? null;
    if (this.liveEffort !== effort) {
      try {
        if (!this.query.applyFlagSettings) throw new Error('applyFlagSettings is not available');
        await this.query.applyFlagSettings({ effortLevel: effort });
        this.liveEffort = effort;
        this.effortStale = false;
      } catch (error) {
        // Fall back to a respawn (resume) before the next turn.
        this.effortStale = true;
        this.deps.log('debug', 'live effort change failed; it applies on the next respawn', error);
      }
    }
  }

  private async spawn(): Promise<void> {
    this.setLifecycle('starting');
    try {
      const runtime = await this.deps.runtime();
      const env = await this.deps.env();
      const queue = new AsyncQueue<SDKUserMessage>();
      const abort = new AbortController();
      const model = this.prefs.model;
      const agent = this.prefs.agent || undefined;
      // A stored/forked preference may name a mode the user has not enabled (bypassPermissions).
      if (!(this.deps.isModeAllowed?.(this.prefs.mode) ?? true)) this.prefs.mode = 'default';
      const options: SdkOptions = {
        cwd: this.deps.cwd,
        ...(this.exists ? { resume: this.id } : { sessionId: this.id }),
        ...(model && model !== 'default' ? { model } : {}),
        permissionMode: this.prefs.mode,
        ...(this.prefs.effort ? { effort: this.prefs.effort } : {}),
        // Required to enter bypassPermissions later in this process (mode cycling), not only to start in it.
        ...(this.deps.isModeAllowed?.('bypassPermissions') ?? true ? { allowDangerouslySkipPermissions: true } : {}),
        ...(agent ? { agent } : {}),
        includePartialMessages: true,
        // Foreground (sync) subagent runs otherwise never forward their text-only reply as a child assistant message.
        forwardSubagentText: true,
        settingSources: ['user', 'project', 'local'],
        // snapshot:false on every spawn: a resumed session otherwise reuses the system prompt recorded by the first
        // process, so after an agent switch the new agent would only get its tool set, not its instructions
        // (docs/PHASE1_1_SUBAGENTS_AGENTSWITCH_NOTES.md). The prompt is rendered fresh per request; it is stable
        // between switches, so the prompt cache is only missed once per switch.
        systemPrompt: { type: 'preset', preset: 'claude_code', snapshot: false },
        thinking: { type: 'adaptive', display: 'summarized' },
        enableFileCheckpointing: true,
        allowedTools: ['TodoWrite'],
        env,
        abortController: abort,
        canUseTool: this.broker.canUseTool as unknown as SdkOptions['canUseTool'],
        stderr: (data) => this.deps.stderr?.(data),
        ...(this.deps.executablePath() ? { pathToClaudeCodeExecutable: this.deps.executablePath() } : {}),
      };
      const mapper = createMapper({
        sessionId: this.id,
        cwd: this.deps.cwd,
        mode: this.prefs.mode,
        model,
        agent,
        now: this.deps.now,
        aliases: (this.deps.aliases ?? pluginAliasResolver)(this.id),
        log: (level, message, data) => this.deps.log(level, `[mapper ${this.id.slice(0, 8)}] ${message}`, data),
        hooks: {
          onInit: (init) => {
            if (init.model) {
              // The concrete model the process runs (an alias or `default` resolves to a full id).
              this.initResolved = { value: this.prefs.model, resolved: init.model };
              this.syncPrefsToInfo();
            }
            if (!this.initEmitted && this.query) {
              this.initEmitted = true;
              this.deps.onInit?.(init, this.query);
            }
          },
          onCommandsChanged: (commands) => this.deps.onCommandsChanged?.(commands),
          onRateLimit: (info) => this.deps.onRateLimit?.(info),
          onModeChanged: (mode) => {
            if (this.prefs.mode !== mode) {
              this.prefs.mode = mode;
              this.liveMode = mode;
              this.deps.onPrefsChanged?.(this);
              // The CLI changed the mode itself (ExitPlanMode approval, "always allow" for edits, ...).
              this.syncPrefsToInfo();
            }
          },
        },
      });
      // A new process gets a new mapper: seed it with the child sessions / agent registry the session already has.
      mapper.seed(this.state);
      this.queue = queue;
      this.abort = abort;
      this.mapper = mapper;
      this.query = runtime.queryFactory({ prompt: queue, options });
      this.spawnedAgent = agent;
      this.liveEffort = this.prefs.effort ?? null;
      this.effortStale = false;
      // Sessions that predate the per-turn record fall back to the agent they first ran with.
      this.deps.agentLog?.noteInitial(this.id, agent ?? this.prefs.mode);
      this.liveMode = this.prefs.mode;
      this.liveModel = model;
      this.initEmitted = false;
      this.spawnCount += 1;
      this.setLifecycle('live-idle');
      this.pump = this.runPump(this.query, mapper);
    } catch (error) {
      this.setLifecycle(this.exists ? 'cold' : 'draft');
      throw error;
    }
  }

  private async runPump(query: ClaudeQuery, mapper: Mapper): Promise<void> {
    let sawResult = false;
    let failure: unknown;
    try {
      for await (const message of query) {
        if (message.type === 'result') {
          sawResult = true;
          this.scheduleContextUsage();
        }
        if (message.type === 'system' && message.subtype === 'init') this.exists = true;
        this.publish(mapper.apply(message));
      }
    } catch (error) {
      failure = error;
    } finally {
      const wasClosing = this.closing;
      const wasBusy = this.status.type !== 'idle';
      this.broker.denyAll();
      this.publish(mapper.finish(wasClosing ? 'interrupted' : 'ended'));
      this.query = undefined;
      this.queue = undefined;
      this.abort = undefined;
      this.mapper = undefined;
      this.exists = this.exists || sawResult;
      this.setLifecycle(this.exists ? 'cold' : 'draft');
      this.deps.onActivity?.(this, 'idle');
      const message = failure instanceof Error ? failure.message : failure ? String(failure) : undefined;
      // A throw after a `result` is the normal end when the CLI exits (W0 notes 3.6); dying mid-turn is unexpected.
      if (!wasClosing && (wasBusy || (failure && !sawResult))) {
        this.publish([{ type: 'session.error', properties: { sessionID: this.id, error: { name: 'process_exit', message: message ?? 'Claude Code process ended unexpectedly', kind: /login|auth/i.test(message ?? '') ? 'auth' : 'unknown' } } }]);
      }
    }
  }

  // --- control -------------------------------------------------------------------

  async interrupt(): Promise<void> {
    // Stop pressed while a send is still spawning the process: cancel that send instead of ignoring the click.
    if ((!this.query || this.lifecycle === 'starting') && this.sendInFlight > 0) this.pendingInterrupt = true;
    if (!this.query) return;
    try {
      await this.query.interrupt();
    } catch (error) {
      this.deps.log('warn', 'interrupt failed', error);
    }
  }

  async setModel(model: string): Promise<void> {
    this.prefs.model = model;
    this.deps.onPrefsChanged?.(this);
    this.syncPrefsToInfo();
    if (this.query && this.isLive) await this.applyLiveSettings();
  }

  /** `null` = model default. Applied live when the SDK allows it, else with a respawn on the next send. */
  async setEffort(effort: EffortLevel | null): Promise<void> {
    this.prefs.effort = effort;
    this.deps.onPrefsChanged?.(this);
    this.syncPrefsToInfo();
    if (this.query && this.isLive) await this.applyLiveSettings();
  }

  async setMode(mode: PermissionMode): Promise<void> {
    if (!this.modeAllowed(mode)) return;
    this.prefs.mode = mode;
    this.deps.onPrefsChanged?.(this);
    this.mapper?.configure({ mode });
    this.syncPrefsToInfo();
    if (this.query && this.isLive) await this.applyLiveSettings();
  }

  /** Stores the agent; it takes effect on the next send (respawn + resume). */
  setAgent(agent: string): void {
    this.applyAgent(agent);
    this.deps.onPrefsChanged?.(this);
    this.syncPrefsToInfo();
  }

  /** Stores the agent; a real switch also takes over the new agent's model / effort preset, when it has one. */
  private applyAgent(agent: string): void {
    if (agent === this.prefs.agent) return;
    this.prefs.agent = agent;
    const preset = this.deps.agentPreset?.(agent);
    if (preset?.defaultModel) this.prefs.model = preset.defaultModel;
    if (preset?.defaultEffort) this.prefs.effort = preset.defaultEffort;
  }

  respondPermission(requestId: string, response: PermissionResponse): boolean {
    const ok = this.broker.respondPermission(requestId, response);
    if (ok) this.syncLifecycle();
    return ok;
  }

  respondQuestion(requestId: string, answers: QuestionAnswer[] | { reject: true }): boolean {
    const ok = this.broker.respondQuestion(requestId, answers);
    if (ok) this.syncLifecycle();
    return ok;
  }

  /** Closes the process (no-op when cold). Pending prompts are denied and running tools become errors. */
  close(): Promise<void> {
    return this.exclusive(() => this.closeProcess());
  }

  /**
   * Closes the process only if it is still idle with no pending prompt, decided inside the exclusive section so a
   * concurrent `send` cannot be killed by an idle-timeout / LRU decision taken a moment earlier.
   */
  closeIfIdle(): Promise<boolean> {
    return this.exclusive(async () => {
      if (this.lifecycle !== 'live-idle' || this.broker.size > 0) return false;
      await this.closeProcess();
      return true;
    });
  }

  private async closeProcess(): Promise<void> {
    for (const t of this.titleTimers.splice(0)) this.deps.timers.clearTimeout(t);
    const pump = this.pump;
    if (!pump || !this.isLive) return;
    this.closing = true;
    this.setLifecycle('closing');
    try {
      this.queue?.end();
      this.query?.close();
      this.abort?.abort();
      await pump;
    } finally {
      this.closing = false;
      this.pump = undefined;
    }
  }

  // --- info ------------------------------------------------------------------------

  private touchInfo(): void {
    this.info = { ...this.info, time: { ...this.info.time, updated: this.deps.now() } };
    this.publish([{ type: 'session.updated', properties: { sessionID: this.id, info: this.info } }]);
  }

  /** `Session.model / effort / resolvedModel` for the given prefs: the live process's answer wins, else the catalog. */
  private modelFields(prefs: SessionPrefs): Pick<Session, 'model' | 'effort' | 'resolvedModel'> {
    const resolved = this.initResolved?.value === prefs.model ? this.initResolved.resolved : this.deps.resolveModel?.(prefs.model);
    return { model: prefs.model, effort: prefs.effort || undefined, resolvedModel: resolved };
  }

  /** Mirrors agent/mode/model/effort into `Session` (the composer reads them from it) and announces changes. */
  syncPrefsToInfo(): void {
    const agent = this.prefs.agent || undefined;
    const fields = this.modelFields(this.prefs);
    if (this.info.agent === agent && this.info.mode === this.prefs.mode && this.info.model === fields.model && this.info.effort === fields.effort && this.info.resolvedModel === fields.resolvedModel) return;
    this.info = { ...this.info, agent, mode: this.prefs.mode, ...fields };
    this.publish([{ type: 'session.updated', properties: { sessionID: this.id, info: this.info } }]);
  }

  /** Applies a (possibly new) title / metadata from the session list and announces changes. */
  updateInfo(next: Partial<Session> & { title?: string }): void {
    const changed = next.title !== undefined && next.title !== this.info.title;
    this.info = { ...this.info, ...next, agent: this.info.agent, mode: this.info.mode, model: this.info.model, effort: this.info.effort, resolvedModel: this.info.resolvedModel, time: { ...this.info.time, ...(next.time ?? {}) } };
    if (changed) this.publish([{ type: 'session.updated', properties: { sessionID: this.id, info: this.info } }]);
  }

  /** The live process's query, for host-wide calls that need no turn (usage limits). */
  liveQuery(): ClaudeQuery | undefined {
    return this.isLive ? this.query : undefined;
  }

  // --- context usage -------------------------------------------------------------

  private contextUsage: ContextUsage | undefined;
  private contextMeasuring: Promise<ContextUsage | undefined> | undefined;
  private contextMeasuredAt = 0;

  /** After a `result`: measure in the background (throttled; never blocks or fails the turn). */
  private scheduleContextUsage(): void {
    if (this.deps.now() - this.contextMeasuredAt < 2000) return;
    void this.measureContextUsage();
  }

  /** SDK `getContextUsage` on the live process, folded into `Session.contextUsage` (announced by `session.updated`). */
  private measureContextUsage(): Promise<ContextUsage | undefined> {
    const query = this.query;
    if (!query?.getContextUsage || !this.isLive) return Promise.resolve(undefined);
    this.contextMeasuring ??= (async () => {
      try {
        const usage = toContextUsage(await query.getContextUsage!({ detail: 'full' }), this.deps.now());
        if (usage && !this.disposed) {
          this.contextUsage = usage;
          this.contextMeasuredAt = this.deps.now();
          this.info = { ...this.info, contextUsage: usage };
          this.publish([{ type: 'session.updated', properties: { sessionID: this.id, info: this.info } }]);
        }
        return usage;
      } catch (error) {
        this.deps.log('debug', 'getContextUsage failed', error instanceof Error ? error.message : String(error));
        return undefined;
      } finally {
        this.contextMeasuring = undefined;
      }
    })();
    return this.contextMeasuring;
  }

  /** Prompt size of the last response in the state: input + cache reads/writes + output of the newest assistant turn. */
  private lastKnownTokens(): number | undefined {
    const messages = bucketFor(this.state, this.id).messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === 'assistant' && m.tokens && (m.tokens.input || m.tokens.output || m.tokens.cache.read || m.tokens.cache.write)) {
        return m.tokens.input + m.tokens.output + m.tokens.cache.read + m.tokens.cache.write;
      }
    }
    return undefined;
  }

  /**
   * Fresh measurement for a live process; otherwise the last known value, else an estimate from the transcript's
   * token counts (`source: 'estimate'`).
   */
  async contextUsageNow(): Promise<ContextUsage> {
    if (this.isLive) {
      const fresh = await (this.contextMeasuring ?? this.measureContextUsage());
      if (fresh) return fresh;
    }
    await this.ensureLoaded();
    if (this.contextUsage) return this.contextUsage;
    const estimate = estimateContextUsage(this.lastKnownTokens() ?? 0, this.deps.now());
    this.info = { ...this.info, contextUsage: estimate };
    return estimate;
  }

  /** After a turn: pull the CLI's auto-generated title (arrives asynchronously) a few times. */
  private onTurnIdle(): void {
    this.touchInfo();
    for (const t of this.titleTimers.splice(0)) this.deps.timers.clearTimeout(t);
    for (const delay of [1500, 6000]) {
      this.titleTimers.push(this.deps.timers.setTimeout(() => this.refreshTitle(), delay));
    }
  }

  /** Overridden by the manager through `refreshInfo`. */
  refreshInfo?: (session: ClaudeSession) => Promise<void>;

  private refreshTitle(): void {
    void this.refreshInfo?.(this);
  }

  /** Test/diagnostics: feeds recorded SDK messages through the mapper as if a live process produced them. */
  attachReplay(): { apply: (message: unknown) => void; userMessage: (content: unknown[], uuid?: string) => void; finish: () => void } {
    const mapper = createMapper({ sessionId: this.id, cwd: this.deps.cwd, mode: this.prefs.mode, model: this.prefs.model, agent: this.prefs.agent || undefined, now: this.deps.now });
    this.loaded = true;
    return {
      apply: (message) => this.publish(mapper.apply(message)),
      userMessage: (content, uuid) => this.publish(mapper.startUserMessage({ content, uuid }).events),
      finish: () => this.publish(mapper.finish('ended')),
    };
  }
}
