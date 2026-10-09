import React from 'react';
import { RiArrowUpLine } from '@remixicon/react';
import type { UserMessage } from '@/lib/claude/types';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { getAgentColor } from '@/lib/agentColors';
import { useConfigStore } from '@/stores/useConfigStore';
import { findAgentByType } from '@/lib/claude/subagents';
import { agentLabel, formatAgentName } from '../mobileControlsUtils';
import { SubagentInstructionBlock } from './parts/SubagentParts';
import { useSubagentSession } from './SubagentSessionContext';
import { formatTimestampForDisplay } from './timeFormat';
import type { ToolPopupContent } from './types';

interface InstructionMessageProps {
    messageId: string;
    info: UserMessage;
    text: string;
    onShowPopup?: (content: ToolPopupContent) => void;
    onContentChange?: () => void;
}

/**
 * A user message inside a subagent child session is an instruction from the parent agent, not something the user
 * typed: left-aligned block with a 2px border in the parent agent's color, eyebrow `FROM <AGENT> · #n Follow-up`
 * and a jump back to the parent tool call (docs/PHASE1_1_UI_SPEC.md 1.6).
 */
const InstructionMessage: React.FC<InstructionMessageProps> = ({ messageId, info, text, onShowPopup, onContentChange }) => {
    const { t } = useI18n();
    const session = useSubagentSession();
    const agents = useConfigStore((state) => state.agents);
    const instruction = info.instruction;

    const index = instruction?.index ?? session?.instructionIndex.get(messageId) ?? 1;
    const kind = instruction?.kind ?? (index === 1 ? 'initial' : 'followup');
    const fromAgent = instruction?.fromAgent ?? session?.parentAgent;
    const catalogAgent = findAgentByType(agents, fromAgent);
    const fromLabel = catalogAgent
        ? agentLabel(catalogAgent)
        : (fromAgent ? formatAgentName(fromAgent) : (session?.parentLabel ?? t('chat.subagent.child.mainAgent')));
    const colorKey = catalogAgent?.name ?? fromAgent ?? session?.parentColorKey ?? 'primary';
    const colorVar = getAgentColor(colorKey).var;
    const kindLabel = kind === 'initial' ? t('chat.subagent.child.initialTask') : t('chat.subagent.child.followUp');
    const time = formatTimestampForDisplay(info.time.created);
    const parentLabel = session?.parentLabel ?? fromLabel;

    const eyebrow = (
        <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">
            <span className="font-medium normal-case" style={{ color: `var(${colorVar})` }}>
                {t('chat.subagent.child.from', { agent: fromLabel })}
            </span>
            <span aria-hidden="true">·</span>
            <span className="normal-case">#{index} {kindLabel}</span>
            {time ? <span className="normal-case tabular-nums">{time}</span> : null}
        </span>
    );

    const canJump = Boolean(instruction?.toolCallID && session);
    const jump = canJump ? (
        <button
            type="button"
            className={cn(
                'inline-flex items-center gap-1 typography-micro text-primary hover:text-primary/80',
                'rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary',
            )}
            onClick={() => session?.openParent({ toolCallId: instruction!.toolCallID, messageId: instruction!.fromMessageID })}
        >
            <RiArrowUpLine className="h-3 w-3" aria-hidden="true" />
            {t('chat.subagent.child.viewInParent', { parent: parentLabel })}
        </button>
    ) : null;

    // Same geometry as the user's own sent messages: right aligned, max 85%, width follows the content.
    return (
        <article
            role="article"
            tabIndex={-1}
            aria-label={t('chat.subagent.child.instructionAria', { index, agent: fromLabel })}
            data-instruction-id={messageId}
            className="my-2 flex justify-end focus-visible:outline-none [&:focus-visible>div]:ring-1 [&:focus-visible>div]:ring-primary"
        >
            <div
                className="min-w-0 max-w-[85%] border px-3 py-1.5 shadow-none"
                style={{
                    backgroundColor: 'var(--chat-user-message-bg)',
                    borderRadius: 'var(--radius-xl)',
                    borderBottomRightRadius: 'var(--radius-sm)',
                    borderColor: `color-mix(in srgb, var(${colorVar}) 22%, transparent)`,
                }}
            >
                <SubagentInstructionBlock
                    label={eyebrow}
                    text={text}
                    popupTitle={`${t('chat.subagent.child.from', { agent: fromLabel })} #${index}`}
                    onShowPopup={onShowPopup}
                    onContentChange={onContentChange}
                    footerAction={jump}
                    fadeClass="from-[var(--chat-user-message-bg)]"
                />
            </div>
        </article>
    );
};

export default InstructionMessage;
