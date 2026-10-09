// Core utilities
export { Binary } from "./binary"
export { retry, type RetryOptions } from "./retry"

// Types
export type { State, GlobalState, ProjectMeta, DirState, EvictPlan, DisposeCheck, ChildOptions } from "./types"
export {
  INITIAL_STATE,
  INITIAL_GLOBAL_STATE,
  MAX_DIR_STORES,
  DIR_IDLE_TTL_MS,
  SESSION_CACHE_LIMIT,
  SESSION_RECENT_LIMIT,
  SESSION_RECENT_WINDOW,
} from "./types"

// Eviction
export { pickDirectoriesToEvict, canDisposeDirectory } from "./eviction"

// Session cache
export { dropSessionCaches, pickSessionCacheEvictions } from "./session-cache"

// Event reducer
export { applyDirectoryEvent } from "./event-reducer"

// Host event source
export { createClaudeEventSource, type FlushHandler, type ClaudeEventSourceInput } from "./claude-event-source"

// Session snapshots
export { applySessionSnapshot, loadSessionIntoStore, isSessionLoaded } from "./session-snapshot"

// Stores
export { useGlobalSyncStore, type GlobalSyncStore } from "./global-sync-store"
export { ChildStoreManager, type DirectoryStore } from "./child-store"

// Bootstrap
export { bootstrapGlobal, bootstrapDirectory, buildDirectoryPatch } from "./bootstrap"

// React integration
export {
  SyncProvider,
  useGlobalSync,
  useGlobalSyncSelector,
  useDirectoryStore,
  useDirectorySync,
  useSessionMessages,
  useSessionMessageCount,
  useSessionMessagesResolved,
  useSessionParts,
  useSessionStatus,
  useSessionPermissions,
  useSessionQuestions,
  useSessions,
  useSyncSDK,
  useSyncDirectory,
  useChildStoreManager,
  useSessionMessageRecords,
  useEnsureSessionMessages,
  useSessionTextMessages,
  useUserMessageHistory,
  buildSessionMessageRecordsSnapshot,
} from "./sync-context"

// Sync operations
export { useSync } from "./use-sync"

// Prompt submission
export { usePromptSubmit, type SubmitInput } from "./submit"


// Streaming lifecycle
export {
  useStreamingStore,
  updateStreamingState,
  selectStreamingMessageId,
  selectMessageStreamState,
  selectIsStreaming,
  type StreamPhase,
  type MessageStreamState,
  type StreamingStore,
} from "./streaming"

// Session UI state
export {
  useSessionUIStore,
  type SessionUIState,
  type AttachedFile,
  type NewSessionDraftState,
} from "./session-ui-store"

// Input store (pending input, synthetic parts, attached files)
export { useInputStore, type SyntheticContextPart } from "./input-store"

// Viewport store (per-session scroll anchors, memory state)
export {
  useViewportStore,
  type SessionMemoryState,
  type ViewportState,
} from "./viewport-store"

// Sync refs (imperative access from non-React code)
export {
  setSyncRefs,
  getSyncChildStores,
  getSyncDirectory,
  getDirectoryState,
  getSyncSessions,
  getSyncMessages,
  getSyncParts,
  getSyncSessionStatus,
  getSyncPermissions,
  getSyncQuestions,
} from "./sync-refs"

// Persisted metadata caches
export {
  readDirCache,
  persistVcs,
  persistProjectMeta,
  persistIcon,
  clearDirCache,
  type PersistedDirCache,
} from "./persist-cache"

// Session mutation versioning
export {
  getSessionMutationVersion,
  bumpSessionMutationVersion,
  markSessionDeleted,
  isSessionMarkedDeleted,
  clearSessionDeleted,
  clearSessionMutationVersions,
} from "./session-mutation-version"

// Session actions
export {
  setActionRefs,
  createSession,
  deleteSession,
  deleteSessions,
  findDescendantSessionIds,
  archiveSession,
  updateSessionTitle,
  shareSession,
  unshareSession,
  abortCurrentOperation,
  respondToPermission,
  dismissPermission,
  respondToQuestion,
  rejectQuestion,
  revertToMessage,
  unrevertSession,
  forkFromMessage,
} from "./session-actions"
