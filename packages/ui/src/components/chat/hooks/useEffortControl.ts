import React from 'react';
import { useDraftEffortStore } from '@/lib/claude/effort';
import { effortLabel, nextEffort } from '@/lib/claude/modelNames';
import type { EffortLevel } from '@/lib/claude/types';
import { setSessionEffort } from '@/sync/session-actions';
import { useComposerModel } from './useComposerModel';

export type EffortControl = {
    /** The selected model supports effort; the button is hidden otherwise (OpenKei hides the variant button the same way). */
    supported: boolean;
    /** Selected effort, `null` = model default. */
    effort: EffortLevel | null;
    /** Supported levels for the selected model (without "Model default"). */
    choices: readonly EffortLevel[];
    /** Button text: `High`, or `Default` for the model default. */
    label: string;
    select: (effort: EffortLevel | null) => void;
    cycle: () => void;
};

/**
 * The composer's "thinking level" control. OpenKei calls it a variant (a separate button next to the model, a mobile
 * panel and a cycle shortcut); for Claude it is the SDK effort level. Existing sessions go through the host
 * (`claude:session.setEffort`); drafts keep the choice locally and send it with the first message.
 */
export const useEffortControl = (): EffortControl => {
    const { sessionId, effort, effortChoices } = useComposerModel();
    const setDraftEffort = useDraftEffortStore((state) => state.setDraftEffort);

    const select = React.useCallback((next: EffortLevel | null) => {
        if (sessionId) {
            void setSessionEffort(sessionId, next).catch((error: unknown) => {
                console.error('[effort] setEffort failed:', error);
            });
            return;
        }
        setDraftEffort(next);
    }, [sessionId, setDraftEffort]);

    const cycle = React.useCallback(() => {
        if (effortChoices.length === 0) return;
        select(nextEffort(effort, effortChoices));
    }, [effort, effortChoices, select]);

    return {
        supported: effortChoices.length > 0,
        effort,
        choices: effortChoices,
        label: effort ? effortLabel(effort) : 'Default',
        select,
        cycle,
    };
};
