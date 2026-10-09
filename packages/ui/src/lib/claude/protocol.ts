/**
 * Extension host <-> webview protocol for ClaudeKei (docs/PHASE1_PLAN.md section 3).
 *
 * Type-only contract (plus one constant). Requests travel over the existing bridge
 * (ids, ack/retry). Host-to-webview pushes are `claude:events` batches (D7).
 */

import type {
  ContextUsage,
  AccountInfo,
  Catalog,
  EffortLevel,
  Message,
  Part,
  PermissionMode,
  PermissionRequest,
  PermissionResponse,
  QuestionAnswer,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
  UsageLimits,
} from './types';

/** Message `type` of host-to-webview event batches. */
export const CLAUDE_EVENTS_PUSH_TYPE = 'claude:events' as const;

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/** Live (spawned or pending) state of one session, included in the bootstrap snapshot. */
export type LiveSessionState = {
  status: SessionStatus;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
};

/** Response of `claude:bootstrap`. `eventSeq` is the last `claude:events` seq already reflected here. */
export type BootstrapResponse = {
  cwd: string;
  /** Null until the SDK reports it (or when logged out). */
  account: AccountInfo | null;
  catalog: Catalog;
  /** Plan usage limits last known by the host (also pushed as `usage.updated`); absent until first fetched. */
  usage?: UsageLimits;
  sessions: Session[];
  live: Record<string, LiveSessionState>;
  eventSeq: number;
};

/** Response of `claude:session.load`: full state of one session. */
export type SessionSnapshot = {
  session: Session;
  messages: Message[];
  /** Parts keyed by message id, ascending by part id. */
  parts: Record<string, Part[]>;
  status: SessionStatus;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  todos: Todo[];
  /** Virtual subagent child sessions (`sub_<toolUseId>`). */
  children: Session[];
  /**
   * Requesting webview's push `seq` at snapshot time (host flushes its broadcaster first).
   * Session-scoped events for this session with `seq <= eventSeq` are already reflected
   * in the snapshot and must be dropped by the client.
   */
  eventSeq?: number;
};

/** Attachment sent with a prompt. */
export type SendFile = { mime: string; filename: string; dataUrl: string };

/** Answer to a question prompt: one label list per question, or a rejection. */
export type QuestionRespondPayload =
  | { sessionId: string; requestId: string; answers: QuestionAnswer[] }
  | { sessionId: string; requestId: string; reject: true };

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Request type -> `{ payload, response }`. Void responses are `void`. */
export type ClaudeRequestMap = {
  'claude:bootstrap': { payload: Record<string, never>; response: BootstrapResponse };
  'claude:session.list': { payload: { limit?: number }; response: Session[] };
  /** Returns a draft session; nothing is spawned until the first send. */
  'claude:session.create': { payload: { title?: string }; response: Session };
  'claude:session.load': { payload: { sessionId: string }; response: SessionSnapshot };
  /** Resolves right after the user message is emitted; replies stream via events. */
  'claude:session.send': {
    payload: {
      sessionId: string;
      text: string;
      files?: SendFile[];
      /** Slash command; the host sends `/name args` as the prompt. */
      command?: { name: string; args: string };
      model?: string;
      mode?: PermissionMode;
      /** Effort for this and following turns; `null` = model default. */
      effort?: EffortLevel | null;
      /** Main-thread agent for this and following turns (switching respawns the host query). */
      agent?: string;
    };
    response: { messageId: string };
  };
  'claude:session.interrupt': { payload: { sessionId: string }; response: void };
  /**
   * Forks on disk (SDK `forkSession`, no process) and returns the new, already persisted session. `atMessageId` cuts the
   * history: at an assistant message up to its last entry that does not split a tool call from its result; at a user
   * message up to the entry before it (forking at the first message returns a fresh empty session). Without it the whole
   * history is copied.
   */
  'claude:session.fork': { payload: { sessionId: string; atMessageId?: string }; response: Session };
  'claude:session.delete': { payload: { sessionId: string }; response: void };
  'claude:session.rename': { payload: { sessionId: string; title: string }; response: void };
  'claude:session.setModel': { payload: { sessionId: string; model: string }; response: void };
  /** Select the session's main-thread agent; applied on the next send. */
  'claude:session.setAgent': { payload: { sessionId: string; agent: string }; response: void };
  'claude:session.setMode': { payload: { sessionId: string; mode: PermissionMode }; response: void };
  /** Select the session's effort (`null` = model default); applied live if possible, else on the next send. */
  'claude:session.setEffort': { payload: { sessionId: string; effort: EffortLevel | null }; response: void };
  'claude:permission.respond': {
    payload: { sessionId: string; requestId: string; response: PermissionResponse };
    response: void;
  };
  'claude:question.respond': { payload: QuestionRespondPayload; response: void };
  /**
   * Fresh context breakdown (SDK `getContextUsage`, per-category count). Live sessions are measured now; cold ones
   * return the last known value or an estimate (`source: 'estimate'`). Not a model turn.
   */
  'claude:session.contextUsage': { payload: { sessionId: string }; response: ContextUsage };
  /** Re-reads the plan usage limits (no model turn). Resolves `windows: []` for API-key / third-party providers. */
  'claude:usage.refresh': { payload: Record<string, never>; response: UsageLimits };
  /**
   * Run a shell command the user explicitly clicked "Run" on (e.g. a ```bash block in a message) in a VS Code
   * terminal named "ClaudeKei" (reused if open), cwd = workspace folder, executed immediately (newline appended).
   */
  'claude:terminal.run': { payload: { command: string }; response: void };
  'claude:catalog.refresh': { payload: Record<string, never>; response: Catalog };
};

