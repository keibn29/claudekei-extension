/**
 * One Claude session owned by the extension host (D1): a streaming-input `Query` (spawned lazily on the first send),
 * the W2 mapper, the folded `SessionState`, pending permissions/questions and the lifecycle
 * `draft -> cold -> starting -> live-idle <-> live-busy -> closing -> cold`.
 *
 * Vscode-free: all effects go through `ClaudeSessionDeps`, so the manager and this class run headless in tests.
 */
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ClaudeEvent, SessionSnapshot } from '@openchamber/ui/src/lib/claude/protocol';
import type { ClaudeRequestPayload } from '@openchamber/ui/src/lib/claude/protocol';
import type { ContextUsage, EffortLevel, Message, PermissionMode, PermissionResponse, QuestionAnswer, RevertPreview, RevertResult, Session, SessionStatus, SlashCommand } from '@openchamber/ui/src/lib/claude/types';
import type { AgentLog } from './agentLog';
import { AsyncQueue } from './asyncQueue';
import { estimateContextUsage, seedContextUsage, toContextBaseline, toContextUsage, type ContextBaseline } from './contextUsage';
import { loadHistory } from './history';
import { CLI_NOT_FOUND_MESSAGE, installHint } from './env';
import { createMapper, type AliasResolver, type InitInfo, type Mapper, type SubagentDefaults } from './mapper';
import { pluginAliasResolver } from './pluginAliases';
import { cleanPluginState } from './pluginStateCleanup';
import { PermissionBroker } from './permissions';
import type { FileHistory } from './fileHistory';
import type { RevertMarker, RevertStore } from './revertStore';
import type { ClaudeQuery, SdkOptions, SdkRuntime, SessionApi, SDKUserMessage } from './sdk';
import { bucketFor, createSessionState, reduceEvents, type SessionState } from './sessionState';
import { revertedPromptIds, transcriptPaths, trimSubagents } from './subagentCut';
import { readSubagentMeta } from './subagentMeta';
import { isTaskTool } from './toolNormalize';
import { cutUuidBefore, forkUuidOf } from './transcriptCut';

export type SessionLifecycle = 'draft' | 'cold' | 'starting' | 'live-idle' | 'live-busy' | 'closing';

/** Per-session preferences persisted by the manager (workspaceState). */
/** `effort`: `null`/undefined = model default. */
export type SessionPrefs = { model: string; mode: PermissionMode; agent: string; effort?: EffortLevel | null };

export type SendInput = Omit<ClaudeRequestPayload<'claude:session.send'>, 'sessionId'>;

/** How long a revert waits for the CLI to acknowledge an interrupt before it closes the process instead. */
const INTERRUPT_TIMEOUT_MS = 5000;

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
  /** A live `getContextUsage` measured the window of the selected model value (lazy fallback for model windows). */
  onModelWindow?: (modelValue: string, maxTokens: number) => void;
  /** Known context window of a model value (catalog / measured), used to size estimates before any measurement. */
  modelWindow?: (modelValue: string) => number | undefined;
  /** Persisted fixed-cost baseline of a model value (seeds a fresh session's context figure). */
  contextBaseline?: (modelValue: string) => ContextBaseline | undefined;
  /** An exact measurement produced a baseline for the selected model value. */
  onContextBaseline?: (modelValue: string, baseline: ContextBaseline) => void;
  /** `bypassPermissions` is only honoured when the user enabled `claudekei.allowBypassPermissions`. */
  isModeAllowed?: (mode: PermissionMode) => boolean;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
  now: () => number;
  timers: SessionTimers;
  stderr?: (data: string) => void;
  /** Plugin alias lookup; defaults to the claudekei plugin's state file. */
  aliases?: (sessionId: string) => AliasResolver;
  /** Configured model / effort of a subagent type (claudekei.jsonc preset, agent frontmatter), for the child sessions. */
  subagentDefaults?: (agentType: string) => SubagentDefaults | undefined;
  /** Home directory holding `.claude/projects` (Claude Code's subagent meta files); defaults to the user's home. */
  home?: string;
  /** Model / effort preset of a primary agent (claudekei.jsonc, else the agent's frontmatter model). */
  agentPreset?: (agent: string) => { defaultModel?: string; defaultEffort?: EffortLevel } | undefined;
  /** Concrete model id for a selected model value (catalog lookup), when known without a live process. */
  resolveModel?: (value: string) => string | undefined;
  /** Per-turn agent record so replayed user messages keep the agent they were sent with. */
  agentLog?: AgentLog;
  /** Revert markers (docs/REVERT_SPEC.md); markers only, file state is in `fileHistory`. Absent = revert is unavailable. */
  revertStore?: RevertStore;
  /** Git snapshot checkpoints behind file restore; absent = conversation-only revert. */
  fileHistory?: FileHistory;
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

