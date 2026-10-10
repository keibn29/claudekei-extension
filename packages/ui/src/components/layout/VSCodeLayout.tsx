import React from 'react';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { SessionSidebar } from '@/components/session/SessionSidebar';
import { ChatView } from '@/components/views';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useViewportStore } from '@/sync/viewport-store';
import { useSessions, useDirectorySync, useSessionMessageRecords } from '@/sync/sync-context';
import { useConfigStore } from '@/stores/useConfigStore';
import { McpDropdown } from '@/components/mcp/McpDropdown';
import { ContextUsagePopover } from './ContextUsagePopover';
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { resolveDisplayContextUsage } from '@/lib/contextUsage';
import type { SessionContextUsage } from '@/stores/types/sessionTypes';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useCurrentSessionIsSubtask } from '@/hooks/useCurrentSessionIsSubtask';
import { RiAddLine, RiArrowLeftLine, RiSettings3Line, RiTimeLine } from '@remixicon/react';
import { useUIStore } from '@/stores/useUIStore';

const SettingsView = lazyWithChunkRecovery(() => import('@/components/views/SettingsView').then(m => ({ default: m.SettingsView })));

type ModelLimits = {
  context: number;
  output: number;
};

type ProviderLike = {
  id: string;
  models?: Array<{
    id: string;
    limit?: {
      context?: number;
      output?: number;
    } | null;
  }>;
};

const readModelLimits = (limit: { context?: number; output?: number } | null | undefined): ModelLimits => ({
  context: typeof limit?.context === 'number' ? limit.context : 0,
  output: typeof limit?.output === 'number' ? limit.output : 0,
});

const resolveModelLimits = (
  providers: ProviderLike[],
  providerId?: string,
  modelId?: string,
): ModelLimits | null => {
  if (!providerId || !modelId) return null;
  const provider = providers.find((entry) => entry.id === providerId);
  const model = provider?.models?.find((entry) => entry.id === modelId);
  return model ? readModelLimits(model.limit ?? null) : null;
};

// Width threshold for mobile vs desktop layout in settings
const MOBILE_WIDTH_THRESHOLD = 550;
// Width threshold for expanded layout (sidebar + chat side by side)
const EXPANDED_LAYOUT_THRESHOLD = 1400;
// Sessions sidebar width in expanded layout
const SESSIONS_SIDEBAR_WIDTH = 280;
const SESSIONS_SIDEBAR_MIN_WIDTH = Math.round(SESSIONS_SIDEBAR_WIDTH * 0.7);
const SESSIONS_SIDEBAR_MAX_WIDTH = 520;

type VSCodeView = 'sessions' | 'chat' | 'settings';

