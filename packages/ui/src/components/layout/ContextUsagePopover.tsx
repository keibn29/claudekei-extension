import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { RiArrowLeftSLine, RiArrowRightSLine, RiArrowDownSLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { claudeClient } from '@/lib/claude/client';
import { getUsage, setUsage } from '@/lib/claude/bootstrapCache';
import { useUsageLimits } from '@/lib/claude/useUsageLimits';
import type { ContextUsage, UsageWindow } from '@/lib/claude/types';
import {
    buildContextBar,
    buildContextDetail,
    formatContextPercent,
    formatContextSummary,
    formatContextTokens,
    formatUsageReset,
    hasUsageLimits,
    shouldRefreshUsage,
    usageWindowPercent,
    usageWindowTone,
    type ContextDetailRow,
    type LimitTone,
} from '@/lib/claude/usage';
import { useSession } from '@/sync/sync-context';

const TONE_COLOR: Record<LimitTone, string> = {
    normal: 'var(--primary)',
    warning: 'var(--status-warning)',
    critical: 'var(--status-error)',
};

/** Pie colour of the trigger ring: green until 75%, then warning, then error (same thresholds as before). */
const ringColor = (percent: number): string =>
    percent >= 90 ? 'var(--status-error)' : percent >= 75 ? 'var(--status-warning)' : 'var(--status-success)';

const popoverStyle: React.CSSProperties = { backgroundColor: 'var(--surface-elevated)', color: 'var(--surface-elevated-foreground)' };

const popoverClassName =
    'w-[min(340px,calc(100vw-1rem))] rounded-xl border border-border/60 p-3 shadow-lg outline-none animate-in fade-in-0 zoom-in-95 duration-150';

type ContextBarProps = { usage: ContextUsage; label: string };

/** Segmented bar: used categories (coloured, in order), the autocompact buffer (hatched) and the free track. */
const ContextBar: React.FC<ContextBarProps> = ({ usage, label }) => {
    const segments = React.useMemo(() => buildContextBar(usage), [usage]);
    return (
        <div
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(usage.percent)}
            aria-valuetext={formatContextSummary(usage)}
            className="flex h-2 w-full gap-px overflow-hidden rounded-full bg-[var(--surface-subtle)]"
        >
            {segments.filter((segment) => segment.kind !== 'free').map((segment) => (
                <span
                    key={segment.id}
                    title={`${segment.label}: ${formatContextTokens(segment.tokens)}`}
                    className="h-full flex-shrink-0 first:rounded-l-full last:rounded-r-full"
                    style={{
                        width: `${segment.widthPercent}%`,
                        ...(segment.kind === 'buffer'
                            ? {
                                backgroundColor: 'transparent',
                                backgroundImage: `repeating-linear-gradient(135deg, ${segment.color} 0 1.5px, transparent 1.5px 4px)`,
                                opacity: 0.6,
                            }
                            : { backgroundColor: segment.color }),
                    }}
                />
            ))}
        </div>
    );
};

const LimitRow: React.FC<{ window: UsageWindow; now: number }> = ({ window: usageWindow, now }) => {
    const { t } = useI18n();
    const percent = usageWindowPercent(usageWindow);
    const tone = usageWindowTone(usageWindow);
    const reset = formatUsageReset(usageWindow.resetsAt, now);
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
                className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]"
            >
                <div className="h-full rounded-full transition-[width]" style={{ width: `${percent}%`, backgroundColor: TONE_COLOR[tone] }} />
            </div>
            {reset ? <div className="typography-micro text-muted-foreground">{reset}</div> : null}
        </div>
    );
};

const DetailRow: React.FC<{ row: ContextDetailRow }> = ({ row }) => (
    <li className="flex items-center gap-2 py-0.5" data-context-category={row.id}>
        <span
            aria-hidden="true"
            className="h-2 w-2 flex-shrink-0 rounded-full"
            style={row.kind === 'buffer'
                ? { backgroundImage: `repeating-linear-gradient(135deg, ${row.color} 0 1.5px, transparent 1.5px 3px)`, border: `1px solid ${row.color}` }
                : { backgroundColor: row.color, border: row.kind === 'free' ? '1px solid var(--border)' : undefined }}
        />
        <span className="typography-meta min-w-0 flex-1 truncate text-foreground">{row.label}</span>
        <span className="typography-meta flex-shrink-0 tabular-nums text-muted-foreground">{formatContextTokens(row.tokens)}</span>
        <span className="typography-micro w-10 flex-shrink-0 text-right tabular-nums text-muted-foreground">{formatContextPercent(row.percentOfMax)}</span>
    </li>
);

