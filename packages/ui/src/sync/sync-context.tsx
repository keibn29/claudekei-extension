/* eslint-disable react-refresh/only-export-components */
import React, { createContext, useContext, useEffect, useRef, useCallback, useMemo } from "react"
import type { StoreApi } from "zustand"
import { useStore } from "zustand"
import { claudeClient } from "@/lib/claude/client"
import { getWorkspaceCwd, loadBootstrap, setAccount, setCatalog, setUsage } from "@/lib/claude/bootstrapCache"
import { useClaudeAuthStore } from "@/lib/claude/authState"
import type { ClaudeEvent } from "@/lib/claude/protocol"
import type { Message, Part, PermissionRequest, QuestionRequest, Session, SessionStatus } from "@/lib/claude/types"
import { createClaudeEventSource } from "./claude-event-source"
import { applyDirectoryEvent } from "./event-reducer"
import { useGlobalSyncStore, type GlobalSyncStore } from "./global-sync-store"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import {
  aggregateLiveSessions,
  aggregateLiveSessionStatuses,
  areSessionListsEquivalent,
  areStatusMapsEquivalent,
  findLiveSession,
  findLiveSessionStatus,
} from "./live-aggregate"
import { bootstrapGlobal, bootstrapDirectory, buildDirectoryPatch, fetchBootstrap } from "./bootstrap"
import { isSessionLoaded, loadSessionIntoStore, onSessionSnapshotSeq } from "./session-snapshot"
import { updateStreamingState } from "./streaming"
import { setActionRefs } from "./session-actions"
import { setSyncRefs } from "./sync-refs"
import { syncDebug } from "./debug"
import { usePermissionStore } from "@/stores/permissionStore"
import { useConfigStore } from "@/stores/useConfigStore"
import { useTodosPersistStore } from "@/stores/useTodosPersistStore"
import { toast } from "@/components/ui"
import { appendNotification } from "./notification-store"
import { claudeHost } from "@/lib/claude/host"
import type { State } from "./types"
import * as sessionActions from "./session-actions"

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

type SyncSystem = {
  childStores: ChildStoreManager
  directory: string
}

const SYNC_CONTEXT_GLOBAL_KEY = "__openchamber_sync_context__"
type SyncGlobal = typeof globalThis & {
  [SYNC_CONTEXT_GLOBAL_KEY]?: React.Context<SyncSystem | null>
}

const syncGlobal = globalThis as SyncGlobal
const SyncContext = syncGlobal[SYNC_CONTEXT_GLOBAL_KEY] ?? createContext<SyncSystem | null>(null)
syncGlobal[SYNC_CONTEXT_GLOBAL_KEY] = SyncContext

function useSyncSystem() {
  const ctx = useContext(SyncContext)
  if (!ctx) throw new Error("useSyncSystem must be used within <SyncProvider>")
  return ctx
}

function getLiveStates(childStores: ChildStoreManager): State[] {
  return Array.from(childStores.children.values(), (store) => store.getState())
}

function useLiveSyncSelector<T>(selector: (states: State[]) => T, isEqual: (left: T, right: T) => boolean = Object.is): T {
  const { childStores } = useSyncSystem()
  const cacheRef = useRef<T | undefined>(undefined)
  const initializedRef = useRef(false)

  const getSnapshot = useCallback(() => {
    const next = selector(getLiveStates(childStores))
    if (initializedRef.current && isEqual(cacheRef.current as T, next)) {
      return cacheRef.current as T
    }

    cacheRef.current = next
    initializedRef.current = true
    return next
  }, [childStores, isEqual, selector])

  return React.useSyncExternalStore(
    useCallback((notify) => childStores.subscribeAll(notify), [childStores]),
    getSnapshot,
    getSnapshot,
  )
}

/** Read status for a session across all directories */
export function useGlobalSessionStatus(sessionId: string): SessionStatus | undefined {
  return useLiveSyncSelector(
    useCallback((states) => findLiveSessionStatus(states, sessionId), [sessionId]),
  )
}

/** Read all session statuses (for sidebar) */
export function useAllSessionStatuses(): Record<string, SessionStatus> {
  return useLiveSyncSelector(
    useCallback((states) => aggregateLiveSessionStatuses(states), []),
    areStatusMapsEquivalent,
  )
}

