import React from 'react';
import { useI18n } from '@/lib/i18n';
import type { UsageWindow } from '@/lib/claude/types';
import {
    formatUsageDuration,
    formatUsageReset,
    usageWindowPace,
    usageWindowPercent,
    usageWindowTone,
    type LimitTone,
} from '@/lib/claude/usage';

const TONE_COLOR: Record<LimitTone, string> = {
    normal: 'var(--primary)',
    warning: 'var(--status-warning)',
    critical: 'var(--status-error)',
};

type UsageLimitRowProps = {
    window: UsageWindow;
    now: number;
    /** Adds the expected-use tick on the bar and a pace line under it. */
    showPace?: boolean;
};

/** One plan limit: label, percent, bar and reset time; optionally the pace against the elapsed window. */
export const UsageLimitRow: React.FC<UsageLimitRowProps> = ({ window: usageWindow, now, showPace = false }) => {
    const { t } = useI18n();
    const percent = usageWindowPercent(usageWindow);
    const tone = usageWindowTone(usageWindow);
    const reset = formatUsageReset(usageWindow.resetsAt, now);
    const pace = showPace ? usageWindowPace(usageWindow, now) : undefined;
    const expectedPercent = pace ? Math.max(0, Math.min(100, pace.expected * 100)) : undefined;
    const paceText = pace
        ? pace.status === 'exhausted'
            ? t('claudeUsage.pace.exhausted')
            : pace.status === 'ahead'
                ? pace.runsOutAt !== undefined
                    ? t('claudeUsage.pace.aheadRunsOut', { duration: formatUsageDuration(pace.runsOutAt - now) })
                    : t('claudeUsage.pace.ahead')
                : t('claudeUsage.pace.onTrack')
        : undefined;
    return (
        <div className="space-y-1" data-usage-window={usageWindow.id}>
            <div className="flex items-baseline justify-between gap-2">
                <span className="typography-meta min-w-0 truncate text-foreground">{usageWindow.label}</span>
                <span className="typography-meta flex-shrink-0 tabular-nums" style={{ color: tone === 'normal' ? undefined : TONE_COLOR[tone] }}>
                    {percent}%
                </span>
            </div>
            <div
                role="progressbar"
                aria-label={t('contextUsage.popover.limitAria', { label: usageWindow.label, percent: `${percent}%` })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]"
            >
                <div className="h-full rounded-full transition-[width]" style={{ width: `${percent}%`, backgroundColor: TONE_COLOR[tone] }} />
                {expectedPercent !== undefined ? (
                    <div
                        aria-hidden="true"
                        title={t('claudeUsage.pace.expectedAria', { percent: `${Math.round(expectedPercent)}%` })}
                        className="absolute inset-y-0 w-px bg-foreground/60"
                        style={{ left: `${expectedPercent}%` }}
                    />
                ) : null}
            </div>
            {reset || paceText ? (
                <div className="typography-micro flex items-baseline justify-between gap-2 text-muted-foreground">
                    <span className="min-w-0 truncate">{reset}</span>
                    {paceText ? (
                        <span
                            className="flex-shrink-0 text-right"
                            style={pace?.status === 'on-track' ? undefined : { color: pace?.status === 'exhausted' ? TONE_COLOR.critical : TONE_COLOR.warning }}
                        >
                            {paceText}
                        </span>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
};