export const VSCodeLayout: React.FC = () => {
  const { t } = useI18n();
  const runtimeApis = useRuntimeAPIs();

  const viewMode = React.useMemo<'sidebar' | 'editor'>(() => {
    const configured =
      typeof window !== 'undefined'
        ? (window as unknown as { __VSCODE_CONFIG__?: { viewMode?: unknown } }).__VSCODE_CONFIG__?.viewMode
        : null;
    return configured === 'editor' ? 'editor' : 'sidebar';
  }, []);

  const initialSessionId = React.useMemo<string | null>(() => {
    const configured =
      typeof window !== 'undefined'
        ? (window as unknown as { __VSCODE_CONFIG__?: { initialSessionId?: unknown } }).__VSCODE_CONFIG__?.initialSessionId
        : null;
    if (typeof configured === 'string' && configured.trim().length > 0) {
      return configured.trim();
    }
    return null;
  }, []);

  const hasAppliedInitialSession = React.useRef(false);

  const bootDraftOpen = React.useMemo(() => {
    try {
      return Boolean(useSessionUIStore.getState().newSessionDraft?.open);
    } catch {
      return false;
    }
  }, []);

  const [currentView, setCurrentView] = React.useState<VSCodeView>(() => (bootDraftOpen ? 'chat' : 'sessions'));
  const [containerWidth, setContainerWidth] = React.useState<number>(0);
  const [expandedSidebarWidth, setExpandedSidebarWidth] = React.useState<number>(SESSIONS_SIDEBAR_WIDTH);
  const [isResizingExpandedSidebar, setIsResizingExpandedSidebar] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const expandedSidebarResizeStartXRef = React.useRef(0);
  const expandedSidebarResizeStartWidthRef = React.useRef(SESSIONS_SIDEBAR_WIDTH);
  const expandedSidebarResizePointerIdRef = React.useRef<number | null>(null);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const sessions = useSessions();

  const activeSessionTitle = React.useMemo(() => {
    if (!currentSessionId) {
      return null;
    }
    return sessions.find((session) => session.id === currentSessionId)?.title || t('vscodeLayout.title.sessionFallback');
  }, [currentSessionId, sessions, t]);
  const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const isSyncingMessages = useViewportStore((state) => state.isSyncing);
  const hasActiveSessionWork = useDirectorySync((state) => {
    const statuses = state.session_status;
    if (!statuses || Object.keys(statuses).length === 0) {
      return false;
    }
    for (const status of Object.values(statuses)) {
      if (status?.type === 'busy' || status?.type === 'retry') {
        return true;
      }
    }
    return false;
  });
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const [connectionStatus, setConnectionStatus] = React.useState<'connecting' | 'connected' | 'error' | 'disconnected'>(
    () => (typeof window !== 'undefined'
      ? (window as { __OPENCHAMBER_CONNECTION__?: { status?: string } }).__OPENCHAMBER_CONNECTION__?.status as
        'connecting' | 'connected' | 'error' | 'disconnected' | undefined
      : 'connecting') || 'connecting'
  );
  const configInitialized = useConfigStore((state) => state.isInitialized);
  const initializeConfig = useConfigStore((state) => state.initializeApp);
  const [hasInitializedOnce, setHasInitializedOnce] = React.useState<boolean>(() => configInitialized);
  const [isInitializing, setIsInitializing] = React.useState<boolean>(false);
  const lastBootstrapAttemptAt = React.useRef<number>(0);

  // Navigate to chat when a session is selected
  React.useEffect(() => {
    if (currentSessionId) {
      setCurrentView('chat');
    }
  }, [currentSessionId]);

  React.useEffect(() => {
    const vscodeApi = runtimeApis.vscode;
    if (!vscodeApi) {
      return;
    }

    void vscodeApi.executeCommand('claudekei.setActiveSession', currentSessionId, activeSessionTitle);
  }, [activeSessionTitle, currentSessionId, runtimeApis.vscode]);

  // If the active session disappears (e.g., deleted), go back to sessions list
  React.useEffect(() => {
    if (viewMode === 'editor') {
      return;
    }

    if (currentView !== 'chat') {
      return;
    }

    if (currentSessionId || newSessionDraftOpen || isSyncingMessages || hasActiveSessionWork) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const state = useSessionUIStore.getState();
      const stillNoSession = !state.currentSessionId;
      const draftStillClosed = !state.newSessionDraft?.open;
      const stillSyncing = useViewportStore.getState().isSyncing;
      const stillActiveWork = false; // sync bootstrap tracks session status

      if (stillNoSession && draftStillClosed && !stillSyncing && !stillActiveWork) {
        setCurrentView('sessions');
      }
    }, 900);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [currentSessionId, newSessionDraftOpen, currentView, viewMode, isSyncingMessages, hasActiveSessionWork]);

  const handleBackToSessions = React.useCallback(() => {
    setCurrentView('sessions');
  }, []);


  // Listen for connection status changes
  React.useEffect(() => {
    // Catch up with the latest status even if the extension posted the connection message
    // before this component registered the event listener.
    const current =
      (typeof window !== 'undefined'
        ? (window as { __OPENCHAMBER_CONNECTION__?: { status?: string } }).__OPENCHAMBER_CONNECTION__?.status
        : undefined) as 'connecting' | 'connected' | 'error' | 'disconnected' | undefined;
    if (current === 'connected' || current === 'connecting' || current === 'error' || current === 'disconnected') {
      setConnectionStatus(current);
    }

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ status?: string; error?: string }>).detail;
      const status = detail?.status;
      if (status === 'connected' || status === 'connecting' || status === 'error' || status === 'disconnected') {
        setConnectionStatus(status);
      }
    };
    window.addEventListener('openchamber:connection-status', handler as EventListener);
    return () => window.removeEventListener('openchamber:connection-status', handler as EventListener);
  }, []);

  // Listen for navigation events from VS Code extension title bar buttons
  React.useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ view?: string }>).detail;
      const view = detail?.view;
      if (view === 'settings') {
        setCurrentView('settings');
      } else if (view === 'chat') {
        setCurrentView('chat');
      } else if (view === 'sessions') {
        setCurrentView('sessions');
      }
    };
    window.addEventListener('openchamber:navigate', handler as EventListener);
    return () => window.removeEventListener('openchamber:navigate', handler as EventListener);
  }, []);

  // Bootstrap config and sessions when connected
  React.useEffect(() => {
    const runBootstrap = async () => {
      if (isInitializing || hasInitializedOnce || connectionStatus !== 'connected') {
        return;
      }
      const now = Date.now();
      if (now - lastBootstrapAttemptAt.current < 750) {
        return;
      }
      lastBootstrapAttemptAt.current = now;
      setIsInitializing(true);
      try {
        const debugEnabled = (() => {
          if (typeof window === 'undefined') return false;
          try {
            return window.localStorage.getItem('openchamber_stream_debug') === '1';
          } catch {
            return false;
          }
        })();

        if (debugEnabled) console.log('[OpenChamber][VSCode][bootstrap] attempt', { configInitialized });
        if (!configInitialized) {
          await initializeConfig();
        }
        const configStore = useConfigStore.getState();

        // Keep trying to fetch core datasets on cold starts.
        if (configStore.isConnected) {
          if (configStore.providers.length === 0) {
            await configStore.loadProviders();
          }
          if (configStore.agents.length === 0) {
            await configStore.loadAgents();
          }
        }

        const configState = useConfigStore.getState();
        // If OpenCode is still warming up, the initial provider/agent loads can fail and be swallowed by retries.
        // Only mark bootstrap complete when core datasets are present so we keep retrying on cold starts.
        if (!configState.isInitialized || !configState.isConnected || configState.providers.length === 0 || configState.agents.length === 0) {
          return;
        }
        if (debugEnabled) console.log('[OpenChamber][VSCode][bootstrap] post-load', {
          providers: configState.providers.length,
          agents: configState.agents.length,
        });
        setHasInitializedOnce(true);
      } catch {
        // Ignore bootstrap failures
      } finally {
        setIsInitializing(false);
      }
    };
    void runBootstrap();
  }, [connectionStatus, configInitialized, hasInitializedOnce, initializeConfig, isInitializing]);

  React.useEffect(() => {
    if (viewMode !== 'editor') {
      return;
    }
    if (hasAppliedInitialSession.current) {
      return;
    }
    if (!hasInitializedOnce || connectionStatus !== 'connected') {
      return;
    }

    // No initialSessionId means open a new session draft
    if (!initialSessionId) {
      hasAppliedInitialSession.current = true;
      openNewSessionDraft();
      return;
    }

    if (!sessions.some((session) => session.id === initialSessionId)) {
      return;
    }

    hasAppliedInitialSession.current = true;
    void useSessionUIStore.getState().setCurrentSession(initialSessionId);
  }, [connectionStatus, hasInitializedOnce, initialSessionId, openNewSessionDraft, sessions, viewMode]);

  // Track container width for responsive settings layout
  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    observer.observe(container);
    // Set initial width
    setContainerWidth(container.clientWidth);

    return () => observer.disconnect();
  }, []);

  const usesMobileLayout = containerWidth > 0 && containerWidth < MOBILE_WIDTH_THRESHOLD;
  const usesExpandedLayout = containerWidth >= EXPANDED_LAYOUT_THRESHOLD;

  const clampExpandedSidebarWidth = React.useCallback((value: number) => {
    return Math.min(SESSIONS_SIDEBAR_MAX_WIDTH, Math.max(SESSIONS_SIDEBAR_MIN_WIDTH, value));
  }, []);

  const handleExpandedSidebarResizeStart = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    expandedSidebarResizePointerIdRef.current = event.pointerId;
    expandedSidebarResizeStartXRef.current = event.clientX;
    expandedSidebarResizeStartWidthRef.current = expandedSidebarWidth;
    setIsResizingExpandedSidebar(true);
    event.preventDefault();
  }, [expandedSidebarWidth]);

  const handleExpandedSidebarResizeMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (expandedSidebarResizePointerIdRef.current !== event.pointerId) {
      return;
    }
    const delta = event.clientX - expandedSidebarResizeStartXRef.current;
    const nextWidth = clampExpandedSidebarWidth(expandedSidebarResizeStartWidthRef.current + delta);
    setExpandedSidebarWidth((current) => (current === nextWidth ? current : nextWidth));
  }, [clampExpandedSidebarWidth]);

  const handleExpandedSidebarResizeEnd = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (expandedSidebarResizePointerIdRef.current !== event.pointerId) {
      return;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    expandedSidebarResizePointerIdRef.current = null;
    setIsResizingExpandedSidebar(false);
  }, []);

  // In expanded layout, always show chat (with sidebar alongside)
  // Navigate to chat automatically when expanded layout is enabled and we're on sessions view
  React.useEffect(() => {
    if (usesExpandedLayout && currentView === 'sessions' && viewMode === 'sidebar') {
      setCurrentView('chat');
    }
  }, [usesExpandedLayout, currentView, viewMode]);

  return (
    <div ref={containerRef} className="h-full w-full bg-background text-foreground flex flex-col">
      {viewMode === 'editor' ? (
        // Editor mode: just chat, no sidebar
        <div className="flex flex-col h-full">
          <VSCodeHeader
            title={sessions.find((session) => session.id === currentSessionId)?.title || t('vscodeLayout.title.chat')}
            showMcp
            showContextUsage
          />
          <div className="flex-1 overflow-hidden">
            <ErrorBoundary>
              <ChatView />
            </ErrorBoundary>
          </div>
        </div>
      ) : currentView === 'settings' ? (
        // Settings view
        <React.Suspense fallback={null}>
          <SettingsView
            onClose={() => setCurrentView(usesExpandedLayout ? 'chat' : 'sessions')}
            forceMobile={usesMobileLayout}
          />
        </React.Suspense>
      ) : usesExpandedLayout ? (
        // Expanded layout: sessions sidebar + chat side by side
        <div className="flex h-full">
          {/* Sessions sidebar */}
          <div
            className={cn('relative h-full border-r border-border overflow-hidden flex-shrink-0', isResizingExpandedSidebar && 'select-none')}
            style={{ width: expandedSidebarWidth, minWidth: expandedSidebarWidth, maxWidth: expandedSidebarWidth }}
          >
            <SessionSidebar
              mobileVariant
              allowReselect
              hideDirectoryControls
              showOnlyMainWorkspace
            />
            <div
              className={cn(
                'absolute right-0 top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
                isResizingExpandedSidebar && 'bg-[var(--interactive-border)]'
              )}
              onPointerDown={handleExpandedSidebarResizeStart}
              onPointerMove={handleExpandedSidebarResizeMove}
              onPointerUp={handleExpandedSidebarResizeEnd}
              onPointerCancel={handleExpandedSidebarResizeEnd}
              role="separator"
              aria-orientation="vertical"
              aria-label={t('vscodeLayout.actions.resizeSessionsSidebarAria')}
            />
          </div>
          {/* Chat content */}
          <div className="flex-1 flex flex-col min-w-0">
            <VSCodeHeader
              title={newSessionDraftOpen && !currentSessionId
                ? t('vscodeLayout.title.newSession')
                : sessions.find((session) => session.id === currentSessionId)?.title || t('vscodeLayout.title.chat')}
              showMcp
              showContextUsage
            />
            <div className="flex-1 overflow-hidden">
              <ErrorBoundary>
                <ChatView />
              </ErrorBoundary>
            </div>
          </div>
        </div>
      ) : (
        // Compact layout: drill-down between sessions list and chat
        <>
          {/* Sessions list view */}
          <div className={cn('flex flex-col h-full', currentView !== 'sessions' && 'hidden')}>
            <VSCodeHeader
              title={t('vscodeLayout.title.sessions')}
            />
            <div className="flex-1 overflow-hidden">
              <SessionSidebar
                mobileVariant
                allowReselect
                onSessionSelected={() => setCurrentView('chat')}
                hideDirectoryControls
                showOnlyMainWorkspace
              />
            </div>
          </div>
          {/* Chat view */}
          <div className={cn('flex flex-col h-full', currentView !== 'chat' && 'hidden')}>
            <VSCodeHeader
              title={newSessionDraftOpen && !currentSessionId
                ? t('vscodeLayout.title.newSession')
                : sessions.find((session) => session.id === currentSessionId)?.title || t('vscodeLayout.title.chat')}
              showBack
              onBack={handleBackToSessions}
              showMcp
              showContextUsage
            />
            <div className="flex-1 overflow-hidden">
              <ErrorBoundary>
                <ChatView />
              </ErrorBoundary>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

interface VSCodeHeaderProps {
  title: string;
  showBack?: boolean;
  onBack?: () => void;
  onNewSession?: () => void;
  onSettings?: () => void;
  showMcp?: boolean;
  showContextUsage?: boolean;
}

const VSCodeHeader: React.FC<VSCodeHeaderProps> = ({ title, showBack, onBack, onNewSession, onSettings, showMcp, showContextUsage }) => {
  const { t } = useI18n();
  const getCurrentModel = useConfigStore((s) => s.getCurrentModel);
  const providers = useConfigStore((s) => s.providers);
  const getContextUsage = useSessionUIStore((state) => state.getContextUsage);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const getLastUserChoice = useSessionUIStore((state) => state.getLastUserChoice);
  // In a subagent session the SubagentHeader's "Back to <Parent>" is the only back navigation.
  const isSubagentSession = useCurrentSessionIsSubtask();

  const currentModel = getCurrentModel();
  const fallbackLimits = React.useMemo(
    () => readModelLimits(currentModel?.limit && typeof currentModel.limit === 'object' ? currentModel.limit : null),
    [currentModel],
  );
  // Always the main/current session: an expanded subagent (`sub_<callId>`) has no context of its own, so focusing it
  // would blank the exact context and the limits.
  const contextUsageSessionId = currentSessionId;
  const sessionChoice = React.useMemo(
    () => (contextUsageSessionId ? getLastUserChoice(contextUsageSessionId) : null),
    [contextUsageSessionId, getLastUserChoice],
  );
  const sessionLimits = React.useMemo(
    () => resolveModelLimits(providers as ProviderLike[], sessionChoice?.providerID, sessionChoice?.modelID),
    [providers, sessionChoice?.modelID, sessionChoice?.providerID],
  );
  const contextLimit = sessionLimits?.context ?? fallbackLimits.context;
  const outputLimit = sessionLimits?.output ?? fallbackLimits.output;
  const contextUsageRecords = useSessionMessageRecords(contextUsageSessionId ?? '');
  const contextUsage = React.useMemo(
    () => {
      void contextUsageRecords;
      return getContextUsage(contextLimit, outputLimit, contextUsageSessionId ?? undefined);
    },
    [contextLimit, contextUsageRecords, contextUsageSessionId, getContextUsage, outputLimit],
  );
  const lastKnownContextUsageRef = React.useRef<{ sessionId: string; usage: SessionContextUsage } | null>(null);
  const visibleContextUsage = React.useMemo(
    () => {
      const known = lastKnownContextUsageRef.current;
      const lastKnown = known && known.sessionId === contextUsageSessionId ? known.usage : null;
      const resolved = resolveDisplayContextUsage(contextUsageSessionId, contextUsage, contextLimit, outputLimit, lastKnown);
      if (contextUsageSessionId && contextUsage) {
        lastKnownContextUsageRef.current = { sessionId: contextUsageSessionId, usage: contextUsage };
      }
      return resolved;
    },
    [contextLimit, contextUsage, contextUsageSessionId, outputLimit],
  );
  const displayPercentage = visibleContextUsage && visibleContextUsage.contextLimit > 0
    ? (visibleContextUsage.totalTokens / visibleContextUsage.contextLimit) * 100
    : 0;
  // New-session draft: no session yet, but the popover still shows the (global) plan limits.

  return (
    <div className="flex items-center gap-1.5 pl-3 pr-2 py-1 border-b border-border bg-background shrink-0">
      {showBack && onBack && !isSubagentSession && (
        <button
          onClick={onBack}
          className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('vscodeLayout.actions.backToSessionsAria')}
        >
          <RiArrowLeftLine className="h-5 w-5" />
        </button>
      )}
      <h1 className="text-sm font-medium truncate flex-1" title={title}>{title}</h1>
      {onNewSession && (
        <button
          onClick={onNewSession}
          className="inline-flex h-9 w-9 items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('vscodeLayout.actions.newSessionAria')}
        >
          <RiAddLine className="h-5 w-5" />
        </button>
      )}
      {showContextUsage && currentSessionId && !isSubagentSession && (
        <button
          onClick={() => useUIStore.getState().setTimelineDialogOpen(true)}
          className="inline-flex h-9 w-9 items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('vscodeLayout.actions.timelineAria')}
          title={t('vscodeLayout.actions.timelineAria')}
        >
          <RiTimeLine className="h-5 w-5" />
        </button>
      )}
      {showMcp && (
        <McpDropdown
          headerIconButtonClass="inline-flex h-9 w-9 items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
      )}
      {onSettings && (
        <button
          onClick={onSettings}
          className="inline-flex h-9 w-9 items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('vscodeLayout.actions.settingsAria')}
        >
          <RiSettings3Line className="h-5 w-5" />
        </button>
      )}
      {showContextUsage && (
        <ContextUsagePopover
          sessionId={contextUsageSessionId}
          fallback={{
            percentage: displayPercentage,
            totalTokens: visibleContextUsage?.totalTokens ?? 0,
            totalCost: visibleContextUsage?.totalCost ?? 0,
          }}
          ariaLabel={t('contextUsage.aria.label')}
        />
      )}
    </div>
  );
};