const Breakdown: React.FC<{ usage: ContextUsage }> = ({ usage }) => {
    const { t } = useI18n();
    const detail = React.useMemo(() => buildContextDetail(usage), [usage]);
    const [openSections, setOpenSections] = React.useState<Record<string, boolean>>({});
    return (
        <div className="space-y-3">
            <ul className="space-y-0.5">
                {detail.window.map((row) => <DetailRow key={row.id} row={row} />)}
            </ul>
            {detail.deferred.length > 0 ? (
                <div className="space-y-1">
                    <div className="typography-micro uppercase tracking-wide text-muted-foreground/80">{t('contextUsage.popover.deferred')}</div>
                    <ul className="space-y-0.5">
                        {detail.deferred.map((row) => <DetailRow key={row.id} row={row} />)}
                    </ul>
                </div>
            ) : null}
            {usage.autocompactEnabled && usage.autocompactThresholdTokens ? (
                <div className="typography-micro text-muted-foreground">
                    {t('contextUsage.popover.autocompact', { tokens: formatContextTokens(usage.autocompactThresholdTokens) })}
                </div>
            ) : null}
            {usage.sections && usage.sections.length > 0 ? (
                <div className="space-y-0.5 border-t border-border/40 pt-2">
                    {usage.sections.map((section) => {
                        const open = Boolean(openSections[section.id]);
                        const total = section.items.reduce((sum, item) => sum + item.tokens, 0);
                        const listId = `context-section-${section.id}`;
                        return (
                            <div key={section.id}>
                                <button
                                    type="button"
                                    className="flex w-full items-center gap-1.5 rounded py-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                                    aria-expanded={open}
                                    aria-controls={listId}
                                    onClick={() => setOpenSections((previous) => ({ ...previous, [section.id]: !previous[section.id] }))}
                                >
                                    {open
                                        ? <RiArrowDownSLine className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                                        : <RiArrowRightSLine className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" aria-hidden="true" />}
                                    <span className="typography-meta min-w-0 flex-1 truncate text-foreground">{section.label}</span>
                                    <span className="typography-meta flex-shrink-0 tabular-nums text-muted-foreground">{formatContextTokens(total)}</span>
                                </button>
                                {open ? (
                                    <ul id={listId} className="mb-1 ml-5 space-y-0.5">
                                        {section.items.map((item) => (
                                            <li key={`${item.name}-${item.detail ?? ''}`} className="flex items-baseline gap-2">
                                                <span className="typography-micro min-w-0 flex-1 truncate text-foreground/80" title={item.name}>
                                                    {item.name}
                                                    {item.detail ? <span className="ml-1.5 text-muted-foreground">{item.detail}</span> : null}
                                                </span>
                                                <span className="typography-micro flex-shrink-0 tabular-nums text-muted-foreground">{formatContextTokens(item.tokens)}</span>
                                            </li>
                                        ))}
                                    </ul>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            ) : null}
            {usage.source === 'estimate' ? (
                <div className="typography-micro text-muted-foreground/80">{t('contextUsage.popover.estimated')}</div>
            ) : null}
        </div>
    );
};

interface ContextUsagePopoverProps {
    /** Session whose context is shown (the focused subagent session while one is expanded). */
    sessionId: string | null;
    /** Static estimate used until the host reports `Session.contextUsage` (and for sessions without it). */
    fallback: { percentage: number; totalTokens: number; totalCost?: number };
    ariaLabel: string;
}

const formatFallbackTokens = (tokens: number): string => formatContextTokens(tokens);

const formatFallbackCost = (cost: number | undefined): string => {
    if (!cost || !Number.isFinite(cost) || cost <= 0) return '$0.00';
    return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
};

/**
 * Header ring with a Claude-desktop style popover: context window summary + segmented bar, plan usage limits
 * (hidden for API-key users) and a detailed breakdown. The host pushes `Session.contextUsage` after every turn;
 * opening the popover asks for a fresh measurement and re-reads the plan limits (throttled).
 */
export const ContextUsagePopover: React.FC<ContextUsagePopoverProps> = ({ sessionId, fallback, ariaLabel }) => {
    const { t } = useI18n();
    const session = useSession(sessionId);
    const limits = useUsageLimits();
    const [open, setOpen] = React.useState(false);
    const [view, setView] = React.useState<'summary' | 'detail'>('summary');
    const [fresh, setFresh] = React.useState<{ sessionId: string; usage: ContextUsage } | null>(null);
    const [portalContainer, setPortalContainer] = React.useState<HTMLElement | null>(null);
    const triggerRef = React.useRef<HTMLButtonElement | null>(null);
    const [now, setNow] = React.useState(() => Date.now());

    const pushed = session?.contextUsage;
    const measured = fresh && fresh.sessionId === sessionId ? fresh.usage : undefined;
    const usage = measured && (!pushed || measured.updatedAt >= pushed.updatedAt) ? measured : pushed ?? measured;

    const handleOpenChange = React.useCallback((next: boolean) => {
        setOpen(next);
        if (!next) {
            setView('summary');
            return;
        }
        const startedAt = Date.now();
        setNow(startedAt);
        if (sessionId) {
            void claudeClient.contextUsage(sessionId)
                .then((result) => setFresh({ sessionId, usage: result }))
                .catch(() => undefined);
        }
        if (shouldRefreshUsage(getUsage()?.updatedAt, startedAt)) {
            void claudeClient.refreshUsage().then((result) => setUsage(result)).catch(() => undefined);
        }
    }, [sessionId]);

    // Reset times tick while the popover is open.
    React.useEffect(() => {
        if (!open) return;
        const timer = window.setInterval(() => setNow(Date.now()), 30_000);
        return () => window.clearInterval(timer);
    }, [open]);

    const percent = usage ? usage.percent : fallback.percentage;
    const clamped = Math.max(0, Math.min(100, percent));
    const degrees = clamped * 3.6;
    const tooltip = usage
        ? formatContextSummary(usage)
        : t('contextUsage.dropdown.summary', {
            tokens: formatFallbackTokens(fallback.totalTokens),
            percent: `${Math.round(fallback.percentage)}%`,
            cost: formatFallbackCost(fallback.totalCost),
        });

    const syncPortalContainer = () => {
        setPortalContainer((triggerRef.current?.closest('[data-slot="dialog-content"], [role="dialog"]') as HTMLElement | null) ?? null);
    };

    return (
        <Popover.Root open={open} onOpenChange={handleOpenChange}>
            <Tooltip delayDuration={400}>
                <TooltipTrigger asChild>
                    <Popover.Trigger
                        render={
                            <button
                                ref={triggerRef}
                                type="button"
                                aria-label={`${ariaLabel}: ${tooltip}`}
                                className="app-region-no-drag inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                                onPointerDownCapture={syncPortalContainer}
                                onFocusCapture={syncPortalContainer}
                            >
                                <span
                                    className="relative block h-4 w-4 rounded-full"
                                    style={{ background: `conic-gradient(${ringColor(clamped)} ${degrees}deg, var(--surface-subtle) ${degrees}deg 360deg)` }}
                                >
                                    <span className="absolute inset-[3px] rounded-full bg-[var(--surface-background)]" />
                                </span>
                            </button>
                        }
                    />
                </TooltipTrigger>
                {!open ? <TooltipContent>{tooltip}</TooltipContent> : null}
            </Tooltip>
            <Popover.Portal container={portalContainer || undefined}>
                <Popover.Positioner side="bottom" align="end" sideOffset={6} collisionPadding={8}>
                    <Popover.Popup
                        className={popoverClassName}
                        style={popoverStyle}
                        data-context-usage-popover
                    >
                        {!usage ? (
                            <div className="space-y-2">
                                <div className="typography-ui-label text-foreground">{tooltip}</div>
                                <div className="typography-micro text-muted-foreground">{t('contextUsage.popover.noData')}</div>
                            </div>
                        ) : view === 'detail' ? (
                            <div className="space-y-3">
                                <button
                                    type="button"
                                    className="flex w-full items-center gap-1 rounded text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                                    onClick={() => setView('summary')}
                                    aria-label={t('contextUsage.popover.backAria')}
                                >
                                    <RiArrowLeftSLine className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden="true" />
                                    <span className="typography-ui-label min-w-0 flex-1 truncate font-medium text-foreground">{t('contextUsage.popover.title')}</span>
                                    <span className="typography-meta flex-shrink-0 tabular-nums text-muted-foreground">{formatContextSummary(usage)}</span>
                                </button>
                                <ContextBar usage={usage} label={t('contextUsage.popover.barAria')} />
                                <Breakdown usage={usage} />
                            </div>
                        ) : (
                            <div className="space-y-3">
                                <button
                                    type="button"
                                    className="flex w-full items-center justify-between gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                                    onClick={() => setView('detail')}
                                    aria-label={t('contextUsage.popover.detailsAria')}
                                >
                                    <span className="typography-ui-label font-medium text-foreground">{t('contextUsage.popover.title')}</span>
                                    <span className="typography-meta flex items-center gap-0.5 tabular-nums text-muted-foreground">
                                        {formatContextSummary(usage)}
                                        <RiArrowRightSLine className="h-4 w-4" aria-hidden="true" />
                                    </span>
                                </button>
                                <ContextBar usage={usage} label={t('contextUsage.popover.barAria')} />
                                {usage.source === 'estimate' ? (
                                    <div className="typography-micro text-muted-foreground/80">{t('contextUsage.popover.estimated')}</div>
                                ) : null}

                                {hasUsageLimits(limits) ? (
                                    <div className="space-y-2.5 border-t border-border/40 pt-3" data-usage-limits>
                                        <div className="typography-ui-label font-medium text-foreground">
                                            {limits.plan
                                                ? t('contextUsage.popover.limitsTitlePlan', { plan: limits.plan })
                                                : t('contextUsage.popover.limitsTitle')}
                                        </div>
                                        {limits.windows.map((window) => <LimitRow key={window.id} window={window} now={now} />)}
                                    </div>
                                ) : null}

                                <Button
                                    type="button"
                                    variant="outline"
                                    size="xs"
                                    className={cn('w-full !font-normal normal-case')}
                                    onClick={() => setView('detail')}
                                >
                                    {t('contextUsage.popover.seeDetails')}
                                </Button>
                            </div>
                        )}
                    </Popover.Popup>
                </Popover.Positioner>
            </Popover.Portal>
        </Popover.Root>
    );
};
