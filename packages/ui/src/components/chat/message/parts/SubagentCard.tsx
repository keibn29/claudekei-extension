import React from 'react';
import { RiArrowDownSLine, RiArrowRightSLine } from '@remixicon/react';
import type { ToolPart } from '@/lib/claude/types';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { isActiveSubagentStatus } from '@/lib/claude/subagents';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';
import type { ToolPopupContent } from '../types';
import { MinDurationShineText } from './MinDurationShineText';
import {
    SubagentActivityList,
    SubagentAlias,
    SubagentInstructionBlock,
    SubagentKindIcon,
    SubagentOpenButton,
    SubagentStatusGlyph,
    SubagentToolCount,
    SubagentTypeChip,
} from './SubagentParts';
import { subagentTitle, useSubagentAriaLabel, useSubagentEffects, useSubagentTitle } from './useSubagentUi';
import { useSubagentInfo, type SubagentInfo } from './useSubagentInfo';

export interface SubagentCardProps {
    part: ToolPart;
    isExpanded: boolean;
    onToggle: (toolId: string) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    onShowPopup?: (content: ToolPopupContent) => void;
    animateTailText?: boolean;
}

/**
 * Announces status transitions only (`Explorer exp-1 finished` / `failed` / `stopped`). Elapsed counters and
 * progress lines are never live. Renders nothing until a transition happens.
 */
export const SubagentLiveRegion: React.FC<{ info: SubagentInfo }> = ({ info }) => {
    const { t } = useI18n();
    const [message, setMessage] = React.useState('');
    const previousRef = React.useRef(info.status);
    const name = [info.typeLabel, info.alias].filter(Boolean).join(' ') || t('chat.subagent.fallbackType');

    React.useEffect(() => {
        const previous = previousRef.current;
        previousRef.current = info.status;
        if (previous === info.status || !isActiveSubagentStatus(previous)) return;
        if (info.status === 'done' || info.status === 'sent') setMessage(t('chat.subagent.announce.finished', { agent: name }));
        else if (info.status === 'failed' || info.status === 'not-delivered') setMessage(t('chat.subagent.announce.failed', { agent: name }));
        else if (info.status === 'stopped') setMessage(t('chat.subagent.announce.stopped', { agent: name }));
    }, [info.status, name, t]);

    return <span className="sr-only" role="status" aria-live="polite">{message}</span>;
};

/**
 * Expanded body, top to bottom: message text, last actions, open-session link, reply. No section labels:
 * spacing and hairlines separate the parts.
 */
export const SubagentBody: React.FC<{
    id: string;
    info: SubagentInfo;
    onShowPopup?: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    className?: string;
}> = ({ id, info, onShowPopup, onContentChange, className }) => {
    const { t } = useI18n();
    const replyText = info.error ? undefined : (info.reply ?? info.toolOutput);
    const handleContentChange = React.useCallback(() => onContentChange?.('structural'), [onContentChange]);
    const popupTitle = `${subagentTitle(t, info.kind)} ${info.typeLabel}`.trim();

    return (
        <div
            id={id}
            className={cn(
                'relative space-y-2 pb-2 pl-[1.4375rem] pr-2 pt-2',
                'before:absolute before:bottom-0 before:left-[0.4375rem] before:top-[-0.25rem] before:w-px before:bg-border/80 before:content-[""]',
                className,
            )}
        >
            {info.instruction ? (
                <SubagentInstructionBlock
                    text={info.instruction}
                    popupTitle={popupTitle}
                    onShowPopup={onShowPopup}
                    onContentChange={handleContentChange}
                />
            ) : null}
            <SubagentActivityList info={info} className="border-t border-border/40 pt-2" />
            {info.error ? (
                <div
                    className="typography-meta rounded-xl border p-2"
                    style={{
                        backgroundColor: 'var(--status-error-background)',
                        color: 'var(--status-error)',
                        borderColor: 'var(--status-error-border)',
                    }}
                >
                    {info.error}
                </div>
            ) : null}
            {info.status !== 'not-delivered' ? <SubagentOpenButton info={info} /> : null}
            {replyText ? (
                <SubagentInstructionBlock
                    className="border-t border-border/40 pt-2"
                    text={replyText}
                    popupTitle={popupTitle}
                    onShowPopup={onShowPopup}
                    onContentChange={handleContentChange}
                />
            ) : null}
        </div>
    );
};

