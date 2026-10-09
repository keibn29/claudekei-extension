import React from 'react';

/**
 * Describes the session being viewed when it is a subagent child session. Provided by `ChatContainer` so message
 * rows can render instruction blocks without each subscribing to the sync store.
 */
export type SubagentSessionContextValue = {
    isChild: boolean;
    parentSessionId: string | null;
    /** Parent's main agent type (`claudekei:orchestrator`), when known. */
    parentAgent?: string;
    /** Display name for the parent agent (`Orchestrator`, or `main agent`). */
    parentLabel: string;
    /** Key for `getAgentColor`. */
    parentColorKey: string;
    /** 1-based instruction number per child user message id (fallback when the host sets no `instruction`). */
    instructionIndex: ReadonlyMap<string, number>;
    /** Switch to the parent session, optionally jumping to the originating tool call. */
    openParent: (target?: { toolCallId: string; messageId?: string }) => void;
};

export const SubagentSessionContext = React.createContext<SubagentSessionContextValue | null>(null);

export const useSubagentSession = (): SubagentSessionContextValue | null => React.useContext(SubagentSessionContext);
