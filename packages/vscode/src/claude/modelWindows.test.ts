import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Catalog } from '@openchamber/ui/src/lib/claude/types';
import { handleClaudeBridgeMessage } from '../bridge-claude-runtime';
import { allEvents, createHarness, tick, until, type Harness } from './fakes';
import { MAX_TERMINAL_COMMAND_LENGTH, validateTerminalCommand } from './terminalCommand';
import { ClaudeSessionManager } from './ClaudeSessionManager';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const WINDOWS = { default: 1_000_000, haiku: 200_000 };
const windowsOf = (catalog: Catalog) => Object.fromEntries(catalog.models.map((m) => [m.value, m.contextWindow]));

const sendAndSettle = async (h: Harness, id: string, text = 'go') => {
  await h.manager.send(id, { text });
  await until(() => h.manager['sessions'].get(id)!.lifecycle === 'live-idle', 3000);
  h.broadcaster.flush();
};

describe('per-model context window', () => {
  test('measured on a no-turn probe per model, restored afterwards, pushed as catalog.updated and persisted', async () => {
    const h = createHarness('text', {}, undefined, { windows: WINDOWS });
    await h.manager.bootstrap();
    await until(() => h.manager['modelWindows'].haiku !== undefined, 3000);
    await h.manager['windowsMeasuring'];
    h.broadcaster.flush();
    expect(windowsOf(h.manager.catalog())).toEqual({ default: 1_000_000, haiku: 200_000 });
    const updates = allEvents(h).filter((e) => e.type === 'catalog.updated') as Array<{ properties: { catalog: Catalog } }>;
    expect(windowsOf(updates.at(-1)!.properties.catalog)).toEqual({ default: 1_000_000, haiku: 200_000 });
    // the measuring probe selected each model in turn, then went back to the original (none)
    const probe = h.queries.at(-1)!;
    expect(probe.models).toEqual([undefined, 'haiku', undefined]);
    expect(probe.contextCalls.every((c) => c.detail === 'summary')).toBe(true);
    expect((h.store.get('claudekei.modelWindows') as { windows: Record<string, number> }).windows).toEqual(WINDOWS);
  });

  test('cached per CLI binary: the next start shows windows at once and measures nothing; a different binary re-measures', async () => {
    const h = createHarness('text', {}, undefined, { windows: WINDOWS });
    await h.manager.bootstrap();
    await h.manager['windowsMeasuring'];
    const h2 = createHarness('text', {}, undefined, { windows: WINDOWS, shared: { store: h.store, api: h.api } });
    expect(windowsOf(h2.manager.catalog())).toEqual(WINDOWS);
    await h2.manager.bootstrap();
    await tick(50); // let the background refresh run
    await h2.manager['windowsMeasuring'];
    expect(h2.queries.length).toBe(1); // only the catalog refresh probe: no measuring probe

    // stale cache key (CLI changed): old values are dropped and measured again
    h.store.set('claudekei.modelWindows', { key: 'other-binary', windows: { default: 5, haiku: 6 } });
    const h3 = createHarness('text', {}, undefined, { windows: WINDOWS, shared: { store: h.store, api: h.api } });
    // old values stay visible as provisional ones until they are measured again
    expect(windowsOf(h3.manager.catalog())).toEqual({ default: 5, haiku: 6 });
    await h3.manager.bootstrap();
    await until(() => windowsOf(h3.manager.catalog()).haiku === 200_000, 3000); // background refresh, then measuring
    expect(windowsOf(h3.manager.catalog())).toEqual(WINDOWS);
  });

  test('only missing models are measured (e.g. a model that appeared after the last probe)', async () => {
    const h = createHarness('text', {}, undefined, { windows: WINDOWS });
    await h.manager.bootstrap();
    await h.manager['windowsMeasuring'];
    h.manager['modelWindows'] = { default: 1_000_000 };
    await h.manager.measureModelWindows();
    expect(h.queries.at(-1)!.models.filter((m) => m !== undefined)).toEqual(['haiku']);
    expect(windowsOf(h.manager.catalog()).haiku).toBe(200_000);
  });

  test('when the probe cannot switch models the window is learned lazily from a live session and persisted', async () => {
    const h = createHarness('text', {}, undefined, { contextRaw: { totalTokens: 10, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, model: 'claude-opus-5-5', categories: [] } });
    await h.manager.bootstrap();
    await h.manager['windowsMeasuring'];
    expect(windowsOf(h.manager.catalog()).default).toBeUndefined();
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    await until(() => h.manager['modelWindows'].default !== undefined, 2000);
    h.broadcaster.flush();
    expect(windowsOf(h.manager.catalog()).default).toBe(1_000_000);
    expect(allEvents(h).some((e) => e.type === 'catalog.updated' && windowsOf(e.properties.catalog).default === 1_000_000)).toBe(true);
    expect((h.store.get('claudekei.modelWindows') as { windows: Record<string, number> }).windows.default).toBe(1_000_000);
  });
});

/** Fake installed CLI: a real file the setting points at (the harness `exists` is the real one for these tests). */
const fakeCli = () => {
  const root = mkdtempSync(join(tmpdir(), 'ck-cli-'));
  dirs.push(root);
  const binary = join(root, 'claude');
  writeFileSync(binary, '#!/bin/sh\n');
  return { root, binary };
};
const keyOf = (path: string) => {
  const st = statSync(path);
  return `${path}:${st.size}:${Math.round(st.mtimeMs)}`;
};

