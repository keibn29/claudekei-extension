import React from 'react';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useDirectorySync } from '@/sync/sync-context';
import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
    derivePendingAgentSwitch,
    findLatestUserAgent,
    hasUserMessage,
    type AgentSwitchState,
} from '@/lib/claude/agentSwitch';

/** Delay before a mismatch counts as a pending switch: lets the session-restore effect settle after a session change. */
const PENDING_SETTLE_MS = 150;

export type AgentSwitchUiState = AgentSwitchState & {
    sessionId: string | null;
    /** Agent chosen in the composer (what the next send uses). */
    selectedAgent?: string;
    /** Agent that ran the last message of the session. */
    appliedAgent?: string;
    sessionStarted: boolean;
};

/**
 * Option B agent switching (docs/PHASE1_1_UI_SPEC.md 2.3): in a started session the composer's agent may differ from
 * the agent that ran the last message; that difference is the pending switch the notice and the agent chip show.
 */
export const useAgentSwitchState = (): AgentSwitchUiState => {
    const sessionId = useSessionUIStore((state) => state.currentSessionId);
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const savedSelection = useSelectionStore((state) => (sessionId ? state.sessionAgentSelections.get(sessionId) ?? null : null));
    const appliedAgent = useDirectorySync(
        React.useCallback((state) => (sessionId ? findLatestUserAgent(state.message[sessionId]) : undefined), [sessionId]),
    );
    const sessionStarted = useDirectorySync(
        React.useCallback((state) => (sessionId ? hasUserMessage(state.message[sessionId]) : false), [sessionId]),
    );
    const { isWorking } = useCurrentSessionActivity();

    const selectedAgent = (sessionId ? savedSelection || currentAgentName : currentAgentName) || undefined;
    const derived = derivePendingAgentSwitch({ sessionStarted, selectedAgent, appliedAgent, busy: isWorking });

    const key = derived.pending ? `${derived.from}>${derived.to}` : '';
    const settledKey = useDebouncedValue(key, PENDING_SETTLE_MS);
    const visible = key !== '' && key === settledKey;

    return {
        pending: visible,
        from: visible ? derived.from : undefined,
        to: visible ? derived.to : undefined,
        deferred: visible && derived.deferred,
        sessionId,
        selectedAgent,
        appliedAgent,
        sessionStarted,
    };
};
