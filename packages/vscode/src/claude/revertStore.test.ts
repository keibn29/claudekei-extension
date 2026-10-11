import { describe, expect, test } from 'bun:test';
import { REVERT_KEY, RevertStore } from './revertStore';

const setup = () => {
  const kv = new Map<string, unknown>();
  const store = new RevertStore({ get: ((k: string, d?: unknown) => (kv.has(k) ? kv.get(k) : d)) as never, update: async (k, v) => void kv.set(k, v) });
  return { store, kv };
};

describe('RevertStore (markers only)', () => {
  test('markers are stored in the key-value store and cleared individually', async () => {
    const { store, kv } = setup();
    expect(store.get('s1')).toBeUndefined();
    await store.set('s1', { uuid: 'u2', resumeAt: 'a1', head: 'abc' });
    await store.set('s2', { uuid: 'x', resumeAt: null });
    expect(store.get('s1')).toEqual({ uuid: 'u2', resumeAt: 'a1', head: 'abc' });
    expect(Object.keys(kv.get(REVERT_KEY) as object)).toEqual(['s1', 's2']);
    await store.clear('s1');
    expect(store.get('s1')).toBeUndefined();
    expect(store.get('s2')).toBeDefined();
    await store.clear('unknown'); // no marker: nothing to write
  });

  test('commit keeps the marker flagged as committed', async () => {
    const { store } = setup();
    await store.commit('s1', { uuid: 'u2', resumeAt: 'a1', head: 'abc' });
    expect(store.get('s1')).toEqual({ uuid: 'u2', resumeAt: 'a1', head: 'abc', committed: true });
  });
});
