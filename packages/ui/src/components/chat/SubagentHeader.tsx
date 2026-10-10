import React from 'react';
import { RiArrowDownSLine, RiArrowLeftLine, RiArrowRightSLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { effortLabel, subagentModelInfo } from '@/lib/claude/modelNames';
import { useConfigStore } from '@/stores/useConfigStore';
import { useCatalog } from './hooks/useComposerModel';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSession, useSessionMessageRecords, useSessionStatus } from '@/sync/sync-context';
import {
    buildSubagentSteps,
    findAgentByType,
    findRunError,
    firstLine,
    listInstructions,
} from '@/lib/claude/subagents';
import { SubagentAlias, SubagentKindIcon, SubagentStatusGlyph, SubagentToolCount, SubagentTypeChip } from './message/parts/SubagentParts';
import { useSubagentSession } from './message/SubagentSessionContext';
import { formatTimestampForDisplay } from './message/timeFormat';
import { agentLabel, formatAgentName } from './mobileControlsUtils';

const focusInstruction = (messageId: string, attempts = 12) => {
    const target = document.querySelector<HTMLElement>(`[data-instruction-id="${messageId}"]`);
    if (target) {
        target.focus({ preventScroll: true });
        return;
    }
    if (attempts > 0) window.requestAnimationFrame(() => focusInstruction(messageId, attempts - 1));
};

interface SubagentHeaderProps {
    /** Scrolls the transcript to a message (virtualized list aware). */
    onJumpToMessage: (messageId: string) => Promise<boolean> | boolean | void;
}

/**
 * Sticky header of an opened subagent session (replaces the floating "Return to parent" button): back button,
 * identity (icon + type chip + alias + live status), description, and the instruction timeline
 * (docs/PHASE1_1_UI_SPEC.md 1.6).
 */
