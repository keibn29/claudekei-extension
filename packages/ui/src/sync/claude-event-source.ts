/**
 * Claude event source: receives `claude:events` batches from the extension host, checks `seq`
 * continuity, coalesces high-frequency events and flushes them to the reducer once per frame.
 *
 *   const source = createClaudeEventSource({ subscribe, onEvents, onGap })
 *   source.setBaseline(bootstrap.eventSeq)   // after claude:bootstrap
 *   ...
 *   source.cleanup()
 *
 * Delivery rules (docs/PHASE1_PLAN.md D7):
 * - Pushes are not acked or retried, so a skipped `seq` means lost events.
 * - A gap calls `onGap`, which must reload snapshots and resolve to the new baseline seq.
 * - Pushes arriving before the baseline is known, or while a reload is running, are buffered and
 *   replayed (duplicates older than the baseline are dropped).
 */

import type { ClaudeEvent, ClaudeEventsPush } from "@/lib/claude/protocol"
import { syncDebug } from "./debug"

export type FlushHandler = (events: ClaudeEvent[]) => void

const FLUSH_FRAME_MS = 33
const MAX_RESYNC_ATTEMPTS = 5
const RESYNC_RETRY_BASE_MS = 1000

export type ClaudeEventSourceInput = {
  subscribe: (listener: (push: ClaudeEventsPush) => void) => () => void
  /** Receives coalesced events, in order, once per flush. */
  onEvents: FlushHandler
  /** Reload snapshots after a gap. Resolve with the `eventSeq` the reloaded state reflects. */
  onGap: () => Promise<number | void> | number | void
}

const deltaKey = (messageID: string, partID: string, field: string) => `${messageID}:${partID}:${field}`

/** Session an event belongs to, when it is session-scoped. */
export const eventSessionId = (event: ClaudeEvent): string | undefined => {
  switch (event.type) {
    case "message.part.updated":
      return event.properties.part.sessionID
    case "catalog.updated":
    case "account.updated":
      return undefined
    default:
      return (event.properties as { sessionID?: string }).sessionID
  }
}

const coalesceKey = (event: ClaudeEvent): string | undefined => {
  switch (event.type) {
    case "session.status":
      // Keyed by status type too: busy -> idle must stay two events so the turn-complete
      // notification (which needs to see the busy state first) still fires.
      return `session.status:${event.properties.sessionID}:${event.properties.status.type}`
    case "todo.updated":
      return `todo.updated:${event.properties.sessionID}`
    case "message.part.updated":
      return `message.part.updated:${event.properties.part.messageID}:${event.properties.part.id}`
    case "message.part.delta": {
      const { messageID, partID, field } = event.properties
      return `message.part.delta:${deltaKey(messageID, partID, field)}`
    }
    default:
      return undefined
  }
}