/** Second/third header lines of the card: description and the SendMessage live state. */
const SubagentLines: React.FC<{ info: SubagentInfo }> = ({ info }) => {
    const { t } = useI18n();
    const active = info.status === 'running';
    const type = info.typeLabel || t('chat.subagent.fallbackType');
    const failedText = info.status === 'failed' || info.status === 'not-delivered' ? info.error : undefined;
    const description = failedText ? failedText.split('\n')[0] : info.description;

    // The last-actions list sits under the card, so only the SendMessage state needs its own line.
    let thirdLine: React.ReactNode = null;
    if (info.kind === 'message' && active) {
        thirdLine = (
            <div className="flex min-w-0 items-center gap-2 pl-5 typography-micro text-muted-foreground">
                <span className="min-w-0 flex-1 truncate">{t('chat.subagent.live.working', { type })}</span>
                <SubagentToolCount count={info.runMatched ? info.toolCount : undefined} />
            </div>
        );
    } else if (info.kind === 'message' && info.status === 'sent' && info.reply) {
        thirdLine = (
            <div className="pl-5 typography-micro text-muted-foreground">{t('chat.subagent.live.replied', { type })}</div>
        );
    }

    return (
        <>
            {description ? (
                <div
                    className="min-w-0 truncate pl-5 typography-meta text-muted-foreground"
                    style={failedText ? { color: 'var(--status-error)' } : undefined}
                    title={description}
                >
                    {info.kind === 'message' && !failedText && info.instruction === description ? `"${description}"` : description}
                </div>
            ) : null}
            {thirdLine}
        </>
    );
};

/**
 * Flat tool-row card for `Agent` (`task`) and `SendMessage` (`sendmessage`) parts
 * (docs/PHASE1_1_UI_SPEC.md 1.2): identity first (type chip + alias), description second, status at the right edge,
 * current step while running, expandable body.
 */
const SubagentCard: React.FC<SubagentCardProps> = ({ part, isExpanded, onToggle, onContentChange, onShowPopup, animateTailText = true }) => {
    const info = useSubagentInfo(part);
    const title = useSubagentTitle(info.kind);
    const ariaLabel = useSubagentAriaLabel(info);
    const bodyId = `subagent-body-${part.id}`;
    useSubagentEffects(info, isExpanded, onContentChange);
    void animateTailText;

    const active = isActiveSubagentStatus(info.status);
    const toggle = () => onToggle(part.id);
    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggle();
    };

    return (
        <div className="@container" data-subagent-call={info.callId} data-subagent-kind={info.kind}>
            <div
                className="group/tool flex cursor-pointer flex-col gap-0.5 rounded-xl py-2 pl-px pr-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                role="button"
                tabIndex={0}
                aria-expanded={isExpanded}
                aria-controls={bodyId}
                aria-label={ariaLabel}
                onClick={toggle}
                onKeyDown={handleKeyDown}
            >
                <div className="flex min-w-0 items-center gap-1.5">
                    <div className="relative h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                        <div className={cn('absolute inset-0 transition-opacity', isExpanded && 'opacity-0', !isExpanded && 'group-hover/tool:opacity-0')}>
                            <SubagentKindIcon kind={info.kind} className="h-3.5 w-3.5" />
                        </div>
                        <div
                            aria-hidden="true"
                            className={cn(
                                'absolute inset-0 flex items-center justify-center transition-opacity',
                                isExpanded ? 'opacity-100' : 'opacity-0 group-hover/tool:opacity-100',
                            )}
                        >
                            {isExpanded ? <RiArrowDownSLine className="h-3.5 w-3.5" /> : <RiArrowRightSLine className="h-3.5 w-3.5" />}
                        </div>
                    </div>
                    <MinDurationShineText
                        active={active}
                        minDurationMs={300}
                        className="typography-meta hidden flex-shrink-0 font-medium @min-[340px]:inline"
                        style={{ color: 'var(--tools-title)' }}
                        title={title}
                    >
                        {title}
                    </MinDurationShineText>
                    <SubagentTypeChip info={info} />
                    <div className="flex min-w-0 flex-1 items-center">
                        <SubagentAlias alias={info.alias} />
                    </div>
                    <SubagentStatusGlyph info={info} />
                </div>
                <SubagentLines info={info} />
            </div>

            {isExpanded ? (
                <SubagentBody id={bodyId} info={info} onShowPopup={onShowPopup} onContentChange={onContentChange} />
            ) : (
                // Last 5 actions stay visible under the collapsed card, live while the child streams.
                <div id={bodyId} className="pb-1 pl-5 pr-2">
                    <SubagentActivityList info={info} />
                </div>
            )}
            <SubagentLiveRegion info={info} />
        </div>
    );
};

export default SubagentCard;
