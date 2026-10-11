import { describe, expect, test } from 'bun:test';
import { allEvents, createHarness, tick, until, type Harness } from './fakes';

const sendAndSettle = async (h: Harness, id: string, text = 'go', extra: Record<string, unknown> = {}) => {
  const res = await h.manager.send(id, { text, ...extra } as never);
  await until(() => h.manager['sessions'].get(id)!.lifecycle === 'live-idle', 3000);
  h.broadcaster.flush();
  return res;
};

describe('ClaudeSessionManager', () => {
  test('bootstrap: catalog with primary agents from a never-yielding probe, status connected', async () => {
    const h = createHarness('text');
    const boot = await h.manager.bootstrap();
    expect(boot.cwd).toBe('/work/proj');
    expect(boot.account?.email).toBe('user@example.com');
    expect(boot.catalog.primaryAgents.map((p) => p.name)).toEqual(['claudekei:orchestrator', 'claudekei:planner', 'claudekei:sprinter']);
    expect(boot.catalog.primaryAgents[0]).toMatchObject({ displayName: 'Orchestrator', color: 'purple' });
    expect(boot.catalog.defaults.agent).toBe('claudekei:orchestrator');
    expect(h.manager.getStatus().status).toBe('connected');
    // the probe is the only query and was not given a transcript
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]!.params.options.persistSession).toBe(false);
    expect(h.queries[0]!.params.options.settingSources).toEqual(['user', 'project', 'local']);
    expect(h.queries[0]!.closed).toBe(true);
    expect(h.store.get('claudekei.catalogCache')).toBeDefined();
  });

  test('create -> send -> streamed events, final snapshot, spawn options', async () => {
    const h = createHarness('edit');
    await h.manager.bootstrap();
    const session = h.manager.create();
    expect(session.title).toBe('New session');
    const { messageId } = await sendAndSettle(h, session.id, 'edit it', { agent: 'claudekei:sprinter', mode: 'acceptEdits', model: 'haiku' });
    expect(messageId).toBeTruthy();

    const q = h.queries[1]!;
    const o = q.params.options;
    expect(o.sessionId).toBe(session.id);
    expect(o.resume).toBeUndefined();
    expect(o.agent).toBe('claudekei:sprinter');
    expect(o.permissionMode).toBe('acceptEdits');
    expect(o.model).toBe('haiku');
    expect(o.includePartialMessages).toBe(true);
    expect(o.settingSources).toEqual(['user', 'project', 'local']);
    expect(o.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(o.enableFileCheckpointing).toBeUndefined();
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', snapshot: false });
    // foreground subagent runs only forward their text reply with this option
    expect(o.forwardSubagentText).toBe(true);
    expect(o.env!.CLAUDE_CODE_ENABLE_TASKS).toBe('false');
    expect(o.env!.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(o.env!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(o.env!.PATH!.startsWith('/opt/login/bin')).toBe(true);
    expect(q.prompts[0].message.content[0].text).toBe('edit it');
    expect(q.prompts[0].uuid).toBeTruthy();

    // events were pushed in order with consecutive seq numbers
    expect(h.pushes.map((p) => p.seq)).toEqual(h.pushes.map((_, i) => i + 1));
    const events = allEvents(h);
    expect(events.filter((e) => e.type !== 'catalog.updated' && e.type !== 'account.updated')[0]!.type).toBe('message.updated'); // the user message first (D9)
    expect(events.some((e) => e.type === 'session.status' && e.properties.status.type === 'busy')).toBe(true);

    const snap = await h.manager.load(session.id);
    expect(snap.status.type).toBe('idle');
    expect(snap.messages[0]!.role).toBe('user');
    expect((snap.messages[0] as { agent: string }).agent).toBe('claudekei:sprinter');
    const tools = Object.values(snap.parts).flat().filter((p) => p.type === 'tool');
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.type === 'tool' && t.state.status === 'completed')).toBe(true);
  });

  test('permission round trip: asked -> respond always -> suggestions echoed -> tool completes', async () => {
    const h = createHarness('permission-edit');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await h.manager.send(id, { text: 'edit' });
    await until(() => (h.broadcaster.flush(), allEvents(h).some((e) => e.type === 'permission.asked')));
    const asked = allEvents(h).find((e) => e.type === 'permission.asked');
    expect(asked && asked.type === 'permission.asked' && asked.properties.permission).toBe('edit');
    if (asked?.type !== 'permission.asked') throw new Error();
    expect(asked.properties.always).toEqual(['Auto-accept edits for this session']);
    expect(asked.properties.sessionID).toBe(id);
    expect(asked.properties.tool?.callID).toBeTruthy();

    // a webview that reloads now sees the pending request in the bootstrap + load snapshots
    const boot = await h.manager.bootstrap();
    expect(boot.live[id]!.permissions).toHaveLength(1);
    expect((await h.manager.load(id)).permissions).toHaveLength(1);
    expect(h.manager['sessions'].get(id)!.lifecycle).toBe('live-busy');

    h.manager.respondPermission(id, asked.properties.id, 'always');
    await until(() => h.manager['sessions'].get(id)!.lifecycle === 'live-idle');
    expect(h.queries[1]!.permissionResults[0]).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits' }] });
    h.broadcaster.flush();
    expect(allEvents(h).some((e) => e.type === 'permission.replied' && e.properties.reply === 'always')).toBe(true);
    expect((await h.manager.load(id)).permissions).toEqual([]);
  });

  test('reject maps to deny', async () => {
    const h = createHarness('permission-edit');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await h.manager.send(id, { text: 'edit' });
    await until(() => (h.broadcaster.flush(), allEvents(h).some((e) => e.type === 'permission.asked')));
    const asked = allEvents(h).find((e) => e.type === 'permission.asked')!;
    if (asked.type !== 'permission.asked') throw new Error();
    h.manager.respondPermission(id, asked.properties.id, 'reject');
    await until(() => h.queries[1]!.permissionResults.length === 1);
    expect(h.queries[1]!.permissionResults[0]).toMatchObject({ behavior: 'deny', message: 'User rejected' });
  });

  test('question round trip (AskUserQuestion multi-select)', async () => {
    const h = createHarness('askuserquestion');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await h.manager.send(id, { text: 'ask' });
    await until(() => (h.broadcaster.flush(), allEvents(h).some((e) => e.type === 'question.asked')));
    const asked = allEvents(h).find((e) => e.type === 'question.asked')!;
    if (asked.type !== 'question.asked') throw new Error();
    expect(asked.properties.questions[0]).toMatchObject({ multiple: true, header: 'Colors' });
    h.manager.respondQuestion(id, asked.properties.id, [['Red', 'Blue']]);
    await until(() => h.queries[1]!.permissionResults.length === 1);
    expect(h.queries[1]!.permissionResults[0].updatedInput.answers).toEqual({ 'Which colors do you like?': 'Red, Blue' });
  });

  test('plan_exit: always switches to acceptEdits then allows', async () => {
    const h = createHarness('plan-exit');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await h.manager.send(id, { text: 'plan', mode: 'plan' });
    await until(() => (h.broadcaster.flush(), allEvents(h).some((e) => e.type === 'permission.asked')));
    const asked = allEvents(h).find((e) => e.type === 'permission.asked')!;
    if (asked.type !== 'permission.asked') throw new Error();
    expect(asked.properties.permission).toBe('plan_exit');
    expect(asked.properties.metadata.plan).toBeTruthy();
    h.manager.respondPermission(id, asked.properties.id, 'always');
    await until(() => h.queries[1]!.permissionResults.length >= 1);
    expect(h.queries[1]!.modes).toContain('acceptEdits');
    expect(h.queries[1]!.permissionResults[0].behavior).toBe('allow');
  });

  test('interrupt reaches the query; model/mode changes apply live', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    await h.manager.interrupt(id);
    expect(h.queries[1]!.interrupts).toBe(1);
    await h.manager.setModel(id, 'haiku');
    await h.manager.setMode(id, 'plan');
    expect(h.queries[1]!.models).toEqual(['haiku']);
    expect(h.queries[1]!.modes).toEqual(['plan']);
    expect(h.store.get('claudekei.sessionPrefs')).toMatchObject({ [id]: { model: 'haiku', mode: 'plan' } });
  });

  test('idle timeout closes the process; the next send resumes it', async () => {
    const h = createHarness('text', { idleTimeoutMinutes: 10 });
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    const s = h.manager['sessions'].get(id)!;
    expect(s.lifecycle).toBe('live-idle');
    h.timers.advance(9 * 60_000);
    expect(s.lifecycle).toBe('live-idle');
    h.timers.advance(61_000);
    await until(() => s.lifecycle === 'cold');
    expect(h.queries[1]!.closed).toBe(true);

    await sendAndSettle(h, id, 'again');
    expect(h.queries).toHaveLength(3);
    expect(h.queries[2]!.params.options.resume).toBe(id);
    expect(h.queries[2]!.params.options.sessionId).toBeUndefined();
  });

  test('a busy session is never idle-closed', async () => {
    const h = createHarness('text', { idleTimeoutMinutes: 1 });
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    h.queries[1]!.pause();
    await h.manager.send(id, { text: 'more' });
    h.timers.advance(5 * 60_000);
    expect(h.manager['sessions'].get(id)!.lifecycle).toBe('live-busy');
    h.queries[1]!.resume();
  });

  test('live cap: least recently used idle session is closed, busy ones are kept', async () => {
    const h = createHarness('text', { maxLiveSessions: 2 });
    await h.manager.bootstrap();
    const a = h.manager.create().id;
    const b = h.manager.create().id;
    const c = h.manager.create().id;
    await sendAndSettle(h, a);
    await tick(3);
    await sendAndSettle(h, b);
    await tick(3);
    const [qa, qb] = [h.queries[1]!, h.queries[2]!];
    await sendAndSettle(h, c);
    expect(qa.closed).toBe(true);
    expect(qb.closed).toBe(false);
    expect(h.manager['sessions'].get(a)!.lifecycle).toBe('cold');
    expect(h.manager['sessions'].get(c)!.isLive).toBe(true);

    // both live ones busy -> soft cap, nothing killed
    const d = h.manager.create().id;
    h.queries[2]!.pause();
    h.queries[3]!.pause();
    await h.manager.send(b, { text: 'x' });
    await h.manager.send(c, { text: 'x' });
    await h.manager.send(d, { text: 'x' });
    expect(h.queries[2]!.closed).toBe(false);
    expect(h.queries[3]!.closed).toBe(false);
    expect(h.logs.some((l) => l.message.includes('every live session is busy'))).toBe(true);
    for (const q of h.queries) q.resume();
  });

  test('agent switch: close + respawn with resume and the new agent; same agent does not respawn', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'one', { agent: 'claudekei:sprinter' });
    await sendAndSettle(h, id, 'two', { agent: 'claudekei:sprinter' });
    expect(h.queries).toHaveLength(2); // probe + one process
    await h.manager.setAgent(id, 'claudekei:planner');
    expect(h.queries).toHaveLength(2); // applied on the next send
    await sendAndSettle(h, id, 'three');
    expect(h.queries).toHaveLength(3);
    expect(h.queries[1]!.closed).toBe(true);
    const o = h.queries[2]!.params.options;
    expect(o.agent).toBe('claudekei:planner');
    expect(o.resume).toBe(id);
    expect(h.manager['sessions'].get(id)!.spawnCount).toBe(2);
    // the user message records the agent it was sent with
    const snap = await h.manager.load(id);
    const agents = snap.messages.filter((m) => m.role === 'user').map((m) => (m as { agent: string }).agent);
    expect(agents).toEqual(['claudekei:sprinter', 'claudekei:sprinter', 'claudekei:planner']);
  });

  test('respawn keeps subagent state: SendMessage after an agent switch links to the existing child', async () => {
    const h = createHarness((i) => (i <= 1 ? 'subagents/q2-sendmessage-sync' : 'subagents/q2-sendmessage-sync#1'));
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'start the helper', { agent: 'claudekei:sprinter' });
    const mid = await h.manager.load(id);
    expect(mid.children).toHaveLength(1);
    const childId = mid.children[0]!.id;
    const created = () => allEvents(h).filter((e) => e.type === 'session.created').length;
    const createdBefore = created();

    await h.manager.setAgent(id, 'claudekei:planner'); // forces a close + respawn on the next send
    await sendAndSettle(h, id, 'continue the helper');
    expect(h.queries).toHaveLength(3);
    expect(h.queries[2]!.params.options.resume).toBe(id);

    const snap = await h.manager.load(id);
    expect(snap.children.map((c) => c.id)).toEqual([childId]);
    expect(created()).toBe(createdBefore);
    const child = await h.manager.load(childId);
    const users = child.messages.filter((m) => m.role === 'user') as Array<{ instruction?: { index: number } }>;
    expect(users.map((u) => u.instruction?.index)).toEqual([1, 2]);
    const roles = child.messages.map((m) => m.role).filter((r, i, a) => i === 0 || r !== a[i - 1]);
    expect(roles).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  test('list / rename / fork / delete go through the SDK helpers', async () => {
    const h = createHarness('text');
    h.addTranscript('s1', 'First');
    await h.manager.bootstrap();
    const listed = await h.manager.list();
    expect(listed.map((s) => s.id)).toEqual(['s1']);
    expect(h.api.listCalls[0]).toEqual({ dir: '/work/proj', limit: undefined }); // never includeProgrammatic:false

    await h.manager.rename('s1', 'Renamed');
    expect(h.api.renamed).toEqual([['s1', 'Renamed']]);
    expect((await h.manager.list())[0]!.title).toBe('Renamed');

    const fork = await h.manager.fork('s1');
    expect(fork.id).toBe('fork-1');
    expect(h.api.forks).toEqual([{ id: 's1', upToMessageId: undefined }]);
    h.broadcaster.flush();
    expect(allEvents(h).some((e) => e.type === 'session.created' && e.properties.sessionID === 'fork-1')).toBe(true);

    await h.manager.delete('s1');
    expect(h.api.deleted).toEqual(['s1']);
    h.broadcaster.flush();
    expect(allEvents(h).some((e) => e.type === 'session.deleted' && e.properties.sessionID === 's1')).toBe(true);
    await expect(h.manager.load('s1')).rejects.toThrow('deleted');
  });

  test('deleting a live session closes it first; drafts delete without a transcript', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    h.api.infos.set(id, { sessionId: id, summary: 'x', lastModified: Date.now() });
    await h.manager.delete(id);
    expect(h.queries[1]!.closed).toBe(true);
    expect(h.api.deleted).toEqual([id]);
    const draft = h.manager.create().id;
    await h.manager.delete(draft);
  });

  test('fork at a message uses its transcript uuid', async () => {
    const h = createHarness('text');
    h.addTranscript('s1');
    h.api.history.set('s1', [
      { type: 'user', uuid: 'uu1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'aa1', timestamp: '2026-01-01T00:00:01.000Z', message: { id: 'msg_1', model: 'm', content: [{ type: 'text', text: 'yo' }] } },
    ]);
    await h.manager.bootstrap();
    const snap = await h.manager.load('s1');
    const assistant = snap.messages.find((m) => m.role === 'assistant')!;
    await h.manager.fork('s1', assistant.id);
    expect(h.api.forks[0]).toEqual({ id: 's1', upToMessageId: 'aa1' });
  });

  test('a cold session is replayed from history on load and resumed on send', async () => {
    const h = createHarness('text');
    h.addTranscript('s1');
    h.api.history.set('s1', [
      { type: 'user', uuid: 'uu1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'aa1', timestamp: '2026-01-01T00:00:01.000Z', message: { id: 'msg_1', model: 'm', content: [{ type: 'text', text: 'yo' }] } },
    ]);
    await h.manager.bootstrap();
    const before = await h.manager.load('s1');
    expect(before.messages).toHaveLength(2);
    await sendAndSettle(h, 's1', 'again');
    expect(h.queries[1]!.params.options.resume).toBe('s1');
    const after = await h.manager.load('s1');
    expect(after.messages.length).toBeGreaterThan(3); // history + new turn
    expect(after.messages.slice(0, 2).map((m) => m.id)).toEqual(before.messages.map((m) => m.id));
  });

  test('subagent child sessions are loadable by their id', async () => {
    const h = createHarness('task-sync');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'task');
    const snap = await h.manager.load(id);
    expect(snap.children).toHaveLength(1);
    const child = await h.manager.load(snap.children[0]!.id);
    expect(child.session.parentID).toBe(id);
    expect(child.messages.length).toBeGreaterThan(0);
  });

  test('replayFixture streams a recording into a synthetic session', async () => {
    const h = createHarness('text');
    const { loadNdjson } = await import('./testUtils');
    const id = await h.manager.replayFixture('edit', loadNdjson('edit'), 0);
    await until(() => (h.broadcaster.flush(), h.manager['sessions'].get(id)!.status.type === 'idle' && allEvents(h).some((e) => e.type === 'message.part.updated')), 3000);
    const snap = await h.manager.load(id);
    expect(Object.values(snap.parts).flat().some((p) => p.type === 'tool' && p.tool === 'edit')).toBe(true);
  });

  test('restartSessions closes live processes and re-probes', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    await h.manager.restartSessions();
    expect(h.queries[1]!.closed).toBe(true);
    expect(h.manager['sessions'].get(id)!.lifecycle).toBe('cold');
    expect(h.queries.length).toBeGreaterThanOrEqual(3); // new probe
  });

  test('logged-out account sets error status; unexpected process death surfaces a session error', async () => {
    const h = createHarness('text', {}, { agents: [], models: [], commands: [], account: {} });
    const boot = await h.manager.bootstrap();
    expect(h.manager.getStatus().status).toBe('error');
    expect(h.manager.getStatus().error).toContain('claude login');
    expect(boot.account).toBeNull();
    h.broadcaster.flush();
    const auth = allEvents(h).filter((e) => e.type === 'session.error');
    expect(auth.length).toBeGreaterThan(0);
    expect(auth[0]).toMatchObject({ properties: { error: { kind: 'auth', name: 'AuthRequired' } } });
    expect((auth[0] as any).properties.sessionID).toBeUndefined();
  });

  test('Session carries agent and live mode in list, load and session.updated', async () => {
    const h = createHarness('text');
    h.addTranscript('s1');
    h.store.set('claudekei.sessionPrefs', { s1: { model: 'haiku', mode: 'plan', agent: 'claudekei:planner' } });
    await h.manager.bootstrap();
    expect((await h.manager.list())[0]).toMatchObject({ id: 's1', agent: 'claudekei:planner', mode: 'plan' });
    expect((await h.manager.load('s1')).session).toMatchObject({ agent: 'claudekei:planner', mode: 'plan' });
    const { id } = h.manager.create();
    expect(h.manager['sessions'].get(id)!.info).toMatchObject({ agent: 'claudekei:orchestrator', mode: 'default' });
    h.broadcaster.flush();
    const before = allEvents(h).length;
    await h.manager.setMode(id, 'acceptEdits');
    await h.manager.setAgent(id, 'claudekei:sprinter');
    h.broadcaster.flush();
    const updates = allEvents(h).slice(before).filter((e) => e.type === 'session.updated').map((e) => (e as any).properties.info);
    expect(updates.map((u: any) => [u.mode, u.agent])).toEqual([['acceptEdits', 'claudekei:orchestrator'], ['acceptEdits', 'claudekei:sprinter']]);
  });

  test('plan approval: mode changes are announced (always -> acceptEdits, CLI reset -> default)', async () => {
    const h = createHarness('plan-exit');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await h.manager.send(id, { text: 'plan', mode: 'plan' });
    await until(() => (h.broadcaster.flush(), allEvents(h).some((e) => e.type === 'permission.asked')));
    const asked = allEvents(h).find((e) => e.type === 'permission.asked')!;
    if (asked.type !== 'permission.asked') throw new Error();
    expect(asked.properties.always).toEqual(['Approve & auto-accept edits']);
    h.manager.respondPermission(id, asked.properties.id, 'always');
    // the recording continues with Bash prompts after the plan was approved: answer them as they come
    const answered = new Set<string>([asked.properties.id]);
    await until(() => {
      h.broadcaster.flush();
      for (const e of allEvents(h)) {
        if (e.type === 'permission.asked' && !answered.has(e.properties.id)) {
          answered.add(e.properties.id);
          h.manager.respondPermission(id, e.properties.id, 'once');
        }
      }
      return h.manager['sessions'].get(id)!.lifecycle === 'live-idle';
    }, 4000);
    h.broadcaster.flush();
    const modes = allEvents(h).filter((e) => e.type === 'session.updated').map((e) => (e as any).properties.info.mode);
    expect(modes).toContain('plan');
    expect(modes).toContain('acceptEdits');
    // the recording's CLI then announced `default` through system/status
    expect(modes.at(-1)).toBe('default');
    expect((await h.manager.load(id)).session.mode).toBe('default');
  });

  test('a UserPromptSubmit hook block surfaces as a kind:hook error (no assistant message)', async () => {
    const h = createHarness('hook-block');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await h.manager.send(id, { text: '/claudekei:agent planner' });
    await until(() => h.manager['sessions'].get(id)!.lifecycle === 'live-idle');
    h.broadcaster.flush();
    const err = allEvents(h).find((e) => e.type === 'session.error' && e.properties.sessionID === id)!;
    expect((err as any).properties.error).toEqual({ name: 'HookBlocked', message: 'Blocked by test hook: switched agent', kind: 'hook' });
    expect((await h.manager.load(id)).messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
  });

  // --- W7 review fixes ----------------------------------------------------------------------------------

  test('H3 race: a send that wins the session lock is never killed by an idle/LRU close', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    const s = h.manager['sessions'].get(id)!;
    // closeIfIdle decided "idle" a moment ago; the send arrives right after and must survive
    const close = s.closeIfIdle();
    const send = h.manager.send(id, { text: 'again' });
    expect(await close).toBe(true);
    await send;
    await until(() => s.lifecycle === 'live-idle');
    expect(h.queries.length).toBe(3); // probe, first process (closed), second process serving the send
    expect(h.queries[2]!.closed).toBe(false);
    expect(h.queries[2]!.prompts).toHaveLength(1);
    // the other order: send first, then the (stale) idle close finds the session busy and leaves it alone
    h.queries[2]!.pause();
    await h.manager.send(id, { text: 'busy' });
    expect(await s.closeIfIdle()).toBe(false);
    expect(h.queries[2]!.closed).toBe(false);
    h.queries[2]!.resume();
  });

  test('H3 race: idle timer fires between check and a new send -> send wins', async () => {
    const h = createHarness('text', { idleTimeoutMinutes: 1 });
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    const s = h.manager['sessions'].get(id)!;
    s.lastActivity = 0;
    const sending = h.manager.send(id, { text: 'x' });
    h.timers.advance(61_000); // timer callback runs while the send is in flight
    await sending;
    await until(() => s.lifecycle === 'live-idle');
    // whichever got the lock first, the message was served by a live process that nobody closed afterwards
    const serving = h.queries.filter((q) => q.params.options.persistSession !== false).find((q) => q.prompts.some((p: any) => p.message.content[0].text === 'x'))!;
    expect(serving.closed).toBe(false);
    expect(s.isLive).toBe(true);
  });

  test('H3 delete: session is unreachable before the close finishes; later sends are rejected', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    h.api.infos.set(id, { sessionId: id, summary: 'x', lastModified: Date.now() });
    const s = h.manager['sessions'].get(id)!;
    const deleting = h.manager.delete(id);
    expect(h.manager['sessions'].has(id)).toBe(false); // removed before awaiting close/deleteSession
    expect(s.isDisposed).toBe(true);
    await expect(s.send({ text: 'late' })).rejects.toThrow('deleted');
    await expect(h.manager.send(id, { text: 'late' })).rejects.toThrow(); // resolves from the (now removed) transcript
    await deleting;
    expect(h.api.deleted).toEqual([id]);
    expect(h.queries.filter((q) => !q.closed && q.params.options.persistSession !== false)).toHaveLength(0);
  });

  test('H3 delete while a send is queued behind the lock: the send is rejected, nothing respawns', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    h.api.infos.set(id, { sessionId: id, summary: 'x', lastModified: Date.now() });
    const s = h.manager['sessions'].get(id)!;
    const queued = s.closeIfIdle(); // holds the exclusive section
    const sending = h.manager.send(id, { text: 'x' });
    const outcome = sending.then(() => 'sent', (e: Error) => e.message);
    await h.manager.delete(id);
    await queued;
    expect(await outcome).toContain('deleted');
    expect(h.queries).toHaveLength(2);
  });

  test('M1: load flushes the requesting webview first and returns its seq', async () => {
    const h = createHarness('text');
    h.addTranscript('s1');
    await h.manager.bootstrap();
    const sink = [...h.broadcaster['sinks'].values()][0]!;
    h.broadcaster.emit([{ type: 'session.status', properties: { sessionID: 's1', status: { type: 'busy' } } }]);
    const before = h.pushes.length;
    const snap = await h.manager.load('s1', sink.id);
    expect(h.pushes.length).toBe(before + 1); // pending events were pushed before the snapshot
    expect(snap.eventSeq).toBe(h.pushes.at(-1)!.seq);
    const boot = await h.manager.bootstrap(sink.id);
    expect(boot.eventSeq).toBe(h.pushes.at(-1)!.seq);
  });

  test('M4 fork: user message cuts before it, first message forks to a fresh session, tool calls keep their result', async () => {
    const h = createHarness('text');
    h.addTranscript('s1');
    const t = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
    h.api.history.set('s1', [
      { type: 'user', uuid: 'u1', timestamp: t(0), message: { role: 'user', content: 'first' } },
      { type: 'assistant', uuid: 'a1', timestamp: t(1), message: { id: 'msg_1', model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'user', uuid: 'r1', timestamp: t(2), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } },
      { type: 'assistant', uuid: 'a2', timestamp: t(3), message: { id: 'msg_2', model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } },
      { type: 'user', uuid: 'u2', timestamp: t(4), message: { role: 'user', content: 'second' } },
      { type: 'assistant', uuid: 'a3', timestamp: t(5), message: { id: 'msg_3', model: 'm', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'pwd' } }] } },
    ]);
    await h.manager.bootstrap();
    const snap = await h.manager.load('s1');
    const [first, toolMsg, done, second, dangling] = snap.messages;
    await h.manager.fork('s1', second!.id);
    expect(h.api.forks.at(-1)!.upToMessageId).toBe('a2'); // entry before the user message
    await h.manager.fork('s1', toolMsg!.id);
    expect(h.api.forks.at(-1)!.upToMessageId).toBe('r1'); // includes the tool_result of the trailing tool call
    await h.manager.fork('s1', done!.id);
    expect(h.api.forks.at(-1)!.upToMessageId).toBe('a2');
    // a tool call without a recorded result cannot be a cut point: fall back to the previous complete message
    await h.manager.fork('s1', dangling!.id);
    expect(h.api.forks.at(-1)!.upToMessageId).toBe('u2');
    const forksBefore = h.api.forks.length;
    const fresh = await h.manager.fork('s1', first!.id);
    expect(h.api.forks.length).toBe(forksBefore); // no SDK fork for the very first message
    expect(fresh.id).not.toBe('s1');
    expect(h.manager['sessions'].get(fresh.id)!.exists).toBe(false);
  });

  test('M5: bootstrap does not re-probe within 5 minutes; an explicit refresh always does', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const probes = () => h.queries.filter((q) => q.params.options.persistSession === false).length;
    expect(probes()).toBe(1);
    await h.manager.bootstrap();
    await h.manager.bootstrap();
    expect(probes()).toBe(1);
    await h.manager.refreshCatalog();
    expect(probes()).toBe(2);
  });

  test('M7: cold sessions are unloaded beyond 20 (live ones never), stale drafts are dropped', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    for (let i = 0; i < 26; i++) {
      h.addTranscript(`c${i}`);
      await h.manager.load(`c${i}`);
    }
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    for (let i = 26; i < 30; i++) {
      h.addTranscript(`c${i}`);
      await h.manager.load(`c${i}`);
    }
    const map = h.manager['sessions'] as Map<string, any>;
    expect([...map.values()].filter((s) => !s.isLive).length).toBeLessThanOrEqual(20);
    expect(map.get(id)!.isLive).toBe(true);
    // an unloaded session reloads transparently
    expect((await h.manager.load('c0')).session.id).toBe('c0');
    // stale unsent draft
    const draft = h.manager.create().id;
    map.get(draft).lastActivity = Date.now() - 2 * 60 * 60_000;
    await h.manager.list();
    expect(map.has(draft)).toBe(false);
  });

  test('M9: modes are validated on the host; bypassPermissions needs the setting', async () => {
    const h = createHarness('text', { allowBypassPermissions: false });
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await h.manager.setMode(id, 'nonsense' as never);
    await h.manager.setMode(id, 'bypassPermissions');
    expect(h.manager['sessions'].get(id)!.prefs.mode).toBe('default');
    await h.manager.send(id, { text: 'x', mode: 'bypassPermissions' });
    await until(() => h.manager['sessions'].get(id)!.lifecycle === 'live-idle');
    expect(h.queries[1]!.params.options.permissionMode).toBe('default');
    expect(h.queries[1]!.params.options.allowDangerouslySkipPermissions).toBeUndefined();
    h.config.allowBypassPermissions = true;
    await h.manager.setMode(id, 'bypassPermissions');
    expect(h.manager['sessions'].get(id)!.prefs.mode).toBe('bypassPermissions');
    // a stored/forked preference is downgraded at spawn when the setting is off again
    h.config.allowBypassPermissions = false;
    const other = h.manager.create().id;
    h.manager['sessions'].get(other)!.prefs.mode = 'bypassPermissions';
    await h.manager.send(other, { text: 'x' });
    await until(() => h.manager['sessions'].get(other)!.lifecycle === 'live-idle');
    expect(h.queries.at(-1)!.params.options.permissionMode).toBe('default');
    expect(h.queries.at(-1)!.params.options.allowDangerouslySkipPermissions).toBeUndefined();
  });

  test('attachments: images/pdf/text go through, binary files are rejected before anything starts', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    const bin = { mime: 'application/zip', filename: 'a.zip', dataUrl: 'data:application/zip;base64,UEsDBA==' };
    await expect(h.manager.send(id, { text: 'x', files: [bin] })).rejects.toThrow('Unsupported attachment type');
    await expect(h.manager.send(id, { text: 'x', files: [{ mime: 'text/plain', filename: 'a.txt', dataUrl: 'nope' }] })).rejects.toThrow('base64');
    expect(h.queries).toHaveLength(1); // only the probe: nothing was spawned
    const ok = [
      { mime: 'image/png', filename: 'a.png', dataUrl: 'data:image/png;base64,AAAA' },
      { mime: 'application/pdf', filename: 'a.pdf', dataUrl: 'data:application/pdf;base64,AAAA' },
      { mime: 'application/json', filename: 'a.json', dataUrl: `data:application/json;base64,${Buffer.from('{"a":1}').toString('base64')}` },
    ];
    await h.manager.send(id, { text: 'look', files: ok });
    await until(() => h.queries[1]!.prompts.length === 1);
    const content = h.queries[1]!.prompts[0].message.content;
    expect(content.map((b: any) => b.type)).toEqual(['text', 'image', 'document', 'text']);
    expect(content[3].text).toContain('{"a":1}');
  });

  test('interrupt while the process is still starting cancels that send', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    const s = h.manager['sessions'].get(id)!;
    const sending = s.send({ text: 'x' });
    const outcome = sending.then(() => 'sent', (e: Error) => e.message);
    await s.interrupt(); // the process does not exist yet
    expect(await outcome).toContain('Interrupted before');
    await tick(10);
    expect(h.queries.filter((q) => q.params.options.persistSession !== false).every((q) => q.prompts.length === 0)).toBe(true);
    // a later send is unaffected by the stale stop
    await s.send({ text: 'y' });
    await until(() => s.lifecycle === 'live-idle');
  });

  test('commands_changed refreshes the slash-command catalog', async () => {
    const h = createHarness('text-usersettings');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    const updates = allEvents(h).filter((e) => e.type === 'catalog.updated');
    const last = updates.at(-1) as any;
    expect(last.properties.catalog.commands.length).toBeGreaterThan(10); // the recording's commands_changed list
  });

  test('M11: a third-party provider counts as logged in', async () => {
    const h = createHarness('text', {}, { agents: [], models: [], commands: [], account: { apiProvider: 'bedrock' } });
    await h.manager.bootstrap();
    expect(h.manager.getStatus().status).toBe('connected');
  });

  test('queued message agent label is the agent actually running the turn', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'one', { agent: 'claudekei:sprinter' });
    h.queries[1]!.pause();
    await h.manager.send(id, { text: 'two' }); // busy now
    await h.manager.send(id, { text: 'queued', agent: 'claudekei:planner' }); // cannot respawn mid-turn
    const users = (await h.manager.load(id)).messages.filter((m) => m.role === 'user').map((m) => (m as any).agent);
    expect(users).toEqual(['claudekei:sprinter', 'claudekei:sprinter', 'claudekei:sprinter']);
    expect(h.queries).toHaveLength(2);
    h.queries[1]!.resume();
  });

  test('diagnostics', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const d = await h.manager.diagnostics();
    expect(d.status).toBe('connected');
    expect(d.loginPath).toBe('/opt/login/bin');
    expect(d.catalog.primaryAgents).toContain('claudekei:planner');
  });
});