export function createClaudeEventSource(input: ClaudeEventSourceInput) {
  const { subscribe, onEvents, onGap } = input

  type QueueItem = { event: ClaudeEvent; seq: number }
  let queue: QueueItem[] = []
  const coalesced = new Map<string, number>()
  /** Stale delta keys -> owning session (so a snapshot can forget the marks of the events it drops). */
  const staleDeltas = new Map<string, string | undefined>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastFlush = 0

  let lastSeq: number | undefined
  let pending: ClaudeEventsPush[] = []
  let resyncing = false
  let resyncAttempt = 0
  let resyncTimer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const flush = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
    if (queue.length === 0) return

    const events = queue.map((item) => item.event)
    const stale = staleDeltas.size > 0 ? new Set(staleDeltas.keys()) : undefined
    queue = []
    coalesced.clear()
    staleDeltas.clear()

    lastFlush = Date.now()
    syncDebug.pipeline.flush(events.length)
    const delivered = stale
      ? events.filter((event) => {
          if (event.type !== "message.part.delta") return true
          const { messageID, partID, field } = event.properties
          return !stale.has(deltaKey(messageID, partID, field))
        })
      : events
    onEvents(delivered)
  }

  const schedule = () => {
    if (timer) return
    const elapsed = Date.now() - lastFlush
    timer = setTimeout(flush, Math.max(0, FLUSH_FRAME_MS - elapsed))
  }

  const enqueue = (event: ClaudeEvent, seq: number) => {
    const key = coalesceKey(event)
    if (key) {
      const index = coalesced.get(key)
      if (index !== undefined) {
        if (event.type === "message.part.delta") {
          const previous = queue[index].event as Extract<ClaudeEvent, { type: "message.part.delta" }>
          queue[index] = {
            seq,
            event: {
              ...event,
              properties: { ...event.properties, delta: previous.properties.delta + event.properties.delta },
            },
          }
        } else {
          queue[index] = { event, seq }
          if (event.type === "message.part.updated") {
            // A full part replaces earlier streamed text: drop deltas already folded into it.
            const { part } = event.properties
            staleDeltas.set(deltaKey(part.messageID, part.id, "text"), part.sessionID)
            staleDeltas.set(deltaKey(part.messageID, part.id, "output"), part.sessionID)
          }
        }
        syncDebug.pipeline.coalesced(event.type, key)
        return
      }
      coalesced.set(key, queue.length)
    }
    queue.push({ event, seq })
    schedule()
  }

  /**
   * A `session.load` snapshot with `eventSeq` already reflects every event of that session up to
   * that seq. Forget such events that are still waiting (UI queue or resync buffer) so they are not
   * applied again on top of the snapshot.
   */
  const dropSessionEvents = (sessionId: string, upToSeq: number) => {
    const dropped = (item: QueueItem) => item.seq <= upToSeq && eventSessionId(item.event) === sessionId
    if (queue.some(dropped)) {
      queue = queue.filter((item) => !dropped(item))
      coalesced.clear()
      queue.forEach((item, index) => {
        const key = coalesceKey(item.event)
        if (key) coalesced.set(key, index)
      })
    }
    for (const [key, owner] of staleDeltas) {
      if (owner === sessionId) staleDeltas.delete(key)
    }
    pending = pending
      .map((push) =>
        push.seq <= upToSeq
          ? { ...push, events: push.events.filter((event) => eventSessionId(event) !== sessionId) }
          : push,
      ) // pushes stay (possibly empty): removing one would look like a seq gap on replay
  }

  const triggerResync = () => {
    if (resyncing || disposed) return
    resyncing = true
    // Everything received so far is in order and valid; apply it before the snapshot lands.
    flush()

    const attempt = async () => {
      try {
        const seq = await onGap()
        if (disposed) return
        resyncing = false
        resyncAttempt = 0
        if (typeof seq === "number") {
          setBaseline(seq)
        } else {
          // Host gave no baseline: continue from the newest buffered push.
          const newest = pending.reduce((max, push) => Math.max(max, push.seq), -1)
          pending = []
          lastSeq = newest >= 0 ? newest : lastSeq
        }
      } catch (error) {
        if (disposed) return
        resyncAttempt += 1
        console.warn(`[claude-events] snapshot reload failed (attempt ${resyncAttempt})`, error)
        if (resyncAttempt >= MAX_RESYNC_ATTEMPTS) {
          resyncing = false
          resyncAttempt = 0
          const newest = pending.reduce((max, push) => Math.max(max, push.seq), -1)
          pending = []
          if (newest >= 0) lastSeq = newest
          return
        }
        resyncTimer = setTimeout(() => void attempt(), RESYNC_RETRY_BASE_MS * resyncAttempt)
      }
    }
    void attempt()
  }

  const handle = (push: ClaudeEventsPush) => {
    if (lastSeq === undefined) {
      pending.push(push)
      return
    }
    if (push.seq <= lastSeq) return // already reflected in the baseline
    if (push.seq !== lastSeq + 1) {
      pending.push(push)
      triggerResync()
      return
    }
    lastSeq = push.seq
    for (const event of push.events) enqueue(event, push.seq)
  }

  const onPush = (push: ClaudeEventsPush) => {
    if (disposed) return
    if (resyncing) {
      pending.push(push)
      return
    }
    handle(push)
  }

  function setBaseline(seq: number) {
    lastSeq = seq
    const replay = pending.sort((a, b) => a.seq - b.seq)
    pending = []
    for (const push of replay) {
      if (resyncing) {
        pending.push(push)
        continue
      }
      handle(push)
    }
  }

  const unsubscribe = subscribe(onPush)

  return {
    /** Declare the seq reflected by the latest snapshot and replay buffered pushes after it. */
    setBaseline,
    /** Apply queued events now. */
    flush,
    /** Forget waiting events of a session that a snapshot (taken at `upToSeq`) already contains. */
    dropSessionEvents,
    /** Start a snapshot reload as if a gap had been detected (buffers pushes until it resolves). */
    resync: triggerResync,
    cleanup: () => {
      disposed = true
      unsubscribe()
      if (resyncTimer) clearTimeout(resyncTimer)
      flush()
    },
  }
}
