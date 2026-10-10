import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';

import { RiArrowLeftSLine, RiChat4Line, RiChatNewLine, RiCloseLine, RiFileTextLine, RiFolder6Line, RiGitBranchLine, RiLayoutLeftLine, RiLayoutRightLine, RiPlayListAddLine, RiServerLine, RiStackLine, RiTerminalBoxLine, type RemixiconComponentType } from '@remixicon/react';
import { DiffIcon } from '@/components/icons/DiffIcon';
import { useUIStore, type MainTab } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions, useSession, useSessionMessageRecords } from '@/sync/sync-context';
import { getAllSyncSessions } from '@/sync/sync-refs';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitBranchLabel } from '@/stores/useGitStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';

import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { useDeviceInfo } from '@/lib/device';
import { cn, hasModifier } from '@/lib/utils';
import { McpDropdownContent } from '@/components/mcp/McpDropdown';
import { McpIcon } from '@/components/icons/McpIcon';
import { eventMatchesShortcut, formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import type { SessionContextUsage } from '@/stores/types/sessionTypes';
import { DesktopHostSwitcherDialog } from '@/components/desktop/DesktopHostSwitcher';
import { OpenInAppButton } from '@/components/desktop/OpenInAppButton';
import { ProjectActionsButton } from '@/components/layout/ProjectActionsButton';
import { isDesktopShell, isVSCodeRuntime, startDesktopWindowDrag } from '@/lib/desktop';
import { desktopHostsGet, locationMatchesHost, redactSensitiveUrl } from '@/lib/desktopHosts';
import { resolveSessionDiffStats } from '@/components/session/sidebar/utils';
import { resolveDisplayContextUsage } from '@/lib/contextUsage';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/claude/types';

const DESKTOP_HEADER_ICON_BUTTON_CLASS = 'app-region-no-drag inline-flex h-8 w-8 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:bg-interactive-hover transition-colors';
const MOBILE_HEADER_ICON_BUTTON_CLASS = 'app-region-no-drag inline-flex h-9 w-9 items-center justify-center gap-2 p-2 rounded-md typography-ui-label font-medium text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:text-foreground hover:bg-interactive-hover transition-colors';

type HeaderIconActionButtonProps = {
  visible?: boolean;
  title: string;
  ariaLabel: string;
  onClick: () => void;
  className?: string;
  Icon: RemixiconComponentType;
  iconClassName?: string;
};

const HeaderIconActionButton = React.memo(function HeaderIconActionButton({
  visible = true,
  title,
  ariaLabel,
  onClick,
  className,
  Icon,
  iconClassName,
}: HeaderIconActionButtonProps) {
  if (!visible) {
    return null;
  }

  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={ariaLabel}
          className={className ?? DESKTOP_HEADER_ICON_BUTTON_CLASS}
        >
          <Icon className={iconClassName ?? 'h-[18px] w-[18px]'} />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{title}</p>
      </TooltipContent>
    </Tooltip>
  );
});

type DesktopServicesMenuProps = {
  isDesktopApp: boolean;
  currentInstanceLabel: string;
  compactCurrentInstanceLabel: string;
  isDesktopServicesOpen: boolean;
  setIsDesktopServicesOpen: React.Dispatch<React.SetStateAction<boolean>>;
  refreshCurrentInstanceLabel: () => Promise<void>;
  desktopServicesTab: 'instance' | 'mcp';
  setDesktopServicesTab: React.Dispatch<React.SetStateAction<'instance' | 'mcp'>>;
  servicesTabItems: SortableTabsStripItem[];
  shortcutLabel: (actionId: string) => string;
};

const DesktopServicesMenu = React.memo(function DesktopServicesMenu({
  isDesktopApp,
  currentInstanceLabel,
  compactCurrentInstanceLabel,
  isDesktopServicesOpen,
  setIsDesktopServicesOpen,
  refreshCurrentInstanceLabel,
  desktopServicesTab,
  setDesktopServicesTab,
  servicesTabItems,
  shortcutLabel,
}: DesktopServicesMenuProps) {
  const { t } = useI18n();
  return (
    <DropdownMenu
      open={isDesktopServicesOpen}
      onOpenChange={(open) => {
        setIsDesktopServicesOpen(open);
        if (open) {
          void refreshCurrentInstanceLabel();
        }
      }}
    >
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={isDesktopApp
                ? t('header.services.openWithCurrent', { current: currentInstanceLabel })
                : t('header.services.open')}
              className={cn(
                DESKTOP_HEADER_ICON_BUTTON_CLASS,
                isDesktopApp ? 'w-auto max-w-[14rem] justify-start gap-1.5 px-2.5' : 'h-8 w-8'
              )}
            >
              <RiStackLine className="h-[18px] w-[18px]" />
              {isDesktopApp ? (
                <span className="truncate typography-ui-label font-medium text-foreground">{compactCurrentInstanceLabel}</span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>
          <p>
            {isDesktopApp
              ? t('header.services.tooltip.currentInstanceWithShortcuts', {
                  current: currentInstanceLabel,
                  toggle: shortcutLabel('toggle_services_menu'),
                  nextTab: shortcutLabel('cycle_services_tab'),
                })
              : t('header.services.tooltip.servicesWithShortcuts', {
                  toggle: shortcutLabel('toggle_services_menu'),
                  nextTab: shortcutLabel('cycle_services_tab'),
                })}
          </p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        className="w-[min(27rem,calc(100vw-2rem))] max-h-[75vh] overflow-y-auto bg-[var(--surface-elevated)] p-0"
      >
        <div className="sticky top-0 z-20 px-2 pt-1.5 pb-px">
          <div className="h-9">
            <SortableTabsStrip
              items={servicesTabItems}
              activeId={desktopServicesTab}
              onSelect={(tabID) => {
                setDesktopServicesTab(tabID as 'instance' | 'mcp');
              }}
              layoutMode="fit"
              variant="active-pill"
              activePillInsetClassName="gap-0.5 px-px py-0"
              activePillButtonClassName="h-8"
              className="h-full"
            />
          </div>
        </div>

        {isDesktopApp && desktopServicesTab === 'instance' ? (
          <DesktopHostSwitcherDialog
            embedded
            open={isDesktopServicesOpen && desktopServicesTab === 'instance'}
            onOpenChange={() => {}}
            onHostSwitched={() => setIsDesktopServicesOpen(false)}
          />
        ) : null}

        {desktopServicesTab === 'mcp' ? (
          <McpDropdownContent active={isDesktopServicesOpen && desktopServicesTab === 'mcp'} />
        ) : null}

      </DropdownMenuContent>
    </DropdownMenu>
  );
});
const formatCompactHeaderLabel = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const first = words[0];
    const second = words[1].slice(0, 3);
    const shortTwoWord = `${first} ${second}`.trim();
    if (words.length > 2 || shortTwoWord.length < trimmed.length) {
      return `${shortTwoWord}...`;
    }
    return shortTwoWord;
  }

  return trimmed.length > 12 ? `${trimmed.slice(0, 9).trimEnd()}...` : trimmed;
};

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

