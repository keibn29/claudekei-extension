import React from 'react';
import type { Session } from '@/lib/claude/types';
import { RiAddLine } from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { MainTab } from '@/stores/useUIStore';
import { SessionFolderItem } from '../SessionFolderItem';
import { DroppableFolderWrapper, SessionFolderDndScope } from './sessionFolderDnd';
import type { SortableDragHandleProps } from './sortableItems';
import type { GroupSearchData, SessionGroup, SessionNode } from './types';
import { compareSessionsByPinnedAndTime, normalizePath, renderHighlightedText } from './utils';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useI18n } from '@/lib/i18n';

type DeleteFolderConfirm = {
  scopeKey: string;
  folderId: string;
  folderName: string;
  subFolderCount: number;
  sessionCount: number;
} | null;

type Props = {
  group: SessionGroup;
  groupKey: string;
  projectId?: string | null;
  hideGroupLabel?: boolean;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  groupSearchDataByGroup: WeakMap<SessionGroup, GroupSearchData>;
  expandedSessionGroups: Set<string>;
  collapsedGroups: Set<string>;
  hideDirectoryControls: boolean;
  getFoldersForScope: (scopeKey: string) => SessionFolder[];
  collapsedFolderIds: Set<string>;
  toggleFolderCollapse: (folderId: string) => void;
  renameFolder: (scopeKey: string, folderId: string, name: string) => void;
  deleteFolder: (scopeKey: string, folderId: string) => void;
  showDeletionDialog: boolean;
  setDeleteFolderConfirm: React.Dispatch<React.SetStateAction<DeleteFolderConfirm>>;
  renderSessionNode: (node: SessionNode, depth?: number, groupDirectory?: string | null, projectId?: string | null, secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null) => React.ReactNode;
  currentSessionDirectory: string | null;
  toggleGroupSessionLimit: (groupKey: string) => void;
  mobileVariant: boolean;
  activeProjectId: string | null;
  setActiveProjectIdOnly: (id: string) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { directoryOverride?: string | null; targetFolderId?: string }) => void;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  createFolderAndStartRename: (scopeKey: string, parentId?: string | null) => { id: string } | null;
  renamingFolderId: string | null;
  renameFolderDraft: string;
  setRenameFolderDraft: React.Dispatch<React.SetStateAction<string>>;
  setRenamingFolderId: React.Dispatch<React.SetStateAction<string | null>>;
  pinnedSessionIds: Set<string>;
  sessionOrderIndex: Map<string, number>;
  onToggleCollapsedGroup: (groupKey: string) => void;
  dragHandleProps?: SortableDragHandleProps | null;
  compactBodyPadding?: boolean;
};

