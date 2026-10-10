/** Host side of the settings pages (docs/SETTINGS_USAGE_SPEC.md sections 2.4, 2.5, 2.6, 9). */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleClaudeBridgeMessage } from '../bridge-claude-runtime';
import { allEvents, createHarness, until, type Harness } from './fakes';
import { mapMcpServers, mcpConfigJson } from './mcpStatus';
import { createMapper } from './mapper';
import { fakeClock, loadJson } from './testUtils';
import { parseUsageActivity } from './usageLimits';
import type { ClaudeSessionManager } from './ClaudeSessionManager';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), `claudekei-${prefix}-`));
  dirs.push(d);
  return d;
};

const server = (name: string, over: Record<string, unknown> = {}) => ({ name, status: 'connected', source: 'user', scope: 'user', config: { type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' } }, tools: [{ name: 't1' }, { name: 't2' }], ...over });
const probes = (h: Harness) => h.queries.filter((q) => q.params.options.persistSession === false).length;

describe('mcpStatus', () => {
  test('polls until nothing is pending and maps origin, scope, config and tool count', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    h.mcp.responses = [
      [server('a', { status: 'pending' }), server('b', { status: 'pending', tools: undefined })],
      [server('a'), server('b', { status: 'pending' })],
      [
        server('a'),
        server('b', { status: 'needs-auth', source: 'claudeai', scope: 'claudeai', config: { type: 'claudeai-proxy', url: 'https://x', id: 'y' }, tools: undefined }),
        server('plugin:p:s', { source: 'plugin', scope: undefined, config: { type: 'http', url: 'https://p/mcp' } }),
        server('h', { source: 'local', scope: 'local', config: { type: 'sse', url: 'https://h/sse', headers: { Authorization: 'x' } }, serverInfo: { name: 'h', version: '1' } }),
        server('bad', { status: 'failed', error: 'spawn ENOENT', config: { type: 'stdio' } }),
      ],
    ];
    const snapshot = await h.manager.mcpStatus();
    expect(h.mcp.calls).toBe(3);
    expect(snapshot.error).toBeUndefined();
    const byName = Object.fromEntries(snapshot.servers.map((s) => [s.name, s]));
    expect(byName.a).toEqual({ name: 'a', status: 'connected', origin: 'user', scope: 'user', config: { type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' } }, toolCount: 2 });
    expect(byName.b).toEqual({ name: 'b', status: 'needs-auth', origin: 'claudeai', toolCount: 0 });
    expect(byName['plugin:p:s']).toMatchObject({ origin: 'plugin', toolCount: 2 });
    expect(byName['plugin:p:s']!.scope).toBeUndefined();
    expect(byName['plugin:p:s']!.config).toBeUndefined();
    expect(byName.h).toMatchObject({ origin: 'local', scope: 'local', config: { type: 'sse', url: 'https://h/sse', headers: { Authorization: 'x' } }, serverInfo: { name: 'h', version: '1' } });
    expect(byName.bad).toMatchObject({ status: 'failed', error: 'spawn ENOENT', origin: 'user' });
    expect(byName.bad!.scope).toBeUndefined(); // a stdio config without a command is not editable
  });

  test('is cached, refresh re-probes, concurrent callers share one probe', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    h.mcp.responses = [[server('a')]];
    const before = probes(h);
    const [first, second] = await Promise.all([h.manager.mcpStatus(), h.manager.mcpStatus(true)]);
    expect(probes(h) - before).toBe(1);
    expect(second).toBe(first);
    await h.manager.mcpStatus();
    expect(probes(h) - before).toBe(1); // cached
    await h.manager.mcpStatus(true);
    expect(probes(h) - before).toBe(2);
  });

  test('a failing probe reports the error and keeps the last known servers', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    h.mcp.statusError = 'boom';
    const first = await h.manager.mcpStatus(true);
    expect(first).toMatchObject({ servers: [], error: 'boom' });
    h.mcp.statusError = undefined;
    h.mcp.responses = [[server('a')]];
    expect((await h.manager.mcpStatus(true)).servers.map((s) => s.name)).toEqual(['a']);
    h.mcp.statusError = 'boom again';
    const failed = await h.manager.mcpStatus(true);
    expect(failed.error).toBe('boom again');
    expect(failed.servers.map((s) => s.name)).toEqual(['a']);
    // an error is not cached
    h.mcp.statusError = undefined;
    expect((await h.manager.mcpStatus()).error).toBeUndefined();
  });

  test('mapMcpServers ignores malformed entries and unknown statuses', () => {
    expect(mapMcpServers([null, 'x', {}, { name: 'z', status: 'weird' }])).toEqual([{ name: 'z', status: 'pending', origin: 'unknown', toolCount: 0 }]);
    expect(mcpConfigJson({ type: 'http', url: 'https://a', headers: {} })).toBe('{"type":"http","url":"https://a"}');
  });
});

describe('toggleMcp / saveMcp / removeMcp', () => {
  test('toggle goes through the probe query, then the config is reloaded', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const before = probes(h);
    await h.manager.toggleMcp('plugin:p:s', false);
    expect(h.mcp.toggles).toEqual([['plugin:p:s', false]]);
    expect(probes(h) - before).toBe(2); // the toggle probe + the catalog re-probe of reloadConfig
    h.mcp.toggleError = 'nope';
    await expect(h.manager.toggleMcp('x', true)).rejects.toThrow('nope');
  });

  test('create runs `claude mcp add-json` with the exact arguments in the workspace', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    await h.manager.saveMcp({ name: 'my-srv_1', scope: 'user', create: true, config: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { K: 'v' } } });
    await h.manager.saveMcp({ name: 'web', scope: 'local', create: true, config: { type: 'http', url: 'https://x.dev/mcp', headers: { Authorization: 'Bearer t' } } });
    expect(h.cliCalls).toEqual([
      { args: ['mcp', 'add-json', '-s', 'user', '--', 'my-srv_1', '{"type":"stdio","command":"npx","args":["-y","pkg"],"env":{"K":"v"}}'], cwd: '/work/proj' },
      { args: ['mcp', 'add-json', '-s', 'local', '--', 'web', '{"type":"http","url":"https://x.dev/mcp","headers":{"Authorization":"Bearer t"}}'], cwd: '/work/proj' },
    ]);
  });

  test('validation: names, project creation, config shape', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const stdio = { type: 'stdio', command: 'x' } as const;
    await expect(h.manager.saveMcp({ name: 'bad name', scope: 'user', create: true, config: stdio })).rejects.toThrow('Server names');
    await expect(h.manager.saveMcp({ name: 'a'.repeat(65), scope: 'user', create: true, config: stdio })).rejects.toThrow('Server names');
    for (const name of ['-rf', '--help', '-', '-x']) {
      await expect(h.manager.saveMcp({ name, scope: 'user', create: true, config: stdio })).rejects.toThrow('Server names');
      await expect(h.manager.removeMcp({ name, scope: 'user' })).rejects.toThrow('Invalid server name');
    }
    await expect(h.manager.saveMcp({ name: 'p', scope: 'project', create: true, config: stdio })).rejects.toThrow('Add project servers in .mcp.json');
    await expect(h.manager.saveMcp({ name: 'p', scope: 'user', create: true, config: { type: 'stdio', command: '  ' } })).rejects.toThrow('needs a command');
    await expect(h.manager.saveMcp({ name: 'p', scope: 'user', create: true, config: { type: 'http', url: 'ftp://x' } })).rejects.toThrow('http:// or https://');
    await expect(h.manager.saveMcp({ name: 'p', scope: 'user', create: true, config: { type: 'sse', url: 'nope' } })).rejects.toThrow('not valid');
    expect(h.cliCalls).toEqual([]);
  });

  test('update = remove + add-json merged onto the stored config (unknown fields survive); a failed add restores the exact previous entry', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const stored = { type: 'http', url: 'https://old', headers: { A: '1', B: '2' }, headersHelper: 'node helper.js', oauth: { clientId: 'abc', callbackPort: 9 }, timeout: 5000 };
    h.mcp.responses = [[server('srv', { source: 'local', scope: 'local', config: stored })]];
    const next = { type: 'http', url: 'https://new', headers: { A: '1', C: '3' } } as const;
    await h.manager.saveMcp({ name: 'srv', scope: 'local', create: false, config: next });
    const merged = { type: 'http', headersHelper: 'node helper.js', oauth: { clientId: 'abc', callbackPort: 9 }, timeout: 5000, url: 'https://new', headers: { A: '1', C: '3' } };
    expect(h.cliCalls.map((c) => c.args)).toEqual([
      ['mcp', 'remove', '-s', 'local', '--', 'srv'],
      ['mcp', 'add-json', '-s', 'local', '--', 'srv', JSON.stringify(merged)],
    ]);

    h.cliCalls.length = 0;
    h.cliFail.current = (args) => (args[1] === 'add-json' && args.at(-1)!.includes('https://new') ? 'Invalid configuration' : undefined);
    await expect(h.manager.saveMcp({ name: 'srv', scope: 'local', create: false, config: next })).rejects.toThrow('Invalid configuration');
    expect(h.cliCalls.map((c) => c.args)).toEqual([
      ['mcp', 'remove', '-s', 'local', '--', 'srv'],
      ['mcp', 'add-json', '-s', 'local', '--', 'srv', JSON.stringify(merged)],
      ['mcp', 'add-json', '-s', 'local', '--', 'srv', JSON.stringify(stored)], // the rollback is the stored entry, byte for byte
    ]);

    h.cliCalls.length = 0;
    h.cliFail.current = undefined;
    await expect(h.manager.saveMcp({ name: 'ghost', scope: 'local', create: false, config: next })).rejects.toThrow('was not found');
    await expect(h.manager.saveMcp({ name: 'srv', scope: 'user', create: false, config: next })).rejects.toThrow('was not found'); // other scope
    expect(h.cliCalls).toEqual([]);
  });

  test('update never trusts the status cache: the stored config is read again, and an unreadable status aborts', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    h.mcp.responses = [[server('srv', { config: { type: 'stdio', command: 'old', timeout: 1 } })]];
    await h.manager.mcpStatus(true); // cached 30 s
    // the file changed since (another window / the CLI)
    h.mcp.calls = 0;
    h.mcp.responses = [[server('srv', { config: { type: 'stdio', command: 'edited-elsewhere', args: ['z'], timeout: 7 } })]];
    await h.manager.saveMcp({ name: 'srv', scope: 'user', create: false, config: { type: 'stdio', command: 'new' } });
    expect(h.cliCalls.map((c) => c.args)).toEqual([
      ['mcp', 'remove', '-s', 'user', '--', 'srv'],
      ['mcp', 'add-json', '-s', 'user', '--', 'srv', '{"type":"stdio","timeout":7,"command":"new"}'],
    ]);

    h.cliCalls.length = 0;
    h.mcp.statusError = 'probe died';
    await expect(h.manager.saveMcp({ name: 'srv', scope: 'user', create: false, config: { type: 'stdio', command: 'new' } })).rejects.toThrow('Could not read the current server configuration: probe died');
    expect(h.cliCalls).toEqual([]);
  });

  test('a transport change starts from a clean config; edited env values keep their stored value when unchanged', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    h.mcp.responses = [[server('srv', { config: { type: 'stdio', command: 'x', env: { A: '1', B: '2' }, timeout: 3 } })]];
    await h.manager.saveMcp({ name: 'srv', scope: 'user', create: false, config: { type: 'sse', url: 'https://s/sse' } });
    expect(h.cliCalls.at(-1)!.args.at(-1)).toBe('{"type":"sse","url":"https://s/sse"}');
    h.cliCalls.length = 0;
    await h.manager.saveMcp({ name: 'srv', scope: 'user', create: false, config: { type: 'stdio', command: 'x', env: { A: '1', C: '9' } } });
    expect(JSON.parse(h.cliCalls.at(-1)!.args.at(-1)!)).toEqual({ type: 'stdio', command: 'x', timeout: 3, env: { A: '1', C: '9' } });
  });

  test('remove', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    await h.manager.removeMcp({ name: 'srv', scope: 'local' });
    expect(h.cliCalls.map((c) => c.args)).toEqual([['mcp', 'remove', '-s', 'local', '--', 'srv']]);
    await expect(h.manager.removeMcp({ name: 'bad name', scope: 'user' })).rejects.toThrow('Invalid server name');
    h.cliFail.current = () => 'No MCP server named "srv" in local scope';
    await expect(h.manager.removeMcp({ name: 'srv', scope: 'local' })).rejects.toThrow('No MCP server named');
  });

  test('a successful write drops the status cache and re-probes the catalog', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    h.mcp.responses = [[server('a')]];
    await h.manager.mcpStatus(true);
    const before = probes(h);
    await h.manager.removeMcp({ name: 'a', scope: 'user' });
    expect(probes(h) - before).toBe(1); // catalog probe
    await h.manager.mcpStatus();
    expect(probes(h) - before).toBe(2); // the cache was dropped
  });
});