export function useAllLiveSessions(): Session[] {
  return useLiveSyncSelector(
    useCallback((states) => aggregateLiveSessions(states), []),
    areSessionListsEquivalent,
  )
}

// ---------------------------------------------------------------------------
// Viewed-session tracking and toasts
// ---------------------------------------------------------------------------

// Module-level refs for notification viewed check.
// Used to determine if user is currently viewing the session when a notification arrives.
let _activeDirectory = ""
let _activeSession = ""
const pendingQuestionToastIds = new Set<string>()
const pendingPermissionToastIds = new Set<string>()

const requestToastKey = (sessionID?: string, requestID?: string) => {
  if (!sessionID || !requestID) return null
  return `${sessionID}:${requestID}`
}

const openSessionFromToast = (sessionID: string, directory: string) => {
  void import("./session-ui-store")
    .then(({ useSessionUIStore }) => {
      useSessionUIStore.getState().setCurrentSession(sessionID, directory)
    })
    .catch(() => undefined)
}

export function setActiveSession(directory: string, sessionId: string) {
  _activeDirectory = directory
  _activeSession = sessionId
}

function isViewedInCurrentSession(directory: string, sessionId?: string): boolean {
  if (!_activeDirectory || !_activeSession || !sessionId) return false
  if (directory !== _activeDirectory) return false
  return sessionId === _activeSession
}

// ---------------------------------------------------------------------------
// Event handling — applies a flushed batch of host events to the live store.
// Each event reads live state, creates a shallow draft, applies, writes back.
// ---------------------------------------------------------------------------

/** Toasts, notifications and cross-store side effects that run before the reducer. */
function runEventSideEffects(event: ClaudeEvent, directory: string, store: StoreApi<DirectoryStore>): boolean {
  switch (event.type) {
    case "permission.asked": {
      const permission: PermissionRequest = event.properties
      const permissionStore = usePermissionStore.getState()
      if (permissionStore.isSessionAutoAccepting(permission.sessionID)) {
        void sessionActions.respondToPermission(permission.sessionID, permission.id, "once").catch(() => undefined)
        return false
      }

      const toastKey = requestToastKey(permission.sessionID, permission.id)
      if (!isViewedInCurrentSession(directory, permission.sessionID) && toastKey && !pendingPermissionToastIds.has(toastKey)) {
        pendingPermissionToastIds.add(toastKey)
        const description = typeof permission.permission === "string" && permission.permission.trim().length > 0
          ? permission.permission
          : "Agent needs your approval"
        toast.info("Permission needed", {
          id: `permission-${toastKey}`,
          description,
          action: {
            label: "Open session",
            onClick: () => openSessionFromToast(permission.sessionID, directory),
          },
        })
      }
      return true
    }

    case "permission.replied": {
      const toastKey = requestToastKey(event.properties.sessionID, event.properties.requestID)
      if (toastKey) {
        pendingPermissionToastIds.delete(toastKey)
        toast.dismiss(`permission-${toastKey}`)
      }
      return true
    }

    case "question.asked": {
      const question: QuestionRequest = event.properties
      const toastKey = requestToastKey(question.sessionID, question.id)
      if (!isViewedInCurrentSession(directory, question.sessionID) && toastKey && !pendingQuestionToastIds.has(toastKey)) {
        pendingQuestionToastIds.add(toastKey)
        const firstQuestion = question.questions?.[0]
        toast.info(firstQuestion?.header?.trim() || "Input needed", {
          id: `question-${toastKey}`,
          description: firstQuestion?.question?.trim() || "Agent is waiting for your response",
          action: {
            label: "Open session",
            onClick: () => openSessionFromToast(question.sessionID, directory),
          },
        })
      }
      return true
    }

    case "question.replied":
    case "question.rejected": {
      const toastKey = requestToastKey(event.properties.sessionID, event.properties.requestID)
      if (toastKey) {
        pendingQuestionToastIds.delete(toastKey)
        toast.dismiss(`question-${toastKey}`)
      }
      return true
    }

    case "session.status": {
      // busy/retry -> idle marks a finished turn. Subagent sessions do not notify.
      if (event.properties.status.type !== "idle") return true
      const sessionID = event.properties.sessionID
      const state = store.getState()
      const previous = state.session_status?.[sessionID]?.type
      if (previous !== "busy" && previous !== "retry") return true
      if (state.session.find((s) => s.id === sessionID)?.parentID) return true
      appendNotification({
        directory,
        session: sessionID,
        time: Date.now(),
        viewed: isViewedInCurrentSession(directory, sessionID),
        type: "turn-complete" as const,
      })
      return true
    }

    case "session.error": {
      const { sessionID, error } = event.properties
      if (error.kind === "auth") {
        useClaudeAuthStore.getState().setAuthRequired(error.message)
      }
      if (error.kind === "hook") {
        // A hook blocked the prompt: informational, not a failed turn.
        useClaudeAuthStore.getState().addHookNotice(sessionID ?? null, error.message)
        return true
      }
      if (sessionID) {
        const session = store.getState().session.find((s) => s.id === sessionID)
        if (!session?.parentID) {
          appendNotification({
            directory,
            session: sessionID,
            time: Date.now(),
            viewed: isViewedInCurrentSession(directory, sessionID),
            type: "error" as const,
            error: { message: error.message },
          })
        }
      }
      return true
    }

    case "catalog.updated":
      setCatalog(event.properties.catalog)
      return true

    case "usage.updated":
      setUsage(event.properties.usage)
      return true

    case "account.updated":
      setAccount(event.properties.account)
      if (event.properties.account) useClaudeAuthStore.getState().clearAuthRequired()
      return true

    default:
      return true
  }
}