export function SessionGroupSection(props: Props): React.ReactNode {
  const { t } = useI18n();
  const {
    group,
    groupKey,
    projectId,
    hideGroupLabel,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    groupSearchDataByGroup,
    expandedSessionGroups,
    collapsedGroups,
    hideDirectoryControls,
    getFoldersForScope,
    collapsedFolderIds,
    toggleFolderCollapse,
    renameFolder,
    deleteFolder,
    showDeletionDialog,
    setDeleteFolderConfirm,
    renderSessionNode,
    toggleGroupSessionLimit,
    mobileVariant,
    activeProjectId,
    setActiveProjectIdOnly,
    setActiveMainTab,
    setSessionSwitcherOpen,
    openNewSessionDraft,
    addSessionToFolder,
    createFolderAndStartRename,
    renamingFolderId,
    renameFolderDraft,
    setRenameFolderDraft,
    setRenamingFolderId,
    pinnedSessionIds,
    sessionOrderIndex,
    onToggleCollapsedGroup,
    dragHandleProps,
    compactBodyPadding = false,
  } = props;

  const compareSessionNodes = React.useCallback((a: SessionNode, b: SessionNode) => {
    const aIndex = sessionOrderIndex.get(a.session.id);
    const bIndex = sessionOrderIndex.get(b.session.id);
    if (aIndex !== undefined || bIndex !== undefined) {
      if (aIndex === undefined) return 1;
      if (bIndex === undefined) return -1;
      if (aIndex !== bIndex) return aIndex - bIndex;
    }
    return compareSessionsByPinnedAndTime(a.session, b.session, pinnedSessionIds);
  }, [pinnedSessionIds, sessionOrderIndex]);

  const isVisibleSessionListNode = React.useCallback((node: SessionNode): boolean => {
    return !(node.session as Session & { parentID?: string | null }).parentID;
  }, []);

  const searchData = hasSessionSearchQuery ? groupSearchDataByGroup.get(group) : null;
  const displayMode = useSessionDisplayStore((state) => state.displayMode);
  const isMinimalMode = displayMode === 'minimal';
  const isExpanded = expandedSessionGroups.has(groupKey);
  const isCollapsed = hasSessionSearchQuery ? false : collapsedGroups.has(groupKey);
  const maxVisible = hideDirectoryControls ? 10 : 5;
  const groupMatchesSearch = hasSessionSearchQuery ? searchData?.groupMatches === true : false;
  const shouldFilterGroupContents = hasSessionSearchQuery;
  const sourceGroupNodes = React.useMemo(
    () => [...(shouldFilterGroupContents ? (searchData?.filteredNodes ?? []) : group.sessions)]
      .sort(compareSessionNodes),
    [compareSessionNodes, group.sessions, searchData?.filteredNodes, shouldFilterGroupContents],
  );
  const folderScopeKey = group.folderScopeKey ?? normalizePath(group.directory ?? null);
  const scopeFolders = React.useMemo(
    () => folderScopeKey ? getFoldersForScope(folderScopeKey) : [],
    [folderScopeKey, getFoldersForScope]
  );

  const nodeBySessionId = React.useMemo(() => {
    const map = new Map<string, SessionNode>();
    const collectNodeLookup = (nodes: SessionNode[]) => {
      nodes.forEach((node) => {
        map.set(node.session.id, node);
        if (node.children.length > 0) {
          collectNodeLookup(node.children);
        }
      });
    };
    collectNodeLookup(sourceGroupNodes);
    return map;
  }, [sourceGroupNodes]);

  const allFoldersForGroupBase = React.useMemo(() => scopeFolders.map((folder) => {
    const nodes = folder.sessionIds
      .map((sid) => nodeBySessionId.get(sid))
      .filter((n): n is SessionNode => n !== undefined && isVisibleSessionListNode(n))
      .sort(compareSessionNodes);
    return { folder, nodes };
  }), [scopeFolders, nodeBySessionId, compareSessionNodes, isVisibleSessionListNode]);

  const allFoldersForGroup = React.useMemo(() => {
    const folderMapById = new Map(allFoldersForGroupBase.map((entry) => [entry.folder.id, entry]));
    const childFolderIdsByParentId = new Map<string, string[]>();
    for (const { folder } of allFoldersForGroupBase) {
      if (!folder.parentId) continue;
      const existing = childFolderIdsByParentId.get(folder.parentId);
      if (existing) {
        existing.push(folder.id);
      } else {
        childFolderIdsByParentId.set(folder.parentId, [folder.id]);
      }
    }

    const keepByFolderId = new Map<string, boolean>();
    const shouldKeepFolder = (folderId: string): boolean => {
      const cached = keepByFolderId.get(folderId);
      if (cached !== undefined) return cached;

      const entry = folderMapById.get(folderId);
      if (!entry) {
        keepByFolderId.set(folderId, false);
        return false;
      }

      const childFolderIds = childFolderIdsByParentId.get(folderId) ?? [];

      if (!hasSessionSearchQuery) {
        keepByFolderId.set(folderId, true);
        return true;
      }

      const folderMatches = entry.folder.name.toLowerCase().includes(normalizedSessionSearchQuery);
      if (folderMatches || entry.nodes.length > 0) {
        keepByFolderId.set(folderId, true);
        return true;
      }

      const hasMatchingChildren = childFolderIds.some((childId) => shouldKeepFolder(childId));
      keepByFolderId.set(folderId, hasMatchingChildren);
      return hasMatchingChildren;
    };

    return allFoldersForGroupBase.filter(({ folder }) => shouldKeepFolder(folder.id));
  }, [allFoldersForGroupBase, hasSessionSearchQuery, normalizedSessionSearchQuery]);

  const sessionIdsInFolders = React.useMemo(() => new Set(allFoldersForGroup.flatMap((f) => f.folder.sessionIds)), [allFoldersForGroup]);
  const ungroupedSessions = React.useMemo(() => sourceGroupNodes.filter((node) => !sessionIdsInFolders.has(node.session.id)), [sourceGroupNodes, sessionIdsInFolders]);
  const rootFolders = React.useMemo(() => allFoldersForGroup.filter(({ folder }) => !folder.parentId), [allFoldersForGroup]);

  if (hasSessionSearchQuery && !groupMatchesSearch && rootFolders.length === 0 && ungroupedSessions.length === 0) {
    return null;
  }

  const totalSessions = ungroupedSessions.length;
  const visibleSessions = hasSessionSearchQuery
    ? ungroupedSessions
    : (isExpanded ? ungroupedSessions : ungroupedSessions.slice(0, maxVisible));
  const remainingCount = totalSessions - visibleSessions.length;

  const renderOneFolderItem = (folder: SessionFolder, nodes: SessionNode[], depth: number): React.ReactNode => {
    const directSubFolders = allFoldersForGroup.filter(({ folder: f }) => f.parentId === folder.id);
    const subFolderItems = directSubFolders.length > 0
      ? <>{directSubFolders.map(({ folder: sf, nodes: sn }) => renderOneFolderItem(sf, sn, depth + 1))}</>
      : undefined;

    return (
      <DroppableFolderWrapper key={folder.id} folderId={folder.id}>
        {(droppableRef, isDropTarget) => (
          <SessionFolderItem
            folder={folder}
            sessions={nodes}
            subFolderItems={subFolderItems}
            isCollapsed={hasSessionSearchQuery ? false : collapsedFolderIds.has(folder.id)}
            onToggle={() => toggleFolderCollapse(folder.id)}
            onRename={(name) => {
              if (folderScopeKey) renameFolder(folderScopeKey, folder.id, name);
            }}
            onDelete={() => {
              if (!folderScopeKey) return;
              if (!showDeletionDialog) {
                deleteFolder(folderScopeKey, folder.id);
                return;
              }
              const subFolderCount = allFoldersForGroup.filter(({ folder: f }) => f.parentId === folder.id).length;
              const sessionCount = nodes.length;
              setDeleteFolderConfirm({
                scopeKey: folderScopeKey,
                folderId: folder.id,
                folderName: folder.name,
                subFolderCount,
                sessionCount,
              });
            }}
            renderSessionNode={renderSessionNode}
            groupDirectory={group.directory}
            projectId={projectId}
            mobileVariant={mobileVariant}
            isRenaming={renamingFolderId === folder.id}
            renameDraft={renamingFolderId === folder.id ? renameFolderDraft : undefined}
            onRenameDraftChange={(value) => setRenameFolderDraft(value)}
            onRenameSave={() => {
              const trimmed = renameFolderDraft.trim();
              if (trimmed && folderScopeKey) {
                renameFolder(folderScopeKey, folder.id, trimmed);
              }
              setRenamingFolderId(null);
              setRenameFolderDraft('');
            }}
            onRenameCancel={() => {
              setRenamingFolderId(null);
              setRenameFolderDraft('');
            }}
            droppableRef={droppableRef}
            isDropTarget={isDropTarget}
            depth={depth}
            onNewSession={() => {
              if (projectId && projectId !== activeProjectId) setActiveProjectIdOnly(projectId);
              setActiveMainTab('chat');
              if (mobileVariant) setSessionSwitcherOpen(false);
              openNewSessionDraft({ directoryOverride: group.directory, targetFolderId: folder.id });
            }}
            onNewSubFolder={depth === 0 ? () => {
              if (!folderScopeKey) return;
              createFolderAndStartRename(folderScopeKey, folder.id);
            } : undefined}
            hideActions={false}
          />
        )}
      </DroppableFolderWrapper>
    );
  };

  const renderFolderItems = () => rootFolders.map(({ folder, nodes }) => renderOneFolderItem(folder, nodes, 0));
  const groupHeaderRightPadding = mobileVariant
    ? 'pr-7'
    : isMinimalMode
      ? 'pr-2'
      : 'pr-5';

  const body = (
    <SessionFolderDndScope
      scopeKey={folderScopeKey}
      hasFolders={allFoldersForGroup.length > 0}
      onSessionDroppedOnFolder={(sessionId, folderId) => {
        if (folderScopeKey) addSessionToFolder(folderScopeKey, folderId, sessionId);
      }}
    >
      {renderFolderItems()}
      {visibleSessions.map((node) => renderSessionNode(node, 0, group.directory, projectId))}
      {totalSessions === 0 && allFoldersForGroup.length === 0 ? (
        <div className="py-1 text-left typography-micro text-muted-foreground">
          {t('sessions.sidebar.group.empty.noSessionsInWorkspace')}
        </div>
      ) : null}
      {remainingCount > 0 && !isExpanded ? (
        <button
          type="button"
          onClick={() => toggleGroupSessionLimit(groupKey)}
          className="mt-0.5 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
        >
          {remainingCount === 1
            ? t('sessions.sidebar.group.showMoreSingle', { count: remainingCount })
            : t('sessions.sidebar.group.showMorePlural', { count: remainingCount })}
        </button>
      ) : null}
      {isExpanded && totalSessions > maxVisible ? (
        <button
          type="button"
          onClick={() => toggleGroupSessionLimit(groupKey)}
          className="mt-0.5 flex items-center justify-start rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline"
        >
          {t('sessions.sidebar.group.showFewer')}
        </button>
      ) : null}
    </SessionFolderDndScope>
  );

  const groupBodyPaddingClass = compactBodyPadding ? 'pb-2 pl-1' : 'pb-3 pl-4';

  if (hideGroupLabel) {
    return <div className="oc-group"><div className={cn('oc-group-body', groupBodyPaddingClass)}>{body}</div></div>;
  }

  return (
    <div className="oc-group">
      <div
        className={cn('group/gh relative flex items-start justify-between gap-1 py-1 min-w-0 rounded-md', 'cursor-pointer')}
        onClick={() => onToggleCollapsedGroup(groupKey)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggleCollapsedGroup(groupKey);
          }
        }}
        aria-label={isCollapsed
          ? t('sessions.sidebar.group.expandAria', { label: group.label })
          : t('sessions.sidebar.group.collapseAria', { label: group.label })}
        aria-expanded={!isCollapsed}
      >
        <div
          ref={dragHandleProps?.setActivatorNodeRef}
          className={cn(
            'min-w-0 flex flex-1 items-start gap-1 overflow-hidden pl-0.5 transition-[padding] cursor-grab active:cursor-grabbing',
            groupHeaderRightPadding,
          )}
          {...(dragHandleProps?.listeners ?? {})}
        >
          <div className="min-w-0 flex flex-1 flex-col justify-center gap-0.5 overflow-hidden">
            <p className="text-[14px] font-normal truncate text-foreground/92">
              {renderHighlightedText(group.label, normalizedSessionSearchQuery)}
            </p>
          </div>
        </div>
        {group.directory ? (
          <div className={cn('absolute right-0.5 top-1/2 -translate-y-1/2 z-10 transition-opacity', mobileVariant ? 'opacity-100' : 'opacity-0 group-hover/gh:opacity-100 group-focus-within/gh:opacity-100')}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    if (projectId && projectId !== activeProjectId) setActiveProjectIdOnly(projectId);
                    setActiveMainTab('chat');
                    if (mobileVariant) setSessionSwitcherOpen(false);
                    openNewSessionDraft({ directoryOverride: group.directory });
                  }}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  aria-label={t('sessions.sidebar.group.actions.newDraftInGroupAria', { label: group.label })}
                 >
                   <RiAddLine className="h-4 w-4" />
                 </button>
               </TooltipTrigger>
               <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.project.actions.newDraftSession')}</p></TooltipContent>
             </Tooltip>
           </div>
         ) : null}
      </div>
      {!isCollapsed ? <div className={cn('oc-group-body', groupBodyPaddingClass)}>{body}</div> : null}
    </div>
  );
}
