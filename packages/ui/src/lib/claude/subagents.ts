/**
 * Pure helpers for subagent visibility (docs/PHASE1_1_UI_SPEC.md section 1): `Agent` (`task`) and
 * `SendMessage` (`sendmessage`) tool parts, their child sessions, grouping and status derivation.
 *
 * No React, no stores: everything here is unit-tested in `subagents.test.ts`. The React hook that
 * feeds these helpers from the sync store lives in `useSubagentInfo.ts`.
 *
 * Data contract: `Session.claude.{agentId,agentType,alias,progress}`, `UserMessage.instruction`,
 * and the `SubagentToolMetadata` keys on the tool part `state.metadata` (see `types.ts`). Every
 * field is optional; the helpers degrade as described in the spec (section 0).
 */

import type { Message, Part, SubagentInstruction, SubagentToolMetadata, ToolPart } from './types';

// ---------------------------------------------------------------------------
// Tool identification
// ---------------------------------------------------------------------------

export type SubagentKind = 'agent' | 'message';

/** `task` / `agent` -> agent spawn, `sendmessage` -> follow-up message; anything else is not a subagent tool. */
export const getSubagentKind = (tool: unknown): SubagentKind | null => {
  if (typeof tool !== 'string') return null;
  const name = tool.trim().toLowerCase();
  if (name === 'task' || name === 'agent') return 'agent';
  if (name === 'sendmessage') return 'message';
  return null;
};

export const isSubagentTool = (tool: unknown): boolean => getSubagentKind(tool) !== null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Tool parts whose `state.metadata.hidden === true` must not render (e.g. the `ToolSearch select:SendMessage`
 * noise row). Part-level `metadata.hidden` is honoured as well.
 */
export const isHiddenToolPart = (part: unknown): boolean => {
  if (!isRecord(part) || part.type !== 'tool') return false;
  const state = isRecord(part.state) ? part.state : undefined;
  return [state?.metadata, part.metadata].some((metadata) => isRecord(metadata) && metadata.hidden === true);
};

const asString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

// ---------------------------------------------------------------------------
// Reading the tool part
// ---------------------------------------------------------------------------

export type SubagentRunStatus = NonNullable<SubagentToolMetadata['runStatus']>;

export type SubagentLink = {
  sessionId?: string;
  agentId?: string;
  agentType?: string;
  recipient?: string;
  message?: string;
  childMessageId?: string;
  reply?: string;
  runStatus?: SubagentRunStatus;
};

const RUN_STATUSES: readonly string[] = ['running', 'completed', 'error', 'stopped'];

/** Reads the `SubagentToolMetadata` keys from `state.metadata` (part-level `metadata` as a fallback). */
export const readSubagentLink = (part: Pick<ToolPart, 'state'> & { metadata?: unknown }): SubagentLink => {
  const stateMetadata = isRecord((part.state as { metadata?: unknown }).metadata)
    ? ((part.state as { metadata?: unknown }).metadata as Record<string, unknown>)
    : {};
  const partMetadata = isRecord(part.metadata) ? part.metadata : {};
  const pick = (key: string): unknown => stateMetadata[key] ?? partMetadata[key];
  const runStatus = asString(pick('runStatus'));
  return {
    sessionId: asString(pick('sessionID')) ?? asString(pick('sessionId')),
    agentId: asString(pick('agentId')),
    agentType: asString(pick('agentType')),
    recipient: asString(pick('recipient')),
    message: asString(pick('message')),
    childMessageId: asString(pick('childMessageID')) ?? asString(pick('childMessageId')),
    reply: asString(pick('reply')),
    runStatus: runStatus && RUN_STATUSES.includes(runStatus) ? (runStatus as SubagentRunStatus) : undefined,
  };
};

export type SubagentInput = {
  description?: string;
  /** `Agent` prompt. */
  prompt?: string;
  subagentType?: string;
  /** `Agent` input `name` (plugin alias such as `exp-1`). */
  name?: string;
  /** `SendMessage` recipient (alias or raw agent id). */
  to?: string;
  /** `SendMessage` text. */
  message?: string;
  summary?: string;
};

