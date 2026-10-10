/**
 * Pure SDKMessage -> domain event mapper (docs/PHASE1_PLAN.md D2, section 2 "SDK -> domain mapping";
 * docs/W0_SPIKE_NOTES.md overrides the plan where they differ).
 *
 * One mapper instance per Claude session. It converts live `SDKMessage`s **and** JSONL history entries
 * (`getSessionMessages`, replay mode) into `ClaudeEvent`s understood by the webview reducer. It performs no I/O,
 * never throws on unknown input, and emits raw deltas (16 ms coalescing is the broadcaster's job, W3).
 *
 * Design notes
 * - Routing: `parent_tool_use_id == null` -> main session; otherwise the virtual child session `sub_<toolUseId>`.
 * - Claude delivers each content block twice: as `stream_event`s (when `includePartialMessages`) and as one `assistant`
 *   message per block. Both feed the same parts: tools pair by block id, text/thinking by ordinal within the API message.
 *   Once the `assistant` block has been reconciled the part is "sealed" and late deltas are dropped.
 * - Ids are host generated and ascending (D6); Claude uuids are kept as `claudeUuid`.
 * - Tolerant by design: unknown message types/subtypes are logged once and ignored.
 */
import type { ClaudeEvent, SessionErrorKind } from '@openchamber/ui/src/lib/claude/protocol';
import type {
  EffortLevel,
  AssistantMessage,
  FilePart,
  Message,
  Part,
  PermissionMode,
  ReasoningPart,
  Session,
  SessionStatus,
  SlashCommand,
  SubagentInstruction,
  TextPart,
  Todo,
  ToolPart,
  UserMessage,
} from '@openchamber/ui/src/lib/claude/types';
import {
  buildEditDiff,
  buildMultiEditDiff,
  buildWriteDiff,
  diffMetadata,
  type FileDiff,
  toRelativePath,
} from './diff';
import { turnRecordOf, type TurnRecord } from './agentLog';
import { childSessionId, createIdGenerator, type IdGenerator } from './ids';
import type { SessionState } from './sessionState';
import {
  isHiddenToolSearch,
  isTaskCreateTool,
  isTaskTool,
  isTaskUpdateTool,
  normalizeToolInput,
  normalizeToolName,
  toolTitle,
} from './toolNormalize';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type MapperLogLevel = 'debug' | 'warn';

export type InitInfo = {
  sessionId: string;
  model: string;
  permissionMode: PermissionMode;
  slashCommands: string[];
  tools: string[];
  agents: string[];
  skills: string[];
  claudeCodeVersion: string;
};

export type MapperHooks = {
  /** `system/init` (emitted once per turn). The host refreshes its catalog / mode from it. */
  onInit?: (init: InitInfo) => void;
  /** `system/status` announced a permission mode (also after ExitPlanMode / "always allow"). */
  onModeChanged?: (mode: PermissionMode) => void;
  /** `system/commands_changed`. */
  onCommandsChanged?: (commands: SlashCommand[]) => void;
  /** `rate_limit_event` (claude.ai subscription): the raw `rate_limit_info`. */
  onRateLimit?: (info: Record<string, unknown>) => void;
};

export type MapperOptions = {
  sessionId: string;
  cwd: string;
  /** Current permission mode; recorded on user messages (`UserMessage.agent`). */
  mode: PermissionMode;
  /** Current model value; recorded on user messages. */
  model: string;
  /**
   * Main-thread agent name (plan amendment A1, e.g. `claudekei:orchestrator`), recorded on user messages as
   * `UserMessage.agent`. Falls back to the permission mode when unset.
   */
  agent?: string;
  now?: () => number;
  ids?: IdGenerator;
  /**
   * History replay: the agent each main-session user turn was sent with (`claudeUuid -> agent`, host-recorded).
   * Turns without an entry take the nearest earlier known agent, then `initial`, then `agent`.
   */
  userAgents?: { byUuid: ReadonlyMap<string, string | TurnRecord>; initial?: string };
  /** Effort in effect (recorded as `UserMessage.model.variant`); null/undefined = model default. */
  effort?: EffortLevel | null;
  /** History replay: timestamps come from the transcript, no status events, user prompts are materialized. */
  replay?: boolean;
  /** Tool outputs longer than this (UTF-16 code units) are cut and flagged `metadata.truncated`. Default: no limit. */
  maxToolOutputChars?: number;
  log?: (level: MapperLogLevel, message: string, data?: unknown) => void;
  hooks?: MapperHooks;
  /** Plugin alias lookups (read-only access to the claudekei plugin's per-session state), optional. */
  aliases?: AliasResolver;
};

/** Maps plugin session aliases (`exp-1`) to agent ids and back. */
export type AliasResolver = {
  forAgent(agentId: string): string | undefined;
  resolve(alias: string): string | undefined;
};

export type UserMessageInput = {
  /** Prompt text, or Messages-API content blocks (`text`, `image`, `document`). */
  content: string | unknown[];
  /** Transcript uuid (the host supplies it on the streamed `SDKUserMessage`). */
  uuid?: string;
  mode?: PermissionMode;
  model?: string;
  /** Effort in effect for this prompt (defaults to the mapper's current effort); recorded as `model.variant`. */
  effort?: EffortLevel | null;
  /** Main-thread agent name for this prompt (defaults to the mapper's current agent). */
  agent?: string;
  /** Set on user messages created inside a subagent child session. */
  instruction?: SubagentInstruction;
};

