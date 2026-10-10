import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { resetBootstrapCache } from '@/lib/claude/bootstrapCache';
import { createMockClaudeRuntime } from '@/lib/claude/mockRuntime';
import type { ClaudeRuntimeAPI, RuntimeAPIs } from '@/lib/api/types';
import type { McpServerInfo } from '@/lib/claude/types';
import { computeMcpHealth, useMcpStore } from './useMcpStore';

type Request = (type: string, payload: unknown) => Promise<unknown>;

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
  useMcpStore.setState({ snapshot: null, loading: false, error: null, selected: null, toggleSupported: true });

const statusOf = (name: string) => useMcpStore.getState().snapshot?.servers.find((server) => server.name === name)?.status;
const rejection = async (promise: Promise<unknown>): Promise<string | null> => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const server = (status: McpServerInfo['status']): McpServerInfo => ({ name: status, status, origin: 'user', toolCount: 0 });

describe('computeMcpHealth', () => {
  test('counts connected servers and flags failures and auth requirements', () => {
    expect(computeMcpHealth(null)).toEqual({ connected: 0, total: 0, hasFailed: false, hasAuthRequired: false });
    expect(computeMcpHealth([server('connected'), server('pending'), server('disabled')])).toEqual({
      connected: 1,
      total: 3,
      hasFailed: false,
      hasAuthRequired: false,
    });
    expect(computeMcpHealth([server('connected'), server('failed')]).hasFailed).toBe(true);
    expect(computeMcpHealth([server('connected'), server('needs-auth')]).hasAuthRequired).toBe(true);
  });
});

describe('useMcpStore', () => {
  beforeEach(resetStore);
  afterEach(() => {
    registerRuntimeAPIs(null);
    resetBootstrapCache();
    resetStore();
  });

  test('refresh loads the snapshot and reports host failures', async () => {
    installRuntime({ fail: { 'claude:mcp.status': 'probe failed' } });
    await useMcpStore.getState().refresh(false);
    expect(useMcpStore.getState().error).toBe('probe failed');
    expect(useMcpStore.getState().loading).toBe(false);

    installRuntime();
    await useMcpStore.getState().refresh(false);
    expect(useMcpStore.getState().error).toBeNull();
    expect(useMcpStore.getState().snapshot?.servers.length).toBeGreaterThan(0);
  });

  test('toggle is optimistic and keeps the new status once the host accepts', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    installRuntime({ delay: { 'claude:mcp.toggle': gate } });
    await useMcpStore.getState().refresh(false);
    expect(statusOf('github')).toBe('connected');

    const pending = useMcpStore.getState().toggle('github', false);
    expect(statusOf('github')).toBe('disabled');
    release();
    await pending;
    await flush();
    expect(statusOf('github')).toBe('disabled');
  });

  test('toggle rolls back and rethrows when the host rejects', async () => {
    installRuntime({ fail: { 'claude:mcp.toggle': 'boom' } });
    await useMcpStore.getState().refresh(false);

    expect(await rejection(useMcpStore.getState().toggle('github', false))).toBe('boom');
    expect(statusOf('github')).toBe('connected');
    expect(useMcpStore.getState().toggleSupported).toBe(true);
  });

  test('"not supported" disables toggling for the session', async () => {
    installRuntime({ fail: { 'claude:mcp.toggle': 'MCP toggle is not supported' } });
    await useMcpStore.getState().refresh(false);

    expect(await rejection(useMcpStore.getState().toggle('github', false))).toBe('MCP toggle is not supported');
    expect(statusOf('github')).toBe('connected');
    expect(useMcpStore.getState().toggleSupported).toBe(false);
  });

  test('save with create selects the new server; remove clears the selection', async () => {
    installRuntime();
    await useMcpStore.getState().refresh(false);
    await useMcpStore.getState().save('demo', 'user', { type: 'http', url: 'https://example.com/mcp' }, true);
    expect(useMcpStore.getState().selected).toBe('demo');
    expect(statusOf('demo')).toBeDefined();

    await useMcpStore.getState().remove('demo', 'user');
    expect(useMcpStore.getState().selected).toBeNull();
    expect(statusOf('demo')).toBeUndefined();
  });
});