describe('stopping a turn stops the subagents (docs/STOP_SUBAGENTS_FIX.md)', () => {
  const child = (h: Harness, id: string) => h.manager['sessions'].get(id)!.state.sessions.get('sub_toolu_stop1');
  const agentPart = (h: Harness, id: string) => {
    const main = h.manager['sessions'].get(id)!.state.sessions.get(id)!;
    return Object.values(main.parts).flat().find((p) => p.type === 'tool' && p.callID === 'toolu_stop1') as any;
  };
  const startHung = async () => {
    const h = createHarness('subagents/stop-hang');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await h.manager.send(id, { text: 'go' });
    await until(() => child(h, id)?.status.type === 'busy');
    return { h, id, session: h.manager['sessions'].get(id)!, query: h.queries[1]! };
  };

  test('an aborted turn ends with the subagent child idle and its tool stopped', async () => {
    const h = createHarness('subagents/stop-aborted');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    expect(child(h, id)!.status).toEqual({ type: 'idle' });
    const tool = agentPart(h, id);
    expect(tool.state.status).toBe('error');
    expect(tool.state.error).toBe('Interrupted by user');
    expect(tool.state.metadata.runStatus).toBe('stopped');
    expect((await h.manager.load(id)).children.map((c) => c.id)).toEqual(['sub_toolu_stop1']);
  });

  test('interrupt asks the CLI to cancel queued prompts too', async () => {
    const { h, id } = await startHung();
    await h.manager.interrupt(id);
    expect(h.queries[1]!.interruptOptions).toEqual([{ cancelQueued: true }]);
  });

  test('interrupting from a subagent view (sub_ id) interrupts the owning session', async () => {
    const { h, query } = await startHung();
    await h.manager.interrupt('sub_toolu_stop1');
    expect(query.interrupts).toBe(1);
    await h.manager.interrupt('sub_unknown'); // no owner: silent no-op
    expect(query.interrupts).toBe(1);
  });

  test('watchdog: tasks that outlive the interrupt are stopped one by one, then the process is closed', async () => {
    const { h, id, session, query } = await startHung();
    await h.manager.interrupt(id);
    expect(query.stopped).toEqual([]);
    h.timers.advance(3999);
    expect(query.stopped).toEqual([]);
    h.timers.advance(1);
    expect(query.stopped).toEqual(['agentstop1']);
    expect(query.closed).toBe(false);
    h.timers.advance(4000);
    await until(() => query.closed && session.lifecycle !== 'live-busy' && session.lifecycle !== 'closing');
    // closing the process idles every child and ends the tool
    expect(child(h, id)!.status).toEqual({ type: 'idle' });
    expect(agentPart(h, id).state.status).toBe('error');
    expect(session.status).toEqual({ type: 'idle' });
  });

  test('watchdog does nothing once the turn is over', async () => {
    const h = createHarness('subagents/stop-aborted');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    const query = h.queries[1]!;
    await h.manager.interrupt(id);
    h.timers.advance(20_000);
    expect(query.stopped).toEqual([]);
    expect(query.closed).toBe(false);
  });
});
