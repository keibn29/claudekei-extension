import React from 'react';
import { RiArrowDownSLine, RiArrowRightSLine, RiExternalLinkLine, RiStackLine } from '@remixicon/react';
import type { ToolPart } from '@/lib/claude/types';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import {
    formatSubagentElapsed,
    shouldGroupStartExpanded,
    summarizeSubagentStatuses,
    type SubagentStatus,
} from '@/lib/claude/subagents';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';
import type { ToolPopupContent } from '../types';
import {
    SubagentAlias,
    SubagentKindIcon,
    SubagentPeekLine,
    SubagentStatusGlyph,
    SubagentTypeChip,
} from './SubagentParts';
import { SubagentBody, SubagentLiveRegion } from './SubagentCard';
import { useSubagentAriaLabel, useSubagentEffects, useSubagentOpen } from './useSubagentUi';
import { useDurationTickerNow } from './useDurationTicker';
import { useSubagentInfo, type SubagentInfo } from './useSubagentInfo';

type MemberReport = { status: SubagentStatus; startedAt?: number; endedAt?: number };

interface SubagentGroupProps {
    parts: ToolPart[];
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    onShowPopup?: (content: ToolPopupContent) => void;
}

interface RowProps {
    part: ToolPart;
    isExpanded: boolean;
    onToggle: (toolId: string) => void;
    onReport: (callId: string, report: MemberReport) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    onShowPopup?: (content: ToolPopupContent) => void;
}

const OpenIconButton: React.FC<{ info: SubagentInfo }> = ({ info }) => {
    const { t } = useI18n();
    const { open, canOpen, label } = useSubagentOpen(info);
    return (
        <button
            type="button"
            className={cn(
                'inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground',
                'hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                !canOpen && 'cursor-not-allowed opacity-40 hover:text-muted-foreground',
            )}
            aria-label={label}
            aria-disabled={!canOpen}
            title={canOpen ? label : t('chat.subagent.unlinkedTooltip')}
            onClick={(event) => {
                event.stopPropagation();
                if (canOpen) open();
            }}
        >
            <RiExternalLinkLine className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
    );
};

/** One compact line (24px): chip, alias, description, status. Expands inline into the full card body. */
const SubagentRow: React.FC<RowProps> = ({ part, isExpanded, onToggle, onReport, onContentChange, onShowPopup }) => {
    const info = useSubagentInfo(part);
    const ariaLabel = useSubagentAriaLabel(info);
    const bodyId = `subagent-body-${part.id}`;
    useSubagentEffects(info, isExpanded, onContentChange);

    const { callId, status, startedAt, endedAt } = info;
    React.useEffect(() => {
        onReport(callId, { status, startedAt, endedAt });
    }, [callId, endedAt, onReport, startedAt, status]);

    return (
        <li data-subagent-call={callId} data-subagent-kind={info.kind} className="min-w-0">
            <div className="flex min-h-6 items-center gap-1">
                <button
                    type="button"
                    className="group/row flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-0.5 pr-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                    aria-expanded={isExpanded}
                    aria-controls={bodyId}
                    aria-label={ariaLabel}
                    onClick={() => onToggle(part.id)}
                >
                    <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true">
                        {isExpanded ? <RiArrowDownSLine className="h-3.5 w-3.5" /> : (
                            info.kind === 'message'
                                ? <SubagentKindIcon kind="message" className="h-3 w-3" />
                                : <RiArrowRightSLine className="h-3.5 w-3.5" />
                        )}
                    </span>
                    <SubagentTypeChip info={info} />
                    <SubagentAlias alias={info.alias} />
                    <span
                        className="typography-meta min-w-0 flex-1 truncate"
                        style={{ color: status === 'failed' || status === 'not-delivered' ? 'var(--status-error)' : 'var(--tools-description)' }}
                        title={info.description}
                    >
                        {info.description}
                    </span>
                    <SubagentStatusGlyph info={info} />
                </button>
                <OpenIconButton info={info} />
            </div>
            {!isExpanded && status === 'running' ? <div className="pr-7"><SubagentPeekLine info={info} /></div> : null}
            {isExpanded ? (
                <SubagentBody id={bodyId} info={info} onShowPopup={onShowPopup} onContentChange={onContentChange} />
            ) : null}
            <SubagentLiveRegion info={info} />
        </li>
    );
};

/**
 * Parallel grouping: 2+ adjacent `Agent` / `SendMessage` parts in one turn render as one collapsible group with
 * running / done / failed counters and one compact row per call (call order, never re-sorted by status).
 */