export const readSubagentInput = (part: Pick<ToolPart, 'state'>): SubagentInput => {
  const input = (part.state as { input?: unknown }).input;
  if (!isRecord(input)) return {};
  return {
    description: asString(input.description),
    prompt: asString(input.prompt),
    subagentType: asString(input.subagent_type) ?? asString(input.subagentType),
    name: asString(input.name),
    to: asString(input.to) ?? asString(input.recipient),
    message: asString(input.message) ?? (typeof input.content === 'string' ? asString(input.content) : undefined),
    summary: asString(input.summary),
  };
};

const RAW_AGENT_ID = /^[0-9a-f]{12,}$/i;

/**
 * Alias shown next to the type chip. `Agent`: the spawn `name`, else the child's alias. `SendMessage`:
 * the recipient the parent used; when that is a raw agent id the child's alias (or a short id) is shown instead.
 */
export const resolveSubagentAlias = (params: {
  kind: SubagentKind;
  input: SubagentInput;
  link: SubagentLink;
  childAlias?: string;
  agentId?: string;
}): string | undefined => {
  const { kind, input, link, childAlias, agentId } = params;
  if (kind === 'agent') return input.name ?? childAlias;
  const recipient = link.recipient ?? input.to;
  if (!recipient) return childAlias;
  const looksLikeId = RAW_AGENT_ID.test(recipient) || (agentId !== undefined && recipient === agentId);
  if (!looksLikeId) return recipient;
  return childAlias ?? recipient.slice(0, 7);
};

/** Deterministic child session id the host uses for an `Agent` call (`sub_<tool_use_id>`). */
export const candidateChildSessionId = (part: Pick<ToolPart, 'callID'>): string | undefined =>
  part.callID ? `sub_${part.callID}` : undefined;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type SubagentStatus =
  | 'preparing'
  | 'running'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'no-session'
  | 'sent'
  | 'not-delivered';

export type ChildPhase = 'idle' | 'busy' | 'retry';

export type SubagentStatusInput = {
  kind: SubagentKind;
  /** Tool part state status (`pending`, `running`, `completed`, `error`, ...). */
  toolStatus?: string;
  /** Tool error text, used to tell a user abort from a failure. */
  toolError?: string;
  /** Host run status for this instruction (`task_notification`). Authoritative when present. */
  runStatus?: SubagentRunStatus;
  hasSession: boolean;
  /** The 3s/8s link-resolution window elapsed without a child session. */
  linkTimedOut: boolean;
  /** Child session status (`undefined` when unknown or no child). */
  childPhase?: ChildPhase;
  /** The child's run ended with an assistant error. */
  childFailed?: boolean;
};

const ABORT_PATTERN = /abort|interrupt|stopped|cancel/i;

/**
 * Card status. It follows the CHILD session and the host run status rather than the tool part:
 * `Agent` runs in the background, so its tool result ("async launched") arrives immediately and
 * would otherwise make every card read "done" while the subagent still works (spec section 0).
 *
 * Precedence: tool pending -> preparing; delivery error (SendMessage) -> not-delivered; host run status;
 * child busy -> running; tool running -> running; otherwise the settled state of the tool.
 */
export const deriveSubagentStatus = (input: SubagentStatusInput): SubagentStatus => {
  const { kind, toolStatus, toolError, runStatus, hasSession, linkTimedOut, childPhase, childFailed } = input;
  const toolFailed = toolStatus === 'error' || toolStatus === 'failed' || toolStatus === 'timeout';
  const toolAborted = toolStatus === 'aborted' || toolStatus === 'cancelled' || (toolFailed && ABORT_PATTERN.test(toolError ?? ''));

  if (toolStatus === 'pending') return 'preparing';
  if (kind === 'message' && toolFailed && !toolAborted && runStatus !== 'completed') return 'not-delivered';
  if (runStatus === 'stopped' || toolAborted) return 'stopped';
  if (runStatus === 'error' || (kind === 'agent' && toolFailed)) return 'failed';
  if (runStatus === 'completed') return kind === 'message' ? 'sent' : 'done';
  if (runStatus === 'running') return 'running';
  if (childPhase === 'busy' || childPhase === 'retry') return 'running';
  if (toolStatus === 'running' || toolStatus === undefined) {
    if (kind === 'agent' && !hasSession && linkTimedOut) return 'no-session';
    return 'running';
  }
  // Tool settled and the child (if any) is idle.
  if (childFailed) return 'failed';
  if (kind === 'message') return 'sent';
  if (!hasSession) return linkTimedOut ? 'no-session' : 'running';
  return 'done';
};

