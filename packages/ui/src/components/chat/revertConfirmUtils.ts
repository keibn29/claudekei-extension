import { revertToMessage } from '@/sync/session-actions';
import type { RevertPreview } from '@/lib/claude/types';

export interface RevertConfirmTarget {
    sessionId: string;
    messageId: string;
}

export interface RevertExecutionResult {
    executed: boolean;
    success: boolean;
    error: string | null;
    target: RevertConfirmTarget | null;
}

export interface ExecuteRevertConfirmOptions {
    target: RevertConfirmTarget | null;
    isPendingRef: { current: boolean };
    isMounted: () => boolean;
    setIsPending?: (pending: boolean) => void;
    setError?: (error: string | null) => void;
    onConfirm?: (() => Promise<void> | void) | null;
    getLatestOnSuccess?: () => (((target?: RevertConfirmTarget) => void) | undefined);
    getLatestOnOpenChange?: () => (((open: boolean) => void) | undefined);
    performRevert?: (sessionId: string, messageId: string) => Promise<unknown>;
    notifyError?: (errorDetail: string) => void;
}

export async function executeRevertConfirm({
    target,
    isPendingRef,
    isMounted,
    setIsPending,
    setError,
    onConfirm,
    getLatestOnSuccess,
    getLatestOnOpenChange,
    performRevert = revertToMessage,
    notifyError,
}: ExecuteRevertConfirmOptions): Promise<RevertExecutionResult> {
    // Synchronous ref guard prevents multiple invocations
    if (isPendingRef.current) {
        return { executed: false, success: false, error: null, target: null };
    }
    if (!target?.sessionId || !target?.messageId) {
        return { executed: false, success: false, error: null, target: null };
    }

    isPendingRef.current = true;
    setIsPending?.(true);
    setError?.(null);

    // Capture stable target to avoid reading mutable references
    const stableTarget: RevertConfirmTarget = {
        sessionId: target.sessionId,
        messageId: target.messageId,
    };

    try {
        if (onConfirm) {
            await onConfirm();
        } else {
            await performRevert(stableTarget.sessionId, stableTarget.messageId);
        }

        if (isMounted()) {
            getLatestOnSuccess?.()?.(stableTarget);
            getLatestOnOpenChange?.()?.(false);
        }

        return { executed: true, success: true, error: null, target: stableTarget };
    } catch (err: unknown) {
        const errorDetail = err instanceof Error ? err.message : String(err);
        if (isMounted()) {
            setError?.(errorDetail);
        }
        notifyError?.(errorDetail);
        // Keep dialog open on error so user can inspect details
        return { executed: true, success: false, error: errorDetail, target: stableTarget };
    } finally {
        isPendingRef.current = false;
        if (isMounted()) {
            setIsPending?.(false);
        }
    }
}

export interface HandleTimelineRevertSuccessOptions {
    isMounted: boolean | (() => boolean);
    currentSessionId: string | null;
    targetSessionId?: string | null;
    onCloseTimeline: () => void;
    onResetTarget: () => void;
}

export function handleTimelineRevertSuccess({
    isMounted,
    currentSessionId,
    targetSessionId,
    onCloseTimeline,
    onResetTarget,
}: HandleTimelineRevertSuccessOptions): boolean {
    const mounted = typeof isMounted === 'function' ? isMounted() : isMounted;
    let closed = false;

    if (mounted && targetSessionId && currentSessionId === targetSessionId) {
        onCloseTimeline();
        closed = true;
    }

    onResetTarget();
    return closed;
}

// ---------------------------------------------------------------------------
// File preview (dry run) state
// ---------------------------------------------------------------------------

export type RevertPreviewState =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'ready'; preview: RevertPreview }
    | { status: 'error'; error: string };

/** Number of file paths listed in the dialog before collapsing the rest into "and N more". */
export const REVERT_PREVIEW_MAX_FILES = 8;

/** Confirm stays disabled until the dry run settles; a failed preview request does not block the revert. */
export function isRevertConfirmDisabled(isPending: boolean, state: RevertPreviewState): boolean {
    return isPending || state.status === 'loading';
}

/** Files cannot be restored: the confirm button reverts the conversation only. */
export function isConversationOnlyPreview(state: RevertPreviewState): boolean {
    return state.status === 'ready' && Boolean(state.preview.filesError);
}

export function splitPreviewFiles(files: string[], max: number = REVERT_PREVIEW_MAX_FILES): { shown: string[]; more: number } {
    return { shown: files.slice(0, max), more: Math.max(0, files.length - max) };
}

/** Stale-response guard: only the most recently started request may settle the state. */
export function createLatestRequestGuard() {
    let latest = 0;
    return {
        start: (): number => {
            latest += 1;
            return latest;
        },
        isCurrent: (id: number): boolean => id === latest,
        /** Marks every in-flight request stale (dialog closed / unmounted). */
        invalidate: (): void => {
            latest += 1;
        },
    };
}

export interface LoadRevertPreviewOptions {
    target: RevertConfirmTarget | null;
    fetchPreview: (sessionId: string, messageId: string) => Promise<RevertPreview>;
    guard: ReturnType<typeof createLatestRequestGuard>;
    setState: (state: RevertPreviewState) => void;
}

/** Runs the dry run for `target` and reports loading/ready/error, ignoring responses that became stale. */
export async function loadRevertPreview({ target, fetchPreview, guard, setState }: LoadRevertPreviewOptions): Promise<void> {
    const requestId = guard.start();
    if (!target?.sessionId || !target?.messageId) {
        setState({ status: 'idle' });
        return;
    }
    setState({ status: 'loading' });
    try {
        const preview = await fetchPreview(target.sessionId, target.messageId);
        if (guard.isCurrent(requestId)) setState({ status: 'ready', preview });
    } catch (err: unknown) {
        if (guard.isCurrent(requestId)) {
            setState({ status: 'error', error: err instanceof Error ? err.message : String(err) });
        }
    }
}
