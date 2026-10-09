import { describe, expect, test } from 'bun:test';
import type { ContextUsage, Session, UsageLimits } from '@openchamber/ui/src/lib/claude/types';
import { estimateContextUsage, slug, toContextUsage } from './contextUsage';
import { allEvents, createHarness, until, type Harness } from './fakes';
import { applyRateLimitEvent, parseUsageReport } from './usageLimits';
import { loadJson } from './testUtils';

const NOW = 1_800_000_000_000;
const usageReport = () => loadJson<Record<string, any>>('usage/usage-report.json');
const contextFull = () => loadJson<Record<string, any>>('usage/context-full.json');
const RATE_LIMIT_INFO = { status: 'allowed', resetsAt: 1791586800, rateLimitType: 'five_hour', overageStatus: 'rejected', isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.35, resetsAt: 1791586800 } } };

const sendAndSettle = async (h: Harness, id: string, text = 'go', extra: Record<string, unknown> = {}) => {
  await h.manager.send(id, { text, ...extra } as never);
  await until(() => h.manager['sessions'].get(id)!.lifecycle === 'live-idle', 3000);
  h.broadcaster.flush();
};

describe('context usage mapping (real getContextUsage response)', () => {
  test('categories, totals, percent, autocompact buffer and detail sections', () => {
    const u = toContextUsage(contextFull(), NOW)!;
    expect(u).toMatchObject({ usedTokens: 22132, maxTokens: 1_000_000, percent: 2.2, autocompactBufferTokens: 33000, autocompactThresholdTokens: 967000, autocompactEnabled: true, model: 'claude-haiku-5-5', source: 'exact', updatedAt: NOW });
    const by = Object.fromEntries(u.categories.map((c) => [c.id, c]));
    expect(by['system-prompt']).toMatchObject({ label: 'System prompt', tokens: 142, kind: 'used' });
    expect(by['system-tools-deferred']!.kind).toBe('deferred');
    expect(by['messages']!.kind).toBe('used');
    expect(by['autocompact-buffer']).toMatchObject({ tokens: 33000, kind: 'buffer' });
    expect(by['free-space']).toMatchObject({ tokens: 944868, kind: 'free' });
    // the used categories add up to the total
    expect(u.categories.filter((c) => c.kind === 'used').reduce((n, c) => n + c.tokens, 0)).toBe(u.usedTokens);
    // sections: sorted by tokens, capped, zero rows dropped
    for (const s of u.sections ?? []) {
      expect(s.items.length).toBeLessThanOrEqual(20);
      expect(s.items.map((i) => i.tokens)).toEqual([...s.items.map((i) => i.tokens)].sort((a, b) => b - a));
      expect(s.items.every((i) => i.tokens > 0)).toBe(true);
    }
  });

  test('unusable input yields undefined; slug is stable', () => {
    expect(toContextUsage(undefined, NOW)).toBeUndefined();
    expect(toContextUsage({ totalTokens: 5 }, NOW)).toBeUndefined();
    expect(toContextUsage({ totalTokens: 5, maxTokens: 0, categories: [] }, NOW)).toBeUndefined();
    expect(slug('MCP tools (deferred)')).toBe('mcp-tools-deferred');
    expect(slug('Autocompact buffer')).toBe('autocompact-buffer');
  });

  test('detail sections come from memory files, MCP tools and the message breakdown', () => {
    const u = toContextUsage({ ...contextFull(), memoryFiles: [{ path: '/p/CLAUDE.md', type: 'Project', tokens: 300 }, { path: '/h/CLAUDE.md', type: 'User', tokens: 800 }], mcpTools: [{ name: 'a', serverName: 's', tokens: 10 }], messageBreakdown: { toolCallTokens: 5, toolResultTokens: 0, attachmentTokens: 100, assistantMessageTokens: 7, userMessageTokens: 12 } }, NOW)!;
    const by = Object.fromEntries((u.sections ?? []).map((s) => [s.id, s]));
    expect(by['memory-files']!.items).toEqual([{ name: '/h/CLAUDE.md', tokens: 800, detail: 'User' }, { name: '/p/CLAUDE.md', tokens: 300, detail: 'Project' }]);
    expect(by['mcp-tools']!.items[0]).toEqual({ name: 'a', tokens: 10, detail: 's' });
    expect(by['messages']!.items.map((i) => i.name)).toEqual(['Attachments', 'User messages', 'Assistant messages', 'Tool calls']);
  });

  test('estimate: all messages, rest free; keeps a known window size', () => {
    const e = estimateContextUsage(50_000, NOW);
    expect(e).toMatchObject({ usedTokens: 50_000, maxTokens: 200_000, percent: 25, source: 'estimate' });
    expect(e.categories.map((c) => [c.id, c.tokens])).toEqual([['messages', 50_000], ['free-space', 150_000]]);
    const withWindow = estimateContextUsage(100_000, NOW, toContextUsage(contextFull(), NOW));
    expect(withWindow.maxTokens).toBe(1_000_000);
    expect(withWindow.percent).toBe(10);
  });
});

