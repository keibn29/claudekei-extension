import React from 'react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { RiLoader4Line } from '@remixicon/react';
import { useI18n } from '@/lib/i18n';
import { claudeClient } from '@/lib/claude/client';
import { revertToMessage } from '@/sync/session-actions';
import { useSessionStatus } from '@/sync/sync-context';
import {
    createLatestRequestGuard,
    executeRevertConfirm,
    isConversationOnlyPreview,
    isRevertConfirmDisabled,
    loadRevertPreview,
    splitPreviewFiles,
    type RevertPreviewState,
    type RevertConfirmTarget,
    type RevertExecutionResult,
    type ExecuteRevertConfirmOptions,
} from './revertConfirmUtils';

export type { RevertConfirmTarget, RevertExecutionResult, ExecuteRevertConfirmOptions };

export interface RevertConfirmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    target: RevertConfirmTarget | null;
    onConfirm?: () => Promise<void> | void;
    onSuccess?: (target?: RevertConfirmTarget) => void;
}

const RevertPreviewBody: React.FC<{ state: RevertPreviewState; isBusy: boolean }> = ({ state, isBusy }) => {
    const { t } = useI18n();

    let content: React.ReactNode = null;
    if (state.status === 'loading') {
        content = (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <RiLoader4Line className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                {t('chat.revertDialog.checkingFiles')}
            </p>
        );
    } else if (state.status === 'ready') {
        const { preview } = state;
        if (preview.filesError) {
            content = (
                <p className="rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3 text-xs text-[var(--status-warning)] break-words">
                    {t('chat.revertDialog.filesUnavailable', { error: preview.filesError })}
                </p>
            );
        } else if (preview.files.length === 0) {
            content = <p className="text-xs text-muted-foreground">{t('chat.revertDialog.filesNone')}</p>;
        } else {
            const { shown, more } = splitPreviewFiles(preview.files);
            content = (
                <div className="space-y-2 text-xs">
                    <p className="flex items-baseline justify-between gap-2 font-medium text-foreground">
                        <span>{t('chat.revertDialog.filesHeading', { count: preview.files.length })}</span>
                        <span className="font-mono text-[11px] shrink-0">
                            <span className="text-[var(--status-success)]">+{preview.insertions}</span>{' '}
                            <span className="text-[var(--status-error)]">{'\u2212'}{preview.deletions}</span>
                        </span>
                    </p>
                    <ul className="space-y-0.5">
                        {shown.map((file) => (
                            <li key={file} className="truncate font-mono text-[11px] text-muted-foreground" title={file}>
                                {file}
                            </li>
                        ))}
                    </ul>
                    {more > 0 ? <p className="text-muted-foreground">{t('chat.revertDialog.moreFiles', { count: more })}</p> : null}
                    <p className="text-muted-foreground/80">{t('chat.revertDialog.filesNote')}</p>
                </div>
            );
        }
    }

    if (!content && !isBusy) return null;
    return (
        <div className="space-y-2">
            {content}
            {isBusy ? <p className="text-xs text-muted-foreground/80">{t('chat.revertDialog.busyNote')}</p> : null}
        </div>
    );
};

