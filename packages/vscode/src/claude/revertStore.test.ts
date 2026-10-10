import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REVERT_KEY, RevertStore } from './revertStore';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const setup = (capBytes?: number) => {
  const base = mkdtempSync(join(tmpdir(), 'claudekei-revertstore-'));
  dirs.push(base);
  const work = join(base, 'work');
  mkdirSync(work, { recursive: true });
  const kv = new Map<string, unknown>();
  const root = join(base, 'revert');
  const store = new RevertStore({ get: ((k: string, d?: unknown) => (kv.has(k) ? kv.get(k) : d)) as never, update: async (k, v) => void kv.set(k, v) }, root, undefined, capBytes);
  return { store, kv, root, work };
};

describe('RevertStore', () => {
  test('markers are stored in the key-value store and cleared with their directory', async () => {
    const { store, kv, root, work } = setup();
    expect(store.get('s1')).toBeUndefined();
    await store.set('s1', { uuid: 'u2', resumeAt: 'a1' });
    await store.set('s2', { uuid: 'x', resumeAt: null });
    expect(store.get('s1')).toEqual({ uuid: 'u2', resumeAt: 'a1' });
    expect(Object.keys(kv.get(REVERT_KEY) as object)).toEqual(['s1', 's2']);
    writeFileSync(join(work, 'a.txt'), 'A');
    await store.capture('s1', [join(work, 'a.txt')]);
    expect(existsSync(join(root, 's1', 'manifest.json'))).toBe(true);
    await store.clear('s1');
    expect(store.get('s1')).toBeUndefined();
    expect(store.get('s2')).toBeDefined();
    expect(existsSync(join(root, 's1'))).toBe(false);
  });

  test('capture keeps the first copy and records files that do not exist yet as absent', async () => {
    const { store, work } = setup();
    const a = join(work, 'a.txt');
    const created = join(work, 'sub', 'new.txt');
    writeFileSync(a, 'head');
    mkdirSync(join(work, 'sub'), { recursive: true });
    await store.capture('s1', [a, created]);
    writeFileSync(a, 'older');
    await store.capture('s1', [a]); // already known: the head copy stays
    writeFileSync(created, 'made by a later state');
    await store.capture('s1', [created]); // absent was recorded first, still absent
    writeFileSync(a, 'whatever');
    expect(await store.restore('s1')).toEqual([a, created]);
    expect(readFileSync(a, 'utf8')).toBe('head');
    expect(existsSync(created)).toBe(false);
  });

  test('restore writes blobs back (creating directories) and unlinks files that were absent', async () => {
    const { store, work } = setup();
    const deep = join(work, 'x', 'y', 'f.txt');
    mkdirSync(join(work, 'x', 'y'), { recursive: true });
    writeFileSync(deep, 'deep head');
    const absent = join(work, 'gone.txt');
    await store.capture('s1', [deep, absent]);
    rmSync(join(work, 'x'), { recursive: true });
    writeFileSync(absent, 'created by the rewound state');
    await store.restore('s1');
    expect(readFileSync(deep, 'utf8')).toBe('deep head');
    expect(existsSync(absent)).toBe(false);
    // nothing captured: nothing to restore
    expect(await store.restore('unknown')).toEqual([]);
  });

  test('the cap is checked before anything is written', async () => {
    const { store, root, work } = setup(10);
    const a = join(work, 'a.txt');
    const b = join(work, 'b.txt');
    writeFileSync(a, '123456');
    writeFileSync(b, '1234567');
    await store.capture('s1', [a]);
    const before = readdirSync(join(root, 's1')).sort();
    await expect(store.capture('s1', [b])).rejects.toThrow('Too much file data to keep for /redo (over 100 MB). Nothing was changed.');
    expect(readdirSync(join(root, 's1')).sort()).toEqual(before);
    // a fresh session starts from zero
    await expect(setup(5).store.capture('s9', [a])).rejects.toThrow('Too much file data');
  });

  test('sweep removes directories without a marker only', async () => {
    const { store, root, work } = setup();
    writeFileSync(join(work, 'a.txt'), 'A');
    await store.set('keep', { uuid: 'u', resumeAt: null });
    await store.capture('keep', [join(work, 'a.txt')]);
    await store.capture('orphan', [join(work, 'a.txt')]);
    await store.sweep();
    expect(readdirSync(root)).toEqual(['keep']);
    // a missing root is fine
    await setup().store.sweep();
  });
});
