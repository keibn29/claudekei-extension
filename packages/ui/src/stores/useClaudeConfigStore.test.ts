import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { resetBootstrapCache } from '@/lib/claude/bootstrapCache';
import { createMockClaudeRuntime } from '@/lib/claude/mockRuntime';
import type { ClaudeRuntimeAPI, RuntimeAPIs } from '@/lib/api/types';
import { selectItems, selectSkillSuggestions, useClaudeConfigStore } from './useClaudeConfigStore';

type Request = (type: string, payload: unknown) => Promise<unknown>;

/** Mock host wrapped to count requests and optionally fail / delay specific types. */
const installRuntime = (hooks: { fail?: Record<string, string>; delay?: Record<string, Promise<void>> } = {}) => {
  const mock = createMockClaudeRuntime();
  const calls: string[] = [];
  const runtime: ClaudeRuntimeAPI = {
    subscribe: mock.subscribe,
    request: (async (type: string, payload: unknown) => {
      calls.push(type);
      const delay = hooks.delay?.[type];
      if (delay) await delay;
      const failure = hooks.fail?.[type];
      if (failure) throw new Error(failure);
      return (mock.request as Request)(type, payload);
    }) as ClaudeRuntimeAPI['request'],
  };
  registerRuntimeAPIs({ claude: runtime } as unknown as RuntimeAPIs);
  return { calls };
};

const resetStore = () =>
  useClaudeConfigStore.setState({
    snapshot: null,
    loading: false,
    error: null,
    selected: { agent: null, command: null, skill: null },
    detail: null,
    detailLoading: false,
    detailError: null,
  });

