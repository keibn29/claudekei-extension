/**
 * Pure helpers for the context-window / plan-usage popup (Claude desktop style). The host sends the numbers
 * (`Session.contextUsage`, `UsageLimits`); this module only formats and arranges them for drawing.
 */

import type { ContextCategory, ContextUsage, UsageLimits, UsageWindow } from './types';

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

/** `20777` -> `20.8k`, `432200` -> `432.2k`, `1_000_000` -> `1M`, `950` -> `950`. */
export const formatContextTokens = (tokens: number): string => {
  const value = Math.max(0, tokens);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(value));
};

/** One decimal below 10% (`2.1%`), whole numbers above (`43%`). */
export const formatContextPercent = (percent: number): string => {
  const value = Math.max(0, percent);
  if (value > 0 && value < 10) return `${value.toFixed(1).replace(/\.0$/, '')}%`;
  return `${Math.round(value)}%`;
};

/** `432.2k / 1M (43%)`. */
export const formatContextSummary = (usage: Pick<ContextUsage, 'usedTokens' | 'maxTokens' | 'percent'>): string =>
  `${formatContextTokens(usage.usedTokens)} / ${formatContextTokens(usage.maxTokens)} (${formatContextPercent(usage.percent)})`;

// ---------------------------------------------------------------------------
// Context bar
// ---------------------------------------------------------------------------

/** Theme variables per category id (our own palette: the host's `color` is a Claude Code token, not CSS). */
const CATEGORY_COLORS: Record<string, string> = {
  'system-prompt': 'var(--syntax-variable)',
  'system-tools': 'var(--status-info)',
  'mcp-tools': 'var(--status-warning)',
  'memory-files': 'var(--syntax-number)',
  'custom-agents': 'var(--status-success)',
  skills: 'var(--syntax-type)',
  messages: 'var(--primary)',
};

const FALLBACK_COLORS = ['var(--status-info)', 'var(--syntax-number)', 'var(--status-success)', 'var(--status-warning)', 'var(--syntax-keyword)'];

export const contextCategoryColor = (category: Pick<ContextCategory, 'id' | 'kind'>): string => {
  if (category.kind === 'buffer' || category.kind === 'deferred') return 'var(--muted-foreground)';
  if (category.kind === 'free') return 'var(--surface-subtle)';
  const known = CATEGORY_COLORS[category.id];
  if (known) return known;
  let hash = 0;
  for (let index = 0; index < category.id.length; index += 1) hash = (hash * 31 + category.id.charCodeAt(index)) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
};

export type ContextBarSegment = {
  id: string;
  label: string;
  tokens: number;
  /** Share of the window, 0-100. */
  widthPercent: number;
  kind: 'used' | 'buffer' | 'free';
  color: string;
};

const MIN_VISIBLE_PERCENT = 0.6;

/**
 * Segments of the bar in category order: each `used` category, then the autocompact buffer, then the remaining free
 * space. `free` is recomputed from the window size so rounding in the host's own free row can never overflow the bar.
 * Deferred categories live outside the window and are not drawn.
 */
export const buildContextBar = (usage: Pick<ContextUsage, 'maxTokens' | 'categories'>): ContextBarSegment[] => {
  const max = usage.maxTokens;
  if (!(max > 0)) return [];
  const segments: ContextBarSegment[] = [];
  let taken = 0;
  const push = (category: Pick<ContextCategory, 'id' | 'label' | 'tokens' | 'kind'>, kind: ContextBarSegment['kind']) => {
    const widthPercent = Math.min(100 - taken, Math.max((category.tokens / max) * 100, category.tokens > 0 ? MIN_VISIBLE_PERCENT : 0));
    if (widthPercent <= 0) return;
    taken += widthPercent;
    segments.push({
      id: category.id,
      label: category.label,
      tokens: category.tokens,
      widthPercent,
      kind,
      color: contextCategoryColor({ id: category.id, kind }),
    });
  };
  for (const category of usage.categories) if (category.kind === 'used' && category.tokens > 0) push(category, 'used');
  for (const category of usage.categories) if (category.kind === 'buffer' && category.tokens > 0) push(category, 'buffer');
  const usedAndBuffer = usage.categories.reduce((sum, category) => (category.kind === 'used' || category.kind === 'buffer' ? sum + category.tokens : sum), 0);
  const freeTokens = Math.max(0, max - usedAndBuffer);
  if (freeTokens > 0) {
    const free = usage.categories.find((category) => category.kind === 'free');
    push({ id: free?.id ?? 'free-space', label: free?.label ?? 'Free space', tokens: freeTokens, kind: 'free' }, 'free');
  }
  return segments;
};

export type ContextDetailRow = ContextCategory & { percentOfMax: number; color: string };

/** Rows of the detailed breakdown: used, buffer and free categories in host order, deferred ones last. */
export const buildContextDetail = (usage: Pick<ContextUsage, 'maxTokens' | 'categories'>): { window: ContextDetailRow[]; deferred: ContextDetailRow[] } => {
  const toRow = (category: ContextCategory): ContextDetailRow => ({
    ...category,
    percentOfMax: usage.maxTokens > 0 ? (category.tokens / usage.maxTokens) * 100 : 0,
    color: contextCategoryColor(category),
  });
  return {
    window: usage.categories.filter((category) => category.kind !== 'deferred').map(toRow),
    deferred: usage.categories.filter((category) => category.kind === 'deferred' && category.tokens > 0).map(toRow),
  };
};

