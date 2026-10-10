import React from 'react';
import type { Session } from '@/lib/claude/types';
import type { SessionGroup, SessionNode } from '../types';
import {
  compareSessionsByPinnedAndTime,
  dedupeSessionsById,
  normalizePath,
} from '../utils';
import { formatPathForDisplay } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

type Args = {
  homeDirectory: string | null;
  pinnedSessionIds: Set<string>;
};

export const useSessionGrouping = (args: Args) => {
  const { t } = useI18n();
  const buildGroupSearchText = React.useCallback((group: SessionGroup): string => {
    return [group.label, group.branch ?? '', group.description ?? '', group.directory ?? ''].join(' ').toLowerCase();
  }, []);

  const buildSessionSearchText = React.useCallback((session: Session): string => {
    const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null) ?? '';
    const sessionTitle = (session.title || t('sessions.sidebar.session.untitled')).trim();
    return `${sessionTitle} ${sessionDirectory}`.toLowerCase();
  }, [t]);

  const filterSessionNodesForSearch = React.useCallback(
    (nodes: SessionNode[], query: string): SessionNode[] => {
      if (!query) {
        return nodes;
      }

      return nodes.flatMap((node) => {
        const nodeMatches = buildSessionSearchText(node.session).includes(query);
        if (nodeMatches) {
          return [node];
        }

        return [];
      });
    },
    [buildSessionSearchText],
  );

  const buildGroupedSessions = React.useCallback(
    (
      projectSessions: Session[],
      projectRoot: string | null,
      projectRootBranch: string | null,
      projectIsRepo: boolean,
    ) => {
      const normalizedProjectRoot = normalizePath(projectRoot ?? null);
      const sortedProjectSessions = dedupeSessionsById(projectSessions)
        .sort((a, b) => compareSessionsByPinnedAndTime(a, b, args.pinnedSessionIds));

      const sessionMap = new Map(sortedProjectSessions.map((session) => [session.id, session]));
      const childrenMap = new Map<string, Session[]>();
      sortedProjectSessions.forEach((session) => {
        const parentID = (session as Session & { parentID?: string | null }).parentID;
        if (!parentID || !sessionMap.has(parentID)) return;
        const collection = childrenMap.get(parentID) ?? [];
        collection.push(session);
        childrenMap.set(parentID, collection);
      });
      childrenMap.forEach((list) => list.sort((a, b) => compareSessionsByPinnedAndTime(a, b, args.pinnedSessionIds)));

      const buildProjectNode = (session: Session): SessionNode => {
        const children = childrenMap.get(session.id) ?? [];
        return { session, children: children.map((child) => buildProjectNode(child)) };
      };

      const roots = sortedProjectSessions.filter((session) => {
        const parentID = (session as Session & { parentID?: string | null }).parentID;
        return !parentID || !sessionMap.has(parentID);
      });

      const groups: SessionGroup[] = [{
        id: 'root',
        label: (projectIsRepo && projectRootBranch && projectRootBranch !== 'HEAD')
          ? t('sessions.sidebar.grouping.projectRootWithBranch', { branch: projectRootBranch })
          : t('sessions.sidebar.grouping.projectRoot'),
        branch: projectRootBranch ?? null,
        description: normalizedProjectRoot ? formatPathForDisplay(normalizedProjectRoot, args.homeDirectory) : null,
        isMain: true,
        directory: normalizedProjectRoot,
        folderScopeKey: normalizedProjectRoot,
        sessions: roots.map((session) => buildProjectNode(session)),
      }];

      return groups;
    },
    [args.homeDirectory, args.pinnedSessionIds, t],
  );

  return {
    buildGroupSearchText,
    buildSessionSearchText,
    filterSessionNodesForSearch,
    buildGroupedSessions,
  };
};