function handleEvent(event: ClaudeEvent, directory: string, childStores: ChildStoreManager) {
  const store = childStores.ensureChild(directory, { bootstrap: false })
  childStores.mark(directory)

  if (!runEventSideEffects(event, directory, store)) return

  // The reducer is copy-on-write: it replaces only the slices an event touches, so untouched
  // slices keep their identity (selectors skip re-renders) and touched ones always change identity.
  const current = store.getState()
  const draft: State = { ...current }

  const applied = applyDirectoryEvent(draft, event, {
    onSetSessionTodo: (sessionID, todos) => {
      useTodosPersistStore.getState().setSessionTodos(sessionID, todos)
    },
  })
  const sessionID = (event.properties as { sessionID?: string }).sessionID
  if (applied) {
    store.setState(draft)
    syncDebug.dispatch.eventApplied(event.type, sessionID, undefined)
  } else {
    syncDebug.dispatch.eventNoChange(event.type, sessionID, undefined)
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Connection phase helpers for the config store (drives send-button gating and banners). */
const markConnected = () => {
  useConfigStore.setState({ isConnected: true, hasEverConnected: true, connectionPhase: "connected" })
}

const markDisconnected = (reason: string) => {
  const { hasEverConnected } = useConfigStore.getState()
  useConfigStore.setState({
    isConnected: false,
    connectionPhase: hasEverConnected ? "reconnecting" : "connecting",
    lastDisconnectReason: reason,
  })
}

export function SyncProvider(props: {
  directory: string
  children: React.ReactNode
}) {
  const childStoresRef = useRef<ChildStoreManager | null>(null)
  if (!childStoresRef.current) childStoresRef.current = new ChildStoreManager()
  const childStores = childStoresRef.current

  // The workspace is a single fixed folder: events always target the active directory store.
  const directoryRef = useRef(props.directory)
  directoryRef.current = props.directory
  // True once the first bootstrap was applied and the event baseline set (see the event-source effect).
  const baselineReadyRef = useRef(false)

  const system = useMemo<SyncSystem>(
    () => ({ childStores, directory: props.directory }),
    [childStores, props.directory],
  )

  const resolveDirectory = useCallback(async (): Promise<string> => {
    if (directoryRef.current) return directoryRef.current
    const bootstrap = await loadBootstrap()
    return bootstrap.cwd
  }, [])

  // Configure child store manager
  useEffect(() => {
    const bootingDirs = new Set<string>()

    childStores.configure({
      onBootstrap: (directory) => {
        if (bootingDirs.has(directory)) return
        bootingDirs.add(directory)

        const store = childStores.getChild(directory)
        if (!store) {
          bootingDirs.delete(directory)
          return
        }

        // Before the event baseline exists the event-source chain applies the bootstrap to every
        // store (patch, then baseline, in one go). A store created afterwards must not reuse that
        // older cached response for live slices (sessions, status, prompts): ask the host again.
        if (!baselineReadyRef.current) {
          bootingDirs.delete(directory)
          return
        }

        void bootstrapDirectory({
          getState: () => store.getState(),
          set: (patch) => store.setState(patch),
          force: true,
        })
          .then((response) => {
            if (response) markConnected()
            else markDisconnected("claude:bootstrap failed")
          })
          .finally(() => {
            bootingDirs.delete(directory)
          })
      },
      onDispose: (directory) => {
        bootingDirs.delete(directory)
      },
      isBooting: (directory) => bootingDirs.has(directory),
      isLoadingSessions: () => false,
    })
  }, [childStores])

  // Global bootstrap: workspace project and synthetic provider.
  useEffect(() => {
    const globalActions = useGlobalSyncStore.getState().actions
    void bootstrapGlobal(globalActions.set).then((response) => {
      if (response) markConnected()
      else markDisconnected("claude:bootstrap failed")
    })
  }, [])

  // Event source — one subscription per mount. Gaps reload snapshots instead of replaying.
  useEffect(() => {
    /**
     * Apply a bootstrap response to every directory store. Callers set the event baseline right after
     * (synchronously), so replayed buffered pushes land on top of this state, never under it.
     */
    const applyBootstrapToStores = (response: Awaited<ReturnType<typeof fetchBootstrap>>) => {
      for (const store of childStores.children.values()) {
        store.setState({ ...buildDirectoryPatch(store.getState(), response), status: "complete" })
      }
    }

    const resyncAll = async (): Promise<number> => {
      const response = await fetchBootstrap(true)
      applyBootstrapToStores(response)
      // Snapshots are newer than the bootstrap. Each carries its own `eventSeq`, which makes the
      // source drop the session's already-reflected waiting events; the baseline stays at the
      // bootstrap seq so events for everything else (session list, other sessions) still replay.
      const loads: Promise<unknown>[] = []
      for (const store of childStores.children.values()) {
        for (const sessionId of Object.keys(store.getState().message)) {
          loads.push(loadSessionIntoStore(store, sessionId).catch(() => undefined))
        }
      }
      await Promise.all(loads)
      markConnected()
      return response.eventSeq
    }

    const source = createClaudeEventSource({
      subscribe: (listener) => claudeClient.subscribe(listener),
      onEvents: (events) => {
        const directory = directoryRef.current || getWorkspaceCwd()
        if (!directory) return
        for (const event of events) handleEvent(event, directory, childStores)
      },
      onGap: resyncAll,
    })
    const stopSnapshotSeq = onSessionSnapshotSeq((sessionId, eventSeq) => source.dropSessionEvents(sessionId, eventSeq))

    let cancelled = false
    baselineReadyRef.current = false
    void fetchBootstrap()
      .then((response) => {
        if (cancelled) return
        applyBootstrapToStores(response)
        baselineReadyRef.current = true
        source.setBaseline(response.eventSeq)
        markConnected()
      })
      .catch((error) => {
        console.warn("[sync] unable to establish event baseline", error)
        markDisconnected(error instanceof Error ? error.message : "claude:bootstrap failed")
        // Without a baseline pushes would buffer forever; the resync retries and sets it.
        if (!cancelled) {
          baselineReadyRef.current = true
          source.resync()
        }
      })

    // Host-reported connection state (connectionStatus message from the extension).
    const onConnectionStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ status?: string; error?: string }>).detail
      if (!detail?.status) return
      if (detail.status === "connected") {
        const wasConnected = useConfigStore.getState().isConnected
        markConnected()
        if (!wasConnected) source.resync()
      } else if (detail.status === "error" || detail.status === "disconnected") {
        markDisconnected(detail.error ?? detail.status)
      }
    }
    window.addEventListener("openchamber:connection-status", onConnectionStatus)

    return () => {
      cancelled = true
      stopSnapshotSeq()
      window.removeEventListener("openchamber:connection-status", onConnectionStatus)
      source.cleanup()
    }
  }, [childStores])

  // Ensure current directory's child store exists
  useEffect(() => {
    let cancelled = false
    void resolveDirectory().then((directory) => {
      if (!cancelled && directory) childStores.ensureChild(directory)
    })
    return () => {
      cancelled = true
    }
  }, [props.directory, childStores, resolveDirectory])

  // Set refs so non-React code (session-actions, session-ui-store) can access sync state
  useEffect(() => {
    setSyncRefs(childStores, props.directory)
    setActionRefs(childStores, () => claudeHost.getDirectory() || props.directory)
  }, [props.directory, childStores])

  // Subscribe to child store for streaming state derivation
  useEffect(() => {
    if (!props.directory) return
    const store = childStores.getChild(props.directory)
    if (!store) return
    const unsubscribe = store.subscribe((state) => {
      updateStreamingState(state)
    })
    return unsubscribe
  }, [props.directory, childStores])

  return <SyncContext.Provider value={system}>{props.children}</SyncContext.Provider>
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Access the global sync store */
export function useGlobalSync() {
  return useGlobalSyncStore()
}

