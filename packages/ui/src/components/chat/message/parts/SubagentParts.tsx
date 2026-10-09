import React from 'react';
import {
    RiAiAgentLine,
    RiCheckLine,
    RiCloseCircleLine,
    RiExternalLinkLine,
    RiFileCopyLine,
    RiLinkUnlinkM,
    RiLoader4Line,
    RiMessage2Line,
    RiSendPlaneLine,
    RiStopCircleLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { getAgentColor } from '@/lib/agentColors';
import { getToolMetadata } from '@/lib/toolHelpers';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { copyTextToClipboard } from '@/lib/clipboard';
import {
    INSTRUCTION_FULL_TEXT_CHARS,
    formatSubagentElapsed,
    formatSubagentTokens,
    getSubagentStepLabel,
    formatSubagentAction,
    isActiveSubagentStatus,
    shouldCollapseInstruction,
    shouldShowNoActivityHint,
    type SubagentStatus,
} from '@/lib/claude/subagents';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import type { ToolPopupContent } from '../types';
import { getToolIcon } from './toolPresentation';
import { useDurationTickerNow } from './useDurationTicker';
import { useSubagentOpen } from './useSubagentUi';
import type { SubagentInfo } from './useSubagentInfo';

const STATUS_COLOR: Partial<Record<SubagentStatus, string>> = {
    done: 'var(--status-success)',
    sent: 'var(--status-success)',
    failed: 'var(--status-error)',
    'not-delivered': 'var(--status-error)',
};

/** Verb/title and kind icon shared by the card header and the compact group rows. */
export const SubagentKindIcon: React.FC<{ kind: SubagentInfo['kind']; className?: string }> = ({ kind, className }) =>
    kind === 'message'
        ? <RiSendPlaneLine className={className} aria-hidden="true" />
        : <RiAiAgentLine className={className} aria-hidden="true" />;

/** Agent-colored type chip (same `agent-badge` classes as the assistant message header). Never truncates. */
export const SubagentTypeChip: React.FC<{ info: Pick<SubagentInfo, 'typeLabel' | 'colorKey'> }> = ({ info }) => {
    const { t } = useI18n();
    return (
        <span
            className={cn(
                'agent-badge typography-micro inline-flex flex-shrink-0 items-center rounded px-1.5 font-medium leading-4',
                getAgentColor(info.colorKey).class,
            )}
        >
            {info.typeLabel || t('chat.subagent.fallbackType')}
        </span>
    );
};

export const SubagentAlias: React.FC<{ alias?: string }> = ({ alias }) => {
    if (!alias) return null;
    return (
        <span className="typography-micro min-w-0 truncate font-mono text-muted-foreground" title={alias}>
            {alias}
        </span>
    );
};

/** Elapsed time. Purely visual (`aria-hidden`): status changes are announced by the card's live region instead. */
export const SubagentElapsed: React.FC<{ info: Pick<SubagentInfo, 'status' | 'startedAt' | 'endedAt'> }> = ({ info }) => {
    const active = isActiveSubagentStatus(info.status);
    const now = useDurationTickerNow(active && info.status === 'running', 1000);
    if (typeof info.startedAt !== 'number') return null;
    const end = info.endedAt ?? now;
    return (
        <span aria-hidden="true" className="tabular-nums">
            {formatSubagentElapsed(end - info.startedAt, !active)}
        </span>
    );
};

/** Right-edge status: icon shape + text, never color alone. */
export const SubagentStatusGlyph: React.FC<{ info: Pick<SubagentInfo, 'status' | 'startedAt' | 'endedAt'> }> = ({ info }) => {
    const { t } = useI18n();
    const { status } = info;
    const iconClass = 'h-3.5 w-3.5 flex-shrink-0';
    let icon: React.ReactNode;
    let label: React.ReactNode;

    switch (status) {
        case 'preparing':
            icon = <RiLoader4Line className={cn(iconClass, 'animate-spin motion-reduce:animate-none')} />;
            label = t('chat.subagent.status.starting');
            break;
        case 'running':
            icon = <RiLoader4Line className={cn(iconClass, 'animate-spin motion-reduce:animate-none')} />;
            label = <SubagentElapsed info={info} />;
            break;
        case 'done':
            icon = <RiCheckLine className={iconClass} />;
            label = <SubagentElapsed info={info} />;
            break;
        case 'sent':
            icon = <RiCheckLine className={iconClass} />;
            label = t('chat.subagent.status.sent');
            break;
        case 'failed':
            icon = <RiCloseCircleLine className={iconClass} />;
            label = t('chat.subagent.status.failed');
            break;
        case 'not-delivered':
            icon = <RiCloseCircleLine className={iconClass} />;
            label = t('chat.subagent.status.notDelivered');
            break;
        case 'stopped':
            icon = <RiStopCircleLine className={iconClass} />;
            label = t('chat.subagent.status.stopped');
            break;
        default:
            icon = <RiLinkUnlinkM className={iconClass} />;
            label = t('chat.subagent.status.noSession');
    }

    return (
        <span
            className="typography-micro inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap text-muted-foreground"
            style={{ color: STATUS_COLOR[status] }}
            data-subagent-status={status}
        >
            <span aria-hidden="true" className="inline-flex">{icon}</span>
            {label}
        </span>
    );
};

/** "Open <Type> (alias) session" full-width link. Disabled with a tooltip while there is no child session. */
export const SubagentOpenButton: React.FC<{ info: SubagentInfo }> = ({ info }) => {
    const { t } = useI18n();
    const { open, canOpen, label } = useSubagentOpen(info);
    return (
        <button
            type="button"
            className={cn(
                'flex w-full items-center gap-2 typography-meta text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded',
                !canOpen && 'cursor-not-allowed opacity-60 hover:text-primary',
            )}
            aria-disabled={!canOpen}
            title={canOpen ? label : t('chat.subagent.unlinkedTooltip')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
                event.stopPropagation();
                if (canOpen) open();
            }}
        >
            <RiExternalLinkLine className="h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
            <span className="typography-meta min-w-0 truncate font-medium">{label}</span>
        </button>
    );
};