/** Stop watchdog: after an interrupt, wait this long before stopping tasks one by one, then again before killing the process. */
const STOP_WATCHDOG_MS = 4000;
/** `getContextUsage` that does not answer within this long is abandoned so a later measurement can run. */
const CONTEXT_MEASURE_TIMEOUT_MS = 12_000;

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
  /** Reverted `promptId`s whose subagent cut still has to be (re)applied before the next spawn (crash / failure before `init`). */
  private pendingCut: { promptIds: string[]; trimmedAgentIds: string[] } | undefined;
  /** `system/init` model of the live process, valid while the selected model is still `value`. */
  private initResolved: { value: string; resolved: string } | undefined;
  /** Effort the live process runs with; `effortStale` = it could not be changed live (respawn on the next idle send). */
  private liveEffort: EffortLevel | null = null;
  private effortStale = false;
  /** Agents / skills / plugins / MCP changed on disk: the live process is stale (respawn on the next idle send). */
  private configStale = false;
  private lock: Promise<unknown> = Promise.resolve();
  private initEmitted = false;
  private titleTimers: unknown[] = [];
  private stopTimers: unknown[] = [];
  /** Pending revert: messages from this user message on are hidden and cut on the next send. */
  private revertMarker: RevertMarker | undefined;
  /** A committed revert whose cut no process has written into the transcript yet (persisted until `init`). */
  private committedMarker: RevertMarker | undefined;
  /** Bumped by every user message: a stop watchdog armed for an older turn must not touch a newer one. */
  private turnSeq = 0;
  /** Transcript uuid the next spawn resumes at (set by a committed revert, cleared once the process emitted `init`). */
  private resumeAt: string | undefined;
  readonly broker: PermissionBroker;
  /** Claude Code's recorded model / effort of a subagent of this session (its `agent-<id>.meta.json`). */
  private readonly subagentMeta = (toolUseId: string, agentId?: string) =>
    readSubagentMeta(toolUseId, agentId, { cwd: this.deps.cwd, sessionId: this.id, home: this.deps.home });

  constructor(
    private readonly deps: ClaudeSessionDeps,
    init: { info: Session; prefs: SessionPrefs; exists: boolean },
  ) {
    this.prefs = init.prefs;
    this.info = { ...init.info, agent: init.prefs.agent || undefined, mode: init.prefs.mode, ...this.modelFields(init.prefs) };
    // A session with no measurement yet starts from the model's known fixed cost (system prompt, tools, memory).
    const baseline = this.info.contextUsage ? undefined : deps.contextBaseline?.(init.prefs.model);
    if (baseline) this.info = { ...this.info, contextUsage: seedContextUsage(baseline, deps.now(), deps.modelWindow?.(init.prefs.model)) };
    this.exists = init.exists;
    this.lifecycle = init.exists ? 'cold' : 'draft';
    this.loaded = !init.exists;
    this.state = createSessionState(init.info.id, this.info);
    this.lastActivity = deps.now();
    const stored = deps.revertStore?.get(init.info.id);
    if (stored?.committed) {
      // The last process died / the window closed before announcing the cut: resume there again, keep the rest hidden.
      this.committedMarker = stored;
      this.resumeAt = stored.resumeAt ?? undefined;
      this.pendingCut = stored.promptIds ? { promptIds: stored.promptIds, trimmedAgentIds: stored.trimmedAgentIds ?? [] } : undefined;
    } else {
      this.revertMarker = stored;
    }
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

  /** Config files changed: a live process respawns (resume) on the next send between turns; a busy turn is never cut. */
  markConfigStale(): void {
    if (this.isLive) this.configStale = true;
  }

  /** A revert is pending (not yet committed by a send). */
  get hasRevert(): boolean {
    return this.revertMarker !== undefined;
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
    const snapshot = await loadHistory({ aliases: (this.deps.aliases ?? pluginAliasResolver)(this.id), subagentDefaults: this.deps.subagentDefaults, subagentMeta: this.subagentMeta, sessionId: this.id, cwd: this.deps.cwd, mode: this.prefs.mode, model: this.prefs.model, agent: this.prefs.agent, effort: this.prefs.effort, userAgents: this.deps.agentLog?.forReplay(this.id), sdk, log: (l, m, d) => this.deps.log(l === 'warn' ? 'warn' : 'debug', m, d) });
    // A live process may have started meanwhile; keep its events by folding them on top of the history.
    if (this.loaded) return;
    const bucket = bucketFor(snapshot.state, this.id);
    bucket.info = this.info;
    this.state = snapshot.state;
    this.loaded = true;
    this.resolveRevertMarker();
    this.hideCommittedCut();
    // Cold session: a rough figure from the transcript until a live measurement replaces it.
    const tokens = this.lastKnownTokens();
    if (!this.contextUsage && tokens) this.info = { ...this.info, contextUsage: estimateContextUsage(tokens, this.deps.now(), undefined, this.deps.modelWindow?.(this.prefs.model)) };
    bucket.info = this.info;
  }

  /** Host message ids change across reloads: the stored marker is found again by the user message's transcript uuid. */
  private resolveRevertMarker(): void {
    const marker = this.revertMarker;
    if (!marker) return;
    const bucket = bucketFor(this.state, this.id);
    const message = bucket.messages.find((m) => m.role === 'user' && m.claudeUuid === marker.uuid);
    if (!message) {
      this.deps.log('warn', 'revert marker points at a message that no longer exists; dropped', { id: this.id, uuid: marker.uuid });
      this.revertMarker = undefined;
      void this.deps.revertStore?.clear(this.id);
      return;
    }
    this.info = { ...this.info, revert: { messageID: message.id } };
    bucket.info = this.info;
  }

  /** After a reload with a committed (not yet written) cut: the messages beyond it stay hidden, like before the reload. */
  private hideCommittedCut(): void {
    const marker = this.committedMarker;
    if (!marker?.resumeAt) return;
    const bucket = bucketFor(this.state, this.id);
    const index = bucket.messages.findIndex((m) => forkUuidOf(m, bucket.parts[m.id] ?? []) === marker.resumeAt);
    if (index < 0) {
      this.deps.log('warn', 'committed revert cut points at an entry that no longer exists; dropped', { id: this.id, resumeAt: marker.resumeAt });
      this.committedMarker = undefined;
      this.resumeAt = undefined;
      void this.deps.revertStore?.clear(this.id);
      return;
    }
    const removed = bucket.messages.slice(index + 1);
    // Not announced: nobody has this session's state yet (it is being loaded).
    if (removed.length > 0) reduceEvents(this.state, this.removalEvents(removed));
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
    if (this.lifecycle === 'live-idle' && !this.hasRunningTasks) void this.deps.fileHistory?.end(this.id);
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
    // The CLI started a turn on its own (a queued message was dequeued, an auto-continuation): the checkpoint an idle
    // closed must cover what this turn does. `reopen` is a no-op when a newer checkpoint is already open (normal send).
    if (busy && !this.revertMarker) void this.deps.fileHistory?.reopen(this.id);
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
      // A pending revert becomes permanent now: the hidden messages are cut from the conversation.
      if (this.revertMarker) await this.commitRevert();
      if (input.mode && this.modeAllowed(input.mode)) this.prefs.mode = input.mode;
      // The agent first: switching applies its model/effort preset, which explicit values sent with it then override.
      if (input.agent !== undefined) this.applyAgent(input.agent);
      if (input.model) this.prefs.model = input.model;
      if (input.effort !== undefined) this.prefs.effort = input.effort;
      this.deps.onPrefsChanged?.(this);
      if (this.isLive) await this.applyLiveSettings();

      // Agent switch (or an effort change the live process could not take): respawn with `resume`, only between
      // turns; a busy turn keeps its agent.
      // Background subagents die with the process: while any runs, the respawn waits (the stale flags stay set).
      if (this.lifecycle === 'live-idle' && !this.hasRunningTasks && (this.spawnedAgent !== (this.prefs.agent || undefined) || this.effortStale || this.configStale)) {
        this.deps.log('info', 'agent, effort or config changed, respawning session process', { id: this.id, from: this.spawnedAgent, to: this.prefs.agent, effortStale: this.effortStale, configStale: this.configStale });
        await this.closeProcess();
      }
      if (this.pendingCut && !this.isLive && (await this.cutSubagents(this.pendingCut.promptIds, this.pendingCut.trimmedAgentIds))) this.pendingCut = undefined; // idempotent re-application
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
      // Snapshot the files right before the message is pushed (never throws; a failure only means no checkpoint).
      await this.deps.fileHistory?.begin(this.id, uuid);
      if (this.disposed) throw new Error('This session was deleted');
      if (!this.mapper || !this.queue || this.pendingInterrupt) {
        this.pendingInterrupt = false;
        throw new Error('Interrupted before the message was sent');
      }
      // The label is the agent the message is actually processed by (a queued message keeps the running agent).
      // Effort: what the live process runs with (a change it could not take yet is not in effect for this turn).
      this.mapper!.configure({ model: this.prefs.model, mode: this.prefs.mode, agent: this.spawnedAgent, effort: this.liveEffort });
      const { messageId, events } = this.mapper!.startUserMessage({ content: blocks, uuid });
      // A stop watchdog of the previous turn must not close / stop anything of this one.
      this.turnSeq += 1;
      this.clearStopWatchdog();
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
      const executablePath = this.deps.executablePath();
      if (!executablePath) throw new Error(`${CLI_NOT_FOUND_MESSAGE} ${installHint()}`);
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
        ...(this.exists ? { resume: this.id, ...(this.resumeAt ? { resumeSessionAt: this.resumeAt } : {}) } : { sessionId: this.id }),
        ...(model && model !== 'default' ? { model } : {}),
        permissionMode: this.prefs.mode,
        ...(this.prefs.effort ? { effort: this.prefs.effort } : {}),
        // Do not declare `perTaskStopAffordance`, and never abort the AbortController to interrupt a turn (that kills the
        // process): `query.interrupt()` aborts the turn and every subagent running under it (docs/STOP_SUBAGENTS_FIX.md).
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
        allowedTools: ['TodoWrite'],
        env,
        abortController: abort,
        canUseTool: this.broker.canUseTool as unknown as SdkOptions['canUseTool'],
        stderr: (data) => this.deps.stderr?.(data),
        pathToClaudeCodeExecutable: executablePath,
      };
      const mapper = createMapper({
        sessionId: this.id,
        cwd: this.deps.cwd,
        mode: this.prefs.mode,
        model,
        agent,
        now: this.deps.now,
        aliases: (this.deps.aliases ?? pluginAliasResolver)(this.id),
        subagentDefaults: this.deps.subagentDefaults,
        subagentMeta: this.subagentMeta,
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
      this.configStale = false;
      // Sessions that predate the per-turn record fall back to the agent they first ran with.
      this.deps.agentLog?.noteInitial(this.id, agent ?? this.prefs.mode);
      this.liveMode = this.prefs.mode;
      this.liveModel = model;
      this.initEmitted = false;
      this.spawnCount += 1;
      this.setLifecycle('live-idle');
      this.pump = this.runPump(this.query, mapper);
      void this.measureAfterSpawn(this.query);
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
          this.clearStopWatchdog();
          this.scheduleContextUsage();
        }
        if (message.type === 'system' && message.subtype === 'init') {
          this.exists = true;
          // The cut is in the transcript now; a spawn that died before `init` keeps it for the next attempt.
          this.resumeAt = undefined;
          if (this.committedMarker) {
            this.committedMarker = undefined;
            void this.deps.revertStore?.clear(this.id).catch((error) => this.deps.log('warn', 'could not clear the committed revert marker', error instanceof Error ? error.message : String(error)));
          }
        }
        this.publish(mapper.apply(message));
      }
    } catch (error) {
      failure = error;
    } finally {
      this.clearStopWatchdog();
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
      void this.deps.fileHistory?.end(this.id);
      this.deps.onActivity?.(this, 'idle');
      const message = failure instanceof Error ? failure.message : failure ? String(failure) : undefined;
      // A throw after a `result` is the normal end when the CLI exits (W0 notes 3.6); dying mid-turn is unexpected.
      if (!wasClosing && (wasBusy || (failure && !sawResult))) {
        this.publish([{ type: 'session.error', properties: { sessionID: this.id, error: { name: 'process_exit', message: message ?? 'Claude Code process ended unexpectedly', kind: /login|auth/i.test(message ?? '') ? 'auth' : 'unknown' } } }]);
      }
    }
  }

  // --- revert ---------------------------------------------------------------------

  /** Workspace-relative path when inside the cwd, else absolute. */
  private displayPath(path: string): string {
    const abs = resolve(this.deps.cwd, path);
    const rel = relative(this.deps.cwd, abs);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
  }

  /** The user message a revert targets (main session, with a transcript uuid, not a subagent instruction). */
  private async revertTarget(messageId: string): Promise<{ uuid: string; messageId: string; resumeAt: string | null }> {
    if (!this.exists) throw new Error('Nothing to revert yet');
    await this.ensureLoaded();
    const bucket = bucketFor(this.state, this.id);
    const index = bucket.messages.findIndex((m) => m.id === messageId);
    const message = bucket.messages[index];
    if (!message || message.role !== 'user' || !message.claudeUuid || message.instruction) throw new Error('This message cannot be reverted');
    const resumeAt = cutUuidBefore(bucket.messages, bucket.parts, index);
    // No cuttable entry before it is only "revert to the very first message" when it really is the first message;
    // otherwise (e.g. entries without a transcript uuid in front) deleting the transcript would lose the earlier turns.
    if (resumeAt === undefined && index !== 0) throw new Error('This message cannot be reverted');
    return { uuid: message.claudeUuid, messageId, resumeAt: resumeAt ?? null };
  }

  /** Stops a running turn (and background subagents) before files change under it; an idle live process stays alive. */
  private async stopRunningTurn(): Promise<void> {
    if (this.lifecycle === 'live-busy' || this.lifecycle === 'starting' || (this.isLive && this.hasRunningTasks)) {
      this.mapper?.markStopRequested();
      // A CLI that does not answer the interrupt must not hang the revert: closing the process stops the turn anyway.
      if (this.query) await this.withTimeout(this.interruptTurn(this.query).catch(() => undefined), INTERRUPT_TIMEOUT_MS);
      await this.closeProcess();
    }
  }

  /** Resolves with `work`, or after `ms` without it (the work keeps running unobserved). Uses the session timers. */
  private withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const handle = this.deps.timers.setTimeout(() => {
        this.deps.log('warn', 'interrupt did not answer in time; closing the process', { id: this.id, ms });
        resolve();
      }, ms);
      void work.then(() => {
        this.deps.timers.clearTimeout(handle);
        resolve();
      });
    });
  }

  /**
   * Absolute paths edited by Write / Edit / MultiEdit / NotebookEdit calls in the range a revert to `fromMessageId`
   * undoes: the main messages from it on, the children their Agent calls created, and, in the other children, what
   * they did after the first follow-up sent from a reverted message (same range as the commit removes).
   */
  private editedPaths(fromMessageId: string): string[] {
    const main = bucketFor(this.state, this.id);
    const removed = main.messages.filter((m) => m.id >= fromMessageId);
    const range = this.revertedRange(removed);
    const scopes: Array<{ messages: Message[]; parts: Record<string, ReadonlyArray<unknown>> }> = [{ messages: removed, parts: main.parts }];
    for (const id of range.owned) {
      const child = this.state.sessions.get(id);
      if (child) scopes.push(child);
    }
    for (const [id, messages] of range.followUps) scopes.push({ messages, parts: this.state.sessions.get(id)!.parts });
    const paths = new Set<string>();
    for (const scope of scopes) {
      for (const m of scope.messages) {
        for (const part of (scope.parts[m.id] ?? []) as Array<{ type: string; tool?: string; claude?: { name?: string }; state?: { input?: Record<string, unknown> } }>) {
          if (part.type !== 'tool') continue;
          const name = (part.claude?.name ?? part.tool ?? '').toLowerCase();
          if (!['write', 'edit', 'multiedit', 'notebookedit'].includes(name)) continue;
          const input = part.state?.input ?? {};
          const path = [input.filePath, input.file_path, input.notebook_path, input.notebookPath].find((v): v is string => typeof v === 'string' && v !== '');
          if (path) paths.add(resolve(this.deps.cwd, path));
        }
      }
    }
    return [...paths];
  }

  /** Adds "N files edited in these turns can't be restored: …" to a revert / preview `filesError`. */
  private async withUnrestorableNote(fromMessageId: string, filesError: string | undefined): Promise<string | undefined> {
    const history = this.deps.fileHistory;
    if (!history) return filesError;
    const bad = await history.audit(this.editedPaths(fromMessageId));
    if (bad.length === 0) return filesError;
    const shown = bad.slice(0, 5).map((p) => this.displayPath(p)).join(', ') + (bad.length > 5 ? ', …' : '');
    const note = `${bad.length} file(s) edited in these turns can't be restored: ${shown}`;
    return filesError ? `${filesError}; ${note}` : note;
  }

  /** Dry run of the file restore for reverting to `messageId`: touches nothing and starts no process. */
  revertPreview(messageId: string): Promise<RevertPreview> {
    return this.exclusive(async () => {
      const target = await this.revertTarget(messageId);
      const history = this.deps.fileHistory;
      if (!history) return { files: [], insertions: 0, deletions: 0, filesError: 'file snapshots are unavailable in this host' };
      const preview = await history.preview(this.id, target.uuid, this.revertMarker?.head);
      const filesError = await this.withUnrestorableNote(target.messageId, preview.filesError);
      return { ...preview, files: preview.files.map((p) => this.displayPath(p)), ...(filesError ? { filesError } : {}) };
    });
  }

  /**
   * Restores the files (from the git snapshots) and hides `messageId` and everything after it until the next send
   * commits the cut, or `unrevert`. The head tree taken right before restoring lets `unrevert` undo it (D5).
   */
  revert(messageId: string): Promise<RevertResult> {
    return this.exclusive(async () => {
      const store = this.deps.revertStore;
      if (!store) throw new Error('Revert is not available in this host');
      const target = await this.revertTarget(messageId);
      if (this.revertMarker?.uuid === target.uuid) return { files: [] };
      await this.stopRunningTurn();
      const history = this.deps.fileHistory;
      let files: string[] = [];
      let filesError: string | undefined;
      let head: string | undefined;
      if (!history) {
        filesError = 'file snapshots are unavailable in this host';
      } else {
        // Back to the head state first, so the new revert starts from it. A failure propagates: the old marker (and
        // its redo state) stays untouched.
        const old = this.revertMarker;
        if (old?.head) {
          const undone = await history.unrevert(this.id, old.uuid, old.head);
          // A store that is only temporarily unavailable (git missing, setting off) must not drop the redo head: refuse.
          if (undone.unavailable) throw new Error(`Cannot move the revert while file snapshots are unavailable (${undone.skipped}). Use /redo first, or fix the setup and try again.`);
          if (undone.skipped) this.deps.log('warn', 'files of the previous revert were not restored', { id: this.id, reason: undone.skipped });
        }
        const result = await history.revert(this.id, target.uuid);
        files = result.files.map((p) => this.displayPath(p));
        filesError = await this.withUnrestorableNote(target.messageId, result.filesError);
        head = result.head;
      }
      this.revertMarker = { uuid: target.uuid, resumeAt: target.resumeAt, ...(head ? { head } : {}) };
      await store.set(this.id, this.revertMarker);
      this.info = { ...this.info, revert: { messageID: target.messageId } };
      this.publish([{ type: 'session.updated', properties: { sessionID: this.id, info: this.info } }]);
      this.deps.onActivity?.(this, 'idle');
      return { files, ...(filesError ? { filesError } : {}) };
    });
  }

  /** Writes the head state back (when the marker has one) and shows the hidden messages again. */
  unrevert(): Promise<void> {
    return this.exclusive(async () => {
      const marker = this.revertMarker;
      if (!marker) return;
      if (marker.head && this.deps.fileHistory) {
        // A file that cannot be written back throws: the marker stays so /redo can be retried.
        const undone = await this.deps.fileHistory.unrevert(this.id, marker.uuid, marker.head);
        // Nothing to restore from (expired snapshots, store unavailable): the conversation is restored only.
        if (undone.skipped) this.deps.log('warn', 'files were not restored on unrevert', { id: this.id, reason: undone.skipped });
      }
      await this.deps.revertStore?.clear(this.id);
      this.revertMarker = undefined;
      this.clearRevertInfo();
      this.publish([{ type: 'session.updated', properties: { sessionID: this.id, info: this.info } }]);
    });
  }

  /** Leftover checkpoints only waste space: a failure must never block the send that commits the cut. */
  private async dropCheckpoints(fromUuid: string): Promise<void> {
    await this.deps.fileHistory?.drop(this.id, fromUuid).catch((error) => this.deps.log('warn', 'could not drop file checkpoints', { id: this.id, error: error instanceof Error ? error.message : String(error) }));
  }

  private clearRevertInfo(): void {
    const { revert: _revert, ...rest } = this.info;
    this.info = rest;
  }

  /**
   * The next send after a revert: drops the hidden messages (and the subagent children they created) from the state and
   * makes the transcript follow: the next process resumes at the last kept entry, or, when the very first message was
   * reverted, the transcript is deleted and a fresh session starts under the same id.
   */
  private async commitRevert(): Promise<void> {
    const marker = this.revertMarker;
    if (!marker) return;
    await this.closeProcess();
    // The reverted turns' promptIds are computed once (the process is closed: the transcript is complete) and persisted
    // with the committed marker, so a re-applied cut can never match turns of the new branch.
    const paths = transcriptPaths({ home: this.deps.home, cwd: this.deps.cwd, sessionId: this.id });
    const promptIds = marker.promptIds ?? (await revertedPromptIds(paths.main, marker.uuid));
    if (!promptIds) this.deps.log('warn', 'could not find the reverted turns in the transcript; subagent transcripts are not rolled back', { id: this.id, uuid: marker.uuid });
    // Which subagents the cut will rewrite is fixed before the first rewrite (dry run) and persisted with the promptIds.
    const trimmedAgentIds = promptIds ? (marker.trimmedAgentIds ?? (await trimSubagents(paths.subagents, promptIds, undefined, { dryRun: true })).trimmed) : undefined;
    const committed: RevertMarker = { ...marker, ...(promptIds ? { promptIds } : {}), ...(trimmedAgentIds ? { trimmedAgentIds } : {}) };
    if (marker.resumeAt) {
      // Persist the cut until a process announced it: a reload before that keeps the messages hidden and resumes there.
      this.resumeAt = marker.resumeAt;
      this.committedMarker = committed;
      await this.deps.revertStore?.commit(this.id, committed);
      await this.dropCheckpoints(marker.uuid);
      if (promptIds) this.pendingCut = (await this.cutSubagents(promptIds, trimmedAgentIds ?? [])) ? undefined : { promptIds, trimmedAgentIds: trimmedAgentIds ?? [] };
    } else {
      await this.deps.revertStore?.clear(this.id);
      await this.dropCheckpoints(marker.uuid);
      if (promptIds) await this.cutSubagents(promptIds, []); // before the transcript is deleted
      try {
        await (await this.deps.runtime()).sessions.deleteSession(this.id, { dir: this.deps.cwd });
      } catch (error) {
        if (!/not found/i.test(error instanceof Error ? error.message : String(error))) throw error;
      }
      this.exists = false;
      this.resumeAt = undefined;
      this.setLifecycle('draft');
    }
    const bucket = bucketFor(this.state, this.id);
    const from = this.info.revert?.messageID;
    const events = this.removalEvents(from ? bucket.messages.filter((m) => m.id >= from) : []);
    this.revertMarker = undefined;
    this.clearRevertInfo();
    events.push({ type: 'session.updated', properties: { sessionID: this.id, info: this.info } });
    this.publish(events);
  }

  /**
   * Rolls the subagent transcripts of the reverted turns back (docs/REVERT_SPEC.md, "Subagent context") and cleans the
   * plugin's alias state. Never throws: a failure is logged and reported so the cut is retried before the next spawn.
   */
  private async cutSubagents(promptIds: string[], knownTrimmed: string[]): Promise<boolean> {
    try {
      const paths = transcriptPaths({ home: this.deps.home, cwd: this.deps.cwd, sessionId: this.id });
      const cut = await trimSubagents(paths.subagents, promptIds);
      for (const f of cut.failed) this.deps.log('warn', 'could not trim a subagent transcript', { id: this.id, ...f });
      if (cut.removed.length || cut.trimmed.length) this.deps.log('info', 'subagent transcripts rolled back', { id: this.id, removed: cut.removed.length, trimmed: cut.trimmed.length, relinked: cut.relinked });
      // `knownTrimmed` comes from the marker: a retry finds nothing left to rewrite but must still reset those aliases.
      await cleanPluginState({ home: this.deps.home, sessionId: this.id, removedAgentIds: cut.removed, trimmedAgentIds: [...new Set([...knownTrimmed, ...cut.trimmed])], subagentsDir: paths.subagents, log: this.deps.log });
      return cut.failed.length === 0;
    } catch (error) {
      this.deps.log('warn', 'could not roll back subagent transcripts', { id: this.id, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * Events removing `removed` main messages, the subagent children their Agent calls created and, in the children that
   * stay, the SendMessage follow-ups sent from a removed message with everything the child did after the first of them.
   */
  private removalEvents(removed: Message[]): ClaudeEvent[] {
    const events: ClaudeEvent[] = removed.map((m) => ({ type: 'message.removed', properties: { sessionID: this.id, messageID: m.id } }));
    const range = this.revertedRange(removed);
    for (const childId of range.owned) {
      const info = this.state.sessions.get(childId)?.info;
      if (info) events.push({ type: 'session.deleted', properties: { sessionID: childId, info } });
      else this.state.sessions.delete(childId);
    }
    for (const [childId, messages] of range.followUps) {
      for (const m of messages) events.push({ type: 'message.removed', properties: { sessionID: childId, messageID: m.id } });
    }
    return events;
  }

  /**
   * What reverting main messages `removed` undoes outside the main session (the one rule behind both the commit's
   * removal events and the audit of edits): the children their Agent calls created (with nested ones), and, in every
   * other child, the messages from the first follow-up sent from a removed message on.
   */
  private revertedRange(removed: Message[]): { owned: string[]; followUps: Map<string, Message[]> } {
    const main = bucketFor(this.state, this.id);
    const owned = this.childrenOwnedBy(removed.flatMap((m) => main.parts[m.id] ?? []));
    const removedIds = new Set(removed.map((m) => m.id));
    const followUps = new Map<string, Message[]>();
    for (const [childId, child] of this.state.sessions) {
      if (childId === this.id || owned.includes(childId)) continue;
      const first = child.messages.findIndex((m) => m.role === 'user' && m.instruction?.fromMessageID !== undefined && removedIds.has(m.instruction.fromMessageID));
      if (first >= 0) followUps.set(childId, child.messages.slice(first));
    }
    return { owned, followUps };
  }

  /** Child sessions created by `Agent` calls among `parts`, plus the children nested below them. */
  private childrenOwnedBy(parts: ReadonlyArray<{ type: string; tool?: string; callID?: string; claude?: { name?: string } }>): string[] {
    const owned = new Set<string>();
    for (const part of parts) {
      if (part.type !== 'tool' || !part.callID || !isTaskTool(part.claude?.name ?? part.tool ?? '')) continue;
      const id = `sub_${part.callID}`;
      if (this.state.sessions.has(id)) owned.add(id);
    }
    // Nested subagents hang off a removed child (parentID).
    for (let grew = true; grew;) {
      grew = false;
      for (const [id, bucket] of this.state.sessions) {
        if (!owned.has(id) && bucket.info?.parentID && owned.has(bucket.info.parentID)) {
          owned.add(id);
          grew = true;
        }
      }
    }
    return [...owned];
  }

  // --- control -------------------------------------------------------------------

  async interrupt(): Promise<void> {
    // Stop pressed while a send is still spawning the process: cancel that send instead of ignoring the click.
    if ((!this.query || this.lifecycle === 'starting') && this.sendInFlight > 0) this.pendingInterrupt = true;
    const query = this.query;
    if (!query) return;
    // First: a foreground subagent cut short by the abort reports `completed`, which must show as stopped.
    this.mapper?.markStopRequested();
    // Armed before the await: the aborted `result` may arrive before the control response and must disarm it.
    if (this.stopIncomplete()) this.armStopWatchdog(query, this.turnSeq);
    try {
      await this.interruptTurn(query);
    } catch (error) {
      this.deps.log('warn', 'interrupt failed', error);
    }
  }

  /** `interrupt({cancelQueued})` and the receipt: messages the CLI cancelled will never run, so they are removed. */
  private async interruptTurn(query: ClaudeQuery): Promise<void> {
    const receipt = await query.interrupt({ cancelQueued: true });
    const cancelled = (receipt as { cancelled?: unknown } | null | undefined)?.cancelled;
    if (!Array.isArray(cancelled) || cancelled.length === 0) return;
    const messages = bucketFor(this.state, this.id).messages;
    const events: ClaudeEvent[] = [];
    for (const uuid of cancelled) {
      // Uuids the host never sent (cron triggers, auto-resume) are ignored.
      const message = typeof uuid === 'string' ? messages.find((m) => m.role === 'user' && m.claudeUuid === uuid) : undefined;
      if (!message) continue;
      events.push({ type: 'message.removed', properties: { sessionID: this.id, messageID: message.id } });
      this.deps.agentLog?.forget(this.id, message.claudeUuid!);
    }
    this.publish(events);
  }

  /** True while the process still runs something the interrupt should have ended. */
  private stopIncomplete(): boolean {
    return this.status.type !== 'idle' || this.hasRunningTasks;
  }

  /** Background / foreground subagent runs still tracked by the mapper (they die with the process). */
  private get hasRunningTasks(): boolean {
    return (this.mapper?.runningTasks().length ?? 0) > 0;
  }

  /**
   * An interrupt normally ends in an aborted `result` within moments. If tasks or the turn are still running after
   * `STOP_WATCHDOG_MS`, stop each running task; if that does not help either, close the process (which idles everything).
   * `turn` is the turn the stop was pressed in: once a newer user message started, the watchdog is moot.
   */
  private armStopWatchdog(query: ClaudeQuery, turn: number): void {
    this.clearStopWatchdog();
    const { timers } = this.deps;
    const stale = (): boolean => this.query !== query || this.turnSeq !== turn || !this.stopIncomplete();
    this.stopTimers.push(timers.setTimeout(() => {
      this.stopTimers = [];
      if (stale()) return;
      const taskIds = new Set(this.mapper?.runningTasks().map((t) => t.taskId));
      this.deps.log('info', 'stop watchdog: stopping tasks that outlived the interrupt', { id: this.id, tasks: [...taskIds] });
      for (const taskId of taskIds) void query.stopTask?.(taskId).catch((error) => this.deps.log('debug', 'stopTask failed', error));
      this.stopTimers.push(timers.setTimeout(() => {
        this.stopTimers = [];
        void this.closeIfStillStuck(stale);
      }, STOP_WATCHDOG_MS));
    }, STOP_WATCHDOG_MS));
  }

  /** Decided inside the exclusive section: a send that slipped in meanwhile makes the close moot. */
  private closeIfStillStuck(stale: () => boolean): Promise<void> {
    return this.exclusive(async () => {
      if (stale()) return;
      this.deps.log('warn', 'stop watchdog: closing the process', { id: this.id });
      await this.closeProcess();
    });
  }

  private clearStopWatchdog(): void {
    for (const t of this.stopTimers.splice(0)) this.deps.timers.clearTimeout(t);
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
    // A measurement already in flight started before this turn ended: take a fresh one after it.
    const inFlight = this.contextMeasuring;
    void (inFlight ? inFlight.then(() => this.measureContextUsage()) : this.measureContextUsage());
  }

  /**
   * Right after the process initialised: `getContextUsage` answers without a turn, so the popup has exact figures
   * from the start instead of after the first result. Bypasses (and does not feed) the post-result throttle.
   */
  private async measureAfterSpawn(query: ClaudeQuery): Promise<void> {
    try {
      await query.initializationResult?.();
    } catch {
      return;
    }
    if (this.query !== query || this.disposed) return;
    await this.measureContextUsage(false);
  }

  /** SDK `getContextUsage` on the live process, folded into `Session.contextUsage` (announced by `session.updated`). */
  private measureContextUsage(throttled = true): Promise<ContextUsage | undefined> {
    const query = this.query;
    if (!query?.getContextUsage || !this.isLive) return Promise.resolve(undefined);
    this.contextMeasuring ??= (async () => {
      let timer: unknown;
      try {
        // A hung process must not leave `contextMeasuring` set forever (every later measurement would join it).
        const timeout = new Promise<never>((_, reject) => {
          timer = this.deps.timers.setTimeout(() => reject(new Error(`getContextUsage timed out after ${CONTEXT_MEASURE_TIMEOUT_MS} ms`)), CONTEXT_MEASURE_TIMEOUT_MS);
        });
        const usage = toContextUsage(await Promise.race([query.getContextUsage!({ detail: 'full' }), timeout]), this.deps.now());
        if (usage && !this.disposed) {
          this.contextUsage = usage;
          this.deps.onModelWindow?.(this.prefs.model, usage.maxTokens);
          const baseline = toContextBaseline(usage);
          if (baseline) this.deps.onContextBaseline?.(this.prefs.model, baseline);
          if (throttled) this.contextMeasuredAt = this.deps.now();
          this.info = { ...this.info, contextUsage: usage };
          this.publish([{ type: 'session.updated', properties: { sessionID: this.id, info: this.info } }]);
        }
        return usage;
      } catch (error) {
        this.deps.log('debug', 'getContextUsage failed', error instanceof Error ? error.message : String(error));
        return undefined;
      } finally {
        if (timer !== undefined) this.deps.timers.clearTimeout(timer);
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
    const tokens = this.lastKnownTokens();
    // Nothing counted in the transcript: keep the seeded estimate rather than replacing it with an empty one.
    if (!tokens && this.info.contextUsage) return this.info.contextUsage;
    const estimate = estimateContextUsage(tokens ?? 0, this.deps.now(), undefined, this.deps.modelWindow?.(this.prefs.model));
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
