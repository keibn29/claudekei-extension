import { describe, expect, test } from 'bun:test';
import type { UserMessage } from '@openchamber/ui/src/lib/claude/types';
import { AGENT_LOG_KEY, AgentLog } from './agentLog';
import { createHarness, until, type Harness } from './fakes';
import { replayEntries, type HistoryEntry } from './history';
import { bucketFor } from './sessionState';
import { fakeClock, loadJson } from './testUtils';

const memento = () => {
  const data = new Map<string, unknown>();
  return { data, store: { get: ((k: string, d?: unknown) => (data.has(k) ? data.get(k) : d)) as never, update: async (k: string, v: unknown) => void data.set(k, v) } };
};

const userEntry = (uuid: string, text: string, n: number): HistoryEntry => ({ type: 'user', uuid, timestamp: `2026-01-01T00:00:${String(n * 2).padStart(2, '0')}.000Z`, message: { role: 'user', content: text } });
const assistantEntry = (uuid: string, text: string, n: number): HistoryEntry => ({ type: 'assistant', uuid, timestamp: `2026-01-01T00:00:${String(n * 2 + 1).padStart(2, '0')}.000Z`, message: { id: `msg_${uuid}`, model: 'm', content: [{ type: 'text', text }] } });
const transcript = (): HistoryEntry[] => ['u1', 'u2', 'u3', 'u4'].flatMap((u, i) => [userEntry(u, `q${i + 1}`, i), assistantEntry(`a${i + 1}`, `r${i + 1}`, i)]);
const agentsOf = (entries: HistoryEntry[], userAgents?: { byUuid: ReadonlyMap<string, string>; initial?: string }) => {
  const snap = replayEntries(entries, { sessionId: 's', cwd: '/w', mode: 'default', model: 'm', agent: 'current', userAgents, now: fakeClock() });
  return bucketFor(snap.state, 's').messages.filter((m): m is UserMessage => m.role === 'user').map((m) => m.agent);
};

describe('AgentLog store', () => {
  test('records per session, bounded to the newest entries, noteInitial only once, remove drops the session', () => {
    const { data, store } = memento();
    const log = new AgentLog(store, 3);
    for (let i = 1; i <= 5; i++) log.record('s1', `u${i}`, `a${i}`);
    log.record('s2', 'x', 'ax');
    log.noteInitial('s1', 'first');
    log.noteInitial('s1', 'second');
    log.noteInitial('s3', 'only');
    const replay = log.forReplay('s1')!;
    expect([...replay.byUuid.keys()]).toEqual(['u3', 'u4', 'u5']);
    expect(replay.initial).toBe('first');
    expect(log.forReplay('s3')!.byUuid.size).toBe(0);
    expect(log.forReplay('nope')).toBeUndefined();
    log.remove('s1');
    expect(log.forReplay('s1')).toBeUndefined();
    expect(Object.keys(data.get(AGENT_LOG_KEY) as object).sort()).toEqual(['s2', 's3']);
  });
});

describe('replay with a recorded agent map', () => {
  test('each main user message takes its recorded agent (the divider is derivable)', () => {
    const agents = agentsOf(transcript(), { byUuid: new Map([['u1', 'A'], ['u2', 'A'], ['u3', 'B'], ['u4', 'A']]) });
    expect(agents).toEqual(['A', 'A', 'B', 'A']);
  });

  test('unknown turns carry the nearest earlier known agent, then initial, then the current agent', () => {
    expect(agentsOf(transcript(), { byUuid: new Map([['u2', 'A'], ['u4', 'B']]), initial: 'first' })).toEqual(['first', 'A', 'A', 'B']);
    expect(agentsOf(transcript(), { byUuid: new Map([['u2', 'A']]) })).toEqual(['current', 'A', 'A', 'A']);
    expect(agentsOf(transcript(), { byUuid: new Map(), initial: 'first' })).toEqual(['first', 'first', 'first', 'first']);
    expect(agentsOf(transcript())).toEqual(['current', 'current', 'current', 'current']);
  });

  test('child (subagent) sessions are unaffected', () => {
    type Dump = { sessionId: string; main: HistoryEntry[]; subagents: Record<string, HistoryEntry[]> };
    const dump = loadJson<Dump>('subagents/history-q2-sendmessage-sync.json');
    const run = (userAgents?: { byUuid: ReadonlyMap<string, string>; initial?: string }) => {
      const snap = replayEntries(dump.main, { sessionId: dump.sessionId, cwd: '/x', mode: 'default', model: 'm', agent: 'current', userAgents, now: fakeClock() }, Object.entries(dump.subagents).map(([agentId, entries]) => ({ agentId, entries })));
      const child = [...snap.state.sessions.entries()].find(([id]) => id !== dump.sessionId)![1];
      return child.messages.filter((m): m is UserMessage => m.role === 'user').map((m) => [m.agent, m.instruction?.fromAgent]);
    };
    const every = new Map(dump.main.filter((e) => e.type === 'user').map((e) => [e.uuid as string, 'ZZZ']));
    expect(run({ byUuid: every, initial: 'ZZZ' })).toEqual(run());
  });
});

