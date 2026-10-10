import { describe, expect, test } from 'bun:test';
import {
  buildContextBar,
  buildContextDetail,
  contextCategoryColor,
  formatContextPercent,
  formatContextSummary,
  formatContextTokens,
  formatUsageReset,
  hasUsageLimits,
  shouldRefreshUsage,
  formatUsageDuration,
  usageWindowDurationMs,
  usageWindowPace,
  usageWindowPercent,
  usageWindowTone,
} from './usage';
import type { UsageWindow } from './types';
import type { ContextCategory } from './types';

const categories: ContextCategory[] = [
  { id: 'system-prompt', label: 'System prompt', tokens: 4_000, kind: 'used' },
  { id: 'system-tools', label: 'System tools', tokens: 8_000, kind: 'used' },
  { id: 'messages', label: 'Messages', tokens: 8_777, kind: 'used' },
  { id: 'autocompact-buffer', label: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
  { id: 'free-space', label: 'Free space', tokens: 946_223, kind: 'free' },
  { id: 'mcp-tools-deferred', label: 'MCP tools (deferred)', tokens: 12_000, kind: 'deferred' },
];

describe('formatting', () => {
  test('tokens', () => {
    expect(formatContextTokens(20_777)).toBe('20.8k');
    expect(formatContextTokens(432_200)).toBe('432.2k');
    expect(formatContextTokens(1_000_000)).toBe('1M');
    expect(formatContextTokens(950)).toBe('950');
    expect(formatContextTokens(0)).toBe('0');
  });

  test('percent keeps a decimal below 10% only', () => {
    expect(formatContextPercent(2.1)).toBe('2.1%');
    expect(formatContextPercent(43.2)).toBe('43%');
    expect(formatContextPercent(0)).toBe('0%');
    expect(formatContextPercent(5)).toBe('5%');
  });

  test('summary line', () => {
    expect(formatContextSummary({ usedTokens: 432_200, maxTokens: 1_000_000, percent: 43.2 })).toBe('432.2k / 1M (43%)');
  });
});

describe('context bar', () => {
  test('used categories in order, then buffer, then free; deferred is not drawn', () => {
    const bar = buildContextBar({ maxTokens: 1_000_000, categories });
    expect(bar.map((segment) => [segment.id, segment.kind])).toEqual([
      ['system-prompt', 'used'],
      ['system-tools', 'used'],
      ['messages', 'used'],
      ['autocompact-buffer', 'buffer'],
      ['free-space', 'free'],
    ]);
    const total = bar.reduce((sum, segment) => sum + segment.widthPercent, 0);
    expect(total).toBeGreaterThan(99.9);
    expect(total <= 100.0001).toBe(true);
  });

  test('free space is recomputed from the window, never overflowing', () => {
    const bar = buildContextBar({ maxTokens: 100, categories: [{ id: 'messages', label: 'Messages', tokens: 120, kind: 'used' }, { id: 'free-space', label: 'Free', tokens: 50, kind: 'free' }] });
    expect(bar.reduce((sum, segment) => sum + segment.widthPercent, 0) <= 100.0001).toBe(true);
    expect(bar.some((segment) => segment.kind === 'free')).toBe(false);
  });

  test('tiny segments stay visible; an empty window draws nothing', () => {
    const bar = buildContextBar({ maxTokens: 1_000_000, categories: [{ id: 'skills', label: 'Skills', tokens: 10, kind: 'used' }] });
    expect(bar[0].widthPercent).toBeGreaterThanOrEqual(0.5);
    expect(buildContextBar({ maxTokens: 0, categories })).toEqual([]);
  });

  test('colors come from our palette by id/kind', () => {
    expect(contextCategoryColor({ id: 'messages', kind: 'used' })).toBe('var(--primary)');
    expect(contextCategoryColor({ id: 'whatever', kind: 'buffer' })).toBe('var(--muted-foreground)');
    expect(contextCategoryColor({ id: 'mcp-tools-deferred', kind: 'deferred' })).toBe('var(--muted-foreground)');
    expect(contextCategoryColor({ id: 'new-thing', kind: 'used' })).toBe(contextCategoryColor({ id: 'new-thing', kind: 'used' }));
  });

  test('detail lists window categories with their share and deferred ones separately', () => {
    const detail = buildContextDetail({ maxTokens: 1_000_000, categories });
    expect(detail.window.map((row) => row.id)).toEqual(['system-prompt', 'system-tools', 'messages', 'autocompact-buffer', 'free-space']);
    expect(Math.abs(detail.window[1].percentOfMax - 0.8) < 1e-9).toBe(true);
    expect(detail.deferred.map((row) => row.id)).toEqual(['mcp-tools-deferred']);
  });
});

describe('usage windows', () => {
  test('tone: server severity, then status, then utilization', () => {
    expect(usageWindowTone({ severity: 'critical', utilization: 0.1 })).toBe('critical');
    expect(usageWindowTone({ status: 'allowed_warning', utilization: 0.1 })).toBe('warning');
    expect(usageWindowTone({ status: 'rejected', utilization: 1 })).toBe('critical');
    expect(usageWindowTone({ severity: 'normal', utilization: 0.95 })).toBe('normal');
    expect(usageWindowTone({ utilization: 0.8 })).toBe('warning');
    expect(usageWindowTone({ utilization: 0.92 })).toBe('critical');
    expect(usageWindowTone({ utilization: 0.37 })).toBe('normal');
  });

  test('percent is clamped and rounded', () => {
    expect(usageWindowPercent({ utilization: 0.374 })).toBe(37);
    expect(usageWindowPercent({ utilization: 1.4 })).toBe(100);
    expect(usageWindowPercent({ utilization: -1 })).toBe(0);
  });

  test('reset text: relative under 24 h, weekday + local time beyond', () => {
    const now = Date.UTC(2026, 9, 14, 10, 0, 0); // Wed 2026-10-14 10:00Z
    expect(formatUsageReset(now + (2 * 60 + 12) * 60_000, now)).toBe('Resets in 2 hr 12 min');
    expect(formatUsageReset(now + 45 * 60_000, now)).toBe('Resets in 45 min');
    expect(formatUsageReset(now + 3 * 3_600_000, now)).toBe('Resets in 3 hr');
    expect(formatUsageReset(now + 20_000, now)).toBe('Resets in less than a minute');
    expect(formatUsageReset(now - 1, now)).toBe('Resets soon');
    expect(formatUsageReset(undefined, now)).toBeUndefined();
    const weekly = formatUsageReset(Date.UTC(2026, 9, 21, 12, 0, 0), now, { timeZone: 'UTC' });
    expect(weekly).toBe('Resets Wed 12:00 PM');
  });

  test('API-key users (no windows) have no limits section; refresh is throttled', () => {
    expect(hasUsageLimits(undefined)).toBe(false);
    expect(hasUsageLimits({ windows: [], updatedAt: 1, source: 'usage' })).toBe(false);
    expect(hasUsageLimits({ windows: [{ id: 'session', kind: 'session', label: 'Session limit', utilization: 0.37 }], updatedAt: 1, source: 'usage' })).toBe(true);
    expect(shouldRefreshUsage(undefined, 100)).toBe(true);
    expect(shouldRefreshUsage(1_000, 20_000)).toBe(false);
    expect(shouldRefreshUsage(1_000, 40_000)).toBe(true);
  });
});

describe('usage pace', () => {
  const HOUR = 3_600_000;
  const now = Date.UTC(2026, 9, 14, 10, 0, 0);
  // Session window: 5 h long, 2 h elapsed (40%).
  const session = (patch: Partial<UsageWindow>): UsageWindow => ({
    id: 'session',
    kind: 'session',
    label: 'Session limit',
    utilization: 0.3,
    resetsAt: now + 3 * HOUR,
    ...patch,
  });

  test('window durations', () => {
    expect(usageWindowDurationMs({ kind: 'session' })).toBe(5 * HOUR);
    expect(usageWindowDurationMs({ kind: 'weekly_all' })).toBe(7 * 24 * HOUR);
    expect(usageWindowDurationMs({ kind: 'weekly_scoped' })).toBe(7 * 24 * HOUR);
    expect(usageWindowDurationMs({ kind: 'monthly' })).toBeUndefined();
  });

  test('on track when utilization is at or below the elapsed share', () => {
    const pace = usageWindowPace(session({ utilization: 0.3 }), now);
    expect(pace?.status).toBe('on-track');
    expect(Math.abs((pace?.expected ?? 0) - 0.4)).toBeLessThan(1e-9);
    expect(pace?.runsOutAt).toBeUndefined();
  });

  test('on track right after a reset even with high utilization', () => {
    const pace = usageWindowPace(session({ utilization: 0.5, resetsAt: now + 5 * HOUR - 60_000 }), now);
    expect(pace?.status).toBe('on-track');
  });

  test('ahead projects when the limit runs out, before the reset', () => {
    // 80% used after 2 h of 5 h: remaining 20% at 40%/h -> 0.5 h left.
    const pace = usageWindowPace(session({ utilization: 0.8 }), now);
    expect(pace?.status).toBe('ahead');
    expect(Math.abs((pace?.runsOutAt ?? 0) - (now + 0.5 * HOUR))).toBeLessThan(1000);
  });

  test('ahead just above the elapsed share still projects a limit before the reset', () => {
    const pace = usageWindowPace(session({ utilization: 0.45 }), now);
    expect(pace?.status).toBe('ahead');
    expect(pace?.runsOutAt).toBeGreaterThan(now);
    expect(pace?.runsOutAt).toBeLessThan(now + 3 * HOUR);
  });

  test('exhausted at full utilization or when rejected', () => {
    expect(usageWindowPace(session({ utilization: 1 }), now)?.status).toBe('exhausted');
    expect(usageWindowPace(session({ utilization: 0.2, status: 'rejected' }), now)?.status).toBe('exhausted');
  });

  test('unknown kind or missing reset has no pace', () => {
    expect(usageWindowPace(session({ kind: 'monthly' }), now)).toBeUndefined();
    expect(usageWindowPace(session({ resetsAt: undefined }), now)).toBeUndefined();
  });

  test('formats projected durations', () => {
    expect(formatUsageDuration(2 * HOUR + 12 * 60_000)).toBe('2 hr 12 min');
    expect(formatUsageDuration(45 * 60_000)).toBe('45 min');
    expect(formatUsageDuration(3 * HOUR)).toBe('3 hr');
    expect(formatUsageDuration(28 * HOUR)).toBe('1 d 4 hr');
    expect(formatUsageDuration(10_000)).toBe('less than a minute');
  });
});