/**
 * Safety net for a child the host left `busy` after the turn ended (the run's end was never reported): a busy child is
 * ignored when the parent session is idle, the tool part is settled and the host does not say the run is still going.
 */
export const isStaleBusyChild = (input: { childPhase: string | undefined; parentIdle: boolean; toolStatus: string | undefined; runStatus: string | undefined }): boolean =>
  input.childPhase === 'busy' && input.parentIdle && (input.toolStatus === 'completed' || input.toolStatus === 'error') && input.runStatus !== 'running';

export const isActiveSubagentStatus = (status: SubagentStatus): boolean => status === 'preparing' || status === 'running';

export type SubagentStatusCounts = { total: number; running: number; done: number; failed: number; stopped: number };

/** Counters for the group header: running (incl. preparing), done (incl. delivered), failed (incl. not delivered), stopped. */
export const summarizeSubagentStatuses = (statuses: readonly SubagentStatus[]): SubagentStatusCounts => {
  const counts: SubagentStatusCounts = { total: statuses.length, running: 0, done: 0, failed: 0, stopped: 0 };
  for (const status of statuses) {
    if (status === 'preparing' || status === 'running') counts.running += 1;
    else if (status === 'done' || status === 'sent') counts.done += 1;
    else if (status === 'failed' || status === 'not-delivered') counts.failed += 1;
    else if (status === 'stopped') counts.stopped += 1;
  }
  return counts;
};

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

/**
 * Starting at `start` (an index of a subagent item), collects the run of adjacent subagent items, skipping
 * "transparent" items (reasoning / justification text that renders nowhere in the flat list). The run ends at
 * the first other item. `next` is the index right after the last collected subagent item.
 */
export const collectSubagentRun = <T>(
  items: readonly T[],
  start: number,
  isSubagent: (item: T) => boolean,
  isTransparent: (item: T) => boolean,
): { indexes: number[]; next: number } => {
  const indexes = [start];
  let cursor = start + 1;
  let next = start + 1;
  while (cursor < items.length) {
    const item = items[cursor];
    if (isSubagent(item)) {
      indexes.push(cursor);
      cursor += 1;
      next = cursor;
      continue;
    }
    if (isTransparent(item)) {
      cursor += 1;
      continue;
    }
    break;
  }
  return { indexes, next };
};

/** A run of 2+ subagent parts renders as one group; a single part renders as a plain card. */
export const MIN_GROUP_SIZE = 2;

// ---------------------------------------------------------------------------
// Child session content
// ---------------------------------------------------------------------------

export type ChildRecord = { info: Message; parts: readonly Part[] };

export type SubagentStep = {
  id?: string;
  tool: string;
  status?: string;
  title?: string;
  input?: Record<string, unknown>;
};

const STEP_EXCLUDED_TOOLS = new Set(['task', 'agent', 'sendmessage', 'todowrite', 'todoread']);

const textOfParts = (parts: readonly Part[]): string => {
  let text = '';
  for (const part of parts) {
    if (part.type !== 'text' || part.ignored) continue;
    if (part.text) text += (text ? '\n' : '') + part.text;
  }
  return text.trim();
};

/** Child tool calls as progress steps (excludes nested agent calls, todo bookkeeping and hidden parts). */
export const buildSubagentSteps = (
  records: readonly ChildRecord[],
  range?: { start: number; end: number },
): SubagentStep[] => {
  const steps: SubagentStep[] = [];
  const start = range?.start ?? 0;
  const end = range?.end ?? records.length;
  for (let index = start; index < end; index += 1) {
    const record = records[index];
    if (record.info.role !== 'assistant') continue;
    for (const part of record.parts) {
      if (part.type !== 'tool' || isHiddenToolPart(part)) continue;
      const tool = part.tool?.toLowerCase() ?? '';
      if (!tool || STEP_EXCLUDED_TOOLS.has(tool)) continue;
      const state = part.state as { status?: string; title?: string; input?: unknown } | undefined;
      steps.push({
        id: part.id,
        tool: part.tool,
        status: state?.status,
        title: state?.title,
        input: isRecord(state?.input) ? (state.input as Record<string, unknown>) : undefined,
      });
    }
  }
  return steps;
};

