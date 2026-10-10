import React from 'react';
import type { Session } from '@/lib/claude/types';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { normalizePath } from '../utils';

type Args = {
  isSessionsLoading: boolean;
  sessions: Session[];
  cleanupSessions: (scopeKey: string, validSessionIds: Set<string>) => void;
};

export const useSessionFolderCleanup = (args: Args): void => {
  const {
    isSessionsLoading,
    sessions,
    cleanupSessions,
  } = args;

  React.useEffect(() => {
    if (isSessionsLoading) {
      return;
    }

    const idsByScope = new Map<string, Set<string>>();
    sessions.forEach((session) => {
      const directory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
      if (!directory) {
        return;
      }
      const existing = idsByScope.get(directory);
      if (existing) {
        existing.add(session.id);
        return;
      }
      idsByScope.set(directory, new Set([session.id]));
    });

    const currentFoldersMap = useSessionFoldersStore.getState().foldersMap;
    const allScopeKeys = new Set([...Object.keys(currentFoldersMap), ...idsByScope.keys()]);
    allScopeKeys.forEach((scopeKey) => {
      cleanupSessions(scopeKey, idsByScope.get(scopeKey) ?? new Set<string>());
    });
  }, [
    cleanupSessions,
    isSessionsLoading,
    sessions,
  ]);
};