const getActiveContextMode = (panelState: {
  isOpen: boolean;
  activeTabId: string | null;
  tabs: Array<{ id: string; mode: 'diff' | 'file' | 'context' | 'plan' | 'chat' }>;
} | undefined): 'diff' | 'file' | 'context' | 'plan' | 'chat' | null => {
  if (!panelState?.isOpen || !Array.isArray(panelState.tabs) || panelState.tabs.length === 0) {
    return null;
  }

  const activeTab = panelState.tabs.find((tab) => tab.id === panelState.activeTabId) ?? panelState.tabs[panelState.tabs.length - 1];
  return activeTab?.mode ?? null;
};

interface TabConfig {
  id: MainTab;
  label: string;
  icon: RemixiconComponentType | 'diff';
  badge?: number;
  showDot?: boolean;
}

interface HeaderProps {
  onToggleLeftDrawer?: () => void;
  onToggleRightDrawer?: () => void;
  leftDrawerOpen?: boolean;
  rightDrawerOpen?: boolean;
  desktopRightSidebarActionsHost?: HTMLElement | null;
}

export const Header: React.FC<HeaderProps> = ({
  onToggleLeftDrawer,
  onToggleRightDrawer,
  leftDrawerOpen,
  rightDrawerOpen,
  desktopRightSidebarActionsHost = null,
}) => {
  const { t } = useI18n();
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
  const toggleBottomTerminal = useUIStore((state) => state.toggleBottomTerminal);
  const toggleRightSidebar = useUIStore((state) => state.toggleRightSidebar);
  const openContextOverview = useUIStore((state) => state.openContextOverview);
  const openContextPlan = useUIStore((state) => state.openContextPlan);
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const contextPanelByDirectory = useUIStore((state) => state.contextPanelByDirectory);
  const activeMainTab = useUIStore((state) => state.activeMainTab);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);

  const getCurrentModel = useConfigStore((state) => state.getCurrentModel);

  const getContextUsage = useSessionUIStore((state) => state.getContextUsage);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const isNewSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSyncedSession = useSession(currentSessionId ?? null);
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const liveSessions = useAllLiveSessions();
  const activeProject = useProjectsStore((state) => {
    if (!state.activeProjectId) {
      return null;
    }
    return state.projects.find((project) => project.id === state.activeProjectId) ?? null;
  });
  const activeProjectLabel = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }

    const trimmedLabel = activeProject.label?.trim();
    if (trimmedLabel) {
      return trimmedLabel;
    }

    const pathSegments = activeProject.path.split(/[\\/]/).filter(Boolean);
    return pathSegments[pathSegments.length - 1] ?? null;
  }, [activeProject]);

  const { isMobile } = useDeviceInfo();

  const headerRef = React.useRef<HTMLElement | null>(null);

  const [isDesktopApp, setIsDesktopApp] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return isDesktopShell();
  });
  const [isDesktopWindowFullscreen, setIsDesktopWindowFullscreen] = React.useState(false);

  const isMacPlatform = React.useMemo(() => {
    if (typeof navigator === 'undefined') {
      return false;
    }
    return /Macintosh|Mac OS X/.test(navigator.userAgent || '');
  }, []);

  const macosMajorVersion = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const injected = (window as unknown as { __OPENCHAMBER_MACOS_MAJOR__?: unknown }).__OPENCHAMBER_MACOS_MAJOR__;
    if (typeof injected === 'number' && Number.isFinite(injected) && injected > 0) {
      return injected;
    }

    // Fallback: WebKit reports "Mac OS X 10_15_7" format where 10 is legacy prefix
    if (typeof navigator === 'undefined') {
      return null;
    }
    const match = (navigator.userAgent || '').match(/Mac OS X (\d+)[._](\d+)/);
    if (!match) {
      return null;
    }
    const first = Number.parseInt(match[1], 10);
    const second = Number.parseInt(match[2], 10);
    if (Number.isNaN(first)) {
      return null;
    }
    return first === 10 ? second : first;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setIsDesktopApp(isDesktopShell());
  }, []);

  const currentModel = getCurrentModel();
  const limit = currentModel && typeof currentModel.limit === 'object' && currentModel.limit !== null
    ? (currentModel.limit as Record<string, unknown>)
    : null;
  const contextLimit = (limit && typeof limit.context === 'number' ? limit.context : 0);
  const outputLimit = (limit && typeof limit.output === 'number' ? limit.output : 0);
  const currentSessionMessageRecords = useSessionMessageRecords(currentSessionId ?? '');
  const contextUsage = React.useMemo(
    () => {
      void currentSessionMessageRecords;
      return getContextUsage(contextLimit, outputLimit);
    },
    [contextLimit, currentSessionMessageRecords, getContextUsage, outputLimit],
  );
  const desktopHeaderContextUsage = React.useMemo<SessionContextUsage | null>(
    () => resolveDisplayContextUsage(currentSessionId, contextUsage, contextLimit, outputLimit),
    [contextLimit, contextUsage, currentSessionId, outputLimit],
  );

  const isSessionSwitcherOpen = useUIStore((state) => state.isSessionSwitcherOpen);
  const [isMobileRateLimitsOpen, setIsMobileRateLimitsOpen] = React.useState(false);
  const [isDesktopServicesOpen, setIsDesktopServicesOpen] = React.useState(false);
  const [currentInstanceLabel, setCurrentInstanceLabel] = React.useState('Local');
  const compactCurrentInstanceLabel = React.useMemo(() => formatCompactHeaderLabel(currentInstanceLabel), [currentInstanceLabel]);
  const [desktopServicesTab, setDesktopServicesTab] = React.useState<'instance' | 'mcp'>(
    isDesktopApp ? 'instance' : 'mcp'
  );
  useEffect(() => {
    if (!isDesktopApp && desktopServicesTab === 'instance') {
      setDesktopServicesTab('mcp');
    }
  }, [desktopServicesTab, isDesktopApp]);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const isLeftSidebarOpen = React.useMemo(() => {
    if (!isMobile) {
      return isSidebarOpen;
    }
    if (typeof onToggleLeftDrawer === 'function') {
      return Boolean(leftDrawerOpen);
    }
    return isSessionSwitcherOpen;
  }, [isMobile, isSessionSwitcherOpen, isSidebarOpen, leftDrawerOpen, onToggleLeftDrawer]);
  const showDesktopHeaderContextUsage = !isVSCode && activeMainTab === 'chat' && !!desktopHeaderContextUsage;
  const desktopHeaderDisplayPercentage = desktopHeaderContextUsage && desktopHeaderContextUsage.contextLimit > 0
    ? Math.min(999, (desktopHeaderContextUsage.totalTokens / desktopHeaderContextUsage.contextLimit) * 100)
    : 0;

  const refreshCurrentInstanceLabel = React.useCallback(async () => {
    if (typeof window === 'undefined' || !isDesktopApp) {
      return;
    }

    try {
      const cfg = await desktopHostsGet();
      const currentHref = window.location.href;
      const localOrigin = window.__OPENCHAMBER_LOCAL_ORIGIN__ || window.location.origin;

      if (locationMatchesHost(currentHref, localOrigin)) {
        setCurrentInstanceLabel('Local');
        return;
      }

      const match = cfg.hosts.find((host) => {
        return locationMatchesHost(currentHref, host.url);
      });

      if (match?.label?.trim()) {
        setCurrentInstanceLabel(redactSensitiveUrl(match.label.trim()));
        return;
      }

      setCurrentInstanceLabel('Instance');
    } catch {
      setCurrentInstanceLabel('Local');
    }
  }, [isDesktopApp]);

  useEffect(() => {
    void refreshCurrentInstanceLabel();
  }, [refreshCurrentInstanceLabel]);
  const currentSessionLive = React.useMemo(() => {
    if (!currentSessionId) return null;
    return liveSessions.find((s) => s.id === currentSessionId)
      ?? globalActiveSessions.find((s) => s.id === currentSessionId)
      ?? currentSyncedSession
      ?? getAllSyncSessions().find((s) => s.id === currentSessionId)
      ?? null;
  }, [currentSessionId, currentSyncedSession, globalActiveSessions, liveSessions]);

  const lastResolvedSessionRef = React.useRef<{
    sessionId: string;
    session: Session;
    expiresAt: number;
  } | null>(null);
  const [sessionFallbackVersion, setSessionFallbackVersion] = React.useState(0);

  React.useEffect(() => {
    if (!currentSessionId) {
      if (lastResolvedSessionRef.current) {
        lastResolvedSessionRef.current = null;
        setSessionFallbackVersion((value) => value + 1);
      }
      return;
    }

    if (currentSessionLive) {
      lastResolvedSessionRef.current = {
        sessionId: currentSessionId,
        session: currentSessionLive,
        expiresAt: Date.now() + 2000,
      };
      return;
    }

    const cached = lastResolvedSessionRef.current;
    if (!cached || cached.sessionId !== currentSessionId) {
      return;
    }

    const remainingMs = cached.expiresAt - Date.now();
    if (remainingMs <= 0) {
      lastResolvedSessionRef.current = null;
      setSessionFallbackVersion((value) => value + 1);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (lastResolvedSessionRef.current?.sessionId === currentSessionId) {
        lastResolvedSessionRef.current = null;
      }
      setSessionFallbackVersion((value) => value + 1);
    }, remainingMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [currentSessionId, currentSessionLive]);

  void sessionFallbackVersion;
  const currentSession = (() => {
    if (currentSessionLive) {
      return currentSessionLive;
    }

    if (!currentSessionId) {
      return null;
    }

    const cached = lastResolvedSessionRef.current;
    if (cached && cached.sessionId === currentSessionId && cached.expiresAt > Date.now()) {
      return cached.session;
    }

    return null;
  })();

  const sessionDirectory = React.useMemo(() => {
    const raw = typeof currentSession?.directory === 'string' ? currentSession.directory : '';
    return normalize(raw || '');
  }, [currentSession?.directory]);

  const draftDirectory = useSessionUIStore((state) => {
    if (!state.newSessionDraft?.open) {
      return '';
    }
    return normalize(state.newSessionDraft.directoryOverride ?? '');
  });

  const openDirectory = React.useMemo(() => {
    return sessionDirectory || draftDirectory;
  }, [draftDirectory, sessionDirectory]);

  const gitBranchForDirectory = useGitBranchLabel(openDirectory || null);
  const currentBranchLabel = gitBranchForDirectory;

  const currentSessionTitle = React.useMemo(() => {
    if (!currentSessionId) {
      return activeProjectLabel ?? 'ClaudeKei';
    }
    const trimmedTitle = currentSession?.title?.trim();
    return trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : 'Untitled Session';
  }, [activeProjectLabel, currentSession?.title, currentSessionId]);

  const currentSessionDiffStats = React.useMemo(() => {
    return resolveSessionDiffStats(currentSession?.summary as Parameters<typeof resolveSessionDiffStats>[0]);
  }, [currentSession?.summary]);

  const currentSessionChanges = React.useMemo(() => {
    if (currentSessionDiffStats) {
      return currentSessionDiffStats;
    }
    return { additions: 0, deletions: 0 };
  }, [currentSessionDiffStats]);
  const hasNonZeroSessionChanges = currentSessionChanges.additions > 0 || currentSessionChanges.deletions > 0;

  const actionDirectory = React.useMemo(() => {
    return normalize(openDirectory || activeProject?.path || '');
  }, [activeProject?.path, openDirectory]);

  const activeProjectRef = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }
    return { id: activeProject.id, path: activeProject.path };
  }, [activeProject]);

  const lastProjectActionsContextRef = React.useRef<{
    projectRef: { id: string; path: string };
    directory: string;
  } | null>(null);

  React.useEffect(() => {
    if (!activeProjectRef || !actionDirectory) {
      return;
    }
    lastProjectActionsContextRef.current = {
      projectRef: activeProjectRef,
      directory: actionDirectory,
    };
  }, [actionDirectory, activeProjectRef]);

  const projectActionsContext = React.useMemo(() => {
    if (activeProjectRef && actionDirectory) {
      return { projectRef: activeProjectRef, directory: actionDirectory };
    }
    return lastProjectActionsContextRef.current;
  }, [actionDirectory, activeProjectRef]);


  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const isSessionPlanAvailable = useSessionUIStore((state) => state.isSessionPlanAvailable);
  const planTabAvailable = planModeEnabled && currentSessionId ? isSessionPlanAvailable(currentSessionId) : false;
  const showPlanTab = planTabAvailable;
  const lastPlanSessionKeyRef = React.useRef<string>('');

  // Reset plan tab availability when session changes
  React.useEffect(() => {
    if (!planModeEnabled) {
      if (useUIStore.getState().activeMainTab === 'plan') {
        useUIStore.getState().setActiveMainTab('chat');
      }
      return;
    }

    if (!currentSessionId) return;

    const sessionKey = `${currentSessionId || 'none'}:${sessionDirectory || 'none'}:${currentSession?.time?.created || 0}:${currentSession?.slug || 'none'}`;
    if (lastPlanSessionKeyRef.current !== sessionKey) {
      lastPlanSessionKeyRef.current = sessionKey;
    }

    // If plan is not available but user is on plan tab, switch them back to chat
    if (!planTabAvailable && useUIStore.getState().activeMainTab === 'plan') {
      useUIStore.getState().setActiveMainTab('chat');
    }
  }, [
    planModeEnabled,
    planTabAvailable,
    currentSession?.slug,
    currentSession?.time?.created,
    currentSessionId,
    sessionDirectory,
  ]);

  const blurActiveElement = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const active = document.activeElement as HTMLElement | null;
    if (!active) {
      return;
    }

    const tagName = active.tagName;
    const isInput = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';

    if (isInput || active.isContentEditable) {
      active.blur();
    }
  }, []);

  const handleOpenSessionSwitcher = React.useCallback(() => {
    if (isMobile) {
      blurActiveElement();
      setSessionSwitcherOpen(!isSessionSwitcherOpen);
      return;
    }
    toggleSidebar();
  }, [blurActiveElement, isMobile, isSessionSwitcherOpen, setSessionSwitcherOpen, toggleSidebar]);

  const handleHeaderNewSession = React.useCallback(() => {
    setActiveMainTab('chat');
    setSessionSwitcherOpen(false);
    openNewSessionDraft();
  }, [openNewSessionDraft, setActiveMainTab, setSessionSwitcherOpen]);

  const handleOpenContextPanel = React.useCallback(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return;
    }

    const panelState = contextPanelByDirectory[directory];
    if (getActiveContextMode(panelState) === 'context') {
      closeContextPanel(directory);
      return;
    }

    openContextOverview(directory);
  }, [closeContextPanel, contextPanelByDirectory, openContextOverview, openDirectory]);

  const isContextPanelActive = React.useMemo(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return false;
    }
    const panelState = contextPanelByDirectory[directory];
    return getActiveContextMode(panelState) === 'context';
  }, [contextPanelByDirectory, openDirectory]);

  const handleOpenContextPlan = React.useCallback(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return;
    }

    const panelState = contextPanelByDirectory[directory];
    if (getActiveContextMode(panelState) === 'plan') {
      closeContextPanel(directory);
      return;
    }

    openContextPlan(directory);
  }, [closeContextPanel, contextPanelByDirectory, openContextPlan, openDirectory]);

  const isContextPlanActive = React.useMemo(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return false;
    }
    const panelState = contextPanelByDirectory[directory];
    return getActiveContextMode(panelState) === 'plan';
  }, [contextPanelByDirectory, openDirectory]);

  const desktopHeaderIconButtonClass = DESKTOP_HEADER_ICON_BUTTON_CLASS;
  const mobileHeaderIconButtonClass = MOBILE_HEADER_ICON_BUTTON_CLASS;

  const desktopPaddingClass = React.useMemo(() => {
    if (!isSidebarOpen && isDesktopApp && isMacPlatform && !isDesktopWindowFullscreen) {
      return 'pl-[5.5rem]';
    }
    return 'pl-3';
  }, [isDesktopApp, isDesktopWindowFullscreen, isMacPlatform, isSidebarOpen]);

  useEffect(() => {
    if (!isDesktopApp || !isMacPlatform) {
      setIsDesktopWindowFullscreen(false);
      return;
    }

    let disposed = false;
    let unlistenResize: (() => void) | null = null;

    const syncFullscreenState = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        const fullscreen = await currentWindow.isFullscreen();
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
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();
        unlistenResize = await currentWindow.onResized(() => {
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
  }, [isDesktopApp, isMacPlatform]);

  const macosHeaderSizeClass = React.useMemo(() => {
    if (!isDesktopApp || !isMacPlatform || macosMajorVersion === null) {
      return '';
    }
    if (macosMajorVersion >= 26) {
      return 'h-12';
    }
    if (macosMajorVersion <= 15) {
      return 'h-14';
    }
    return '';
  }, [isDesktopApp, isMacPlatform, macosMajorVersion]);

  const webWindowControlsOverlayStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (isDesktopApp || isVSCode) {
      return undefined;
    }

    return {
      paddingLeft: 'calc(0.75rem + var(--oc-wco-left-inset, 0px))',
      paddingRight: 'calc(0.75rem + var(--oc-wco-right-inset, 0px))',
      minHeight: 'max(3rem, var(--oc-wco-titlebar-height, 0px))',
      height: 'max(3rem, var(--oc-wco-titlebar-height, 0px))',
    };
  }, [isDesktopApp, isVSCode]);

  const updateHeaderHeight = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const height = headerRef.current?.getBoundingClientRect().height;
    if (height) {
      document.documentElement.style.setProperty('--oc-header-height', `${height}px`);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    updateHeaderHeight();

    const node = headerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return () => { };
    }

    let rafId = 0;
    const scheduleUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        updateHeaderHeight();
      });
    };

    const observer = new ResizeObserver(scheduleUpdate);

    observer.observe(node);
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', scheduleUpdate);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('orientationchange', scheduleUpdate);
    };
  }, [updateHeaderHeight]);

  useEffect(() => {
    updateHeaderHeight();
  }, [updateHeaderHeight, isMobile, macosHeaderSizeClass]);

  const handleDragStart = React.useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.app-region-no-drag')) {
      return;
    }
    if (target.closest('button, a, input, select, textarea')) {
      return;
    }
    if (e.button !== 0) {
      return;
    }
    if (isDesktopApp) {
      await startDesktopWindowDrag();
    }
  }, [isDesktopApp]);

  const tabs: TabConfig[] = React.useMemo(() => {
    if (isMobile) {
      const base: TabConfig[] = [
        { id: 'chat', label: t('layout.mainTab.chat'), icon: RiChat4Line },
      ];

      if (showPlanTab) {
        base.push({ id: 'plan', label: t('layout.mainTab.plan'), icon: RiFileTextLine });
      }

      base.push(
        { id: 'diff', label: t('layout.mainTab.diff'), icon: 'diff' },
        { id: 'files', label: t('layout.mainTab.files'), icon: RiFolder6Line },
        { id: 'terminal', label: t('layout.mainTab.terminal'), icon: RiTerminalBoxLine },
      );

      return base;
    }

    // Desktop: no tabs in header
    return [];
  }, [isMobile, showPlanTab, t]);

  const shortcutLabel = React.useCallback((actionId: string) => {
    return formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides));
  }, [shortcutOverrides]);

  useEffect(() => {
    if (!isMobile && (activeMainTab === 'git' || activeMainTab === 'terminal' || activeMainTab === 'diff' || activeMainTab === 'files')) {
      setActiveMainTab('chat');
    }
  }, [activeMainTab, isMobile, setActiveMainTab]);

  const servicesTabs = React.useMemo(() => {
    const base: Array<{ value: 'instance' | 'mcp'; label: string; icon: RemixiconComponentType }> = [];
    if (isDesktopApp) {
      base.push({ value: 'instance', label: t('layout.services.instance'), icon: RiServerLine });
    }
    base.push({ value: 'mcp', label: 'MCP', icon: McpIcon as unknown as RemixiconComponentType });
    return base;
  }, [isDesktopApp, t]);

  const servicesTabItems = React.useMemo(() => {
    return servicesTabs.map((tab) => ({
      id: tab.value,
      label: tab.label,
      icon: <tab.icon className="h-3.5 w-3.5" />,
    }));
  }, [servicesTabs]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (hasModifier(e) && !e.shiftKey && !e.altKey) {
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= tabs.length) {
          e.preventDefault();
          setActiveMainTab(tabs[num - 1].id);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tabs, setActiveMainTab]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const toggleServicesCombo = getEffectiveShortcutCombo('toggle_services_menu', shortcutOverrides);
      if (eventMatchesShortcut(e, toggleServicesCombo)) {
        e.preventDefault();

        if (isDesktopServicesOpen) {
          setIsDesktopServicesOpen(false);
        } else {
          setIsDesktopServicesOpen(true);
          void refreshCurrentInstanceLabel();
        }
        return;
      }

      const cycleServicesCombo = getEffectiveShortcutCombo('cycle_services_tab', shortcutOverrides);
      if (eventMatchesShortcut(e, cycleServicesCombo)) {
        e.preventDefault();

        const tabValues = servicesTabs.map((tab) => tab.value) as Array<'instance' | 'mcp'>;
        if (tabValues.length === 0) {
          return;
        }

        const currentIndex = tabValues.indexOf(desktopServicesTab);
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % tabValues.length;
        const nextTab = tabValues[nextIndex];
        setDesktopServicesTab(nextTab);
        setIsDesktopServicesOpen(true);
        void refreshCurrentInstanceLabel();
        return;
      }

      const toggleContextPlanCombo = getEffectiveShortcutCombo('toggle_context_plan', shortcutOverrides);
      if (eventMatchesShortcut(e, toggleContextPlanCombo)) {
        e.preventDefault();
        handleOpenContextPlan();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    shortcutOverrides,
    isDesktopServicesOpen,
    desktopServicesTab,
    servicesTabs,
    refreshCurrentInstanceLabel,
    handleOpenContextPlan,
  ]);

  const renderTab = (tab: TabConfig) => {
    const isActive = activeMainTab === tab.id;
    const isDiffTab = tab.icon === 'diff';
    const Icon = isDiffTab ? null : (tab.icon as RemixiconComponentType);
    const isChatTab = tab.id === 'chat';

    const renderIcon = (iconSize: number) => {
      if (isDiffTab) {
        return <DiffIcon size={iconSize} />;
      }
      return Icon ? <Icon size={iconSize} /> : null;
    };

    const tabButton = (
      <button
        type="button"
        onClick={() => setActiveMainTab(tab.id)}
          className={cn(
            'relative flex h-8 items-center gap-2 px-3 rounded-lg typography-ui-label font-medium transition-colors',
            isActive
              ? 'app-region-no-drag bg-interactive-selection text-interactive-selection-foreground shadow-none'
              : 'app-region-no-drag text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            isChatTab && !isMobile && 'min-w-[100px] justify-center'
          )}
        aria-label={tab.label}
        aria-selected={isActive}
        role="tab"
      >
        {isMobile ? (
          renderIcon(20)
        ) : (
          <>
            {renderIcon(16)}
            <span className="header-tab-label">{tab.label}</span>
          </>
        )}

        {tab.badge !== undefined && tab.badge > 0 && (
          <span className="header-tab-badge typography-micro text-status-info font-medium">
            {tab.badge}
          </span>
        )}
      </button>
    );

    return <React.Fragment key={tab.id}>{tabButton}</React.Fragment>;
  };

  const desktopSidebarActions = (
    <>
      {showPlanTab && (
        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('header.actions.openPlanAria')}
                onClick={handleOpenContextPlan}
                className={cn(desktopHeaderIconButtonClass, isContextPlanActive && 'bg-[var(--interactive-hover)]')}
              >
              <RiFileTextLine className="h-[18px] w-[18px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t('header.actions.planWithShortcut', { shortcut: shortcutLabel('toggle_context_plan') })}</p>
          </TooltipContent>
        </Tooltip>
      )}
      <OpenInAppButton directory={actionDirectory} className="mr-1" />
      <DesktopServicesMenu
        isDesktopApp={isDesktopApp}
        currentInstanceLabel={currentInstanceLabel}
        compactCurrentInstanceLabel={compactCurrentInstanceLabel}
        isDesktopServicesOpen={isDesktopServicesOpen}
        setIsDesktopServicesOpen={setIsDesktopServicesOpen}
        refreshCurrentInstanceLabel={refreshCurrentInstanceLabel}
        desktopServicesTab={desktopServicesTab}
        setDesktopServicesTab={setDesktopServicesTab}
        servicesTabItems={servicesTabItems}
        shortcutLabel={shortcutLabel}
      />
      <HeaderIconActionButton
        title={t('header.actions.terminalPanelWithShortcut', { shortcut: shortcutLabel('toggle_terminal') })}
        ariaLabel={t('header.actions.toggleTerminalPanelAria')}
        onClick={toggleBottomTerminal}
        Icon={RiTerminalBoxLine}
      />
      <HeaderIconActionButton
        title={t('header.actions.rightSidebarWithShortcut', { shortcut: shortcutLabel('toggle_right_sidebar') })}
        ariaLabel={t('header.actions.toggleRightSidebarAria')}
        onClick={toggleRightSidebar}
        Icon={RiLayoutRightLine}
      />
    </>
  );

  const desktopSidebarActionsInline = !isRightSidebarOpen || !desktopRightSidebarActionsHost;

  const renderDesktop = () => (
    <div
      onMouseDown={handleDragStart}
      className={cn(
        'app-region-drag relative flex h-12 select-none items-center pr-3',
        desktopPaddingClass,
        macosHeaderSizeClass
      )}
      style={webWindowControlsOverlayStyle}
      role="tablist"
      aria-label={t('header.navigation.mainAria')}
    >
      <HeaderIconActionButton
        visible={!isSidebarOpen}
        title={t('header.actions.openSessionsWithShortcut', { shortcut: shortcutLabel('toggle_sidebar') })}
        ariaLabel={t('header.actions.openSessionsAria')}
        onClick={handleOpenSessionSwitcher}
        className={`${desktopHeaderIconButtonClass} shrink-0`}
        Icon={RiLayoutLeftLine}
      />

      <div className={cn('flex min-w-0 flex-1 items-center', !isSidebarOpen && 'pl-3')}>
        {!isLeftSidebarOpen ? (
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={t('header.actions.newSessionAria')}
                onClick={handleHeaderNewSession}
                className={cn(desktopHeaderIconButtonClass, 'mr-6 shrink-0')}
              >
                <RiChatNewLine className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('header.actions.newSessionWithShortcut', { shortcut: shortcutLabel('new_chat') })}</p>
            </TooltipContent>
          </Tooltip>
        ) : null}
        {projectActionsContext && (
          <ProjectActionsButton
            projectRef={projectActionsContext.projectRef}
            directory={projectActionsContext.directory}
            className="mr-2"
          />
        )}
        {!isNewSessionDraftOpen ? (
          <div className="mr-3 min-w-0">
            <div className="truncate pl-1 typography-ui-label text-[14px] font-normal leading-tight text-foreground">
              {currentSessionTitle}
            </div>
            {(activeProjectLabel || currentBranchLabel || hasNonZeroSessionChanges) ? (
              <div className="flex min-w-0 items-center gap-1.5 truncate pl-1 typography-micro text-[10.5px] font-normal leading-tight text-muted-foreground/75">
                {activeProjectLabel ? <span className="truncate">{activeProjectLabel}</span> : null}
                {currentBranchLabel ? (
                  <span className="inline-flex min-w-0 items-center gap-0.5">
                    <RiGitBranchLine className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
                    <span className="truncate">{currentBranchLabel}</span>
                  </span>
                ) : null}
                {hasNonZeroSessionChanges ? (
                  <span className="inline-flex flex-shrink-0 items-center gap-0 text-[0.92em]">
                    <span className="text-status-success/80">+{currentSessionChanges.additions}</span>
                    <span className="text-muted-foreground/60">/</span>
                    <span className="text-status-error/65">-{currentSessionChanges.deletions}</span>
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {tabs.length > 0 && (
          <div className="flex items-center gap-1 rounded-lg bg-[var(--surface-muted)]/50 p-1">
            {tabs.map((tab) => renderTab(tab))}
          </div>
        )}

        <div className="flex-1" />

        <div className="flex shrink-0 items-center gap-1">
          {showDesktopHeaderContextUsage && desktopHeaderContextUsage ? (
            <ContextUsageDisplay
              totalTokens={desktopHeaderContextUsage.totalTokens}
              percentage={desktopHeaderDisplayPercentage}
              colorPercentage={desktopHeaderContextUsage.percentage}
              contextLimit={desktopHeaderContextUsage.contextLimit}
              outputLimit={desktopHeaderContextUsage.outputLimit ?? 0}
              size="compact"
              hideIcon
              showPercentIcon
              onClick={handleOpenContextPanel}
              pressed={isContextPanelActive}
              className={desktopSidebarActionsInline ? 'mr-3.5' : ''}
              valueClassName="typography-ui-label font-medium leading-none text-foreground"
              percentIconClassName="h-5 w-5"
            />
          ) : null}
          {desktopSidebarActionsInline ? desktopSidebarActions : null}
          {!desktopSidebarActionsInline && desktopRightSidebarActionsHost
            ? createPortal(desktopSidebarActions, desktopRightSidebarActionsHost)
            : null}
        </div>
      </div>
    </div>
  );

  const renderMobile = () => (
    <div className="app-region-drag relative flex items-center gap-2 px-3 py-2 select-none">
      <div className="flex items-center gap-2 shrink-0">
        {/* Use drawer toggle when onToggleLeftDrawer is provided, otherwise use legacy session switcher */}
        {onToggleLeftDrawer ? (
          <button
            type="button"
            onClick={onToggleLeftDrawer}
            className={cn(
              mobileHeaderIconButtonClass,
              leftDrawerOpen && 'bg-interactive-selection text-interactive-selection-foreground'
            )}
            aria-label={leftDrawerOpen ? t('header.actions.closeSessionsAria') : t('header.actions.openSessionsAria')}
          >
            <RiLayoutLeftLine className="h-5 w-5" />
          </button>
        ) : isSessionSwitcherOpen ? (
          <button
            type="button"
            onClick={() => setSessionSwitcherOpen(false)}
            className="app-region-no-drag h-9 w-9 p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md active:bg-interactive-active"
            aria-label={t('header.actions.backAria')}
          >
            <RiArrowLeftSLine className="h-5 w-5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleOpenSessionSwitcher}
            className="app-region-no-drag h-9 w-9 p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md active:bg-interactive-active"
            aria-label={t('header.actions.openSessionsAria')}
          >
            <RiPlayListAddLine className="h-5 w-5" />
          </button>
        )}

        {isSessionSwitcherOpen && (
          <span className="typography-ui-label font-semibold text-foreground">{t('header.sessions.title')}</span>
        )}
      </div>

      {/* Hide tabs and right-side buttons when sessions sidebar is open */}
      {!isSessionSwitcherOpen && (
        <>
          <div className="app-region-no-drag flex min-w-0 flex-1 items-center">
            <div className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden scrollbar-hidden touch-pan-x overscroll-x-contain">
              <div className="flex w-max items-center gap-1 pr-1">
                <div
                  className="flex items-center gap-0.5 rounded-lg bg-[var(--surface-muted)]/50 p-0.5"
                  role="tablist"
                  aria-label={t('header.navigation.mainAria')}
                >
                  {tabs.map((tab) => {
                    const isActive = activeMainTab === tab.id;
                    const isDiffTab = tab.icon === 'diff';
                    const Icon = isDiffTab ? null : (tab.icon as RemixiconComponentType);
                    return (
                      <Tooltip key={tab.id} delayDuration={500}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => {
                              if (isMobile) {
                                blurActiveElement();
                              }
                              setActiveMainTab(tab.id);
                            }}
                            aria-label={tab.label}
                            aria-selected={isActive}
                            role="tab"
                            className={cn(
                              mobileHeaderIconButtonClass,
                              'relative rounded-lg',
                              isActive && 'bg-interactive-selection text-interactive-selection-foreground'
                            )}
                          >
                            {isDiffTab ? (
                              <DiffIcon className="h-5 w-5" />
                            ) : Icon ? (
                              <Icon className="h-5 w-5" />
                            ) : null}
                            {tab.badge !== undefined && tab.badge > 0 && (
                              <span className="absolute -top-1 -right-1 text-[10px] font-semibold text-primary">
                                {tab.badge}
                              </span>
                            )}
                            {tab.showDot && (
                              <span
                                className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-primary"
                                aria-label={t('header.changes.availableAria')}
                              />
                            )}
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>{tab.label}</p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {projectActionsContext && (
              <ProjectActionsButton
                projectRef={projectActionsContext.projectRef}
                directory={projectActionsContext.directory}
                compact
                allowMobile
                className="h-9"
              />
            )}

            {/* Mobile Services Menu (MCP) */}
            <DropdownMenu
              open={isMobileRateLimitsOpen}
              onOpenChange={setIsMobileRateLimitsOpen}
            >
              <Tooltip delayDuration={500}>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label={t('header.services.viewAria')}
                      className={mobileHeaderIconButtonClass}
                    >
                      <RiStackLine className="h-5 w-5" />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t('header.services.title')}</p>
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent
                align="end"
                sideOffset={0}
                className="h-dvh w-[100vw] max-h-none rounded-none border-0 p-0 overflow-hidden"
              >
                <div className="flex h-full flex-col bg-[var(--surface-elevated)]">
          <div className="sticky top-0 z-20 bg-[var(--surface-elevated)] px-2 py-px">
                    <div className="flex items-center justify-between gap-2 px-3 py-0">
                      <span className="typography-ui-header min-w-0 flex-1 truncate font-semibold text-foreground">MCP</span>
                      <button
                        type="button"
                        onClick={() => setIsMobileRateLimitsOpen(false)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover"
                        aria-label={t('header.services.closeAria')}
                      >
                        <RiCloseLine className="h-5 w-5" />
                      </button>
                    </div>
                  </div>

                  <McpDropdownContent active={isMobileRateLimitsOpen} />
                </div>
              </DropdownMenuContent>
            </DropdownMenu>

            {onToggleRightDrawer ? (
              <Tooltip delayDuration={500}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onToggleRightDrawer}
                    className={cn(
                      mobileHeaderIconButtonClass,
                      'relative',
                      rightDrawerOpen && 'bg-interactive-selection text-interactive-selection-foreground'
                    )}
                    aria-label={rightDrawerOpen ? 'Close git sidebar' : 'Open git sidebar'}
                  >
                    <RiLayoutRightLine className="h-5 w-5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{rightDrawerOpen ? 'Close git sidebar' : 'Open git sidebar'}</p>
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
        </>
      )}
    </div>
  );

  const headerClassName = cn(
    'header-safe-area relative z-10',
    isMobile && 'border-b border-border/50',
    'bg-background'
  );

  return (
    <header
      ref={headerRef}
      className={headerClassName}
      style={{ ['--padding-scale' as string]: '1' } as React.CSSProperties}
    >
      {isMobile ? renderMobile() : renderDesktop()}
    </header>
  );
};
