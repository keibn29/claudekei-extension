import React from 'react';
import type { Session } from '@/lib/claude/types';
import { normalizePath } from '../utils';

type Args = {
  sessions: Session[];
};

export const useProjectSessionLists = (args: Args) => {
  const { sessions } = args;

  const sessionsByDirectory = React.useMemo(() => {
    const next = new Map<string, Session[]>();
    sessions.forEach((session) => {
      const directory = normalizePath((session as Session & { directory?: string | null }).directory ?? null)
        ?? normalizePath((session as Session & { project?: { worktree?: string | null } | null }).project?.worktree ?? null);
      if (!directory) {
        return;
      }

      const collection = next.get(directory) ?? [];
      collection.push(session);
      next.set(directory, collection);
    });
    return next;
  }, [sessions]);

  const getSessionsForProject = React.useCallback(
    (project: { normalizedPath: string }) => sessionsByDirectory.get(project.normalizedPath) ?? [],
    [sessionsByDirectory],
  );

  return {
    getSessionsForProject,
  };
};