describe('setPluginEnabled', () => {
  const setup = async () => {
    const home = tmp('home');
    const cwd = tmp('cwd');
    mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
    const install = (scope: string, projectPath?: string) => [{ scope, installPath: join(home, 'x'), version: '1', installedAt: '2026-01-01', lastUpdated: '2026-01-01', gitCommitSha: 'a', ...(projectPath ? { projectPath } : {}) }];
    writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'user-plug@market': install('user'), 'proj-plug@market': install('project', cwd) } }));
    const h = createHarness('text', {}, undefined, { home, cwd });
    await h.manager.bootstrap();
    return h;
  };

  test('runs enable / disable in the scope the plugin is installed in, then reloads', async () => {
    const h = await setup();
    const before = probes(h);
    await h.manager.setPluginEnabled('user-plug@market', true);
    await h.manager.setPluginEnabled('proj-plug@market', false);
    expect(h.cliCalls.map((c) => c.args)).toEqual([
      ['plugin', 'enable', '-s', 'user', '--json', '--', 'user-plug@market'],
      ['plugin', 'disable', '-s', 'project', '--json', '--', 'proj-plug@market'],
    ]);
    expect(probes(h) - before).toBe(2);
  });

  test('an unknown plugin is rejected before the CLI could write it into settings.json', async () => {
    const h = await setup();
    await expect(h.manager.setPluginEnabled('nope@nowhere', true)).rejects.toThrow('not installed');
    expect(h.cliCalls).toEqual([]);
  });

  test('"already enabled" is success, other CLI failures are errors', async () => {
    const h = await setup();
    h.cliFail.current = () => '✘ Failed to enable plugin "user-plug@market": Plugin "user-plug@market" is already enabled at user scope';
    await h.manager.setPluginEnabled('user-plug@market', true);
    h.cliFail.current = () => '✘ Failed to disable plugin: settings.json is not writable';
    await expect(h.manager.setPluginEnabled('user-plug@market', false)).rejects.toThrow('not writable');
  });
});

