import type { Part } from '@/lib/claude/types';

const shouldKeepSyntheticUserText = (text: string, planModeEnabled: boolean): boolean => {
    const trimmed = text.trim();
    if (planModeEnabled && trimmed.startsWith('User has requested to enter plan mode')) return true;
    if (planModeEnabled && trimmed.startsWith('The plan at ')) return true;
    return false;
};

export const normalizeUserDisplayParts = (parts: Part[], options?: { planModeEnabled?: boolean }): Part[] => {
    const planModeEnabled = options?.planModeEnabled === true;
    return parts
        .filter((part) => {
            const synthetic = (part as { synthetic?: boolean }).synthetic === true;
            if (!synthetic) return true;
            if (part.type !== 'text') return false;
            const text = (part as { text?: unknown }).text;
            if (typeof text !== 'string') {
                return false;
            }

            return shouldKeepSyntheticUserText(text, planModeEnabled);
        })
        .map((part) => {
            const rawPart = part as Record<string, unknown>;
            if (rawPart.type === 'compaction') {
                return { type: 'text', text: '/compact' } as Part;
            }
            return part;
        });
};
