/**
 * Session actions — operations on sessions and pending prompts, backed by `claudeClient`.
 * Replaces the action methods from the old useSessionStore.
 */

import { toast } from "sonner"
import { claudeClient } from "@/lib/claude/client"
import type { EffortLevel, PermissionMode, PermissionResponse, Part, Session } from "@/lib/claude/types"
import type { State } from "./types"
import { Binary } from "./binary"
import { useSessionUIStore } from "./session-ui-store"
import { useInputStore } from "./input-store"
import type { ChildStoreManager } from "./child-store"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { useConfigStore } from "@/stores/useConfigStore"
import { isSyntheticPart } from "@/lib/messages/synthetic"
import { clearSessionPrefetch } from "./session-prefetch-cache"
import { markSessionDeleted } from "./session-mutation-version"

// Reference set by SyncProvider — allows actions to access the stores
let _childStores: ChildStoreManager | null = null
let _getDirectory: () => string = () => ""

export function setActionRefs(childStores: ChildStoreManager, getDirectory: () => string) {
  _childStores = childStores
  _getDirectory = getDirectory
}

function dirStore() {
  if (!_childStores) throw new Error("Child stores not initialized")
  const d = _getDirectory()
  if (!d) throw new Error("No current directory")
  return _childStores.ensureChild(d)
}

function connectionLostError(): Error {
  const { hasEverConnected, lastDisconnectReason } = useConfigStore.getState()
  const suffix = lastDisconnectReason
    ? ` (${lastDisconnectReason})`
    : hasEverConnected
      ? ""
      : " (never connected)"
  return new Error(`Connection lost${suffix}. Please wait for reconnection.`)
}

// Wait briefly for the host connection before failing a send, so a transient
// reconnect does not surface as a hard "Connection lost" toast.
const CONNECTION_GRACE_MS = 2000
export async function waitForConnectionOrThrow(): Promise<void> {
  const deadline = Date.now() + CONNECTION_GRACE_MS
  while (Date.now() < deadline) {
    if (useConfigStore.getState().isConnected) return
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    if (await useConfigStore.getState().probeConnection({ timeoutMs: Math.min(500, remainingMs) })) return
    const sleepMs = Math.min(100, deadline - Date.now())
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
    }
  }
  throw connectionLostError()
}

function upsertSessionInStore(session: Session) {
  const store = dirStore()
  const sessions = [...store.getState().session]
  const result = Binary.search(sessions, session.id, (s) => s.id)
  if (result.found) sessions[result.index] = session
  else sessions.splice(result.index, 0, session)
  store.setState({ session: sessions })
}

// ---------------------------------------------------------------------------
// Session CRUD
// ---------------------------------------------------------------------------

/** Create a draft session on the host (nothing is spawned until the first send). */
export async function createSession(
  title?: string,
  _directoryOverride?: string | null,
  _parentID?: string | null,
): Promise<Session | null> {
  void _directoryOverride
  void _parentID
  try {
    const session = await claudeClient.createSession(title)
    if (!session) return null

    upsertSessionInStore(session)
    useSessionUIStore.getState().setCurrentSession(session.id, session.directory ?? null)
    useSessionUIStore.getState().markSessionAsOpenChamberCreated(session.id)
    useGlobalSessionsStore.getState().upsertSession(session)
    return session
  } catch (error) {
    console.error("[session-actions] createSession failed", error)
    return null
  }
}

/**
 * Discover descendant session IDs following parentID relationships rooted at rootIds.
 * Returns descendants in post-order (deepest descendants first).
 * Never touches another main session tree; strictly uses parentID.
 */
export function findDescendantSessionIds(
  rootIds: Iterable<string>,
  knownSessions: Iterable<Session>,
): string[] {
  const rootSet = new Set(rootIds)
  const childrenByParent = new Map<string, Session[]>()
  for (const session of knownSessions) {
    if (session.parentID) {
      const list = childrenByParent.get(session.parentID) ?? []
      list.push(session)
      childrenByParent.set(session.parentID, list)
    }
  }

  const orderedDescendantIds: string[] = []
  const visited = new Set<string>(rootSet)

  const traverse = (parentId: string) => {
    const children = childrenByParent.get(parentId) ?? []
    for (const child of children) {
      if (!visited.has(child.id)) {
        visited.add(child.id)
        traverse(child.id)
        orderedDescendantIds.push(child.id)
      }
    }
  }

  for (const rootId of rootSet) {
    traverse(rootId)
  }

  return Array.from(new Set(orderedDescendantIds))
}