export type Mapper = {
  /** Maps one SDK message (or history entry in replay mode) to zero or more events. Never throws. */
  apply(message: unknown): ClaudeEvent[];
  /**
   * Creates the user message for a prompt the host is about to send (D9: no optimistic layer, the host emits it
   * immediately). Also marks the session busy. In replay mode user messages come from `apply`.
   */
  startUserMessage(input: UserMessageInput): { messageId: string; events: ClaudeEvent[] };
  /**
   * The query ended (process exit / close / throw) or the turn was cut: open messages are completed, tools that are
   * still pending/running become errors, subagent children and the session go idle.
   */
  finish(reason: 'ended' | 'interrupted' | 'error', message?: string): ClaudeEvent[];
  /** Updates the defaults recorded on subsequent user messages (model switch, mode cycle, agent respawn). */
  configure(settings: { model?: string; mode?: PermissionMode; agent?: string; effort?: EffortLevel | null }): void;
  /**
   * Replay only: tells the mapper which agentId owns which `Agent` tool call (from `listSubagents` /
   * `getSubagentMessages`), before the main transcript is applied.
   */
  registerAgent(agentId: string, ownerToolUseId: string): void;
  /** Respawn: adopt the child sessions / agent registry of the session's current state (see implementation). */
  seed(state: SessionState): void;
  /**
   * The host asked the CLI to interrupt: a foreground subagent that the abort cuts short reports `task_notification
   * completed` from the CLI's `finally`, which must not turn into a "done" card. The flag is cleared by the next
   * user message and by the aborted `result`.
   */
  markStopRequested(): void;
  /** Subagent runs that have started and not ended yet (the host's stop watchdog stops them one by one). */
  runningTasks(): Array<{ taskId: string; runId: string; toolUseId: string; childId: string }>;
  readonly info: {
    readonly model: string;
    readonly mode: PermissionMode;
    readonly agent: string | undefined;
    readonly lastUserMessageId: string | undefined;
    readonly childSessionIds: string[];
  };
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

const PROVIDER = 'anthropic' as const;
const KNOWN_MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'];
const AUTH_ERRORS = new Set([
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'cloud_credential_error',
]);
const AUTH_TEXT = /\/login|not logged in|invalid api key|authentication/i;
const INTERRUPT_TEXT = /^(The user doesn't want to proceed with this tool use|\[Request interrupted by user)/;
const INTERRUPTED_MESSAGE = 'Interrupted by user';
const SYNTHETIC_COMPACT_TEXT = 'Context compacted';

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

type TextRef = {
  part: TextPart | ReasoningPart;
  /** Accumulated streamed text. */
  acc: string;
  /** Reconciled against the final `assistant` block: late deltas are ignored. */
  sealed: boolean;
};

/** One subagent instance (SDK `agent_id` / `task_id`) = one child session. */
type AgentRec = {
  agentId: string;
  childId: string;
  ownerToolUseId: string;
  agentType?: string;
  alias?: string;
  /** Runs currently executing: key = `run_id` (or the instructing tool_use id) -> the instructing tool call. */
  runs: Map<string, ToolRef>;
};

type InstructionRec = {
  message: UserMessage;
  kind: 'initial' | 'followup';
  text: string;
  /** Linked to a tool call (Agent/SendMessage). */
  linked: boolean;
};

type ToolRef = {
  /** Extra `state.metadata` that survives every state transition (subagent link keys, `hidden`, ...). */
  meta: Rec;
  /** Plain text of the tool_result (replay linking: `resumedAgentId`). */
  resultText?: string;
  part: ToolPart;
  container: Container;
  json: string;
  /** Launched asynchronously (background subagent): stays running until `task_notification`. */
  async: boolean;
  done: boolean;
  startMs: number | undefined;
  childId?: string;
};

type Block = { kind: 'text' | 'thinking'; ref: TextRef } | { kind: 'tool'; tool: ToolRef } | { kind: 'other' };

type AsstState = {
  message: AssistantMessage;
  container: Container;
  apiId: string;
  open: boolean;
  blocks: Map<number, Block>;
  streamed: { text: TextRef[]; thinking: TextRef[] };
  seen: { text: number; thinking: number };
  lastTs: number | undefined;
};

type Container = {
  id: string;
  parentId?: string;
  lastUserMessageId: string | undefined;
  lastAssistant: AsstState | undefined;
  /** Assistant messages still open in this container (usually 0 or 1). */
  open: Set<AsstState>;
  status: SessionStatus;
  /** Task-v2 todos keyed by task id. */
  taskTodos: Map<string, Todo>;
  /** Tool call (in the parent container) that spawned this child. */
  spawnedBy?: string;
  seenUuids: Set<string>;
  /** Child sessions only: the `Session` we announced, kept to emit `session.updated` (agent link, progress). */
  info?: Session;
  agentRec?: AgentRec;
  instructions: InstructionRec[];
  lastProgressEmit: number;
  /** An assistant text was seen since the latest instruction (forwarded by the SDK or synthesized by the safety net). */
  replied: boolean;
};

export function createMapper(options: MapperOptions): Mapper {
  const { sessionId, cwd, hooks } = options;
  const replay = options.replay === true;
  const nowFn = options.now ?? Date.now;
  const ids = options.ids ?? createIdGenerator({ now: nowFn });
  const maxOutput = options.maxToolOutputChars ?? Number.POSITIVE_INFINITY;
  const logFn = options.log ?? (() => undefined);

  let mode: PermissionMode = options.mode;
  let model: string = options.model;
  let agent: string | undefined = options.agent;
  let effort: EffortLevel | null = options.effort ?? null;
  /** Replay: last agent / effort / model resolved for a main-session user turn (effort undefined = none recorded yet). */
  let replayAgent: string | undefined;
  let replayEffort: EffortLevel | null | undefined;
  let replayModel: string | undefined;
  let out: ClaudeEvent[] = [];
  /** Timestamp of the message being applied (replay only). */
  let curTs: number | undefined;
  const warned = new Set<string>();

  const containers = new Map<string, Container>();
  const tools = new Map<string, ToolRef>();
  const asstByApi = new Map<string, AsstState>();
  const asyncTaskByAgent = new Map<string, ToolRef>();
  /** Run keys registered as foreground (`task_started.is_backgrounded === false`). */
  const foregroundRuns = new Set<string>();
  /** Run keys ended by `stopRuns`: their late `task_notification` is ignored. */
  const stoppedRuns = new Set<string>();
  /** A host interrupt is in flight (see `Mapper.markStopRequested`). */
  let stopRequested = false;
  /** `result.total_cost_usd` is cumulative per `query()`: the cost already attributed to earlier turns of this process. */
  let costSeen = 0;
  /** agentId -> subagent instance; also keyed by childId in `agentByChild`. */
  const agents = new Map<string, AgentRec>();
  /** Replay: owner Agent tool_use id -> agentId (from the subagent transcripts), applied when the child is created. */
  const pendingAgentIndex = new Map<string, string>();
  let lastUserMessage: UserMessage | undefined;
  const PROGRESS_THROTTLE_MS = 1000;

  const log = (level: MapperLogLevel, message: string, data?: unknown): void => {
    try {
      logFn(level, message, data);
    } catch {
      /* logging must never break mapping */
    }
  };
  const warnOnce = (key: string, message: string, data?: unknown): void => {
    if (warned.has(key)) return;
    warned.add(key);
    log('warn', message, data);
  };

  // --- time & ids -----------------------------------------------------------

  const ms = (): number => (replay && curTs !== undefined ? curTs : nowFn());
  const nid = (): string => ids.next(replay ? curTs : undefined);

  // --- emit helpers ---------------------------------------------------------

  const emit = (event: ClaudeEvent): void => {
    out.push(event);
  };
  const emitMessage = (message: Message): void =>
    emit({ type: 'message.updated', properties: { sessionID: message.sessionID, info: structuredClone(message) } });
  const emitPart = (part: Part): void => emit({ type: 'message.part.updated', properties: { part: structuredClone(part) } });

  const setStatus = (container: Container, status: SessionStatus): void => {
    const prev = container.status;
    const same =
      prev.type === status.type &&
      (status.type !== 'retry' || (prev.type === 'retry' && prev.attempt === status.attempt && prev.next === status.next));
    if (same) return;
    container.status = status;
    if (replay) return;
    emit({ type: 'session.status', properties: { sessionID: container.id, status } });
  };

  // --- containers -----------------------------------------------------------

  const makeContainer = (id: string, parentId?: string): Container => {
    const c: Container = {
      id,
      parentId,
      lastUserMessageId: undefined,
      lastAssistant: undefined,
      open: new Set(),
      status: { type: 'idle' },
      taskTodos: new Map(),
      seenUuids: new Set(),
      instructions: [],
      lastProgressEmit: 0,
      replied: true,
    };
    containers.set(id, c);
    return c;
  };
  const main = makeContainer(sessionId);

  const containerForParent = (parentToolUseId: unknown): Container => {
    const parent = str(parentToolUseId);
    if (!parent) return main;
    const id = childSessionId(parent);
    const existing = containers.get(id);
    if (existing) return existing;
    const toolRef = tools.get(parent);
    return createChild(parent, toolRef?.container ?? main, str((toolRef?.part.state.input as Rec | undefined)?.description));
  };

  const createChild = (toolUseId: string, parent: Container, description?: string): Container => {
    const id = childSessionId(toolUseId);
    const existing = containers.get(id);
    if (existing) return existing;
    const child = makeContainer(id, parent.id);
    child.spawnedBy = toolUseId;
    const t = ms();
    const info: Session = {
      id,
      title: description?.trim() || 'Subagent',
      directory: cwd,
      parentID: parent.id,
      time: { created: t, updated: t },
    };
    child.info = info;
    emit({ type: 'session.created', properties: { sessionID: id, info: structuredClone(info) } });
    setStatus(child, { type: 'busy' });
    // Replay: the agent id is known up-front from the subagent transcripts.
    const known = pendingAgentIndex.get(toolUseId);
    if (known) attachAgent(child, known, toolUseId, undefined);
    return child;
  };

  /** Announces changes of a child's `Session` (agent link, alias, progress). */
  const emitChildInfo = (child: Container): void => {
    if (!child.info) return;
    child.info = { ...child.info, time: { ...child.info.time, updated: ms() } };
    emit({ type: 'session.updated', properties: { sessionID: child.id, info: structuredClone(child.info) } });
  };

  const setChildClaude = (child: Container, patch: Record<string, unknown>, announce = true): void => {
    if (!child.info) return;
    const next: Record<string, unknown> = { ...(child.info.claude ?? {}), ...patch };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    child.info = { ...child.info, claude: next as Session['claude'] };
    if (announce) emitChildInfo(child);
  };

  /** Registers (or returns) the agent instance behind a child session. */
  function attachAgent(child: Container, agentId: string, ownerToolUseId: string, agentType: string | undefined): AgentRec {
    let rec = agents.get(agentId);
    if (!rec) {
      rec = { agentId, childId: child.id, ownerToolUseId, agentType, runs: new Map() };
      agents.set(agentId, rec);
    } else if (agentType && !rec.agentType) rec.agentType = agentType;
    child.agentRec = rec;
    const ownerRef = tools.get(ownerToolUseId);
    const type = rec.agentType ?? str((ownerRef?.part.state.input as Rec | undefined)?.subagent_type);
    rec.agentType = type;
    setChildClaude(child, { agentId, agentType: type });
    if (ownerRef) updateSubMeta(ownerRef, { sessionID: child.id, agentId, ...(type ? { agentType: type } : {}) });
    return rec;
  }

  const applyAlias = (rec: AgentRec): void => {
    const alias = options.aliases?.forAgent(rec.agentId);
    if (!alias || alias === rec.alias) return;
    rec.alias = alias;
    const child = containers.get(rec.childId);
    if (child) setChildClaude(child, { alias });
  };

  // --- user messages --------------------------------------------------------

  const fileFromBlock = (block: Rec, messageId: string, container: Container): FilePart | undefined => {
    const type = str(block.type);
    if (type !== 'image' && type !== 'document') return undefined;
    const source = isRec(block.source) ? block.source : undefined;
    if (!source) return undefined;
    const mime = str(source.media_type) ?? (type === 'image' ? 'image/png' : 'application/octet-stream');
    let url: string | undefined;
    if (source.type === 'base64' && typeof source.data === 'string') url = `data:${mime};base64,${source.data}`;
    else if (source.type === 'url' && typeof source.url === 'string') url = source.url;
    if (!url) return undefined;
    return {
      id: nid(),
      sessionID: container.id,
      messageID: messageId,
      type: 'file',
      mime,
      filename: str(block.title) ?? str(block.name),
      url,
    };
  };

  const createUserMessage = (container: Container, input: UserMessageInput): string => {
    finalizeContainer(container);
    const blocks: unknown[] = typeof input.content === 'string' ? [{ type: 'text', text: input.content }] : input.content;
    const messageId = nid();
    let label = input.agent ?? agent ?? input.mode ?? mode;
    let modelID = input.model ?? model;
    let variant: EffortLevel | null = input.effort !== undefined ? input.effort : effort;
    const isMainTurn = container === main && !input.instruction;
    if (replay && options.userAgents && isMainTurn) {
      // The transcript records none of agent / effort / model: use the host's per-turn record, else carry the previous
      // known value forward, else fall back to the session's current ones (`agent` / `effort` / `model`).
      const entry = input.uuid ? options.userAgents.byUuid.get(input.uuid) : undefined;
      const rec = entry === undefined ? undefined : turnRecordOf(entry);
      replayAgent = rec?.agent ?? replayAgent ?? options.userAgents.initial;
      if (rec && rec.effort !== undefined) replayEffort = rec.effort;
      if (rec?.model) replayModel = rec.model;
      if (replayAgent) label = replayAgent;
      if (replayEffort !== undefined) variant = replayEffort;
      if (replayModel) modelID = replayModel;
    }
    const message: UserMessage = {
      id: messageId,
      sessionID: container.id,
      role: 'user',
      time: { created: ms() },
      // `UserMessage.agent` is the main-thread agent name (A1); the permission mode is the fallback.
      agent: label as UserMessage['agent'],
      // `variant` is the effort level in effect for the turn (omitted = model default); main-session turns only.
      model: { providerID: PROVIDER, modelID, ...(isMainTurn && variant ? { variant } : {}) },
      ...(input.uuid ? { claudeUuid: input.uuid } : {}),
      ...(input.instruction ? { instruction: input.instruction } : {}),
    };
    lastUserMessage = message;
    container.lastUserMessageId = messageId;
    emitMessage(message);
    for (const raw of blocks) {
      if (!isRec(raw)) continue;
      if (raw.type === 'text' && typeof raw.text === 'string') {
        const part: TextPart = {
          id: nid(),
          sessionID: container.id,
          messageID: messageId,
          type: 'text',
          text: raw.text,
          time: { start: ms(), end: ms() },
        };
        emitPart(part);
        continue;
      }
      const file = fileFromBlock(raw, messageId, container);
      if (file) emitPart(file);
    }
    return messageId;
  };

  // --- assistant messages ---------------------------------------------------

  const emptyTokens = (): AssistantMessage['tokens'] => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

  const applyUsage = (a: AsstState, usage: unknown): void => {
    if (!isRec(usage)) return;
    const t = a.message.tokens;
    const input = num(usage.input_tokens);
    const output = num(usage.output_tokens);
    const read = num(usage.cache_read_input_tokens);
    const write = num(usage.cache_creation_input_tokens);
    const details = isRec(usage.output_tokens_details) ? usage.output_tokens_details : undefined;
    const reasoning = num(details?.thinking_tokens);
    if (input !== undefined) t.input = input;
    if (output !== undefined) t.output = output;
    if (read !== undefined) t.cache.read = read;
    if (write !== undefined) t.cache.write = write;
    if (reasoning !== undefined) t.reasoning = reasoning;
    t.total = t.input + t.output + t.cache.read + t.cache.write;
  };

  const startAssistant = (container: Container, apiId: string, apiModel: string | undefined): AsstState => {
    finalizeContainer(container);
    const message: AssistantMessage = {
      id: nid(),
      sessionID: container.id,
      role: 'assistant',
      parentID: container.lastUserMessageId ?? '',
      time: { created: ms() },
      modelID: apiModel ?? model,
      providerID: PROVIDER,
      tokens: emptyTokens(),
      cost: 0,
      apiMessageId: apiId,
    };
    const a: AsstState = {
      message,
      container,
      apiId,
      open: true,
      blocks: new Map(),
      streamed: { text: [], thinking: [] },
      seen: { text: 0, thinking: 0 },
      lastTs: curTs,
    };
    asstByApi.set(apiId, a);
    container.open.add(a);
    container.lastAssistant = a;
    emitMessage(message);
    return a;
  };

  const finalizeAssistant = (a: AsstState): void => {
    if (!a.open) return;
    a.open = false;
    a.container.open.delete(a);
    // Streaming messages complete "now"; replayed ones at their last transcript timestamp.
    a.message.time.completed = replay ? (a.lastTs ?? ms()) : ms();
    emitMessage(a.message);
  };

  function finalizeContainer(container: Container): void {
    for (const a of [...container.open]) finalizeAssistant(a);
  }

  const classifyError = (name: string | undefined, text: string | undefined): SessionErrorKind => {
    if (name && AUTH_ERRORS.has(name)) return 'auth';
    if (text && AUTH_TEXT.test(text)) return 'auth';
    return name ? 'api' : 'unknown';
  };

  // --- parts ----------------------------------------------------------------

  const newTextRef = (a: AsstState, kind: 'text' | 'thinking', initial: string): TextRef => {
    const t = ms();
    const base = { id: nid(), sessionID: a.container.id, messageID: a.message.id };
    const part: TextPart | ReasoningPart =
      kind === 'text'
        ? { ...base, type: 'text', text: initial, time: { start: t } }
        : { ...base, type: 'reasoning', text: initial, time: { start: t } };
    const ref: TextRef = { part, acc: initial, sealed: false };
    (kind === 'text' ? a.streamed.text : a.streamed.thinking).push(ref);
    emitPart(part);
    return ref;
  };

  /** Writes the final text (and end time) to a part and emits it. */
  const settleTextRef = (ref: TextRef, text: string): void => {
    ref.acc = text;
    ref.part.text = text;
    if (ref.part.time && ref.part.time.end === undefined) ref.part.time.end = ms();
    emitPart(ref.part);
  };

  const registerTool = (a: AsstState, callId: string, claudeName: string, input: unknown, running: boolean): ToolRef => {
    const existing = tools.get(callId);
    if (existing) return existing;
    const tool = normalizeToolName(claudeName);
    const part: ToolPart = {
      id: nid(),
      sessionID: a.container.id,
      messageID: a.message.id,
      type: 'tool',
      tool,
      callID: callId,
      state: { status: 'pending', input: {}, raw: '' },
      claude: { name: claudeName, input: isRec(input) ? input : {} },
    };
    const ref: ToolRef = { part, container: a.container, json: '', async: false, done: false, startMs: undefined, meta: {} };
    tools.set(callId, ref);
    emitPart(part);
    if (running) markRunning(ref, input);
    return ref;
  };

  /** pending -> running with the (final) input. Idempotent; later calls refresh the input if it changed. */
  function markRunning(ref: ToolRef, rawInput: unknown): void {
    if (ref.done) return;
    const part = ref.part;
    const input = normalizeToolInput(part.claude.name, rawInput);
    part.claude.input = isRec(rawInput) ? rawInput : {};
    const prev = part.state;
    if (prev.status === 'running') {
      if (JSON.stringify(prev.input) === JSON.stringify(input)) return;
      prev.input = input;
      prev.title = toolTitle(part.tool, input, cwd) || prev.title;
      emitPart(part);
      return;
    }
    ref.startMs = ms();
    const title = toolTitle(part.tool, input, cwd);
    if (isHiddenToolSearch(part.claude.name, rawInput)) ref.meta.hidden = true;
    if (isTaskTool(part.claude.name)) {
      const child = createChild(part.callID, ref.container, str(input.description));
      ref.childId = child.id;
      Object.assign(ref.meta, {
        sessionID: child.id,
        ...(str(input.subagent_type) ? { agentType: str(input.subagent_type) } : {}),
        message: str(input.prompt) ?? '',
        runStatus: 'running',
      });
      // The agent may have been registered (replay index) before the tool input was known.
      const rec = child.agentRec;
      const type = str(input.subagent_type);
      if (rec && !rec.agentType && type) {
        rec.agentType = type;
        setChildClaude(child, { agentType: type });
      }
    } else if (part.tool === 'sendmessage') {
      Object.assign(ref.meta, { recipient: str(input.to) ?? '', message: str(input.message) ?? '' });
    }
    part.state = {
      status: 'running',
      input,
      ...(title ? { title } : {}),
      ...(Object.keys(ref.meta).length > 0 ? { metadata: { ...ref.meta } } : {}),
      time: { start: ref.startMs },
    };
    emitPart(part);
    if (part.tool === 'todowrite') emitTodos(ref.container, arr(input.todos));
  }

  function emitTodos(container: Container, todos: unknown[]): void {
    const list: Todo[] = todos.filter(isRec).map((t, i) => ({
      id: str(t.id) ?? String(i + 1),
      content: str(t.content) ?? '',
      status: (['pending', 'in_progress', 'completed'].includes(str(t.status) ?? '') ? t.status : 'pending') as Todo['status'],
      priority: 'medium',
      ...(str(t.activeForm) ? { activeForm: str(t.activeForm) } : {}),
    }));
    emit({ type: 'todo.updated', properties: { sessionID: container.id, todos: list } });
  }

  // --- tool results ---------------------------------------------------------

  const contentToText = (content: unknown): string => {
    if (typeof content === 'string') return content;
    return arr(content)
      .map((block) => (isRec(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .filter((t) => t.length > 0)
      .join('\n');
  };

  const attachmentsFrom = (content: unknown, ref: ToolRef): FilePart[] => {
    const files: FilePart[] = [];
    for (const block of arr(content)) {
      if (!isRec(block)) continue;
      const file = fileFromBlock(block, ref.part.messageID, ref.container);
      if (file) files.push({ ...file, sessionID: ref.container.id });
    }
    return files;
  };

  /** Unwraps the "[Subagent hand-back] ... The report follows:" frame the harness puts around subagent results. */
  const extractSubagentReport = (text: string): string => {
    const marker = 'The report follows:\n';
    const at = text.indexOf(marker);
    if (!text.startsWith('[Subagent hand-back]') || at < 0) return text;
    let body = text.slice(at + marker.length);
    const trailer = body.search(/\nagentId: /);
    if (trailer >= 0) body = body.slice(0, trailer);
    return body
      .split('\n')
      .map((line) => (line.startsWith('  ') ? line.slice(2) : line))
      .join('\n')
      .trim();
  };

  const stripToolError = (text: string): string => text.replace(/^<tool_use_error>([\s\S]*)<\/tool_use_error>$/, '$1').trim();

  const truncate = (text: string): { text: string; truncated: boolean } =>
    text.length > maxOutput ? { text: text.slice(0, maxOutput), truncated: true } : { text, truncated: false };

  const buildMetadata = (ref: ToolRef, tur: unknown, input: Rec): Rec => {
    const tool = ref.part.tool;
    const result = isRec(tur) ? tur : undefined;
    const filePath = str(input.filePath) ?? '';
    switch (tool) {
      case 'edit': {
        const d = buildEditDiff(cwd, { filePath, oldString: str(input.oldString), newString: str(input.newString) }, tur);
        return { filePath, ...diffMetadata(d ? [d] : []) };
      }
      case 'write': {
        const d = buildWriteDiff(cwd, { filePath, content: str(input.content) }, tur);
        return { filePath, ...diffMetadata(d ? [d] : []) };
      }
      case 'multiedit': {
        const edits = arr(input.edits).filter(isRec).map((e) => ({ oldString: str(e.oldString), newString: str(e.newString) }));
        const d = buildMultiEditDiff(cwd, { filePath, edits }, tur);
        return { filePath, ...diffMetadata(d ? [d] : []) };
      }
      case 'read': {
        const file = isRec(result?.file) ? result.file : undefined;
        return {
          filePath,
          ...(num(file?.totalLines) !== undefined ? { totalLines: file!.totalLines } : {}),
          ...(num(file?.numLines) !== undefined ? { numLines: file!.numLines } : {}),
          ...(num(file?.startLine) !== undefined ? { startLine: file!.startLine } : {}),
        };
      }
      case 'bash': {
        const stderr = str(result?.stderr);
        return {
          command: str(input.command) ?? '',
          ...(str(input.description) ? { description: str(input.description) } : {}),
          ...(result?.interrupted === true ? { interrupted: true } : {}),
          ...(stderr ? { stderr } : {}),
          ...(str(result?.backgroundTaskId) ? { backgroundTaskId: result!.backgroundTaskId } : {}),
        };
      }
      case 'grep':
      case 'glob':
        return {
          ...(num(result?.numFiles) !== undefined ? { count: result!.numFiles } : {}),
          ...(result?.truncated === true ? { resultsTruncated: true } : {}),
          ...(str(result?.mode) ? { mode: result!.mode } : {}),
        };
      case 'todowrite':
        return { todos: arr(result?.newTodos ?? input.todos) };
      case 'question':
        return isRec(result?.answers) ? { answers: result.answers } : {};
      case 'plan_exit':
        return { plan: str(result?.plan) ?? str(input.plan) ?? '' };
      case 'task': {
        const meta: Rec = {};
        if (ref.childId) meta.sessionID = ref.childId;
        if (str(result?.status)) meta.status = result!.status;
        if (str(result?.agentId)) meta.agentId = result!.agentId;
        if (num(result?.totalDurationMs) !== undefined) meta.totalDurationMs = result!.totalDurationMs;
        if (num(result?.totalTokens) !== undefined) meta.totalTokens = result!.totalTokens;
        if (num(result?.totalToolUseCount) !== undefined) meta.totalToolUseCount = result!.totalToolUseCount;
        return meta;
      }
      default:
        return {};
    }
  };

  const failTool = (ref: ToolRef, error: string, metadata?: Rec): void => {
    if (ref.done) return;
    ref.done = true;
    const input = ref.part.state.input;
    const start = ref.startMs ?? ms();
    if (ref.meta.runStatus === 'running') ref.meta.runStatus = error === INTERRUPTED_MESSAGE ? 'stopped' : 'error';
    const merged = { ...(metadata ?? {}), ...ref.meta };
    ref.part.state = { status: 'error', input, error, ...(Object.keys(merged).length > 0 ? { metadata: merged } : {}), time: { start, end: ms() } };
    emitPart(ref.part);
    finishChildOf(ref);
  };

  const completeTool = (ref: ToolRef, output: string, tur: unknown, attachments: FilePart[] = []): void => {
    if (ref.done) return;
    ref.done = true;
    const input = ref.part.state.input;
    const start = ref.startMs ?? ms();
    if (isTaskTool(ref.part.claude.name)) {
      if (ref.meta.runStatus === undefined || ref.meta.runStatus === 'running') ref.meta.runStatus = 'completed';
      if (ref.meta.reply === undefined && output) ref.meta.reply = output;
    } else if (ref.part.tool === 'sendmessage') {
      // A continuation's run ends with its task_notification (async: after this result); without a tracked run the
      // tool result is all there is.
      const tracked = [...agents.values()].some((a) => [...a.runs.values()].includes(ref));
      if (ref.meta.runStatus === undefined || (ref.meta.runStatus === 'running' && !tracked)) ref.meta.runStatus = 'completed';
    }
    const metadata = { ...buildMetadata(ref, tur, input), ...ref.meta };
    const cut = truncate(output);
    if (cut.truncated) metadata.truncated = true;
    ref.part.state = {
      status: 'completed',
      input,
      output: cut.text,
      title: toolTitle(ref.part.tool, input, cwd),
      metadata,
      time: { start, end: ms() },
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    emitPart(ref.part);
    finishChildOf(ref);
    updateTaskTodos(ref, tur);
  };

  /** A finished `task` tool means its child session is idle. */
  function finishChildOf(ref: ToolRef): void {
    if (!ref.childId) return;
    const child = containers.get(ref.childId);
    if (!child) return;
    // With run tracking the child is idle when its last run ended (task_notification), not when a tool part completes.
    if (child.agentRec && child.agentRec.runs.size > 0 && !replay) return;
    finalizeContainer(child);
    setStatus(child, { type: 'idle' });
  }

  /** Merges keys into a subagent tool part's metadata (kept across state transitions) and announces it. */
  function updateSubMeta(ref: ToolRef, patch: Rec): void {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (JSON.stringify(ref.meta[key]) !== JSON.stringify(value)) {
        ref.meta[key] = value;
        changed = true;
      }
    }
    if (!changed) return;
    const state = ref.part.state;
    if (state.status === 'pending') return; // applied when it starts running
    state.metadata = { ...(state.metadata ?? {}), ...ref.meta };
    emitPart(ref.part);
  }

  /** Creates the user message that carries one instruction in a child session. */
  function createInstruction(child: Container, text: string, kind: 'initial' | 'followup', toolCallID: string, uuid?: string): InstructionRec {
    const parent = child.parentId ? containers.get(child.parentId) : undefined;
    const ownerRef = toolCallID ? tools.get(toolCallID) : undefined;
    const instruction: SubagentInstruction = {
      kind,
      index: child.instructions.length + 1,
      fromSessionID: child.parentId ?? sessionId,
      ...(ownerRef ? { fromMessageID: ownerRef.part.messageID } : {}),
      toolCallID,
      ...((parent?.agentRec?.agentType ?? agent) ? { fromAgent: parent?.agentRec?.agentType ?? agent } : {}),
    };
    createUserMessage(child, { content: text, uuid, agent: child.agentRec?.agentType, instruction });
    child.replied = false;
    const rec: InstructionRec = { message: lastUserMessage!, kind, text, linked: toolCallID !== '' };
    child.instructions.push(rec);
    return rec;
  }

  /** Starts a run on a child: instruction message, busy status, tool metadata. */
  function startRun(rec: AgentRec, runKey: string, ref: ToolRef, prompt: string | undefined, kind: 'initial' | 'followup', foreground = false): void {
    const child = containers.get(rec.childId);
    if (!child) return;
    rec.runs.set(runKey, ref);
    stoppedRuns.delete(runKey);
    if (foreground) foregroundRuns.add(runKey);
    else foregroundRuns.delete(runKey);
    setStatus(child, { type: 'busy' });
    if (prompt) {
      // One instruction per run: skip when this tool call already produced one (task_started seen twice).
      const exists = child.instructions.some((i) => i.message.instruction?.toolCallID === ref.part.callID);
      if (!exists) {
        const instr = createInstruction(child, prompt, kind, ref.part.callID);
        updateSubMeta(ref, { childMessageID: instr.message.id, message: prompt });
      }
    }
    updateSubMeta(ref, { runStatus: 'running', agentId: rec.agentId, ...(rec.agentType ? { agentType: rec.agentType } : {}), sessionID: rec.childId });
  }

  /**
   * Safety net for foreground runs: without `forwardSubagentText` (or when a run's text-only reply is not forwarded) the
   * reply exists only in task_notification.summary / the tool result. If nothing was forwarded since the latest
   * instruction, synthesize exactly one completed assistant message parented to that instruction.
   */
  function ensureChildReply(child: Container, runRef: ToolRef | undefined, text: string | undefined): void {
    if (replay || child.replied || !text || !text.trim()) return;
    child.replied = true;
    const instr = (runRef ? child.instructions.find((i) => i.message.instruction?.toolCallID === runRef.part.callID) : undefined) ?? child.instructions.at(-1);
    if (instr) child.lastUserMessageId = instr.message.id;
    const a = startAssistant(child, `reply:${nid()}`, undefined);
    a.message.finish = 'end_turn';
    const part = newTextRef(a, 'text', text);
    part.sealed = true;
    settleTextRef(part, text);
    finalizeAssistant(a);
  }

  /** Ends a run: tool metadata, child idle when it was the last one. */
  function endRun(rec: AgentRec, runKey: string, status: string | undefined, reply: string | undefined): void {
    const ref = rec.runs.get(runKey);
    rec.runs.delete(runKey);
    const runStatus = status === 'failed' ? 'error' : status === 'stopped' ? 'stopped' : 'completed';
    const finished: ToolRef[] = ref ? [ref] : [];
    // A SendMessage injected into a run that was already executing (no task_started of its own) ends with it.
    for (const [key, injected] of [...rec.runs]) {
      if (key.startsWith('inject:')) {
        rec.runs.delete(key);
        finished.push(injected);
      }
    }
    for (const r of finished) updateSubMeta(r, { runStatus, ...(reply !== undefined ? { reply } : {}) });
    const child = containers.get(rec.childId);
    if (child && runStatus === 'completed') ensureChildReply(child, ref, reply);
    if (child && rec.runs.size === 0) {
      finalizeContainer(child);
      setStatus(child, { type: 'idle' });
      if (child.info?.claude?.progress) setChildClaude(child, { progress: undefined });
    }
  }

  /**
   * Ends every run still tracked, as stopped: the CLI aborted the turn, so no `task_notification` will (reliably) come.
   * Tool parts that are still open become errors; the children go idle.
   */
  function stopRuns(reason: string): void {
    for (const rec of agents.values()) {
      const child = containers.get(rec.childId);
      for (const [key, ref] of [...rec.runs]) {
        rec.runs.delete(key);
        stoppedRuns.add(key);
        updateSubMeta(ref, { runStatus: 'stopped' });
        failTool(ref, reason);
      }
      if (!child) continue;
      finalizeContainer(child);
      setStatus(child, { type: 'idle' });
      if (child.info?.claude?.progress) setChildClaude(child, { progress: undefined });
    }
  }

  /** Links a SendMessage tool call to an agent (live fallback and replay post-pass). */
  function linkSendMessage(ref: ToolRef, rec: AgentRec, opts: { replayText?: string } = {}): void {
    const child = containers.get(rec.childId);
    if (!child) return;
    const input = ref.part.state.input;
    const text = str(input.message) ?? '';
    // Reuse the follow-up instruction created from the child transcript (replay), else create one (live).
    let instr = child.instructions.find((i) => i.kind === 'followup' && !i.linked && i.text === (opts.replayText ?? text));
    instr ??= child.instructions.find((i) => i.kind === 'followup' && !i.linked && replay);
    if (instr) {
      instr.linked = true;
      const instruction = instr.message.instruction!;
      instruction.toolCallID = ref.part.callID;
      instruction.fromMessageID = ref.part.messageID;
      emitMessage(instr.message);
    } else if (!replay && !child.instructions.some((i) => i.message.instruction?.toolCallID === ref.part.callID)) {
      instr = createInstruction(child, text, 'followup', ref.part.callID);
    }
    applyAlias(rec);
    updateSubMeta(ref, {
      sessionID: rec.childId,
      agentId: rec.agentId,
      ...(rec.agentType ? { agentType: rec.agentType } : {}),
      recipient: str(input.to) ?? '',
      message: text,
      ...(instr ? { childMessageID: instr.message.id } : {}),
    });
  }

  /** Task-v2 (`TaskCreate` / `TaskUpdate`) -> `todo.updated`, used when TodoWrite is not enabled. */
  function updateTaskTodos(ref: ToolRef, tur: unknown): void {
    const name = ref.part.claude.name;
    const container = ref.container;
    const result = isRec(tur) ? tur : undefined;
    const rawInput = isRec(ref.part.claude.input) ? ref.part.claude.input : {};
    if (isTaskCreateTool(name)) {
      const task = isRec(result?.task) ? result.task : undefined;
      const id = str(task?.id) ?? String(container.taskTodos.size + 1);
      container.taskTodos.set(id, {
        id,
        content: str(task?.subject) ?? str(rawInput.subject) ?? `Task ${id}`,
        status: 'pending',
        priority: 'medium',
        ...(str(rawInput.activeForm) ? { activeForm: str(rawInput.activeForm) } : {}),
      });
    } else if (isTaskUpdateTool(name)) {
      const id = str(rawInput.taskId) ?? str(result?.taskId);
      if (!id) return;
      const status = str(rawInput.status) ?? str(isRec(result?.statusChange) ? result.statusChange.to : undefined);
      if (status === 'deleted') {
        container.taskTodos.delete(id);
      } else {
        const prev = container.taskTodos.get(id) ?? { id, content: `Task ${id}`, status: 'pending' as const, priority: 'medium' as const };
        container.taskTodos.set(id, {
          ...prev,
          ...(str(rawInput.subject) ? { content: str(rawInput.subject)! } : {}),
          ...(str(rawInput.activeForm) ? { activeForm: str(rawInput.activeForm) } : {}),
          ...(status === 'pending' || status === 'in_progress' || status === 'completed' ? { status } : {}),
        });
      }
    } else {
      return;
    }
    const list = [...container.taskTodos.values()].sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
    emit({ type: 'todo.updated', properties: { sessionID: container.id, todos: list } });
  }

  const handleToolResult = (block: Rec, toolUseResult: unknown, resultUuid?: string): void => {
    const callId = str(block.tool_use_id);
    if (!callId) return;
    const ref = tools.get(callId);
    if (!ref) {
      warnOnce(`orphan-result`, 'tool_result without a known tool_use', { callId });
      return;
    }
    if (ref.done) return;
    // Transcript uuid of the entry carrying this result: a fork must include it so tool_use/tool_result are never split.
    if (resultUuid) ref.part.metadata = { ...(ref.part.metadata ?? {}), resultUuid };
    const rawText = contentToText(block.content);
    ref.resultText = rawText;
    const isError = block.is_error === true;

    if (isError) {
      const text = stripToolError(rawText);
      failTool(ref, INTERRUPT_TEXT.test(text) ? INTERRUPTED_MESSAGE : text || 'Tool failed');
      return;
    }

    const result = isRec(toolUseResult) ? toolUseResult : undefined;
    const asyncLaunch =
      isTaskTool(ref.part.claude.name) &&
      (result?.isAsync === true || result?.status === 'async_launched' || rawText.startsWith('Async agent launched successfully'));
    if (asyncLaunch) {
      // Background subagent: keep the tool running until its task_notification arrives.
      ref.async = true;
      const agentId = str(result?.agentId) ?? /agentId: (\S+)/.exec(rawText)?.[1];
      if (agentId) asyncTaskByAgent.set(agentId, ref);
      if (ref.part.state.status === 'running') {
        ref.part.state.metadata = { ...(ref.part.state.metadata ?? {}), async: true, ...(agentId ? { agentId } : {}) };
        emitPart(ref.part);
      }
      if (agentId) learnAgent(agentId, ref.part.callID);
      return;
    }

    const isTask = isTaskTool(ref.part.claude.name);
    if (isTask) {
      // The hand-back trailer ("agentId: X (use SendMessage ...)") is the only agent id in history.
      const trailer = /\nagentId: (\S+)/.exec(rawText)?.[1] ?? str(result?.agentId);
      if (trailer) learnAgent(trailer, ref.part.callID);
      const rec = ref.childId ? containers.get(ref.childId)?.agentRec : undefined;
      if (rec) applyAlias(rec);
    }
    let output = isTask ? extractSubagentReport(rawText) : rawText;
    if (isTask && ref.childId && !replay) {
      // Result before notification (or a run whose reply was never forwarded): the unwrapped hand-back is the reply.
      const child = containers.get(ref.childId);
      if (child) ensureChildReply(child, ref, output);
    }
    if (ref.part.tool === 'sendmessage') {
      const parsed = parseSendMessageResult(rawText, result);
      output = parsed.reply ?? parsed.message ?? rawText;
      if (parsed.reply !== undefined) {
        ref.meta.reply = parsed.reply;
        const sid = typeof ref.meta.sessionID === 'string' ? ref.meta.sessionID : undefined;
        const linked = sid ? containers.get(sid) : undefined;
        if (linked) ensureChildReply(linked, ref, parsed.reply);
      }
      // Live fallback: no task_started for this call (message injected into a running agent / hook-less variants).
      if (!ref.meta.sessionID && !replay) {
        const target = findAgentForSendMessage(ref, parsed.agentId);
        if (target) {
          linkSendMessage(ref, target);
          // Injected into a run that is still executing: it ends with that run.
          if (!replay && target.runs.size > 0) {
            target.runs.set(`inject:${ref.part.callID}`, ref);
            updateSubMeta(ref, { runStatus: 'running' });
          } else updateSubMeta(ref, { runStatus: 'completed' });
        }
      }
    }
    completeTool(ref, output, toolUseResult, attachmentsFrom(block.content, ref));
  };

  /** Registers an agent id learned from a result text/structure; the owner's child must already exist. */
  function learnAgent(agentId: string, ownerToolUseId: string): void {
    if (agents.has(agentId)) return;
    const child = containers.get(childSessionId(ownerToolUseId));
    if (!child) return;
    attachAgent(child, agentId, ownerToolUseId, undefined);
  }

  /** `{"success":true,"message":..., "resumedAgentId":...}` JSON (async) or JSON + hand-back frame (sync). */
  function parseSendMessageResult(rawText: string, structured: Rec | undefined): { agentId?: string; message?: string; reply?: string } {
    const firstLine = rawText.split('\n', 1)[0] ?? '';
    let json: Rec | undefined;
    try {
      const parsed = JSON.parse(firstLine);
      if (isRec(parsed)) json = parsed;
    } catch {
      /* plain text result */
    }
    const frame = extractSubagentReport(rawText.slice(firstLine.length + 1).trim() || rawText);
    const hasFrame = rawText.includes('[Subagent hand-back]');
    const inline = isRec(structured?.inlineHandback) ? structured.inlineHandback : undefined;
    const inlineText = Array.isArray(inline?.content) ? contentToText(inline.content) : undefined;
    return {
      agentId: str(json?.resumedAgentId) ?? str(isRec(structured?.pin) ? structured.pin.id : undefined),
      message: str(json?.message),
      reply: hasFrame ? frame : inlineText,
    };
  }

  /** Resolves which agent a SendMessage targets: raw id, `resumedAgentId`, plugin alias. */
  function findAgentForSendMessage(ref: ToolRef, resumedAgentId: string | undefined): AgentRec | undefined {
    const to = str(ref.part.state.input.to) ?? '';
    return (
      (to ? agents.get(to) : undefined) ??
      (resumedAgentId ? agents.get(resumedAgentId) : undefined) ??
      (() => {
        const id = to ? options.aliases?.resolve(to) : undefined;
        return id ? agents.get(id) : undefined;
      })() ??
      [...agents.values()].find((a) => a.alias === to)
    );
  }

  const completeAsyncTask = (toolUseId: string | undefined, status: string | undefined, text: string | undefined): void => {
    if (!toolUseId) return;
    const ref = tools.get(toolUseId);
    if (!ref) return;
    if (ref.part.tool === 'sendmessage') {
      // A continuation's reply arrives after (async) or before (sync) the SendMessage result: metadata only.
      updateSubMeta(ref, { runStatus: status === 'failed' ? 'error' : status === 'stopped' ? 'stopped' : 'completed', ...(text !== undefined ? { reply: text } : {}) });
      return;
    }
    if (ref.done) return;
    updateSubMeta(ref, { runStatus: status === 'failed' ? 'error' : status === 'stopped' ? 'stopped' : 'completed', ...(text !== undefined ? { reply: text } : {}) });
    if (status === 'failed' || status === 'stopped') failTool(ref, text || `Subagent ${status}`);
    else completeTool(ref, text ?? '', undefined);
  };

  // --- SDK message handlers -------------------------------------------------

  const ensureAssistant = (container: Container, apiId: string, apiModel: string | undefined): AsstState => {
    const existing = asstByApi.get(apiId);
    if (existing && existing.container === container) return existing;
    return startAssistant(container, apiId, apiModel);
  };

  const handleStreamEvent = (msg: Rec): void => {
    const event = isRec(msg.event) ? msg.event : undefined;
    if (!event) return;
    const container = containerForParent(msg.parent_tool_use_id);
    const type = str(event.type);

    if (type === 'message_start') {
      const m = isRec(event.message) ? event.message : {};
      const apiId = str(m.id) ?? str(msg.api_message_id) ?? nid();
      if (container === main) setStatus(main, { type: 'busy' });
      if (asstByApi.has(apiId)) return;
      const a = startAssistant(container, apiId, str(m.model));
      applyUsage(a, m.usage);
      return;
    }

    const apiId = str(msg.api_message_id);
    const a = (apiId ? asstByApi.get(apiId) : undefined) ?? container.lastAssistant;
    if (!a) return;

    switch (type) {
      case 'content_block_start': {
        const index = num(event.index);
        const block = isRec(event.content_block) ? event.content_block : {};
        if (index === undefined) return;
        const btype = str(block.type);
        if (btype === 'text') a.blocks.set(index, { kind: 'text', ref: newTextRef(a, 'text', str(block.text) ?? '') });
        else if (btype === 'thinking') a.blocks.set(index, { kind: 'thinking', ref: newTextRef(a, 'thinking', str(block.thinking) ?? '') });
        else if (btype === 'tool_use') {
          const id = str(block.id);
          if (!id) return;
          const ref = registerTool(a, id, str(block.name) ?? 'unknown', undefined, false);
          a.blocks.set(index, { kind: 'tool', tool: ref });
        } else a.blocks.set(index, { kind: 'other' });
        return;
      }
      case 'content_block_delta': {
        const index = num(event.index);
        const delta = isRec(event.delta) ? event.delta : {};
        const block = index === undefined ? undefined : a.blocks.get(index);
        if (!block) return;
        const dtype = str(delta.type);
        if (block.kind === 'tool') {
          if (dtype === 'input_json_delta') block.tool.json += str(delta.partial_json) ?? '';
          return;
        }
        if (block.kind === 'other' || block.ref.sealed) return;
        const field = dtype === 'text_delta' ? str(delta.text) : dtype === 'thinking_delta' ? str(delta.thinking) : undefined;
        if (!field) return;
        block.ref.acc += field;
        emit({
          type: 'message.part.delta',
          properties: { sessionID: a.container.id, messageID: a.message.id, partID: block.ref.part.id, field: 'text', delta: field },
        });
        return;
      }
      case 'content_block_stop': {
        const index = num(event.index);
        const block = index === undefined ? undefined : a.blocks.get(index);
        if (!block || block.kind === 'other') return;
        if (block.kind === 'tool') {
          if (block.tool.part.state.status !== 'pending') return;
          try {
            markRunning(block.tool, block.tool.json.trim() ? JSON.parse(block.tool.json) : {});
          } catch {
            log('debug', 'tool input JSON incomplete at content_block_stop; waiting for the assistant message', { id: block.tool.part.callID });
          }
          return;
        }
        // Text/thinking: emit the settled part (final text + end time) once.
        block.ref.part.text = block.ref.acc;
        if (block.ref.part.time) block.ref.part.time.end ??= ms();
        emitPart(block.ref.part);
        return;
      }
      case 'message_delta': {
        const delta = isRec(event.delta) ? event.delta : {};
        const stop = str(delta.stop_reason);
        if (stop) a.message.finish = stop;
        applyUsage(a, event.usage);
        return;
      }
      case 'message_stop':
        finalizeAssistant(a);
        return;
      default:
        return;
    }
  };

  const handleAssistant = (msg: Rec): void => {
    const uuid = str(msg.uuid);
    const container = containerForParent(msg.parent_tool_use_id);
    if (uuid) {
      if (container.seenUuids.has(uuid)) return;
      container.seenUuids.add(uuid);
    }
    const m = isRec(msg.message) ? msg.message : undefined;
    if (!m) return;
    if (container !== main) noteAgentFrom(msg);
    const apiId = str(m.id) ?? uuid ?? nid();
    if (container === main) setStatus(main, { type: 'busy' });
    const a = ensureAssistant(container, apiId, str(m.model));
    a.lastTs = curTs ?? a.lastTs;
    if (uuid) a.message.claudeUuid = uuid;
    applyUsage(a, m.usage);
    const stop = str(m.stop_reason);
    if (stop) a.message.finish = stop;

    const errorName = str(msg.error);
    const content = arr(m.content);
    if (errorName) {
      const text = content.map((b) => (isRec(b) && typeof b.text === 'string' ? b.text : '')).join('').trim();
      a.message.error = { name: errorName, message: text || errorName, data: { message: text || errorName } };
      emitMessage(a.message);
    }

    for (const raw of content) {
      if (!isRec(raw)) continue;
      switch (raw.type) {
        case 'text':
        case 'thinking': {
          const kind = raw.type === 'text' ? 'text' : 'thinking';
          const text = (kind === 'text' ? str(raw.text) : str(raw.thinking)) ?? '';
          if (kind === 'text' && text.trim() && container !== main) container.replied = true;
          const ordinal = a.seen[kind]++;
          const ref = a.streamed[kind][ordinal];
          if (ref) {
            ref.sealed = true;
            if (ref.acc !== text && text !== '') settleTextRef(ref, text);
            else if (ref.acc !== text) ref.sealed = true; // empty final text (omitted thinking): keep streamed content
          } else {
            const created = newTextRef(a, kind, text);
            created.sealed = true;
            settleTextRef(created, text);
          }
          break;
        }
        case 'tool_use': {
          const id = str(raw.id);
          if (!id) break;
          const ref = registerTool(a, id, str(raw.name) ?? 'unknown', raw.input, false);
          markRunning(ref, raw.input);
          break;
        }
        default:
          log('debug', `ignoring assistant content block type ${String(raw.type)}`);
      }
    }
  };

  const userTextOf = (content: unknown): string | undefined => {
    if (typeof content === 'string') return content;
    const texts = arr(content).filter((b): b is Rec => isRec(b) && b.type === 'text' && typeof b.text === 'string');
    return texts.length > 0 ? texts.map((b) => b.text as string).join('\n') : undefined;
  };

  /** "The coordinator sent a message while you were working:\n<text>\n\nAddress this before ..." -> <text>. */
  const unwrapInstructionFrame = (text: string): string | undefined => {
    const m = /^The coordinator sent a message while you were working:\n([\s\S]*?)\n+Address this before completing your current task\.?\s*$/.exec(text);
    return m ? m[1]!.trim() : undefined;
  };

  /** Subagent messages carry `agent_id`; it identifies the instance even without a task_started. */
  const noteAgentFrom = (msg: Rec): void => {
    const agentId = str(msg.agent_id);
    const parent = str(msg.parent_tool_use_id);
    if (agentId && parent) learnAgent(agentId, parent);
  };

  const parseTaskNotification = (text: string): { toolUseId?: string; status?: string; result?: string } | undefined => {
    if (!text.startsWith('<task-notification>')) return undefined;
    const tag = (name: string): string | undefined => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
    return { toolUseId: tag('tool-use-id'), status: tag('status'), result: tag('result') ?? tag('summary') };
  };

  const handleUser = (msg: Rec): void => {
    const m = isRec(msg.message) ? msg.message : undefined;
    if (!m) return;
    const content = m.content;
    const blocks = arr(content);
    const hasToolResult = blocks.some((b) => isRec(b) && b.type === 'tool_result');
    const parent = str(msg.parent_tool_use_id);
    const container = containerForParent(parent);
    const uuid = str(msg.uuid);

    if (hasToolResult) {
      for (const block of blocks) if (isRec(block) && block.type === 'tool_result') handleToolResult(block, msg.tool_use_result, uuid);
      return;
    }

    const text = userTextOf(content);
    if (parent) {
      noteAgentFrom(msg);
      if (text) {
        const instructionText = unwrapInstructionFrame(text) ?? text;
        if (replay) {
          // History: every user entry of a subagent transcript is one instruction (the first is the Agent prompt, the
          // rest are SendMessage follow-ups; their tool call is linked in the post-pass).
          const initial = container.instructions.length === 0;
          const instr = createInstruction(container, instructionText, initial ? 'initial' : 'followup', initial ? parent : '', uuid);
          const owner = initial ? tools.get(parent) : undefined;
          if (owner) updateSubMeta(owner, { childMessageID: instr.message.id, message: instructionText });
        } else if (container.instructions.length === 0) {
          // Live fallback: an echoed prompt without a task_started (the normal path creates it from task_started.prompt).
          const instr = createInstruction(container, instructionText, 'initial', parent, uuid);
          const owner = tools.get(parent);
          if (owner) updateSubMeta(owner, { childMessageID: instr.message.id });
        }
      }
      return;
    }

    if (!replay) return; // Live prompts are emitted by the host (startUserMessage); everything else here is noise.

    if (msg.isCompactSummary === true || msg.is_meta === true || msg.isSynthetic === true) {
      if (msg.isCompactSummary === true) emitCompacted(uuid);
      return;
    }
    if (text === undefined) {
      // Attachment-only prompt (images/documents).
      createUserMessage(container, { content: blocks, uuid });
      return;
    }
    const notification = parseTaskNotification(text);
    if (notification) {
      completeAsyncTask(notification.toolUseId, notification.status, notification.result);
      return;
    }
    if (text.startsWith('[Request interrupted by user') || text.startsWith('<local-command-stdout>')) return;
    const command = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
    if (command) {
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
      createUserMessage(container, { content: `${command[1]!.trim()}${args ? ` ${args}` : ''}`, uuid });
      return;
    }
    createUserMessage(container, { content: typeof content === 'string' ? content : blocks, uuid });
  };

  /** Synthetic assistant text (compaction marker, hook notices): own message, completed immediately. */
  function emitNotice(text: string, level?: string, uuid?: string): void {
    const a = startAssistant(main, `notice:${nid()}`, undefined);
    // The transcript entry behind the notice (replayed compaction summary) makes it a valid cut point for fork / revert.
    if (uuid) a.message.claudeUuid = uuid;
    const ref = newTextRef(a, 'text', text);
    const part = ref.part as TextPart;
    part.synthetic = true;
    if (level) part.metadata = { level };
    ref.sealed = true;
    settleTextRef(ref, text);
    finalizeAssistant(a);
  }

  const emitCompacted = (uuid?: string): void => emitNotice(SYNTHETIC_COMPACT_TEXT, undefined, uuid);

  const abortOpenTools = (reason: string, includeAsync: boolean): void => {
    for (const ref of tools.values()) {
      if (ref.done) continue;
      if (ref.async && !includeAsync) continue;
      failTool(ref, reason);
    }
  };

  const handleResult = (msg: Rec): void => {
    for (const c of containers.values()) finalizeContainer(c);
    const subtype = str(msg.subtype);
    const isError = msg.is_error === true || (subtype !== undefined && subtype !== 'success');
    const terminal = str(msg.terminal_reason);
    const aborted = (terminal !== undefined && terminal.startsWith('aborted')) || (stopRequested && isError && subtype === 'error_during_execution');

    const last = main.lastAssistant;
    if (last) {
      const total = num(msg.total_cost_usd);
      if (total !== undefined) {
        // A turn that ended without a new main assistant message (e.g. an aborted one) must not overwrite the cost an
        // earlier turn's message already carries: only the current turn's own assistant gets the delta, added up.
        const delta = Math.max(0, total - costSeen);
        if (delta > 0 && last.message.parentID === main.lastUserMessageId) last.message.cost = (last.message.cost ?? 0) + delta;
        costSeen = Math.max(costSeen, total);
      }
      emitMessage(last.message);
    }

    if (isError) {
      // An abort also kills background subagents, so their tool parts end too.
      abortOpenTools(aborted ? INTERRUPTED_MESSAGE : 'Tool did not complete', aborted);
      if (aborted) stopRuns(INTERRUPTED_MESSAGE);
      if (!aborted) {
        const errors = arr(msg.errors).filter((e): e is string => typeof e === 'string');
        const resultText = str(msg.result) ?? errors.join('; ');
        const name = last?.message.error?.name ?? terminal ?? subtype ?? 'error';
        const message = resultText || last?.message.error?.message || name;
        emit({
          type: 'session.error',
          properties: { sessionID: sessionId, error: { name, message, kind: classifyError(last?.message.error?.name, message) } },
        });
      }
    }
    for (const c of containers.values()) {
      if (c === main) continue;
      // Children with a run in progress stay busy: their end is task_notification, not the parent's `result`.
      if (c.agentRec) {
        if (c.agentRec.runs.size > 0) continue;
      } else {
        const ref = c.spawnedBy ? tools.get(c.spawnedBy) : undefined;
        if (ref && !ref.done) continue;
      }
      setStatus(c, { type: 'idle' });
    }
    if (aborted) stopRequested = false;
    setStatus(main, { type: 'idle' });
  };

  const handleSystem = (msg: Rec): void => {
    const subtype = str(msg.subtype);
    switch (subtype) {
      case 'init': {
        const init: InitInfo = {
          sessionId: str(msg.session_id) ?? '',
          model: str(msg.model) ?? model,
          permissionMode: (KNOWN_MODES.includes(str(msg.permissionMode) ?? '') ? msg.permissionMode : mode) as PermissionMode,
          slashCommands: arr(msg.slash_commands).filter((c): c is string => typeof c === 'string'),
          tools: arr(msg.tools).filter((c): c is string => typeof c === 'string'),
          agents: arr(msg.agents).filter((c): c is string => typeof c === 'string'),
          skills: arr(msg.skills).filter((c): c is string => typeof c === 'string'),
          claudeCodeVersion: str(msg.claude_code_version) ?? '',
        };
        if (init.sessionId && init.sessionId !== sessionId) {
          log('warn', 'system/init session_id differs from the mapper session id', { expected: sessionId, got: init.sessionId });
        }
        if (init.model) model = init.model;
        mode = init.permissionMode;
        hooks?.onInit?.(init);
        return;
      }
      case 'status': {
        const status = msg.status;
        if (status === 'requesting' || status === 'compacting') setStatus(main, { type: 'busy' });
        const pm = str(msg.permissionMode);
        if (pm && KNOWN_MODES.includes(pm)) {
          mode = pm as PermissionMode;
          hooks?.onModeChanged?.(mode);
        }
        if (msg.compact_result === 'failed') log('warn', 'compaction failed', { error: msg.compact_error });
        return;
      }
      case 'compact_boundary':
        if (!replay) emitCompacted();
        return;
      case 'api_retry': {
        const attempt = num(msg.attempt) ?? 1;
        const delay = num(msg.retry_delay_ms) ?? 0;
        setStatus(main, { type: 'retry', attempt, message: str(msg.error) ?? 'API error', next: nowFn() + delay });
        return;
      }
      case 'permission_denied': {
        const ref = tools.get(str(msg.tool_use_id) ?? '');
        if (ref) failTool(ref, 'Permission denied');
        return;
      }
      case 'task_started': {
        const toolUseId = str(msg.tool_use_id);
        const agentId = str(msg.task_id);
        const ref = toolUseId ? tools.get(toolUseId) : undefined;
        if (!ref || !toolUseId || !agentId) return;
        const runKey = str(msg.run_id) ?? toolUseId;
        if (isTaskTool(ref.part.claude.name)) {
          const child = containers.get(childSessionId(toolUseId)) ?? createChild(toolUseId, ref.container, str(msg.description));
          const rec = attachAgent(child, agentId, toolUseId, str(msg.subagent_type));
          startRun(rec, runKey, ref, str(msg.prompt) ?? str(ref.part.state.input.prompt), 'initial', msg.is_backgrounded === false);
        } else if (ref.part.tool === 'sendmessage') {
          // A continuation of an existing agent: same task_id, new run_id, the sent message as `prompt`.
          const rec = agents.get(agentId);
          if (!rec) {
            log('debug', 'task_started for SendMessage with an unknown agent', { agentId });
            return;
          }
          startRun(rec, runKey, ref, str(msg.prompt) ?? str(ref.part.state.input.message), 'followup', msg.is_backgrounded === false);
          linkSendMessage(ref, rec);
        }
        return;
      }
      case 'task_progress': {
        const rec = agents.get(str(msg.task_id) ?? '');
        const child = rec ? containers.get(rec.childId) : undefined;
        if (!child) return;
        const usage = isRec(msg.usage) ? msg.usage : {};
        setChildClaude(
          child,
          {
            progress: {
              ...(num(usage.tool_uses) !== undefined ? { toolUses: usage.tool_uses } : {}),
              ...(num(usage.total_tokens) !== undefined ? { totalTokens: usage.total_tokens } : {}),
              ...(num(usage.duration_ms) !== undefined ? { durationMs: usage.duration_ms } : {}),
              ...(str(msg.last_tool_name) ? { lastToolName: str(msg.last_tool_name) } : {}),
              ...((str(msg.summary) ?? str(msg.description)) ? { description: str(msg.summary) ?? str(msg.description) } : {}),
            },
          },
          false,
        );
        // ~1 Hz: the latest value is kept, the announcement is throttled.
        const now = nowFn();
        if (now - child.lastProgressEmit >= PROGRESS_THROTTLE_MS) {
          child.lastProgressEmit = now;
          emitChildInfo(child);
        }
        return;
      }
      case 'task_notification': {
        const toolUseId = str(msg.tool_use_id);
        let status = str(msg.status);
        let summary = str(msg.summary);
        const ref = toolUseId ? tools.get(toolUseId) : undefined;
        const rec = agents.get(str(msg.task_id) ?? '');
        const runKey = str(msg.run_id) ?? toolUseId ?? '';
        // Already ended by an aborted turn: a late notification must not flip the card back to "done".
        if (stoppedRuns.delete(runKey)) return;
        // The CLI reports `completed` for a foreground run its abort cut short.
        if (stopRequested && status === 'completed' && foregroundRuns.has(runKey)) {
          status = 'stopped';
          summary = INTERRUPTED_MESSAGE;
        }
        foregroundRuns.delete(runKey);
        if (ref && isTaskTool(ref.part.claude.name) && !ref.done) completeAsyncTask(toolUseId, status, summary);
        if (rec) endRun(rec, runKey, status, summary);
        else if (ref && ref.part.tool === 'sendmessage') completeAsyncTask(toolUseId, status, summary);
        return;
      }
      case 'commands_changed': {
        const commands = arr(msg.commands)
          .filter(isRec)
          .map((c): SlashCommand => ({
            name: str(c.name) ?? '',
            description: str(c.description) ?? '',
            argumentHint: str(c.argumentHint) ?? '',
            ...(Array.isArray(c.aliases) ? { aliases: c.aliases.filter((x): x is string => typeof x === 'string') } : {}),
            ...(c.builtin === true ? { builtin: true } : {}),
          }))
          .filter((c) => c.name);
        hooks?.onCommandsChanged?.(commands);
        return;
      }
      case 'informational': {
        // e.g. a UserPromptSubmit hook answering `decision: block` ("UserPromptSubmit operation blocked by hook: ...").
        const text = str(msg.content);
        const hookBlock = text !== undefined ? /^UserPromptSubmit operation blocked by hook:\n([\s\S]*?)(?:\n\nOriginal prompt:[\s\S]*)?$/.exec(text) : null;
        if (hookBlock && !replay) {
          // Surfaced as a dismissible notice by the UI (kind 'hook'); no synthetic assistant message, so nothing shows twice.
          emit({ type: 'session.error', properties: { sessionID: sessionId, error: { name: 'HookBlocked', message: hookBlock[1]!.trim(), kind: 'hook' } } });
        } else if (text && !str(msg.tool_use_id)) emitNotice(text, str(msg.level));
        else log('debug', 'informational message without text or tied to a tool ignored', { tag: msg.tag });
        return;
      }
      // Known, intentionally ignored.
      case 'task_updated': {
        const rec = agents.get(str(msg.task_id) ?? '');
        const patch = isRec(msg.patch) ? msg.patch : {};
        if (!rec) return;
        const runId = str(msg.run_id);
        if (patch.is_backgrounded === true && runId) foregroundRuns.delete(runId);
        const status = str(patch.status);
        if (status === 'killed' || status === 'failed') {
          // Without a run id the update concerns whatever the agent is running.
          const keys = runId ? (rec.runs.has(runId) ? [runId] : []) : [...rec.runs.keys()];
          for (const key of keys) {
            const ref = rec.runs.get(key);
            endRun(rec, key, status === 'killed' ? 'stopped' : 'failed', undefined);
            // A background Agent's tool part is otherwise left running; a late task_notification must not revive it.
            if (ref && isTaskTool(ref.part.claude.name) && !ref.done) failTool(ref, status === 'killed' ? INTERRUPTED_MESSAGE : 'Subagent failed');
            stoppedRuns.add(key);
          }
        }
        return;
      }
      case 'thinking_tokens':
      case 'background_tasks_changed':
      case 'hook_started':
      case 'hook_progress':
      case 'hook_response':
      case 'files_persisted':
      case 'session_state_changed':
      case 'notification':
      case 'local_command_output':
      case 'plugin_install':
      case 'memory_recall':
      case 'elicitation_complete':
      case 'control_request_progress':
        return;
      default:
        warnOnce(`system/${subtype}`, `unhandled system message subtype ${String(subtype)}`);
    }
  };

  const handleToolProgress = (msg: Rec): void => {
    const ref = tools.get(str(msg.tool_use_id) ?? '');
    const elapsed = num(msg.elapsed_time_seconds);
    if (!ref || ref.done || elapsed === undefined || ref.part.state.status !== 'running') return;
    const whole = Math.floor(elapsed);
    if (ref.part.state.metadata?.elapsed === whole) return;
    ref.part.state.metadata = { ...(ref.part.state.metadata ?? {}), elapsed: whole };
    emitPart(ref.part);
  };

  const handleRateLimit = (msg: Rec): void => {
    const info = isRec(msg.rate_limit_info) ? msg.rate_limit_info : undefined;
    if (info && !replay) hooks?.onRateLimit?.(info);
    if (info?.status !== 'rejected') return;
    const resetsAt = num(info.resetsAt);
    setStatus(main, { type: 'retry', attempt: 0, message: 'Rate limited', next: resetsAt !== undefined ? resetsAt * 1000 : nowFn() });
  };

  // --- entry points ---------------------------------------------------------

  const apply = (input: unknown): ClaudeEvent[] => {
    out = [];
    try {
      if (!isRec(input)) return out;
      const ts = replay ? Date.parse(str(input.timestamp) ?? '') : Number.NaN;
      curTs = Number.isFinite(ts) ? ts : undefined;
      switch (input.type) {
        case 'stream_event':
          handleStreamEvent(input);
          break;
        case 'assistant':
          handleAssistant(input);
          break;
        case 'user':
          handleUser(input);
          break;
        case 'result':
          handleResult(input);
          break;
        case 'system':
          handleSystem(input);
          break;
        case 'tool_progress':
          handleToolProgress(input);
          break;
        case 'rate_limit_event':
          handleRateLimit(input);
          break;
        case 'command_lifecycle':
          if (input.state === 'started') setStatus(main, { type: 'busy' });
          break;
        case 'tool_use_summary':
        case 'prompt_suggestion':
        case 'auth_status':
        case 'conversation_reset':
        case 'active_goal':
        case 'keep_alive':
          break;
        default:
          warnOnce(`type/${String(input.type)}`, `unhandled message type ${String(input.type)}`);
      }
    } catch (error) {
      log('warn', 'mapper error while applying a message (ignored)', { error: error instanceof Error ? error.message : String(error), type: isRec(input) ? input.type : undefined });
    }
    const result = out;
    out = [];
    return result;
  };

  const startUserMessage = (input: UserMessageInput): { messageId: string; events: ClaudeEvent[] } => {
    out = [];
    curTs = undefined;
    stopRequested = false;
    const messageId = createUserMessage(main, input);
    setStatus(main, { type: 'busy' });
    const events = out;
    out = [];
    return { messageId, events };
  };

  /** Replay post-pass: link SendMessage parts to their agents (see docs/PHASE1_1_*). */
  const linkReplaySendMessages = (): void => {
    for (const ref of tools.values()) {
      if (ref.part.tool !== 'sendmessage' || ref.meta.sessionID) continue;
      const parsed = ref.resultText ? parseSendMessageResult(ref.resultText, undefined) : {};
      let rec = findAgentForSendMessage(ref, parsed.agentId);
      if (!rec) {
        // Last resort: the message text matches an unlinked follow-up instruction of exactly one agent.
        const text = str(ref.part.state.input.message) ?? '';
        const hits = [...agents.values()].filter((a) => containers.get(a.childId)?.instructions.some((i) => i.kind === 'followup' && !i.linked && i.text === text));
        if (hits.length >= 1) rec = hits[0];
      }
      if (rec) linkSendMessage(ref, rec);
    }
    for (const rec of agents.values()) applyAlias(rec);
  };

  /**
   * Seeds a fresh mapper (respawn after idle close / LRU / agent switch) from the session's current state: child
   * containers with their last message ids and instruction counters, and the agentId registry, so a later
   * SendMessage links to the existing child instead of an "unknown agent" and no `session.created` is repeated.
   */
  const seed = (state: SessionState): void => {
    for (const [id, bucket] of state.sessions) {
      if (id === sessionId || containers.has(id) || !bucket.info) continue;
      const child = makeContainer(id, bucket.info.parentID ?? sessionId);
      child.info = structuredClone(bucket.info);
      child.spawnedBy = id.replace(/^sub_/, '');
      child.status = { type: 'idle' };
      const messages = bucket.messages;
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      child.lastUserMessageId = lastUser?.id;
      child.replied = messages.at(-1)?.role !== 'user';
      for (const m of messages) {
        if (m.role !== 'user' || !m.instruction) continue;
        const text = (bucket.parts[m.id] ?? []).flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('');
        child.instructions.push({ message: structuredClone(m), kind: m.instruction.kind, text, linked: m.instruction.toolCallID !== '' });
      }
      const claude = bucket.info.claude;
      if (claude?.agentId) {
        const rec: AgentRec = { agentId: claude.agentId, childId: id, ownerToolUseId: child.spawnedBy, agentType: claude.agentType, alias: claude.alias, runs: new Map() };
        agents.set(claude.agentId, rec);
        child.agentRec = rec;
      }
    }
  };

  const registerAgent = (agentId: string, ownerToolUseId: string): void => {
    pendingAgentIndex.set(ownerToolUseId, agentId);
    const child = containers.get(childSessionId(ownerToolUseId));
    if (child && !child.agentRec) attachAgent(child, agentId, ownerToolUseId, undefined);
  };

  const finish = (reason: 'ended' | 'interrupted' | 'error', message?: string): ClaudeEvent[] => {
    out = [];
    curTs = undefined;
    if (replay) linkReplaySendMessages();
    for (const rec of agents.values()) rec.runs.clear();
    for (const c of containers.values()) finalizeContainer(c);
    const text = message ?? (reason === 'interrupted' ? INTERRUPTED_MESSAGE : 'Session ended');
    abortOpenTools(text, true);
    for (const c of containers.values()) setStatus(c, { type: 'idle' });
    const events = out;
    out = [];
    return events;
  };

  const configure = (settings: { model?: string; mode?: PermissionMode; agent?: string; effort?: EffortLevel | null }): void => {
    if (settings.effort !== undefined) effort = settings.effort;
    if (settings.model !== undefined) model = settings.model;
    if (settings.mode !== undefined) mode = settings.mode;
    if (settings.agent !== undefined) agent = settings.agent;
  };

  const markStopRequested = (): void => {
    stopRequested = true;
  };

  const runningTasks = (): Array<{ taskId: string; runId: string; toolUseId: string; childId: string }> =>
    [...agents.values()].flatMap((rec) => [...rec.runs].map(([runId, ref]) => ({ taskId: rec.agentId, runId, toolUseId: ref.part.callID, childId: rec.childId })));

  return {
    apply,
    startUserMessage,
    finish,
    configure,
    registerAgent,
    seed,
    markStopRequested,
    runningTasks,
    info: {
      get agent() {
        return agent;
      },
      get model() {
        return model;
      },
      get mode() {
        return mode;
      },
      get lastUserMessageId() {
        return main.lastUserMessageId;
      },
      get childSessionIds() {
        return [...containers.keys()].filter((id) => id !== sessionId);
      },
    },
  };
}

/** Re-exports for consumers that only need the helpers. */
export { toRelativePath };
export type { FileDiff };
