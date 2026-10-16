import { createVSCodeAPIs } from './api';
import { onCommand, onThemeChange, sendBridgeMessage } from './api/bridge';
import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';
import {
  buildVSCodeThemeFromPalette,
  readVSCodeThemePalette,
  type VSCodeThemeKind,
  type VSCodeThemePayload,
} from '@openchamber/ui/lib/theme/vscode/adapter';

type ConnectionStatus = 'connecting' | 'connected' | 'error' | 'disconnected';

declare const __OPENCHAMBER_WEBVIEW_BUILD_TIME__: string;

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
    __VSCODE_CONFIG__?: {
      apiUrl?: string;
      workspaceFolder: string;
      theme: string;
      connectionStatus: string;
      cliAvailable?: boolean;
      viewMode?: 'sidebar' | 'editor';
      initialSessionId?: string | null;
    };
    __OPENCHAMBER_VSCODE_THEME__?: VSCodeThemePayload['theme'];
    __OPENCHAMBER_VSCODE_SHIKI_THEMES__?: { light?: Record<string, unknown>; dark?: Record<string, unknown> } | null;
    __OPENCHAMBER_CONNECTION__?: { status: ConnectionStatus; error?: string; cliAvailable?: boolean };
    __OPENCHAMBER_HOME__?: string;
  }
}

console.log('[ClaudeKei] VS Code webview starting...');
console.log('[ClaudeKei] VS Code webview build:', __OPENCHAMBER_WEBVIEW_BUILD_TIME__);
console.log('[ClaudeKei] Config:', window.__VSCODE_CONFIG__);
try {
  if (window.localStorage.getItem('openchamber_stream_debug') === '1') {
    console.log('[ClaudeKei] Debug: openchamber_stream_debug=1');
  }
} catch {
  // ignore
}

const runtimeApis = createVSCodeAPIs();
window.__OPENCHAMBER_RUNTIME_APIS__ = runtimeApis;

// Dev only: `?mock=claude` (or VITE_CLAUDE_MOCK=1) swaps the host transport for an in-memory
// scripted runtime so the UI can be developed without the extension host. Never enabled by default.
const useClaudeMock = (() => {
  try {
    return new URLSearchParams(window.location.search).get('mock') === 'claude'
      || import.meta.env.VITE_CLAUDE_MOCK === '1';
  } catch {
    return false;
  }
})();
if (useClaudeMock) {
  if (!window.__VSCODE_CONFIG__?.workspaceFolder) {
    window.__VSCODE_CONFIG__ = {
      theme: 'dark',
      connectionStatus: 'connected',
      // `?view=editor` shows the chat (editor-tab layout) instead of the sessions sidebar.
      viewMode: new URLSearchParams(window.location.search).get('view') === 'editor' ? 'editor' : 'sidebar',
      ...window.__VSCODE_CONFIG__,
      workspaceFolder: '/mock/workspace',
    };
  }
  // Dev only: the extension host HTML (webviewHtml.ts) provides the full-height root and the
  // `--vscode-*` variables. Emulate the former so `?mock=claude` lays out like the real webview.
  // (The app's own theme is fixed to a dark theme inside VS Code, so no theme variables are needed.)
  {
    const style = document.createElement('style');
    style.textContent = 'html, body, #root { height: 100%; width: 100%; margin: 0; padding: 0; } body { overflow: hidden; }';
    document.head.appendChild(style);
  }
  // Outside VS Code there is no host to answer the remaining bridge calls: fail them fast.
  const globalWithApi = window as unknown as { acquireVsCodeApi?: () => unknown };
  if (typeof globalWithApi.acquireVsCodeApi !== 'function') {
    globalWithApi.acquireVsCodeApi = () => ({
      postMessage: (message: { id?: string; type?: string }) => {
        if (!message?.id) return;
        window.postMessage({ id: message.id, type: message.type, success: false, error: 'Not available in mock mode' }, '*');
      },
      getState: () => undefined,
      setState: () => undefined,
    });
  }
}
const mockRuntimeReady: Promise<void> = useClaudeMock
  ? import('@openchamber/ui/lib/claude/mockRuntime').then(({ createMockClaudeRuntime }) => {
      runtimeApis.claude = createMockClaudeRuntime();
      console.warn('[ClaudeKei] Using the in-memory mock Claude runtime (?mock=claude)');
    })
  : Promise.resolve();