describe('reloadConfig', () => {
  test('a live idle session respawns with resume on its next send; a busy turn is never cut', async () => {
    const h = createHarness('multi-turn');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    const session = () => h.manager['sessions'].get(id)!;
    const real = () => h.queries.filter((q) => q.params.options.persistSession !== false);
    await h.manager.send(id, { text: 'one' });
    await until(() => session().lifecycle === 'live-idle', 3000);
    expect(real()).toHaveLength(1);

    const catalog = await h.manager.reloadConfig();
    expect(catalog.agents.length).toBeGreaterThan(0);
    await h.manager.send(id, { text: 'two' });
    await until(() => session().lifecycle === 'live-idle' && real().length === 2, 3000);
    expect(real()[0]!.closed).toBe(true);
    expect(real()[1]!.params.options.resume).toBe(id);

    // no reload: no respawn
    await h.manager.send(id, { text: 'three' });
    await until(() => session().lifecycle === 'live-idle', 3000);
    expect(real()).toHaveLength(2);

    // busy: marked stale, but a message sent mid-turn goes to the running process
    real()[1]!.pause();
    await h.manager.send(id, { text: 'four' });
    await h.manager.reloadConfig();
    await h.manager.send(id, { text: 'five (queued)' });
    expect(real()).toHaveLength(2);
    expect(real()[1]!.closed).toBe(false);
    real()[1]!.resume();
    await until(() => session().lifecycle === 'live-idle', 3000);
    await h.manager.send(id, { text: 'six' });
    await until(() => real().length === 3, 3000);
  });

  test('cold sessions are untouched', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await h.manager.reloadConfig();
    expect(h.manager['sessions'].get(id)!['configStale']).toBe(false);
  });
});

