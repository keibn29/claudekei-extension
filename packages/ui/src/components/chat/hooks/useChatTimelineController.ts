import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';
import type { MessageListHandle } from '../MessageList';
import {
    buildTurnWindowModel,
    updateTurnWindowModelIncremental,
    type TurnWindowModel,
} from '../lib/turns/windowTurns';

interface UseChatTimelineControllerOptions {
    sessionId: string | null;
    messages: ChatMessageEntry[];
    messageListRef: React.RefObject<MessageListHandle | null>;
    prepareForBottomResume: (options?: { instant?: boolean; force?: boolean }) => void;
    scrollToBottom: (options?: { instant?: boolean; force?: boolean; followBottom?: boolean }) => void;
    releasePinnedScroll: () => void;
    isPinned: boolean;
    isOverflowing: boolean;
}

export interface UseChatTimelineControllerResult {
    turnIds: string[];
    renderedMessages: ChatMessageEntry[];
    activeTurnId: string | null;
    showScrollToBottom: boolean;
    resumeToBottom: () => void;
    resumeToBottomInstant: () => void;
    scrollToTurn: (turnId: string) => Promise<boolean>;
    scrollToMessage: (messageId: string) => Promise<boolean>;
    handleActiveTurnChange: (turnId: string | null) => void;
}

export const useChatTimelineController = ({
    sessionId,
    messages,
    messageListRef,
    prepareForBottomResume,
    scrollToBottom,
    releasePinnedScroll,
    isPinned,
    isOverflowing,
}: UseChatTimelineControllerOptions): UseChatTimelineControllerResult => {
    const previousTurnWindowModelRef = React.useRef<TurnWindowModel | null>(null);
    const previousMessagesRef = React.useRef<ChatMessageEntry[] | null>(null);
    const turnWindowModel = React.useMemo(() => {
        const incrementalModel = updateTurnWindowModelIncremental(
            previousTurnWindowModelRef.current,
            previousMessagesRef.current,
            messages,
        );
        const nextModel = incrementalModel ?? buildTurnWindowModel(messages);
        previousTurnWindowModelRef.current = nextModel;
        previousMessagesRef.current = messages;
        return nextModel;
    }, [messages]);

    const [activeTurnId, setActiveTurnId] = React.useState<string | null>(null);

    const turnModelRef = React.useRef(turnWindowModel);
    turnModelRef.current = turnWindowModel;

    React.useEffect(() => {
        setActiveTurnId(null);
    }, [sessionId]);

    const scrollToTurn = React.useCallback(async (turnId: string): Promise<boolean> => {
        if (!turnId || !turnModelRef.current.turnIndexById.has(turnId)) {
            return false;
        }

        releasePinnedScroll();
        const didScroll = messageListRef.current?.scrollToTurnId(turnId) ?? false;
        if (didScroll) {
            setActiveTurnId(turnId);
        }
        return didScroll;
    }, [messageListRef, releasePinnedScroll]);

    const scrollToMessage = React.useCallback(async (messageId: string): Promise<boolean> => {
        const turnId = messageId ? turnModelRef.current.messageToTurnId.get(messageId) : undefined;
        if (!turnId) {
            return false;
        }

        releasePinnedScroll();
        const didScroll = messageListRef.current?.scrollToMessageId(messageId) ?? false;
        if (didScroll) {
            setActiveTurnId(turnId);
        }
        return didScroll;
    }, [messageListRef, releasePinnedScroll]);

    const resumeToBottom = React.useCallback(() => {
        prepareForBottomResume({ force: true });
        scrollToBottom({ force: true });
    }, [prepareForBottomResume, scrollToBottom]);

    const resumeToBottomInstant = React.useCallback(() => {
        prepareForBottomResume({ instant: true, force: true });
        scrollToBottom({ instant: true, force: true, followBottom: true });
    }, [prepareForBottomResume, scrollToBottom]);

    const handleActiveTurnChange = React.useCallback((turnId: string | null) => {
        setActiveTurnId(turnId);
    }, []);

    return {
        turnIds: turnWindowModel.turnIds,
        renderedMessages: messages,
        activeTurnId,
        showScrollToBottom: isOverflowing && !isPinned,
        resumeToBottom,
        resumeToBottomInstant,
        scrollToTurn,
        scrollToMessage,
        handleActiveTurnChange,
    };
};
