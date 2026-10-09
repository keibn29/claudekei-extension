/**
 * Fan-out of `ClaudeEvent`s to webviews (D7): events are buffered per webview and pushed as
 * `{type:'claude:events', seq, events}` at most every `batchMs` (16 ms). Consecutive text deltas for the same part are
 * coalesced. `seq` is per webview, strictly increasing by 1, with no ack or retry (a gap makes the webview reload).
 */
import { CLAUDE_EVENTS_PUSH_TYPE, type ClaudeEvent, type ClaudeEventsPush } from '@openchamber/ui/src/lib/claude/protocol';

export type EventSink = {
  /** Posts a message to the webview. May return a promise/thenable (ignored). */
  post(message: ClaudeEventsPush): unknown;
};

export type BroadcasterOptions = {
  batchMs?: number;
  /** Injectable timers (tests). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onSinkError?: (id: string, error: unknown) => void;
};

type SinkState = { id: string; sink: EventSink; seq: number; pending: ClaudeEvent[] };

const partKey = (e: Extract<ClaudeEvent, { type: 'message.part.delta' }>): string =>
  `${e.properties.sessionID}\u0000${e.properties.messageID}\u0000${e.properties.partID}\u0000${e.properties.field}`;

/**
 * Merges consecutive deltas of the same part. A `message.part.updated` of that part is a barrier (the full part
 * replaces earlier text, later deltas must stay after it). Pure; exported for tests.
 */
export function coalesceEvents(events: readonly ClaudeEvent[]): ClaudeEvent[] {
  const out: ClaudeEvent[] = [];
  const open = new Map<string, number>(); // delta key -> index in `out`
  for (const event of events) {
    if (event.type === 'message.part.delta') {
      const key = partKey(event);
      const at = open.get(key);
      if (at !== undefined) {
        const target = out[at] as Extract<ClaudeEvent, { type: 'message.part.delta' }>;
        out[at] = { type: 'message.part.delta', properties: { ...target.properties, delta: target.properties.delta + event.properties.delta } };
      } else {
        open.set(key, out.length);
        out.push(event);
      }
      continue;
    }
    if (event.type === 'message.part.updated') {
      const part = event.properties.part;
      for (const field of ['text']) open.delete(`${part.sessionID}\u0000${part.messageID}\u0000${part.id}\u0000${field}`);
    }
    out.push(event);
  }
  return out;
}

/** Session an event belongs to (undefined for global events such as catalog/account updates). */
export function eventSessionId(e: ClaudeEvent): string | undefined {
  switch (e.type) {
    case 'message.part.updated':
      return e.properties.part.sessionID;
    case 'message.updated':
      return e.properties.info.sessionID;
    case 'catalog.updated':
    case 'account.updated':
    case 'usage.updated':
      return undefined;
    default:
      return (e.properties as { sessionID?: string }).sessionID;
  }
}

export class Broadcaster {
  private readonly sinks = new Map<string, SinkState>();
  private readonly batchMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timer: unknown;
  private counter = 0;

  constructor(private readonly options: BroadcasterOptions = {}) {
    this.batchMs = options.batchMs ?? 16;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** Registers a webview. Returns its id and an unregister function. */
  register(sink: EventSink): { id: string; dispose: () => void } {
    const id = `sink_${++this.counter}`;
    this.sinks.set(id, { id, sink, seq: 0, pending: [] });
    return { id, dispose: () => this.unregister(id) };
  }

  unregister(id: string): void {
    this.sinks.delete(id);
  }

  get sinkCount(): number {
    return this.sinks.size;
  }

  /** Queues events for every webview and schedules a flush. */
  emit(events: readonly ClaudeEvent[]): void {
    if (events.length === 0 || this.sinks.size === 0) return;
    for (const state of this.sinks.values()) state.pending.push(...events);
    if (this.timer === undefined) {
      this.timer = this.setTimer(() => {
        this.timer = undefined;
        this.flush();
      }, this.batchMs);
    }
  }

  /** Sends all pending batches now. */
  flush(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    for (const state of [...this.sinks.values()]) this.push(state);
  }

  private push(state: SinkState): void {
    if (state.pending.length === 0) return;
    const events = coalesceEvents(state.pending);
    state.pending = [];
    state.seq += 1;
    try {
      const result = state.sink.post({ type: CLAUDE_EVENTS_PUSH_TYPE, seq: state.seq, events });
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        (result as Promise<unknown>).catch((error) => this.options.onSinkError?.(state.id, error));
      }
    } catch (error) {
      this.options.onSinkError?.(state.id, error);
    }
  }

  /**
   * Snapshot barrier for one webview: pushes its pending events now (they are already reflected in the host state a
   * snapshot is built from, so they must reach the webview *before* the snapshot response) and returns the webview's
   * last pushed `seq` (`eventSeq`). Call it synchronously with building the snapshot.
   */
  flushSink(sinkId: string | undefined): number {
    const state = sinkId ? this.sinks.get(sinkId) : undefined;
    if (!state) return 0;
    this.push(state);
    return state.seq;
  }
}