/**
 * Instructions / Message block: markdown with a 4-line preview and Show more / Show less. Copy button top right;
 * very long text also offers the full-text dialog.
 */
export const SubagentInstructionBlock: React.FC<{
    /** Optional eyebrow row (child session: `FROM ORCHESTRATOR · #2`). Without it the copy button floats top right. */
    label?: React.ReactNode;
    text: string;
    popupTitle: string;
    onShowPopup?: (content: ToolPopupContent) => void;
    onContentChange?: () => void;
    /** Extra action aligned to the right of the Show more row (child session: "View in <Parent>"). */
    footerAction?: React.ReactNode;
    className?: string;
    /** Tailwind `from-*` class matching the surface behind the collapsed fade. */
    fadeClass?: string;
}> = ({ label, text, popupTitle, onShowPopup, onContentChange, footerAction, className, fadeClass = 'from-background' }) => {
    const { t } = useI18n();
    const collapsible = shouldCollapseInstruction(text);
    const [expanded, setExpanded] = React.useState(false);
    const [copied, setCopied] = React.useState(false);
    const copiedTimer = React.useRef<number | null>(null);
    const isCollapsed = collapsible && !expanded;

    React.useEffect(() => () => {
        if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    }, []);

    const handleCopy = async (event: React.MouseEvent) => {
        event.stopPropagation();
        const result = await copyTextToClipboard(text);
        if (!result.ok) return;
        setCopied(true);
        if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
    };

    return (
        <div className={cn('space-y-1', className)}>
            {label ? (
                <div className="flex items-start justify-between gap-2">
                    <span className="typography-micro min-w-0 text-muted-foreground/80">{label}</span>
                    <button
                        type="button"
                        className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                        aria-label={t('chat.subagent.copy')}
                        title={t('chat.subagent.copy')}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={handleCopy}
                    >
                        {copied
                            ? <RiCheckLine className="h-3.5 w-3.5 text-[color:var(--status-success)]" />
                            : <RiFileCopyLine className="h-3.5 w-3.5" />}
                    </button>
                </div>
            ) : null}
            <div className="relative">
                {!label ? <div className="absolute right-0 top-0 z-10">
                <button
                    type="button"
                    className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                    aria-label={t('chat.subagent.copy')}
                    title={t('chat.subagent.copy')}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={handleCopy}
                >
                    {copied
                        ? <RiCheckLine className="h-3.5 w-3.5 text-[color:var(--status-success)]" />
                        : <RiFileCopyLine className="h-3.5 w-3.5" />}
                </button>
                </div> : null}
                <div
                    className={cn(
                        'relative typography-meta text-foreground/90',
                        !label && 'pr-7',
                        isCollapsed && 'max-h-[5.5rem] overflow-hidden',
                        collapsible && expanded && 'max-h-[40vh] overflow-y-auto',
                    )}
                >
                    <SimpleMarkdownRenderer content={text} variant="tool" />
                    {isCollapsed ? (
                        <div aria-hidden="true" className={cn('pointer-events-none absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t to-transparent', fadeClass)} />
                    ) : null}
                </div>
            </div>
            {collapsible || footerAction || (text.length > INSTRUCTION_FULL_TEXT_CHARS && onShowPopup) ? (
                <div className="flex items-center gap-3">
                    {collapsible ? (
                        <button
                            type="button"
                            className="typography-micro text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded"
                            aria-expanded={expanded}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                event.stopPropagation();
                                setExpanded((previous) => !previous);
                                onContentChange?.();
                            }}
                        >
                            {expanded ? t('inlineComment.actions.showLess') : t('inlineComment.actions.showMore')}
                        </button>
                    ) : null}
                    {text.length > INSTRUCTION_FULL_TEXT_CHARS && onShowPopup ? (
                        <button
                            type="button"
                            className="typography-micro text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                event.stopPropagation();
                                onShowPopup({ open: true, title: popupTitle, content: text, metadata: { tool: 'task' } });
                            }}
                        >
                            {t('chat.subagent.openFullText')}
                        </button>
                    ) : null}
                    {footerAction ? <div className="ml-auto">{footerAction}</div> : null}
                </div>
            ) : null}
        </div>
    );
};

