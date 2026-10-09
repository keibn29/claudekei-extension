import React from 'react';
import { useI18n } from '@/lib/i18n';
import { getAgentColor } from '@/lib/agentColors';
import { useConfigStore } from '@/stores/useConfigStore';
import { findAgentByType } from '@/lib/claude/subagents';
import { agentLabel, formatAgentName } from '../mobileControlsUtils';

/**
 * Transcript marker above the first user message sent after a main-agent switch
 * (docs/PHASE1_1_UI_SPEC.md 2.5): `--- • Switched to Planner ---` / `Claude restarted · history kept`.
 */
const AgentSwitchDivider: React.FC<{ to: string }> = ({ to }) => {
    const { t } = useI18n();
    const agents = useConfigStore((state) => state.agents);
    const agent = findAgentByType(agents, to);
    const label = agent ? agentLabel(agent) : formatAgentName(to);
    const color = `var(${getAgentColor(agent?.name ?? to).var})`;
    // Keep the translated word order: split the sentence around the (colored) agent name.
    const [before, after = ''] = t('chat.agentSwitch.divider', { agent: '\u0000' }).split('\u0000');

    return (
        <div className="chat-message-column py-3" role="separator" aria-label={t('chat.agentSwitch.divider', { agent: label })} data-agent-switch-divider>
            <div className="flex items-center gap-3">
                <span aria-hidden="true" className="h-px flex-1 bg-border/40" />
                <div className="flex flex-col items-center typography-micro text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
                        <span>
                            {before}
                            <span className="font-medium" style={{ color }}>{label}</span>
                            {after}
                        </span>
                    </span>
                    <span className="text-muted-foreground/70">{t('chat.agentSwitch.dividerHint')}</span>
                </div>
                <span aria-hidden="true" className="h-px flex-1 bg-border/40" />
            </div>
        </div>
    );
};

export default AgentSwitchDivider;
