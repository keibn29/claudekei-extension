import { useCallback, useRef, useMemo } from "react"
import { Binary } from "./binary"
import { SESSION_CACHE_LIMIT } from "./types"
import { pickSessionCacheEvictions } from "./session-cache"
import { useDirectoryStore, useSyncDirectory, useChildStoreManager } from "./sync-context"
import { dropSessionCaches } from "./session-cache"
import { forgetLoadedSessions, isSessionLoaded, loadSessionIntoStore } from "./session-snapshot"
import { clearSessionPrefetch } from "./session-prefetch-cache"

const MAX_SEEN_DIRS = 30

// ---------------------------------------------------------------------------
// useSync — session loading. `claude:session.load` returns the whole session, so there is no
// message paging and no optimistic layer.
// ---------------------------------------------------------------------------

export function useSync() {
  const directory = useSyncDirectory()
  const store = useDirectoryStore()
  const childStores = useChildStoreManager()

  // Refs for mutable tracking (no re-renders)
  const inflight = useRef(new Map<string, Promise<void>>())
  const seen = useRef(new Map<string, Set<string>>())

  const keyFor = useCallback(
    (sessionID: string) => `${directory}\n${sessionID}`,
    [directory],
  )

  // Session cache eviction — two levels of LRU:
  // (1) across directories (max 30), (2) within a directory (SESSION_CACHE_LIMIT).

  // Evict all cached session data for given IDs from a directory's store
  const evict = useCallback(
    (dir: string, sessionIDs: string[]) => {
      if (sessionIDs.length === 0) return
      const dirStore = childStores.getChild(dir)
      if (!dirStore) return

      const current = dirStore.getState()
      const draft = {
        message: { ...current.message },
        part: { ...current.part },
        session_status: { ...current.session_status },
        session_diff: { ...current.session_diff },
        todo: { ...current.todo },
        permission: { ...current.permission },
        question: { ...current.question },
      }
      dropSessionCaches(draft, sessionIDs)
      dirStore.setState(draft)

      forgetLoadedSessions(dirStore, sessionIDs)
      clearSessionPrefetch(dir, sessionIDs)
    },
    [childStores],
  )

  // Get or create the seen-set for a directory. LRU reorder on access.
  // When seen directories exceed MAX_SEEN_DIRS, evict the oldest directory's caches.
  const seenFor = useCallback(() => {
    const existing = seen.current.get(directory)
    if (existing) {
      // LRU reorder: delete + re-insert moves to end (most recent)
      seen.current.delete(directory)
      seen.current.set(directory, existing)
      return existing
    }
    const created = new Set<string>()
    seen.current.set(directory, created)

    while (seen.current.size > MAX_SEEN_DIRS) {
      const first = seen.current.keys().next().value
      if (!first) break
      const staleSessionIds = [...(seen.current.get(first) ?? [])]
      seen.current.delete(first)
      evict(first, staleSessionIds)
    }

    return created
  }, [directory, evict])

  // Touch a session — triggers both directory-level and session-level eviction
  const touch = useCallback(
    (sessionID: string) => {
      const s = seenFor()
      const stale = pickSessionCacheEvictions({
        seen: s,
        keep: sessionID,
        limit: SESSION_CACHE_LIMIT,
      })
      evict(directory, stale)
    },
    [directory, seenFor, evict],
  )

  // Sync a session (load the snapshot if not cached)
  const syncSession = useCallback(
    async (sessionID: string, force?: boolean) => {
      touch(sessionID)
      const key = keyFor(sessionID)

      // Dedup inflight requests
      const existing = inflight.current.get(key)
      if (existing) return existing

      const current = store.getState()
      const cached = isSessionLoaded(store, sessionID)
      const hasSession = Binary.search(current.session, sessionID, (s) => s.id).found
      // Cached sessions stay current through the event stream; only force reloads them.
      if (cached && hasSession && !force) return

      const promise = loadSessionIntoStore(store, sessionID)
        .then(() => undefined)
        .catch((error) => {
          console.error("[sync] failed to load session", sessionID, error)
        })

      inflight.current.set(key, promise)
      promise.finally(() => inflight.current.delete(key))
      return promise
    },
    [store, keyFor, touch],
  )

  const isLoading = useCallback(
    (sessionID: string) => inflight.current.has(keyFor(sessionID)),
    [keyFor],
  )

  return useMemo(
    () => ({ syncSession, isLoading }),
    [syncSession, isLoading],
  )
}
