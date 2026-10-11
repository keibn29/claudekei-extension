import React from 'react';
import type { ToolPart } from '@/lib/claude/types';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { firstLine, isActiveSubagentStatus } from '@/lib/claude/subagents';
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
import { subagentTitle, useSubagentEffects, useSubagentTitle } from './useSubagentUi';
import { useSubagentInfo, type SubagentInfo } from './useSubagentInfo';

export interface SubagentCardProps {
    part: ToolPart;
    onContentChange?: (reason?: ContentChangeReason) => void;
    onShowPopup?: (content: ToolPopupContent) => void;
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
 * Expanded body, top to bottom: last actions, open-session link, reply (hidden behind a toggle). No section labels:
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
    // Hide the reply (toggle and expanded output) while the subagent is working, including follow-up runs.
    const replyText = info.error || isActiveSubagentStatus(info.status) ? undefined : (info.reply ?? info.toolOutput);
    const handleContentChange = React.useCallback(() => onContentChange?.('structural'), [onContentChange]);
    const [showOutput, setShowOutput] = React.useState(false);
    const outputId = `${id}-output`;
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
            <SubagentActivityList info={info} />
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
                <div className="border-t border-border/40 pt-2">
                    <button
                        type="button"
                        className="typography-micro rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                        aria-expanded={showOutput}
                        aria-controls={outputId}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            event.stopPropagation();
                            setShowOutput((previous) => !previous);
                            handleContentChange();
                        }}
                    >
                        {showOutput ? t('chat.subagent.output.hide') : t('chat.subagent.output.show')}
                    </button>
                    {showOutput ? (
                        <SubagentInstructionBlock
                            id={outputId}
                            scrollable
                            className="mt-1"
                            text={replyText}
                            popupTitle={popupTitle}
                            onShowPopup={onShowPopup}
                            onContentChange={handleContentChange}
                        />
                    ) : null}
                </div>
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
    // The description falls back to the first line of the prompt; never surface the prompt in the header.
    const isPromptFallback = !failedText && Boolean(info.description) && info.description === firstLine(info.instruction);
    const description = failedText ? failedText.split('\n')[0] : (isPromptFallback ? undefined : info.description);

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
                    {description}
                </div>
            ) : null}
            {thirdLine}
        </>
    );
};

/**
 * Standalone tool-row card for `Agent` (`task`) and `SendMessage` (`sendmessage`) parts
 * (docs/PHASE1_1_UI_SPEC.md 1.2): identity first (type chip + alias), description second, status at the right edge,
 * body always shown (last actions, open-session link, output toggle). Not collapsible; parallel calls render as
 * collapsible rows inside `SubagentGroup` instead.
 */
const SubagentCard: React.FC<SubagentCardProps> = ({ part, onContentChange, onShowPopup }) => {
    const info = useSubagentInfo(part);
    const title = useSubagentTitle(info.kind);
    const bodyId = `subagent-body-${part.id}`;
    useSubagentEffects(info, true, onContentChange);

    const active = isActiveSubagentStatus(info.status);

    return (
        <div className="@container" data-subagent-call={info.callId} data-subagent-kind={info.kind}>
            <div className="flex flex-col gap-0.5 rounded-xl py-2 pl-px pr-2">
                <div className="flex min-w-0 items-center gap-1.5">
                    <div className="h-3.5 w-3.5 flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                        <SubagentKindIcon kind={info.kind} className="h-3.5 w-3.5" />
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
            <SubagentBody id={bodyId} info={info} onShowPopup={onShowPopup} onContentChange={onContentChange} />
            <SubagentLiveRegion info={info} />
        </div>
    );
};

export default SubagentCard;
