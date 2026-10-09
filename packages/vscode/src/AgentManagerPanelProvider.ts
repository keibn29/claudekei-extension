import * as vscode from 'vscode';
import { attachWebview } from './webviewHost';
import { getThemeKindName } from './theme';
import type { ClaudeSessionManager, ConnectionStatus } from './claude/ClaudeSessionManager';
import type { Broadcaster } from './claude/broadcaster';
import { getWebviewShikiThemes } from './shikiThemes';
import { getWebviewHtml } from './webviewHtml';
import { resolveWebviewDevServerUrl } from './webviewDevServer';

export class AgentManagerPanelProvider {
  public static readonly viewType = 'claudekei.agentManager';

  private _panel?: vscode.WebviewPanel;
  
  // Cache latest status/URL for when webview is resolved after connection is ready
  private _cachedStatus: ConnectionStatus = 'connecting';
  private _cachedError?: string;
  private _attached?: vscode.Disposable;
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

  public createOrShow(): void {
    // If panel exists, reveal it
    if (this._panel) {
      this._panel.reveal(vscode.ViewColumn.One);
      return;
    }

    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist');

    // Create new panel
    this._panel = vscode.window.createWebviewPanel(
      AgentManagerPanelProvider.viewType,
      'Agent Manager',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this._extensionUri, distUri],
      }
    );

    this._panel.iconPath = {
      light: vscode.Uri.joinPath(this._extensionUri, 'assets', 'app-icon.png'),
      dark: vscode.Uri.joinPath(this._extensionUri, 'assets', 'app-icon.png'),
    };

    const panel = this._panel;
    const attached = attachWebview({
      webview: panel.webview,
      context: this._context,
      manager: this._manager,
      broadcaster: this._broadcaster,
      deliver: (response) => void panel.webview.postMessage(response),
    });
    this._attached = attached;
    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
    
    // Send theme payload (including optional Shiki theme JSON) after the webview is set up.
    void this.updateTheme(vscode.window.activeColorTheme.kind);
    
    // Send cached connection status
    this._sendCachedState();

    // Handle panel disposal
    this._panel.onDidDispose(() => {
      attached.dispose();
      if (this._attached === attached) this._attached = undefined;
      if (this._panel === panel) this._panel = undefined;
    }, null, this._context.subscriptions);
  }

  public updateTheme(kind: vscode.ColorThemeKind) {
    if (this._panel) {
      const themeKind = getThemeKindName(kind);
      void getWebviewShikiThemes().then((shikiThemes) => {
        this._panel?.webview.postMessage({
          type: 'themeChange',
          theme: { kind: themeKind, shikiThemes },
        });
      });
    }
  }

  public updateConnectionStatus(status: ConnectionStatus, error?: string) {
    // Cache the latest state
    this._cachedStatus = status;
    this._cachedError = error;
    
    // Send to webview if it exists
    this._sendCachedState();
  }
  
  private _sendCachedState() {
    if (!this._panel) {
      return;
    }
    
    this._panel.webview.postMessage({
      type: 'connectionStatus',
      status: this._cachedStatus,
      error: this._cachedError,
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';

    return getWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      workspaceFolder,
      initialStatus: this._cachedStatus,
      panelType: 'agentManager',
      devServerUrl: this._webviewDevServerUrl,
    });
  }
}
