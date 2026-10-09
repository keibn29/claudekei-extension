import * as vscode from 'vscode';
import { attachWebview } from './webviewHost';
import { getThemeKindName } from './theme';
import type { ClaudeSessionManager, ConnectionStatus } from './claude/ClaudeSessionManager';
import type { Broadcaster } from './claude/broadcaster';
import { getWebviewShikiThemes } from './shikiThemes';
import { getWebviewHtml } from './webviewHtml';
import { resolveWebviewDevServerUrl } from './webviewDevServer';

type SessionPanelState = {
  panel: vscode.WebviewPanel;
  attached: vscode.Disposable;
};

export class SessionEditorPanelProvider {
  public static readonly viewType = 'claudekei.sessionEditor';

  private _cachedStatus: ConnectionStatus = 'connecting';
  private _cachedError?: string;
  private _panels = new Map<string, SessionPanelState>();
  private readonly _webviewDevServerUrl: string | null;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _manager: ClaudeSessionManager,
    private readonly _broadcaster: Broadcaster,
  ) {
    const current = this._manager.getStatus();
    this._cachedStatus = current.status;
    this._cachedError = current.error;
    this._webviewDevServerUrl = resolveWebviewDevServerUrl(this._context);
  }

  public createOrShowNewSession(): void {
    // Generate unique panel ID for new session drafts
    const panelId = `new_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    this._createPanel(panelId, 'New Session', null);
  }

  public createOrShow(sessionId: string, title?: string): void {
    if (!sessionId || typeof sessionId !== 'string') {
      return;
    }

    const sessionTitle = title && title.trim().length > 0 ? title.trim() : 'Session';

    const existing = this._panels.get(sessionId);
    if (existing) {
      existing.panel.title = sessionTitle;
      existing.panel.reveal(existing.panel.viewColumn ?? vscode.ViewColumn.Active);
      return;
    }

    this._createPanel(sessionId, sessionTitle, sessionId);
  }

  private _createPanel(panelId: string, title: string, initialSessionId: string | null): void {
    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist');

    const panel = vscode.window.createWebviewPanel(
      SessionEditorPanelProvider.viewType,
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._extensionUri, distUri],
      }
    );

    panel.iconPath = {
      light: vscode.Uri.joinPath(this._extensionUri, 'assets', 'app-icon.png'),
      dark: vscode.Uri.joinPath(this._extensionUri, 'assets', 'app-icon.png'),
    };

    const state: SessionPanelState = {
      panel,
      // Editor-tab sessions subscribe to the same event stream as the sidebar.
      attached: attachWebview({
        webview: panel.webview,
        context: this._context,
        manager: this._manager,
        broadcaster: this._broadcaster,
        deliver: (response) => void panel.webview.postMessage(response),
      }),
    };

    this._panels.set(panelId, state);

    panel.webview.html = this._getHtmlForWebview(panel.webview, initialSessionId);

    void this.updateTheme(vscode.window.activeColorTheme.kind);
    this._sendCachedStateToPanel(state);

    panel.onDidDispose(() => {
      this._disposePanel(panelId);
    }, null, this._context.subscriptions);
  }

  public updateTheme(kind: vscode.ColorThemeKind) {
    const themeKind = getThemeKindName(kind);
    void getWebviewShikiThemes().then((shikiThemes) => {
      for (const entry of this._panels.values()) {
        entry.panel.webview.postMessage({
          type: 'themeChange',
          theme: { kind: themeKind, shikiThemes },
        });
      }
    });
  }

  public updateConnectionStatus(status: ConnectionStatus, error?: string) {
    this._cachedStatus = status;
    this._cachedError = error;

    for (const entry of this._panels.values()) {
      this._sendCachedStateToPanel(entry);
    }
  }

  public notifySettingsSynced(settings: unknown): void {
    for (const entry of this._panels.values()) {
      entry.panel.webview.postMessage({
        type: 'command',
        command: 'settingsSynced',
        payload: settings,
      });
    }
  }

  private _sendCachedStateToPanel(entry: SessionPanelState) {
    entry.panel.webview.postMessage({
      type: 'connectionStatus',
      status: this._cachedStatus,
      error: this._cachedError,
    });
  }

  private _disposePanel(sessionId: string) {
    const entry = this._panels.get(sessionId);
    if (!entry) return;

    entry.attached.dispose();

    this._panels.delete(sessionId);
  }

  private _getHtmlForWebview(webview: vscode.Webview, sessionId: string | null) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    const initialStatus = this._cachedStatus;

    return getWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      workspaceFolder,
      initialStatus,
      panelType: 'chat',
      initialSessionId: sessionId ?? undefined,
      viewMode: 'editor',
      devServerUrl: this._webviewDevServerUrl,
    });
  }
}