const names = (kind: 'agent' | 'command' | 'skill') => selectItems(kind)(useClaudeConfigStore.getState()).map((item) => item.name);
const rejection = async (promise: Promise<unknown>): Promise<string | null> => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('useClaudeConfigStore', () => {
  beforeEach(resetStore);
  afterEach(() => {
    registerRuntimeAPIs(null);
    resetBootstrapCache();
    resetStore();
  });

  test('load fetches the snapshot once, dedupes concurrent calls and refetches on force', async () => {
    const { calls } = installRuntime();
    await Promise.all([useClaudeConfigStore.getState().load(), useClaudeConfigStore.getState().load()]);
    expect(calls.filter((type) => type === 'claude:config.list')).toHaveLength(1);
    expect(useClaudeConfigStore.getState().snapshot?.items.length).toBeGreaterThan(0);
    expect(useClaudeConfigStore.getState().loading).toBe(false);

    await useClaudeConfigStore.getState().load();
    expect(calls.filter((type) => type === 'claude:config.list')).toHaveLength(1);
    await useClaudeConfigStore.getState().load(true);
    expect(calls.filter((type) => type === 'claude:config.list')).toHaveLength(2);
  });

  test('load failure keeps the error and allows a retry', async () => {
    installRuntime({ fail: { 'claude:config.list': 'host down' } });
    await useClaudeConfigStore.getState().load();
    expect(useClaudeConfigStore.getState().error).toBe('host down');
    expect(useClaudeConfigStore.getState().snapshot).toBeNull();

    installRuntime();
    await useClaudeConfigStore.getState().load();
    expect(useClaudeConfigStore.getState().error).toBeNull();
    expect(useClaudeConfigStore.getState().snapshot === null).toBe(false);
  });

  test('selectItems groups by kind with a stable identity per snapshot', async () => {
    installRuntime();
    await useClaudeConfigStore.getState().load();
    const state = useClaudeConfigStore.getState();
    expect(selectItems('agent')(state)).toBe(selectItems('agent')(state));
    expect(names('agent')).toContain('reviewer');
    expect(names('command').length).toBeGreaterThan(0);
    expect(names('skill').length).toBeGreaterThan(0);
  });

  test('skill suggestions map scope and hide overridden user items', async () => {
    installRuntime();
    await useClaudeConfigStore.getState().load();
    const suggestions = selectSkillSuggestions(useClaudeConfigStore.getState());
    const skills = useClaudeConfigStore.getState().snapshot!.items.filter((item) => item.kind === 'skill' && !item.shadowed);
    expect(suggestions.length).toBe(skills.length);
    for (const item of skills) {
      expect(suggestions.find((entry) => entry.name === item.name)?.scope).toBe(item.source === 'project' ? 'project' : 'user');
    }
    expect(selectSkillSuggestions(useClaudeConfigStore.getState())).toBe(suggestions);
  });

  test('selecting an item loads its detail', async () => {
    installRuntime();
    const store = useClaudeConfigStore.getState();
    await store.load();
    const item = useClaudeConfigStore.getState().snapshot!.items.find((entry) => entry.kind === 'agent' && entry.source === 'user' && entry.name === 'reviewer')!;
    store.select('agent', { path: item.path });
    await flush();
    const detail = useClaudeConfigStore.getState().detail;
    expect(detail?.path).toBe(item.path);
    expect(detail?.fields.model).toBe('sonnet');
    expect(detail?.otherKeys).toContain('skills');
  });

  test('save creates an item, reloads the snapshot and selects it; a duplicate create fails without side effects', async () => {
    installRuntime();
    const store = useClaudeConfigStore.getState();
    await store.load();
    const request = { kind: 'command', scope: 'project', name: 'ship-it', create: true, fields: { description: 'Ship it', 'argument-hint': '[env]' }, body: 'Deploy $ARGUMENTS' } as const;
    const saved = await store.save(request);
    expect(saved.name).toBe('ship-it');
    expect(names('command')).toContain('ship-it');
    expect(useClaudeConfigStore.getState().selected.command).toEqual({ path: saved.path });
    await flush();
    expect(useClaudeConfigStore.getState().detail?.body).toBe('Deploy $ARGUMENTS');

    expect(await rejection(store.save(request))).toContain('already exists in project');
    expect(useClaudeConfigStore.getState().selected.command).toEqual({ path: saved.path });
  });

  test('save updates fields and an empty value clears the key', async () => {
    installRuntime();
    const store = useClaudeConfigStore.getState();
    await store.load();
    await store.save({ kind: 'agent', scope: 'user', name: 'helper', create: true, fields: { description: 'Helps', color: 'red' }, body: 'Hi' });
    await store.save({ kind: 'agent', scope: 'user', name: 'helper', create: false, fields: { description: 'Helps more', color: '' }, body: 'Hi again' });
    await flush();
    const detail = useClaudeConfigStore.getState().detail;
    expect(detail?.fields).toEqual({ description: 'Helps more' });
    expect(detail?.body).toBe('Hi again');
  });

  test('remove deletes the item and clears its selection', async () => {
    installRuntime();
    const store = useClaudeConfigStore.getState();
    await store.load();
    const saved = await store.save({ kind: 'skill', scope: 'user', name: 'temp-skill', create: true, fields: { description: 'Temporary' }, body: 'x' });
    expect(names('skill')).toContain('temp-skill');
    await store.remove(saved.path);
    expect(names('skill')).not.toContain('temp-skill');
    expect(useClaudeConfigStore.getState().selected.skill).toBeNull();
    expect(useClaudeConfigStore.getState().detail).toBeNull();
  });

  test('plugin toggle is optimistic and refreshes plugin items on success', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    installRuntime({ delay: { 'claude:plugin.setEnabled': gate } });
    const store = useClaudeConfigStore.getState();
    await store.load();
    const id = 'superpowers@superpowers-marketplace';
    const enabled = () => useClaudeConfigStore.getState().snapshot!.plugins.find((plugin) => plugin.id === id)!.enabled;
    expect(enabled()).toBe(false);
    expect(names('skill')).not.toContain('superpowers:brainstorming');

    const pending = store.setPluginEnabled(id, true);
    expect(enabled()).toBe(true); // flipped before the host answered
    release();
    await pending;
    expect(enabled()).toBe(true);
    expect(names('skill')).toContain('superpowers:brainstorming');
  });

  test('plugin toggle rolls back and rethrows when the host rejects', async () => {
    installRuntime({ fail: { 'claude:plugin.setEnabled': 'claude plugin enable failed' } });
    const store = useClaudeConfigStore.getState();
    await store.load();
    const enabledOf = (id: string) => useClaudeConfigStore.getState().snapshot!.plugins.find((plugin) => plugin.id === id)!.enabled;

    const off = 'superpowers@superpowers-marketplace';
    expect(enabledOf(off)).toBe(false);
    expect(await rejection(store.setPluginEnabled(off, true))).toBe('claude plugin enable failed');
    expect(enabledOf(off)).toBe(false);

    // A disable that fails restores the enabled state, too.
    const on = 'claudekei@claudekei';
    expect(enabledOf(on)).toBe(true);
    expect(await rejection(store.setPluginEnabled(on, false))).toBe('claude plugin enable failed');
    expect(enabledOf(on)).toBe(true);
  });

  test('reloadClaude calls the host and reloads the snapshot', async () => {
    const { calls } = installRuntime();
    const store = useClaudeConfigStore.getState();
    await store.load();
    await store.reloadClaude();
    expect(calls).toContain('claude:config.reload');
    expect(calls.filter((type) => type === 'claude:config.list')).toHaveLength(2);
  });

  test('a forced load after a write does not reuse an unforced load that started before it', async () => {
    const mock = createMockClaudeRuntime();
    let listCalls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    registerRuntimeAPIs({
      claude: {
        subscribe: mock.subscribe,
        request: (async (type: string, payload: unknown) => {
          if (type === 'claude:config.list') {
            const call = ++listCalls;
            // Snapshot is taken before the gate: the first request returns pre-write data late.
            const response = await (mock.request as Request)(type, payload);
            if (call === 1) await firstGate;
            return response;
          }
          return (mock.request as Request)(type, payload);
        }) as ClaudeRuntimeAPI['request'],
      },
    } as unknown as RuntimeAPIs);

    const store = useClaudeConfigStore.getState();
    const stale = store.load(); // unforced, still in flight
    await flush();
    await mock.request('claude:config.save', { kind: 'skill', scope: 'user', name: 'written-late', create: true, fields: { description: 'x' }, body: '' });
    const fresh = store.load(true); // must start its own request
    await fresh;
    expect(listCalls).toBe(2);
    expect(names('skill')).toContain('written-late');

    releaseFirst();
    await stale;
    // The older, pre-write response must not overwrite the newer snapshot.
    expect(names('skill')).toContain('written-late');
    expect(useClaudeConfigStore.getState().loading).toBe(false);
  });

  test('detail is shared across kinds: reopening the selected path restores it', async () => {
    installRuntime();
    await useClaudeConfigStore.getState().load();
    const items = useClaudeConfigStore.getState().snapshot!.items;
    const agent = items.find((entry) => entry.kind === 'agent' && entry.source === 'user')!;
    const command = items.find((entry) => entry.kind === 'command')!;
    const store = useClaudeConfigStore.getState();
    store.select('agent', { path: agent.path });
    await flush();
    store.select('command', { path: command.path });
    await flush();
    expect(useClaudeConfigStore.getState().detail?.path).toBe(command.path);
    // Back on the Agents page: selection is kept, detail is not, and the editor re-requests it.
    expect(useClaudeConfigStore.getState().selected.agent).toEqual({ path: agent.path });
    await useClaudeConfigStore.getState().openDetail(agent.path);
    expect(useClaudeConfigStore.getState().detail?.path).toBe(agent.path);
  });

  test('a failed detail read sets detailError and does not clear the selection', async () => {
    installRuntime({ fail: { 'claude:config.read': 'read failed' } });
    await useClaudeConfigStore.getState().load();
    const agent = useClaudeConfigStore.getState().snapshot!.items.find((entry) => entry.kind === 'agent')!;
    useClaudeConfigStore.getState().select('agent', { path: agent.path });
    await flush();
    const state = useClaudeConfigStore.getState();
    expect(state.detailError).toBe('read failed');
    expect(state.detailLoading).toBe(false);
    expect(state.detail).toBeNull();
  });
});