// ---------------------------------------------------------------------------
// Plan usage limits
// ---------------------------------------------------------------------------

export type LimitTone = 'normal' | 'warning' | 'critical';

/** Bar tint: the server's severity wins, then the rate-limit status, then utilization thresholds (75% / 90%). */
export const usageWindowTone = (window: Pick<UsageWindow, 'severity' | 'status' | 'utilization'>): LimitTone => {
  if (window.severity === 'critical' || window.status === 'rejected') return 'critical';
  if (window.severity === 'warning' || window.status === 'allowed_warning') return 'warning';
  if (window.severity === 'normal') return 'normal';
  if (window.utilization >= 0.9) return 'critical';
  if (window.utilization >= 0.75) return 'warning';
  return 'normal';
};

export const usageWindowPercent = (window: Pick<UsageWindow, 'utilization'>): number =>
  Math.max(0, Math.min(100, Math.round(window.utilization * 100)));

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * `Resets in 2 hr 12 min` within 24 hours, `Resets Wed 12:00 PM` (local time) beyond; `undefined` without a reset time.
 * `locale` / `timeZone` exist for tests.
 */
export const formatUsageReset = (
  resetsAt: number | undefined,
  now: number = Date.now(),
  options: { locale?: string; timeZone?: string } = {},
): string | undefined => {
  if (typeof resetsAt !== 'number') return undefined;
  const diff = resetsAt - now;
  if (diff <= 0) return 'Resets soon';
  if (diff < 24 * HOUR_MS) {
    const hours = Math.floor(diff / HOUR_MS);
    const minutes = Math.floor((diff % HOUR_MS) / MINUTE_MS);
    if (hours === 0 && minutes === 0) return 'Resets in less than a minute';
    if (hours === 0) return `Resets in ${minutes} min`;
    if (minutes === 0) return `Resets in ${hours} hr`;
    return `Resets in ${hours} hr ${minutes} min`;
  }
  const date = new Date(resetsAt);
  const weekday = date.toLocaleDateString(options.locale ?? 'en-US', { weekday: 'short', timeZone: options.timeZone });
  const time = date.toLocaleTimeString(options.locale ?? 'en-US', { hour: 'numeric', minute: '2-digit', timeZone: options.timeZone });
  return `Resets ${weekday} ${time}`;
};

/** API-key / third-party providers report no windows: the limits section is hidden. */
export const hasUsageLimits = (usage: UsageLimits | null | undefined): usage is UsageLimits =>
  Boolean(usage && usage.windows.length > 0);

/** Refresh on popup open, but not more often than `throttleMs` (the host re-reads the endpoint every call). */
export const shouldRefreshUsage = (lastUpdatedAt: number | undefined, now: number, throttleMs: number = 30_000): boolean =>
  typeof lastUpdatedAt !== 'number' || now - lastUpdatedAt >= throttleMs;

// ---------------------------------------------------------------------------
// Pace
// ---------------------------------------------------------------------------

/** Length of the rolling window behind a meter kind; `undefined` when the kind has no fixed length. */
export const usageWindowDurationMs = (w: Pick<UsageWindow, 'kind'>): number | undefined =>
  w.kind === 'session' ? 5 * 3_600_000 : w.kind.startsWith('weekly') ? 7 * 86_400_000 : undefined;

export type UsagePace = { expected: number; status: 'on-track' | 'ahead' | 'exhausted'; runsOutAt?: number };

/**
 * Compares the share of the window that has elapsed (`expected`) with the utilization. `undefined` when the window
 * has no known length or reset time. `runsOutAt` is a linear projection, kept only when it lands before the reset.
 */
export function usageWindowPace(w: UsageWindow, now: number): UsagePace | undefined {
  const duration = usageWindowDurationMs(w);
  if (duration === undefined || typeof w.resetsAt !== 'number') return undefined;
  const start = w.resetsAt - duration;
  const elapsed = Math.max(0, Math.min(duration, now - start));
  const expected = elapsed / duration;
  const utilization = w.utilization;
  if (utilization >= 1 || w.status === 'rejected') return { expected, status: 'exhausted' };
  if (elapsed < 0.02 * duration || utilization <= expected) return { expected, status: 'on-track' };
  const runsOutAt = now + ((1 - utilization) * elapsed) / utilization;
  return runsOutAt < w.resetsAt ? { expected, status: 'ahead', runsOutAt } : { expected, status: 'ahead' };
}

/** `2 hr 12 min`, `45 min`, `3 hr`, `1 d 4 hr`; `less than a minute` below one minute. */
export const formatUsageDuration = (ms: number): string => {
  const value = Math.max(0, ms);
  const days = Math.floor(value / (24 * HOUR_MS));
  const hours = Math.floor((value % (24 * HOUR_MS)) / HOUR_MS);
  const minutes = Math.floor((value % HOUR_MS) / MINUTE_MS);
  if (days > 0) return hours > 0 ? `${days} d ${hours} hr` : `${days} d`;
  if (hours > 0) return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
  return minutes > 0 ? `${minutes} min` : 'less than a minute';
};