const SubagentGroup: React.FC<SubagentGroupProps> = ({ parts, expandedTools, onToggleTool, onContentChange, onShowPopup }) => {
    const { t } = useI18n();
    const [reports, setReports] = React.useState<Record<string, MemberReport>>({});
    const [userExpanded, setUserExpanded] = React.useState<boolean | null>(null);
    const headingId = React.useId();
    const listId = React.useId();

    const handleReport = React.useCallback((callId: string, report: MemberReport) => {
        setReports((previous) => {
            const current = previous[callId];
            if (current && current.status === report.status && current.startedAt === report.startedAt && current.endedAt === report.endedAt) {
                return previous;
            }
            return { ...previous, [callId]: report };
        });
    }, []);

    const statuses = parts.map((part) => reports[part.callID]?.status ?? 'running');
    const counts = summarizeSubagentStatuses(statuses);
    const expanded = userExpanded ?? shouldGroupStartExpanded(counts);

    const starts = parts.map((part) => reports[part.callID]?.startedAt).filter((value): value is number => typeof value === 'number');
    const ends = parts.map((part) => reports[part.callID]?.endedAt).filter((value): value is number => typeof value === 'number');
    const firstStart = starts.length > 0 ? Math.min(...starts) : undefined;
    const running = counts.running > 0;
    const now = useDurationTickerNow(running, 1000);
    const lastEnd = ends.length > 0 ? Math.max(...ends) : undefined;
    const elapsed = typeof firstStart === 'number'
        ? formatSubagentElapsed((running ? now : (lastEnd ?? now)) - firstStart)
        : undefined;

    const onContentChangeRef = React.useRef(onContentChange);
    onContentChangeRef.current = onContentChange;
    React.useEffect(() => {
        onContentChangeRef.current?.('structural');
    }, [expanded]);

    const summary = [
        counts.running > 0 ? t('chat.subagent.group.running', { count: counts.running }) : null,
        counts.done > 0 ? t('chat.subagent.group.done', { count: counts.done }) : null,
        counts.failed > 0 ? t('chat.subagent.group.failed', { count: counts.failed }) : null,
    ].filter(Boolean).join(' · ');

    return (
        <div role="group" aria-labelledby={headingId} data-subagent-group>
            <button
                type="button"
                className="group/tool flex w-full items-center gap-1.5 rounded-xl py-2 pl-px pr-2 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                aria-expanded={expanded}
                aria-controls={listId}
                onClick={() => setUserExpanded(!expanded)}
            >
                <span className="relative h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--tools-icon)' }} aria-hidden="true">
                    <span className={cn('absolute inset-0 transition-opacity', expanded ? 'opacity-0' : 'group-hover/tool:opacity-0')}>
                        <RiStackLine className="h-3.5 w-3.5" />
                    </span>
                    <span className={cn('absolute inset-0 flex items-center justify-center transition-opacity', expanded ? 'opacity-100' : 'opacity-0 group-hover/tool:opacity-100')}>
                        {expanded ? <RiArrowDownSLine className="h-3.5 w-3.5" /> : <RiArrowRightSLine className="h-3.5 w-3.5" />}
                    </span>
                </span>
                <span id={headingId} className="typography-meta flex-shrink-0 font-medium" style={{ color: 'var(--tools-title)' }}>
                    {t('chat.subagent.group.title', { count: parts.length })}
                </span>
                <span className="typography-micro min-w-0 flex-1 truncate text-muted-foreground" data-subagent-group-summary>
                    {summary}
                </span>
                {elapsed ? <span aria-hidden="true" className="typography-micro flex-shrink-0 tabular-nums text-muted-foreground">{elapsed}</span> : null}
            </button>
            <div hidden={!expanded} className={cn('relative ml-2 pb-1 pl-3', !expanded && 'hidden')}>
                <span aria-hidden="true" className="pointer-events-none absolute bottom-0 left-0 top-px w-px" style={{ backgroundColor: 'var(--tools-border)' }} />
                <ul id={listId} className="space-y-0.5">
                    {parts.map((part) => (
                        <SubagentRow
                            key={part.id}
                            part={part}
                            isExpanded={expandedTools.has(part.id)}
                            onToggle={onToggleTool}
                            onReport={handleReport}
                            onContentChange={onContentChange}
                            onShowPopup={onShowPopup}
                        />
                    ))}
                </ul>
            </div>
        </div>
    );
};

export default React.memo(SubagentGroup);