const bootstrapConnectionStatus = () => {
  const initialStatus = (window.__VSCODE_CONFIG__?.connectionStatus as ConnectionStatus | undefined) || 'connecting';
  const cliAvailable = window.__VSCODE_CONFIG__?.cliAvailable ?? true;
  window.__OPENCHAMBER_CONNECTION__ = { status: initialStatus, cliAvailable };
};

bootstrapConnectionStatus();

const handleConnectionMessage = (event: MessageEvent) => {
  const msg = event.data;
  if (msg?.type === 'connectionStatus') {
    const payload: ConnectionStatus = msg.status;
    const error: string | undefined = msg.error;
    const prevCliAvailable = window.__OPENCHAMBER_CONNECTION__?.cliAvailable ?? true;
    window.__OPENCHAMBER_CONNECTION__ = { status: payload, error, cliAvailable: prevCliAvailable };
    window.dispatchEvent(new CustomEvent('openchamber:connection-status', { detail: { status: payload, error } }));
  }
};

window.addEventListener('message', handleConnectionMessage);
window.addEventListener('openchamber:connection-status', () => {
  maybeHideLoadingOverlay();
});

const fadeOutLoadingScreen = () => {
  const loadingEl = document.getElementById('initial-loading');
  if (!loadingEl) return;
  loadingEl.classList.add('fade-out');
  setTimeout(() => {
    try {
      loadingEl.remove();
    } catch {
      // ignore
    }
  }, 300);
};

const setLoadingStatusText = (text: string, variant: 'normal' | 'error' = 'normal') => {
  const statusEl = document.getElementById('loading-status');
  if (!statusEl) return;
  statusEl.textContent = text;
  if (variant === 'error') {
    statusEl.classList.add('error-text');
  } else {
    statusEl.classList.remove('error-text');
  }
};

const waitForUiMount = (timeoutMs = 8000): Promise<boolean> => {
  if (typeof document === 'undefined') return Promise.resolve(false);
  const root = document.getElementById('root');
  if (!root) return Promise.resolve(false);

  const hasContent = () => root.childNodes.length > 0;
  if (hasContent()) return Promise.resolve(true);

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (hasContent()) {
        observer.disconnect();
        clearTimeout(timeout);
        resolve(true);
      }
    });

    observer.observe(root, { childList: true, subtree: true });

    const timeout = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, timeoutMs);
  });
};

let uiMounted = false;
let bootstrapReady = false;
let bootstrapFailed = false;

// The overlay waits for the first `claude:bootstrap` answer (catalog, sessions, account).
const trackBootstrap = () => {
  const claude = runtimeApis.claude;
  if (!claude) return;
  const request = claude.request.bind(claude);
  claude.request = (async (type, payload) => {
    try {
      const result = await request(type, payload);
      if (type === 'claude:bootstrap') {
        bootstrapReady = true;
        bootstrapFailed = false;
        maybeHideLoadingOverlay();
      }
      return result;
    } catch (error) {
      if (type === 'claude:bootstrap' && !bootstrapReady) {
        bootstrapFailed = true;
        maybeHideLoadingOverlay();
      }
      throw error;
    }
  }) as typeof claude.request;
};

const maybeHideLoadingOverlay = () => {
  const connectionStatus = window.__OPENCHAMBER_CONNECTION__?.status ?? 'connecting';

  if (!uiMounted) {
    return;
  }

  // A completed bootstrap proves the host is reachable even before connectionStatus arrives.
  if (bootstrapReady && connectionStatus !== 'error' && connectionStatus !== 'disconnected') {
    fadeOutLoadingScreen();
    return;
  }

  if (connectionStatus === 'connected') {
    if (bootstrapFailed) {
      setLoadingStatusText('Claude connected, but initial data load failed.', 'error');
      fadeOutLoadingScreen();
      return;
    }

    setLoadingStatusText('Loading Claude sessions and models…');
    return;
  }

  if (connectionStatus === 'error') {
    const error = window.__OPENCHAMBER_CONNECTION__?.error;
    setLoadingStatusText(error || 'Connection error', 'error');
    fadeOutLoadingScreen();
    return;
  }

  if (connectionStatus === 'disconnected') {
    setLoadingStatusText('Disconnected', 'error');
    fadeOutLoadingScreen();
    return;
  }

  setLoadingStatusText('Starting Claude…');
};

