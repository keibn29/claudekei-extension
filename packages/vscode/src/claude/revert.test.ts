/** Host side of revert / undo / redo (docs/REVERT_SPEC.md sections 3 and 7). */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleClaudeBridgeMessage } from '../bridge-claude-runtime';
import { allEvents, createHarness, STUB_INIT, tick, until, type Harness } from './fakes';
import { REVERT_KEY } from './revertStore';
import { transcriptPaths } from './subagentCut';
import type { ClaudeSessionManager } from './ClaudeSessionManager';

const hasGit = spawnSync('git', ['--version']).status === 0;
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

/** `git`: the workspace is a real repository and `h.fileHistory` can snapshot it. */
const setup = async (fixture: string | ((i: number) => string) = 'multi-turn', git = false, withHome = false) => {
  const base = mkdtempSync(join(tmpdir(), 'claudekei-revert-'));
  dirs.push(base);
  const plain = join(base, 'work');
  mkdirSync(plain, { recursive: true });
  const home = withHome ? join(base, 'home') : undefined;
  const h = createHarness(fixture, {}, STUB_INIT, { ...(git ? { git: true } : { cwd: plain }), ...(home ? { home } : {}) });
  const work = h.cwd;
  dirs.push(work, h.storageDir);
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
  const read = (name: string) => readFileSync(join(work, name), 'utf8');
  /** One finished turn of the checkpoint log: begin, the turn's file writes, end. */
  const turn = async (uuid: string, writes: Record<string, string>) => {
    await h.fileHistory!.begin('s1', uuid);
    for (const [name, body] of Object.entries(writes)) file(name, body);
    await h.fileHistory!.end('s1');
  };
  const log = () => JSON.parse(readFileSync(join(h.storageDir, 'checkpoints', 's1.json'), 'utf8')) as { checkpoints: Array<{ uuid: string; files?: string[] }> };
  const refs = () => {
    const root = join(h.storageDir, 'snapshot');
    if (!existsSync(root)) return [];
    return readdirSync(root).flatMap((d) => spawnSync('git', ['--git-dir', join(root, d), 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean));
  };
  const session = () => h.manager['sessions'].get('s1')!;
  const procs = () => h.queries.filter((q) => q.params.options.persistSession !== false);
  const markers = () => (h.store.get(REVERT_KEY) ?? {}) as Record<string, unknown>;
  const sessionUpdates = () => (h.broadcaster.flush(), allEvents(h).filter((e) => e.type === 'session.updated' && e.properties.sessionID === 's1')) as Array<{ properties: { info: { revert?: { messageID: string } } } }>;
  const settle = async () => {
    await until(() => session().lifecycle === 'live-idle', 3000);
    h.broadcaster.flush();
  };
  return { h, snap, id, file, read, turn, log, refs, work, home, session, procs, markers, sessionUpdates, settle };
};

describe.skipIf(!hasGit)('revert (docs/REVERT_SPEC.md section 7, item 2)', () => {
  test('a: a cold revert restores the snapshotted files without spawning a process, sets the marker with the head tree and announces it', async () => {
    const { h, id, turn, read, work, procs, markers, sessionUpdates } = await setup('multi-turn', true);
    await turn('u1', { 'a.txt': 'v1' });
    await turn('u2', { 'a.txt': 'v2' });
    await turn('u3', { 'b.txt': 'b3' });
    const preview = await h.manager.revertPreview('s1', id('u2'));
    expect(preview).toEqual({ files: ['a.txt', 'b.txt'], insertions: 2, deletions: 1 });
    expect(procs()).toHaveLength(0);
    const result = await h.manager.revert('s1', id('u2'));
    expect(result.filesError).toBeUndefined();
    expect(result.files.sort()).toEqual(['a.txt', 'b.txt']);
    expect(procs()).toHaveLength(0);
    expect(read('a.txt')).toBe('v1');
    expect(existsSync(join(work, 'b.txt'))).toBe(false);
    expect(markers()).toEqual({ s1: { uuid: 'u2', resumeAt: 'a1', head: expect.stringMatching(/^[0-9a-f]{40,}$/) } });
    expect(sessionUpdates().at(-1)!.properties.info.revert).toEqual({ messageID: id('u2') });
    // nothing was truncated yet: the hidden messages are still in the host state
    expect((await h.manager.load('s1')).messages.some((m) => m.id === id('u3'))).toBe(true);
  });

  test('b: reverting a busy turn interrupts and closes the process, restores a file written while it ran, and starts no process', async () => {
    const { h, id, turn, file, session, procs } = await setup('subagents/stop-hang', true);
    await turn('u2', { 'a.txt': 'v2' });
    await turn('u3', { 'a.txt': 'v3' });
    await h.manager.send('s1', { text: 'go' });
    await until(() => session().status.type === 'busy' && session().state.sessions.get('sub_toolu_stop1')?.status.type === 'busy');
    const busy = procs()[0]!;
    file('from-bash.txt', 'written by a shell command or subagent while busy');
    const result = await h.manager.revert('s1', id('u2'));
    expect(result.filesError).toBeUndefined();
    expect(result.files.sort()).toEqual(['a.txt', 'from-bash.txt']);
    expect(existsSync(join(h.cwd, 'from-bash.txt'))).toBe(false);
    expect(busy.interrupts).toBe(1);
    expect(busy.interruptOptions).toEqual([{ cancelQueued: true }]);
    expect(busy.closed).toBe(true);
    expect(procs()).toHaveLength(1);
    expect(existsSync(join(h.cwd, 'a.txt'))).toBe(false); // a.txt did not exist before u2
    // the interrupted turn ended cleanly
    expect(session().state.sessions.get('sub_toolu_stop1')?.status).toEqual({ type: 'idle' });
    expect(session().status).toEqual({ type: 'idle' });
  });

  test('c: without a usable snapshot store the conversation is still reverted: filesError, marker set, no process', async () => {
    const { h, id, procs, markers, sessionUpdates } = await setup();
    const result = await h.manager.revert('s1', id('u2'));
    expect(result).toEqual({ files: [], filesError: 'the workspace is not a Git repository' });
    expect(markers()).toEqual({ s1: { uuid: 'u2', resumeAt: 'a1' } });
    expect(sessionUpdates().at(-1)!.properties.info.revert).toEqual({ messageID: id('u2') });
    expect(procs()).toHaveLength(0);
  });

  test('d: the next send resumes at the cut, drops the checkpoints from the target onward and removes everything hidden in ONE batch', async () => {
    const { h, snap, id, turn, log, refs, procs, markers, session, settle } = await setup('multi-turn', true);
    expect(snap.children.map((c) => c.id)).toEqual(['sub_toolu_ag']);
    await turn('u1', { 'a.txt': 'v1' });
    await turn('u2', { 'a.txt': 'v2' });
    await turn('u3', { 'b.txt': 'b3' });
    await h.manager.revert('s1', id('u2'));
    expect(refs().sort()).toEqual(['refs/claudekei/s1/revert-head', 'refs/claudekei/s1/u1', 'refs/claudekei/s1/u2', 'refs/claudekei/s1/u3']);
    h.pushes.length = 0;

    await h.manager.send('s1', { text: 'next' });
    await settle();
    expect(procs()).toHaveLength(1);
    expect(procs()[0]!.params.options.resume).toBe('s1');
    expect(procs()[0]!.params.options.resumeSessionAt).toBe('a1'); // last entry of the kept turn
    // `init` arrived: the cut is in the transcript now
    expect(session()['resumeAt']).toBeUndefined();
    const cps = log().checkpoints.map((c) => c.uuid);
    expect(cps).toHaveLength(2);
    expect(cps[0]).toBe('u1');
    expect(refs()).toContain('refs/claudekei/s1/u1');
    expect(refs().some((r) => /s1\/(u2|u3|revert-head)$/.test(r))).toBe(false);

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
    expect(procs()).toHaveLength(1);
    expect(procs()[0]!.params.options.sessionId).toBe('s1');
    expect(procs()[0]!.params.options.resume).toBeUndefined();
    expect(procs()[0]!.params.options.resumeSessionAt).toBeUndefined();
    expect(session().exists).toBe(true); // the new process announced itself
    const after = await h.manager.load('s1');
    expect(after.messages.filter((m) => m.role === 'user')).toHaveLength(1);
    expect(markers()).toEqual({});
  });

  test('e2: committing a first-message revert also drops its checkpoints', async () => {
    const { h, id, turn, log, refs, settle } = await setup('multi-turn', true);
    await turn('u1', { 'a.txt': 'v1' });
    await h.manager.revert('s1', id('u1'));
    await h.manager.send('s1', { text: 'fresh start' });
    await settle();
    expect(log().checkpoints.map((c) => c.uuid)).not.toContain('u1');
    expect(refs().some((r) => r.endsWith('/u1') || r.endsWith('/revert-head'))).toBe(false);
  });

  test('f: unrevert writes the head state back without spawning anything and shows the messages again', async () => {
    const { h, id, turn, read, work, procs, markers, sessionUpdates } = await setup('multi-turn', true);
    await turn('u1', { 'a.txt': 'a1' });
    await turn('u2', { 'a.txt': 'a2', 'made-by-turn.txt': 'created' });
    await turn('u3', {});
    await h.manager.revert('s1', id('u2'));
    expect(read('a.txt')).toBe('a1');
    expect(existsSync(join(work, 'made-by-turn.txt'))).toBe(false);
    await h.manager.unrevert('s1');
    expect(read('a.txt')).toBe('a2');
    expect(read('made-by-turn.txt')).toBe('created');
    expect(procs()).toHaveLength(0);
    expect(markers()).toEqual({});
    expect(sessionUpdates().at(-1)!.properties.info.revert).toBeUndefined();
    await h.manager.unrevert('s1'); // no marker: a no-op
    expect((await h.manager.load('s1')).session.revert).toBeUndefined();
  });

  test('g: undo X, then an earlier Y, then unrevert restores the head state of both files', async () => {
    const { h, id, turn, read, markers, procs } = await setup('multi-turn', true);
    await turn('u1', { 'a.txt': 'a1', 'b.txt': 'b1' });
    await turn('u2', { 'a.txt': 'a2', 'b.txt': 'b2' });
    await turn('u3', { 'b.txt': 'b3' });
    await h.manager.revert('s1', id('u3'));
    expect([read('a.txt'), read('b.txt')]).toEqual(['a2', 'b2']);
    await h.manager.revert('s1', id('u2'));
    expect(markers()).toMatchObject({ s1: { uuid: 'u2', resumeAt: 'a1' } });
    expect([read('a.txt'), read('b.txt')]).toEqual(['a1', 'b1']);
    await h.manager.unrevert('s1');
    expect([read('a.txt'), read('b.txt')]).toEqual(['a2', 'b3']);
    expect(procs()).toHaveLength(0);
  });

  test('h: undo Y, then a later Z, then unrevert restores the head state', async () => {
    const { h, id, turn, read, markers } = await setup('multi-turn', true);
    await turn('u1', { 'a.txt': 'a1', 'b.txt': 'b1' });
    await turn('u2', { 'a.txt': 'a2', 'b.txt': 'b2' });
    await turn('u3', { 'b.txt': 'b3' });
    await h.manager.revert('s1', id('u2'));
    await h.manager.revert('s1', id('u3'));
    expect(markers()).toMatchObject({ s1: { uuid: 'u3', resumeAt: 'a2b' } });
    expect([read('a.txt'), read('b.txt')]).toEqual(['a2', 'b2']);
    await h.manager.unrevert('s1');
    expect([read('a.txt'), read('b.txt')]).toEqual(['a2', 'b3']);
  });

  test('unrevert of a marker without a head (older version) restores the conversation only', async () => {
    const { h, id, markers, sessionUpdates } = await setup();
    await h.manager.revert('s1', id('u2'));
    await h.manager.unrevert('s1');
    expect(markers()).toEqual({});
    expect(sessionUpdates().at(-1)!.properties.info.revert).toBeUndefined();
  });

  test('unrevert survives expired snapshots: the conversation is restored and a warning is logged', async () => {
    const { h, id, turn, markers } = await setup('multi-turn', true);
    await turn('u1', { 'a.txt': 'a1' });
    await turn('u2', { 'a.txt': 'a2' });
    await h.manager.revert('s1', id('u2'));
    h.store.set(REVERT_KEY, { s1: { ...(markers().s1 as object), head: 'f'.repeat(40) } });
    h.manager['sessions'].get('s1')!['revertMarker'] = (markers() as Record<string, never>).s1;
    await h.manager.unrevert('s1');
    expect(markers()).toEqual({});
    expect(h.logs.some((l) => l.level === 'warn' && /unrevert/.test(l.message))).toBe(true);
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
    const { h, id, procs, session } = await setup((i) => (i === 1 ? 'revert/noinit' : 'multi-turn'));
    await h.manager.revert('s1', id('u2'));
    await h.manager.send('s1', { text: 'next' }); // commit: spawn #1 never emits init
    await until(() => procs()[0]?.prompts.length === 1);
    expect(procs()[0]!.params.options.resumeSessionAt).toBe('a1');
    expect(session()['resumeAt']).toBe('a1');
    session()['queue']!.end(); // the process dies before init
    await until(() => session().lifecycle === 'cold');
    expect(session()['resumeAt']).toBe('a1');

    await h.manager.send('s1', { text: 'again' });
    await until(() => session().lifecycle === 'live-idle', 3000);
    expect(procs()[1]!.params.options.resumeSessionAt).toBe('a1');
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

  test('l: a preview never interrupts and starts no process while the turn runs', async () => {
    const { h, id, turn, session, procs } = await setup('subagents/stop-hang', true);
    await turn('u2', { 'x.ts': 'one\ntwo\n' });
    await turn('u3', { 'x.ts': 'one\n' });
    await h.manager.send('s1', { text: 'go' });
    await until(() => session().status.type === 'busy');
    const busy = procs()[0]!;
    const preview = await h.manager.revertPreview('s1', id('u2'));
    expect(preview).toEqual({ files: ['x.ts'], insertions: 1, deletions: 0 });
    expect(busy.interrupts).toBe(0);
    expect(busy.closed).toBe(false);
    expect(procs()).toHaveLength(1);
    expect(session().status.type).toBe('busy');
    // no checkpoint was taken for u1: filesError
    expect(await h.manager.revertPreview('s1', id('u1'))).toEqual({ files: [], insertions: 0, deletions: 0, filesError: 'no file snapshot was taken when this message was sent' });
  });

  test('a cold preview spawns nothing and leaves no revert state', async () => {
    const { h, id, procs, session } = await setup();
    const preview = await h.manager.revertPreview('s1', id('u2'));
    expect(preview.filesError).toBe('the workspace is not a Git repository');
    expect(procs()).toHaveLength(0);
    expect(session().hasRevert).toBe(false);
  });

  test('a live send records a checkpoint for the pushed uuid before it is queued, and closes it once idle with the files the turn wrote', async () => {
    const { h, log, file, procs, settle } = await setup('multi-turn', true);
    const history = h.fileHistory!;
    const begin = history.begin.bind(history);
    // The turn's file write happens after the checkpoint exists (stand-in for a tool run while busy).
    history.begin = async (sid, uuid) => {
      await begin(sid, uuid);
      file('written-by-turn.txt', 'x');
    };
    await h.manager.send('s1', { text: 'hello' });
    await settle();
    const pushed = procs()[0]!.prompts[0].uuid as string;
    await until(() => log().checkpoints.at(-1)?.files !== undefined);
    expect(log().checkpoints.map((c) => c.uuid)).toEqual([pushed]);
    expect(log().checkpoints[0]!.files).toContain('written-by-turn.txt');
  });

  test('H1: a publish while begin() runs (cold spawn, context refresh) does not close the new checkpoint early', async () => {
    const { h, id, file, session, procs } = await setup('subagents/stop-hang', true);
    const history = h.fileHistory!;
    await history.begin('s1', 'u2'); // the previous turn is still open
    const begin = history.begin.bind(history);
    history.begin = async (sid, uuid) => {
      const pending = begin(sid, uuid);
      session().publish([{ type: 'session.updated', properties: { sessionID: 's1', info: session()['info'] } }]);
      await pending;
    };
    await h.manager.send('s1', { text: 'go' });
    await until(() => session().status.type === 'busy');
    file('from-bash.txt', 'written while the turn runs');
    const result = await h.manager.revert('s1', id('u2'));
    expect(result.filesError).toBeUndefined();
    expect(result.files).toContain('from-bash.txt');
    expect(existsSync(join(h.cwd, 'from-bash.txt'))).toBe(false);
    expect(procs()).toHaveLength(1);
  });

  /** N is paused after its checkpoint exists, X is queued behind it: the shared setup of the G4 tests. */
  const queuedBehindPausedTurn = async () => {
    const t = await setup('multi-turn', true);
    const history = t.h.fileHistory!;
    const begin = history.begin.bind(history);
    let paused = false;
    history.begin = async (sid, uuid) => {
      await begin(sid, uuid);
      if (!paused) {
        paused = true;
        t.procs()[0]!.pause(); // the first turn is held until we resume it
      }
    };
    await t.h.manager.send('s1', { text: 'N' });
    await t.h.manager.send('s1', { text: 'X' }); // queued behind N
    const query = t.procs()[0]!;
    query.resume(); // N runs ...
    query.pause(); // ... and X waits before it emits anything
    await until(() => t.session().lifecycle === 'live-idle' && t.log().checkpoints.length === 2);
    await until(() => t.log().checkpoints[1]!.files !== undefined); // N's idle closed X's checkpoint
    return { ...t, query };
  };

  test('G4: a queued message whose checkpoint an idle closed is reopened when its turn starts, so its edits are covered', async () => {
    const { file, log, session, query } = await queuedBehindPausedTurn();
    file('x-edit.txt', 'written by the second turn');
    query.resume(); // X's turn starts (busy again) ...
    await until(() => session().lifecycle === 'live-idle' && query.prompts.length === 2);
    await until(() => log().checkpoints[1]!.files?.includes('x-edit.txt') === true); // ... and its idle closes it again
  });

  test('G4: a queued prompt folded into the running turn (no turn of its own) is not reopened: an edit after the final idle stays out', async () => {
    const { file, log, query } = await queuedBehindPausedTurn();
    file('manual-edit.txt', 'made by the user after the last idle');
    await tick(800);
    expect(log().checkpoints[1]!.files ?? []).not.toContain('manual-edit.txt');
    query.resume(); // clean up
  });

  test('G4: a turn the CLI starts on its own after an idle (auto-continuation) reopens the last checkpoint and covers its edits', async () => {
    const { h, file, log, session, settle } = await setup('multi-turn', true);
    await h.manager.send('s1', { text: 'hello' });
    await settle();
    await until(() => log().checkpoints.at(-1)?.files !== undefined);
    const status = (type: 'busy' | 'idle') => session().publish([{ type: 'session.status', properties: { sessionID: 's1', status: { type } } }]);
    status('busy'); // no send: the CLI continues by itself
    await until(() => session().lifecycle === 'live-busy');
    await tick(400); // reopen needs a log write
    expect(log().checkpoints.at(-1)!.files).toBeUndefined();
    file('auto-edit.txt', 'written by the auto-continuation');
    status('idle');
    await until(() => log().checkpoints.at(-1)?.files?.includes('auto-edit.txt') === true);
  });

  test('G6: a CLI that never answers the interrupt cannot hang a revert: the process is closed after the timeout', async () => {
    const { h, id, session, procs } = await setup('subagents/stop-hang', true);
    await h.manager.send('s1', { text: 'go' });
    await until(() => session().status.type === 'busy');
    const busy = procs()[0]!;
    busy.interrupt = () => new Promise(() => undefined); // never resolves
    const reverting = h.manager.revert('s1', id('u2'));
    await tick(30);
    expect(busy.closed).toBe(false);
    h.timers.advance(5001);
    const result = await reverting;
    expect(busy.closed).toBe(true);
    expect(result.files).toBeDefined();
    expect(h.logs.some((l) => l.level === 'warn' && /interrupt did not answer/.test(l.message))).toBe(true);
  });

  test('G1/G2: edits the snapshot cannot undo (outside the repo, Git-ignored, in child sessions) are reported in preview and revert', async () => {
    const { h, id, turn, session, file } = await setup('multi-turn', true);
    file('.gitignore', 'ignored.txt\n');
    await turn('u1', { 'a.txt': 'a1' });
    await turn('u2', { 'a.txt': 'a2' });
    const after = id('u3') + '~';
    const toolPart = (sessionID: string, messageID: string, tool: string, input: Record<string, unknown>, n: number) => ({ id: `part_${n}`, sessionID, messageID, type: 'tool', tool: tool.toLowerCase(), callID: `call_${n}`, claude: { name: tool }, state: { status: 'completed', input } });
    const message = (sessionID: string, mid: string) => ({ id: mid, sessionID, role: 'assistant', time: { created: 1 } });
    session().publish([
      { type: 'message.updated', properties: { info: message('s1', after) } },
      { type: 'message.part.updated', properties: { part: toolPart('s1', after, 'Write', { filePath: join(h.cwd, 'ignored.txt') }, 1) } },
      { type: 'message.part.updated', properties: { part: toolPart('s1', after, 'Edit', { filePath: '/elsewhere/outside.ts' }, 2) } },
      { type: 'message.part.updated', properties: { part: toolPart('s1', after, 'Edit', { filePath: join(h.cwd, 'a.txt') }, 3) } }, // restorable
      { type: 'message.part.updated', properties: { part: toolPart('s1', after, 'Read', { filePath: '/elsewhere/read-only.ts' }, 4) } }, // not an edit
      // the child created by u2's Agent call edited a notebook in a nested repository
      { type: 'message.updated', properties: { info: message('sub_toolu_ag', 'child_m1') } },
      { type: 'message.part.updated', properties: { part: toolPart('sub_toolu_ag', 'child_m1', 'NotebookEdit', { notebook_path: join(h.cwd, 'nested', 'n.ipynb') }, 5) } },
    ] as never);
    mkdirSync(join(h.cwd, 'nested', '.git'), { recursive: true });
    const note = (list: string) => `3 file(s) edited in these turns can't be restored: ${list}`;
    const preview = await h.manager.revertPreview('s1', id('u2'));
    expect(preview.filesError).toBe(note('/elsewhere/outside.ts, ignored.txt, nested/n.ipynb'));
    expect(preview.files).toEqual(['a.txt']);
    const result = await h.manager.revert('s1', id('u2'));
    expect(result.filesError).toBe(note('/elsewhere/outside.ts, ignored.txt, nested/n.ipynb'));
    expect(result.files).toEqual(['a.txt']);
  });

  test('moving a revert while file snapshots are unavailable is refused and keeps the redo head', async () => {
    const { h, id, turn, markers } = await setup('multi-turn', true);
    await turn('u1', { 'a.txt': 'a1' });
    await turn('u2', { 'a.txt': 'a2' });
    await h.manager.revert('s1', id('u2'));
    const marker = markers().s1;
    h.config.fileSnapshots = false;
    await expect(h.manager.revert('s1', id('u1'))).rejects.toThrow('file snapshots are unavailable');
    expect(markers().s1).toEqual(marker);
    h.config.fileSnapshots = true;
    await h.manager.revert('s1', id('u1'));
    expect(markers().s1).toMatchObject({ uuid: 'u1' });
  });

  test('two queued sends record two checkpoints in send order', async () => {
    const { h, log, procs, session } = await setup('subagents/stop-hang', true);
    await h.manager.send('s1', { text: 'first' });
    await until(() => session().status.type === 'busy');
    await h.manager.send('s1', { text: 'second' });
    await until(() => procs()[0]!.prompts.length === 2);
    expect(log().checkpoints.map((c) => c.uuid)).toEqual(procs()[0]!.prompts.map((p) => p.uuid));
    expect(log().checkpoints).toHaveLength(2);
  });

  test('H3: a failing drop never blocks the send that commits the cut', async () => {
    const { h, id, markers, settle, procs } = await setup('multi-turn', true);
    h.fileHistory!.drop = async () => {
      throw new Error('boom');
    };
    await h.manager.revert('s1', id('u2'));
    await h.manager.send('s1', { text: 'next' });
    await settle();
    expect(markers()).toEqual({});
    expect(procs()[0]!.params.options.resumeSessionAt).toBe('a1');
    expect(h.logs.some((l) => l.level === 'warn' && /could not drop/.test(l.message))).toBe(true);
  });

  test('H2/M7: when the files of the old marker cannot be restored, a new revert is rejected, /redo surfaces the error, and the marker stays', async () => {
    const { h, id, turn, markers, sessionUpdates } = await setup('multi-turn', true);
    await turn('u1', { 'a.txt': 'a1' });
    await turn('u2', { 'a.txt': 'a2' });
    await turn('u3', { 'b.txt': 'b3' });
    await h.manager.revert('s1', id('u3'));
    const marker = markers().s1;
    const history = h.fileHistory!;
    history.unrevert = async () => {
      throw new Error('1 file(s) could not be restored: b.txt');
    };
    await expect(h.manager.revert('s1', id('u2'))).rejects.toThrow('could not be restored');
    expect(markers().s1).toEqual(marker);
    await expect(h.manager.unrevert('s1')).rejects.toThrow('could not be restored');
    expect(markers().s1).toEqual(marker);
    expect(sessionUpdates().at(-1)!.properties.info.revert).toEqual({ messageID: id('u3') });
    delete (history as unknown as Record<string, unknown>).unrevert; // back to the real implementation
    await h.manager.unrevert('s1');
    expect(markers()).toEqual({});
  });

  test('M7: an expired head restores the conversation only and logs a warning', async () => {
    const { h, id, turn, markers } = await setup('multi-turn', true);
    await turn('u1', { 'a.txt': 'a1' });
    await turn('u2', { 'a.txt': 'a2' });
    await h.manager.revert('s1', id('u2'));
    h.fileHistory!.unrevert = async () => ({ skipped: 'the file snapshots for this message have expired' });
    await h.manager.unrevert('s1');
    expect(markers()).toEqual({});
    expect(h.logs.some((l) => l.level === 'warn' && /not restored on unrevert/.test(l.message))).toBe(true);
  });

  test('a send issued while a revert runs waits for it and then commits', async () => {
    const { h, id, session, procs, markers, settle } = await setup();
    // Straight into the session: both calls queue on its exclusive lock in this order.
    const reverting = session().revert(id('u2'));
    const sending = session().send({ text: 'meanwhile' });
    await Promise.all([reverting, sending]);
    await settle();
    expect(markers()).toEqual({});
    expect(session().hasRevert).toBe(false);
    expect(procs()[0]!.params.options.resumeSessionAt).toBe('a1');
    expect((await h.manager.load('s1')).messages.some((m) => m.id === id('u3'))).toBe(false);
  });

  test('reverting the target that is already reverted is a no-op', async () => {
    const { h, id, turn, markers } = await setup('multi-turn', true);
    await turn('u2', { 'a.txt': 'a2' });
    await h.manager.revert('s1', id('u2'));
    const before = markers();
    expect(await h.manager.revert('s1', id('u2'))).toEqual({ files: [] });
    expect(markers()).toEqual(before);
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

  test('deleting a session drops its marker, checkpoint log and refs', async () => {
    const { h, id, turn, markers, refs } = await setup('multi-turn', true);
    await turn('u2', { 'a.txt': 'a2' });
    await h.manager.revert('s1', id('u2'));
    expect(existsSync(join(h.storageDir, 'checkpoints', 's1.json'))).toBe(true);
    await h.manager.delete('s1');
    expect(markers()).toEqual({});
    expect(existsSync(join(h.storageDir, 'checkpoints', 's1.json'))).toBe(false);
    expect(refs()).toEqual([]);
  });
});

const jl = (...rows: Array<Record<string, unknown>>) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const sub = (uuid: string, parent: string | null, promptId?: string) => ({ type: 'user', uuid, parentUuid: parent, ...(promptId ? { promptId } : {}), isSidechain: true });
const subAsst = (uuid: string, parent: string) => ({ type: 'assistant', uuid, parentUuid: parent, isSidechain: true });
const readJsonl = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { uuid: string; promptId?: string });

/** Writes the Claude Code transcripts (main + two subagents) and the claudekei plugin's alias state for session s1. */
const writeDisk = (home: string, cwd: string) => {
  const paths = transcriptPaths({ home, cwd, sessionId: 's1' });
  mkdirSync(paths.subagents, { recursive: true });
  writeFileSync(
    paths.main,
    jl(
      { type: 'user', uuid: 'u1', parentUuid: null, promptId: 'p1', isSidechain: false },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', isSidechain: false },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', promptId: 'p2', isSidechain: false },
      { type: 'user', uuid: 'r2', parentUuid: 'u2', promptId: 'p2', isSidechain: false },
      { type: 'user', uuid: 'u3', parentUuid: 'r2', promptId: 'p3', isSidechain: false },
    ),
  );
  const oldFile = join(paths.subagents, 'agent-OLD.jsonl');
  const newFile = join(paths.subagents, 'agent-NEW.jsonl');
  writeFileSync(oldFile, jl(sub('o0', null, 'p1'), subAsst('o1', 'o0'), sub('o2', 'o1', 'p2'), subAsst('o3', 'o2')));
  writeFileSync(newFile, jl(sub('n0', null, 'p2'), subAsst('n1', 'n0')));
  writeFileSync(join(paths.subagents, 'agent-NEW.meta.json'), '{"toolUseId":"toolu_new"}');
  writeFileSync(join(paths.subagents, 'agent-OLD.meta.json'), '{"toolUseId":"toolu_old"}');
  const state = join(home, '.claude', 'plugins', 'data', 'claudekei-inline', 'sessions');
  mkdirSync(state, { recursive: true });
  const child = (agentId: string) => ({ alias: `exp-${agentId}`, agentId, agentType: 'explorer', description: 'd', status: 'idle', createdAt: 1, lastUsedAt: 9, reads: [{ path: '/a.ts', lines: 80 }] });
  writeFileSync(join(state, 's1.json'), JSON.stringify({ version: 1, mode: null, modeBaseAgentType: null, counters: { exp: 2 }, children: [child('OLD'), child('NEW')] }));
  return { oldFile, newFile, newMeta: join(paths.subagents, 'agent-NEW.meta.json'), state: join(state, 's1.json') };
};

describe('commit rolls subagent context back (docs/REVERT_SPEC.md, subagent context)', () => {
  test('the next send trims reverted continuations, deletes subagents born in reverted turns, cleans the plugin state and persists the promptIds; /redo is untouched until then', async () => {
    const { h, id, home, work, procs, markers } = await setup((i) => (i === 1 ? 'revert/noinit' : 'multi-turn'), false, true);
    const disk = writeDisk(home!, work);
    await h.manager.revert('s1', id('u2'));
    expect(readJsonl(disk.oldFile)).toHaveLength(4); // revert alone changes nothing on disk
    expect(existsSync(disk.newFile)).toBe(true);

    await h.manager.send('s1', { text: 'next' });
    await until(() => procs()[0]?.prompts.length === 1);
    expect(readJsonl(disk.oldFile).map((e) => e.uuid)).toEqual(['o0', 'o1']);
    expect(existsSync(disk.newFile)).toBe(false);
    expect(existsSync(disk.newMeta)).toBe(false);
    expect(existsSync(join(disk.oldFile, '..', 'agent-OLD.meta.json'))).toBe(true);
    const state = JSON.parse(readFileSync(disk.state, 'utf8'));
    expect(state.children.map((c: { agentId: string }) => c.agentId)).toEqual(['OLD']);
    expect(state.children[0]).toMatchObject({ reads: [], status: 'idle', lastUsedAt: 1 });
    expect(markers()).toEqual({ s1: { uuid: 'u2', resumeAt: 'a1', promptIds: ['p2', 'p3'], trimmedAgentIds: ['OLD'], committed: true } });
  });

  test('a crash before init re-applies the cut idempotently from the persisted promptIds, without touching the new branch', async () => {
    const { h, id, home, work, procs, session } = await setup((i) => (i === 1 ? 'revert/noinit' : 'multi-turn'), false, true);
    const disk = writeDisk(home!, work);
    await h.manager.revert('s1', id('u2'));
    await h.manager.send('s1', { text: 'next' });
    await until(() => procs()[0]?.prompts.length === 1);
    session()['queue']!.end();
    await until(() => session().lifecycle === 'cold');
    // the dead process wrote a reverted line back (stand-in for a cut that never completed) and the new branch ran under p4
    writeFileSync(disk.oldFile, readFileSync(disk.oldFile, 'utf8') + jl(sub('o4', 'o1', 'p2'), sub('o5', 'o1', 'p4')));

    const h2 = createHarness('multi-turn', {}, STUB_INIT, { cwd: work, home, shared: { store: h.store, api: h.api }, storageDir: h.storageDir });
    await h2.manager.bootstrap();
    await h2.manager.load('s1');
    await h2.manager.send('s1', { text: 'again' });
    await until(() => h2.manager['sessions'].get('s1')!.lifecycle === 'live-idle', 3000);
    expect(readJsonl(disk.oldFile).map((e) => e.uuid)).toEqual(['o0', 'o1', 'o5']);
  });

  test('a crash between the file deletion and the plugin cleanup is completed by the retry (aliases removed, trimmed aliases reset)', async () => {
    const { h, id, home, work, procs, session } = await setup((i) => (i === 1 ? 'revert/noinit' : 'multi-turn'), false, true);
    const disk = writeDisk(home!, work);
    await h.manager.revert('s1', id('u2'));
    await h.manager.send('s1', { text: 'next' });
    await until(() => procs()[0]?.prompts.length === 1);
    session()['queue']!.end();
    await until(() => session().lifecycle === 'cold');
    // as if the host died after the files were rewritten but before the plugin state was written
    const stale = { version: 1, mode: null, modeBaseAgentType: null, counters: { exp: 2 }, children: ['OLD', 'NEW'].map((agentId) => ({ alias: `exp-${agentId}`, agentId, agentType: 'explorer', description: 'd', status: 'running', createdAt: 1, lastUsedAt: 9, reads: [{ path: '/a.ts', lines: 80 }] })) };
    writeFileSync(disk.state, JSON.stringify(stale));
    expect(existsSync(disk.newFile)).toBe(false); // the deletion had already happened

    const h2 = createHarness('multi-turn', {}, STUB_INIT, { cwd: work, home, shared: { store: h.store, api: h.api }, storageDir: h.storageDir });
    await h2.manager.bootstrap();
    await h2.manager.load('s1');
    await h2.manager.send('s1', { text: 'again' });
    await until(() => h2.manager['sessions'].get('s1')!.lifecycle === 'live-idle', 3000);
    const state = JSON.parse(readFileSync(disk.state, 'utf8'));
    expect(state.children.map((c: { agentId: string }) => c.agentId)).toEqual(['OLD']);
    expect(state.children[0]).toMatchObject({ reads: [], status: 'idle' });
  });

  test('reverting the first message trims before the transcript is deleted: every subagent of the session is removed', async () => {
    const { h, id, home, work, settle } = await setup('multi-turn', false, true);
    const disk = writeDisk(home!, work);
    await h.manager.revert('s1', id('u1'));
    await h.manager.send('s1', { text: 'fresh' });
    await settle();
    expect(existsSync(disk.oldFile)).toBe(false);
    expect(existsSync(disk.newFile)).toBe(false);
    expect(JSON.parse(readFileSync(disk.state, 'utf8')).children).toEqual([]);
  });

  test('without Claude transcripts on disk the commit still works', async () => {
    const { h, id, settle, markers } = await setup('multi-turn', false, true);
    await h.manager.revert('s1', id('u2'));
    await h.manager.send('s1', { text: 'next' });
    await settle();
    expect(markers()).toEqual({});
  });

  test('UI: follow-ups sent from reverted messages and everything the kept child did after them are removed; earlier ones stay', async () => {
    const { h, id, session, settle } = await setup('multi-turn', false, true);
    // a kept child (created in turn 1) that received a follow-up from the reverted message u3
    session().publish([
      { type: 'session.created', properties: { sessionID: 'sub_keep', info: { id: 'sub_keep', parentID: 's1' } } },
      ...[
        { id: 'k1', sessionID: 'sub_keep', role: 'user', time: { created: 1 }, instruction: { kind: 'initial', index: 1, fromSessionID: 's1', fromMessageID: id('u1'), toolCallID: 't0' } },
        { id: 'k2', sessionID: 'sub_keep', role: 'assistant', time: { created: 1 } },
        { id: 'k3', sessionID: 'sub_keep', role: 'user', time: { created: 1 }, instruction: { kind: 'followup', index: 2, fromSessionID: 's1', fromMessageID: id('u3'), toolCallID: 't1' } },
        { id: 'k4', sessionID: 'sub_keep', role: 'assistant', time: { created: 1 } },
      ].map((info) => ({ type: 'message.updated', properties: { info } })),
    ] as never);
    await h.manager.revert('s1', id('u2'));
    h.pushes.length = 0;
    await h.manager.send('s1', { text: 'next' });
    await settle();
    const removed = h.pushes.flatMap((p) => p.events).filter((e) => e.type === 'message.removed' && e.properties.sessionID === 'sub_keep').map((e) => (e as { properties: { messageID: string } }).properties.messageID);
    expect(removed.sort()).toEqual(['k3', 'k4']);
    expect(session().state.sessions.get('sub_keep')!.messages.map((m) => m.id)).toEqual(['k1', 'k2']);
  });

  test('history replay after the trim: the reloaded child has no reverted continuation', async () => {
    const { h, id, home, work, settle } = await setup('multi-turn', false, true);
    const disk = writeDisk(home!, work);
    await h.manager.revert('s1', id('u2'));
    await h.manager.send('s1', { text: 'next' });
    await settle();
    const kept = readJsonl(disk.oldFile);
    expect(kept.map((e) => e.uuid)).toEqual(['o0', 'o1']);
    // a reload replays exactly the trimmed file: the SDK reads the same transcript the trim rewrote
    const h2 = createHarness('multi-turn', {}, STUB_INIT, { cwd: work, home, shared: { store: h.store, api: h.api }, storageDir: h.storageDir });
    h.api.subagents.set('s1', { 'agent-OLD': kept.map((e) => ({ ...e, parent_tool_use_id: 'toolu_ag', timestamp: t(3), message: { role: e.uuid === 'o0' ? 'user' : 'assistant', ...(e.uuid === 'o0' ? { content: [{ type: 'text', text: 'p' }] } : { id: 'm_o1', model: 'm', content: [{ type: 'text', text: 'reply' }] }) } })) as never });
    await h2.manager.bootstrap();
    const snap = await h2.manager.load('s1');
    expect(snap.children.map((c) => c.id)).toEqual(['sub_toolu_ag']);
    const child = await h2.manager.load('sub_toolu_ag');
    expect(child.messages).toHaveLength(2); // the instruction and the reply of the kept turn
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