export const RevertConfirmDialog: React.FC<RevertConfirmDialogProps> = ({
    open,
    onOpenChange,
    target,
    onConfirm,
    onSuccess,
}) => {
    const { t } = useI18n();
    const [isPending, setIsPending] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const [previewState, setPreviewState] = React.useState<RevertPreviewState>({ status: 'idle' });
    const previewGuardRef = React.useRef(createLatestRequestGuard());
    const sessionStatus = useSessionStatus(target?.sessionId ?? '');
    const isBusy = sessionStatus !== undefined && sessionStatus.type !== 'idle';
    const targetSessionId = target?.sessionId;
    const targetMessageId = target?.messageId;

    const isPendingRef = React.useRef(false);
    const isMountedRef = React.useRef(true);
    const onSuccessRef = React.useRef(onSuccess);
    onSuccessRef.current = onSuccess;
    const onOpenChangeRef = React.useRef(onOpenChange);
    onOpenChangeRef.current = onOpenChange;
    const onConfirmRef = React.useRef(onConfirm);
    onConfirmRef.current = onConfirm;

    React.useEffect(() => {
        isMountedRef.current = true;
        return () => {
            isMountedRef.current = false;
        };
    }, []);

    // Clear error when dialog opens or target changes
    React.useEffect(() => {
        if (open) {
            setError(null);
        }
    }, [open, target?.sessionId, target?.messageId]);

    // Dry run of the file rewind: which files would be restored. Re-runs when the target changes.
    React.useEffect(() => {
        const guard = previewGuardRef.current;
        if (!open || !targetSessionId || !targetMessageId) {
            guard.invalidate();
            setPreviewState({ status: 'idle' });
            return;
        }
        void loadRevertPreview({
            target: { sessionId: targetSessionId, messageId: targetMessageId },
            fetchPreview: claudeClient.revertPreview,
            guard,
            setState: setPreviewState,
        });
        return () => guard.invalidate();
    }, [open, targetSessionId, targetMessageId]);

    const handleCancel = React.useCallback(() => {
        if (isPendingRef.current) return;
        setError(null);
        onOpenChangeRef.current?.(false);
    }, []);

    const handleOpenChange = React.useCallback(
        (nextOpen: boolean) => {
            if (isPendingRef.current) {
                // Prevent dismissal while pending (Esc / backdrop / wrapper trigger)
                return;
            }
            if (!nextOpen) {
                setError(null);
            }
            onOpenChangeRef.current?.(nextOpen);
        },
        []
    );

    const handleConfirm = React.useCallback(async () => {
        return executeRevertConfirm({
            target,
            isPendingRef,
            isMounted: () => isMountedRef.current,
            setIsPending,
            setError,
            onConfirm: onConfirmRef.current,
            getLatestOnSuccess: () => onSuccessRef.current,
            getLatestOnOpenChange: () => onOpenChangeRef.current,
            performRevert: revertToMessage,
            notifyError: (errorDetail) => {
                toast.error(t('chat.revertDialog.toast.failed'), {
                    description: errorDetail,
                });
            },
        });
    }, [target, t]);

    const errorText = error ?? (previewState.status === 'error' ? previewState.error : null);
    const conversationOnly = isConversationOnlyPreview(previewState);

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent showCloseButton={!isPending} className="max-w-sm gap-5">
                <DialogHeader>
                    <DialogTitle>{t('chat.revertDialog.title')}</DialogTitle>
                    <DialogDescription className="space-y-2 text-left">
                        <span className="block">{t('chat.revertDialog.description')}</span>
                    </DialogDescription>
                </DialogHeader>

                <RevertPreviewBody state={previewState} isBusy={isBusy} />

                {errorText ? (
                    <div
                        role="alert"
                        className="rounded-lg border border-[var(--status-error)]/30 bg-[color-mix(in_srgb,var(--status-error)_8%,var(--surface-elevated))] p-3 text-xs text-[var(--status-error)] break-words"
                    >
                        <p className="font-semibold">{t('chat.revertDialog.errorTitle')}</p>
                        <p className="mt-1 font-mono text-[11px] leading-relaxed select-text whitespace-pre-wrap">
                            {errorText}
                        </p>
                    </div>
                ) : null}

                <DialogFooter>
                    <Button
                        type="button"
                        onClick={handleCancel}
                        variant="outline"
                        size="sm"
                        disabled={isPending}
                    >
                        {t('chat.revertDialog.cancel')}
                    </Button>
                    <Button
                        type="button"
                        onClick={handleConfirm}
                        size="sm"
                        disabled={isRevertConfirmDisabled(isPending, previewState)}
                        className="gap-1.5"
                    >
                        {isPending ? (
                            <>
                                <RiLoader4Line
                                    className="h-4 w-4 animate-spin text-[var(--foreground-muted)]"
                                    aria-hidden="true"
                                />
                                <span>{t('chat.revertDialog.reverting')}</span>
                            </>
                        ) : (
                            t(conversationOnly ? 'chat.revertDialog.confirmConversationOnly' : 'chat.revertDialog.confirm')
                        )}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default RevertConfirmDialog;