describe('effort (model.variant) and model per turn', () => {
  const run = (userAgents: { byUuid: ReadonlyMap<string, string | { agent: string; effort?: string | null; model?: string }>; initial?: string } | undefined, current: { effort?: 'low' | 'high' | null; model?: string } = {}) => {
    const snap = replayEntries(transcript(), { sessionId: 's', cwd: '/w', mode: 'default', model: current.model ?? 'cur-model', agent: 'current', effort: current.effort as never, userAgents: userAgents as never, now: fakeClock() });
    return bucketFor(snap.state, 's').messages.filter((m): m is UserMessage => m.role === 'user').map((m) => [m.model.modelID, m.model.variant]);
  };

  test('recorded per-turn effort and model are replayed; a recorded model default stays omitted', () => {
    const rows = run({
      byUuid: new Map([
        ['u1', { agent: 'A', effort: 'high', model: 'opus' }],
        ['u2', { agent: 'A', effort: null, model: 'opus' }],
        ['u3', { agent: 'B', effort: 'low', model: 'sonnet' }],
        ['u4', { agent: 'B', effort: 'low', model: 'haiku' }],
      ]),
    }, { effort: 'high', model: 'cur-model' });
    expect(rows).toEqual([['opus', 'high'], ['opus', undefined], ['sonnet', 'low'], ['haiku', 'low']]);
  });

  test('fallbacks: nearest earlier known, then the current effort/model; legacy string entries carry no effort/model', () => {
    const rows = run({ byUuid: new Map<string, string | { agent: string; effort?: string | null; model?: string }>([['u2', { agent: 'A', effort: 'low', model: 'opus' }], ['u3', 'B']]) }, { effort: 'high', model: 'cur-model' });
    // u1: nothing earlier -> current; u2 known; u3 legacy -> carries u2's; u4 unknown -> carries
    expect(rows).toEqual([['cur-model', 'high'], ['opus', 'low'], ['opus', 'low'], ['opus', 'low']]);
    // entirely legacy log: current effort and model everywhere
    const legacy = run({ byUuid: new Map([['u1', 'A'], ['u2', 'B']]) }, { effort: 'high', model: 'cur-model' });
    expect(legacy.every((r) => r[0] === 'cur-model' && r[1] === 'high')).toBe(true);
    // no log at all: the current effort applies, none when the session runs on the model default
    expect(run(undefined, { effort: 'low' }).every((r) => r[1] === 'low')).toBe(true);
    expect(run(undefined, { effort: null }).every((r) => r[1] === undefined)).toBe(true);
  });

  test('child (subagent) messages never carry a variant', () => {
    type Dump = { sessionId: string; main: HistoryEntry[]; subagents: Record<string, HistoryEntry[]> };
    const dump = loadJson<Dump>('subagents/history-q2-sendmessage-sync.json');
    const every = new Map(dump.main.filter((e) => e.type === 'user').map((e) => [e.uuid as string, { agent: 'Z', effort: 'high', model: 'opus' }]));
    const snap = replayEntries(dump.main, { sessionId: dump.sessionId, cwd: '/x', mode: 'default', model: 'm', effort: 'high', userAgents: { byUuid: every as never }, now: fakeClock() }, Object.entries(dump.subagents).map(([agentId, entries]) => ({ agentId, entries })));
    const child = [...snap.state.sessions.entries()].find(([id]) => id !== dump.sessionId)![1];
    const users = child.messages.filter((m): m is UserMessage => m.role === 'user');
    expect(users.length).toBeGreaterThan(0);
    expect(users.every((m) => m.model.variant === undefined && m.model.modelID === 'm')).toBe(true);
  });
});

