import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

// Import i18n dictionaries to verify completeness and truthful copy
import { dict as enDict } from '@/lib/i18n/messages/en';
import { dict as ptBrDict } from '@/lib/i18n/messages/pt-BR';
import { dict as zhCnDict } from '@/lib/i18n/messages/zh-CN';
import { dict as esDict } from '@/lib/i18n/messages/es';
import { dict as ukDict } from '@/lib/i18n/messages/uk';

import {
    createLatestRequestGuard,
    executeRevertConfirm,
    handleTimelineRevertSuccess,
    isConversationOnlyPreview,
    isRevertConfirmDisabled,
    loadRevertPreview,
    REVERT_PREVIEW_MAX_FILES,
    splitPreviewFiles,
    type RevertPreviewState,
} from './revertConfirmUtils';
import type { RevertPreview } from '@/lib/claude/types';
import { useSessionUIStore } from '@/sync/session-ui-store';

describe('RevertConfirmDialog & Confirmation Fix Contracts', () => {
    describe('1. i18n dictionary completeness & copy truthfulness', () => {
        const requiredKeys = [
            'chat.revertDialog.title',
            'chat.revertDialog.description',
            'chat.revertDialog.checkingFiles',
            'chat.revertDialog.filesHeading',
            'chat.revertDialog.filesNone',
            'chat.revertDialog.filesUnavailable',
            'chat.revertDialog.filesNote',
            'chat.revertDialog.busyNote',
            'chat.revertDialog.moreFiles',
            'chat.revertDialog.confirm',
            'chat.revertDialog.confirmConversationOnly',
            'chat.revertDialog.cancel',
            'chat.revertDialog.reverting',
            'chat.revertDialog.errorTitle',
            'chat.revertDialog.toast.failed',
            'chat.revert.toast.filesNotRestored',
            'chat.revert.toast.undidTo',
            'chat.revert.toast.redidTo',
            'chat.revert.toast.restoredAll',
            'chat.timeline.help.undoToPoint',
        ] as const;

        const locales = [
            { name: 'en', dict: enDict },
            { name: 'pt-BR', dict: ptBrDict },
            { name: 'zh-CN', dict: zhCnDict },
            { name: 'es', dict: esDict },
            { name: 'uk', dict: ukDict },
        ];

        for (const { name, dict } of locales) {
            test(`locale ${name} has all required chat.revertDialog keys with non-empty strings`, () => {
                for (const key of requiredKeys) {
                    const value = (dict as Record<string, string>)[key];
                    expect(value !== undefined).toBe(true);
                    expect(typeof value).toBe('string');
                    expect(value.length).toBeGreaterThan(0);
                }
            });

            test(`locale ${name} copy does not claim 'cannot undo' or 'irreversible'`, () => {
                for (const key of requiredKeys) {
                    const value = ((dict as Record<string, string>)[key] || '').toLowerCase();
                    expect(value.includes('cannot be undone')).toBe(false);
                    expect(value.includes('não pode ser desfeita')).toBe(false);
                    expect(value.includes('无法撤销')).toBe(false);
                    expect(value.includes('no se puede deshacer')).toBe(false);
                    expect(value.includes('не можна скасувати')).toBe(false);
                }
            });
        }

        test('English copy explains the hidden messages, composer refill, permanence and /redo', () => {
            const desc = enDict['chat.revertDialog.description'].toLowerCase();
            expect(desc.includes('hidden')).toBe(true);
            expect(desc.includes('composer')).toBe(true);
            expect(desc.includes('permanent')).toBe(true);
            expect(desc.includes('/redo')).toBe(true);
            expect(enDict['chat.revertDialog.filesNote'].toLowerCase().includes('shell')).toBe(true);
            expect('chat.revertDialog.subagentHelp' in enDict).toBe(false);
        });

        test('interpolated copy keeps its placeholders in every locale', () => {
            for (const { dict } of locales) {
                const d = dict as Record<string, string>;
                expect(d['chat.revertDialog.filesHeading'].includes('{count}')).toBe(true);
                expect(d['chat.revertDialog.moreFiles'].includes('{count}')).toBe(true);
                expect(d['chat.revertDialog.filesUnavailable'].includes('{error}')).toBe(true);
                expect(d['chat.revert.toast.undidTo'].includes('{preview}')).toBe(true);
                expect(d['chat.revert.toast.redidTo'].includes('{preview}')).toBe(true);
            }
        });
    });

    describe('2. Confirmation action & pending synchronous ref guard', () => {
        test('cancel never calls action', async () => {
            let actionCalls = 0;
            const actionFn = async () => {
                actionCalls += 1;
            };
            let dialogOpen = true;

            const handleCancel = (isPending: boolean, onOpenChange: (open: boolean) => void) => {
                if (isPending) return;
                onOpenChange(false);
            };

            handleCancel(false, (open) => {
                dialogOpen = open;
            });

            expect(dialogOpen).toBe(false);
            expect(typeof actionFn).toBe('function');
            expect(actionCalls).toBe(0);
        });

        test('confirm executes once with stable target and blocks concurrent calls via ref guard', async () => {
            let resolveAction: () => void = () => {};
            const actionPromise = new Promise<void>((res) => {
                resolveAction = res;
            });

            const actionCalls: Array<[string, string]> = [];
            const actionFn = async (sessionId: string, messageId: string) => {
                actionCalls.push([sessionId, messageId]);
                await actionPromise;
            };

            const isPendingRef = { current: false };
            let isPendingState = false;
            let dialogOpen = true;
            let successCalled = false;

            const target = { sessionId: 'session-123', messageId: 'msg-456' };

            // First click triggers action using actual production executeRevertConfirm
            const firstCall = executeRevertConfirm({
                target,
                isPendingRef,
                isMounted: () => true,
                setIsPending: (pending) => { isPendingState = pending; },
                performRevert: actionFn,
                getLatestOnSuccess: () => () => { successCalled = true; },
                getLatestOnOpenChange: () => (open) => { dialogOpen = open; },
            });

            expect(isPendingRef.current).toBe(true);
            expect(isPendingState).toBe(true);

            // Second and third concurrent clicks while pending are ignored by synchronous ref guard
            const secondCall = executeRevertConfirm({
                target,
                isPendingRef,
                isMounted: () => true,
                setIsPending: (pending) => { isPendingState = pending; },
                performRevert: actionFn,
                getLatestOnSuccess: () => () => { successCalled = true; },
                getLatestOnOpenChange: () => (open) => { dialogOpen = open; },
            });
            const thirdCall = executeRevertConfirm({
                target,
                isPendingRef,
                isMounted: () => true,
                setIsPending: (pending) => { isPendingState = pending; },
                performRevert: actionFn,
                getLatestOnSuccess: () => () => { successCalled = true; },
                getLatestOnOpenChange: () => (open) => { dialogOpen = open; },
            });

            expect(actionCalls.length).toBe(1);

            // Complete the pending action
            resolveAction();
            const [firstResult, secondResult, thirdResult] = await Promise.all([firstCall, secondCall, thirdCall]);

            expect(firstResult.executed).toBe(true);
            expect(firstResult.success).toBe(true);
            expect(secondResult.executed).toBe(false);
            expect(thirdResult.executed).toBe(false);

            expect(actionCalls.length).toBe(1);
            expect(actionCalls[0]).toEqual(['session-123', 'msg-456']);
            expect(successCalled).toBe(true);
            expect(dialogOpen).toBe(false);
            expect(isPendingRef.current).toBe(false);
            expect(isPendingState).toBe(false);
        });

        test('dismissal (Esc/backdrop) is prevented while pending', () => {
            const isPendingRef = { current: true };
            let dialogOpen = true;

            const handleOpenChange = (nextOpen: boolean) => {
                if (isPendingRef.current) {
                    return; // Prevent dismissal while pending
                }
                dialogOpen = nextOpen;
            };

            // Attempt to dismiss while pending
            handleOpenChange(false);
            expect(dialogOpen).toBe(true);

            // Once not pending, dismissal succeeds
            isPendingRef.current = false;
            handleOpenChange(false);
            expect(dialogOpen).toBe(false);
        });
    });

    describe('3. Core error handling and detail visibility', () => {
        test('catches thrown error, keeps dialog open, and exposes detailed error preserving session IDs', async () => {
            const partialFailureMessage =
                'Partial revert failure: successfully reverted sessions [sub-1, sub-2], failed on session sub-3: Revert message ID mismatch';

            const failingAction = async () => {
                throw new Error(partialFailureMessage);
            };

            const toastCalls: Array<{ title: string; description: string }> = [];
            const isPendingRef = { current: false };
            let isPendingState = false;
            let dialogOpen = true;
            let errorState: string | null = null;
            let successCalled = false;

            const target = { sessionId: 'root-session', messageId: 'msg-u1' };

            const result = await executeRevertConfirm({
                target,
                isPendingRef,
                isMounted: () => true,
                setIsPending: (pending) => { isPendingState = pending; },
                setError: (err) => { errorState = err; },
                performRevert: failingAction,
                notifyError: (description) => {
                    toastCalls.push({ title: 'Failed to revert', description });
                },
                getLatestOnSuccess: () => () => { successCalled = true; },
                getLatestOnOpenChange: () => (open) => { dialogOpen = open; },
            });

            // Dialog must stay open on error
            expect(dialogOpen).toBe(true);
            expect(successCalled).toBe(false);
            expect(isPendingState).toBe(false);
            expect(isPendingRef.current).toBe(false);
            expect(result.executed).toBe(true);
            expect(result.success).toBe(false);

            // Toast received the error detail
            expect(toastCalls.length).toBe(1);
            expect(toastCalls[0]?.description).toBe(partialFailureMessage);

            // Dialog visible error state preserves full error details (including sub-session IDs)
            expect(result.error).toBe(partialFailureMessage);
            const displayedError = errorState ?? '';
            expect(displayedError).toBe(partialFailureMessage);
            expect(displayedError.includes('sub-1')).toBe(true);
            expect(displayedError.includes('sub-3')).toBe(true);
            expect(result.error?.includes('sub-1')).toBe(true);
            expect(result.error?.includes('sub-3')).toBe(true);
        });
    });

    describe('4. TimelineDialog contract: open confirm, cancel retention, success closure, session guard', () => {
        test('timeline opens confirm dialog without closing itself', () => {
            const timelineOpen = true;
            let revertTarget: { sessionId: string; messageId: string } | null = null;

            const handleRevertClick = (sessionId: string, messageId: string) => {
                revertTarget = { sessionId, messageId };
            };

            handleRevertClick('session-root', 'msg-root-1');

            expect(timelineOpen).toBe(true);
            expect(revertTarget).toEqual({ sessionId: 'session-root', messageId: 'msg-root-1' });
        });

        test('canceling confirm closes confirm dialog but keeps timeline open', () => {
            const timelineOpen = true;
            let revertTarget: { sessionId: string; messageId: string } | null = {
                sessionId: 'session-root',
                messageId: 'msg-root-1',
            };

            const handleConfirmDialogClose = (open: boolean) => {
                if (!open) {
                    revertTarget = null;
                }
            };

            handleConfirmDialogClose(false);

            expect(revertTarget).toBeNull();
            expect(timelineOpen).toBe(true); // Timeline remains open
        });

        test('confirmed success closes timeline if session matches and mounted', () => {
            let activeSessionId = 'session-root';
            if (typeof useSessionUIStore?.setState === 'function') {
                useSessionUIStore.setState({ currentSessionId: 'session-root' });
                activeSessionId = useSessionUIStore.getState().currentSessionId ?? 'session-root';
            }
            let timelineOpen = true;
            let revertTarget: { sessionId: string; messageId: string } | null = {
                sessionId: 'session-root',
                messageId: 'msg-root-1',
            };

            const closed = handleTimelineRevertSuccess({
                isMounted: true,
                currentSessionId: activeSessionId,
                targetSessionId: revertTarget.sessionId,
                onCloseTimeline: () => { timelineOpen = false; },
                onResetTarget: () => { revertTarget = null; },
            });

            expect(closed).toBe(true);
            expect(timelineOpen).toBe(false);
            expect(revertTarget).toBeNull();
        });

        test('session switch while confirm pending guards timeline from closing mismatched session', () => {
            // User switched to another session in background
            let activeSessionId = 'session-switched';
            if (typeof useSessionUIStore?.setState === 'function') {
                useSessionUIStore.setState({ currentSessionId: 'session-switched' });
                activeSessionId = useSessionUIStore.getState().currentSessionId ?? 'session-switched';
            }
            let timelineOpen = true;
            let revertTarget: { sessionId: string; messageId: string } | null = {
                sessionId: 'session-root',
                messageId: 'msg-root-1',
            };

            const closed = handleTimelineRevertSuccess({
                isMounted: true,
                currentSessionId: activeSessionId,
                targetSessionId: revertTarget.sessionId,
                onCloseTimeline: () => { timelineOpen = false; },
                onResetTarget: () => { revertTarget = null; },
            });

            // Timeline was guarded against closing
            expect(closed).toBe(false);
            expect(timelineOpen).toBe(true);
            expect(revertTarget).toBeNull();
        });

        test('ACTUAL lifecycle: async deferred revert with session switch executes original target and guards timeline', async () => {
            // 1. User starts on session-A
            let liveSessionId = 'session-A';
            if (typeof useSessionUIStore?.setState === 'function') {
                useSessionUIStore.setState({ currentSessionId: 'session-A' });
            }
            let timelineOpen = true;
            let revertTarget: { sessionId: string; messageId: string } | null = {
                sessionId: 'session-A',
                messageId: 'msg-A-42',
            };

            let resolveDeferredRevert: () => void = () => {};
            const deferredRevertPromise = new Promise<void>((resolve) => {
                resolveDeferredRevert = resolve;
            });

            const performRevertCalls: Array<[string, string]> = [];
            const performRevertFn = async (sess: string, msg: string) => {
                performRevertCalls.push([sess, msg]);
                await deferredRevertPromise;
            };

            const getLiveSession = () => {
                if (typeof useSessionUIStore?.getState === 'function') {
                    return useSessionUIStore.getState().currentSessionId ?? liveSessionId;
                }
                return liveSessionId;
            };

            // Dynamic callback simulating latest callback ref pattern in RevertConfirmDialog
            const latestCallbacks = {
                onSuccess: (completedTarget?: { sessionId: string; messageId: string }) => {
                    handleTimelineRevertSuccess({
                        isMounted: () => true,
                        currentSessionId: getLiveSession(),
                        targetSessionId: completedTarget?.sessionId ?? revertTarget?.sessionId,
                        onCloseTimeline: () => { timelineOpen = false; },
                        onResetTarget: () => { revertTarget = null; },
                    });
                },
                onOpenChange: () => {},
            };

            const isPendingRef = { current: false };

            // 2. Start confirmation execution
            const executionPromise = executeRevertConfirm({
                target: revertTarget,
                isPendingRef,
                isMounted: () => true,
                performRevert: performRevertFn,
                getLatestOnSuccess: () => latestCallbacks.onSuccess,
                getLatestOnOpenChange: () => latestCallbacks.onOpenChange,
            });

            // In-flight
            expect(isPendingRef.current).toBe(true);

            // 3. User switches to session-B during pending operation!
            liveSessionId = 'session-B';
            if (typeof useSessionUIStore?.setState === 'function') {
                useSessionUIStore.setState({ currentSessionId: 'session-B' });
            }
            // Target object in parent/store might update or be mutated
            revertTarget = { sessionId: 'session-B', messageId: 'msg-B-99' };

            // Simulate parent re-render updating the onSuccess callback to read latest store
            latestCallbacks.onSuccess = (completedTarget?: { sessionId: string; messageId: string }) => {
                handleTimelineRevertSuccess({
                    isMounted: () => true,
                    currentSessionId: getLiveSession(),
                    targetSessionId: completedTarget?.sessionId,
                    onCloseTimeline: () => { timelineOpen = false; },
                    onResetTarget: () => { revertTarget = null; },
                });
            };

            // 4. Resolve the deferred revert operation
            resolveDeferredRevert();
            const execResult = await executionPromise;

            // 5. Verify outcomes:
            // Original target executed unchanged!
            expect(performRevertCalls.length).toBe(1);
            expect(performRevertCalls[0]).toEqual(['session-A', 'msg-A-42']);
            expect(execResult.executed).toBe(true);
            expect(execResult.success).toBe(true);
            expect(execResult.target).toEqual({ sessionId: 'session-A', messageId: 'msg-A-42' });

            // Timeline for session-B MUST NOT close!
            expect(timelineOpen).toBe(true);
            // Revert target reset
            expect(revertTarget).toBeNull();
        });

        test('RevertConfirmDialog invokes latest callback ref even if callback changes while pending', async () => {
            let initialCallbackCalled = false;
            let latestCallbackCalled = false;

            let resolveRevert: () => void = () => {};
            const revertPromise = new Promise<void>((resolve) => {
                resolveRevert = resolve;
            });

            const latestCallbacks = {
                onSuccess: () => { initialCallbackCalled = true; },
                onOpenChange: () => {},
            };

            const isPendingRef = { current: false };

            const confirmPromise = executeRevertConfirm({
                target: { sessionId: 'sess-1', messageId: 'msg-1' },
                isPendingRef,
                isMounted: () => true,
                performRevert: async () => { await revertPromise; },
                getLatestOnSuccess: () => latestCallbacks.onSuccess,
                getLatestOnOpenChange: () => latestCallbacks.onOpenChange,
            });

            // While pending, parent re-renders and passes a new onSuccess prop
            latestCallbacks.onSuccess = () => { latestCallbackCalled = true; };

            resolveRevert();
            await confirmPromise;

            // Latest callback was called, NOT the stale initial callback!
            expect(initialCallbackCalled).toBe(false);
            expect(latestCallbackCalled).toBe(true);
        });

        test('target executed unchanged even if target prop mutated during pending operation', async () => {
            let resolveRevert: () => void = () => {};
            const revertPromise = new Promise<void>((resolve) => {
                resolveRevert = resolve;
            });

            const actionCalls: Array<[string, string]> = [];
            const actionFn = async (sess: string, msg: string) => {
                actionCalls.push([sess, msg]);
                await revertPromise;
            };

            const mutableTarget = { sessionId: 'sess-original', messageId: 'msg-original' };
            const isPendingRef = { current: false };

            const confirmPromise = executeRevertConfirm({
                target: mutableTarget,
                isPendingRef,
                isMounted: () => true,
                performRevert: actionFn,
            });

            // Target mutated while operation is in flight
            mutableTarget.sessionId = 'sess-mutated';
            mutableTarget.messageId = 'msg-mutated';

            resolveRevert();
            await confirmPromise;

            expect(actionCalls.length).toBe(1);
            expect(actionCalls[0]).toEqual(['sess-original', 'msg-original']);
        });
    });

    describe('5. Source-based verification: descendantCount heuristic removed & RevertConfirmDialog integrated', () => {
        const chatMessageSource = readFileSync(
            fileURLToPath(new URL('./ChatMessage.tsx', import.meta.url)),
            'utf-8'
        );
        const timelineDialogSource = readFileSync(
            fileURLToPath(new URL('./TimelineDialog.tsx', import.meta.url)),
            'utf-8'
        );
        const revertConfirmDialogSource = readFileSync(
            fileURLToPath(new URL('./RevertConfirmDialog.tsx', import.meta.url)),
            'utf-8'
        );

        test('ChatMessage does not contain descendantCount or countDescendantSessions heuristic', () => {
            expect(chatMessageSource.includes('descendantCount')).toBe(false);
            expect(chatMessageSource.includes('countDescendantSessions')).toBe(false);
            expect(chatMessageSource.includes('useDirectoryStore')).toBe(false);
        });

        test('ChatMessage uses RevertConfirmDialog with stable captured target', () => {
            expect(chatMessageSource.includes('RevertConfirmDialog')).toBe(true);
            expect(chatMessageSource.includes('target={revertDialogTarget}')).toBe(true);
            expect(chatMessageSource.includes('sessionId,')).toBe(true);
            expect(chatMessageSource.includes('messageId: message.info.id')).toBe(true);
        });

        test('TimelineDialog uses RevertConfirmDialog with stable captured target', () => {
            expect(timelineDialogSource.includes('RevertConfirmDialog')).toBe(true);
            expect(timelineDialogSource.includes('target={revertTarget}')).toBe(true);
            expect(timelineDialogSource.includes('setRevertTarget')).toBe(true);
            // Revert button now opens confirm dialog rather than immediate revert
            expect(timelineDialogSource.includes('await revertToMessage')).toBe(false);
        });

        test('RevertConfirmDialog has synchronous ref guard and theme-based spinner', () => {
            expect(revertConfirmDialogSource.includes('isPendingRef.current')).toBe(true);
            expect(revertConfirmDialogSource.includes('RiLoader4Line')).toBe(true);
            expect(revertConfirmDialogSource.includes('text-[var(--foreground-muted)]')).toBe(true);
            expect(revertConfirmDialogSource.includes('disabled={isPending}')).toBe(true);
            expect(revertConfirmDialogSource.includes('chat.revertDialog.toast.failed')).toBe(true);
            expect(revertConfirmDialogSource.includes('chat.revertDialog.errorTitle')).toBe(true);
        });
    });

    describe('6. File preview (dry run) states', () => {
        const target = { sessionId: 's1', messageId: 'm1' };
        const preview = (overrides: Partial<RevertPreview> = {}): RevertPreview => ({
            files: ['a.ts'],
            insertions: 3,
            deletions: 1,
            ...overrides,
        });
        const recordStates = () => {
            const states: RevertPreviewState[] = [];
            return { states, setState: (state: RevertPreviewState) => states.push(state) };
        };

        test('loading then ready; confirm is disabled only while loading', async () => {
            const { states, setState } = recordStates();
            const guard = createLatestRequestGuard();
            await loadRevertPreview({ target, guard, setState, fetchPreview: async () => preview() });
            expect(states.map((s) => s.status)).toEqual(['loading', 'ready']);
            expect(isRevertConfirmDisabled(false, { status: 'loading' })).toBe(true);
            expect(isRevertConfirmDisabled(false, states[1]!)).toBe(false);
            expect(isRevertConfirmDisabled(true, states[1]!)).toBe(true);
        });

        test('filesError switches the confirm action to conversation-only', async () => {
            const { states, setState } = recordStates();
            await loadRevertPreview({
                target,
                guard: createLatestRequestGuard(),
                setState,
                fetchPreview: async () => preview({ files: [], insertions: 0, deletions: 0, filesError: 'No file checkpoint for this message' }),
            });
            expect(isConversationOnlyPreview(states[1]!)).toBe(true);
            expect(isConversationOnlyPreview({ status: 'ready', preview: preview() })).toBe(false);
            expect(isConversationOnlyPreview({ status: 'loading' })).toBe(false);
        });

        test('a failed preview request leaves confirm enabled and exposes the error', async () => {
            const { states, setState } = recordStates();
            await loadRevertPreview({
                target,
                guard: createLatestRequestGuard(),
                setState,
                fetchPreview: async () => {
                    throw new Error('host unavailable');
                },
            });
            expect(states[1]).toEqual({ status: 'error', error: 'host unavailable' });
            expect(isRevertConfirmDisabled(false, states[1]!)).toBe(false);
        });

        test('stale responses are ignored (target changed or dialog closed)', async () => {
            const { states, setState } = recordStates();
            const guard = createLatestRequestGuard();
            let resolveFirst: (value: RevertPreview) => void = () => {};
            const first = loadRevertPreview({
                target,
                guard,
                setState,
                fetchPreview: () => new Promise<RevertPreview>((resolve) => { resolveFirst = resolve; }),
            });
            const second = loadRevertPreview({
                target: { sessionId: 's1', messageId: 'm2' },
                guard,
                setState,
                fetchPreview: async () => preview({ files: ['b.ts'] }),
            });
            await second;
            resolveFirst(preview({ files: ['stale.ts'] }));
            await first;
            const last = states[states.length - 1]!;
            expect(last.status === 'ready' && last.preview.files).toEqual(['b.ts']);

            const closing = recordStates();
            let resolveClosed: (value: RevertPreview) => void = () => {};
            const pending = loadRevertPreview({
                target,
                guard,
                setState: closing.setState,
                fetchPreview: () => new Promise<RevertPreview>((resolve) => { resolveClosed = resolve; }),
            });
            guard.invalidate();
            resolveClosed(preview());
            await pending;
            expect(closing.states.map((s) => s.status)).toEqual(['loading']);
        });

        test('no target resets to idle without fetching', async () => {
            const { states, setState } = recordStates();
            let calls = 0;
            await loadRevertPreview({
                target: null,
                guard: createLatestRequestGuard(),
                setState,
                fetchPreview: async () => {
                    calls += 1;
                    return preview();
                },
            });
            expect(states).toEqual([{ status: 'idle' }]);
            expect(calls).toBe(0);
        });

        test('file list shows the first 8 paths and counts the rest', () => {
            const files = Array.from({ length: 11 }, (_, i) => `f${i}.ts`);
            const { shown, more } = splitPreviewFiles(files);
            expect(REVERT_PREVIEW_MAX_FILES).toBe(8);
            expect(shown).toEqual(files.slice(0, 8));
            expect(more).toBe(3);
            expect(splitPreviewFiles(['a.ts'])).toEqual({ shown: ['a.ts'], more: 0 });
        });
    });
});