/** Access the global sync store with a selector */
export function useGlobalSyncSelector<T>(selector: (state: GlobalSyncStore) => T): T {
  return useGlobalSyncStore(selector)
}

/** Get the child store for a directory (defaults to current) */
export function useDirectoryStore(directory?: string): StoreApi<DirectoryStore> {
  const system = useSyncSystem()
  const dir = directory ?? system.directory
  return system.childStores.ensureChild(dir)
}

/** Select from the current directory's store */
export function useDirectorySync<T>(selector: (state: State) => T, directory?: string): T {
  const store = useDirectoryStore(directory)
  return useStore(store, selector)
}

/** Get the revert messageID for a session (if reverted) */
export function useSessionRevertMessageID(sessionID: string, directory?: string): string | undefined {
  return useDirectorySync(
    useCallback((state: State) => {
      const session = state.session.find((s) => s.id === sessionID)
      return (session as { revert?: { messageID?: string } } | undefined)?.revert?.messageID
    }, [sessionID]),
    directory,
  )
}

/** Get session messages for a specific session */
export function useSessionMessages(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.message[sessionID] ?? EMPTY_MESSAGES, [sessionID]),
    directory,
  )
}

/**
 * Get visible session messages — filters out reverted messages.
 * Filters out reverted messages (id >= session.revert.messageID).
 */