describe('manager persistence', () => {
  const sendAndSettle = async (h: Harness, id: string, text: string, extra: Record<string, unknown> = {}) => {
    await h.manager.send(id, { text, ...extra } as never);
    await until(() => h.manager['sessions'].get(id)!.lifecycle === 'live-idle', 3000);
    h.broadcaster.flush();
  };
  const stored = (h: Harness) => h.store.get(AGENT_LOG_KEY) as Record<string, { initial?: string; entries: Array<[string, string | Record<string, unknown>]> }> | undefined;

  test('sends are recorded, survive a cold reload and a restart, and are dropped on delete', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'one', { agent: 'claudekei:sprinter' });
    await sendAndSettle(h, id, 'two', { agent: 'claudekei:planner' });
    await sendAndSettle(h, id, 'three');

    const uuids = h.queries.flatMap((q) => q.prompts.map((p) => p.uuid as string));
    expect(uuids).toHaveLength(3);
    expect(stored(h)![id]!.entries).toEqual([
      [uuids[0]!, { agent: 'claudekei:sprinter', effort: null, model: 'default' }],
      [uuids[1]!, { agent: 'claudekei:planner', effort: null, model: 'default' }],
      [uuids[2]!, { agent: 'claudekei:planner', effort: null, model: 'default' }],
    ]);
    expect(stored(h)![id]!.initial).toBe('claudekei:sprinter');

    // Transcript as the SDK would return it (it records the supplied uuids, not the agents).
    h.addTranscript(id);
    h.api.history.set(id, uuids.flatMap((u, i) => [
      { type: 'user', uuid: u, timestamp: `2026-01-01T00:00:0${i * 2}.000Z`, message: { role: 'user', content: `m${i}` } },
      { type: 'assistant', uuid: `a${i}`, timestamp: `2026-01-01T00:00:0${i * 2 + 1}.000Z`, message: { id: `msg_${i}`, model: 'm', content: [{ type: 'text', text: 'ok' }] } },
    ]));
    await h.manager.restartSessions();
    h.manager['sessions'].get(id)!['loaded'] = false; // force a replay instead of the live state
    const snap = await h.manager.load(id);
    expect(snap.messages.filter((m) => m.role === 'user').map((m) => (m as UserMessage).agent)).toEqual(['claudekei:sprinter', 'claudekei:planner', 'claudekei:planner']);

    await h.manager.delete(id);
    expect(stored(h)![id]).toBeUndefined();
  });

  const modelsOf = (messages: Array<{ role: string }>) => messages.filter((m) => m.role === 'user').map((m) => [(m as UserMessage).model.modelID, (m as UserMessage).model.variant]);

  test('live: model.variant is the effort in effect for the turn, modelID the selected model; both survive a cold reload; legacy entries still read', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'one', { agent: 'claudekei:sprinter', model: 'haiku', effort: 'high' });
    await sendAndSettle(h, id, 'two', { effort: null });
    await sendAndSettle(h, id, 'three', { model: 'sonnet', effort: 'low' });
    const live = (await h.manager.load(id)).messages;
    expect(modelsOf(live)).toEqual([['haiku', 'high'], ['haiku', undefined], ['sonnet', 'low']]);
    expect(stored(h)![id]!.entries.map(([, t]) => t)).toEqual([
      { agent: 'claudekei:sprinter', effort: 'high', model: 'haiku' },
      { agent: 'claudekei:sprinter', effort: null, model: 'haiku' },
      { agent: 'claudekei:sprinter', effort: 'low', model: 'sonnet' },
    ]);
    // after the session's current prefs moved on, the replay still shows what each turn ran with
    await h.manager.setEffort(id, 'max');
    await h.manager.setModel(id, 'opus');
    const uuids = h.queries.flatMap((q) => q.prompts.map((p) => p.uuid as string));
    h.addTranscript(id);
    h.api.history.set(id, uuids.flatMap((u, i) => [
      { type: 'user', uuid: u, timestamp: `2026-01-01T00:00:0${i * 2}.000Z`, message: { role: 'user', content: `m${i}` } },
      { type: 'assistant', uuid: `a${i}`, timestamp: `2026-01-01T00:00:0${i * 2 + 1}.000Z`, message: { id: `msg_${i}`, model: 'm', content: [{ type: 'text', text: 'ok' }] } },
    ]));
    await h.manager.restartSessions();
    h.manager['sessions'].get(id)!['loaded'] = false;
    expect(modelsOf((await h.manager.load(id)).messages)).toEqual([['haiku', 'high'], ['haiku', undefined], ['sonnet', 'low']]);

    // a log written before this change (plain agent strings): agents still replay, effort/model fall back to the current ones
    h.store.set('claudekei.sessionAgents', { [id]: { initial: 'claudekei:sprinter', entries: uuids.map((u) => [u, 'claudekei:sprinter']) } });
    h.manager['sessions'].get(id)!['loaded'] = false;
    const legacy = (await h.manager.load(id)).messages;
    expect(legacy.filter((m) => m.role === 'user').map((m) => (m as UserMessage).agent)).toEqual(['claudekei:sprinter', 'claudekei:sprinter', 'claudekei:sprinter']);
    expect(modelsOf(legacy)).toEqual([['opus', 'max'], ['opus', 'max'], ['opus', 'max']]);
  });

  test('a fork carries only the first agent (the SDK remaps uuids)', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'one', { agent: 'claudekei:sprinter' });
    h.addTranscript(id);
    const fork = await h.manager.fork(id);
    expect(stored(h)![fork.id]).toEqual({ initial: 'claudekei:sprinter', entries: [] });
  });
});
