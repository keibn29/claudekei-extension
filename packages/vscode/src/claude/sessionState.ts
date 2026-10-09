/**
 * Pure fold of `ClaudeEvent`s into per-session state (messages sorted by id, parts sorted by id, todos, status).
 *
 * Used by history replay (to build a `SessionSnapshot` from mapper events) and by the golden tests. It mirrors the
 * semantics of the webview's `sync/event-reducer.ts` for the events the mapper emits, without immer/zustand. W3 can
 * use it as the host-side `SessionState`.
 */
import type { ClaudeEvent } from '@openchamber/ui/src/lib/claude/protocol';
import type { Message, Part, Session, SessionStatus, Todo } from '@openchamber/ui/src/lib/claude/types';

export type SessionBucket = {
  info?: Session;
  /** Ascending by id. */
  messages: Message[];
  /** Keyed by message id, each ascending by part id. */
  parts: Record<string, Part[]>;
  status: SessionStatus;
  todos: Todo[];
};

export type SessionErrorRecord = { sessionID?: string; name: string; message: string; kind?: string };

export type SessionState = {
  /** Id of the session the mapper was created for. */
  mainSessionId: string;
  /** Main session and virtual `sub_<toolUseId>` children. */
  sessions: Map<string, SessionBucket>;
  errors: SessionErrorRecord[];
};

export function createSessionState(mainSessionId: string, info?: Session): SessionState {
  const state: SessionState = { mainSessionId, sessions: new Map(), errors: [] };
  const bucket = bucketFor(state, mainSessionId);
  if (info) bucket.info = structuredClone(info);
  return state;
}

export function bucketFor(state: SessionState, sessionId: string): SessionBucket {
  let bucket = state.sessions.get(sessionId);
  if (!bucket) {
    bucket = { messages: [], parts: {}, status: { type: 'idle' }, todos: [] };
    state.sessions.set(sessionId, bucket);
  }
  return bucket;
}

/** Binary search for `id` in an id-sorted array. */
function findIndex<T extends { id: string }>(items: T[], id: string): { found: boolean; index: number } {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midId = items[mid]!.id;
    if (midId === id) return { found: true, index: mid };
    if (midId < id) lo = mid + 1;
    else hi = mid;
  }
  return { found: false, index: lo };
}

function upsert<T extends { id: string }>(items: T[], item: T): void {
  const { found, index } = findIndex(items, item.id);
  if (found) items[index] = item;
  else items.splice(index, 0, item);
}

/** Applies one event. Events are cloned on the way in, so callers may keep mutating their objects. */
export function reduceEvent(state: SessionState, event: ClaudeEvent): void {
  switch (event.type) {
    case 'session.created':
    case 'session.updated': {
      const bucket = bucketFor(state, event.properties.sessionID);
      bucket.info = structuredClone(event.properties.info);
      return;
    }
    case 'session.deleted':
      state.sessions.delete(event.properties.sessionID);
      return;
    case 'session.status':
      bucketFor(state, event.properties.sessionID).status = structuredClone(event.properties.status);
      return;
    case 'session.error':
      state.errors.push({ ...event.properties.error, sessionID: event.properties.sessionID });
      if (event.properties.sessionID) bucketFor(state, event.properties.sessionID).status = { type: 'idle' };
      return;
    case 'message.updated': {
      const info = structuredClone(event.properties.info);
      upsert(bucketFor(state, info.sessionID).messages, info);
      return;
    }
    case 'message.removed': {
      const bucket = bucketFor(state, event.properties.sessionID);
      bucket.messages = bucket.messages.filter((m) => m.id !== event.properties.messageID);
      delete bucket.parts[event.properties.messageID];
      return;
    }
    case 'message.part.updated': {
      const part = structuredClone(event.properties.part);
      const bucket = bucketFor(state, part.sessionID);
      const list = (bucket.parts[part.messageID] ??= []);
      upsert(list, part);
      return;
    }
    case 'message.part.delta': {
      const { sessionID, messageID, partID, field, delta } = event.properties;
      const list = bucketFor(state, sessionID).parts[messageID];
      if (!list) return;
      const { found, index } = findIndex(list, partID);
      if (!found) return;
      const existing = list[index] as unknown as Record<string, unknown>;
      existing[field] = `${typeof existing[field] === 'string' ? existing[field] : ''}${delta}`;
      return;
    }
    case 'todo.updated':
      bucketFor(state, event.properties.sessionID).todos = structuredClone(event.properties.todos);
      return;
    default:
      // permission.*, question.*, catalog.updated, account.updated, usage.updated are not part of mapped session content.
      return;
  }
}

export function reduceEvents(state: SessionState, events: readonly ClaudeEvent[]): void {
  for (const event of events) reduceEvent(state, event);
}

/** Convenience: all parts of one session in message order. */
export function partsOf(bucket: SessionBucket): Part[] {
  return bucket.messages.flatMap((m) => bucket.parts[m.id] ?? []);
}
