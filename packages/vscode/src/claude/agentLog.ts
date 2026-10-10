/**
 * Per-session record of which agent each user turn was sent with (`claudeUuid -> agent`).
 *
 * The transcript does not store the main-thread agent, so replayed user messages would all carry the session's current
 * agent and the "Switched to <Agent>" divider (derived from consecutive `UserMessage.agent` values) would vanish after a
 * reload. The host keeps this small map in its Memento-like store, bounded per session, and history replay reads it.
 */

import type { EffortLevel } from '@openchamber/ui/src/lib/claude/types';

export type AgentLogStore = {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): PromiseLike<void> | Promise<void>;
};

/**
 * What one user turn ran with. `effort: null` = model default (known); `effort` undefined = not recorded (legacy
 * entries), which replay treats as unknown. `model` is the selected model value.
 */
export type TurnRecord = { agent: string; effort?: EffortLevel | null; model?: string };

/** Persisted shape: `entries` keeps send order so the oldest can be dropped. Old entries are plain agent strings. */
export type SessionAgentLog = {
  /** The agent label the session first ran with (fallback for turns sent before this log existed). */
  initial?: string;
  entries: Array<[uuid: string, turn: string | TurnRecord]>;
};

/** What history replay needs. */
export type ReplayAgents = { byUuid: ReadonlyMap<string, string | TurnRecord>; initial?: string };

/** Normalizes a persisted entry (legacy string or record). */
export const turnRecordOf = (entry: string | TurnRecord): TurnRecord => (typeof entry === 'string' ? { agent: entry } : entry);

export const AGENT_LOG_KEY = 'claudekei.sessionAgents';
export const MAX_AGENT_LOG_ENTRIES = 500;

export class AgentLog {
  constructor(
    private readonly store: AgentLogStore,
    private readonly limit = MAX_AGENT_LOG_ENTRIES,
  ) {}

  private all(): Record<string, SessionAgentLog> {
    return this.store.get<Record<string, SessionAgentLog>>(AGENT_LOG_KEY, {});
  }

  private write(all: Record<string, SessionAgentLog>): void {
    void this.store.update(AGENT_LOG_KEY, all);
  }

  /** Replay input for one session; undefined when nothing is recorded. */
  forReplay(sessionId: string): ReplayAgents | undefined {
    const log = this.all()[sessionId];
    if (!log) return undefined;
    return { byUuid: new Map(log.entries), ...(log.initial ? { initial: log.initial } : {}) };
  }

  /** Records what a user turn was sent with. */
  record(sessionId: string, uuid: string, turn: string | TurnRecord): void {
    const all = this.all();
    const log: SessionAgentLog = { ...all[sessionId], entries: [...(all[sessionId]?.entries ?? []), [uuid, turn]] };
    if (log.entries.length > this.limit) log.entries = log.entries.slice(-this.limit);
    this.write({ ...all, [sessionId]: log });
  }

  /** A user turn that never ran (cancelled while queued): its record must not outlive the message. */
  forget(sessionId: string, uuid: string): void {
    const all = this.all();
    const log = all[sessionId];
    if (!log?.entries.some(([id]) => id === uuid)) return;
    this.write({ ...all, [sessionId]: { ...log, entries: log.entries.filter(([id]) => id !== uuid) } });
  }

  /** Remembers the agent of the first spawn; later calls are ignored. */
  noteInitial(sessionId: string, agent: string): void {
    const all = this.all();
    if (all[sessionId]?.initial) return;
    this.write({ ...all, [sessionId]: { ...all[sessionId], entries: all[sessionId]?.entries ?? [], initial: agent } });
  }

  /** Session deleted. */
  remove(sessionId: string): void {
    const all = this.all();
    if (!(sessionId in all)) return;
    const { [sessionId]: _dropped, ...rest } = all;
    this.write(rest);
  }
}
