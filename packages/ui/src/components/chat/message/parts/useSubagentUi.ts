import React from 'react';
import type { SubagentInfo } from './useSubagentInfo';
import { useI18n } from '@/lib/i18n';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionDirectory } from '@/sync/sync-context';
import { sessionEvents } from '@/lib/sessionEvents';
import { formatSubagentElapsed, isActiveSubagentStatus, type SubagentStatus } from '@/lib/claude/subagents';
import type { ContentChangeReason } from '@/hooks/useChatScrollManager';

type Translate = ReturnType<typeof useI18n>['t'];

/** Title verb: `Subagent Task` / `Message to`. */
export const subagentTitle = (t: Translate, kind: SubagentInfo['kind']): string =>
    kind === 'message' ? t('chat.subagent.title.message') : t('chat.subagent.title.agent');

export const useSubagentTitle = (kind: SubagentInfo['kind']): string => {
    const { t } = useI18n();
    return subagentTitle(t, kind);
};

/** Plain-text status word for aria labels and live announcements. */
export const useSubagentStatusWord = (status: SubagentStatus): string => {
    const { t } = useI18n();
    switch (status) {
        case 'preparing': return t('chat.subagent.status.starting');
        case 'running': return t('chat.subagent.status.running');
        case 'done': return t('chat.subagent.status.done');
        case 'sent': return t('chat.subagent.status.sent');
        case 'failed': return t('chat.subagent.status.failed');
        case 'not-delivered': return t('chat.subagent.status.notDelivered');
        case 'stopped': return t('chat.subagent.status.stopped');
        default: return t('chat.subagent.status.noSession');
    }
};

/** Open the child session through the existing subtask navigation. */
export const useSubagentOpen = (info: Pick<SubagentInfo, 'sessionId' | 'typeLabel' | 'alias'>) => {
    const { t } = useI18n();
    const openSubtaskSession = useSessionUIStore((state) => state.openSubtaskSession);
    const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const parentDirectory = useSessionDirectory(currentSessionId);
    const { sessionId } = info;

    const open = React.useCallback(() => {
        if (!sessionId) return;
        if (currentSessionId) {
            openSubtaskSession(sessionId, currentSessionId, parentDirectory ?? null);
            return;
        }
        setCurrentSession(sessionId, parentDirectory ?? null);
    }, [currentSessionId, openSubtaskSession, parentDirectory, sessionId, setCurrentSession]);

    const type = info.typeLabel || t('chat.subagent.fallbackType');
    const label = info.alias
        ? t('chat.subagent.openAlias', { type, alias: info.alias })
        : t('chat.subagent.open', { type });
    return { open, canOpen: Boolean(sessionId), label };
};

/** Accessible name: `Subagent Task, Explorer exp-1, running, Ping explorer` (status words, no ticking counters). */
export const useSubagentAriaLabel = (info: SubagentInfo): string => {
    const title = useSubagentTitle(info.kind);
    const statusWord = useSubagentStatusWord(info.status);
    const settled = !isActiveSubagentStatus(info.status);
    const elapsed = settled && typeof info.startedAt === 'number' && typeof info.endedAt === 'number'
        ? formatSubagentElapsed(info.endedAt - info.startedAt)
        : undefined;
    return [
        title,
        [info.typeLabel, info.alias].filter(Boolean).join(' '),
        statusWord,
        elapsed,
        info.description,
    ].filter(Boolean).join(', ');
};

/** Side effects shared by the card and the compact group rows. */
export const useSubagentEffects = (info: SubagentInfo, isExpanded: boolean, onContentChange?: (reason?: ContentChangeReason) => void) => {
    const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
    const { status } = info;

    // Files may have changed once a run finishes.
    const previousStatusRef = React.useRef(status);
    React.useEffect(() => {
        const previous = previousStatusRef.current;
        previousStatusRef.current = status;
        if (previous !== status && isActiveSubagentStatus(previous) && (status === 'done' || status === 'sent') && currentDirectory) {
            sessionEvents.requestGitRefresh({ directory: currentDirectory });
        }
    }, [currentDirectory, status]);

    const onContentChangeRef = React.useRef(onContentChange);
    onContentChangeRef.current = onContentChange;
    const stepCount = info.steps.length;
    React.useEffect(() => {
        onContentChangeRef.current?.('structural');
    }, [isExpanded, stepCount, status]);
};

