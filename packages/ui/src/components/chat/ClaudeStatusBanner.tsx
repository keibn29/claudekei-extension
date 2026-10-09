import React from 'react';
import { RiAlertLine, RiCloseLine, RiInformationLine, RiTerminalBoxLine } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useClaudeAuthStore } from '@/lib/claude/authState';
import { openClaudeLoginTerminal } from '@/lib/claude/loginTerminal';

type ClaudeStatusBannerProps = {
  sessionId: string | null;
};

/**
 * Banner above the composer: sign-in call to action when Claude is not authenticated, and
 * non-error notices when a hook blocked a prompt.
 */
export const ClaudeStatusBanner: React.FC<ClaudeStatusBannerProps> = ({ sessionId }) => {
  const { vscode } = useRuntimeAPIs();
  const authRequired = useClaudeAuthStore((state) => state.authRequired);
  const authMessage = useClaudeAuthStore((state) => state.message);
  const hookNotices = useClaudeAuthStore((state) => state.hookNotices);
  const dismissHookNotice = useClaudeAuthStore((state) => state.dismissHookNotice);

  const visibleNotices = React.useMemo(
    () => hookNotices.filter((notice) => !notice.sessionId || notice.sessionId === sessionId),
    [hookNotices, sessionId],
  );

  const handleOpenTerminal = React.useCallback(() => {
    void openClaudeLoginTerminal(vscode?.executeCommand).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Could not open a terminal. Run `claude login` manually.');
    });
  }, [vscode]);

  if (!authRequired && visibleNotices.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5 pb-2" data-claude-status-banner>
      {authRequired ? (
        <div
          role="alert"
          data-claude-banner="auth"
          className="flex items-start gap-2 rounded-xl border border-[var(--status-warning)]/40 bg-[var(--status-warning)]/10 px-3 py-2"
        >
          <RiAlertLine className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--status-warning)]" />
          <div className="min-w-0 flex-1">
            <div className="typography-meta font-medium text-foreground">
              Not signed in to Claude — run <code className="rounded bg-muted/40 px-1">claude login</code> in a terminal
            </div>
            {authMessage ? (
              <div className="typography-micro mt-0.5 break-words text-muted-foreground">{authMessage}</div>
            ) : null}
            {/* Below the text (not beside it) so the copy keeps its full width in a narrow sidebar. */}
            <Button type="button" size="xs" variant="outline" onClick={handleOpenTerminal} className="mt-2 gap-1">
              <RiTerminalBoxLine className="h-3.5 w-3.5" />
              Open terminal
            </Button>
          </div>
        </div>
      ) : null}

      {visibleNotices.map((notice) => (
        <div
          key={notice.id}
          role="status"
          data-claude-banner="hook"
          className="flex items-start gap-2 rounded-xl border border-border/40 bg-muted/20 px-3 py-2"
        >
          <RiInformationLine className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--status-info)]" />
          <div className="typography-meta min-w-0 flex-1 break-words text-foreground">{notice.message}</div>
          <button
            type="button"
            onClick={() => dismissHookNotice(notice.id)}
            className="-m-1 flex-shrink-0 rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
            aria-label="Dismiss notice"
          >
            <RiCloseLine className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
};