const applyInitialTheme = (theme: { metadata?: { variant?: string }; colors?: { surface?: { background?: string; foreground?: string } } }) => {
  if (typeof document === 'undefined' || !theme) return;
  const variant = theme.metadata?.variant === 'dark' ? 'dark' : 'light';
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  root.classList.add(variant);

  const background = theme.colors?.surface?.background;
  if (background) {
    document.body.style.backgroundColor = background;
    let meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;
    if (!meta) {
      meta = document.createElement('meta');
      meta.setAttribute('name', 'theme-color');
      document.head.appendChild(meta);
    }
    meta.setAttribute('content', background);
  }
};

const emitVSCodeTheme = (preferredKind?: VSCodeThemeKind) => {
  const palette = readVSCodeThemePalette(preferredKind);
  if (!palette) {
    return;
  }
  const theme = buildVSCodeThemeFromPalette(palette);
  window.__OPENCHAMBER_VSCODE_THEME__ = theme;
   applyInitialTheme(theme);
  window.dispatchEvent(new CustomEvent<VSCodeThemePayload>('openchamber:vscode-theme', {
    detail: { theme, palette },
  }));
};

emitVSCodeTheme(window.__VSCODE_CONFIG__?.theme as VSCodeThemeKind | undefined);

const scheduleThemeRecompute = (kind?: VSCodeThemeKind) => {
  // VS Code updates webview CSS variables asynchronously around theme changes.
  // Re-read on the next frames so we don't snapshot the old palette.
  requestAnimationFrame(() => {
    emitVSCodeTheme(kind);
    requestAnimationFrame(() => emitVSCodeTheme(kind));
  });
};

onThemeChange((payload) => {
  const kind = (typeof payload === 'string'
    ? payload
    : typeof payload === 'object' && payload
      ? payload.kind
      : undefined) as VSCodeThemeKind | undefined;

  if (typeof payload === 'object' && payload?.shikiThemes !== undefined) {
    window.__OPENCHAMBER_VSCODE_SHIKI_THEMES__ = payload.shikiThemes;
    window.dispatchEvent(
      new CustomEvent('openchamber:vscode-shiki-themes', {
        detail: { shikiThemes: payload.shikiThemes },
      }),
    );
  }

  scheduleThemeRecompute(kind);
});