describe('cache key of the installed CLI', () => {
  test('path + size + mtime: unchanged across a restart, a different build (CLI update) re-measures', async () => {
    const cli = fakeCli();
    const opts = { windows: WINDOWS, exists: existsSync };
    const h = createHarness('text', { claudeExecutablePath: cli.binary }, undefined, opts);
    await h.manager.bootstrap();
    await h.manager['windowsMeasuring'];
    const stored = h.store.get('claudekei.modelWindows') as { key: string };
    expect(stored.key).toBe(keyOf(cli.binary));

    // same binary on the next start: nothing measured again
    const h2 = createHarness('text', { claudeExecutablePath: cli.binary }, undefined, { ...opts, shared: { store: h.store, api: h.api } });
    expect(windowsOf(h2.manager.catalog())).toEqual(WINDOWS);
    await h2.manager.bootstrap();
    await tick(50);
    await h2.manager['windowsMeasuring'];
    expect(h2.queries.length).toBe(1); // only the catalog refresh probe
    expect(h2.manager['windowsStale']).toBe(false);

    // `claude update`: the file behind the same path changes -> provisional values shown, everything measured again
    writeFileSync(cli.binary, '#!/bin/sh\n# updated build\n');
    utimesSync(cli.binary, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const h3 = createHarness('text', { claudeExecutablePath: cli.binary }, undefined, { windows: { default: 2_000_000, haiku: 300_000 }, exists: existsSync, shared: { store: h.store, api: h.api } });
    expect(windowsOf(h3.manager.catalog())).toEqual(WINDOWS); // provisional
    await h3.manager.bootstrap();
    await until(() => windowsOf(h3.manager.catalog()).default === 2_000_000, 3000);
    expect(windowsOf(h3.manager.catalog())).toEqual({ default: 2_000_000, haiku: 300_000 });
    expect((h.store.get('claudekei.modelWindows') as { key: string }).key).toBe(keyOf(cli.binary));
  });

  test('a lazy window recorded before the first measurement persists under the current key (not an empty one)', async () => {
    const cli = fakeCli();
    const raw = { totalTokens: 10, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, model: 'claude-opus-5-5', categories: [] };
    const h = createHarness('text', { claudeExecutablePath: cli.binary }, undefined, { contextRaw: raw, exists: existsSync });
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    await until(() => h.manager['modelWindows'].default !== undefined, 2000);
    const stored = h.store.get('claudekei.modelWindows') as { key: string; windows: Record<string, number> };
    expect(stored.key).toBe(keyOf(cli.binary));
    expect(stored.windows.default).toBe(1_000_000);
    // ... and is accepted as valid on the next start (same build)
    const h2 = createHarness('text', { claudeExecutablePath: cli.binary }, undefined, { exists: existsSync, shared: { store: h.store, api: h.api } });
    expect(windowsOf(h2.manager.catalog()).default).toBe(1_000_000);
    expect(h2.manager['windowsStale']).toBe(false);
  });

  test('measurement failures are logged at warn, each run with one info line', async () => {
    const h = createHarness('text', {}, undefined, { windows: { default: 1_000_000 }, measureWindows: true });
    await h.manager.bootstrap();
    await h.manager['windowsMeasuring'];
    // `haiku` has no window in the fake: the measurement of that model fails
    expect(h.logs.some((l) => l.level === 'warn' && /model window measurement failed/.test(l.message))).toBe(true);
    const info = h.logs.filter((l) => l.level === 'info' && l.message === 'model context windows measured');
    expect(info).toHaveLength(1);
  });
});

describe('claude:terminal.run validation', () => {
  test('accepts a command; trims trailing whitespace; keeps multi-line input', () => {
    expect(validateTerminalCommand('npm test  \n')).toBe('npm test');
    expect(validateTerminalCommand('cd a\nls')).toBe('cd a\nls');
  });

  test('rejects non-strings, blank, over-long and NUL-containing commands', () => {
    for (const bad of [undefined, null, 5, {}, '', '   \n', 'a\0b', 'x'.repeat(MAX_TERMINAL_COMMAND_LENGTH + 1)]) {
      expect(() => validateTerminalCommand(bad)).toThrow();
    }
    expect(validateTerminalCommand('x'.repeat(MAX_TERMINAL_COMMAND_LENGTH))).toHaveLength(MAX_TERMINAL_COMMAND_LENGTH);
  });

  test('the bridge route rejects an invalid command before touching any terminal', async () => {
    const manager = createHarness('text').manager as ClaudeSessionManager;
    for (const command of ['', '  ', 'x'.repeat(MAX_TERMINAL_COMMAND_LENGTH + 1), 123]) {
      const response = await handleClaudeBridgeMessage({ id: '1', type: 'claude:terminal.run', payload: { command } }, { manager });
      expect(response).toMatchObject({ success: false });
    }
  });

  test('the bridge passes effort through with send', async () => {
    const sent: unknown[] = [];
    const manager = { send: async (_id: string, input: unknown) => (sent.push(input), { messageId: 'm' }) } as unknown as ClaudeSessionManager;
    await handleClaudeBridgeMessage({ id: '1', type: 'claude:session.send', payload: { sessionId: 's', text: 'hi', effort: 'high' } }, { manager });
    await handleClaudeBridgeMessage({ id: '2', type: 'claude:session.send', payload: { sessionId: 's', text: 'hi', effort: null } }, { manager });
    expect(sent.map((s) => (s as { effort: unknown }).effort)).toEqual(['high', null]);
  });
});
