import React from 'react';
import { RiExternalLinkLine, RiLoader4Line, RiRefreshLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { UsageLimitRow } from '@/components/usage/UsageLimitRow';
import { claudeClient } from '@/lib/claude/client';
import { getAccount, setUsage, subscribeBootstrapCache } from '@/lib/claude/bootstrapCache';
import { useUsageLimits } from '@/lib/claude/useUsageLimits';
import { hasUsageLimits } from '@/lib/claude/usage';
import type { UsageActivity, UsageActivityWindow, UsageShare } from '@/lib/claude/types';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { errorText, formatRelativeTime } from '@/components/sections/claude-config/configFields';

const CLAUDE_AI_USAGE_URL = 'https://claude.ai/settings/usage';
const TICK_MS = 30_000;

type ActivityRange = 'day' | 'week';
type ActivityState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; activity: UsageActivity | null };

const titleCase = (key: string): string =>
  key
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

const SectionHeading: React.FC<{ children: React.ReactNode; action?: React.ReactNode }> = ({ children, action }) => (
  <div className="mb-2 flex items-center justify-between gap-2 px-1">
    <h3 className="typography-ui-header min-w-0 truncate font-medium text-foreground">{children}</h3>
    {action}
  </div>
);

const ShareList: React.FC<{ title: string; items: UsageShare[] }> = ({ title, items }) => {
  const top = items.slice(0, 5);
  if (top.length === 0) return null;
  return (
    <div className="space-y-1.5" data-usage-list={title}>
      <div className="typography-micro uppercase tracking-wide text-muted-foreground/80">{title}</div>
      <ul className="space-y-1.5">
        {top.map((item) => (
          <li key={item.name} className="space-y-0.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="typography-meta min-w-0 truncate text-foreground" title={item.name}>{item.name}</span>
              <span className="typography-meta flex-shrink-0 tabular-nums text-muted-foreground">{Math.round(item.pct)}%</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]">
              <div className="h-full rounded-full bg-primary/70" style={{ width: `${Math.max(0, Math.min(100, item.pct))}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

const ActivityBody: React.FC<{ data: UsageActivityWindow }> = ({ data }) => {
  const { t } = useI18n();
  const behaviorLabel = (key: string): string => {
    const messageKey = `claudeUsage.activity.behavior.${key}`;
    const translated = t(messageKey as Parameters<typeof t>[0]);
    return translated === messageKey ? titleCase(key) : translated;
  };
  const empty = data.requests === 0 && data.sessions === 0;
  return (
    <div className="space-y-4">
      <div className="typography-meta tabular-nums text-muted-foreground">
        {t('claudeUsage.activity.totals', { requests: data.requests, sessions: data.sessions })}
      </div>
      {empty ? (
        <div className="typography-meta text-muted-foreground">{t('claudeUsage.activity.empty')}</div>
      ) : (
        <>
          <div className="space-y-1.5">
            <div className="typography-micro uppercase tracking-wide text-muted-foreground/80">{t('claudeUsage.activity.behaviors')}</div>
            {data.behaviors.length > 0 ? (
              <ul className="space-y-1">
                {data.behaviors.map((behavior) => (
                  <li key={behavior.key} className="flex items-baseline justify-between gap-2" data-usage-behavior={behavior.key}>
                    <span className="typography-meta min-w-0 truncate text-foreground">{behaviorLabel(behavior.key)}</span>
                    <span className="typography-meta flex-shrink-0 tabular-nums text-muted-foreground">{Math.round(behavior.pct)}%</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="typography-meta text-muted-foreground">{t('claudeUsage.activity.noBehaviors')}</div>
            )}
          </div>
          <ShareList title={t('claudeUsage.activity.list.agents')} items={data.agents} />
          <ShareList title={t('claudeUsage.activity.list.skills')} items={data.skills} />
          <ShareList title={t('claudeUsage.activity.list.plugins')} items={data.plugins} />
          <ShareList title={t('claudeUsage.activity.list.mcpServers')} items={data.mcpServers} />
        </>
      )}
    </div>
  );
};

const RangeToggle: React.FC<{ value: ActivityRange; onChange: (value: ActivityRange) => void }> = ({ value, onChange }) => {
  const { t } = useI18n();
  const options: Array<{ id: ActivityRange; label: string }> = [
    { id: 'day', label: t('claudeUsage.activity.range24h') },
    { id: 'week', label: t('claudeUsage.activity.range7d') },
  ];
  return (
    <div role="group" aria-label={t('claudeUsage.activity.rangeAria')} className="flex flex-shrink-0 overflow-hidden rounded-md border border-border/60">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            'typography-micro px-2 py-0.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
            value === option.id ? 'bg-[var(--interactive-selection)] text-foreground' : 'text-muted-foreground hover:bg-[var(--interactive-hover)]',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
};

/** Plan limits with pace, extra usage and local activity breakdown (single settings page, no sidebar). */
export const UsagePage: React.FC = () => {
  const { t, locale } = useI18n();
  const limits = useUsageLimits();
  const account = React.useSyncExternalStore(subscribeBootstrapCache, getAccount, getAccount);
  const [now, setNow] = React.useState(() => Date.now());
  const [refreshing, setRefreshing] = React.useState(false);
  const [refreshError, setRefreshError] = React.useState<string | null>(null);
  const [range, setRange] = React.useState<ActivityRange>('day');
  const [activity, setActivity] = React.useState<ActivityState>({ status: 'loading' });

  // Reset countdowns and pace move with time.
  React.useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const loadActivity = React.useCallback(() => {
    let cancelled = false;
    setActivity({ status: 'loading' });
    claudeClient
      .usageActivity()
      .then((result) => {
        if (!cancelled) setActivity({ status: 'ready', activity: result });
      })
      .catch((error: unknown) => {
        if (!cancelled) setActivity({ status: 'error', message: errorText(error) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => loadActivity(), [loadActivity]);

  const handleRefresh = () => {
    setRefreshing(true);
    setRefreshError(null);
    claudeClient
      .refreshUsage()
      .then((result) => {
        setUsage(result);
        setNow(Date.now());
      })
      .catch((error: unknown) => setRefreshError(errorText(error)))
      .finally(() => setRefreshing(false));
  };

  const withLimits = hasUsageLimits(limits);
  const extra = limits?.extraUsage;
  const activityWindow = activity.status === 'ready' && activity.activity ? activity.activity[range] : null;
  const extraPercent = extra?.utilization !== undefined ? Math.round(extra.utilization * 100) : undefined;

  return (
    <SettingsPageLayout>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="typography-ui-header font-semibold text-foreground">{t('claudeUsage.title')}</h2>
            {limits?.plan ? (
              <span className="typography-micro flex-shrink-0 rounded border border-border/50 bg-muted px-1 pb-px leading-none text-muted-foreground">
                {limits.plan}
              </span>
            ) : null}
          </div>
          <div className="flex flex-shrink-0 items-center gap-1.5">
            <Button type="button" size="xs" variant="outline" className="gap-1 !font-normal" disabled={refreshing} onClick={handleRefresh}>
              <RiRefreshLine className={cn('h-3 w-3', refreshing && 'animate-spin')} />
              {refreshing ? t('claudeUsage.refreshing') : t('claudeUsage.refresh')}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="gap-1 !font-normal"
              aria-label={t('claudeUsage.openClaudeAiAria')}
              onClick={() => void openExternalUrl(CLAUDE_AI_USAGE_URL)}
            >
              {t('claudeUsage.openClaudeAi')}
              <RiExternalLinkLine className="h-3 w-3" />
            </Button>
          </div>
        </div>
        {account?.email || (withLimits && limits) ? (
          <div className="typography-micro flex flex-wrap items-center gap-x-2 px-1 text-muted-foreground">
            {account?.email ? <span className="min-w-0 truncate" title={account.email}>{account.email}</span> : null}
            {limits && withLimits ? <span>{t('claudeUsage.updated', { time: formatRelativeTime(limits.updatedAt, now, locale) })}</span> : null}
          </div>
        ) : null}
        {refreshError ? (
          <div className="typography-micro px-1 text-[var(--status-error)]">{t('claudeUsage.refreshFailed', { error: refreshError })}</div>
        ) : null}
      </div>

      <section>
        {withLimits ? (
          <>
            <SectionHeading>{t('claudeUsage.limitsHeading')}</SectionHeading>
            <div className="space-y-3 rounded-lg border border-border/40 bg-[var(--surface-elevated)] p-3" data-usage-limits>
              {limits.windows.map((window) => (
                <UsageLimitRow key={window.id} window={window} now={now} showPace />
              ))}
            </div>
          </>
        ) : (
          <p className="typography-meta px-1 text-muted-foreground">{t('claudeUsage.noLimits')}</p>
        )}
      </section>

      {extra?.enabled ? (
        <section>
          <SectionHeading>{t('claudeUsage.extra.heading')}</SectionHeading>
          <div className="typography-meta rounded-lg border border-border/40 bg-[var(--surface-elevated)] p-3 tabular-nums text-foreground" data-usage-extra>
            {extra.limit !== undefined
              ? t('claudeUsage.extra.summary', {
                  used: (extra.used ?? 0).toFixed(2),
                  limit: extra.limit.toFixed(2),
                  currency: extra.currency ?? '',
                  percent: extraPercent ?? Math.round(((extra.used ?? 0) / (extra.limit || 1)) * 100),
                })
              : t('claudeUsage.extra.summaryNoLimit', { used: (extra.used ?? 0).toFixed(2), currency: extra.currency ?? '' })}
          </div>
        </section>
      ) : null}

      {activity.status === 'ready' && activity.activity === null ? null : (
        <section data-usage-activity>
          <SectionHeading action={activityWindow ? <RangeToggle value={range} onChange={setRange} /> : undefined}>
            {t('claudeUsage.activity.heading')}
          </SectionHeading>
          <div className="rounded-lg border border-border/40 bg-[var(--surface-elevated)] p-3">
            {activity.status === 'loading' ? (
              <div className="typography-meta flex items-center gap-2 text-muted-foreground">
                <RiLoader4Line className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('claudeUsage.activity.loading')}
              </div>
            ) : activity.status === 'error' ? (
              <div className="space-y-2">
                <div className="typography-meta text-[var(--status-error)]">{t('claudeUsage.activity.error', { error: activity.message })}</div>
                <Button type="button" size="xs" variant="outline" className="!font-normal" onClick={loadActivity}>
                  {t('claudeUsage.activity.retry')}
                </Button>
              </div>
            ) : activityWindow ? (
              <ActivityBody data={activityWindow} />
            ) : null}
          </div>
          {activityWindow ? (
            <p className="typography-micro mt-2 px-1 text-muted-foreground/70">{t('claudeUsage.activity.footnote')}</p>
          ) : null}
        </section>
      )}
    </SettingsPageLayout>
  );
};
