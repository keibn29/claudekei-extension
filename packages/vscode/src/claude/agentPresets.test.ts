import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, UserMessage } from '@openchamber/ui/src/lib/claude/types';
import { derivePrimaryAgents } from './catalog';
import { readAgentPresets } from './claudekeiConfig';
import { allEvents, createHarness, until, STUB_INIT, FakeSessionApi, type Harness } from './fakes';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Temp home + project with optional claudekei.jsonc files. */
const sandbox = (files: { user?: string; project?: string }) => {
  const root = mkdtempSync(join(tmpdir(), 'ck-presets-'));
  dirs.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'proj');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(cwd, '.claude'), { recursive: true });
  if (files.user !== undefined) writeFileSync(join(home, '.claude', 'claudekei.jsonc'), files.user);
  if (files.project !== undefined) writeFileSync(join(cwd, '.claude', 'claudekei.jsonc'), files.project);
  return { home, cwd };
};

const PRESETS = `{
  // comments and trailing commas are fine
  "primaryAgents": {
    "orchestrator": { "model": "haiku", "effort": "high", },
    "planner": { "model": "sonnet", "effort": "max" },
    /* no effort for the sprinter */
    "sprinter": { "model": "haiku" },
  },
}`;

const sendAndSettle = async (h: Harness, id: string, text = 'go', extra: Record<string, unknown> = {}) => {
  await h.manager.send(id, { text, ...extra } as never);
  await until(() => h.manager['sessions'].get(id)!.lifecycle === 'live-idle', 3000);
  h.broadcaster.flush();
};

const infoOf = async (h: Harness, id: string): Promise<Session> => (await h.manager.load(id)).session;

describe('claudekei.jsonc presets', () => {
  test('JSONC with comments and trailing commas; bare and prefixed keys; project wins per field', () => {
    const { home, cwd } = sandbox({
      user: `{ "primaryAgents": { "planner": { "model": "opus", "effort": "low" }, "claudekei:sprinter": { "model": "haiku" } } }`,
      project: `{ "primaryAgents": { "planner": { "effort": "xhigh", }, }, // note\n }`,
    });
    expect(readAgentPresets({ cwd, home })).toEqual({
      'claudekei:planner': { model: 'opus', effort: 'xhigh' },
      'claudekei:sprinter': { model: 'haiku' },
    });
  });

  test('missing files, malformed content and invalid fields are ignored', () => {
    expect(readAgentPresets(sandbox({}))).toEqual({});
    expect(readAgentPresets(sandbox({ user: '{ not json', project: '[]' }))).toEqual({});
    const { home, cwd } = sandbox({ user: `{ "primaryAgents": { "planner": { "model": "", "effort": "ultra" }, "x": 3, "y": { "model": 5 } } }` });
    expect(readAgentPresets({ cwd, home })).toEqual({});
  });

  test('catalog: file value, else the agent frontmatter model (inherit ignored)', () => {
    const agents = [
      { name: 'claudekei:planner', description: 'primary agent', model: 'opus' },
      { name: 'claudekei:sprinter', description: 'primary agent', model: 'inherit' },
      { name: 'claudekei:orchestrator', description: 'primary agent', model: 'sonnet' },
    ];
    const byName = Object.fromEntries(derivePrimaryAgents(agents, undefined, { 'claudekei:orchestrator': { model: 'haiku', effort: 'high' } }).map((p) => [p.name, p]));
    expect(byName['claudekei:planner']!.defaultModel).toBe('opus');
    expect(byName['claudekei:planner']!.defaultEffort).toBeUndefined();
    expect(byName['claudekei:sprinter']!.defaultModel).toBeUndefined();
    expect(byName['claudekei:orchestrator']).toMatchObject({ defaultModel: 'haiku', defaultEffort: 'high' });
  });
});