export function useVisibleSessionMessages(sessionID: string, directory?: string) {
  const messages = useSessionMessages(sessionID, directory)
  const revertMessageID = useSessionRevertMessageID(sessionID, directory)
  return useMemo(() => {
    if (!revertMessageID) return messages
    return messages.filter((m) => m.id < revertMessageID)
  }, [messages, revertMessageID])
}

/** Check whether the message list for a session has been loaded into sync state. */
export function useSessionMessagesResolved(sessionID: string, directory?: string): boolean {
  return useDirectorySync(
    useCallback((state: State) => {
      if (!sessionID) return false
      return Object.prototype.hasOwnProperty.call(state.message, sessionID)
    }, [sessionID]),
    directory,
  )
}

/** Get parts for a specific message */
export function useSessionParts(messageID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.part[messageID] ?? EMPTY_PARTS, [messageID]),
    directory,
  )
}

/** Get status for a specific session */
export function useSessionStatus(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.session_status?.[sessionID], [sessionID]),
    directory,
  )
}

/** Get permissions for a specific session */
export function useSessionPermissions(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.permission[sessionID] ?? EMPTY_PERMISSION_REQUESTS, [sessionID]),
    directory,
  )
}

/** Get questions for a specific session */
export function useSessionQuestions(sessionID: string, directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.question[sessionID] ?? EMPTY_QUESTION_REQUESTS, [sessionID]),
    directory,
  )
}

/** Get sessions list for a directory */
export function useSessions(directory?: string) {
  return useDirectorySync(
    useCallback((state: State) => state.session, []),
    directory,
  )
}

const getSidebarSessionSignature = (session: Session, stableUpdatedAt: number): string => {
  const directory = (session as Session & { directory?: string | null }).directory ?? ''
  const parentID = (session as Session & { parentID?: string | null }).parentID ?? ''
  const projectWorktree = (session as Session & { project?: { worktree?: string | null } | null }).project?.worktree ?? ''
  const shared = session.share?.url ?? ''
  return [
    session.id,
    session.title ?? '',
    session.time?.created ?? 0,
    session.time?.archived ? 1 : 0,
    directory,
    parentID,
    projectWorktree,
    shared,
    stableUpdatedAt,
  ].join('|')
}

