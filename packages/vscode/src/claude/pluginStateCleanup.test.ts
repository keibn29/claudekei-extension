import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanPluginState } from './pluginStateCleanup';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const child = (agentId: string, extra: Record<string, unknown> = {}) => ({ alias: `exp-${agentId}`, agentId, agentType: 'explorer', description: 'd', status: 'running', createdAt: 100, lastUsedAt: 900, reads: [{ path: '/a.ts', lines: 50 }], ...extra });
const setup = (plugin = 'claudekei-inline', state: unknown = { version: 1, mode: null, modeBaseAgentType: null, counters: { exp: 3 }, children: [child('A'), child('B'), child('C')] }) => {
  const home = mkdtempSync(join(tmpdir(), 'claudekei-plugin-'));
  dirs.push(home);
  const sessions = join(home, '.claude', 'plugins', 'data', plugin, 'sessions');
  mkdirSync(sessions, { recursive: true });
  const file = join(sessions, 's1.json');
  writeFileSync(file, JSON.stringify(state));
  const logs: Array<[string, string]> = [];
  const run = (removed: string[], trimmed: string[], lockTimeoutMs = 100) => cleanPluginState({ home, sessionId: 's1', removedAgentIds: removed, trimmedAgentIds: trimmed, log: (l, m) => void logs.push([l, m]), lockTimeoutMs });
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  return { home, file, sessions, logs, run, read };
};

describe('cleanPluginState', () => {
  test('removes children of deleted transcripts and resets the ones that were only trimmed; the rest and the other fields stay', async () => {
    const t = setup();
    await t.run(['A'], ['B']);
    const state = t.read();
    expect(state.children.map((c: { agentId: string }) => c.agentId)).toEqual(['B', 'C']);
    expect(state.children[0]).toMatchObject({ agentId: 'B', reads: [], status: 'idle', lastUsedAt: 100, alias: 'exp-B' });
    expect(state.children[1]).toEqual(child('C'));
    expect(state.counters).toEqual({ exp: 3 }); // aliases are never reused
    expect(readdirSync(t.sessions)).toEqual(['s1.json']); // no lock / tmp leftovers
  });

  test('every claudekei plugin data directory holding the session is cleaned', async () => {
    const t = setup('claudekei-inline');
    const other = join(t.home, '.claude', 'plugins', 'data', 'claudekei-claudekei', 'sessions');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 's1.json'), JSON.stringify({ version: 1, children: [child('A')] }));
    mkdirSync(join(t.home, '.claude', 'plugins', 'data', 'unrelated', 'sessions'), { recursive: true });
    writeFileSync(join(t.home, '.claude', 'plugins', 'data', 'unrelated', 'sessions', 's1.json'), JSON.stringify({ version: 1, children: [child('A')] }));
    await t.run(['A'], []);
    expect(JSON.parse(readFileSync(join(other, 's1.json'), 'utf8')).children).toEqual([]);
    expect(JSON.parse(readFileSync(join(t.home, '.claude', 'plugins', 'data', 'unrelated', 'sessions', 's1.json'), 'utf8')).children).toHaveLength(1);
  });

  test('a held lock is respected: nothing is written, a warning is logged, the foreign lock stays', async () => {
    const t = setup();
    mkdirSync(`${t.file}.lock`);
    const before = readFileSync(t.file, 'utf8');
    await t.run(['A'], []);
    expect(readFileSync(t.file, 'utf8')).toBe(before);
    expect(existsSync(`${t.file}.lock`)).toBe(true);
    expect(t.logs.some(([l, m]) => l === 'warn' && /locked/.test(m))).toBe(true);
  });

  test('a stale lock (older than 5 s) is taken over like the plugin does', async () => {
    const t = setup();
    mkdirSync(`${t.file}.lock`);
    const old = new Date(Date.now() - 10_000);
    utimesSync(`${t.file}.lock`, old, old);
    await t.run(['A'], []);
    expect(t.read().children.map((c: { agentId: string }) => c.agentId)).toEqual(['B', 'C']);
    expect(existsSync(`${t.file}.lock`)).toBe(false);
  });

  test('an unknown schema or unreadable file is left untouched and logged', async () => {
    const bad = setup('claudekei-inline', { version: 2, children: [child('A')] });
    await bad.run(['A'], []);
    expect(bad.read()).toEqual({ version: 2, children: [child('A')] });
    expect(bad.logs.some(([, m]) => /unknown schema/.test(m))).toBe(true);
    expect(existsSync(`${bad.file}.lock`)).toBe(false);

    const garbled = setup();
    writeFileSync(garbled.file, '{not json');
    await garbled.run(['A'], []);
    expect(readFileSync(garbled.file, 'utf8')).toBe('{not json');
    expect(garbled.logs.some(([, m]) => /unreadable/.test(m))).toBe(true);
  });

  test('reconcile: children whose transcript file is gone are dropped (a cleanup interrupted after the files were deleted is completed by the retry)', async () => {
    const t = setup();
    const sub = join(t.home, 'subagents');
    mkdirSync(sub);
    writeFileSync(join(sub, 'agent-B.jsonl'), '{}\n');
    writeFileSync(join(sub, 'agent-C.jsonl'), '{}\n'); // A's file was deleted before the crash
    await cleanPluginState({ home: t.home, sessionId: 's1', removedAgentIds: [], trimmedAgentIds: ['B'], subagentsDir: sub, log: () => undefined, lockTimeoutMs: 100 });
    const state = t.read();
    expect(state.children.map((c: { agentId: string }) => c.agentId)).toEqual(['B', 'C']);
    expect(state.children[0].reads).toEqual([]); // trimmed ids given by the caller are reset on the retry too
    expect(state.children[1].reads).toHaveLength(1);
  });

  test('reconcile removes nothing when the subagents directory cannot be listed', async () => {
    const t = setup();
    const before = readFileSync(t.file, 'utf8');
    await cleanPluginState({ home: t.home, sessionId: 's1', removedAgentIds: [], trimmedAgentIds: [], subagentsDir: join(t.home, 'missing'), log: (l, m) => void t.logs.push([l, m]), lockTimeoutMs: 100 });
    expect(readFileSync(t.file, 'utf8')).toBe(before);
    expect(t.logs.some(([, m]) => /reconcile skipped/.test(m))).toBe(true);
  });

  test('no state file (or nothing to clean): no lock directory is created and nothing is written', async () => {
    const t = setup();
    rmSync(t.file);
    await t.run(['A'], []);
    expect(readdirSync(t.sessions)).toEqual([]);
    const t2 = setup();
    const before = readFileSync(t2.file, 'utf8');
    await t2.run(['ghost'], []); // unknown agent: no change, no rewrite
    expect(readFileSync(t2.file, 'utf8')).toBe(before);
    await t2.run([], []);
    expect(readdirSync(t2.sessions)).toEqual(['s1.json']);
  });
});
