import React from 'react';
import { RiArrowGoBackLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { getAgentColor } from '@/lib/agentColors';
import { useConfigStore } from '@/stores/useConfigStore';
import { findAgentByType } from '@/lib/claude/subagents';
import { useAgentSwitchState } from './hooks/useAgentSwitchState';
import { useComposerModel } from './hooks/useComposerModel';
import { agentLabel, formatAgentName } from './mobileControlsUtils';

const useAgentLabel = (name: string | undefined): string => {
    const agents = useConfigStore((state) => state.agents);
    if (!name) return '';
    const agent = findAgentByType(agents, name);
    return agent ? agentLabel(agent) : formatAgentName(name);
};

/**
 * Pending main-agent switch, shown next to the composer: `Next message → Planner · restarts Claude, keeps history`
 * with Undo (docs/PHASE1_1_UI_SPEC.md 2.3, Option B). A sibling visually-hidden live region announces agent
 * changes politely: `Agent: Planner` in a new session, the consequence in a started one.
 */
export const PendingAgentSwitchNotice: React.FC = () => {
    const { t } = useI18n();
    const setAgent = useConfigStore((state) => state.setAgent);
    const state = useAgentSwitchState();
    // The model/effort the switched agent will run with (its defaults are already reflected in the chip).
    const modelChip = useComposerModel().chipText;
    const toLabel = useAgentLabel(state.to);
    const selectedLabel = useAgentLabel(state.selectedAgent);
    const fromLabel = useAgentLabel(state.from);
    const [announcement, setAnnouncement] = React.useState('');

    // Announce user-driven agent changes only: skip the first value and session changes.
    const previousRef = React.useRef<{ sessionId: string | null; agent?: string }>({ sessionId: state.sessionId, agent: state.selectedAgent });
    React.useEffect(() => {
        const previous = previousRef.current;
        previousRef.current = { sessionId: state.sessionId, agent: state.selectedAgent };
        if (previous.sessionId !== state.sessionId || previous.agent === state.selectedAgent || !state.selectedAgent) return;
        if (!state.sessionStarted) {
            setAnnouncement(t('chat.agentSwitch.announce.draft', { agent: selectedLabel }));
        } else if (state.appliedAgent && state.selectedAgent === state.appliedAgent) {
            setAnnouncement(t('chat.agentSwitch.announce.undone', { agent: selectedLabel }));
        } else {
            setAnnouncement(t('chat.agentSwitch.announce.pending', { agent: selectedLabel }));
        }
    }, [selectedLabel, state.appliedAgent, state.selectedAgent, state.sessionId, state.sessionStarted, t]);

    const color = `var(${getAgentColor(state.to).var})`;

    return (
        <>
            <span className="sr-only" role="status" aria-live="polite" data-agent-announcer>{announcement}</span>
            {state.pending ? (
                <div data-agent-switch-pending>
                <div className={cn('flex min-w-0 items-start gap-1.5 px-1 pb-1.5 typography-micro text-muted-foreground')}>
                    <span aria-hidden="true" className="mt-[5px] h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ backgroundColor: color }} />
                    <span className="min-w-0">
                        <span className="font-medium" style={{ color }}>
                            {state.deferred
                                ? t('chat.agentSwitch.pendingBusyLabel', { agent: toLabel })
                                : t('chat.agentSwitch.pendingLabel', { agent: toLabel })}
                        </span>
                        {modelChip ? <span>{' · '}{modelChip}</span> : null}
                        <span>
                            {' · '}
                            {state.deferred ? t('chat.agentSwitch.pendingBusyHint') : t('chat.agentSwitch.pendingHint')}
                        </span>
                    </span>
                    <button
                        type="button"
                        className="ml-auto inline-flex flex-shrink-0 items-center gap-1 rounded px-1 py-0.5 text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                        aria-label={t('chat.agentSwitch.undoAria', { agent: fromLabel })}
                        onClick={() => {
                            if (state.from) setAgent(state.from);
                        }}
                    >
                        <RiArrowGoBackLine className="h-3 w-3" aria-hidden="true" />
                        {t('chat.agentSwitch.undo')}
                    </button>
                </div>
                </div>
            ) : null}
        </>
    );
};
