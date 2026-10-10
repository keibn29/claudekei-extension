/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Part } from "@/lib/claude/types";
import { isFullySyntheticMessage } from "@/lib/messages/synthetic";

export interface MessageInfo {
    id: string;
    role: string;
    time?: {
        created?: number;
        completed?: number;
    };
    status?: string;
    streaming?: boolean;
    finish?: string;
}

export interface MessageRecord {
    info: MessageInfo & Record<string, any>;
    parts: Part[];
}

// Finish reasons that mean the assistant message ended and will not be continued within the turn.
// 'stop' is the legacy value; the Claude host reports Anthropic stop_reason values. 'tool_use' and
// 'pause_turn' mean more assistant output follows, so they are intentionally excluded.
// 'max_tokens' and 'refusal' end the turn as well (nothing continues after them).
const TURN_END_FINISH_REASONS: ReadonlySet<string> = new Set([
    'stop',
    'end_turn',
    'stop_sequence',
    'max_tokens',
    'refusal',
]);

export function isTurnEndFinish(finish: string | null | undefined): boolean {
    return typeof finish === 'string' && TURN_END_FINISH_REASONS.has(finish);
}

export function isMessageComplete(messageInfo: MessageInfo, parts: Part[] = []): boolean {
    if (isFullySyntheticMessage(parts)) {
        return true;
    }

    const timeInfo = messageInfo?.time ?? {};
    const completedAt = typeof timeInfo?.completed === 'number' ? timeInfo.completed : undefined;
    const messageStatus = messageInfo?.status;

    const hasStopFinish = isTurnEndFinish(messageInfo.finish);

    const hasCompletedFlag = (typeof completedAt === 'number' && completedAt > 0) || messageStatus === 'completed';
    if (!hasCompletedFlag || !hasStopFinish) {
        return false;
    }

    const hasActiveTools = parts.some((part) => {
        switch (part.type) {
            case 'reasoning': {
                const time = (part as any)?.time;
                return !time || typeof time.end === 'undefined';
            }
            case 'tool': {
                const status = (part as any)?.state?.status;
                return status === 'running' || status === 'pending';
            }
            default:
                return false;
        }
    });

    return !hasActiveTools;
}

export function getLatestAssistantMessageId(messages: MessageRecord[]): string | null {
    const assistantMessages = messages
        .filter(msg => msg.info.role === 'assistant' && !isFullySyntheticMessage(msg.parts))
        .sort((a, b) => (a.info.id || "").localeCompare(b.info.id || ""));

    return assistantMessages.length > 0
        ? assistantMessages[assistantMessages.length - 1].info.id
        : null;
}

export function hasAnimatingWork(messages: MessageRecord[]): boolean {
    if (messages.length === 0) {
        return false;
    }

    for (const message of messages) {
        if (message.info.role !== 'assistant') {
            continue;
        }

        if (isFullySyntheticMessage(message.parts)) {
            continue;
        }

        if (!isMessageComplete(message.info, message.parts)) {
            return true;
        }
    }

    return false;
}

export function shouldContinueStreaming(
    messages: MessageRecord[],
    currentStreamingId: string | null
): boolean {
    const latestId = getLatestAssistantMessageId(messages);
    if (!latestId) {
        return false;
    }

    if (currentStreamingId && currentStreamingId !== latestId) {
        return true;
    }

    const latestMessage = messages.find(
        (msg) => msg.info.id === latestId && !isFullySyntheticMessage(msg.parts)
    );
    if (!latestMessage) {
        return false;
    }

    return !isMessageComplete(latestMessage.info, latestMessage.parts);
}