/** Get sessions stabilized for sidebar tree rendering */
export function useSidebarSessions(directory?: string): Session[] {
  const store = useDirectoryStore(directory)
  const cacheRef = React.useRef<{
    source: Session[]
    streamingSignature: string
    array: Session[]
    signatures: Map<string, string>
    sessionsById: Map<string, Session>
    stableUpdatedAtById: Map<string, number>
    streamingById: Map<string, boolean>
  } | null>(null)

  const getSnapshot = React.useCallback(() => {
    const state = store.getState()
    const source = state.session
    const cached = cacheRef.current
    const streamingSignature = source
      .map((session) => {
        const statusType = state.session_status?.[session.id]?.type
        const isStreaming = statusType === 'busy' || statusType === 'retry'
        return `${session.id}:${isStreaming ? 1 : 0}`
      })
      .join('|')

    if (cached && cached.source === source && cached.streamingSignature === streamingSignature) {
      return cached.array
    }

    const signatures = new Map<string, string>()
    const sessionsById = new Map<string, Session>()
    const stableUpdatedAtById = new Map<string, number>()
    const streamingById = new Map<string, boolean>()
    let changed = !cached || cached.array.length !== source.length

    const array = source.map((session) => {
      const rawUpdatedAt = Number(session.time?.updated ?? session.time?.created ?? 0)
      const statusType = state.session_status?.[session.id]?.type
      const isStreaming = statusType === 'busy' || statusType === 'retry'
      const cachedUpdatedAt = cached?.stableUpdatedAtById.get(session.id) ?? rawUpdatedAt
      const wasStreaming = cached?.streamingById.get(session.id) ?? false
      const stableUpdatedAt = isStreaming
        ? (wasStreaming ? cachedUpdatedAt : Math.max(rawUpdatedAt, cachedUpdatedAt, Date.now()))
        : cachedUpdatedAt
      const signature = getSidebarSessionSignature(session, stableUpdatedAt)
      signatures.set(session.id, signature)
      stableUpdatedAtById.set(session.id, stableUpdatedAt)
      streamingById.set(session.id, isStreaming)

      const cachedSession = cached?.sessionsById.get(session.id)
      if (
        cachedSession
        && cached?.signatures.get(session.id) === signature
      ) {
        sessionsById.set(session.id, cachedSession)
        return cachedSession
      }

      changed = true
      const nextSession = stableUpdatedAt === rawUpdatedAt
        ? session
        : {
            ...session,
            time: {
              ...session.time,
              updated: stableUpdatedAt,
            },
          }
      sessionsById.set(session.id, nextSession)
      return nextSession
    })

    if (!changed && cached) {
      cacheRef.current = {
        source,
        streamingSignature,
        array: cached.array,
        signatures,
        sessionsById: cached.sessionsById,
        stableUpdatedAtById,
        streamingById,
      }
      return cached.array
    }

    cacheRef.current = { source, streamingSignature, array, signatures, sessionsById, stableUpdatedAtById, streamingById }
    return array
  }, [store])

  return React.useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

/** Get one session by id for a directory */
export function useSession(sessionID?: string | null, directory?: string) {
  const { childStores } = useSyncSystem()
  const getSnapshot = useCallback(() => {
    if (directory) {
      return childStores.getChild(directory)?.getState().session.find((session) => session.id === sessionID)
    }
    return findLiveSession(getLiveStates(childStores), sessionID)
  }, [childStores, directory, sessionID])

  const subscribe = useCallback((notify: () => void) => {
    if (directory) {
      return childStores.ensureChild(directory).subscribe(notify)
    }
    return childStores.subscribeAll(notify)
  }, [childStores, directory])

  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Get one session directory by id for a directory */
export function useSessionDirectory(sessionID?: string | null, directory?: string): string | undefined {
  const session = useSession(sessionID, directory)
  return (session as (typeof session & { directory?: string | null }) | undefined)?.directory ?? undefined
}

/** Get the Claude host client (replaces the OpenCode SDK client). */
export function useSyncSDK() {
  useSyncSystem()
  return claudeClient
}

/** Get the current directory */
export function useSyncDirectory() {
  return useSyncSystem().directory
}

/** Get the child store manager (for advanced operations) */
export function useChildStoreManager() {
  return useSyncSystem().childStores
}

export type SessionTextMessage = {
  id: string
  role: string | null
  text: string
}

const getPartText = (part: Part): string => {
  if (part?.type !== "text") return ""
  const text = (part as { text?: unknown }).text
  return typeof text === "string" ? text : ""
}

const getConcatenatedTextFromParts = (parts: Part[]): string => {
  let text = ""
  for (const part of parts) {
    text += getPartText(part)
  }
  return text
}

const getFirstTextFromParts = (parts: Part[]): string => {
  for (const part of parts) {
    const text = getPartText(part)
    if (text.length > 0) return text
  }
  return ""
}

type SessionMessageRecord = { info: Message; parts: Part[] }

type SessionMessageRecordsSnapshot = {
  sessionID: string
  sourceMessages: Message[]
  visibleMessages: Message[]
  revertMessageID?: string
  list: SessionMessageRecord[]
  byId: Map<string, SessionMessageRecord>
}

function getVisibleMessagesForSession(state: State, sessionID: string, previous?: SessionMessageRecordsSnapshot): {
  sourceMessages: Message[]
  visibleMessages: Message[]
  revertMessageID?: string
} {
  const sourceMessages = state.message[sessionID] ?? EMPTY_MESSAGES
  const session = state.session.find((candidate) => candidate.id === sessionID)
  const revertMessageID = (session as { revert?: { messageID?: string } } | undefined)?.revert?.messageID

  if (
    previous
    && previous.sourceMessages === sourceMessages
    && previous.revertMessageID === revertMessageID
  ) {
    return {
      sourceMessages,
      visibleMessages: previous.visibleMessages,
      revertMessageID,
    }
  }

  return {
    sourceMessages,
    visibleMessages: revertMessageID ? sourceMessages.filter((message) => message.id < revertMessageID) : sourceMessages,
    revertMessageID,
  }
}

export function buildSessionMessageRecordsSnapshot(
  state: State,
  sessionID: string,
  previous?: SessionMessageRecordsSnapshot,
  suspendPartUpdates = false,
): SessionMessageRecordsSnapshot {
  const { sourceMessages, visibleMessages, revertMessageID } = getVisibleMessagesForSession(state, sessionID, previous)
  const nextById = new Map<string, SessionMessageRecord>()
  const nextList = visibleMessages.map((message) => {
    const previousRecord = previous?.byId.get(message.id)
    const parts = suspendPartUpdates && previousRecord
      ? previousRecord.parts
      : (state.part[message.id] ?? EMPTY_PARTS)

    const nextRecord = previousRecord && previousRecord.info === message && previousRecord.parts === parts
      ? previousRecord
      : { info: message, parts }

    nextById.set(message.id, nextRecord)
    return nextRecord
  })

  const unchanged = Boolean(previous)
    && previous?.visibleMessages === visibleMessages
    && previous.list.length === nextList.length
    && previous.list.every((record, index) => record === nextList[index])

  if (unchanged && previous) {
    return previous
  }

  return {
    sessionID,
    sourceMessages,
    visibleMessages,
    revertMessageID,
    list: nextList,
    byId: nextById,
  }
}

export function useSessionMessageCount(sessionID: string, directory?: string): number {
  return useDirectorySync(
    useCallback((state: State) => {
      if (!sessionID) return 0
      return state.message[sessionID]?.length ?? 0
    }, [sessionID]),
    directory,
  )
}

export function useSessionTextMessages(sessionID: string, directory?: string): SessionTextMessage[] {
  const records = useSessionMessageRecords(sessionID, directory)

  return useMemo(
    () => records.map((record) => ({
      id: record.info.id,
      role: typeof record.info.role === "string" ? record.info.role : null,
      text: getConcatenatedTextFromParts(record.parts),
    })),
    [records],
  )
}

export function useUserMessageHistory(sessionID: string, directory?: string): string[] {
  const records = useSessionMessageRecords(sessionID, directory)
  const userMessages = useMemo(() => records.filter((record) => record.info.role === 'user'), [records])

  return useMemo(() => {
    const history: string[] = []
    for (let index = userMessages.length - 1; index >= 0; index -= 1) {
      const message = userMessages[index]
      const text = getFirstTextFromParts(message.parts)
      if (text.length > 0) {
        history.push(text)
      }
    }
    return history
  }, [userMessages])
}

/**
 * Get messages for a session in the old {info, parts}[] format.
 * Uses visible messages (filtered by revert state).
 *
 * Uses a ref-stable parts lookup that only triggers re-renders when
 * a part array for one of our displayed messages actually changes.
 */
export function useSessionMessageRecords(
  sessionID: string,
  directory?: string,
  options?: { suspendPartUpdates?: boolean },
) {
  const store = useDirectoryStore(directory)
  const snapshotRef = useRef<SessionMessageRecordsSnapshot>({
    sessionID,
    sourceMessages: EMPTY_MESSAGES,
    visibleMessages: EMPTY_MESSAGES,
    revertMessageID: undefined,
    list: [],
    byId: new Map(),
  })

  const getSnapshot = useCallback(() => {
    const nextSnapshot = buildSessionMessageRecordsSnapshot(
      store.getState(),
      sessionID,
      snapshotRef.current.sessionID === sessionID ? snapshotRef.current : undefined,
      Boolean(options?.suspendPartUpdates),
    )
    snapshotRef.current = nextSnapshot
    return nextSnapshot.list
  }, [options?.suspendPartUpdates, sessionID, store])

  return React.useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

/**
 * Ensures a session's messages are loaded into the sync store.
 * If the session exists in state.session but messages haven't been fetched
 * (state.message[sessionID] is absent), triggers a background API fetch.
 *
 * This covers the case where a user navigates to an old parent session
 * whose child session messages were never loaded — bootstrap only loads
 * session metadata, not messages.
 */

// Module-level in-flight tracking for useEnsureSessionMessages.
// Prevents redundant parallel fetches when multiple component instances
// (e.g. multiple ToolParts) request the same session's messages.
const _ensureMessagesLoading = new Set<string>()

export function useEnsureSessionMessages(sessionID: string, directory?: string) {
  const store = useDirectoryStore(directory)

  React.useEffect(() => {
    if (!sessionID) return

    const state = store.getState()
    // Already loaded — nothing to do
    if (isSessionLoaded(store, sessionID)) return
    // Session doesn't exist — nothing to load
    if (!state.session.some((s) => s.id === sessionID)) return

    const dir = directory ?? claudeHost.getDirectory()
    const loadingKey = `${dir ?? ""}:${sessionID}`
    // Already loading this session for this directory
    if (_ensureMessagesLoading.has(loadingKey)) return

    _ensureMessagesLoading.add(loadingKey)

    void loadSessionIntoStore(store, sessionID)
      .catch(() => {
        // Transient failure — next navigation or resync will retry
      })
      .finally(() => {
        _ensureMessagesLoading.delete(loadingKey)
      })
  }, [sessionID, store, directory])
}

/**
 * Determines if a session is actively working.
 * Checks session_status and only falls back to incomplete assistant messages
 * when authoritative status is missing.
 * Returns false when permissions are pending (permission indicator takes priority).
 */
export function useIsSessionWorking(sessionID: string, directory?: string): boolean {
  const status = useSessionStatus(sessionID, directory)
  const permissions = useSessionPermissions(sessionID, directory)
  const messages = useSessionMessages(sessionID, directory)

  return useMemo(() => {
    // Permissions pending → not "working" (show permission indicator instead)
    if (permissions.length > 0) return false

    // Check session_status
    const hasAuthoritativeStatus = status !== undefined
    const statusWorking = hasAuthoritativeStatus && status.type !== "idle"

    // Check for incomplete assistant message (fallback if status event delayed)
    let hasPendingAssistant = false
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === "assistant" && typeof (m as { time?: { completed?: number } }).time?.completed !== "number") {
        hasPendingAssistant = true
        break
      }
    }

    if (hasAuthoritativeStatus) return statusWorking
    return hasPendingAssistant
  }, [status, permissions, messages])
}

const EMPTY_MESSAGES: Message[] = []
const EMPTY_PARTS: Part[] = []
const EMPTY_PERMISSION_REQUESTS: PermissionRequest[] = []
const EMPTY_QUESTION_REQUESTS: QuestionRequest[] = []