export type ClaudeRequestType = keyof ClaudeRequestMap;
export type ClaudeRequestPayload<T extends ClaudeRequestType> = ClaudeRequestMap[T]['payload'];
export type ClaudeRequestResponse<T extends ClaudeRequestType> = ClaudeRequestMap[T]['response'];

// ---------------------------------------------------------------------------
// Push events
// ---------------------------------------------------------------------------

/**
 * Error classification for `session.error`. `auth` drives the "Run `claude login`" CTA; `hook`
 * marks a prompt blocked by a user hook (rendered as an info notice, not an error).
 */
export type SessionErrorKind = 'auth' | 'api' | 'aborted' | 'hook' | 'unknown';

/** Property shapes mirror what `sync/event-reducer.ts` reads. */
export type ClaudeEvent =
  | { type: 'session.created'; properties: { sessionID: string; info: Session } }
  | { type: 'session.updated'; properties: { sessionID: string; info: Session } }
  | { type: 'session.deleted'; properties: { sessionID: string; info: Session } }
  | { type: 'session.status'; properties: { sessionID: string; status: SessionStatus } }
  | {
      type: 'session.error';
      properties: { sessionID?: string; error: { name: string; message: string; kind?: SessionErrorKind } };
    }
  | { type: 'message.updated'; properties: { sessionID: string; info: Message } }
  | { type: 'message.removed'; properties: { sessionID: string; messageID: string } }
  | { type: 'message.part.updated'; properties: { part: Part } }
  | {
      type: 'message.part.delta';
      properties: { sessionID: string; messageID: string; partID: string; field: string; delta: string };
    }
  | { type: 'permission.asked'; properties: PermissionRequest }
  | {
      type: 'permission.replied';
      properties: { sessionID: string; requestID: string; reply: PermissionResponse };
    }
  | { type: 'question.asked'; properties: QuestionRequest }
  | {
      type: 'question.replied';
      properties: { sessionID: string; requestID: string; answers: QuestionAnswer[] };
    }
  | { type: 'question.rejected'; properties: { sessionID: string; requestID: string } }
  | { type: 'todo.updated'; properties: { sessionID: string; todos: Todo[] } }
  | { type: 'catalog.updated'; properties: { catalog: Catalog } }
  | { type: 'account.updated'; properties: { account: AccountInfo | null } }
  /** Plan usage limits changed (after a turn's `rate_limit_event`, a refresh, or the startup fetch). */
  | { type: 'usage.updated'; properties: { usage: UsageLimits } };

export type ClaudeEventType = ClaudeEvent['type'];

/**
 * Host-to-webview push. `seq` is per webview and strictly increasing by 1;
 * a gap means events were lost and the webview must reload snapshots. Not acked or retried.
 */
export type ClaudeEventsPush = {
  type: typeof CLAUDE_EVENTS_PUSH_TYPE;
  seq: number;
  events: ClaudeEvent[];
};