export const SubagentHeader: React.FC<SubagentHeaderProps> = ({ onJumpToMessage }) => {
    const { t } = useI18n();
    const parent = useSubagentSession();
    const sessionId = useSessionUIStore((state) => state.currentSessionId);
    const session = useSession(sessionId);
    const records = useSessionMessageRecords(sessionId ?? '');
    const status = useSessionStatus(sessionId ?? '');
    const agents = useConfigStore((state) => state.agents);
    const catalog = useCatalog();
    const [open, setOpen] = React.useState(false);
    const [activeId, setActiveId] = React.useState<string | null>(null);
    const listId = React.useId();

    const instructions = React.useMemo(() => listInstructions(records), [records]);
    const toolCount = React.useMemo(() => buildSubagentSteps(records).length, [records]);

    if (!parent?.isChild) return null;

    const type = session?.claude?.agentType;
    const catalogAgent = findAgentByType(agents, type);
    const typeLabel = catalogAgent ? agentLabel(catalogAgent) : (type ? formatAgentName(type) : '');
    const colorKey = catalogAgent?.name ?? type ?? 'subagent';
    const modelInfo = subagentModelInfo(session, catalog?.models ?? []);
    const busy = status?.type === 'busy' || status?.type === 'retry';
    const failed = !busy && Boolean(findRunError(records, { start: 0, end: records.length }));
    const infoStatus = busy ? 'running' : failed ? 'failed' : 'done';
    const startedAt = instructions[0]?.createdAt ?? session?.time.created;
    const endedAt = busy ? undefined : session?.time.updated;
    const title = session?.title?.trim();
    const description = title || firstLine(instructions[0]?.text);

    const handleJump = (messageId: string) => {
        setActiveId(messageId);
        void Promise.resolve(onJumpToMessage(messageId)).finally(() => {
            window.requestAnimationFrame(() => focusInstruction(messageId));
        });
    };

    return (
        <div
            className="z-20 flex-shrink-0 space-y-1.5 border-b border-border/60 bg-background px-3 py-2"
            data-subagent-header
        >
            <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => parent.openParent()}
                className="!font-normal normal-case"
                aria-label={t('chat.subagent.child.backAria', { parent: parent.parentLabel })}
            >
                <RiArrowLeftLine className="h-4 w-4" aria-hidden="true" />
                {t('chat.subagent.child.back', { parent: parent.parentLabel })}
            </Button>

            <div className="flex min-w-0 items-center gap-1.5">
                <span className="flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                    <SubagentKindIcon kind="agent" className="h-3.5 w-3.5" />
                </span>
                <SubagentTypeChip info={{ typeLabel, colorKey }} />
                {modelInfo.model ? (
                    <span className="typography-meta flex-shrink-0 text-foreground/80" data-subagent-model>
                        {modelInfo.model}
                    </span>
                ) : null}
                {modelInfo.effort ? (
                    <span className="typography-micro flex-shrink-0 rounded border border-border bg-muted px-1.5 leading-4 text-foreground/80" data-subagent-effort>
                        {effortLabel(modelInfo.effort).toLowerCase()}
                    </span>
                ) : null}
                <div className="flex min-w-0 flex-1 items-center">
                    <SubagentAlias alias={session?.claude?.alias} />
                </div>
                <SubagentStatusGlyph info={{ status: infoStatus, startedAt, endedAt }} />
            </div>

            <div className="flex min-w-0 items-center gap-2">
                {description ? (
                    <span className="typography-meta min-w-0 flex-1 truncate text-muted-foreground" title={description}>
                        {description}
                    </span>
                ) : <span className="flex-1" />}
                <SubagentToolCount count={toolCount} tokens={session?.claude?.progress?.totalTokens} />
            </div>

            {instructions.length > 0 ? (
                <div>
                    <button
                        type="button"
                        className="inline-flex items-center gap-1 typography-micro text-muted-foreground hover:text-foreground rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                        aria-expanded={open}
                        aria-controls={listId}
                        onClick={() => setOpen((previous) => !previous)}
                    >
                        {open ? <RiArrowDownSLine className="h-3.5 w-3.5" aria-hidden="true" /> : <RiArrowRightSLine className="h-3.5 w-3.5" aria-hidden="true" />}
                        {instructions.length === 1
                            ? t('chat.subagent.child.instructionsOne')
                            : t('chat.subagent.child.instructionsMany', { count: instructions.length })}
                    </button>
                    <ul id={listId} hidden={!open} className={cn('mt-1 space-y-0.5', !open && 'hidden')}>
                        {instructions.map((entry) => {
                            const time = typeof entry.createdAt === 'number' ? formatTimestampForDisplay(entry.createdAt) : '';
                            return (
                                <li key={entry.messageId}>
                                    <button
                                        type="button"
                                        className="flex w-full min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-left typography-micro hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
                                        aria-current={activeId === entry.messageId ? 'true' : undefined}
                                        onClick={() => handleJump(entry.messageId)}
                                    >
                                        <span className="flex-shrink-0 font-medium text-foreground/80">
                                            #{entry.index} {entry.kind === 'initial' ? t('chat.subagent.child.initialTask') : t('chat.subagent.child.followUp')}
                                        </span>
                                        {time ? <span className="flex-shrink-0 tabular-nums text-muted-foreground">{time}</span> : null}
                                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{firstLine(entry.text)}</span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            ) : null}
        </div>
    );
};

/** Replaces the composer in a child session: instructions only come from the parent agent. */
export const SubagentReadOnlyFooter: React.FC = () => {
    const { t } = useI18n();
    const parent = useSubagentSession();
    if (!parent?.isChild) return null;
    return (
        <div className="flex flex-shrink-0 flex-col items-start gap-2 border-t border-border/60 bg-background px-3 py-3" data-subagent-footer>
            <p className="typography-meta text-muted-foreground">
                {t('chat.subagent.child.readOnly', { parent: parent.parentLabel })}
            </p>
            <Button type="button" variant="outline" size="xs" onClick={() => parent.openParent()} className="!font-normal normal-case">
                <RiArrowLeftLine className="h-4 w-4" aria-hidden="true" />
                {t('chat.subagent.child.back', { parent: parent.parentLabel })}
            </Button>
        </div>
    );
};
