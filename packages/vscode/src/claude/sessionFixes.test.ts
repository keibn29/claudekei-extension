/** Review fixes at session level: cancelled queued messages, stop watchdog turns, running tasks vs respawn / revert, committed cut. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_LOG_KEY } from './agentLog';
import { createHarness, STUB_INIT, until, type Harness } from './fakes';
import { REVERT_KEY } from './revertStore';
import type { ClaudeSession } from './ClaudeSession';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'claudekei-fixes-'));
  dirs.push(d);
  return d;
};

const sessionOf = (h: Harness, id: string): ClaudeSession => h.manager['sessions'].get(id)!;
const userUuids = (s: ClaudeSession) => s.getSnapshot().messages.filter((m) => m.role === 'user').map((m) => m.claudeUuid);

/** A finished turn followed by a background Agent run that is still running (the main turn is idle). */
async function idleWithRunningTask(fixture = 'multi-turn') {
  const h = createHarness(fixture, {}, STUB_INIT, { cwd: tmp() });
  await h.manager.bootstrap();
  const { id } = h.manager.create();
  await h.manager.send(id, { text: 'go' });
  const session = sessionOf(h, id);
  await until(() => session.lifecycle === 'live-idle', 3000);
  const mapper = session['mapper']!;
  session.publish(mapper.apply({ type: 'assistant', uuid: 'ua', parent_tool_use_id: null, message: { id: 'msg_bg', model: 'm', content: [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { description: 'd', prompt: 'p', subagent_type: 'helper', run_in_background: true } }] } }));
  session.publish(mapper.apply({ type: 'system', subtype: 'task_started', task_id: 'agbg', tool_use_id: 'toolu_bg', run_id: 'run_bg', prompt: 'p', is_backgrounded: true }));
  session.publish(mapper.apply({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }));
  expect(session.lifecycle).toBe('live-idle');
  expect(mapper.runningTasks()).toHaveLength(1);
  const endTask = () => session.publish(mapper.apply({ type: 'system', subtype: 'task_notification', task_id: 'agbg', tool_use_id: 'toolu_bg', run_id: 'run_bg', status: 'completed', summary: 'done' }));
  return { h, id, session, endTask };
}

