import React from 'react';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useContextStore } from '@/stores/contextStore';
import { useUIStore } from '@/stores/useUIStore';
import { useModelLists } from '@/hooks/useModelLists';
import { useEffortControl } from './hooks/useEffortControl';
import { setSessionModel } from '@/sync/session-actions';
import { effortLabel } from '@/lib/claude/modelNames';
import type { EffortLevel } from '@/lib/claude/types';
import { useI18n } from '@/lib/i18n';

const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
});

const formatTokens = (value?: number | null) => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return null;
    }
    if (value === 0) {
        return '0';
    }
    const formatted = COMPACT_NUMBER_FORMATTER.format(value);
    return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

interface UnifiedControlsDrawerProps {
    open: boolean;
    onClose: () => void;
    onOpenModel: () => void;
}

export const UnifiedControlsDrawer: React.FC<UnifiedControlsDrawerProps> = ({
    open,
    onClose,
    onOpenModel,
}) => {
    const { t } = useI18n();
    const providers = useConfigStore((state) => state.providers);
    const currentProviderId = useConfigStore((state) => state.currentProviderId);
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const setProvider = useConfigStore((state) => state.setProvider);
    const setModel = useConfigStore((state) => state.setModel);
    const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
    const addRecentModel = useUIStore((state) => state.addRecentModel);
    const { recentModelsList } = useModelLists();
    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const saveAgentModelForSession = useSelectionStore((state) => state.saveAgentModelForSession);
    const sessionAgentName = useContextStore((state) =>
        currentSessionId ? state.getSessionAgentSelection(currentSessionId) : null
    );

    const uiAgentName = currentSessionId ? (sessionAgentName || null) : null;

    const recentModelsBase = recentModelsList.slice(0, 4);
    const hasCurrentInRecents = recentModelsBase.some(
        (entry) => entry.providerID === currentProviderId && entry.modelID === currentModelId
    );
    // If current model not in recents, prepend it so it's always visible
    const recentModels = React.useMemo(() => {
        if (hasCurrentInRecents || !currentProviderId || !currentModelId) {
            return recentModelsBase;
        }
        const currentProvider = providers.find((p) => p.id === currentProviderId);
        const currentModel = currentProvider?.models?.find((m) => m.id === currentModelId);
        if (!currentModel) {
            return recentModelsBase;
        }
        return [
            { providerID: currentProviderId, modelID: currentModelId, provider: currentProvider, model: currentModel },
            ...recentModelsBase.slice(0, 3),
        ];
    }, [recentModelsBase, hasCurrentInRecents, currentProviderId, currentModelId, providers]);

    // OpenKei's thinking-variant pills, mapped onto the Claude effort levels (model default + supported levels).
    const effortControl = useEffortControl();
    const hasEffort = effortControl.supported;
    const effortOptions: Array<EffortLevel | null> = [null, ...effortControl.choices];

    const handleModelSelect = (providerId: string, modelId: string) => {
        const provider = providers.find((entry) => entry.id === providerId);
        if (!provider) {
            return;
        }
        const providerModels = Array.isArray(provider.models) ? provider.models : [];
        const modelExists = providerModels.some((model) => model.id === modelId);
        if (!modelExists) {
            return;
        }

        const isRecentAlready = recentModelsList.some(
            (entry) => entry.providerID === providerId && entry.modelID === modelId
        );

        setProvider(providerId);
        setModel(modelId);
        if (currentSessionId) {
            void setSessionModel(currentSessionId, modelId).catch((error: unknown) => {
                console.error('[UnifiedControlsDrawer] setModel failed:', error);
            });
        }
        if (!isRecentAlready) {
            addRecentModel(providerId, modelId);
        }

        if (currentSessionId && uiAgentName) {
            saveAgentModelForSession(currentSessionId, uiAgentName, providerId, modelId);
        }
    };

    return (
        <MobileOverlayPanel open={open} onClose={onClose} title={t('chat.unifiedControls.title')}>
            <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2">
                    <div className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground">
                        {t('chat.unifiedControls.model.title')}
                    </div>
                    <div className="rounded-xl border border-border/40 overflow-hidden">
                        {recentModels.length === 0 && !hasCurrentInRecents && (
                            <div className="px-3 py-2 typography-meta text-muted-foreground">
                                {t('chat.unifiedControls.model.noRecent')}
                            </div>
                        )}
                        {recentModels.map(({ providerID, modelID, model }) => {
                            const isSelected = providerID === currentProviderId && modelID === currentModelId;
                            const modelName = typeof model?.name === 'string' && model.name.trim().length > 0
                                ? model.name
                                : modelID;
                            const metadata = getModelMetadata(providerID, modelID);
                            const ctxTokens = formatTokens(metadata?.limit?.context);
                            const outTokens = formatTokens(metadata?.limit?.output);
                            return (
                                <button
                                    key={`recent-${providerID}-${modelID}`}
                                    type="button"
                                    onClick={() => handleModelSelect(providerID, modelID)}
                                    className={cn(
                                        'flex min-h-[44px] w-full items-center gap-2 border-b border-border/30 px-3 py-2 text-left last:border-b-0',
                                        isSelected ? 'bg-primary/10' : ''
                                    )}
                                >
                                    <ProviderLogo providerId={providerID} className="h-4 w-4 flex-shrink-0" />
                                    <span className="typography-meta font-medium text-foreground truncate min-w-0 flex-1">
                                        {modelName}
                                    </span>
                                    {(ctxTokens || outTokens) && (
                                        <span className="typography-micro text-muted-foreground whitespace-nowrap flex-shrink-0">
                                            {ctxTokens && `${ctxTokens} ctx`}
                                            {ctxTokens && outTokens && ' • '}
                                            {outTokens && `${outTokens} out`}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                        <button
                            type="button"
                            onClick={onOpenModel}
                            className="flex min-h-[44px] w-full items-center justify-center border-t border-border/30 px-3 py-2 typography-meta font-medium text-muted-foreground"
                            aria-label={t('chat.unifiedControls.model.moreAria')}
                        >
                            ...
                        </button>
                    </div>
                </div>

                {hasEffort && (
                    <div className="flex flex-col gap-2">
                        <div className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground">
                            {t('chat.unifiedControls.effort.title')}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {effortOptions.map((level) => {
                                const isSelected = effortControl.effort === level;
                                return (
                                    <button
                                        key={level ?? 'default'}
                                        type="button"
                                        onClick={() => effortControl.select(level)}
                                        className={cn(
                                            'inline-flex items-center rounded-full border px-2.5 py-1 typography-meta font-medium',
                                            isSelected
                                                ? 'border-primary/30 bg-primary/10 text-foreground'
                                                : 'border-border/40 text-muted-foreground hover:bg-interactive-hover/50'
                                        )}
                                        aria-pressed={isSelected}
                                    >
                                        {level ? effortLabel(level) : t('chat.modelControls.default')}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </MobileOverlayPanel>
    );
};

export default UnifiedControlsDrawer;
