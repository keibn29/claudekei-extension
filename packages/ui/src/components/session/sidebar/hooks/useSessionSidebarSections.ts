import React from 'react';
import type { Session } from '@/lib/claude/types';
import type { SessionGroup, SessionNode, GroupSearchData } from '../types';
import { normalizePath } from '../utils';

type ProjectItem = {
  id: string;
  path: string;
  label?: string;
  normalizedPath: string;
  icon?: string;
  color?: string;
};

type ProjectSection = {
  project: ProjectItem;
  groups: SessionGroup[];
};

type Args = {
  normalizedProjects: ProjectItem[];
  getSessionsForProject: (project: { normalizedPath: string }) => Session[];
  projectRepoStatus: Map<string, boolean | null>;
  projectRootBranches: Map<string, string | null>;
  lastRepoStatus: boolean;
  buildGroupedSessions: (
    sessions: Session[],
    projectRoot: string,
    rootBranch: string | null,
    isRepo: boolean,
  ) => SessionGroup[];
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  filterSessionNodesForSearch: (nodes: SessionNode[], query: string) => SessionNode[];
  buildGroupSearchText: (group: SessionGroup) => string;
  getFoldersForScope: (scopeKey: string) => Array<{ name: string }>;
};

export const useSessionSidebarSections = (args: Args) => {
  const {
    normalizedProjects,
    getSessionsForProject,
    projectRepoStatus,
    projectRootBranches,
    lastRepoStatus,
    buildGroupedSessions,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    filterSessionNodesForSearch,
    buildGroupSearchText,
    getFoldersForScope,
  } = args;

  const projectSections = React.useMemo<ProjectSection[]>(() => {
    return normalizedProjects.map((project) => {
      const projectSessions = getSessionsForProject(project);
      const isRepo = projectRepoStatus.has(project.id)
        ? Boolean(projectRepoStatus.get(project.id))
        : lastRepoStatus;
      const groups = buildGroupedSessions(
        projectSessions,
        project.normalizedPath,
        projectRootBranches.get(project.id) ?? null,
        isRepo,
      );
      return { project, groups };
    });
  }, [
    normalizedProjects,
    getSessionsForProject,
    projectRepoStatus,
    lastRepoStatus,
    buildGroupedSessions,
    projectRootBranches,
  ]);

  const visibleProjectSections = React.useMemo(() => {
    return projectSections;
  }, [projectSections]);

  const groupSearchDataByGroup = React.useMemo(() => {
    const result = new WeakMap<SessionGroup, GroupSearchData>();
    if (!hasSessionSearchQuery) {
      return result;
    }

    const countNodes = (nodes: SessionNode[]): number => nodes.reduce((total, node) => total + 1 + countNodes(node.children), 0);

    visibleProjectSections.forEach((section) => {
      section.groups.forEach((group) => {
        const filteredNodes = filterSessionNodesForSearch(group.sessions, normalizedSessionSearchQuery);
        const matchedSessionCount = countNodes(filteredNodes);
        const groupMatches = buildGroupSearchText(group).includes(normalizedSessionSearchQuery);
        const scopeKey = normalizePath(group.directory ?? null);
        const folderNameMatchCount = scopeKey
          ? getFoldersForScope(scopeKey).filter((folder) => folder.name.toLowerCase().includes(normalizedSessionSearchQuery)).length
          : 0;

        result.set(group, {
          filteredNodes,
          matchedSessionCount,
          folderNameMatchCount,
          groupMatches,
          hasMatch: groupMatches || matchedSessionCount > 0 || folderNameMatchCount > 0,
        });
      });
    });

    return result;
  }, [
    hasSessionSearchQuery,
    visibleProjectSections,
    filterSessionNodesForSearch,
    normalizedSessionSearchQuery,
    buildGroupSearchText,
    getFoldersForScope,
  ]);

  const searchableProjectSections = React.useMemo(() => {
    if (!hasSessionSearchQuery) {
      return visibleProjectSections;
    }

    return visibleProjectSections
      .map((section) => ({
        ...section,
        groups: section.groups.filter((group) => groupSearchDataByGroup.get(group)?.hasMatch === true),
      }))
      .filter((section) => section.groups.length > 0);
  }, [hasSessionSearchQuery, visibleProjectSections, groupSearchDataByGroup]);

  const sectionsForRender = hasSessionSearchQuery ? searchableProjectSections : visibleProjectSections;

  const searchMatchCount = React.useMemo(() => {
    if (!hasSessionSearchQuery) {
      return 0;
    }

    return sectionsForRender.reduce((total, section) => {
      return total + section.groups.reduce((groupTotal, group) => {
        const data = groupSearchDataByGroup.get(group);
        if (!data) {
          return groupTotal;
        }
        const metadataMatches = data.folderNameMatchCount + (data.groupMatches ? 1 : 0);
        return groupTotal + data.matchedSessionCount + metadataMatches;
      }, 0);
    }, 0);
  }, [hasSessionSearchQuery, sectionsForRender, groupSearchDataByGroup]);

  return {
    projectSections,
    visibleProjectSections,
    groupSearchDataByGroup,
    searchableProjectSections,
    sectionsForRender,
    searchMatchCount,
  };
};