describe('1: interrupt receipt cancelled[] removes the queued messages', () => {
  test('cancelled user messages disappear from the state, are announced and dropped from the agent log', async () => {
    const h = createHarness('subagents/stop-hang');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await h.manager.send(id, { text: 'go' });
    const session = sessionOf(h, id);
    await until(() => session.status.type === 'busy');
    await h.manager.send(id, { text: 'queued one' });
    await h.manager.send(id, { text: 'queued two' });
    const [first, second, third] = userUuids(session) as string[];
    expect(third).toBeDefined();
    const query = h.queries[1]!;
    query.interrupt = async () => ({ still_queued: [], cancelled: [second, third, 'cron-not-ours'] });
    h.pushes.length = 0;
    await h.manager.interrupt(id);
    h.broadcaster.flush();

    expect(userUuids(session)).toEqual([first]);
    const removed = h.pushes.flatMap((p) => p.events).filter((e) => e.type === 'message.removed');
    expect(removed).toHaveLength(2);
    const logged = (h.store.get(AGENT_LOG_KEY) as Record<string, { entries: Array<[string, unknown]> }>)[id]!.entries.map(([uuid]) => uuid);
    expect(logged).toEqual([first!]);
    // a reload no longer shows them either: nothing but the sent-and-kept message is in the state
    expect(session.getSnapshot().messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  test('a receipt without cancelled (older CLI) changes nothing', async () => {
    const h = createHarness('subagents/stop-hang');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await h.manager.send(id, { text: 'go' });
    const session = sessionOf(h, id);
    await until(() => session.status.type === 'busy');
    await h.manager.send(id, { text: 'queued' });
    await h.manager.interrupt(id);
    expect(userUuids(session)).toHaveLength(2);
  });
});

describe('2: the stop watchdog belongs to the turn it was armed for', () => {
  test('a new user message disarms it: nothing is stopped or closed afterwards', async () => {
    const h = createHarness('subagents/stop-hang');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await h.manager.send(id, { text: 'go' });
    const session = sessionOf(h, id);
    await until(() => session.status.type === 'busy' && session.state.sessions.get('sub_toolu_stop1')?.status.type === 'busy');
    const query = h.queries[1]!;
    await h.manager.interrupt(id);
    h.timers.advance(4000);
    expect(query.stopped).toEqual(['agentstop1']);
    await h.manager.send(id, { text: 'new turn' }); // starts a new turn: the old stop is history
    h.timers.advance(20_000);
    expect(query.closed).toBe(false);
    expect(query.stopped).toEqual(['agentstop1']);
  });

  test('stop with nothing running arms no watchdog', async () => {
    const h = createHarness('multi-turn');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await h.manager.send(id, { text: 'go' });
    const session = sessionOf(h, id);
    await until(() => session.lifecycle === 'live-idle', 3000);
    const timers = h.timers.pending;
    await h.manager.interrupt(id);
    expect(h.timers.pending).toBe(timers);
    h.timers.advance(20_000);
    expect(h.queries[1]!.closed).toBe(false);
  });
});

describe('4/5: running background subagents', () => {
  test('a stale config does not respawn while a task runs, and does once it ended', async () => {
    const { h, id, session, endTask } = await idleWithRunningTask();
    session.markConfigStale();
    await h.manager.send(id, { text: 'second' });
    await until(() => session.lifecycle === 'live-idle', 3000).catch(() => undefined);
    expect(session.spawnCount).toBe(1);
    expect(h.queries[1]!.closed).toBe(false);
    expect(session['configStale']).toBe(true);
    endTask();
    await until(() => session.lifecycle === 'live-idle', 3000);
    await h.manager.send(id, { text: 'third' });
    expect(session.spawnCount).toBe(2);
    expect(h.queries[1]!.closed).toBe(true);
    expect(session['configStale']).toBe(false);
  });

  test('revert treats running tasks as busy: interrupt + close, no respawn', async () => {
    const { h, id, session } = await idleWithRunningTask();
    const first = h.queries[1]!;
    const message = session.getSnapshot().messages.find((m) => m.role === 'user')!;
    await h.manager.revert(id, message.id);
    expect(first.interrupts).toBe(1);
    expect(first.interruptOptions).toEqual([{ cancelQueued: true }]);
    expect(first.closed).toBe(true);
    expect(h.queries).toHaveLength(2);
  });
});

const t = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
const prompt = (uuid: string, n: number, body: string) => ({ type: 'user', uuid, timestamp: t(n), message: { role: 'user', content: body } });
const answer = (id: string, uuid: string, n: number, body: string) => ({ type: 'assistant', uuid, timestamp: t(n), message: { id, model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: body }] } });
const summary = (uuid: string | undefined, n: number) => ({ type: 'user', ...(uuid ? { uuid } : {}), isCompactSummary: true, timestamp: t(n), message: { role: 'user', content: 'summary' } });

describe('3: revert target without a cuttable predecessor', () => {
  const setup = async (entries: unknown[]) => {
    const work = tmp();
    mkdirSync(work, { recursive: true });
    const h = createHarness('multi-turn', {}, STUB_INIT, { cwd: work });
    h.addTranscript('s1');
    h.api.history.set('s1', entries as never);
    await h.manager.bootstrap();
    const snap = await h.manager.load('s1');
    const id = (uuid: string) => snap.messages.find((m) => m.role === 'user' && m.claudeUuid === uuid)!.id;
    return { h, id };
  };

  test('only the first message of the conversation maps to "delete the transcript"; the rest is refused', async () => {
    // a compaction summary without a transcript uuid sits in front of the first real prompt
    const { h, id } = await setup([summary(undefined, 0), prompt('u1', 1, 'one'), answer('m1', 'a1', 2, 'A')]);
    await expect(h.manager.revert('s1', id('u1'))).rejects.toThrow('This message cannot be reverted');
    expect(h.store.get(REVERT_KEY)).toBeUndefined();
    expect(h.api.deleted).toEqual([]);
  });

  test('a compaction summary with a uuid is a valid cut point', async () => {
    const { h, id } = await setup([summary('sum1', 0), prompt('u1', 1, 'one'), answer('m1', 'a1', 2, 'A')]);
    await h.manager.revert('s1', id('u1'));
    expect(h.store.get(REVERT_KEY)).toEqual({ s1: { uuid: 'u1', resumeAt: 'sum1' } });
  });

  test('the very first message still reverts to a fresh start', async () => {
    const { h, id } = await setup([prompt('u1', 1, 'one'), answer('m1', 'a1', 2, 'A'), prompt('u2', 3, 'two'), answer('m2', 'a2', 4, 'B')]);
    await h.manager.revert('s1', id('u1'));
    expect(h.store.get(REVERT_KEY)).toEqual({ s1: { uuid: 'u1', resumeAt: null } });
  });
});

describe('7: a committed cut survives a reload until a process announced it', () => {
  const entries = [prompt('u1', 0, 'one'), answer('m1', 'a1', 1, 'A1'), prompt('u2', 2, 'two'), answer('m2', 'a2', 3, 'A2'), prompt('u3', 4, 'three'), answer('m3', 'a3', 5, 'A3')];

  test('commit keeps a committed marker; reload hides the cut messages and the next spawn resumes there; init clears it', async () => {
    const work = tmp();
    const h = createHarness((i) => (i === 1 ? 'revert/noinit' : 'multi-turn'), {}, STUB_INIT, { cwd: work });
    h.addTranscript('s1');
    h.api.history.set('s1', entries as never);
    await h.manager.bootstrap();
    const snap = await h.manager.load('s1');
    const u2 = snap.messages.find((m) => m.role === 'user' && m.claudeUuid === 'u2')!.id;
    await h.manager.revert('s1', u2);
    await h.manager.send('s1', { text: 'next' }); // commit; the process never announces itself
    const session = sessionOf(h, 's1');
    await until(() => h.queries[1]?.prompts.length === 1);
    expect(h.store.get(REVERT_KEY)).toEqual({ s1: { uuid: 'u2', resumeAt: 'a1', committed: true } });
    expect(session.hasRevert).toBe(false);

    // window reload: same state store, same transcript (it still contains the dead branch)
    const h2 = createHarness('multi-turn', {}, STUB_INIT, { cwd: work, shared: { store: h.store, api: h.api }, storageDir: h.storageDir });
    await h2.manager.bootstrap();
    const after = await h2.manager.load('s1');
    expect(after.messages.filter((m) => m.role === 'user').map((m) => m.claudeUuid)).toEqual(['u1']);
    expect(after.session.revert).toBeUndefined();
    expect(after.children).toEqual([]);

    await h2.manager.send('s1', { text: 'again' });
    const reloaded = sessionOf(h2, 's1');
    await until(() => reloaded.lifecycle === 'live-idle', 3000);
    const spawned = h2.queries.filter((q) => q.params.options.persistSession !== false);
    expect(spawned[0]!.params.options.resume).toBe('s1');
    expect(spawned[0]!.params.options.resumeSessionAt).toBe('a1');
    expect(reloaded['resumeAt']).toBeUndefined();
    await until(() => (h.store.get(REVERT_KEY) as Record<string, unknown>)['s1'] === undefined);
  });

  test('a committed marker whose cut no longer exists in the transcript is dropped', async () => {
    const work = tmp();
    const h = createHarness('multi-turn', {}, STUB_INIT, { cwd: work });
    h.addTranscript('s1');
    h.api.history.set('s1', entries as never);
    h.store.set(REVERT_KEY, { s1: { uuid: 'u2', resumeAt: 'ghost', committed: true } });
    await h.manager.bootstrap();
    const snap = await h.manager.load('s1');
    expect(snap.messages.filter((m) => m.role === 'user')).toHaveLength(3);
    expect(h.store.get(REVERT_KEY)).toEqual({});
    expect(h.logs.some((l) => l.level === 'warn' && /committed revert cut/.test(l.message))).toBe(true);
  });
});