describe('per-agent model/effort in the session host', () => {
  const setup = (files = { project: PRESETS }) => {
    const { home, cwd } = sandbox(files);
    const h = createHarness('text', {}, STUB_INIT, { home, cwd });
    return { h, home, cwd };
  };

  test('the catalog carries the presets and the default agent drives defaults.model/effort', async () => {
    const { h } = setup();
    const boot = await h.manager.bootstrap();
    const byName = Object.fromEntries(boot.catalog.primaryAgents.map((p) => [p.name, p]));
    expect(byName['claudekei:planner']).toMatchObject({ defaultModel: 'sonnet', defaultEffort: 'max' });
    expect(byName['claudekei:sprinter']!.defaultEffort).toBeUndefined();
    const defaultAgent = boot.catalog.defaults.agent;
    expect(defaultAgent).toBeTruthy();
    const preset = byName[defaultAgent]!;
    expect(boot.catalog.defaults.model).toBe(preset.defaultModel ?? boot.catalog.models[0]!.value);
    expect(boot.catalog.defaults.effort).toBe(preset.defaultEffort);
  });

  test('a new session starts with the default agent preset; model and effort reach the spawn options and Session', async () => {
    const { h } = setup({ project: `{ "primaryAgents": { "orchestrator": { "model": "haiku", "effort": "high" }, "planner": { "model": "sonnet", "effort": "max" } } }` });
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'go', { agent: 'claudekei:orchestrator' });
    const o = h.queries[1]!.params.options;
    expect(o.model).toBe('haiku');
    expect(o.effort).toBe('high');
    const s = await infoOf(h, id);
    expect(s).toMatchObject({ model: 'haiku', effort: 'high', agent: 'claudekei:orchestrator' });
  });

  test('switching agent applies the new preset and announces it; manual choices stick until the next switch', async () => {
    const { h } = setup();
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'one', { agent: 'claudekei:orchestrator' });
    expect(await infoOf(h, id)).toMatchObject({ model: 'haiku', effort: 'high' });

    const mark = allEvents(h).length;
    await h.manager.setAgent(id, 'claudekei:planner');
    h.broadcaster.flush();
    const updates = allEvents(h).slice(mark).filter((e) => e.type === 'session.updated');
    expect(updates.at(-1)).toMatchObject({ properties: { info: { agent: 'claudekei:planner', model: 'sonnet', effort: 'max' } } });
    expect(await infoOf(h, id)).toMatchObject({ model: 'sonnet', effort: 'max' });

    // manual choices stick across sends, with no further preset applied
    await h.manager.setModel(id, 'opus');
    await h.manager.setEffort(id, 'low');
    await sendAndSettle(h, id, 'two');
    let o = h.queries.at(-1)!.params.options;
    expect(o).toMatchObject({ model: 'opus', effort: 'low', agent: 'claudekei:planner', resume: id });
    await sendAndSettle(h, id, 'three');
    expect(await infoOf(h, id)).toMatchObject({ model: 'opus', effort: 'low' });

    // the next switch resets to the preset (sprinter has a model but no effort: effort is kept)
    await h.manager.setAgent(id, 'claudekei:sprinter');
    expect(await infoOf(h, id)).toMatchObject({ model: 'haiku', effort: 'low' });
    await sendAndSettle(h, id, 'four');
    o = h.queries.at(-1)!.params.options;
    expect(o).toMatchObject({ model: 'haiku', effort: 'low', agent: 'claudekei:sprinter' });
  });

  test('an agent sent with the message applies its preset first; explicit model/effort in the same send win', async () => {
    const { h } = setup();
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'one', { agent: 'claudekei:orchestrator' });
    await sendAndSettle(h, id, 'two', { agent: 'claudekei:planner', effort: 'low' });
    expect(h.queries.at(-1)!.params.options).toMatchObject({ model: 'sonnet', effort: 'low' });
  });

  test('presets, prefs persist per session and survive a window reload', async () => {
    const { h, home, cwd } = setup();
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'one', { agent: 'claudekei:planner' });
    await h.manager.setEffort(id, null);
    expect((h.store.get('claudekei.sessionPrefs') as Record<string, { effort: unknown; model: string }>)[id]).toMatchObject({ model: 'sonnet', effort: null });

    h.addTranscript(id);
    const h2 = createHarness('text', {}, STUB_INIT, { home, cwd, shared: { store: h.store, api: h.api } });
    const boot = await h2.manager.bootstrap();
    const listed = boot.sessions.find((s) => s.id === id)!;
    // an explicit "model default" is not replaced by the preset
    expect(listed).toMatchObject({ agent: 'claudekei:planner', model: 'sonnet' });
    expect(listed.effort).toBeUndefined();
  });

  test('editing claudekei.jsonc is picked up and pushed as catalog.updated', async () => {
    const { h, cwd } = setup();
    await h.manager.bootstrap();
    h.broadcaster.flush();
    const mark = allEvents(h).length;
    writeFileSync(join(cwd, '.claude', 'claudekei.jsonc'), `{ "primaryAgents": { "planner": { "model": "opus", "effort": "low" } } }`);
    h.manager.reloadAgentPresets();
    h.broadcaster.flush();
    const update = allEvents(h).slice(mark).find((e) => e.type === 'catalog.updated') as { properties: { catalog: { primaryAgents: Array<{ name: string; defaultModel?: string; defaultEffort?: string }> } } };
    expect(update.properties.catalog.primaryAgents.find((p) => p.name === 'claudekei:planner')).toMatchObject({ defaultModel: 'opus', defaultEffort: 'low' });
    // nothing changed: nothing pushed
    const again = allEvents(h).length;
    h.manager.reloadAgentPresets();
    h.broadcaster.flush();
    expect(allEvents(h).length).toBe(again);
  });
});

