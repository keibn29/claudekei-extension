import React from 'react';
import type { Session, ToolPart } from '@/lib/claude/types';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
    useDirectorySync,
    useEnsureSessionMessages,
    useSession,
    useSessionMessageRecords,
    useSessionStatus,
} from '@/sync/sync-context';
import { getAgentColor } from '@/lib/agentColors';
import {
    candidateChildSessionId,
    deriveSubagentEnd,
    deriveSubagentStatus,
    findAgentByType,
    findRunError,
    findRunRange,
    findRunReply,
    firstLine,
    buildSubagentActivity,
    buildSubagentSteps,
    getSubagentKind,
    isStaleBusyChild,
    readSubagentInput,
    readSubagentLink,
    resolveSubagentAlias,
    type ChildPhase,
    type SubagentActivityItem,
    type SubagentKind,
    type SubagentStatus,
    type SubagentStep,
} from '@/lib/claude/subagents';
import { agentLabel, formatAgentName } from '../../mobileControlsUtils';
import { resolveFallbackTaskSessionId } from './resolveFallbackTaskSessionId';

/** Existing child-resolution windows (docs/PHASE1_1_UI_SPEC.md 1.4 "No session"). */
const LINK_RETRY_MS = 3000;
const LINK_TIMEOUT_MS = 8000;

export type SubagentInfo = {
    kind: SubagentKind;
    callId: string;
    /** Child session id, when resolved. */
    sessionId?: string;
    agentId?: string;
    /** Agent type as reported (`claudekei:explorer`). */
    type?: string;
    /** Display name for the chip (`Explorer`). */
    typeLabel: string;
    /** Key passed to `getAgentColor`. */
    colorKey: string;
    alias?: string;
    /** Second header line: description / first line of the message. */
    description?: string;
    /** Prompt (`Agent`) or message (`SendMessage`) text for the body block. */
    instruction?: string;
    status: SubagentStatus;
    startedAt?: number;
    endedAt?: number;
    /** Child tool calls of this run (the whole session when the run cannot be identified). */
    steps: SubagentStep[];
    /** Last 5 actions of this run (tool calls and text snippets), oldest first. */
    activity: SubagentActivityItem[];
    /** `steps` covers only the instruction sent by this part (false = whole-session fallback). */
    runMatched: boolean;
    toolCount?: number;
    tokens?: number;
    /** Step to show on the peek line while running. */
    currentStep?: SubagentStep;
    /** Last assistant text of this run, else the host `reply` metadata. */
    reply?: string;
    /** Error text (tool error or child run error). */
    error?: string;
    /** `Agent` tool output (async-launch boilerplate removed), used when the child has no reply text. */
    toolOutput?: string;
};

const ASYNC_LAUNCH = /async agent launched/i;
const AGENT_ID_TRAILER = /\n*agentId:[^\n]*$/i;

const cleanAgentOutput = (output: string | undefined): string | undefined => {
    if (!output) return undefined;
    if (ASYNC_LAUNCH.test(output)) return undefined;
    const cleaned = output
        .replace(/\n*<task_metadata>[\s\S]*?<\/task_metadata>\s*$/i, '')
        .replace(AGENT_ID_TRAILER, '')
        .trim();
    return cleaned.length > 0 ? cleaned : undefined;
};

/**
 * Merges everything the UI knows about one `Agent` / `SendMessage` tool part: the tool state, the host link
 * metadata, the child session (status, messages, `claude.progress`) and the agent catalog. All the derivation lives
 * in `lib/claude/subagents.ts`; this hook only wires it to the sync store.
 */
