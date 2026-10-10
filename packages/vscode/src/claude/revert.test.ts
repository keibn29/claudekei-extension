/** Host side of revert / undo / redo (docs/REVERT_SPEC.md sections 3 and 7). */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleClaudeBridgeMessage } from '../bridge-claude-runtime';
import { allEvents, createHarness, STUB_INIT, tick, until, type Harness } from './fakes';
import { REVERT_KEY } from './revertStore';
import type { ClaudeSessionManager } from './ClaudeSessionManager';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const t = (n: number) => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
const text = (id: string, uuid: string, n: number, body: string) => ({ type: 'assistant', uuid, timestamp: t(n), message: { id, model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: body }] } });
const prompt = (uuid: string, n: number, body: string) => ({ type: 'user', uuid, timestamp: t(n), message: { role: 'user', content: body } });

/** u1 a1 | u2 a2(Agent) r2 a2b | u3 a3, with one subagent transcript owned by the Agent call of turn 2. */
const seed = (h: Harness, id = 's1') => {
  h.addTranscript(id);
  h.api.history.set(id, [
    prompt('u1', 0, 'one'),
    text('msg_1', 'a1', 1, 'A1'),
    prompt('u2', 2, 'two'),
    { type: 'assistant', uuid: 'a2', timestamp: t(3), message: { id: 'msg_2', model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_ag', name: 'Agent', input: { description: 'd', prompt: 'p', subagent_type: 'helper' } }] } },
    { type: 'user', uuid: 'r2', timestamp: t(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_ag', content: 'sub done' }] } },
    text('msg_2b', 'a2b', 5, 'A2'),
    prompt('u3', 6, 'three'),
    text('msg_3', 'a3', 7, 'A3'),
  ]);
  h.api.subagents.set(id, {
    'agent-1': [
      { type: 'user', uuid: 's1', parent_tool_use_id: 'toolu_ag', timestamp: t(3), message: { role: 'user', content: [{ type: 'text', text: 'p' }] } },
      { type: 'assistant', uuid: 's2', parent_tool_use_id: 'toolu_ag', timestamp: t(4), message: { id: 'msg_s', model: 'm', content: [{ type: 'text', text: 'sub reply' }] } },
    ],
  });
};

const setup = async (fixture: string | ((i: number) => string) = 'multi-turn') => {
  const base = mkdtempSync(join(tmpdir(), 'claudekei-revert-'));
  dirs.push(base);
  const work = join(base, 'work');
  mkdirSync(work, { recursive: true });
  const h = createHarness(fixture, {}, STUB_INIT, { cwd: work });
  seed(h);
  await h.manager.bootstrap();
  const snap = await h.manager.load('s1');
  /** Host message id of the user message with this transcript uuid. */
  const id = (uuid: string) => snap.messages.find((m) => m.role === 'user' && m.claudeUuid === uuid)!.id;
  const file = (name: string, body: string) => {
    const path = join(work, name);
    writeFileSync(path, body);
    return path;
  };
  const session = () => h.manager['sessions'].get('s1')!;
  const procs = () => h.queries.filter((q) => q.params.options.persistSession !== false);
  const markers = () => (h.store.get(REVERT_KEY) ?? {}) as Record<string, unknown>;
  const copies = join(h.storageDir, 'revert', 's1');
  const sessionUpdates = () => (h.broadcaster.flush(), allEvents(h).filter((e) => e.type === 'session.updated' && e.properties.sessionID === 's1')) as Array<{ properties: { info: { revert?: { messageID: string } } } }>;
  const settle = async () => {
    await until(() => session().lifecycle === 'live-idle', 3000);
    h.broadcaster.flush();
  };
  return { h, snap, id, file, work, session, procs, markers, copies, sessionUpdates, settle };
};

describe('revert (docs/REVERT_SPEC.md section 7, item 2)', () => {
  test('a: a cold revert spawns one plain resume, dry run before real, sets the marker and announces it', async () => {
    const { h, id, file, procs, markers, copies, sessionUpdates } = await setup();
    const a = file('a.txt', 'head');
    h.rewind.set('u2', { dry: { canRewind: true, filesChanged: [a], insertions: 1, deletions: 2 }, apply: () => writeFileSync(a, 'old') });
    const result = await h.manager.revert('s1', id('u2'));
    expect(result).toEqual({ files: ['a.txt'] });
    expect(procs()).toHaveLength(1);
    expect(procs()[0]!.params.options.resume).toBe('s1');
    expect(procs()[0]!.params.options.resumeSessionAt).toBeUndefined();
    expect(procs()[0]!.params.options.enableFileCheckpointing).toBe(true);
    expect(h.rewindLog.map((c) => [c.uuid, c.dryRun])).toEqual([['u2', true], ['u2', false]]);
    expect(markers()).toEqual({ s1: { uuid: 'u2', resumeAt: 'a1' } });
    expect(sessionUpdates().at(-1)!.properties.info.revert).toEqual({ messageID: id('u2') });
    expect(readFileSync(a, 'utf8')).toBe('old');
    expect(readFileSync(join(copies, '0'), 'utf8')).toBe('head'); // the copy that /redo writes back
    // nothing was truncated yet: the hidden messages are still in the host state
    expect((await h.manager.load('s1')).messages.some((m) => m.id === id('u3'))).toBe(true);
  });

  test('b: reverting a busy turn interrupts and closes the process first, then rewinds on a fresh one', async () => {
    const { h, id, session, procs } = await setup('subagents/stop-hang');
    await h.manager.send('s1', { text: 'go' });
    await until(() => session().status.type === 'busy' && session().state.sessions.get('sub_toolu_stop1')?.status.type === 'busy');
    const busy = procs()[0]!;
    h.rewind.set('u2', { dry: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 } });
    const result = await h.manager.revert('s1', id('u2'));
    expect(result).toEqual({ files: [] });
    expect(busy.interrupts).toBe(1);
    expect(busy.interruptOptions).toEqual([{ cancelQueued: true }]);
    expect(busy.closed).toBe(true);
    expect(busy.rewindCalls).toEqual([]);
    expect(procs()).toHaveLength(2);
    expect(procs()[1]!.rewindCalls.map((c) => c.dryRun)).toEqual([true, false]);
    // the interrupted turn ended cleanly
    expect(session().state.sessions.get('sub_toolu_stop1')?.status).toEqual({ type: 'idle' });
    expect(session().status).toEqual({ type: 'idle' });
  });

  test('c: canRewind false reverts the conversation only: filesError, no copies, marker set', async () => {
    const { h, id, procs, markers, copies, sessionUpdates } = await setup();
    h.rewind.set('u2', { dry: { canRewind: false, error: 'No file checkpoint found for this message.' } });
    const result = await h.manager.revert('s1', id('u2'));
    expect(result).toEqual({ files: [], filesError: 'No file checkpoint found for this message.' });
    expect(h.rewindLog.map((c) => c.dryRun)).toEqual([true]); // no real rewind
    expect(existsSync(copies)).toBe(false);
    expect(markers()).toEqual({ s1: { uuid: 'u2', resumeAt: 'a1' } });
    expect(sessionUpdates().at(-1)!.properties.info.revert).toEqual({ messageID: id('u2') });
    expect(procs()).toHaveLength(1);
  });

  test('d: the next send closes the process, resumes at the cut and removes everything hidden in ONE batch', async () => {
    const { h, snap, id, file, procs, markers, copies, session, settle } = await setup();
    expect(snap.children.map((c) => c.id)).toEqual(['sub_toolu_ag']);
    const a = file('a.txt', 'head');
    h.rewind.set('u2', { dry: { canRewind: true, filesChanged: [a], insertions: 0, deletions: 0 }, apply: () => writeFileSync(a, 'old') });
    await h.manager.revert('s1', id('u2'));
    const reverted = procs()[0]!;
    h.pushes.length = 0;

    await h.manager.send('s1', { text: 'next' });
    await settle();
    expect(reverted.closed).toBe(true);
    expect(procs()).toHaveLength(2);
    expect(procs()[1]!.params.options.resume).toBe('s1');
    expect(procs()[1]!.params.options.resumeSessionAt).toBe('a1'); // last entry of the kept turn
    // `init` arrived: the cut is in the transcript now
    expect(session()['resumeAt']).toBeUndefined();

    const batches = h.pushes.filter((p) => p.events.some((e) => e.type === 'message.removed'));
    expect(batches).toHaveLength(1);
    const events = batches[0]!.events;
    const removed = events.filter((e) => e.type === 'message.removed').map((e) => (e as { properties: { messageID: string } }).properties.messageID);
    expect(removed.sort()).toEqual(snap.messages.filter((m) => m.id >= id('u2')).map((m) => m.id).sort());
    expect(removed.length).toBeGreaterThanOrEqual(5);
    expect(events.filter((e) => e.type === 'session.deleted').map((e) => (e as { properties: { sessionID: string } }).properties.sessionID)).toEqual(['sub_toolu_ag']);
    const updated = events.filter((e) => e.type === 'session.updated' && e.properties.sessionID === 's1').at(-1) as { properties: { info: { revert?: unknown } } };
    expect(updated.properties.info.revert).toBeUndefined();

    expect(markers()).toEqual({});
    expect(existsSync(copies)).toBe(false);
    const after = await h.manager.load('s1');
    expect(after.session.revert).toBeUndefined();
    expect(after.children).toEqual([]);
    expect(after.messages.filter((m) => m.role === 'user').map((m) => m.claudeUuid).slice(0, 1)).toEqual(['u1']);
    expect(after.messages.some((m) => removed.includes(m.id))).toBe(false);
    // the new prompt is a later message than everything that was kept
    expect(after.messages.at(-1)!.id > id('u1')).toBe(true);
  });

  test('e: reverting the first message deletes the transcript on the next send and starts a fresh session under the same id', async () => {
    const { h, id, procs, markers, session, settle } = await setup();
    await h.manager.revert('s1', id('u1'));
    expect(markers()).toEqual({ s1: { uuid: 'u1', resumeAt: null } });
    expect(h.api.deleted).toEqual([]);

    await h.manager.send('s1', { text: 'fresh start' });
    await settle();
    expect(h.api.deleted).toEqual(['s1']);
    expect(procs()).toHaveLength(2);
    expect(procs()[1]!.params.options.sessionId).toBe('s1');
    expect(procs()[1]!.params.options.resume).toBeUndefined();
    expect(procs()[1]!.params.options.resumeSessionAt).toBeUndefined();
    expect(session().exists).toBe(true); // the new process announced itself
    const after = await h.manager.load('s1');
    expect(after.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(markers()).toEqual({});
  });

  test('f: unrevert writes the saved files back without spawning anything and shows the messages again', async () => {
    const { h, id, file, procs, markers, copies, sessionUpdates } = await setup();
    const a = file('a.txt', 'head');
    const created = join(h.manager.cwd, 'made-by-turn.txt'); // does not exist at the reverted point
    h.rewind.set('u2', { dry: { canRewind: true, filesChanged: [a, created], insertions: 0, deletions: 0 }, apply: () => writeFileSync(a, 'old') });
    writeFileSync(created, 'created');
    await h.manager.revert('s1', id('u2'));
    rmSync(created); // the rewind deleted the file the turn created
    const spawns = procs().length;
    await h.manager.unrevert('s1');
    expect(readFileSync(a, 'utf8')).toBe('head');
    expect(readFileSync(created, 'utf8')).toBe('created');
    expect(procs()).toHaveLength(spawns);
    expect(markers()).toEqual({});
    expect(existsSync(copies)).toBe(false);
    expect(sessionUpdates().at(-1)!.properties.info.revert).toBeUndefined();
    await h.manager.unrevert('s1'); // no marker: a no-op
    expect((await h.manager.load('s1')).session.revert).toBeUndefined();
  });

  test('g: undo X, then an earlier Y, then unrevert restores the head state of both files', async () => {
    const { h, id, file, procs, markers } = await setup();
    const a = file('a.txt', 'a-head');
    const b = file('b.txt', 'b-head');
    h.rewind.set('u3', { dry: { canRewind: true, filesChanged: [b], insertions: 0, deletions: 0 }, apply: () => writeFileSync(b, 'b@u3') });
    h.rewind.set('u2', { dry: { canRewind: true, filesChanged: [a, b], insertions: 0, deletions: 0 }, apply: () => (writeFileSync(a, 'a@u2'), writeFileSync(b, 'b@u2')) });
    await h.manager.revert('s1', id('u3'));
    await h.manager.revert('s1', id('u2'));
    expect(markers()).toEqual({ s1: { uuid: 'u2', resumeAt: 'a1' } });
    expect([readFileSync(a, 'utf8'), readFileSync(b, 'utf8')]).toEqual(['a@u2', 'b@u2']);
    await h.manager.unrevert('s1');
    expect([readFileSync(a, 'utf8'), readFileSync(b, 'utf8')]).toEqual(['a-head', 'b-head']);
    expect(procs()).toHaveLength(1);
  });

  test('h: undo Y, then a later Z, then unrevert restores the head state', async () => {
    const { h, id, file, markers } = await setup();
    const a = file('a.txt', 'a-head');
    const b = file('b.txt', 'b-head');
    h.rewind.set('u2', { dry: { canRewind: true, filesChanged: [a, b], insertions: 0, deletions: 0 }, apply: () => (writeFileSync(a, 'a@u2'), writeFileSync(b, 'b@u2')) });
    h.rewind.set('u3', { dry: { canRewind: true, filesChanged: [b], insertions: 0, deletions: 0 }, apply: () => writeFileSync(b, 'b@u3') });
    await h.manager.revert('s1', id('u2'));
    await h.manager.revert('s1', id('u3'));
    expect(markers()).toEqual({ s1: { uuid: 'u3', resumeAt: 'a2b' } });
    expect([readFileSync(a, 'utf8'), readFileSync(b, 'utf8')]).toEqual(['a@u2', 'b@u3']);
    await h.manager.unrevert('s1');
    expect([readFileSync(a, 'utf8'), readFileSync(b, 'utf8')]).toEqual(['a-head', 'b-head']);
  });

  test('i: after a reload the marker is resolved by transcript uuid; a stale marker is dropped with a warning', async () => {
    const { h, id, work } = await setup();
    await h.manager.revert('s1', id('u2'));

    const h2 = createHarness('multi-turn', {}, STUB_INIT, { cwd: work, shared: { store: h.store, api: h.api }, storageDir: h.storageDir });
    await h2.manager.bootstrap();
    const snap2 = await h2.manager.load('s1');
    const replayedId = snap2.messages.find((m) => m.role === 'user' && m.claudeUuid === 'u2')!.id;
    expect(snap2.session.revert).toEqual({ messageID: replayedId });

    h.store.set(REVERT_KEY, { s1: { uuid: 'ghost', resumeAt: null } });
    const h3 = createHarness('multi-turn', {}, STUB_INIT, { cwd: work, shared: { store: h.store, api: h.api }, storageDir: h.storageDir });
    await h3.manager.bootstrap();
    const snap3 = await h3.manager.load('s1');
    await tick();
    expect(snap3.session.revert).toBeUndefined();
    expect(h.store.get(REVERT_KEY)).toEqual({});
    expect(h3.logs.some((l) => l.level === 'warn' && /revert marker/.test(l.message))).toBe(true);
  });

  test('j: the cut survives a spawn that dies before init and is cleared once a process announced itself', async () => {
    const { h, id, procs, session } = await setup((i) => (i === 2 ? 'revert/noinit' : 'multi-turn'));
    await h.manager.revert('s1', id('u2'));
    await h.manager.send('s1', { text: 'next' }); // commit: spawn #2 never emits init
    await until(() => procs()[1]?.prompts.length === 1);
    expect(procs()[1]!.params.options.resumeSessionAt).toBe('a1');
    expect(session()['resumeAt']).toBe('a1');
    session()['queue']!.end(); // the process dies before init
    await until(() => session().lifecycle === 'cold');
    expect(session()['resumeAt']).toBe('a1');

    await h.manager.send('s1', { text: 'again' });
    await until(() => session().lifecycle === 'live-idle', 3000);
    expect(procs()[2]!.params.options.resumeSessionAt).toBe('a1');
    expect(session()['resumeAt']).toBeUndefined();
  });

  test('k: sessions with a pending revert are never unloaded; a live session without a transcript is listed', async () => {
    const { h, id, session } = await setup();
    await h.manager.revert('s1', id('u2'));
    await session().close();
    for (let i = 0; i < 26; i++) {
      h.addTranscript(`c${i}`);
      await h.manager.load(`c${i}`);
    }
    expect(h.manager['sessions'].has('s1')).toBe(true);
    expect(session().hasRevert).toBe(true);

    // live but no transcript yet (the process never announced itself)
    const h2 = createHarness('revert/noinit');
    await h2.manager.bootstrap();
    const draft = h2.manager.create();
    await h2.manager.send(draft.id, { text: 'hi' });
    expect((await h2.manager.list()).map((s) => s.id)).toContain(draft.id);
  });

  test('l: a preview never interrupts and does not spawn when the process is live', async () => {
    const { h, id, session, procs } = await setup('subagents/stop-hang');
    await h.manager.send('s1', { text: 'go' });
    await until(() => session().status.type === 'busy');
    const busy = procs()[0]!;
    h.rewind.set('u2', { dry: { canRewind: true, filesChanged: [join(h.manager.cwd, 'x.ts'), '/elsewhere/y.ts'], insertions: 3, deletions: 1 } });
    const preview = await h.manager.revertPreview('s1', id('u2'));
    expect(preview).toEqual({ files: ['x.ts', '/elsewhere/y.ts'], insertions: 3, deletions: 1 });
    expect(busy.interrupts).toBe(0);
    expect(busy.closed).toBe(false);
    expect(procs()).toHaveLength(1);
    expect(busy.rewindCalls).toEqual([{ uuid: 'u2', dryRun: true, query: busy.index }]);
    expect(session().status.type).toBe('busy');
    // no checkpoint: filesError, still no real rewind
    expect(await h.manager.revertPreview('s1', id('u3'))).toEqual({ files: [], insertions: 0, deletions: 0, filesError: 'No file checkpoint found for this message.' });
  });

  test('a cold preview spawns a plain resume that the idle timer closes later', async () => {
    const { h, id, procs, session } = await setup();
    h.rewind.set('u2', { dry: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 } });
    await h.manager.revertPreview('s1', id('u2'));
    expect(procs()).toHaveLength(1);
    expect(procs()[0]!.params.options.resume).toBe('s1');
    expect(procs()[0]!.params.options.resumeSessionAt).toBeUndefined();
    expect(session().hasRevert).toBe(false);
    h.timers.advance(10 * 60_000 + 1);
    await until(() => procs()[0]!.closed);
  });

  test('a send issued while a revert runs waits for it and then commits', async () => {
    const { h, id, session, procs, markers, settle } = await setup();
    h.rewind.set('u2', { dry: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 } });
    // Straight into the session: both calls queue on its exclusive lock in this order.
    const reverting = session().revert(id('u2'));
    const sending = session().send({ text: 'meanwhile' });
    await Promise.all([reverting, sending]);
    await settle();
    expect(markers()).toEqual({});
    expect(session().hasRevert).toBe(false);
    expect(procs()[1]!.params.options.resumeSessionAt).toBe('a1');
    expect((await h.manager.load('s1')).messages.some((m) => m.id === id('u3'))).toBe(false);
  });

  test('reverting the target that is already reverted is a no-op', async () => {
    const { h, id } = await setup();
    h.rewind.set('u2', { dry: { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 } });
    await h.manager.revert('s1', id('u2'));
    const calls = h.rewindLog.length;
    expect(await h.manager.revert('s1', id('u2'))).toEqual({ files: [] });
    expect(h.rewindLog).toHaveLength(calls);
  });

  test('only main-session user messages with a transcript uuid can be reverted', async () => {
    const { h, snap } = await setup();
    const assistant = snap.messages.find((m) => m.role === 'assistant')!;
    await expect(h.manager.revert('s1', assistant.id)).rejects.toThrow('This message cannot be reverted');
    await expect(h.manager.revert('s1', 'no-such-message')).rejects.toThrow('This message cannot be reverted');
    await expect(h.manager.revert('sub_toolu_ag', 'x')).rejects.toThrow('Subagent sessions cannot be reverted');
    const child = (await h.manager.load('sub_toolu_ag')).messages.find((m) => m.role === 'user')!;
    expect(child.role === 'user' && child.instruction).toBeTruthy();
    const draft = h.manager.create();
    await expect(h.manager.revert(draft.id, 'x')).rejects.toThrow('Nothing to revert yet');
  });

  test('deleting a session drops its marker and copies', async () => {
    const { h, id, file, markers, copies } = await setup();
    const a = file('a.txt', 'head');
    h.rewind.set('u2', { dry: { canRewind: true, filesChanged: [a], insertions: 0, deletions: 0 } });
    await h.manager.revert('s1', id('u2'));
    expect(existsSync(copies)).toBe(true);
    await h.manager.delete('s1');
    expect(markers()).toEqual({});
    expect(existsSync(copies)).toBe(false);
  });
});

describe('bridge routes (section 7, item 5)', () => {
  test('the revert routes reject a missing sessionId / messageId and pass valid ones through', async () => {
    const calls: unknown[][] = [];
    const manager = {
      revertPreview: async (...a: unknown[]) => (calls.push(['preview', ...a]), { files: [], insertions: 0, deletions: 0 }),
      revert: async (...a: unknown[]) => (calls.push(['revert', ...a]), { files: [] }),
      unrevert: async (...a: unknown[]) => void calls.push(['unrevert', ...a]),
    } as unknown as ClaudeSessionManager;
    const call = (type: string, payload: Record<string, unknown>) => handleClaudeBridgeMessage({ id: '1', type, payload }, { manager });
    for (const type of ['claude:session.revertPreview', 'claude:session.revert']) {
      expect(await call(type, { sessionId: 's' })).toMatchObject({ success: false, error: 'Missing "messageId"' });
      expect(await call(type, { messageId: 'm' })).toMatchObject({ success: false, error: 'Missing "sessionId"' });
      expect(await call(type, { sessionId: 's', messageId: '' })).toMatchObject({ success: false });
    }
    expect(await call('claude:session.unrevert', {})).toMatchObject({ success: false, error: 'Missing "sessionId"' });
    expect(calls).toEqual([]);
    expect(await call('claude:session.revertPreview', { sessionId: 's', messageId: 'm' })).toMatchObject({ success: true, data: { files: [] } });
    expect(await call('claude:session.revert', { sessionId: 's', messageId: 'm' })).toMatchObject({ success: true });
    expect(await call('claude:session.unrevert', { sessionId: 's' })).toMatchObject({ success: true });
    expect(calls).toEqual([['preview', 's', 'm'], ['revert', 's', 'm'], ['unrevert', 's']]);
  });
});
