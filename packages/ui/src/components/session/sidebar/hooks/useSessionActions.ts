import React from 'react';
import type { Session } from '@/lib/claude/types';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

type DeleteSessionConfirmSetter = React.Dispatch<React.SetStateAction<{
  session: Session;
  descendantCount: number;
} | null>>;

type Args = {
  activeProjectId: string | null;
  currentDirectory: string | null;
  currentSessionId: string | null;
  mobileVariant: boolean;
  allowReselect: boolean;
  onSessionSelected?: (sessionId: string) => void;
  isSessionSearchOpen: boolean;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  setIsSessionSearchOpen: (open: boolean) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setDirectory: (directory: string, options?: { showOverlay?: boolean }) => void;
  setActiveMainTab: (tab: 'chat' | 'plan' | 'git' | 'diff' | 'terminal' | 'files') => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  setCurrentSession: (sessionId: string | null, directoryHint?: string | null) => void;
  updateSessionTitle: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<boolean>;
  deleteSessions: (ids: string[]) => Promise<{ deletedIds: string[]; failedIds: string[] }>;
  childrenMap: Map<string, Session[]>;
  showDeletionDialog: boolean;
  setDeleteSessionConfirm: DeleteSessionConfirmSetter;
  deleteSessionConfirm: { session: Session; descendantCount: number } | null;
  setEditingId: (id: string | null) => void;
  setEditTitle: (value: string) => void;
  editingId: string | null;
  editTitle: string;
};

export const useSessionActions = (args: Args) => {
  const { t } = useI18n();
  const handleSessionSelect = React.useCallback(
    (sessionId: string, sessionDirectory?: string | null, disabled?: boolean, projectId?: string | null) => {
      if (disabled) {
        return;
      }

      const resetSessionSearch = () => {
        if (!args.isSessionSearchOpen && args.sessionSearchQuery.length === 0) {
          return;
        }
        args.setSessionSearchQuery('');
        args.setIsSessionSearchOpen(false);
      };

      if (projectId && projectId !== args.activeProjectId) {
        args.setActiveProjectIdOnly(projectId);
      }

      if (sessionDirectory && sessionDirectory !== args.currentDirectory) {
        args.setDirectory(sessionDirectory, { showOverlay: false });
      }

      if (args.mobileVariant) {
        args.setActiveMainTab('chat');
        args.setSessionSwitcherOpen(false);
      }

      if (sessionId === args.currentSessionId) {
        if (args.allowReselect) {
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent<string>('openchamber:session-reselected', {
              detail: sessionId,
            }));
          }
          args.onSessionSelected?.(sessionId);
        }
        resetSessionSearch();
        return;
      }
      args.setCurrentSession(sessionId, sessionDirectory ?? null);
      args.onSessionSelected?.(sessionId);
      resetSessionSearch();
    },
    [args],
  );

  const handleSessionDoubleClick = React.useCallback(() => {
    args.setActiveMainTab('chat');
  }, [args]);

  const handleSaveEdit = React.useCallback(async () => {
    if (args.editingId && args.editTitle.trim()) {
      await args.updateSessionTitle(args.editingId, args.editTitle.trim());
      args.setEditingId(null);
      args.setEditTitle('');
    }
  }, [args]);

  const handleCancelEdit = React.useCallback(() => {
    args.setEditingId(null);
    args.setEditTitle('');
  }, [args]);

  const collectDescendants = React.useCallback((sessionId: string): Session[] => {
    const collected: Session[] = [];
    const visited = new Set<string>([sessionId]);
    const visit = (id: string) => {
      const children = args.childrenMap.get(id) ?? [];
      children.forEach((child) => {
        if (!visited.has(child.id)) {
          visited.add(child.id);
          visit(child.id);
          collected.push(child);
        }
      });
    };
    visit(sessionId);
    return collected;
  }, [args.childrenMap]);

  const executeDeleteSession = React.useCallback(
    async (session: Session) => {
      const descendants = collectDescendants(session.id);
      if (descendants.length === 0) {
        const success = await args.deleteSession(session.id);
        if (success) {
          toast.success(t('sessions.sidebar.session.delete.success'));
        } else {
          toast.error(t('sessions.sidebar.session.delete.error'));
        }
        return;
      }

      // Children first, then the parent.
      const ids = [...descendants.map((s) => s.id), session.id];
      const { deletedIds, failedIds } = await args.deleteSessions(ids);
      if (deletedIds.length > 0) {
        toast.success(deletedIds.length === 1
          ? t('sessions.sidebar.bulkActions.deletedSingle', { count: deletedIds.length })
          : t('sessions.sidebar.bulkActions.deletedPlural', { count: deletedIds.length }));
      }
      if (failedIds.length > 0) {
        toast.error(failedIds.length === 1
          ? t('sessions.sidebar.bulkActions.failedDeleteSingle', { count: failedIds.length })
          : t('sessions.sidebar.bulkActions.failedDeletePlural', { count: failedIds.length }));
      }
    },
    [args, collectDescendants, t],
  );

  const handleDeleteSession = React.useCallback(
    (session: Session) => {
      const descendants = collectDescendants(session.id);
      if (!args.showDeletionDialog) {
        void executeDeleteSession(session);
        return;
      }
      args.setDeleteSessionConfirm({
        session,
        descendantCount: descendants.length,
      });
    },
    [args, collectDescendants, executeDeleteSession],
  );

  const confirmDeleteSession = React.useCallback(async () => {
    if (!args.deleteSessionConfirm) return;
    const { session } = args.deleteSessionConfirm;
    args.setDeleteSessionConfirm(null);
    await executeDeleteSession(session);
  }, [args, executeDeleteSession]);

  return {
    handleSessionSelect,
    handleSessionDoubleClick,
    handleSaveEdit,
    handleCancelEdit,
    handleDeleteSession,
    confirmDeleteSession,
  };
};