const workspaceFolder = window.__VSCODE_CONFIG__?.workspaceFolder;
if (workspaceFolder) {
  const normalizeWorkspacePath = (value: string) => {
    const normalized = value
      .replace(/\\/g, '/')
      .replace(/^([a-z]):\//, (_, letter: string) => `${letter.toUpperCase()}:/`)
      .replace(/^\/([a-z]):\//, (_, letter: string) => `/${letter.toUpperCase()}:/`);
    if (normalized === '/') {
      return '/';
    }
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
  };

  const normalizedWorkspaceFolder = normalizeWorkspacePath(workspaceFolder);
  window.__OPENCHAMBER_HOME__ = normalizedWorkspaceFolder;
  try {
    window.localStorage.setItem('lastDirectory', normalizedWorkspaceFolder);
    window.localStorage.setItem('homeDirectory', normalizedWorkspaceFolder);

    // VS Code defaults: show dotfiles, hide gitignored
    if (window.localStorage.getItem('directoryTreeShowHidden') === null) {
      window.localStorage.setItem('directoryTreeShowHidden', 'true');
    }
    if (window.localStorage.getItem('filesViewShowGitignored') === null) {
      window.localStorage.setItem('filesViewShowGitignored', 'false');
    }
  } catch (error) {
    console.warn('Failed to persist workspace folder', error);
  }
}

const normalizeUrl = (input: string | URL) => {
  try {
    return typeof input === 'string' ? new URL(input, window.location.href) : new URL(input.toString(), window.location.href);
  } catch {
    return null;
  }
};

const handleLocalApiRequest = async (url: URL, init?: RequestInit) => {
  const pathname = url.pathname;
  const method = ((init?.method || 'GET') as string).toUpperCase();

  // Health endpoints: reflect actual connection status
  if (pathname === '/health' || pathname === '/api/health') {
    const connectionStatus = window.__OPENCHAMBER_CONNECTION__?.status;
    const isReady = connectionStatus === 'connected';
    const cliAvailable = window.__OPENCHAMBER_CONNECTION__?.cliAvailable ?? true;
    return new Response(JSON.stringify({ 
      status: isReady ? 'ok' : 'connecting', 
      isOpenCodeReady: isReady,
      cliAvailable,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (pathname.startsWith('/api/fs/search')) {
    const data = await sendBridgeMessage('api:fs:search', {
      directory: url.searchParams.get('directory') || '',
      query: url.searchParams.get('query') || '',
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
      includeHidden: url.searchParams.get('includeHidden') === 'true',
      respectGitignore: url.searchParams.get('respectGitignore') !== 'false',
      type: url.searchParams.get('type') === 'directory' ? 'directory' : 'file',
    });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/fs/list')) {
    const targetPath = url.searchParams.get('path') || '';
    const respectGitignore = url.searchParams.get('respectGitignore') === 'true';
    const data = await sendBridgeMessage('api:fs:list', { path: targetPath, respectGitignore });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/fs/mkdir')) {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const data = await sendBridgeMessage('api:fs:mkdir', { path: body.path });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/fs/home')) {
    const data = await sendBridgeMessage('api:fs/home');
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/vscode/pick-files')) {
    const data = await sendBridgeMessage('api:files/pick');
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/vscode/drop-files') && method === 'POST') {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const uris = Array.isArray((body as { uris?: unknown[] }).uris)
      ? (body as { uris: unknown[] }).uris.filter((value): value is string => typeof value === 'string')
      : [];
    const data = await sendBridgeMessage('api:files/drop', { uris });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/vscode/save-image') && method === 'POST') {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const fileName = typeof (body as { fileName?: unknown }).fileName === 'string'
      ? (body as { fileName: string }).fileName
      : undefined;
    const dataUrl = typeof (body as { dataUrl?: unknown }).dataUrl === 'string'
      ? (body as { dataUrl: string }).dataUrl
      : undefined;
    const data = await sendBridgeMessage('api:files/save-image', { fileName, dataUrl });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/vscode/save-markdown') && method === 'POST') {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const fileName = typeof (body as { fileName?: unknown }).fileName === 'string'
      ? (body as { fileName: string }).fileName
      : undefined;
    const content = typeof (body as { content?: unknown }).content === 'string'
      ? (body as { content: string }).content
      : undefined;
    const data = await sendBridgeMessage('api:files/save-markdown', { fileName, content });
    return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname.startsWith('/api/config/settings')) {
    if ((init?.method || 'GET').toUpperCase() === 'GET') {
      const settings = await sendBridgeMessage('api:config/settings:get');
      return new Response(JSON.stringify(settings), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const updated = await sendBridgeMessage('api:config/settings:save', body);
    return new Response(JSON.stringify(updated), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (pathname === '/api/magic-prompts') {
    if (method === 'GET') {
      const data = await sendBridgeMessage('api:magic-prompts:get');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'DELETE') {
      const data = await sendBridgeMessage('api:magic-prompts:reset-all');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname.startsWith('/api/magic-prompts/')) {
    const id = decodeURIComponent(pathname.slice('/api/magic-prompts/'.length));
    if (method === 'PUT') {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const data = await sendBridgeMessage('api:magic-prompts:save', { id, text: body?.text });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (method === 'DELETE') {
      const data = await sendBridgeMessage('api:magic-prompts:reset', { id });
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
  }

  if (pathname === '/auth/session') {
    // VS Code host is trusted; mirror web server shape to keep UI logic happy
    const body = {
      authenticated: true,
      requireSetup: false,
      authenticatedAt: Date.now(),
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  return null;
};

const originalFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const targetUrl = typeof input === 'string' || input instanceof URL ? normalizeUrl(input) : normalizeUrl((input as Request).url);
  const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

  const pathname = targetUrl?.pathname || '';
  const normalizedPathname = pathname.replace(/\/+/, '/');
  if (targetUrl && normalizedPathname === '/health') {
    const connectionStatus = window.__OPENCHAMBER_CONNECTION__?.status;
    const isReady = connectionStatus === 'connected';
    const cliAvailable = window.__OPENCHAMBER_CONNECTION__?.cliAvailable ?? true;
    return new Response(JSON.stringify({ 
      status: isReady ? 'ok' : 'connecting', 
      isOpenCodeReady: isReady,
      cliAvailable,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (targetUrl && targetUrl.pathname.startsWith('/api/')) {
    const localResponse = await handleLocalApiRequest(targetUrl, init);
    if (localResponse) {
      return localResponse;
    }

    // There is no HTTP backend behind the webview: everything Claude-related goes through
    // `RuntimeAPIs.claude`. Unknown /api routes are legacy callers that still need migrating.
    console.warn(`[ClaudeKei] Unhandled API request ${method} ${targetUrl.pathname}; returning 501`);
    return new Response(JSON.stringify({ error: `Not implemented: ${targetUrl.pathname}` }), {
      status: 501,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return originalFetch(input as RequestInfo, init);
};

// Listen for addToContext command from extension
onCommand('addToContext', (payload) => {
  const { text, selectionContext } = payload as {
    text: string;
    selectionContext?: {
      mentionText: string;
      filePath: string;
      startLine: number;
      endLine: number;
      selectedText: string;
      languageId?: string;
    };
  };

  import('@/sync/input-store').then(({ useInputStore }) => {
    useInputStore.getState().setPendingInputText(text, 'append-inline');
    if (selectionContext) {
      useInputStore.getState().appendPendingSelectionContexts([selectionContext]);
    }
  });

  window.dispatchEvent(new CustomEvent('openchamber:navigate', { detail: { view: 'chat' } }));
});

onCommand('addFileMentions', (payload) => {
  const rawPaths = Array.isArray((payload as { paths?: unknown[] })?.paths)
    ? (payload as { paths: unknown[] }).paths
    : [];
  const paths = rawPaths
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (paths.length === 0) {
    return;
  }

  const mentionText = paths.map((relativePath) => `@${relativePath}`).join(' ');

  import('@/sync/input-store').then(({ useInputStore }) => {
    useInputStore.getState().setPendingInputText(mentionText, 'append-inline');
  });
});

// Listen for createSessionWithPrompt command from extension (Explain, Improve Code)
onCommand('createSessionWithPrompt', (payload) => {
  const { prompt } = payload as { prompt: string };

  Promise.all([
    import('@/sync/session-ui-store'),
    import('@/stores/useConfigStore'),
    import('@/sync/input-store'),
  ]).then(([{ useSessionUIStore }, { useConfigStore }, { useInputStore }]) => {
    const sessionStore = useSessionUIStore.getState();
    const configStore = useConfigStore.getState();

    // Open a new session draft first
    sessionStore.openNewSessionDraft();

    // Get current provider/model/agent configuration
    const { currentProviderId, currentModelId, currentAgentName } = configStore;

    if (currentProviderId && currentModelId) {
      // Send the message - this will create the session from the draft and send
      sessionStore.sendMessage(
        prompt,
        currentProviderId,
        currentModelId,
        currentAgentName ?? undefined,
        undefined, // attachments
        undefined, // agentMentionName
        undefined  // additionalParts
      ).catch((error: unknown) => {
        console.error('[ClaudeKei] Failed to send prompt:', error);
      });
    } else {
      // If no provider/model configured, just set the text and let user send manually
      useInputStore.getState().setPendingInputText(prompt);
    }
  });
});

// Listen for newSession command from extension title bar button
onCommand('newSession', () => {
  import('@/sync/session-ui-store').then(({ useSessionUIStore }) => {
    useSessionUIStore.getState().openNewSessionDraft();
  });
  
  // Also dispatch event to navigate to chat view in VSCodeLayout
  window.dispatchEvent(new CustomEvent('openchamber:navigate', { detail: { view: 'chat' } }));
});

// Listen for showSettings command from extension title bar button
onCommand('showSettings', () => {
  // Dispatch event to navigate to settings view in VSCodeLayout
  window.dispatchEvent(new CustomEvent('openchamber:navigate', { detail: { view: 'settings' } }));
});

onCommand('cyclePrimaryAgent', () => {
  window.dispatchEvent(new CustomEvent('openchamber:cycle-primary-agent'));
});

// Host command `claudekei.cyclePermissionMode`: the composer's permission mode selector listens for this.
onCommand('cyclePermissionMode', () => {
  window.dispatchEvent(new CustomEvent('openchamber:cycle-permission-mode'));
});

// Listen for settings sync command from extension (broadcast to all VS Code webviews)
onCommand('settingsSynced', () => {
  import('@openchamber/ui/lib/persistence').then(({ syncDesktopSettings }) => {
    void syncDesktopSettings();
  });
});

mockRuntimeReady
  .then(() => {
    trackBootstrap();
    return import('@/main');
  })
  .then(async () => {
    await waitForUiMount();
    uiMounted = true;
    maybeHideLoadingOverlay();
  })
  .catch((error) => {
    console.error('[ClaudeKei] Failed to bootstrap UI:', error);
    // If the UI bundle fails to load, remove the overlay so the user at least sees errors in the root.
    uiMounted = true;
    fadeOutLoadingScreen();
  });