describe('usageActivity', () => {
  const fixture = loadJson<Record<string, any>>('config/usage-activity.json');

  test('asks for behaviors, parses day / week (sorted, top 5) and refreshes the limits', async () => {
    const h = createHarness('text', {}, undefined, { usageRaw: fixture });
    await h.manager.bootstrap();
    const activity = (await h.manager.usageActivity())!;
    const probe = h.queries.filter((q) => q.usageOptions.some((o) => o?.skipBehaviors === false));
    expect(probe).toHaveLength(1);
    expect(activity.day.requests).toBe(fixture.behaviors.day.request_count);
    expect(activity.week.sessions).toBe(fixture.behaviors.week.session_count);
    expect(activity.day.behaviors[0]).toEqual({ key: 'subagent_heavy', pct: 92 });
    expect(activity.day.agents[0]).toEqual({ name: 'claudekei:frontend-developer', pct: 44 });
    expect(activity.day.plugins).toEqual([{ name: 'claudekei', pct: 78 }]);
    expect(activity.day.mcpServers).toEqual([{ name: 'Claude Browser', pct: 5 }]);
    expect(activity.day.agents.length).toBeLessThanOrEqual(5);
    // the same response feeds the plan limits
    expect(h.manager.getUsage()?.windows.length).toBeGreaterThan(0);
  });

  test('uses a live session when there is one', async () => {
    const h = createHarness('text', {}, undefined, { usageRaw: fixture });
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await h.manager.send(id, { text: 'go' });
    await until(() => h.manager['sessions'].get(id)!.lifecycle === 'live-idle', 3000);
    const before = h.queries.length;
    await h.manager.usageActivity();
    expect(h.queries).toHaveLength(before);
    expect(h.queries[1]!.usageOptions.at(-1)).toEqual({ skipBehaviors: false });
  });

  test('null behaviors (API key, no subscription) resolve null; parseUsageActivity tolerates junk', async () => {
    const h = createHarness('text', {}, undefined, { usageRaw: loadJson('usage/usage-report.json') });
    await h.manager.bootstrap();
    expect(await h.manager.usageActivity()).toBeNull();
    expect(parseUsageActivity(null, 1)).toBeNull();
    expect(parseUsageActivity({ behaviors: { day: { agents: [{ name: 'a', pct: 1 }, { pct: 2 }, 'x'] } } }, 5)).toMatchObject({ updatedAt: 5, day: { requests: 0, agents: [{ name: 'a', pct: 1 }] }, week: { sessions: 0 } });
  });

  test('a failing probe rejects (the page shows Retry)', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    await expect(h.manager.usageActivity()).rejects.toThrow();
  });
});