describe('usage limits mapping (real usage response)', () => {
  test('server rows become desktop-style windows with plan name', () => {
    const u = parseUsageReport(usageReport(), NOW, { subscriptionType: 'Claude Team' });
    expect(u.plan).toBe('Team');
    expect(u.source).toBe('usage');
    expect(u.windows).toEqual([
      { id: 'session', kind: 'session', label: 'Session limit', utilization: 0.36, resetsAt: Date.parse('2026-10-09T23:00:00.467612+00:00'), severity: 'normal', active: true },
      { id: 'weekly:fable', kind: 'weekly_scoped', label: 'Weekly · Fable', utilization: 0, resetsAt: Date.parse('2026-10-14T05:00:00.467801+00:00'), severity: 'normal' },
    ]);
    expect(u.extraUsage).toMatchObject({ enabled: false });
  });

  test('a weekly_all row is labelled "Weekly · All models"; unknown kinds are title-cased', () => {
    const u = parseUsageReport({ subscription_type: 'max', rate_limits_available: true, rate_limits: { limits: [{ kind: 'weekly_all', group: 'weekly', percent: 50, resets_at: null, severity: 'warning', is_active: false }, { kind: 'monthly_pool', group: 'x', percent: 120 }] } }, NOW);
    expect(u.plan).toBe('Max');
    expect(u.windows.map((w) => [w.id, w.label, w.utilization])).toEqual([['weekly', 'Weekly · All models', 0.5], ['monthly_pool', 'Monthly Pool', 1]]);
  });

  test('older CLIs without limits[] fall back to the fixed window fields', () => {
    const u = parseUsageReport({ subscription_type: 'pro', rate_limits_available: true, rate_limits: { five_hour: { utilization: 12, resets_at: '2026-10-10T00:00:00Z' }, seven_day: { utilization: 40, resets_at: null }, seven_day_opus: null, model_scoped: [{ display_name: 'Fable', utilization: 3, resets_at: null }] } }, NOW);
    expect(u.windows.map((w) => [w.label, w.utilization])).toEqual([['Session limit', 0.12], ['Weekly · All models', 0.4], ['Weekly · Fable', 0.03]]);
  });

  test('API key / third party: no windows', () => {
    expect(parseUsageReport({ subscription_type: null, rate_limits_available: false, rate_limits: null }, NOW)).toMatchObject({ windows: [], source: 'usage' });
    expect(parseUsageReport(undefined, NOW).windows).toEqual([]);
  });

  test('rate_limit_event (real shape): updates only its window, keeps the rest; other types are ignored', () => {
    const base = parseUsageReport(usageReport(), NOW);
    const next = applyRateLimitEvent(base, RATE_LIMIT_INFO, NOW + 1000)!;
    expect(next.windows.find((w) => w.id === 'session')).toMatchObject({ utilization: 0.35, resetsAt: 1791586800 * 1000, status: 'allowed', label: 'Session limit', active: true });
    expect(next.windows.find((w) => w.id === 'weekly:fable')).toEqual(base.windows[1]!);
    expect(next.source).toBe('usage');
    expect(applyRateLimitEvent(base, { status: 'allowed', rateLimitType: 'overage' }, NOW)).toBe(base);
    // without any previous data a partial result is built
    const fresh = applyRateLimitEvent(undefined, { ...RATE_LIMIT_INFO, rateLimitType: 'seven_day', utilization: 0.8, unifiedWindows: undefined, status: 'allowed_warning' }, NOW)!;
    expect(fresh).toMatchObject({ source: 'rate_limit_event', windows: [{ id: 'weekly', label: 'Weekly · All models', utilization: 0.8, status: 'allowed_warning' }] });
  });
});

