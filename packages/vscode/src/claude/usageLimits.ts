/**
 * Plan usage limits (claude.ai subscription) for the "Your usage limits" popup.
 *
 * Primary source: the SDK's usage endpoint (`Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, the data
 * behind `/usage`), which needs no model turn. Secondary: the `rate_limit_event` the CLI emits during a turn, which
 * describes only the window that changed. API-key and third-party providers have no plan limits: `windows: []`.
 */
import type { AccountInfo, UsageActivity, UsageActivityWindow, UsageLimits, UsageShare, UsageWindow } from '@openchamber/ui/src/lib/claude/types';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const isoToMs = (v: unknown): number | undefined => {
  const t = typeof v === 'string' ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : undefined;
};

const titleCase = (s: string): string => s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Server meter -> desktop label / id. */
function describeLimit(kind: string, scopeName: string | undefined): { id: string; label: string } {
  if (kind === 'session') return { id: 'session', label: 'Session limit' };
  if (kind === 'weekly_all') return { id: 'weekly', label: 'Weekly · All models' };
  if (kind === 'weekly_scoped') return { id: `weekly:${(scopeName ?? 'scoped').toLowerCase()}`, label: `Weekly · ${scopeName ?? 'Scoped'}` };
  return { id: kind, label: titleCase(kind) };
}

/** Pretty plan name: `team` -> "Team"; falls back to the account's subscription type. */
const planName = (subscriptionType: unknown, account?: AccountInfo | null): string | undefined => {
  const raw = str(subscriptionType);
  if (raw) return raw.replace(/\b\w/g, (c) => c.toUpperCase());
  return account?.subscriptionType?.replace(/^Claude\s+/i, '') || undefined;
};

/** Maps the SDK usage response (`rate_limits.limits[]`, legacy window fields as fallback). */
export function parseUsageReport(raw: unknown, now: number, account?: AccountInfo | null): UsageLimits {
  const report = isRec(raw) ? raw : {};
  const limits = isRec(report.rate_limits) ? report.rate_limits : undefined;
  const plan = planName(report.subscription_type, account);
  if (report.rate_limits_available === false || !limits) return { ...(plan ? { plan } : {}), windows: [], updatedAt: now, source: 'usage' };

  const windows: UsageWindow[] = [];
  const rows = Array.isArray(limits.limits) ? limits.limits : undefined;
  if (rows) {
    for (const r of rows) {
      if (!isRec(r)) continue;
      const kind = str(r.kind);
      const percent = num(r.percent);
      if (!kind || percent === undefined) continue;
      const scope = isRec(r.scope) ? r.scope : undefined;
      const scopeName = str((isRec(scope?.model) ? scope.model : undefined)?.display_name) ?? str((isRec(scope?.surface) ? scope.surface : undefined)?.display_name);
      const { id, label } = describeLimit(kind, scopeName);
      const resetsAt = isoToMs(r.resets_at);
      windows.push({ id, kind, label, utilization: clamp01(percent / 100), ...(resetsAt !== undefined ? { resetsAt } : {}), ...(str(r.severity) ? { severity: str(r.severity) } : {}), ...(r.is_active === true ? { active: true } : {}) });
    }
  } else {
    // Older CLIs: fixed window fields.
    const legacy: Array<[string, string, string, unknown]> = [
      ['session', 'session', 'Session limit', limits.five_hour],
      ['weekly', 'weekly_all', 'Weekly · All models', limits.seven_day],
      ['weekly:opus', 'weekly_scoped', 'Weekly · Opus', limits.seven_day_opus],
      ['weekly:sonnet', 'weekly_scoped', 'Weekly · Sonnet', limits.seven_day_sonnet],
    ];
    for (const [id, kind, label, w] of legacy) {
      if (!isRec(w)) continue;
      const u = num(w.utilization);
      if (u === undefined) continue;
      const resetsAt = isoToMs(w.resets_at);
      windows.push({ id, kind, label, utilization: clamp01(u / 100), ...(resetsAt !== undefined ? { resetsAt } : {}) });
    }
    for (const m of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) {
      if (!isRec(m)) continue;
      const name = str(m.display_name);
      const u = num(m.utilization);
      if (!name || u === undefined) continue;
      const resetsAt = isoToMs(m.resets_at);
      windows.push({ id: `weekly:${name.toLowerCase()}`, kind: 'weekly_scoped', label: `Weekly · ${name}`, utilization: clamp01(u / 100), ...(resetsAt !== undefined ? { resetsAt } : {}) });
    }
  }

  const extra = isRec(limits.extra_usage) ? limits.extra_usage : undefined;
  const result: UsageLimits = { ...(plan ? { plan } : {}), windows, updatedAt: now, source: 'usage' };
  if (extra && typeof extra.is_enabled === 'boolean') {
    const used = num(extra.used_credits);
    const limit = num(extra.monthly_limit);
    const utilization = num(extra.utilization);
    result.extraUsage = { enabled: extra.is_enabled, ...(used !== undefined ? { used } : {}), ...(limit !== undefined ? { limit } : {}), ...(utilization !== undefined ? { utilization: clamp01(utilization / 100) } : {}), ...(str(extra.currency) ? { currency: str(extra.currency) } : {}) };
  }
  return result;
};