describe('cost per turn (result.total_cost_usd is cumulative per query)', () => {
  const run = (totals: number[]) => {
    const mapper = createMapper({ sessionId: 's', cwd: '/w', mode: 'default', model: 'm', now: fakeClock() });
    const costs: number[] = [];
    totals.forEach((total, i) => {
      mapper.startUserMessage({ content: `turn ${i}` });
      mapper.apply({ type: 'assistant', uuid: `a${i}`, parent_tool_use_id: null, message: { id: `msg_${i}`, model: 'm', content: [{ type: 'text', text: 'hi' }] } });
      const events = mapper.apply({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: total });
      const message = events.flatMap((e) => (e.type === 'message.updated' && e.properties.info.role === 'assistant' ? [e.properties.info] : [])).at(-1);
      costs.push((message as { cost?: number }).cost ?? Number.NaN);
    });
    return costs;
  };

  test('0.10 then 0.25 gives 0.10 and 0.15', () => {
    const [first, second] = run([0.1, 0.25]);
    expect(first).toBeCloseTo(0.1, 10);
    expect(second).toBeCloseTo(0.15, 10);
  });

  test('a new mapper (respawned process) starts again at zero; a lower total never goes negative', () => {
    expect(run([0.05])[0]).toBeCloseTo(0.05, 10);
    expect(run([0.2, 0.1])[1]).toBe(0);
  });
});