describe('effort', () => {
  test('applied live through applyFlagSettings (null = model default), no respawn', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'one');
    expect(h.queries[1]!.params.options.effort).toBeUndefined();
    await h.manager.setEffort(id, 'low');
    expect(h.queries[1]!.flags).toEqual([{ effortLevel: 'low' }]);
    await sendAndSettle(h, id, 'two', { effort: 'xhigh' });
    await h.manager.setEffort(id, null);
    expect(h.queries[1]!.flags).toEqual([{ effortLevel: 'low' }, { effortLevel: 'xhigh' }, { effortLevel: null }]);
    expect(h.queries).toHaveLength(2);
    expect((await infoOf(h, id)).effort).toBeUndefined();
  });

  test('when the live change fails the next send respawns with resume and the new effort', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'one');
    h.queries[1]!.failFlags = true;
    await h.manager.setEffort(id, 'max');
    await sendAndSettle(h, id, 'two');
    expect(h.queries).toHaveLength(3);
    expect(h.queries[1]!.closed).toBe(true);
    expect(h.queries[2]!.params.options).toMatchObject({ resume: id, effort: 'max' });
  });

  test('invalid values are ignored (setEffort and send)', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await h.manager.setEffort(id, 'turbo' as never);
    await sendAndSettle(h, id, 'one', { effort: 'warp' });
    expect(h.queries[1]!.params.options.effort).toBeUndefined();
  });
});

describe('resolvedModel', () => {
  const init = {
    ...STUB_INIT,
    models: [
      { value: 'default', displayName: 'Default', description: 'd', resolvedModel: 'claude-opus-5-5' },
      { value: 'haiku', displayName: 'Haiku', description: 'h', resolvedModel: 'claude-haiku-5-5' },
      { value: 'sonnet', displayName: 'Sonnet', description: 's', resolvedModel: 'claude-sonnet-5-5' },
    ],
  };

  test('a cold session gets it from the catalog, a live one from system/init, setModel updates it immediately', async () => {
    const h = createHarness('text', {}, init as never);
    h.addTranscript('s1');
    await h.manager.bootstrap();
    const listed = (await h.manager.list()).find((s) => s.id === 's1')!;
    expect(listed).toMatchObject({ model: 'default', resolvedModel: 'claude-opus-5-5' });

    await h.manager.setModel('s1', 'sonnet');
    expect(await infoOf(h, 's1')).toMatchObject({ model: 'sonnet', resolvedModel: 'claude-sonnet-5-5' });

    const mark = allEvents(h).length;
    await sendAndSettle(h, 's1', 'go');
    // the fixture's init reports the process's actual model
    const updates = allEvents(h).slice(mark).filter((e) => e.type === 'session.updated') as Array<{ properties: { info: Session } }>;
    expect(updates.some((u) => u.properties.info.resolvedModel === 'claude-haiku-5-5')).toBe(true);
    expect((await infoOf(h, 's1')).resolvedModel).toBe('claude-haiku-5-5');

    // a later setModel resolves through the catalog right away (the next init confirms it)
    await h.manager.setModel('s1', 'default');
    expect(await infoOf(h, 's1')).toMatchObject({ model: 'default', resolvedModel: 'claude-opus-5-5' });
  });

  test('a full model id resolves to itself', async () => {
    const h = createHarness('text', {}, init as never);
    h.addTranscript('s1');
    await h.manager.bootstrap();
    await h.manager.setModel('s1', 'claude-opus-4-1');
    expect((await infoOf(h, 's1')).resolvedModel).toBe('claude-opus-4-1');
  });
});

describe('default permission mode', () => {
  test('product default is bypassPermissions: catalog, new sessions and the spawn (allowDangerouslySkipPermissions)', async () => {
    const h = createHarness('text', { defaultPermissionMode: 'bypassPermissions', allowBypassPermissions: true });
    const boot = await h.manager.bootstrap();
    expect(boot.catalog.defaults.mode).toBe('bypassPermissions');
    const { id } = h.manager.create();
    expect(h.manager['sessions'].get(id)!.prefs.mode).toBe('bypassPermissions');
    await sendAndSettle(h, id, 'go');
    const o = h.queries[1]!.params.options;
    expect(o.permissionMode).toBe('bypassPermissions');
    expect(o.allowDangerouslySkipPermissions).toBe(true);
  });

  test('allowDangerouslySkipPermissions is set whenever bypass is allowed, so the mode can be cycled to later', async () => {
    const h = createHarness('text', { defaultPermissionMode: 'plan', allowBypassPermissions: true });
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'go');
    expect(h.queries[1]!.params.options).toMatchObject({ permissionMode: 'plan', allowDangerouslySkipPermissions: true });
    await h.manager.setMode(id, 'bypassPermissions');
    expect(h.queries[1]!.modes).toEqual(['bypassPermissions']);
  });

  test('guard: with allowBypassPermissions off the default is downgraded and bypass is refused', async () => {
    const h = createHarness('text', { defaultPermissionMode: 'bypassPermissions', allowBypassPermissions: false });
    const boot = await h.manager.bootstrap();
    expect(boot.catalog.defaults.mode).toBe('default');
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'go');
    const o = h.queries[1]!.params.options;
    expect(o.permissionMode).toBe('default');
    expect(o.allowDangerouslySkipPermissions).toBeUndefined();
    await h.manager.setMode(id, 'bypassPermissions');
    expect(h.manager['sessions'].get(id)!.prefs.mode).toBe('default');
  });

  test('an explicit acceptEdits/plan default is used as is', async () => {
    for (const mode of ['acceptEdits', 'plan'] as const) {
      const h = createHarness('text', { defaultPermissionMode: mode });
      const boot = await h.manager.bootstrap();
      expect(boot.catalog.defaults.mode).toBe(mode);
    }
  });
});

