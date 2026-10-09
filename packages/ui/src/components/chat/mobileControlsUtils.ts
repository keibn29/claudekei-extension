import type { Agent } from '@/lib/claude/types';
import { getCatalog } from '@/lib/claude/bootstrapCache';

export type MobileControlsPanel = 'model' | 'agent' | 'variant' | null;

export const isPrimaryMode = (mode?: string) => mode === 'primary' || mode === 'all' || mode === undefined || mode === null;

export const capitalizeLabel = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/**
 * Formats an agent/subagent name for display:
 * "business-analyst" → "Business Analyst"
 * Handles hyphen-separated names by splitting on hyphens,
 * capitalizing each word, and joining with spaces.
 */
export const formatAgentName = (name: string): string => {
    if (!name || name.trim().length === 0) return name;
    // Plugin agents are namespaced (`claudekei:orchestrator`): show only the agent part.
    const bare = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
    return bare
        .split('-')
        .map((part) => capitalizeLabel(part))
        .join(' ');
};

/** Label for an agent: the host-provided display name, else the formatted agent type. */
export const agentLabel = (agent: Pick<Agent, 'name' | 'displayName'>): string =>
    agent.displayName?.trim() || formatAgentName(agent.name);

/** Default main agent: the catalog default when it is a primary agent, else the first primary agent. */
export const getDefaultAgent = (agents: Agent[]): Agent | undefined => {
    const primary = agents.filter((agent) => isPrimaryMode(agent.mode));
    const wanted = getCatalog()?.defaults.agent;
    return primary.find((agent) => agent.name === wanted) ?? primary[0];
};

export const getAgentDisplayName = (agents: Agent[], agentName?: string) => {
    if (agentName) {
        const agent = agents.find((entry) => entry.name === agentName);
        return agent ? agentLabel(agent) : formatAgentName(agentName);
    }

    const fallbackAgent = getDefaultAgent(agents) || agents[0];
    return fallbackAgent ? agentLabel(fallbackAgent) : 'Select agent';
};

type ProviderModel = { id?: string; name?: string };

export const getModelDisplayName = (
    provider: { models?: ProviderModel[] } | undefined,
    modelId: string | undefined,
) => {
    if (!provider || !modelId) {
        return 'Not selected';
    }
    const models = Array.isArray(provider.models) ? provider.models : [];
    const model = models.find((entry) => entry.id === modelId);
    if (typeof model?.name === 'string' && model.name.trim().length > 0) {
        return model.name;
    }
    if (typeof model?.id === 'string' && model.id.trim().length > 0) {
        return model.id;
    }
    return modelId;
};

export const formatEffortLabel = (variant?: string) => {
    if (!variant || variant.trim().length === 0) {
        return 'Default';
    }
    const trimmed = variant.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
        return trimmed;
    }
    return capitalizeLabel(trimmed);
};

export const DEFAULT_EFFORT_KEY = 'default';

export const serializeEffortVariant = (variant?: string) => {
    const trimmed = typeof variant === 'string' ? variant.trim() : '';
    return trimmed.length > 0 ? trimmed : DEFAULT_EFFORT_KEY;
};

export const parseEffortVariant = (variant: string) => {
    return variant === DEFAULT_EFFORT_KEY ? undefined : variant;
};

const EFFORT_RANKS: Record<string, number> = {
    max: 6,
    maximum: 6,
    xhigh: 5,
    high: 4,
    medium: 3,
    default: 2,
    low: 1,
    min: 0,
    minimal: 0,
};

export const getEffortRank = (variant?: string) => {
    if (!variant || variant.trim().length === 0) {
        return EFFORT_RANKS.default;
    }
    const normalized = variant.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(EFFORT_RANKS, normalized)) {
        return EFFORT_RANKS[normalized];
    }
    const numeric = Number.parseFloat(normalized);
    return Number.isFinite(numeric) ? numeric : 0;
};

export const getQuickEffortOptions = (variants: string[]) => {
    const options = new Map<string, string | undefined>();
    options.set('default', undefined);
    for (const variant of variants) {
        options.set(variant, variant);
    }

    const ordered = Array.from(options.values()).sort((a, b) => getEffortRank(b) - getEffortRank(a));
    if (ordered.length <= 4) {
        return ordered;
    }

    const top = ordered.slice(0, 3);
    const lowest = ordered[ordered.length - 1];
    if (top.some((item) => item === lowest)) {
        return top;
    }
    return [...top, lowest];
};