/** Human label for a step: tool title, else the path/url/pattern/command it worked on. */
export const getSubagentStepLabel = (step: SubagentStep): string => {
  const title = step.title?.trim();
  if (title) return title;
  const input = step.input;
  if (!input) return '';
  const candidate = input.filePath ?? input.file_path ?? input.path ?? input.url ?? input.pattern ?? input.query ?? input.command;
  return typeof candidate === 'string' ? candidate.trim().split('\n')[0] : '';
};

export type SubagentActivityItem = {
  id: string;
  kind: 'tool' | 'text';
  tool?: string;
  status?: string;
  title?: string;
  input?: Record<string, unknown>;
  /** First line of an assistant text snippet. */
  text?: string;
  /** In progress: a running tool call, or the text still being streamed. */
  active: boolean;
};

/** Number of recent actions shown under every subagent card. */
export const SUBAGENT_ACTIVITY_LIMIT = 5;

const SNIPPET_MAX_CHARS = 160;

/**
 * Recent actions of a run, oldest first: tool calls and assistant text snippets in the order the child produced
 * them. The last item is `active` while it is a running tool or a text part of a message that is still streaming.
 */
export const buildSubagentActivity = (
  records: readonly ChildRecord[],
  range?: { start: number; end: number },
  limit: number = SUBAGENT_ACTIVITY_LIMIT,
): SubagentActivityItem[] => {
  const items: Array<SubagentActivityItem & { streaming?: boolean }> = [];
  const start = range?.start ?? 0;
  const end = range?.end ?? records.length;
  for (let index = start; index < end; index += 1) {
    const record = records[index];
    if (record.info.role !== 'assistant') continue;
    const streaming = typeof (record.info as { time?: { completed?: number } }).time?.completed !== 'number';
    for (const part of record.parts) {
      if (part.type === 'tool') {
        if (isHiddenToolPart(part)) continue;
        const name = part.tool?.toLowerCase() ?? '';
        if (!name || STEP_EXCLUDED_TOOLS.has(name)) continue;
        const state = part.state as { status?: string; title?: string; input?: unknown } | undefined;
        items.push({
          id: part.id,
          kind: 'tool',
          tool: part.tool,
          status: state?.status,
          title: state?.title,
          input: isRecord(state?.input) ? (state.input as Record<string, unknown>) : undefined,
          active: state?.status === 'running' || state?.status === 'pending',
        });
      } else if (part.type === 'text' && !part.synthetic && !part.ignored) {
        const text = firstLine(part.text?.replace(/^[#>\-*\s]+/, '').replace(/[`]|\*\*/g, ''));
        if (text) {
          items.push({
            id: part.id,
            kind: 'text',
            text: text.length > SNIPPET_MAX_CHARS ? `${text.slice(0, SNIPPET_MAX_CHARS)}...` : text,
            active: false,
            streaming,
          });
        }
      }
    }
  }
  const recent = items.slice(-limit);
  const last = recent[recent.length - 1];
  if (last && last.kind === 'text' && last.streaming) last.active = true;
  return recent.map(({ streaming, ...item }) => {
    void streaming;
    return item;
  });
};

/**
 * "No activity yet" only makes sense while the run is still going. A settled run without recorded actions (e.g. it
 * only produced a reply) shows nothing: the reply block below is enough.
 */
export const shouldShowNoActivityHint = (status: SubagentStatus): boolean => status === 'running';

const ACTION_VERBS: Record<string, string> = {
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  multiedit: 'Edit',
  bash: 'Bash',
  grep: 'Grep',
  glob: 'Glob',
  list: 'List',
  webfetch: 'Fetch',
  websearch: 'Search',
  task: 'Agent',
  skill: 'Skill',
};

/** Short action text for an activity row: `Read` + `src/foo.ts`, `Bash` + `npm test`, `Grep` + `'x'`. */
export const formatSubagentAction = (item: Pick<SubagentActivityItem, 'tool' | 'title' | 'input'>): { verb: string; detail: string } => {
  const name = (item.tool ?? 'tool').toLowerCase();
  const verb = ACTION_VERBS[name] ?? (name.charAt(0).toUpperCase() + name.slice(1));
  const input = item.input;
  const str = (key: string): string | undefined => (typeof input?.[key] === 'string' ? (input[key] as string).trim() : undefined);
  let detail: string | undefined;
  if (name === 'grep' || name === 'glob') {
    const pattern = str('pattern');
    detail = pattern ? `'${pattern}'` : undefined;
  } else if (name === 'bash') {
    detail = firstLine(str('command'));
  }
  if (!detail) detail = getSubagentStepLabel({ tool: item.tool ?? 'tool', title: item.title, input });
  return { verb, detail };
};

export type RunRange = {
  /** First record of the run (the one after the instruction user message). */
  start: number;
  /** Exclusive end: the next instruction, or the end of the session. */
  end: number;
  /** The instruction message was identified; false means the range is the whole session. */
  matched: boolean;
  userMessageId?: string;
};

const userIndexes = (records: readonly ChildRecord[]): number[] => {
  const indexes: number[] = [];
  records.forEach((record, index) => {
    if (record.info.role === 'user') indexes.push(index);
  });
  return indexes;
};

/**
 * Locates the slice of the child session that belongs to one parent instruction.
 * - `Agent`: the first instruction (matched by `toolCallId`, else the first user message).
 * - `SendMessage`: the user message matched by `childMessageId`, then `instruction.toolCallID`, then message text;
 *   unmatched falls back to the whole session (spec section 0, "progress is whole-session").
 */
export const findRunRange = (
  records: readonly ChildRecord[],
  params: { kind: SubagentKind; childMessageId?: string; toolCallId?: string; messageText?: string },
): RunRange => {
  const whole: RunRange = { start: 0, end: records.length, matched: false };
  const users = userIndexes(records);
  if (users.length === 0) return whole;

  const matchById = (id?: string) => (id ? users.find((index) => records[index].info.id === id) : undefined);
  const matchByCall = (toolCallId?: string) =>
    toolCallId
      ? users.find((index) => (records[index].info as { instruction?: { toolCallID?: string } }).instruction?.toolCallID === toolCallId)
      : undefined;

  let target = matchById(params.childMessageId) ?? matchByCall(params.toolCallId);
  if (target === undefined && params.kind === 'agent') target = users[0];
  if (target === undefined && params.messageText) {
    const wanted = params.messageText.trim();
    if (wanted.length >= 8) {
      target = users.find((index) => textOfParts(records[index].parts).includes(wanted));
    }
  }
  if (target === undefined) return whole;

  const next = users.find((index) => index > target);
  return { start: target + 1, end: next ?? records.length, matched: true, userMessageId: records[target].info.id };
};

/** Last non-empty assistant text inside a run (the subagent's reply for that instruction). */
export const findRunReply = (records: readonly ChildRecord[], range: { start: number; end: number }): string | undefined => {
  for (let index = Math.min(range.end, records.length) - 1; index >= range.start; index -= 1) {
    const record = records[index];
    if (record.info.role !== 'assistant') continue;
    for (let partIndex = record.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = record.parts[partIndex];
      if (part.type === 'text' && !part.synthetic && part.text?.trim()) return part.text.trim();
    }
  }
  return undefined;
};

/** Error text when the last assistant message of the run ended with an error. */
export const findRunError = (records: readonly ChildRecord[], range: { start: number; end: number }): string | undefined => {
  for (let index = Math.min(range.end, records.length) - 1; index >= range.start; index -= 1) {
    const info = records[index].info;
    if (info.role !== 'assistant') continue;
    const error = (info as { error?: { message?: string; data?: { message?: string }; name?: string } }).error;
    if (!error) return undefined;
    return error.data?.message ?? error.message ?? error.name ?? 'Failed';
  }
  return undefined;
};

export type InstructionEntry = {
  messageId: string;
  /** 1-based order within the child session. */
  index: number;
  kind: 'initial' | 'followup';
  createdAt?: number;
  text: string;
  fromAgent?: string;
  fromSessionId?: string;
  fromMessageId?: string;
  toolCallId?: string;
};

/**
 * Instruction timeline of a child session. Uses `UserMessage.instruction` when the host set it; otherwise every
 * user message is an instruction (first = initial task, later = follow-up).
 */
export const listInstructions = (records: readonly ChildRecord[]): InstructionEntry[] => {
  const entries: InstructionEntry[] = [];
  let position = 0;
  for (const record of records) {
    if (record.info.role !== 'user') continue;
    const info = record.info as { instruction?: SubagentInstruction; time?: { created?: number } };
    const instruction = info.instruction;
    entries.push({
      messageId: record.info.id,
      index: instruction?.index ?? position + 1,
      kind: instruction?.kind ?? (position === 0 ? 'initial' : 'followup'),
      createdAt: info.time?.created,
      text: textOfParts(record.parts),
      fromAgent: instruction?.fromAgent,
      fromSessionId: instruction?.fromSessionID,
      fromMessageId: instruction?.fromMessageID,
      toolCallId: instruction?.toolCallID,
    });
    position += 1;
  }
  return entries;
};

// ---------------------------------------------------------------------------
// Timing and formatting
// ---------------------------------------------------------------------------

/**
 * End time of a settled run. `Agent` is async, so the tool part's own `time.end` is the launch time; prefer the
 * duration reported by `task_progress`, then the child's last update, then the tool end.
 */
export const deriveSubagentEnd = (params: {
  startedAt?: number;
  progressDurationMs?: number;
  childUpdatedAt?: number;
  toolEnd?: number;
}): number | undefined => {
  const { startedAt, progressDurationMs, childUpdatedAt, toolEnd } = params;
  if (typeof startedAt === 'number' && typeof progressDurationMs === 'number' && progressDurationMs > 0) {
    return startedAt + progressDurationMs;
  }
  if (typeof childUpdatedAt === 'number' && (startedAt === undefined || childUpdatedAt >= startedAt)) return childUpdatedAt;
  return toolEnd;
};

/** `12s`, `1m 05s`; `precise` adds a decimal below one minute (`12.3s`). */
export const formatSubagentElapsed = (ms: number, precise = false): string => {
  const safe = Math.max(0, ms);
  if (safe < 60_000) {
    const seconds = safe / 1000;
    return precise ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds)}s`;
  }
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
};

/** `950`, `12.4k`. */
export const formatSubagentTokens = (count: number): string =>
  count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(Math.max(0, Math.trunc(count)));

export const INSTRUCTION_PREVIEW_LINES = 4;
export const INSTRUCTION_PREVIEW_CHARS = 280;
/** Prompts longer than this offer `Open full text` (ToolOutputDialog) in addition to the scrolling expanded view. */
export const INSTRUCTION_FULL_TEXT_CHARS = 4000;

/** Instructions collapse to a 4-line preview when they exceed 4 lines or 280 characters. */
export const shouldCollapseInstruction = (text: string): boolean =>
  text.length > INSTRUCTION_PREVIEW_CHARS || text.split('\n').length > INSTRUCTION_PREVIEW_LINES;

/** First non-empty line of a text, for the second header line. */
export const firstLine = (text: string | undefined): string | undefined => {
  if (!text) return undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Agent type display
// ---------------------------------------------------------------------------

/** Plugin agents are namespaced (`claudekei:explorer`). */
export const bareAgentName = (name: string): string => (name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name);

/**
 * Finds a catalog agent by exact name, then by bare name (`explorer` vs `claudekei:explorer`), so a subagent type
 * reported without its plugin prefix still resolves to its display name and color.
 */
export const findAgentByType = <T extends { name: string }>(agents: readonly T[], type: string | undefined): T | undefined => {
  if (!type) return undefined;
  const exact = agents.find((agent) => agent.name === type);
  if (exact) return exact;
  const bare = bareAgentName(type).toLowerCase();
  return agents.find((agent) => bareAgentName(agent.name).toLowerCase() === bare);
};