/** Drop every trace of the given sessions from the child stores (and prefetch cache). */
function removeSessionsFromStores(ids: Set<string>) {
  if (!_childStores) return
  for (const [dir, store] of _childStores.children) {
    const state = store.getState()
    const hasMatchingSessions = state.session.some((s) => ids.has(s.id))
    const hasCache = Array.from(ids).some((id) =>
      state.message[id] || state.part[id] || state.todo[id] || state.session_status[id]
      || state.session_diff[id] || state.permission[id] || state.question[id])
    if (!hasMatchingSessions && !hasCache) continue

    const patch: Partial<State> = {
      session: hasMatchingSessions ? state.session.filter((s) => !ids.has(s.id)) : state.session,
    }
    if (hasCache) {
      const message = { ...state.message }
      const part = { ...state.part }
      const todo = { ...state.todo }
      const status = { ...state.session_status }
      const diff = { ...state.session_diff }
      const permission = { ...state.permission }
      const question = { ...state.question }
      for (const id of ids) {
        for (const messageEntry of message[id] ?? []) delete part[messageEntry.id]
        delete message[id]
        delete todo[id]
        delete status[id]
        delete diff[id]
        delete permission[id]
        delete question[id]
      }
      Object.assign(patch, { message, part, todo, session_status: status, session_diff: diff, permission, question })
    }
    store.setState(patch)
    clearSessionPrefetch(dir, ids)
  }
}

/**
 * Delete sessions. Virtual subagent children (`sub_*`) have no transcript of their own, so only
 * their root sessions are deleted on the host; descendants are removed from the UI with them.
 */
export async function deleteSessions(
  ids: string[],
  _options?: Record<string, unknown>,
): Promise<{ deletedIds: string[]; failedIds: string[] }> {
  void _options
  const rawIds = Array.from(new Set(ids.filter(Boolean)))
  if (rawIds.length === 0) {
    return { deletedIds: [], failedIds: [] }
  }

  const known = new Map<string, Session>()
  if (_childStores) {
    for (const store of _childStores.children.values()) {
      for (const session of store.getState().session) known.set(session.id, session)
    }
  }
  const descendantIds = findDescendantSessionIds(rawIds, known.values())
  const allTargetIds = Array.from(new Set([...descendantIds, ...rawIds]))
  const allTargetSet = new Set(allTargetIds)

  const ui = useSessionUIStore.getState()
  if (ui.currentSessionId && allTargetSet.has(ui.currentSessionId)) {
    ui.setCurrentSession(null)
  }

  // Optimistic UI removal before the host round trip.
  useGlobalSessionsStore.getState().removeSessions(allTargetSet)
  for (const id of allTargetIds) markSessionDeleted(id)
  removeSessionsFromStores(allTargetSet)

  const hostIds = rawIds.filter((id) => !known.get(id)?.parentID)
  const failed = new Set<string>()
  for (const id of hostIds) {
    try {
      await claudeClient.deleteSession(id)
    } catch (error) {
      console.error(`[session-actions] deleteSession failed for ${id}:`, error)
      failed.add(id)
    }
  }

  if (failed.size > 0) {
    void useGlobalSessionsStore.getState().loadSessions().catch(() => {})
  }

  return {
    deletedIds: allTargetIds.filter((id) => !failed.has(id)),
    failedIds: allTargetIds.filter((id) => failed.has(id)),
  }
}

export async function deleteSession(sessionId: string, options?: Record<string, unknown>): Promise<boolean> {
  const result = await deleteSessions([sessionId], options)
  return result.deletedIds.includes(sessionId)
}

/** Delete a session specifying which directory it lives in (agent groups). The workspace is fixed, so the directory is ignored. */
export async function deleteSessionInDirectory(sessionId: string, _directory: string): Promise<boolean> {
  void _directory
  return deleteSession(sessionId)
}

const phase2Toast = (feature: string) => {
  toast.info(`${feature} is not available yet`, { description: "Planned for a later ClaudeKei release." })
}

/** Archiving is not supported by Claude sessions (Phase 2). */
export async function archiveSession(_sessionId: string): Promise<boolean> {
  void _sessionId
  phase2Toast("Archiving sessions")
  return false
}

export async function updateSessionTitle(sessionId: string, title: string): Promise<void> {
  await claudeClient.renameSession(sessionId, title)
  // The host also pushes session.updated; update eagerly so the sidebar does not lag.
  const store = dirStore()
  const sessions = [...store.getState().session]
  const index = Binary.search(sessions, sessionId, (s) => s.id)
  if (index.found) {
    const updated: Session = { ...sessions[index.index], title, time: { ...sessions[index.index].time, updated: Date.now() } }
    sessions[index.index] = updated
    store.setState({ session: sessions })
    useGlobalSessionsStore.getState().upsertSession(updated)
  }
}

/** Sharing is not supported (Phase 2). */
export async function shareSession(_sessionId: string): Promise<Session | null> {
  void _sessionId
  phase2Toast("Sharing sessions")
  return null
}

/** Sharing is not supported (Phase 2). */
export async function unshareSession(_sessionId: string): Promise<Session | null> {
  void _sessionId
  phase2Toast("Sharing sessions")
  return null
}

// ---------------------------------------------------------------------------
// Permission mode
// ---------------------------------------------------------------------------