describe('agent per turn survives reloads (bug: divider and composer agent after Reload Window)', () => {
  const agentsOf = (messages: Array<{ role: string }>) => messages.filter((m) => m.role === 'user').map((m) => (m as UserMessage).agent);

  const transcriptFor = (h: Harness, id: string) => {
    const uuids = h.queries.flatMap((q) => q.prompts.map((p) => p.uuid as string));
    h.addTranscript(id);
    h.api.history.set(id, uuids.flatMap((u, i) => [
      { type: 'user', uuid: u, timestamp: `2026-01-01T00:00:0${i * 2}.000Z`, message: { role: 'user', content: `m${i}` } },
      { type: 'assistant', uuid: `a${i}`, timestamp: `2026-01-01T00:00:0${i * 2 + 1}.000Z`, message: { id: `msg_${i}`, model: 'm', content: [{ type: 'text', text: 'ok' }] } },
    ]));
  };

  test('webview reload while the host stays alive: bootstrap + load return the live agents and Session.agent', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'one', { agent: 'claudekei:orchestrator' });
    await sendAndSettle(h, id, 'two', { agent: 'claudekei:planner' });
    // a reloaded webview asks again with a fresh sink
    const boot = await h.manager.bootstrap('sink-2');
    expect(boot.sessions.find((s) => s.id === id)!.agent).toBe('claudekei:planner');
    const snap = await h.manager.load(id, 'sink-2');
    expect(snap.session.agent).toBe('claudekei:planner');
    expect(agentsOf(snap.messages)).toEqual(['claudekei:orchestrator', 'claudekei:planner']);
    // ... also after the live process was closed (cold replay inside the same host)
    transcriptFor(h, id);
    await h.manager.restartSessions();
    h.manager['sessions'].get(id)!['loaded'] = false;
    expect(agentsOf((await h.manager.load(id)).messages)).toEqual(['claudekei:orchestrator', 'claudekei:planner']);
  });

  test('window reload: a new manager over the same workspaceState replays the agents and lists the stored agent', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id, 'one', { agent: 'claudekei:sprinter' });
    await sendAndSettle(h, id, 'two', { agent: 'claudekei:planner' });
    await sendAndSettle(h, id, 'three');
    transcriptFor(h, id);

    const h2 = createHarness('text', {}, STUB_INIT, { shared: { store: h.store, api: h.api } });
    const boot = await h2.manager.bootstrap();
    expect(boot.sessions.find((s) => s.id === id)!.agent).toBe('claudekei:planner');
    expect(boot.catalog.defaults.agent).not.toBe('claudekei:planner'); // the default is not what the session shows
    const snap = await h2.manager.load(id);
    expect(snap.session.agent).toBe('claudekei:planner');
    expect(agentsOf(snap.messages)).toEqual(['claudekei:sprinter', 'claudekei:planner', 'claudekei:planner']);
    // continuing after the reload keeps the stored agent (no fallback to the default agent)
    await sendAndSettle(h2, id, 'four');
    expect(h2.queries.at(-1)!.params.options.agent).toBe('claudekei:planner');
  });

  test('an old session without a per-turn record: every turn shows the first-run agent, then the current one is kept', async () => {
    const h = createHarness('text');
    h.addTranscript('old');
    h.api.history.set('old', [
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'a' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01.000Z', message: { id: 'm1', model: 'm', content: [{ type: 'text', text: 'ok' }] } },
    ]);
    h.store.set('claudekei.sessionPrefs', { old: { model: 'default', mode: 'default', agent: 'claudekei:planner' } });
    await h.manager.bootstrap();
    const snap = await h.manager.load('old');
    expect(snap.session.agent).toBe('claudekei:planner');
    expect(agentsOf(snap.messages)).toEqual(['claudekei:planner']);
  });
});

void FakeSessionApi;
