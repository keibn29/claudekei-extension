import React from 'react';
import type { Session } from '@/lib/claude/types';
import { RiLayoutLeftLine } from '@remixicon/react';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { isDesktopLocalOriginActive, isDesktopShell, isTauriShell } from '@/lib/desktop';
import { isDesktopWindowFullscreen as getDesktopWindowFullscreen, onDesktopWindowResized, startDesktopWindowDrag } from '@/lib/desktopNative';
import { sessionEvents } from '@/lib/sessionEvents';
import { formatDirectoryName, cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSync } from '@/sync/use-sync';
import { useSessionPrefetch } from './sidebar/hooks/useSessionPrefetch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { useGitRepoStatusMap } from '@/stores/useGitStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useSessionSidebarSections } from './sidebar/hooks/useSessionSidebarSections';
import { useProjectSessionSelection } from './sidebar/hooks/useProjectSessionSelection';
import { useGroupOrdering } from './sidebar/hooks/useGroupOrdering';
import { useSessionGrouping } from './sidebar/hooks/useSessionGrouping';
import { useSessionSearchEffects } from './sidebar/hooks/useSessionSearchEffects';
import { useDirectoryStatusProbe } from './sidebar/hooks/useDirectoryStatusProbe';
import { useSessionActions } from './sidebar/hooks/useSessionActions';
import { useSidebarPersistence } from './sidebar/hooks/useSidebarPersistence';
import { useProjectRepoStatus } from './sidebar/hooks/useProjectRepoStatus';
import { useProjectSessionLists } from './sidebar/hooks/useProjectSessionLists';
import { useSessionFolderCleanup } from './sidebar/hooks/useSessionFolderCleanup';
import { useStickyProjectHeaders } from './sidebar/hooks/useStickyProjectHeaders';
import { ProjectEditDialog } from '@/components/layout/ProjectEditDialog';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import { SessionGroupSection } from './sidebar/SessionGroupSection';
import { SidebarHeader } from './sidebar/SidebarHeader';
import { SidebarFooter } from './sidebar/SidebarFooter';
import { SidebarProjectsList } from './sidebar/SidebarProjectsList';
import { SessionNodeItem } from './sidebar/SessionNodeItem';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useShallow } from 'zustand/react/shallow';
import type { SortableDragHandleProps } from './sidebar/sortableItems';
import {
  BulkSessionDeleteConfirmDialog,
  FolderDeleteConfirmDialog,
  SessionDeleteConfirmDialog,
  type BulkDeleteSessionsConfirmState,
  type DeleteFolderConfirmState,
  type DeleteSessionConfirmState,
} from './sidebar/ConfirmDialogs';
import { BulkActionBar } from './sidebar/BulkActionBar';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { type SessionGroup, type SessionNode } from './sidebar/types';
import {
  compareSessionsByPinnedAndTime,
  normalizePath,
} from './sidebar/utils';
import { refreshGlobalSessions, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

const PROJECT_COLLAPSE_STORAGE_KEY = 'oc.sessions.projectCollapse';
const GROUP_ORDER_STORAGE_KEY = 'oc.sessions.groupOrder';
const GROUP_COLLAPSE_STORAGE_KEY = 'oc.sessions.groupCollapse';
const PROJECT_ACTIVE_SESSION_STORAGE_KEY = 'oc.sessions.activeSessionByProject';
const SESSION_EXPANDED_STORAGE_KEY = 'oc.sessions.expandedParents';
const SESSION_PINNED_STORAGE_KEY = 'oc.sessions.pinned';

interface SessionSidebarProps {
  mobileVariant?: boolean;
  onSessionSelected?: (sessionId: string) => void;
  allowReselect?: boolean;
  hideDirectoryControls?: boolean;
  showOnlyMainWorkspace?: boolean;
}

export const SessionSidebar: React.FC<SessionSidebarProps> = ({
  mobileVariant = false,
  onSessionSelected,
  allowReselect = false,
  hideDirectoryControls = false,
  showOnlyMainWorkspace = false,
}) => {
  const { t } = useI18n();
  const [isSessionSearchOpen, setIsSessionSearchOpen] = React.useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = React.useState('');
  const sessionSearchContainerRef = React.useRef<HTMLDivElement | null>(null);
  const sessionSearchInputRef = React.useRef<HTMLInputElement | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editTitle, setEditTitle] = React.useState('');
  const [editingProjectDialogId, setEditingProjectDialogId] = React.useState<string | null>(null);
  const [expandedParents, setExpandedParents] = React.useState<Set<string>>(new Set());
  const [directoryStatus, setDirectoryStatus] = React.useState<Map<string, 'unknown' | 'exists' | 'missing'>>(
    () => new Map(),
  );
  const safeStorage = React.useMemo(() => getSafeStorage(), []);
  const [collapsedProjects, setCollapsedProjects] = React.useState<Set<string>>(new Set());

  const [projectRepoStatus, setProjectRepoStatus] = React.useState<Map<string, boolean | null>>(new Map());
  const [expandedSessionGroups, setExpandedSessionGroups] = React.useState<Set<string>>(new Set());
  const [updateDialogOpen, setUpdateDialogOpen] = React.useState(false);
  const [openSidebarMenuKey, setOpenSidebarMenuKey] = React.useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = React.useState<string | null>(null);
  const [renameFolderDraft, setRenameFolderDraft] = React.useState('');
  const [deleteSessionConfirm, setDeleteSessionConfirm] = React.useState<DeleteSessionConfirmState>(null);
  const [deleteFolderConfirm, setDeleteFolderConfirm] = React.useState<DeleteFolderConfirmState>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = React.useState<BulkDeleteSessionsConfirmState>(null);
  const [pinnedSessionIds, setPinnedSessionIds] = React.useState<Set<string>>(() => {
    try {
      const raw = getSafeStorage().getItem(SESSION_PINNED_STORAGE_KEY);
      if (!raw) {
        return new Set();
      }
      const parsed = JSON.parse(raw) as string[];
      return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(() => {
    try {
      const raw = getSafeStorage().getItem(GROUP_COLLAPSE_STORAGE_KEY);
      if (!raw) {
        return new Set();
      }
      const parsed = JSON.parse(raw) as string[];
      return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const [groupOrderByProject, setGroupOrderByProject] = React.useState<Map<string, string[]>>(() => {
    try {
      const raw = getSafeStorage().getItem(GROUP_ORDER_STORAGE_KEY);
      if (!raw) {
        return new Map();
      }
      const parsed = JSON.parse(raw) as Record<string, string[]>;
      const next = new Map<string, string[]>();
      Object.entries(parsed).forEach(([projectId, order]) => {
        if (Array.isArray(order)) {
          next.set(projectId, order.filter((item) => typeof item === 'string'));
        }
      });
      return next;
    } catch {
      return new Map();
    }
  });
  const [activeSessionByProject, setActiveSessionByProject] = React.useState<Map<string, string>>(() => {
    try {
      const raw = getSafeStorage().getItem(PROJECT_ACTIVE_SESSION_STORAGE_KEY);
      if (!raw) {
        return new Map();
      }
      const parsed = JSON.parse(raw) as Record<string, string>;
      const next = new Map<string, string>();
      Object.entries(parsed).forEach(([projectId, sessionId]) => {
        if (typeof sessionId === 'string' && sessionId.length > 0) {
          next.set(projectId, sessionId);
        }
      });
      return next;
    } catch {
      return new Map();
    }
  });

  const [projectRootBranches, setProjectRootBranches] = React.useState<Map<string, string>>(new Map());
  const projectHeaderSentinelRefs = React.useRef<Map<string, HTMLDivElement | null>>(new Map());
  const ignoreIntersectionUntil = React.useRef<number>(0);

  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);

  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const addProject = useProjectsStore((state) => state.addProject);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);
  const reorderProjects = useProjectsStore((state) => state.reorderProjects);

  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const toggleHelpDialog = useUIStore((state) => state.toggleHelpDialog);
  const setAboutDialogOpen = useUIStore((state) => state.setAboutDialogOpen);
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const notifyOnSubtasks = useUIStore((state) => state.notifyOnSubtasks);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);

  const debouncedSessionSearchQuery = useDebouncedValue(sessionSearchQuery, 120);
  const normalizedSessionSearchQuery = React.useMemo(
    () => debouncedSessionSearchQuery.trim().toLowerCase(),
    [debouncedSessionSearchQuery],
  );

  const hasSessionSearchQuery = normalizedSessionSearchQuery.length > 0;

  // Session Folders store
  const collapsedFolderIds = useSessionFoldersStore((state) => state.collapsedFolderIds);
  const foldersMap = useSessionFoldersStore((state) => state.foldersMap);
  const getFoldersForScope = useSessionFoldersStore((state) => state.getFoldersForScope);
  const createFolder = useSessionFoldersStore((state) => state.createFolder);
  const renameFolder = useSessionFoldersStore((state) => state.renameFolder);
  const deleteFolder = useSessionFoldersStore((state) => state.deleteFolder);
  const addSessionToFolder = useSessionFoldersStore((state) => state.addSessionToFolder);
  const addSessionsToFolder = useSessionFoldersStore((state) => state.addSessionsToFolder);
  const removeSessionFromFolder = useSessionFoldersStore((state) => state.removeSessionFromFolder);
  const removeSessionsFromFolders = useSessionFoldersStore((state) => state.removeSessionsFromFolders);
  const toggleFolderCollapse = useSessionFoldersStore((state) => state.toggleFolderCollapse);
  const cleanupSessions = useSessionFoldersStore((state) => state.cleanupSessions);
  const getSessionFolderId = useSessionFoldersStore((state) => state.getSessionFolderId);

  useSessionSearchEffects({
    isSessionSearchOpen,
    setIsSessionSearchOpen,
    sessionSearchInputRef,
    sessionSearchContainerRef,
  });

  const sync = useSync();
  const liveSessions = useAllLiveSessions();
  const hasLoadedGlobalSessions = useGlobalSessionsStore((state) => state.hasLoaded);
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  // sessionAttentionStates removed — now using notification-store directly in SessionNodeItem
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const updateStore = useUpdateStore(useShallow((s) => ({
    checkForUpdates: s.checkForUpdates,
    available: s.available,
    runtimeType: s.runtimeType,
    info: s.info,
    downloading: s.downloading,
    downloaded: s.downloaded,
    progress: s.progress,
    error: s.error,
    downloadUpdate: s.downloadUpdate,
    restartToUpdate: s.restartToUpdate,
  })));

  const sessions = React.useMemo(() => {
    const liveById = new Map(liveSessions.map((session) => [session.id, session]));
    const merged = globalActiveSessions.map((session) => liveById.get(session.id) ?? session);
    const seenIds = new Set(merged.map((session) => session.id));

    liveSessions.forEach((session) => {
      if (seenIds.has(session.id)) {
        return;
      }
      merged.push(session);
    });

    return merged;
  }, [globalActiveSessions, liveSessions]);

  const syncSessionStructureSignature = React.useMemo(
    () => liveSessions
      .map((session) => {
        const directory = normalizePath((session as Session & { directory?: string | null }).directory ?? null) ?? '';
        return `${session.id}:${session.title ?? ''}:${directory}`;
      })
      .join('|'),
    [liveSessions],
  );

  const syncSessionsSnapshotRef = React.useRef<Session[]>(liveSessions);
  React.useEffect(() => {
    syncSessionsSnapshotRef.current = liveSessions;
  }, [syncSessionStructureSignature, liveSessions]);

  React.useEffect(() => {
    void refreshGlobalSessions(syncSessionsSnapshotRef.current);
  }, [currentDirectory, syncSessionStructureSignature]);

  const tauriIpcAvailable = React.useMemo(() => isTauriShell(), []);
  const isDesktopShellRuntime = React.useMemo(() => isDesktopShell(), []);
  const [isDesktopWindowFullscreen, setIsDesktopWindowFullscreen] = React.useState(false);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const isMacPlatform = React.useMemo(() => {
    if (typeof navigator === 'undefined') {
      return false;
    }
    return /Macintosh|Mac OS X/.test(navigator.userAgent || '');
  }, []);
  const isWebRuntime = !mobileVariant && !isVSCode && !isDesktopShellRuntime;
  const showDesktopSidebarChrome = !mobileVariant && !isVSCode && !isWebRuntime;
  const desktopSidebarTopPaddingClass = isDesktopShellRuntime && isMacPlatform && !isDesktopWindowFullscreen ? 'pl-[5.5rem]' : 'pl-3';
  const desktopSidebarToggleButtonClass = 'app-region-no-drag inline-flex h-8 w-8 items-center justify-center rounded-md typography-ui-label font-medium text-foreground transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50';

  React.useEffect(() => {
    if (!isDesktopShellRuntime || !isMacPlatform) {
      setIsDesktopWindowFullscreen(false);
      return;
    }

    let disposed = false;
    let unlistenResize: (() => void) | null = null;

    const syncFullscreenState = async () => {
      try {
        const fullscreen = await getDesktopWindowFullscreen();
        if (!disposed) {
          setIsDesktopWindowFullscreen(fullscreen);
        }
      } catch {
        if (!disposed) {
          setIsDesktopWindowFullscreen(false);
        }
      }
    };

    const attach = async () => {
      try {
        unlistenResize = onDesktopWindowResized(() => {
          void syncFullscreenState();
        });
      } catch {
        // Ignore listener setup failures; fallback state remains false.
      }
    };

    void syncFullscreenState();
    void attach();

    return () => {
      disposed = true;
      if (unlistenResize) {
        unlistenResize();
      }
    };
  }, [isDesktopShellRuntime, isMacPlatform]);

  const handleDesktopSidebarDragStart = React.useCallback(async (event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('.app-region-no-drag')) {
      return;
    }
    if (target.closest('button, a, input, select, textarea')) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    if (!isDesktopShellRuntime) {
      return;
    }

    await startDesktopWindowDrag();
  }, [isDesktopShellRuntime]);

  const {
    buildGroupSearchText,
    filterSessionNodesForSearch,
    buildGroupedSessions,
  } = useSessionGrouping({
    homeDirectory,
    pinnedSessionIds,
  });

  const { scheduleCollapsedProjectsPersist } = useSidebarPersistence({
    isVSCode,
    hasLoadedGlobalSessions,
    safeStorage,
    keys: {
      sessionExpanded: SESSION_EXPANDED_STORAGE_KEY,
      projectCollapse: PROJECT_COLLAPSE_STORAGE_KEY,
      sessionPinned: SESSION_PINNED_STORAGE_KEY,
      groupOrder: GROUP_ORDER_STORAGE_KEY,
      projectActiveSession: PROJECT_ACTIVE_SESSION_STORAGE_KEY,
      groupCollapse: GROUP_COLLAPSE_STORAGE_KEY,
    },
    sessions,
    pinnedSessionIds,
    setPinnedSessionIds,
    groupOrderByProject,
    activeSessionByProject,
    collapsedGroups,
    setExpandedParents,
    setCollapsedProjects,
  });

  const togglePinnedSession = React.useCallback((sessionId: string) => {
    setPinnedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const sortedSessions = React.useMemo(() => {
    return [...sessions].sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds));
  }, [sessions, pinnedSessionIds]);

  const sessionOrderIndex = React.useMemo(
    () => new Map(sortedSessions.map((session, index) => [session.id, index])),
    [sortedSessions],
  );

  const childrenMap = React.useMemo(() => {
    const map = new Map<string, Session[]>();
    sortedSessions.forEach((session) => {
      const parentID = (session as Session & { parentID?: string | null }).parentID;
      if (!parentID) {
        return;
      }
      const collection = map.get(parentID) ?? [];
      collection.push(session);
      map.set(parentID, collection);
    });
    map.forEach((list) => list.sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds)));
    return map;
  }, [sortedSessions, pinnedSessionIds]);

  useDirectoryStatusProbe({
    sortedSessions,
    projects,
    directoryStatus,
    setDirectoryStatus,
  });

  const emptyState = (
    <div className="py-6 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">{t('sessions.sidebar.empty.noSessions.title')}</p>
      <p className="typography-meta mt-1">{t('sessions.sidebar.empty.noSessions.description')}</p>
    </div>
  );

  const editingProject = React.useMemo(
    () => projects.find((project) => project.id === editingProjectDialogId) ?? null,
    [projects, editingProjectDialogId],
  );

  const handleSaveProjectEdit = React.useCallback((data: { label: string; icon: string | null; color: string | null }) => {
    if (!editingProjectDialogId) {
      return;
    }
    updateProjectMeta(editingProjectDialogId, data);
    setEditingProjectDialogId(null);
  }, [editingProjectDialogId, updateProjectMeta]);

  const handleOpenUpdateDialog = React.useCallback(() => {
    const current = useUpdateStore.getState();
    if (current.available && current.info) {
      setUpdateDialogOpen(true);
      return;
    }

    void updateStore.checkForUpdates().then(() => {
      const { available, error } = useUpdateStore.getState();
      if (error) {
        toast.error(t('sessions.sidebar.updateCheck.errorTitle'), { description: error });
        return;
      }
      if (!available) {
        toast.success(t('sessions.sidebar.updateCheck.latestVersion'));
        return;
      }
      setUpdateDialogOpen(true);
    });
  }, [t, updateStore]);

  const handleOpenSettings = React.useCallback(() => {
    if (mobileVariant) {
      setSessionSwitcherOpen(false);
    }
    setSettingsDialogOpen(true);
  }, [mobileVariant, setSessionSwitcherOpen, setSettingsDialogOpen]);

  const showSidebarUpdateButton =
    updateStore.available &&
    (updateStore.runtimeType === 'desktop' || updateStore.runtimeType === 'web');

  const deleteSession = useSessionUIStore((state) => state.deleteSession);
  const deleteSessions = useSessionUIStore((state) => state.deleteSessions);

  const {
    handleSessionSelect,
    handleSessionDoubleClick,
    handleSaveEdit,
    handleCancelEdit,
    handleDeleteSession,
    confirmDeleteSession,
  } = useSessionActions({
    activeProjectId,
    currentDirectory,
    currentSessionId,
    mobileVariant,
    allowReselect,
    onSessionSelected,
    isSessionSearchOpen,
    sessionSearchQuery,
    setSessionSearchQuery,
    setIsSessionSearchOpen,
    setActiveProjectIdOnly,
    setDirectory,
    setActiveMainTab,
    setSessionSwitcherOpen,
    setCurrentSession,
    updateSessionTitle,
    deleteSession,
    deleteSessions,
    childrenMap,
    showDeletionDialog,
    setDeleteSessionConfirm,
    deleteSessionConfirm,
    setEditingId,
    setEditTitle,
    editingId,
    editTitle,
  });

  const confirmDeleteFolder = React.useCallback(() => {
    if (!deleteFolderConfirm) return;
    const { scopeKey, folderId } = deleteFolderConfirm;
    setDeleteFolderConfirm(null);
    deleteFolder(scopeKey, folderId);
  }, [deleteFolderConfirm, deleteFolder]);

  const handleOpenDirectoryDialog = React.useCallback(() => {
    if (!tauriIpcAvailable || !isDesktopLocalOriginActive()) {
      sessionEvents.requestDirectoryDialog();
      return;
    }

    import('@/lib/desktop')
      .then(({ requestDirectoryAccess }) => requestDirectoryAccess(''))
      .then((result) => {
        if (result.success && result.path) {
          const added = addProject(result.path, { id: result.projectId });
          if (!added) {
            toast.error(t('sessions.sidebar.directory.errorAddProjectTitle'), {
              description: t('sessions.sidebar.directory.errorAddProjectDescription'),
            });
          }
        } else if (result.error && result.error !== 'Directory selection cancelled') {
          toast.error(t('sessions.sidebar.directory.errorSelectDirectoryTitle'), {
            description: result.error,
          });
        }
      })
      .catch((error) => {
        console.error('Desktop: Error selecting directory:', error);
        toast.error(t('sessions.sidebar.directory.errorSelectDirectoryTitle'));
      });
  }, [addProject, t, tauriIpcAvailable]);

  // Auto-expand parent session when navigating to a subagent (child) session
  React.useEffect(() => {
    if (!currentSessionId) return;
    const current = sessions.find((s) => s.id === currentSessionId);
    const parentID = (current as Session & { parentID?: string | null })?.parentID;
    if (!parentID) return;
    setExpandedParents((prev) => {
      if (prev.has(parentID)) return prev;
      const next = new Set(prev);
      next.add(parentID);
      try {
        safeStorage.setItem(SESSION_EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch { /* ignored */ }
      return next;
    });
  }, [currentSessionId, sessions, safeStorage]);

  const toggleParent = React.useCallback((sessionId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      try {
        safeStorage.setItem(SESSION_EXPANDED_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch { /* ignored */ }
      return next;
    });
  }, [safeStorage]);

  const createFolderAndStartRename = React.useCallback(
    (scopeKey: string, parentId?: string | null) => {
      if (!scopeKey) {
        return null;
      }

      if (parentId && collapsedFolderIds.has(parentId)) {
        toggleFolderCollapse(parentId);
      }

      const newFolder = createFolder(scopeKey, t('sessions.sidebar.folder.newFolderName'), parentId);
      setRenamingFolderId(newFolder.id);
      setRenameFolderDraft(newFolder.name);
      return newFolder;
    },
    [collapsedFolderIds, toggleFolderCollapse, createFolder, t],
  );

  const toggleGroupSessionLimit = React.useCallback((groupId: string) => {
    setExpandedSessionGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const collapseAllProjects = React.useCallback(() => {
    ignoreIntersectionUntil.current = Date.now() + 150;
    setCollapsedProjects(() => {
      const allIds = new Set(projects.map((p) => p.id));
      try {
        safeStorage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(allIds)));
      } catch { /* ignored */ }
      if (!isVSCode) {
        scheduleCollapsedProjectsPersist(allIds);
      }
      return allIds;
    });
  }, [projects, isVSCode, safeStorage, scheduleCollapsedProjectsPersist]);

  const expandAllProjects = React.useCallback(() => {
    ignoreIntersectionUntil.current = Date.now() + 150;
    setCollapsedProjects(() => {
      const empty = new Set<string>();
      try {
        safeStorage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify([]));
      } catch { /* ignored */ }
      if (!isVSCode) {
        scheduleCollapsedProjectsPersist(empty);
      }
      return empty;
    });
  }, [isVSCode, safeStorage, scheduleCollapsedProjectsPersist]);

  const toggleProject = React.useCallback((projectId: string) => {
    // Ignore intersection events for a short period after toggling
    ignoreIntersectionUntil.current = Date.now() + 150;
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      try {
        safeStorage.setItem(PROJECT_COLLAPSE_STORAGE_KEY, JSON.stringify(Array.from(next)));
      } catch { /* ignored */ }

      // Persist collapse state to server settings (web + desktop local/remote).
      if (!isVSCode) {
        scheduleCollapsedProjectsPersist(next);
      }
      return next;
    });
  }, [isVSCode, safeStorage, scheduleCollapsedProjectsPersist]);

  const normalizedProjects = React.useMemo(() => {
    return projects
      .map((project) => ({
        ...project,
        normalizedPath: normalizePath(project.path),
      }))
      .filter((project) => Boolean(project.normalizedPath)) as Array<{
        id: string;
        path: string;
        label?: string;
        normalizedPath: string;
        icon?: string;
        color?: string;
      }>;
  }, [projects]);

  const normalizedProjectPaths = React.useMemo(
    () => normalizedProjects.map((project) => project.normalizedPath),
    [normalizedProjects],
  );

  const gitRepoStatus = useGitRepoStatusMap(normalizedProjectPaths);

  useProjectRepoStatus({
    normalizedProjects,
    gitRepoStatus,
    setProjectRepoStatus,
    setProjectRootBranches,
  });

  const isSessionsLoading = useSessionUIStore((state) => state.isLoading);
  useSessionFolderCleanup({
    isSessionsLoading,
    sessions,
    cleanupSessions,
  });

  const { getSessionsForProject } = useProjectSessionLists({ sessions });

  // Keep last-known repo status to avoid UI jiggling during project switch
  const lastRepoStatusRef = React.useRef(false);
  if (activeProjectId && projectRepoStatus.has(activeProjectId)) {
    lastRepoStatusRef.current = Boolean(projectRepoStatus.get(activeProjectId));
  }

  const {
    projectSections,
    groupSearchDataByGroup,
    sectionsForRender,
    searchMatchCount,
  } = useSessionSidebarSections({
    normalizedProjects,
    getSessionsForProject,
    projectRepoStatus,
    projectRootBranches,
    lastRepoStatus: lastRepoStatusRef.current,
    buildGroupedSessions,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    filterSessionNodesForSearch,
    buildGroupSearchText,
    getFoldersForScope,
  });

  const searchEmptyState = (
    <div className="py-6 text-center text-muted-foreground">
      <p className="typography-ui-label font-semibold">{t('sessions.sidebar.empty.noMatches.title')}</p>
      <p className="typography-meta mt-1">{t('sessions.sidebar.empty.noMatches.description')}</p>
    </div>
  );

  const reserveHeaderActionsSpace = true;

  const { currentSessionDirectory } = useProjectSessionSelection({
    projectSections,
    activeProjectId,
    activeSessionByProject,
    setActiveSessionByProject,
    currentSessionId,
    handleSessionSelect,
    newSessionDraftOpen,
    mobileVariant,
    openNewSessionDraft,
    setActiveMainTab,
    setSessionSwitcherOpen,
    sessions,
  });

  const { getOrderedGroups } = useGroupOrdering(groupOrderByProject);
  useSessionPrefetch({
    currentSessionId,
    sortedSessions,
    recentSessionIds: [],
    loadMessages: sync.syncSession,
  });

  const desktopHeaderActionButtonClass =
    'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md leading-none text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed';
  const mobileHeaderActionButtonClass =
    'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md leading-none text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed';
  const headerActionButtonClass = mobileVariant ? mobileHeaderActionButtonClass : desktopHeaderActionButtonClass;
  const headerActionIconClass = 'h-4.5 w-4.5';
  const stuckProjectHeaders = useStickyProjectHeaders({
    isDesktopShellRuntime,
    projectSections,
    projectHeaderSentinelRefs,
  });

  const renderSessionNode = React.useCallback(
    (
      node: SessionNode,
      depth = 0,
      groupDirectory?: string | null,
      projectId?: string | null,
      secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null } | null,
      renderContext: 'project' | 'recent' = 'project',
    ): React.ReactNode => (
      <SessionNodeItem
        node={node}
        depth={depth}
        groupDirectory={groupDirectory}
        projectId={projectId}
        directoryStatus={directoryStatus}
        currentSessionId={currentSessionId}
        pinnedSessionIds={pinnedSessionIds}
        expandedParents={expandedParents}
        hasSessionSearchQuery={hasSessionSearchQuery}
        normalizedSessionSearchQuery={normalizedSessionSearchQuery}
        notifyOnSubtasks={notifyOnSubtasks}
        editingId={editingId}
        setEditingId={setEditingId}
        editTitle={editTitle}
        setEditTitle={setEditTitle}
        handleSaveEdit={handleSaveEdit}
        handleCancelEdit={handleCancelEdit}
        toggleParent={toggleParent}
        handleSessionSelect={handleSessionSelect}
        handleSessionDoubleClick={handleSessionDoubleClick}
        togglePinnedSession={togglePinnedSession}
        openSidebarMenuKey={openSidebarMenuKey}
        setOpenSidebarMenuKey={setOpenSidebarMenuKey}
        renamingFolderId={renamingFolderId}
        getFoldersForScope={getFoldersForScope}
        getSessionFolderId={getSessionFolderId}
        removeSessionFromFolder={removeSessionFromFolder}
        addSessionToFolder={addSessionToFolder}
        createFolderAndStartRename={createFolderAndStartRename}
        handleDeleteSession={handleDeleteSession}
        mobileVariant={mobileVariant}
        renderSessionNode={renderSessionNode}
        secondaryMeta={secondaryMeta}
        renderContext={renderContext}
      />
    ),
    [
      directoryStatus,
      currentSessionId,
      pinnedSessionIds,
      expandedParents,
      hasSessionSearchQuery,
      normalizedSessionSearchQuery,
      notifyOnSubtasks,
      editingId,
      setEditingId,
      editTitle,
      setEditTitle,
      handleSaveEdit,
      handleCancelEdit,
      toggleParent,
      handleSessionSelect,
      handleSessionDoubleClick,
      togglePinnedSession,
      openSidebarMenuKey,
      setOpenSidebarMenuKey,
      renamingFolderId,
      getFoldersForScope,
      getSessionFolderId,
      removeSessionFromFolder,
      addSessionToFolder,
      createFolderAndStartRename,
      handleDeleteSession,
      mobileVariant,
    ],
  );

  const toggleCollapsedGroup = React.useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const renderGroupSessions = React.useCallback(
    (group: SessionGroup, groupKey: string, projectId?: string | null, hideGroupLabel?: boolean, dragHandleProps?: SortableDragHandleProps | null, compactBodyPadding?: boolean) => (
      <SessionGroupSection
        group={group}
        groupKey={groupKey}
        projectId={projectId}
        hideGroupLabel={hideGroupLabel}
        compactBodyPadding={compactBodyPadding}
        hasSessionSearchQuery={hasSessionSearchQuery}
        normalizedSessionSearchQuery={normalizedSessionSearchQuery}
        groupSearchDataByGroup={groupSearchDataByGroup}
        expandedSessionGroups={expandedSessionGroups}
        collapsedGroups={collapsedGroups}
        hideDirectoryControls={hideDirectoryControls}
        getFoldersForScope={getFoldersForScope}
        collapsedFolderIds={collapsedFolderIds}
        toggleFolderCollapse={toggleFolderCollapse}
        renameFolder={renameFolder}
        deleteFolder={deleteFolder}
        showDeletionDialog={showDeletionDialog}
        setDeleteFolderConfirm={setDeleteFolderConfirm}
        renderSessionNode={renderSessionNode}
        currentSessionDirectory={currentSessionDirectory}
        toggleGroupSessionLimit={toggleGroupSessionLimit}
        mobileVariant={mobileVariant}
        activeProjectId={activeProjectId}
        setActiveProjectIdOnly={setActiveProjectIdOnly}
        setActiveMainTab={setActiveMainTab}
        setSessionSwitcherOpen={setSessionSwitcherOpen}
        openNewSessionDraft={openNewSessionDraft}
        addSessionToFolder={addSessionToFolder}
        createFolderAndStartRename={createFolderAndStartRename}
        renamingFolderId={renamingFolderId}
        renameFolderDraft={renameFolderDraft}
        setRenameFolderDraft={setRenameFolderDraft}
        setRenamingFolderId={setRenamingFolderId}
        pinnedSessionIds={pinnedSessionIds}
        sessionOrderIndex={sessionOrderIndex}
        onToggleCollapsedGroup={toggleCollapsedGroup}
        dragHandleProps={dragHandleProps}
      />
    ),
    [
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
      renderSessionNode,
      currentSessionDirectory,
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
      pinnedSessionIds,
      sessionOrderIndex,
      toggleCollapsedGroup,
    ],
  );

  const topContent = null;
  const isInlineEditing = Boolean(renamingFolderId || editingId || editingProjectDialogId);

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const selectedIds = useSessionMultiSelectStore((state) => state.selectedIds);
  const selectionScopeKey = useSessionMultiSelectStore((state) => state.scopeKey);
  const multiSelectStoreApi = useSessionMultiSelectStore;

  const handleToggleSelectionMode = React.useCallback(() => {
    useSessionMultiSelectStore.getState().toggleMode();
  }, []);
  const handleExitSelectionMode = React.useCallback(() => {
    useSessionMultiSelectStore.getState().disable();
  }, []);

  const derivedSelectionScope = React.useMemo(() => {
    if (selectionScopeKey) return selectionScopeKey;
    if (selectedIds.size === 0) return null;
    if (typeof document === 'undefined') return null;
    for (const id of selectedIds) {
      const row = document.querySelector<HTMLElement>(`[data-session-row="${CSS.escape(id)}"]`);
      const scope = row?.getAttribute('data-session-scope');
      if (scope && scope.length > 0) return scope;
    }
    return null;
  }, [selectedIds, selectionScopeKey]);

  const bulkScopeFolders = React.useMemo(() => {
    if (!derivedSelectionScope) return [];
    return foldersMap[derivedSelectionScope] ?? [];
  }, [foldersMap, derivedSelectionScope]);

  const bulkCanRemoveFromFolder = React.useMemo(() => {
    if (!derivedSelectionScope || selectedIds.size === 0) return false;
    const scopeFolders = foldersMap[derivedSelectionScope] ?? [];
    for (const folder of scopeFolders) {
      for (const id of folder.sessionIds) {
        if (selectedIds.has(id)) return true;
      }
    }
    return false;
  }, [foldersMap, derivedSelectionScope, selectedIds]);

  const handleBulkMoveToFolder = React.useCallback((folderId: string) => {
    if (!derivedSelectionScope || selectedIds.size === 0) return;
    addSessionsToFolder(derivedSelectionScope, folderId, Array.from(selectedIds));
  }, [addSessionsToFolder, selectedIds, derivedSelectionScope]);

  const handleBulkCreateFolderAndMove = React.useCallback(() => {
    if (!derivedSelectionScope || selectedIds.size === 0) return;
    const newFolder = createFolderAndStartRename(derivedSelectionScope);
    if (!newFolder) return;
    addSessionsToFolder(derivedSelectionScope, newFolder.id, Array.from(selectedIds));
  }, [addSessionsToFolder, createFolderAndStartRename, selectedIds, derivedSelectionScope]);

  const handleBulkRemoveFromFolder = React.useCallback(() => {
    if (!derivedSelectionScope || selectedIds.size === 0) return;
    removeSessionsFromFolders(derivedSelectionScope, Array.from(selectedIds));
  }, [removeSessionsFromFolders, selectedIds, derivedSelectionScope]);

  const executeBulkDelete = React.useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const { deletedIds, failedIds } = await deleteSessions(ids);
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
    useSessionMultiSelectStore.getState().clear();
  }, [deleteSessions, selectedIds, t]);

  const handleBulkDelete = React.useCallback(() => {
    const count = selectedIds.size;
    if (count === 0) return;
    if (!showDeletionDialog) {
      void executeBulkDelete();
      return;
    }
    setBulkDeleteConfirm({ sessionCount: count });
  }, [executeBulkDelete, selectedIds, showDeletionDialog]);

  const confirmBulkDelete = React.useCallback(async () => {
    setBulkDeleteConfirm(null);
    await executeBulkDelete();
  }, [executeBulkDelete]);

  React.useEffect(() => {
    if (!selectionModeEnabled) return;
    const isMac = typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent || '');
    const listener = (event: KeyboardEvent) => {
      if (isInlineEditing) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      if (event.key === 'Escape') {
        event.preventDefault();
        useSessionMultiSelectStore.getState().disable();
        return;
      }
      if (modifier && event.key === 'Backspace') {
        event.preventDefault();
        handleBulkDelete();
        return;
      }
      if (modifier && (event.key === 'a' || event.key === 'A')) {
        const rows = typeof document !== 'undefined'
          ? Array.from(document.querySelectorAll<HTMLElement>('[data-session-row]'))
          : [];
        if (rows.length === 0) return;
        event.preventDefault();
        const currentScope = multiSelectStoreApi.getState().scopeKey;
        const targetScope = currentScope
          ?? rows[0]?.getAttribute('data-session-scope')
          ?? null;
        const scopeFilter = (el: HTMLElement): boolean => {
          if (!targetScope) return true;
          return el.getAttribute('data-session-scope') === targetScope;
        };
        const ids = rows
          .filter(scopeFilter)
          .map((el) => el.getAttribute('data-session-row'))
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        if (ids.length === 0) return;
        multiSelectStoreApi.getState().replaceAll(ids, targetScope || null);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [handleBulkDelete, isInlineEditing, multiSelectStoreApi, selectionModeEnabled]);
  const handleSidebarNewSession = React.useCallback(() => {
    setActiveMainTab('chat');
    if (mobileVariant) {
      setSessionSwitcherOpen(false);
    }
    openNewSessionDraft();
  }, [mobileVariant, openNewSessionDraft, setActiveMainTab, setSessionSwitcherOpen]);

  return (
    <div
      ref={sessionSearchContainerRef}
      className={cn(
        'relative flex h-full flex-col text-foreground overflow-x-hidden',
        mobileVariant ? '' : 'bg-transparent',
      )}
    >
      {showDesktopSidebarChrome ? (
        <div
          onMouseDown={handleDesktopSidebarDragStart}
          className={cn(
            'app-region-drag flex h-[var(--oc-header-height,56px)] flex-shrink-0 items-center pr-3',
            desktopSidebarTopPaddingClass,
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={toggleSidebar}
                className={desktopSidebarToggleButtonClass}
                aria-label={t('sessions.sidebar.header.actions.closeSessions')}
              >
                <RiLayoutLeftLine className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('sessions.sidebar.header.actions.closeSessions')}</p>
            </TooltipContent>
          </Tooltip>
        </div>
      ) : null}

      <SidebarHeader
        hideDirectoryControls={hideDirectoryControls}
        handleOpenDirectoryDialog={handleOpenDirectoryDialog}
        handleNewSession={handleSidebarNewSession}
        headerActionIconClass={headerActionIconClass}
        reserveHeaderActionsSpace={reserveHeaderActionsSpace}
        headerActionButtonClass={headerActionButtonClass}
        isSessionSearchOpen={isSessionSearchOpen}
        setIsSessionSearchOpen={setIsSessionSearchOpen}
        sessionSearchInputRef={sessionSearchInputRef}
        sessionSearchQuery={sessionSearchQuery}
        setSessionSearchQuery={setSessionSearchQuery}
        hasSessionSearchQuery={hasSessionSearchQuery}
        searchMatchCount={searchMatchCount}
        collapseAllProjects={collapseAllProjects}
        expandAllProjects={expandAllProjects}
        selectionModeEnabled={selectionModeEnabled}
        onToggleSelectionMode={handleToggleSelectionMode}
        showSidebarToggle={isWebRuntime}
        onToggleSidebar={toggleSidebar}
      />

      <SidebarProjectsList
        topContent={topContent}
        sectionsForRender={sectionsForRender}
        projectSections={projectSections}
        activeProjectId={activeProjectId}
        showOnlyMainWorkspace={showOnlyMainWorkspace}
        hasSessionSearchQuery={hasSessionSearchQuery}
        emptyState={emptyState}
        searchEmptyState={searchEmptyState}
        renderGroupSessions={renderGroupSessions}
        homeDirectory={homeDirectory}
        collapsedProjects={collapsedProjects}
        hideDirectoryControls={hideDirectoryControls}
        projectRepoStatus={projectRepoStatus}
        isDesktopShellRuntime={isDesktopShellRuntime}
        stuckProjectHeaders={stuckProjectHeaders}
        mobileVariant={mobileVariant}
        toggleProject={toggleProject}
        setActiveProjectIdOnly={setActiveProjectIdOnly}
        setActiveMainTab={setActiveMainTab}
        setSessionSwitcherOpen={setSessionSwitcherOpen}
        openNewSessionDraft={openNewSessionDraft}
        openProjectEditDialog={setEditingProjectDialogId}
        removeProject={removeProject}
        projectHeaderSentinelRefs={projectHeaderSentinelRefs}
        reorderProjects={reorderProjects}
        getOrderedGroups={getOrderedGroups}
        setGroupOrderByProject={setGroupOrderByProject}
        openSidebarMenuKey={openSidebarMenuKey}
        setOpenSidebarMenuKey={setOpenSidebarMenuKey}
        isInlineEditing={isInlineEditing}
      />

      {selectionModeEnabled && selectedIds.size > 0 ? (
        <BulkActionBar
          selectedCount={selectedIds.size}
          scopeKey={derivedSelectionScope}
          scopeFolders={bulkScopeFolders}
          onMoveToFolder={handleBulkMoveToFolder}
          onCreateFolderAndMove={handleBulkCreateFolderAndMove}
          onRemoveFromFolder={handleBulkRemoveFromFolder}
          canRemoveFromFolder={bulkCanRemoveFromFolder}
          onDelete={handleBulkDelete}
          onDone={handleExitSelectionMode}
        />
      ) : null}

      <SidebarFooter
        onOpenSettings={handleOpenSettings}
        onOpenShortcuts={toggleHelpDialog}
        onOpenAbout={() => setAboutDialogOpen(true)}
        onOpenUpdate={handleOpenUpdateDialog}
        showRuntimeButtons={!isVSCode}
        showUpdateButton={showSidebarUpdateButton}
      />

      <UpdateDialog
        open={updateDialogOpen}
        onOpenChange={setUpdateDialogOpen}
        info={updateStore.info}
        downloading={updateStore.downloading}
        downloaded={updateStore.downloaded}
        progress={updateStore.progress}
        error={updateStore.error}
        onDownload={updateStore.downloadUpdate}
        onRestart={updateStore.restartToUpdate}
        runtimeType={updateStore.runtimeType}
      />

      {editingProject ? (
        <ProjectEditDialog
          open={Boolean(editingProject)}
          onOpenChange={(open) => {
            if (!open) {
              setEditingProjectDialogId(null);
            }
          }}
          projectName={editingProject.label || formatDirectoryName(editingProject.path, homeDirectory)}
          projectPath={editingProject.path}
          initialIcon={editingProject.icon}
          initialColor={editingProject.color}
          onSave={handleSaveProjectEdit}
        />
      ) : null}

      <SessionDeleteConfirmDialog
        value={deleteSessionConfirm}
        setValue={setDeleteSessionConfirm}
        showDeletionDialog={showDeletionDialog}
        setShowDeletionDialog={setShowDeletionDialog}
        onConfirm={confirmDeleteSession}
      />

      <FolderDeleteConfirmDialog
        value={deleteFolderConfirm}
        setValue={setDeleteFolderConfirm}
        onConfirm={confirmDeleteFolder}
      />

      <BulkSessionDeleteConfirmDialog
        value={bulkDeleteConfirm}
        setValue={setBulkDeleteConfirm}
        showDeletionDialog={showDeletionDialog}
        setShowDeletionDialog={setShowDeletionDialog}
        onConfirm={confirmBulkDelete}
      />
    </div>
  );
};