export const SubagentToolCount: React.FC<{ count?: number; tokens?: number }> = ({ count, tokens }) => {
    const { t } = useI18n();
    const parts: string[] = [];
    if (typeof count === 'number' && count > 0) {
        parts.push(count === 1 ? t('chat.subagent.tools.one') : t('chat.subagent.tools.many', { count }));
    }
    if (typeof tokens === 'number' && tokens > 0) {
        parts.push(t('chat.subagent.tokens', { count: formatSubagentTokens(tokens) }));
    }
    if (parts.length === 0) return null;
    return <span className="typography-micro flex-shrink-0 whitespace-nowrap text-muted-foreground">{parts.join(' · ')}</span>;
};

/** Third header line while running: current step + tool count. */
export const SubagentPeekLine: React.FC<{ info: SubagentInfo }> = ({ info }) => {
    const step = info.currentStep;
    if (!step) return null;
    const toolName = (step.tool || 'tool').toLowerCase();
    const label = getSubagentStepLabel(step);
    return (
        <div className="flex min-w-0 items-center gap-2 pl-5 typography-micro text-muted-foreground" data-subagent-peek>
            <span aria-hidden="true">→</span>
            <span className="min-w-0 flex-1 truncate">
                <span style={{ color: 'var(--tools-title)' }}>{getToolMetadata(toolName).displayName}</span>
                {label ? <span className="ml-1.5" style={{ color: 'var(--tools-description)' }}>{label}</span> : null}
            </span>
            <SubagentToolCount count={info.toolCount} />
        </div>
    );
};

/** Last actions of the run (tool calls and text snippets), newest last; a spinner marks the one in progress. */
export const SubagentActivityList: React.FC<{ info: SubagentInfo; className?: string }> = ({ info, className }) => {
    const { t } = useI18n();
    const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
    if (info.status === 'not-delivered' || info.status === 'preparing') return null;
    if (info.activity.length === 0 && !shouldShowNoActivityHint(info.status)) return null;

    const relative = (value: string): string => {
        const base = currentDirectory ? (currentDirectory.endsWith('/') ? currentDirectory : `${currentDirectory}/`) : '';
        return base && value.startsWith(base) ? value.slice(base.length) : value;
    };

    return (
        <div className={cn('min-w-0 space-y-0.5', className)} data-subagent-activity>
            {info.activity.length === 0 ? (
                <div className="typography-meta text-muted-foreground/70">{t('chat.subagent.activity.none')}</div>
            ) : info.activity.map((item) => {
                const icon = item.active
                    ? <RiLoader4Line className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                    : item.kind === 'text'
                        ? <RiMessage2Line className="h-3.5 w-3.5" />
                        : getToolIcon((item.tool ?? 'tool').toLowerCase());
                const action = item.kind === 'tool' ? formatSubagentAction(item) : null;
                const failed = item.status === 'error';
                return (
                    <div key={item.id} className="flex min-w-0 items-center gap-2" data-subagent-activity-item={item.kind}>
                        <span className="flex-shrink-0 text-muted-foreground" aria-hidden="true">{icon}</span>
                        {action ? (
                            <span
                                className="typography-meta min-w-0 truncate"
                                style={{ color: failed ? 'var(--status-error)' : 'var(--tools-description)' }}
                                title={`${action.verb} ${relative(action.detail)}`.trim()}
                            >
                                <span className="font-medium" style={{ color: failed ? 'var(--status-error)' : 'var(--tools-title)' }}>{action.verb}</span>
                                {action.detail ? <span className="ml-1.5">{relative(action.detail)}</span> : null}
                            </span>
                        ) : (
                            <span className="typography-meta min-w-0 truncate italic text-muted-foreground" title={item.text}>
                                {item.text}
                            </span>
                        )}
                    </div>
                );
            })}
        </div>
    );
};