/**
 * Change a session's permission mode on the host and mirror it into the store right away; the host's
 * own `session.updated` (e.g. after plan approval) keeps it current afterwards.
 */
export async function setSessionPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
  await claudeClient.setMode(sessionId, mode)
  const store = dirStore()
  const sessions = [...store.getState().session]
  const index = Binary.search(sessions, sessionId, (s) => s.id)
  if (index.found) {
    sessions[index.index] = { ...sessions[index.index], mode }
    store.setState({ session: sessions })
  }
}

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

export async function abortCurrentOperation(sessionId: string): Promise<void> {
  try {
    await claudeClient.interrupt(sessionId)
  } catch (error) {
    console.error("[session-actions] interrupt failed", error)
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export async function respondToPermission(
  sessionId: string,
  requestId: string,
  response: PermissionResponse,
): Promise<void> {
  await waitForConnectionOrThrow()
  await claudeClient.respondPermission(sessionId, requestId, response)
}

export async function dismissPermission(sessionId: string, requestId: string): Promise<void> {
  await waitForConnectionOrThrow()
  await claudeClient.respondPermission(sessionId, requestId, "reject")
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export async function respondToQuestion(
  sessionId: string,
  requestId: string,
  answers: string[] | string[][],
): Promise<void> {
  await waitForConnectionOrThrow()
  const normalized = (answers as unknown[]).map((answer) => (Array.isArray(answer) ? answer : [String(answer)])) as string[][]
  await claudeClient.respondQuestion(sessionId, requestId, normalized)
}

export async function rejectQuestion(sessionId: string, requestId: string): Promise<void> {
  await waitForConnectionOrThrow()
  await claudeClient.respondQuestion(sessionId, requestId, { reject: true })
}

// ---------------------------------------------------------------------------
// Revert (Phase 2)
// ---------------------------------------------------------------------------

/** Undo/revert is not supported yet (Phase 2). */
export async function revertToMessage(_sessionId: string, _messageId: string): Promise<void> {
  void _sessionId
  void _messageId
  phase2Toast("Reverting to a message")
}

/** Undo/redo is not supported yet (Phase 2). */
export async function unrevertSession(_sessionId: string): Promise<void> {
  void _sessionId
  phase2Toast("Restoring reverted messages")
}

// ---------------------------------------------------------------------------
// Fork
// ---------------------------------------------------------------------------

/**
 * Fork a session at a message.
 *
 * The host forks BEFORE the selected user message (the fork does not contain it), so pre-filling the
 * composer with that message's text lets the user edit and resend it. For any other message (e.g. an
 * assistant reply) the fork already contains everything up to it, so nothing is pre-filled.
 *
 * 1. Ask the host for a forked draft session (first send resumes with `forkSession`)
 * 2. Insert the new session into the child store (so sidebar updates immediately)
 * 3. Switch to the new session and, for user messages, set the pending input text
 */
export async function forkFromMessage(sessionId: string, messageId: string): Promise<void> {
  const store = dirStore()
  const state = store.getState()

  const sourceMessage = (state.message[sessionId] ?? []).find((message) => message.id === messageId)
  let messageText = ""
  if (sourceMessage?.role === "user") {
    // Only non-synthetic text parts are restored into the input.
    const parts = state.part[messageId] ?? []
    messageText = parts
      .filter((p) => p.type === "text" && !isSyntheticPart(p))
      .map((p: Part) => ((p as Record<string, unknown>).text as string) || "")
      .join("\n")
      .trim()
  }

  const forkedSession = await claudeClient.fork(sessionId, messageId)
  if (!forkedSession) return

  upsertSessionInStore(forkedSession)
  useGlobalSessionsStore.getState().upsertSession(forkedSession)
  useSessionUIStore.getState().setCurrentSession(forkedSession.id)

  if (messageText) {
    useInputStore.setState({
      pendingInputText: messageText,
      pendingInputMode: "replace" as const,
    })
  }
}

// ---------------------------------------------------------------------------
// Model and effort
// ---------------------------------------------------------------------------

const patchSession = (sessionId: string, patch: Partial<Session>) => {
  const store = dirStore()
  const sessions = [...store.getState().session]
  const index = Binary.search(sessions, sessionId, (s) => s.id)
  if (index.found) {
    sessions[index.index] = { ...sessions[index.index], ...patch }
    store.setState({ session: sessions })
  }
}

/** Select a session's model on the host and mirror it right away; `session.updated` keeps `model`/`resolvedModel` current. */
export async function setSessionModel(sessionId: string, model: string): Promise<void> {
  await claudeClient.setModel(sessionId, model)
  patchSession(sessionId, { model })
}

/** Select a session's effort (`null` = model default) on the host and mirror it right away. */
export async function setSessionEffort(sessionId: string, effort: EffortLevel | null): Promise<void> {
  await claudeClient.setEffort(sessionId, effort)
  patchSession(sessionId, { effort: effort ?? undefined })
}
