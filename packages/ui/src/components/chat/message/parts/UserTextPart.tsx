import React from 'react';
import { cn } from '@/lib/utils';
import type { Part } from '@/lib/claude/types';
import type { AgentMentionInfo } from '../types';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { findMentionRanges, looksLikeFilePath } from '../../composer/mentions';
import { useCurrentSessionIsSubtask } from '@/hooks/useCurrentSessionIsSubtask';

type PartWithText = Part & { text?: string; content?: string; value?: string };

type UserTextPartProps = {
    part: Part;
    messageId: string;
    isMobile: boolean;
    agentMention?: AgentMentionInfo;
};

const buildMentionUrl = (name: string): string => {
    const encoded = encodeURIComponent(name);
    return `https://opencode.ai/docs/agents/#${encoded}`;
};

const normalizeUserMessageRenderingMode = (mode: unknown): 'markdown' | 'plain' => {
    return mode === 'markdown' ? 'markdown' : 'plain';
};

const UserTextPart: React.FC<UserTextPartProps> = ({ part, messageId, agentMention }) => {
    const partWithText = part as PartWithText;
    const rawText = partWithText.text;
    const textContent = typeof rawText === 'string' ? rawText : partWithText.content || partWithText.value || '';

    const userMessageRenderingMode = useUIStore((state) => state.userMessageRenderingMode);
    const normalizedRenderingMode = normalizeUserMessageRenderingMode(userMessageRenderingMode);
    const isCurrentSessionSubtask = useCurrentSessionIsSubtask();
    const shouldForcePlainRendering = isCurrentSessionSubtask;
    const shouldRenderMarkdown = normalizedRenderingMode === 'markdown' && !shouldForcePlainRendering;

    const agents = useConfigStore((state) => state.agents);
    const knownAgentNames = React.useMemo(
        () => new Set(agents.map((agent) => agent.name.toLowerCase())),
        [agents],
    );
    const getMentionRanges = React.useCallback(
        (text: string) => findMentionRanges(text, (name) => knownAgentNames.has(name), looksLikeFilePath),
        [knownAgentNames],
    );
    const userMarkdownOptions = React.useMemo(
        () => ({
            getMentionRanges,
            agentMention: agentMention?.token
                ? { token: agentMention.token, href: buildMentionUrl(agentMention.name) }
                : undefined,
        }),
        [agentMention, getMentionRanges],
    );

    const plainTextContent = React.useMemo(() => {
        if (!agentMention?.token || !textContent.includes(agentMention.token)) {
            return textContent;
        }

        const idx = textContent.indexOf(agentMention.token);
        const before = textContent.slice(0, idx);
        const after = textContent.slice(idx + agentMention.token.length);
        return (
            <>
                {before}
                <a
                    href={buildMentionUrl(agentMention.name)}
                    className="text-primary hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => event.stopPropagation()}
                >
                    {agentMention.token}
                </a>
                {after}
            </>
        );
    }, [agentMention, textContent]);

    if (!textContent || textContent.trim().length === 0) {
        return null;
    }

    return (
        <div className="relative" key={part.id || `${messageId}-user-text`}>
            <div
                className={cn(
                    "break-words font-sans typography-markdown",
                    (normalizedRenderingMode === 'plain' || shouldForcePlainRendering) && 'whitespace-pre-wrap',
                )}
            >
                {shouldRenderMarkdown ? (
                    <SimpleMarkdownRenderer
                        content={textContent}
                        variant="user"
                        userOptions={userMarkdownOptions}
                        disableLinkSafety
                    />
                ) : (
                    plainTextContent
                )}
            </div>
        </div>
    );
};

export default React.memo(UserTextPart);
