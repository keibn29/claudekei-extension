import React from 'react';
import { getCatalog, subscribeBootstrapCache } from '@/lib/claude/bootstrapCache';
import { resolveComposerEffort, useDraftEffortStore } from '@/lib/claude/effort';
import { formatModelChip, resolveModelLabel, supportedEffortLevels } from '@/lib/claude/modelNames';
import type { Catalog, EffortLevel, ModelInfo } from '@/lib/claude/types';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession } from '@/sync/sync-context';
import { useAgentSwitchState } from './useAgentSwitchState';

/** Reactive catalog snapshot (`catalog.updated` keeps it current). */
export const useCatalog = (): Catalog | null => React.useSyncExternalStore(subscribeBootstrapCache, getCatalog, getCatalog);

export type ComposerModelState = {
    sessionId: string | null;
    /** Selected `ModelInfo.value` (session choice, else the composer's). */
    selectedModel?: string;
    modelInfo?: ModelInfo;
    /** Catalog models (for callers that need other entries than the selected one). */
    catalogModels?: readonly ModelInfo[];
    /** Friendly name of the model (`Opus 5.5`). */
    label: string;
    /** Selected effort; `null` = model default. */
    effort: EffortLevel | null;
    /** Levels to offer for the selected model. */
    effortChoices: readonly EffortLevel[];
    /** Footer chip text (`Opus 5.5 · High`). */
    chipText: string;
};

/**
 * What the composer footer shows for model and effort. Existing sessions follow the host (`Session.model`,
 * `Session.resolvedModel`, `Session.effort`, refreshed on `session.updated`); drafts use the local choice and the
 * selected agent's defaults.
 */
export const useComposerModel = (): ComposerModelState => {
    const sessionId = useSessionUIStore((state) => state.currentSessionId);
    const session = useSession(sessionId);
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const draftEffort = useDraftEffortStore((state) => state.draftEffort);
    const catalog = useCatalog();
    const { selectedAgent } = useAgentSwitchState();

    const models = catalog?.models;
    const selectedModel = (sessionId ? session?.model : undefined) ?? currentModelId ?? undefined;
    const modelInfo = React.useMemo(() => models?.find((model) => model.value === selectedModel), [models, selectedModel]);
    const label = React.useMemo(
        () => resolveModelLabel({ selected: selectedModel, resolved: sessionId ? session?.resolvedModel : undefined, models: models ?? [] }),
        [models, selectedModel, session?.resolvedModel, sessionId],
    );

    const agentInfo = selectedAgent ? catalog?.primaryAgents.find((agent) => agent.name === selectedAgent) : undefined;
    const effort = resolveComposerEffort({
        hasSession: Boolean(sessionId),
        sessionEffort: session?.effort,
        draftEffort,
        agentDefaultEffort: agentInfo?.defaultEffort,
        catalogDefaultEffort: catalog?.defaults.effort,
    });
    const effortChoices = supportedEffortLevels(modelInfo);
    // Models without effort support never show a level, even if one was stored.
    const shownEffort = effortChoices.length > 0 ? effort : null;

    return {
        sessionId,
        selectedModel,
        modelInfo,
        catalogModels: models,
        label,
        effort: shownEffort,
        effortChoices,
        chipText: formatModelChip(label, shownEffort),
    };
};