const WINDOW_ORDER = ['session', 'weekly'];
/** Session first, then weekly, then the rest (stable). */
const sortWindows = (windows: UsageWindow[]): void => {
  windows.sort((a, b) => (WINDOW_ORDER.indexOf(a.id) + 1 || 99) - (WINDOW_ORDER.indexOf(b.id) + 1 || 99));
};

/**
 * A usage report that lists fewer windows than we already know about (e.g. one that dropped the session row) must not
 * erase them: windows of `previous` that `next` lacks are kept while their reset time is still in the future. Windows
 * without a reset time or past it are dropped (their meter has restarted, the old figure would be wrong).
 */
export function carryOverWindows(previous: UsageLimits | undefined, next: UsageLimits, now: number): UsageLimits {
  const missing = (previous?.windows ?? []).filter((w) => !next.windows.some((n) => n.id === w.id) && w.resetsAt !== undefined && w.resetsAt > now);
  if (missing.length === 0) return next;
  const windows = [...next.windows, ...missing];
  sortWindows(windows);
  return { ...next, windows };
}

const EVENT_WINDOWS: Record<string, { id: string; kind: string; label: string }> = {
  five_hour: { id: 'session', kind: 'session', label: 'Session limit' },
  seven_day: { id: 'weekly', kind: 'weekly_all', label: 'Weekly · All models' },
  seven_day_opus: { id: 'weekly:opus', kind: 'weekly_scoped', label: 'Weekly · Opus' },
  seven_day_sonnet: { id: 'weekly:sonnet', kind: 'weekly_scoped', label: 'Weekly · Sonnet' },
};

/**
 * Folds one `rate_limit_event.rate_limit_info` into the last known limits (replacing that window only). The event
 * carries the changed window in `rateLimitType` with `utilization` (0-1) / `resetsAt` (epoch seconds), and often
 * `unifiedWindows[type]` with the same data. Returns `previous` unchanged for event types it does not map
 * (`overage`, `seven_day_overage_included`).
 */
export function applyRateLimitEvent(previous: UsageLimits | undefined, info: unknown, now: number): UsageLimits | undefined {
  if (!isRec(info)) return previous;
  const type = str(info.rateLimitType);
  const meta = type ? EVENT_WINDOWS[type] : undefined;
  if (!type || !meta) return previous;
  const unified = isRec(info.unifiedWindows) && isRec(info.unifiedWindows[type]) ? (info.unifiedWindows[type] as Rec) : undefined;
  const utilization = num(unified?.utilization) ?? num(info.utilization);
  const resetsSec = num(unified?.resetsAt) ?? num(info.resetsAt);
  const status = info.status === 'allowed' || info.status === 'allowed_warning' || info.status === 'rejected' ? info.status : undefined;
  const existing = previous?.windows.find((w) => w.id === meta.id);
  const window: UsageWindow = {
    ...existing,
    ...meta,
    utilization: utilization !== undefined ? clamp01(utilization) : (existing?.utilization ?? (status === 'rejected' ? 1 : 0)),
    ...(resetsSec !== undefined ? { resetsAt: resetsSec * 1000 } : {}),
    ...(status ? { status } : {}),
  };
  const windows = previous ? previous.windows.filter((w) => w.id !== meta.id) : [];
  windows.push(window);
  sortWindows(windows);
  return { ...previous, windows, updatedAt: now, source: previous?.source ?? 'rate_limit_event' };
}

const shares = (v: unknown): UsageShare[] =>
  (Array.isArray(v) ? v : [])
    .flatMap((e): UsageShare[] => (isRec(e) && str(e.name) && num(e.pct) !== undefined ? [{ name: e.name as string, pct: num(e.pct)! }] : []))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 5);

function activityWindow(v: unknown): UsageActivityWindow {
  const w = isRec(v) ? v : {};
  return {
    requests: num(w.request_count) ?? 0,
    sessions: num(w.session_count) ?? 0,
    behaviors: (Array.isArray(w.behaviors) ? w.behaviors : []).flatMap((b): Array<{ key: string; pct: number }> => (isRec(b) && str(b.key) && num(b.pct) !== undefined ? [{ key: b.key as string, pct: num(b.pct)! }] : [])).sort((a, b) => b.pct - a.pct),
    agents: shares(w.agents),
    skills: shares(w.skills),
    plugins: shares(w.plugins),
    mcpServers: shares(w.mcp_servers),
  };
}

/**
 * "What is contributing to limits usage" (24 h / 7 d) from the SDK usage response fetched with `skipBehaviors: false`.
 * Null when the scan was skipped or failed (`behaviors: null`: API-key sessions, no subscription).
 */
export function parseUsageActivity(raw: unknown, now: number): UsageActivity | null {
  const behaviors = isRec(raw) && isRec(raw.behaviors) ? raw.behaviors : undefined;
  if (!behaviors) return null;
  return { day: activityWindow(behaviors.day), week: activityWindow(behaviors.week), updatedAt: now };
}
