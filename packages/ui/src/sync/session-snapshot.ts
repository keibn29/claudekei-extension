/**
 * Session snapshots: `claude:session.load` replaces the per-session message paging of the old
 * OpenCode sync. One call returns messages, parts, status, pending prompts, todos and children.
 */

import type { StoreApi } from "zustand"
import { claudeClient } from "@/lib/claude/client"
import type { SessionSnapshot } from "@/lib/claude/protocol"
import type { Message, Part, Session } from "@/lib/claude/types"
import { useTodosPersistStore } from "@/stores/useTodosPersistStore"
import { Binary } from "./binary"
import type { DirectoryStore } from "./child-store"
import { retry } from "./retry"
import { stripMessageDiffSnapshots, stripSessionDiffSnapshots } from "./sanitize"
import { SKIPPED_PART_TYPES } from "./streaming-parts"

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// Sessions whose full snapshot is in the store. Event-created message lists (e.g. for an evicted
// session that is still streaming) are partial and must not count as loaded.
const loadedSessions = new WeakMap<StoreApi<DirectoryStore>, Set<string>>()

export const isSessionLoaded = (store: StoreApi<DirectoryStore>, sessionId: string): boolean =>
  loadedSessions.get(store)?.has(sessionId) ?? false

export const forgetLoadedSessions = (store: StoreApi<DirectoryStore>, sessionIds: Iterable<string>) => {
  const loaded = loadedSessions.get(store)
  if (!loaded) return
  for (const id of sessionIds) loaded.delete(id)
}

function upsertSession(sessions: Session[], session: Session) {
  const result = Binary.search(sessions, session.id, (s) => s.id)
  if (result.found) sessions[result.index] = session
  else sessions.splice(result.index, 0, session)
}

/** Write a session snapshot into a directory store. Idempotent. */
export function applySessionSnapshot(store: StoreApi<DirectoryStore>, snapshot: SessionSnapshot) {
  const sessionID = snapshot.session.id
  const state = store.getState()

  const sessions = [...state.session]
  upsertSession(sessions, stripSessionDiffSnapshots(snapshot.session))
  for (const child of snapshot.children ?? []) {
    if (child?.id) upsertSession(sessions, stripSessionDiffSnapshots(child))
  }

  const messages: Message[] = snapshot.messages
    .filter((message) => !!message?.id)
    .map((message) => stripMessageDiffSnapshots(message))
    .sort((a, b) => cmp(a.id, b.id))

  const part = { ...state.part }
  for (const message of messages) {
    const parts: Part[] = (snapshot.parts[message.id] ?? [])
      .filter((candidate) => !!candidate?.id && !SKIPPED_PART_TYPES.has(candidate.type))
      .sort((a, b) => cmp(a.id, b.id))
    part[message.id] = parts
  }

  store.setState({
    session: sessions,
    message: { ...state.message, [sessionID]: messages },
    part,
    session_status: { ...state.session_status, [sessionID]: snapshot.status },
    permission: { ...state.permission, [sessionID]: snapshot.permissions },
    question: { ...state.question, [sessionID]: snapshot.questions },
    todo: { ...state.todo, [sessionID]: snapshot.todos },
  })
  useTodosPersistStore.getState().setSessionTodos(sessionID, snapshot.todos)

  let loaded = loadedSessions.get(store)
  if (!loaded) {
    loaded = new Set()
    loadedSessions.set(store, loaded)
  }
  loaded.add(sessionID)
}

type SnapshotListener = (sessionId: string, eventSeq: number) => void
const snapshotListeners = new Set<SnapshotListener>()

/**
 * Observe snapshots that carry an `eventSeq` (the push seq they reflect). The event source uses this
 * to drop queued events the snapshot already contains. Returns an unsubscribe function.
 */
export function onSessionSnapshotSeq(listener: SnapshotListener): () => void {
  snapshotListeners.add(listener)
  return () => {
    snapshotListeners.delete(listener)
  }
}

/** Fetch and apply a session snapshot. */
export async function loadSessionIntoStore(store: StoreApi<DirectoryStore>, sessionId: string): Promise<SessionSnapshot> {
  const snapshot = await retry(() => claudeClient.loadSession(sessionId), {
    attempts: 3,
    delay: 400,
    retryIf: () => true,
  })
  // Drop already-reflected waiting events first, then write the snapshot, with no await in between.
  if (typeof snapshot.eventSeq === "number") {
    for (const listener of snapshotListeners) listener(snapshot.session.id, snapshot.eventSeq)
  }
  applySessionSnapshot(store, snapshot)
  return snapshot
}