describe('bridge routes (settings pages)', () => {
  const ALL = ['config.list', 'config.read', 'config.save', 'config.delete', 'config.reload', 'plugin.setEnabled', 'mcp.status', 'mcp.save', 'mcp.remove', 'mcp.toggle', 'skills.catalog', 'skills.install', 'usage.activity'].map((t) => `claude:${t}`);

  const stub = (calls: unknown[][] = [], cwd = '/nonexistent-cwd') =>
    ({
      configFs: () => ({ cwd, home: '/nonexistent-home' }),
      skillsOptions: async () => ({ cwd, home: '/nonexistent-home', env: {} }),
      reloadConfig: async () => (calls.push(['reload']), {}),
      setPluginEnabled: async (...a: unknown[]) => void calls.push(['plugin', ...a]),
      mcpStatus: async (...a: unknown[]) => (calls.push(['mcpStatus', ...a]), { servers: [], updatedAt: 1 }),
      saveMcp: async (...a: unknown[]) => void calls.push(['saveMcp', ...a]),
      removeMcp: async (...a: unknown[]) => void calls.push(['removeMcp', ...a]),
      toggleMcp: async (...a: unknown[]) => void calls.push(['toggleMcp', ...a]),
      usageActivity: async () => null,
    }) as unknown as ClaudeSessionManager;
  const call = (manager: ClaudeSessionManager, type: string, payload: Record<string, unknown>) => handleClaudeBridgeMessage({ id: '1', type, payload }, { manager });

  test('every settings route is known (none answers "Unknown Claude request")', async () => {
    for (const type of ALL) {
      const response = await call(stub(), type, {});
      expect((response as { error?: string }).error ?? '').not.toContain('Unknown Claude request');
    }
  });

  test('bad payloads are rejected before anything runs', async () => {
    const calls: unknown[][] = [];
    const manager = stub(calls);
    const bad: Array<[string, Record<string, unknown>]> = [
      ['config.read', {}],
      ['config.delete', { path: 3 }],
      ['config.save', { kind: 'bogus', scope: 'user', name: 'a', create: true, fields: {}, body: '' }],
      ['config.save', { kind: 'agent', scope: 'plugin', name: 'a', create: true, fields: {}, body: '' }],
      ['config.save', { kind: 'agent', scope: 'user', name: 'a', create: 'yes', fields: {}, body: '' }],
      ['config.save', { kind: 'agent', scope: 'user', name: 'a', create: true, fields: { description: 1 }, body: '' }],
      ['config.save', { kind: 'agent', scope: 'user', name: 'a', create: true, fields: {}, body: 5 }],
      ['plugin.setEnabled', { id: 'p@m', enabled: 'on' }],
      ['plugin.setEnabled', { enabled: true }],
      ['mcp.save', { name: 'a', scope: 'global', create: true, config: { type: 'stdio', command: 'x' } }],
      ['mcp.save', { name: 'a', scope: 'user', create: true, config: { type: 'ws', url: 'x' } }],
      ['mcp.save', { name: 'a', scope: 'user', create: true, config: { type: 'stdio' } }],
      ['mcp.save', { name: 'a', scope: 'user', create: true, config: { type: 'stdio', command: 'x', args: [1] } }],
      ['mcp.save', { name: 'a', scope: 'user', create: true, config: { type: 'http', url: 'https://x', headers: { a: 1 } } }],
      ['mcp.save', { name: 'a', scope: 'user', config: { type: 'stdio', command: 'x' } }],
      ['mcp.remove', { name: 'a', scope: 'x' }],
      ['mcp.toggle', { name: 'a' }],
      ['skills.install', { source: 's', dirs: [], scope: 'user', overwrite: false }],
      ['skills.install', { source: 's', dirs: ['a'], scope: 'local', overwrite: false }],
      ['skills.install', { source: 's', dirs: ['a'], scope: 'user' }],
    ];
    for (const [type, payload] of bad) expect(await call(manager, `claude:${type}`, payload)).toMatchObject({ success: false });
    expect(calls).toEqual([]);
  });

  test('valid payloads reach the manager with the validated shape', async () => {
    const calls: unknown[][] = [];
    const manager = stub(calls);
    await call(manager, 'claude:plugin.setEnabled', { id: 'p@m', enabled: false });
    await call(manager, 'claude:mcp.status', { refresh: true });
    await call(manager, 'claude:mcp.status', {});
    await call(manager, 'claude:mcp.save', { name: 'a', scope: 'local', create: true, config: { type: 'http', url: 'https://x', headers: { H: 'v' }, junk: 1 } });
    await call(manager, 'claude:mcp.save', { name: 'b', scope: 'user', create: false, config: { type: 'stdio', command: 'x', args: ['1'], env: { E: '1' } } });
    await call(manager, 'claude:mcp.remove', { name: 'a', scope: 'local' });
    await call(manager, 'claude:mcp.toggle', { name: 'a', enabled: true });
    expect(calls).toEqual([
      ['plugin', 'p@m', false],
      ['mcpStatus', true],
      ['mcpStatus', false],
      ['saveMcp', { name: 'a', scope: 'local', create: true, config: { type: 'http', url: 'https://x', headers: { H: 'v' } } }],
      ['saveMcp', { name: 'b', scope: 'user', create: false, config: { type: 'stdio', command: 'x', args: ['1'], env: { E: '1' } } }],
      ['removeMcp', { name: 'a', scope: 'local' }],
      ['toggleMcp', 'a', true],
    ]);
    expect(await call(manager, 'claude:usage.activity', {})).toMatchObject({ success: true, data: null });
  });

  test('writes trigger a background reloadConfig; reads do not; config.reload returns the catalog', async () => {
    const cwd = tmp('bridge');
    const calls: unknown[][] = [];
    const manager = stub(calls, cwd);
    const saved = await call(manager, 'claude:config.save', { kind: 'agent', scope: 'project', name: 'helper', create: true, fields: { description: 'Helps' }, body: 'Do it.' });
    expect(saved).toMatchObject({ success: true, data: { kind: 'agent', name: 'helper', source: 'project' } });
    expect(calls).toEqual([['reload']]);
    const path = (saved as { data: { path: string } }).data.path;
    expect(readFileSync(path, 'utf8')).toContain('description: Helps');

    const read = (await call(manager, 'claude:config.read', { path })) as { success: boolean; data: { fields: Record<string, string>; body: string } };
    expect(read.success).toBe(true);
    expect(read.data.fields).toEqual({ description: 'Helps' });
    expect(read.data.body.trim()).toBe('Do it.');
    expect(await call(manager, 'claude:config.list', {})).toMatchObject({ success: true });
    expect(calls).toEqual([['reload']]);

    expect(await call(manager, 'claude:config.delete', { path })).toMatchObject({ success: true });
    expect(calls).toEqual([['reload'], ['reload']]);
    expect(await call(manager, 'claude:config.delete', { path: '/etc/passwd' })).toMatchObject({ success: false });
    expect(await call(manager, 'claude:config.reload', {})).toMatchObject({ success: true });
    expect(calls).toEqual([['reload'], ['reload'], ['reload']]);
  });
});
