/** Test-only helpers: fixture loading, deterministic clock, fixture driver and state normalization. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeEvent } from '@openchamber/ui/src/lib/claude/protocol';
import type { Message, Part, PermissionMode } from '@openchamber/ui/src/lib/claude/types';
import { createMapper, type AliasResolver, type Mapper, type MapperHooks, type MapperLogLevel } from './mapper';
import { bucketFor, createSessionState, reduceEvents, type SessionBucket, type SessionState } from './sessionState';

export const FIXTURES = join(import.meta.dir, '__fixtures__');

export type FixtureLine = Record<string, any>;

export function loadNdjson(name: string): FixtureLine[] {
  return readFileSync(join(FIXTURES, `${name}.ndjson`), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export function loadJson<T = any>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

/** Clock that advances 1 ms per call: ids/times are deterministic and strictly increasing. */
export function fakeClock(start = 1_700_000_000_000): () => number {
  let t = start;
  return () => t++;
}

export type RunResult = {
  mapper: Mapper;
  state: SessionState;
  main: SessionBucket;
  events: ClaudeEvent[];
  logs: Array<{ level: MapperLogLevel; message: string; data?: unknown }>;
  inits: number;
  sessionId: string;
};

/**
 * Plays a recorded fixture the way the W3 pump will: `_input` lines become `startUserMessage`, raw SDK messages go
 * through `apply`, other synthetic lines are ignored, and the end of the stream calls `finish`.
 */
export function runFixture(name: string, hooks?: MapperHooks, extra: { aliases?: AliasResolver; now?: () => number } = {}): RunResult {
  const lines = loadNdjson(name);
  const options = lines.find((l) => l.type === '_options')?.options ?? {};
  const init = lines.find((l) => l.type === 'system' && l.subtype === 'init');
  const sessionId: string = init?.session_id ?? options.sessionId ?? 'sess';
  const logs: RunResult['logs'] = [];
  let inits = 0;
  const mapper = createMapper({
    sessionId,
    cwd: init?.cwd ?? '/work',
    mode: (options.permissionMode ?? 'default') as PermissionMode,
    model: options.model ?? 'haiku',
    agent: options.agent,
    aliases: extra.aliases,
    now: extra.now ?? fakeClock(),
    log: (level, message, data) => logs.push({ level, message, data }),
    hooks: { ...hooks, onInit: (i) => { inits++; hooks?.onInit?.(i); } },
  });
  const state = createSessionState(sessionId);
  const events: ClaudeEvent[] = [];
  const feed = (batch: ClaudeEvent[]) => {
    events.push(...batch);
    reduceEvents(state, batch);
  };
  for (const line of lines) {
    if (line.type === '_input') {
      feed(mapper.startUserMessage({ content: line.message.message.content, uuid: line.message.uuid }).events);
    } else if (typeof line.type === 'string' && line.type.startsWith('_')) {
      continue;
    } else {
      feed(mapper.apply(line));
    }
  }
  feed(mapper.finish('ended'));
  return { mapper, state, main: bucketFor(state, sessionId), events, logs, inits, sessionId };
}

/** All tool parts of every session in the state. */
export function allToolParts(state: SessionState): Array<Extract<Part, { type: 'tool' }>> {
  const result: Array<Extract<Part, { type: 'tool' }>> = [];
  for (const bucket of state.sessions.values()) {
    for (const m of bucket.messages) {
      for (const p of bucket.parts[m.id] ?? []) if (p.type === 'tool') result.push(p);
    }
  }
  return result;
}

/** Ids in the order the events first mention them (messages and parts share one ascending sequence). */
export function creationOrderIds(events: readonly ClaudeEvent[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const note = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  };
  for (const e of events) {
    if (e.type === 'message.updated') note(e.properties.info.id);
    else if (e.type === 'message.part.updated') note(e.properties.part.id);
  }
  return order;
}

const stripTimes = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripTimes);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'time') continue;
      out[k] = stripTimes(v);
    }
    return out;
  }
  return value;
};

/** Snapshot-friendly view of a bucket: ids replaced by stable aliases, times dropped. */
export function normalizeBucket(bucket: SessionBucket): unknown {
  const alias = new Map<string, string>();
  const a = (id: string | undefined, prefix: string): string | undefined => {
    if (!id) return id;
    if (!alias.has(id)) alias.set(id, `${prefix}${alias.size + 1}`);
    return alias.get(id);
  };
  const messages = bucket.messages.map((m: Message) => {
    const clean = stripTimes(m) as Record<string, any>;
    clean.id = a(m.id, 'm');
    if ('parentID' in clean) clean.parentID = a(clean.parentID, 'm');
    delete clean.sessionID;
    return {
      ...clean,
      parts: (bucket.parts[m.id] ?? []).map((p) => {
        const c = stripTimes(p) as Record<string, any>;
        c.id = a(p.id, 'p');
        c.messageID = a(p.messageID, 'm');
        delete c.sessionID;
        return c;
      }),
    };
  });
  return { messages, todos: bucket.todos, status: bucket.status };
}
