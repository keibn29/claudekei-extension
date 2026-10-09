/**
 * JSONL history -> domain state (docs/PHASE1_PLAN.md section 2 "History").
 *
 * `getSessionMessages` entries are fed through the same mapper as live messages, in replay mode: timestamps and ids
 * come from the transcript, user prompts are materialized, no status events are produced. Subagent transcripts
 * (`listSubagents` / `getSubagentMessages`, W0 finding) are replayed into their `sub_<toolUseId>` child sessions.
 * Tool outputs above 100 KB are truncated (`metadata.truncated`).
 */
import type { ClaudeEvent } from '@openchamber/ui/src/lib/claude/protocol';
import type { EffortLevel, PermissionMode } from '@openchamber/ui/src/lib/claude/types';
import type { TurnRecord } from './agentLog';
import type { IdGenerator } from './ids';
import { createMapper, type AliasResolver, type MapperLogLevel } from './mapper';
import { createSessionState, reduceEvents, type SessionState } from './sessionState';

/** Shape of `SessionMessage` as returned at runtime (the d.ts lists fewer fields). */
export type HistoryEntry = {
  type: 'user' | 'assistant' | 'system';
  uuid: string;
  session_id?: string;
  message?: unknown;
  parent_tool_use_id?: string | null;
  parent_agent_id?: string | null;
  timestamp?: string;
  isCompactSummary?: boolean;
  is_meta?: boolean;
  isCompletedLocalCommand?: boolean;
};

export type HistorySdk = {
  getSessionMessages(sessionId: string, options?: { dir?: string; includeSystemMessages?: boolean }): Promise<HistoryEntry[]>;
  listSubagents(sessionId: string, options?: { dir?: string }): Promise<string[]>;
  getSubagentMessages(sessionId: string, agentId: string, options?: { dir?: string }): Promise<HistoryEntry[]>;
};

export type ReplayOptions = {
  sessionId: string;
  cwd: string;
  /** Mode / model / agent recorded on replayed user messages (the transcript does not store them). */
  mode: PermissionMode;
  model: string;
  agent?: string;
  /** Host-recorded agent per user turn (see agentLog.ts); optional. */
  userAgents?: { byUuid: ReadonlyMap<string, string | TurnRecord>; initial?: string };
  /** The session's current effort: fallback `model.variant` for turns without a record. */
  effort?: EffortLevel | null;
  ids?: IdGenerator;
  now?: () => number;
  /** Default 100 KB. */
  maxToolOutputChars?: number;
  /** Plugin alias lookups (claudekei state file), optional. */
  aliases?: AliasResolver;
  log?: (level: MapperLogLevel, message: string, data?: unknown) => void;
};

export type HistorySnapshot = {
  /** Main session plus virtual subagent children (`sub_<toolUseId>`); read buckets with `bucketFor`. */
  state: SessionState;
  /** Every event the replay produced (tests / diagnostics). */
  events: ClaudeEvent[];
};

export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 100 * 1024;

/** Entries that carry no replayable content (system markers have no `message`). */
const replayable = (entry: HistoryEntry): boolean => entry.type !== 'system' && entry.message !== undefined && entry.message !== null;

const byTimestamp = (a: HistoryEntry, b: HistoryEntry): number => (Date.parse(a.timestamp ?? '') || 0) - (Date.parse(b.timestamp ?? '') || 0);

/**
 * Pure replay of already-loaded entries (used by `loadHistory` and tests).
 * `subagentEntries` are the transcripts of subagents (each entry's `parent_tool_use_id` routes it to its child session).
 */
export type SubagentTranscript = readonly HistoryEntry[] | { agentId: string; entries: readonly HistoryEntry[] };

export function replayEntries(entries: readonly HistoryEntry[], options: ReplayOptions, subagentEntries: readonly SubagentTranscript[] = []): HistorySnapshot {
  const mapper = createMapper({
    sessionId: options.sessionId,
    cwd: options.cwd,
    mode: options.mode,
    model: options.model,
    agent: options.agent,
    userAgents: options.userAgents,
    effort: options.effort,
    now: options.now,
    ids: options.ids,
    log: options.log,
    aliases: options.aliases,
    replay: true,
    maxToolOutputChars: options.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS,
  });
  const state = createSessionState(options.sessionId);
  const events: ClaudeEvent[] = [];
  const feed = (batch: ClaudeEvent[]): void => {
    events.push(...batch);
    reduceEvents(state, batch);
  };

  const transcripts = subagentEntries.map((sub): { agentId?: string; entries: readonly HistoryEntry[] } => (Array.isArray(sub) ? { entries: sub as readonly HistoryEntry[] } : (sub as { agentId: string; entries: readonly HistoryEntry[] })));
  // agentId <-> owner Agent tool: every entry of a subagent transcript carries the owner's tool_use id.
  for (const t of transcripts) {
    const owner = t.entries.find((e) => e.parent_tool_use_id)?.parent_tool_use_id;
    if (t.agentId && owner) mapper.registerAgent(t.agentId, owner);
  }
  for (const entry of entries) if (replayable(entry)) feed(mapper.apply(entry));
  // Subagent transcripts after the main one, so the `Agent` tool calls (and child sessions) already exist.
  for (const sub of transcripts) {
    for (const entry of [...sub.entries].sort(byTimestamp)) {
      if (!replayable(entry)) continue;
      if (!entry.parent_tool_use_id) {
        options.log?.('debug', 'subagent history entry without parent_tool_use_id skipped', { uuid: entry.uuid });
        continue;
      }
      feed(mapper.apply(entry));
    }
  }
  feed(mapper.finish('ended'));

  return { state, events };
}

async function defaultSdk(): Promise<HistorySdk> {
  // The SDK is ESM-only and external to the bundle; see docs/W0_SPIKE_NOTES.md section 5.
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk as unknown as HistorySdk;
}

export type LoadHistoryOptions = ReplayOptions & {
  /** Injected SDK helpers (tests). Defaults to the real SDK. */
  sdk?: HistorySdk;
  /** Replay subagent transcripts into child sessions. Default true. */
  includeSubagents?: boolean;
};

/** Loads a session transcript with the SDK and replays it. Missing sessions yield an empty snapshot. */
export async function loadHistory(options: LoadHistoryOptions): Promise<HistorySnapshot> {
  const sdk = options.sdk ?? (await defaultSdk());
  const dir = options.cwd;
  const entries = await sdk.getSessionMessages(options.sessionId, { dir });
  const subagents: SubagentTranscript[] = [];
  if (options.includeSubagents !== false && entries.length > 0) {
    try {
      const agentIds = await sdk.listSubagents(options.sessionId, { dir });
      subagents.push(
        ...(await Promise.all(agentIds.map(async (agentId) => ({ agentId, entries: await sdk.getSubagentMessages(options.sessionId, agentId, { dir }) })))),
      );
    } catch (error) {
      options.log?.('warn', 'could not load subagent history', { error: error instanceof Error ? error.message : String(error) });
    }
  }
  return replayEntries(entries, options, subagents);
}