export const useSubagentInfo = (part: ToolPart): SubagentInfo => {
    const kind: SubagentKind = getSubagentKind(part.tool) ?? 'agent';
    const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
    const parentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const agents = useConfigStore((state) => state.agents);

    const state = part.state;
    const input = React.useMemo(() => readSubagentInput(part), [part]);
    const link = React.useMemo(() => readSubagentLink(part), [part]);
    const toolStatus = (state as { status?: string }).status;
    const stateTime = (state as { time?: { start?: number; end?: number } }).time;

    // --- Child session resolution -------------------------------------------------------------------
    const firstSeenRef = React.useRef<number>(Date.now());
    const resolutionStart = stateTime?.start ?? firstSeenRef.current;
    const [retried, setRetried] = React.useState(() => Date.now() - resolutionStart > LINK_RETRY_MS);
    const [timedOut, setTimedOut] = React.useState(() => Date.now() - resolutionStart > LINK_TIMEOUT_MS);

    const explicitSessionId = link.sessionId;
    const candidateId = candidateChildSessionId(part);
    const isFinalized = toolStatus === 'completed' || toolStatus === 'error';

    const resolvedSessionId = useDirectorySync(
        React.useCallback((store) => {
            if (explicitSessionId) return explicitSessionId;
            // Deterministic id the host uses for an Agent call.
            if (kind === 'agent' && candidateId && store.session.some((session) => session.id === candidateId)) {
                return candidateId;
            }
            // SendMessage (or Agent without metadata): look the child up by agent id / alias among this session's children.
            const wanted = [link.agentId, link.recipient ?? input.to].filter((value): value is string => Boolean(value));
            if (wanted.length > 0 && parentSessionId) {
                const match = store.session.find((session: Session) => (
                    session.parentID === parentSessionId
                    && (
                        (session.claude?.agentId !== undefined && wanted.includes(session.claude.agentId))
                        || (session.claude?.alias !== undefined && wanted.includes(session.claude.alias))
                    )
                ));
                if (match) return match.id;
            }
            if (kind !== 'agent') return undefined;
            return resolveFallbackTaskSessionId({
                isTaskTool: true,
                parentSessionId: parentSessionId ?? undefined,
                taskStartTime: stateTime?.start ?? firstSeenRef.current,
                isTaskFinalized: isFinalized,
                sessions: store.session,
                sessionStatusMap: store.session_status,
                hasRetried: retried,
            });
        }, [candidateId, explicitSessionId, input.to, isFinalized, kind, link.agentId, link.recipient, parentSessionId, retried, stateTime?.start]),
        currentDirectory,
    );

    React.useEffect(() => {
        if (resolvedSessionId || timedOut) return;
        const now = Date.now();
        const timers: number[] = [];
        if (!retried) timers.push(window.setTimeout(() => setRetried(true), Math.max(0, LINK_RETRY_MS - (now - resolutionStart))));
        timers.push(window.setTimeout(() => setTimedOut(true), Math.max(0, LINK_TIMEOUT_MS - (now - resolutionStart))));
        return () => timers.forEach((timer) => window.clearTimeout(timer));
    }, [resolutionStart, resolvedSessionId, retried, timedOut]);

    const sessionId = resolvedSessionId;
    const childSession = useSession(sessionId ?? null, currentDirectory);
    const records = useSessionMessageRecords(sessionId ?? '', currentDirectory);
    useEnsureSessionMessages(sessionId ?? '', currentDirectory);
    const childStatus = useSessionStatus(sessionId ?? '', currentDirectory);
    const parentStatus = useSessionStatus(parentSessionId ?? '', currentDirectory);

    // --- Run slice and derived content --------------------------------------------------------------
    const range = React.useMemo(
        () => findRunRange(records, {
            kind,
            childMessageId: link.childMessageId,
            toolCallId: part.callID,
            messageText: link.message ?? input.message,
        }),
        [input.message, kind, link.childMessageId, link.message, part.callID, records],
    );
    const steps = React.useMemo(() => buildSubagentSteps(records, range), [range, records]);
    const activity = React.useMemo(() => buildSubagentActivity(records, range), [range, records]);
    const isLatestRun = range.end >= records.length;

    const childPhase: ChildPhase | undefined = React.useMemo(() => {
        if (!sessionId) return undefined;
        const phase: ChildPhase | undefined = (() => {
            if (childStatus) return childStatus.type;
            const last = records[records.length - 1];
            const pending = last?.info.role === 'assistant'
                && typeof (last.info as { time?: { completed?: number } }).time?.completed !== 'number';
            return pending ? 'busy' : undefined;
        })();
        // A child still `busy` after the turn ended and the tool settled (e.g. a stopped run) must not keep spinning.
        return isStaleBusyChild({ childPhase: phase, parentIdle: !parentStatus || parentStatus.type === 'idle', toolStatus, runStatus: link.runStatus }) ? 'idle' : phase;
    }, [childStatus, link.runStatus, parentStatus, records, sessionId, toolStatus]);

    const runError = React.useMemo(() => findRunError(records, range), [range, records]);
    const toolError = (state as { error?: string }).error;

    const status = deriveSubagentStatus({
        kind,
        toolStatus,
        toolError,
        runStatus: link.runStatus,
        hasSession: Boolean(sessionId),
        linkTimedOut: timedOut,
        childPhase,
        childFailed: Boolean(runError) && childPhase !== 'busy' && childPhase !== 'retry',
    });

    // --- Identity ------------------------------------------------------------------------------------
    const agentId = link.agentId ?? childSession?.claude?.agentId;
    const type = link.agentType ?? childSession?.claude?.agentType ?? input.subagentType;
    const catalogAgent = React.useMemo(() => findAgentByType(agents, type), [agents, type]);
    const typeLabel = catalogAgent ? agentLabel(catalogAgent) : (type ? formatAgentName(type) : '');
    const colorKey = catalogAgent?.name ?? type ?? 'subagent';
    const alias = resolveSubagentAlias({ kind, input, link, childAlias: childSession?.claude?.alias, agentId });

    // --- Text ----------------------------------------------------------------------------------------
    const instruction = kind === 'agent' ? input.prompt ?? link.message : input.message ?? link.message;
    const description = kind === 'agent'
        ? input.description ?? firstLine(instruction)
        : input.summary ?? firstLine(instruction);
    const reply = link.reply ?? findRunReply(records, range);
    const error = (state as { status?: string }).status === 'error' ? toolError : runError;
    const toolOutput = kind === 'agent' && toolStatus === 'completed'
        ? cleanAgentOutput((state as { output?: string }).output)
        : undefined;

    // --- Progress and timing -------------------------------------------------------------------------
    const progress = isLatestRun ? childSession?.claude?.progress : undefined;
    const toolCount = steps.length > 0 ? steps.length : progress?.toolUses;
    const startedAt = stateTime?.start ?? firstSeenRef.current;
    const settled = status !== 'preparing' && status !== 'running';
    const endedAt = settled
        ? deriveSubagentEnd({
            startedAt,
            progressDurationMs: progress?.durationMs,
            childUpdatedAt: isLatestRun && childPhase !== 'busy' && childPhase !== 'retry' ? childSession?.time.updated : undefined,
            toolEnd: stateTime?.end,
        })
        : undefined;

    const currentStep = React.useMemo<SubagentStep | undefined>(() => {
        for (let index = steps.length - 1; index >= 0; index -= 1) {
            if (steps[index].status === 'running' || steps[index].status === 'pending') return steps[index];
        }
        if (steps.length > 0) return steps[steps.length - 1];
        if (progress?.lastToolName || progress?.description) {
            return { tool: progress.lastToolName ?? 'tool', title: progress.description, status: 'running' };
        }
        return undefined;
    }, [progress?.description, progress?.lastToolName, steps]);

    return {
        kind,
        callId: part.callID,
        sessionId,
        agentId,
        type,
        typeLabel,
        colorKey,
        alias,
        description,
        instruction,
        status,
        startedAt,
        endedAt,
        steps,
        activity,
        runMatched: range.matched,
        toolCount,
        tokens: progress?.totalTokens,
        currentStep,
        reply,
        error,
        toolOutput,
    };
};

/** Agent color tokens for a `SubagentInfo` (CSS variable list + the `agent-*` class used by `agent-badge`). */
export const getSubagentColor = (info: Pick<SubagentInfo, 'colorKey'>) => getAgentColor(info.colorKey);