describe('usage limits in the session host', () => {
  test('the startup probe fetches the limits: bootstrap carries them, usage.updated is pushed, persisted for the next start', async () => {
    const h = createHarness('text', {}, undefined, { usageRaw: usageReport() });
    const boot = await h.manager.bootstrap();
    h.broadcaster.flush();
    expect(boot.usage?.windows.map((w) => w.label)).toEqual(['Session limit', 'Weekly · Fable']);
    expect(allEvents(h).some((e) => e.type === 'usage.updated')).toBe(true);
    expect((h.store.get('claudekei.usageLimits') as UsageLimits).windows).toHaveLength(2);

    // next start: shown from the persisted value before any probe finishes
    const h2 = createHarness('text', {}, undefined, { shared: { store: h.store, api: h.api } });
    expect(h2.manager.getUsage()?.windows).toHaveLength(2);
  });

  test('a turn with a rate_limit_event updates its window live (the full refresh is throttled right after a fetch)', async () => {
    const h = createHarness('usage/rate-limit-turn', {}, undefined, { usageRaw: usageReport() });
    await h.manager.bootstrap();
    h.broadcaster.flush();
    const { id } = h.manager.create();
    const mark = allEvents(h).length;
    await sendAndSettle(h, id);
    h.broadcaster.flush();
    const updates = allEvents(h).slice(mark).filter((e) => e.type === 'usage.updated') as Array<{ properties: { usage: UsageLimits } }>;
    // the recorded base turn already carried one event (0.05); the injected one (0.35) comes last
    expect(updates.length).toBe(2);
    const last = updates.at(-1)!.properties.usage;
    expect(last.windows.find((w) => w.id === 'session')).toMatchObject({ utilization: 0.35, status: 'allowed', resetsAt: 1791586800 * 1000 });
    // the weekly row from the last full fetch is still there
    expect(last.windows.some((w) => w.id === 'weekly:fable')).toBe(true);
    expect(h.queries.at(-1)!.usageCalls).toBe(0); // throttled: the startup probe fetched seconds ago
  });

  test('with a live session the refresh goes through its process (no extra probe)', async () => {
    const h = createHarness('text', {}, undefined, { usageRaw: usageReport() });
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    const spawned = h.queries.length;
    const fresh = await h.manager.refreshUsage();
    expect(h.queries.length).toBe(spawned);
    expect(h.queries.at(-1)!.usageCalls).toBe(1);
    expect(fresh.windows).toHaveLength(2);
  });

  test('refreshUsage without a live session uses a short-lived probe; API-key users get no windows; failures keep the last value', async () => {
    const h = createHarness('text', {}, undefined, { usageRaw: usageReport() });
    await h.manager.bootstrap();
    const probes = h.queries.length;
    const fresh = await h.manager.refreshUsage();
    expect(h.queries.length).toBe(probes + 1);
    expect(fresh.windows).toHaveLength(2);

    const apiKey = createHarness('text', {}, undefined, { usageRaw: { subscription_type: null, rate_limits_available: false, rate_limits: null } });
    const boot = await apiKey.manager.bootstrap();
    expect(boot.usage).toMatchObject({ windows: [] });

    const failing = createHarness('text', {});
    await failing.manager.bootstrap();
    expect(failing.manager.getUsage()).toBeUndefined();
    expect((await failing.manager.refreshUsage()).windows).toEqual([]);
    failing.store.set('claudekei.usageLimits', parseUsageReport(usageReport(), NOW));
  });
});

describe('context usage in the session host', () => {
  test('measured after each result, announced in session.updated, available through the request', async () => {
    const h = createHarness('text', {}, undefined, { contextRaw: contextFull() });
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    const mark = allEvents(h).length;
    await sendAndSettle(h, id);
    await until(() => h.queries.at(-1)!.contextCalls.length > 0, 2000);
    h.broadcaster.flush();
    expect(h.queries.at(-1)!.contextCalls[0]).toEqual({ detail: 'full' });
    const withUsage = allEvents(h).slice(mark).filter((e) => e.type === 'session.updated' && (e.properties.info as Session).contextUsage) as Array<{ properties: { info: Session } }>;
    expect(withUsage.at(-1)!.properties.info.contextUsage).toMatchObject({ usedTokens: 22132, maxTokens: 1_000_000, source: 'exact' });
    expect((await h.manager.load(id)).session.contextUsage?.percent).toBe(2.2);

    const fresh: ContextUsage = await h.manager.contextUsage(id);
    expect(fresh.source).toBe('exact');
    expect(fresh.categories.some((c) => c.id === 'autocompact-buffer')).toBe(true);
  });

  test('a failing or unsupported getContextUsage never breaks the turn', async () => {
    const h = createHarness('text');
    await h.manager.bootstrap();
    const { id } = h.manager.create();
    await sendAndSettle(h, id);
    await until(() => h.queries.at(-1)!.contextCalls.length > 0, 2000);
    expect((await h.manager.load(id)).session.contextUsage).toBeUndefined();
    // the request falls back to an estimate (this fixture has assistant token counts)
    const estimate = await h.manager.contextUsage(id);
    expect(estimate.source).toBe('estimate');
    expect(estimate.maxTokens).toBe(200_000);
  });

  test('a cold session gets an estimate from the transcript and the last measurement once live', async () => {
    const h = createHarness('text', {}, undefined, { contextRaw: contextFull() });
    h.addTranscript('s1');
    h.api.history.set('s1', [
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01.000Z', message: { id: 'm1', model: 'm', content: [{ type: 'text', text: 'yo' }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 1000 } } },
    ]);
    await h.manager.bootstrap();
    const cold = await h.manager.load('s1');
    expect(cold.session.contextUsage).toMatchObject({ source: 'estimate', usedTokens: 21_015 });
    const viaRequest = await h.manager.contextUsage('s1');
    expect(viaRequest.source).toBe('estimate');
    await sendAndSettle(h, 's1', 'again');
    await until(() => h.queries.at(-1)!.contextCalls.length > 0, 2000);
    expect((await h.manager.contextUsage('s1')).source).toBe('exact');
  });
});
