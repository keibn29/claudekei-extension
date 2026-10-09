import * as vscode from 'vscode';
import { type BridgeResponse } from './bridge';
import { attachWebview } from './webviewHost';
import { getThemeKindName } from './theme';
import type { ClaudeSessionManager, ConnectionStatus } from './claude/ClaudeSessionManager';
import type { Broadcaster } from './claude/broadcaster';
import { getWebviewShikiThemes } from './shikiThemes';
import { getWebviewHtml } from './webviewHtml';
import { resolveWebviewDevServerUrl } from './webviewDevServer';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudekei.chatView';

  private _view?: vscode.WebviewView;

  public isVisible() {
    return this._view?.visible ?? false;
  }

  // Cache latest status/URL for when webview is resolved after connection is ready
  private _cachedStatus: ConnectionStatus = 'connecting';
  private _cachedError?: string;
  private _attached?: vscode.Disposable;
  private readonly _webviewDevServerUrl: string | null;

  // Message delivery confirmation and retry
  private readonly _pendingMessages = new Set<string>();
  private readonly _messageTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly _MESSAGE_TIMEOUT = 5000; // 5 seconds
  private readonly _MAX_RETRIES = 3;

  private _createMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private _clearPendingMessages(): void {
    for (const timeout of this._messageTimeouts.values()) {
      clearTimeout(timeout);
    }
    this._messageTimeouts.clear();
    this._pendingMessages.clear();
  }

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

  public resolveWebviewView(
    webviewView: vscode.WebviewView
  ) {
    this._clearPendingMessages();
    this._view = webviewView;
    // A re-resolved view replaces the previous attachment; only this view's own registration is ever disposed.
    this._attached?.dispose();

    const distUri = vscode.Uri.joinPath(this._extensionUri, 'dist');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri, distUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    // Send theme payload (including optional Shiki theme JSON) after the webview is set up.
    void this.updateTheme(vscode.window.activeColorTheme.kind);

    // Send cached connection status and API URL (may have been set before webview was resolved)
    this._sendCachedState();

    const attached = attachWebview({
      webview: webviewView.webview,
      context: this._context,
      manager: this._manager,
      broadcaster: this._broadcaster,
      deliver: (response) => void this._sendMessageWithRetry(response),
      preHandle: (message) => {
        const ack = message as { type?: string; _msgId?: unknown };
        if (ack.type === 'bridge:ack' && typeof ack._msgId === 'string') {
          this._confirmMessage(ack._msgId);
          return true;
        }
        return false;
      },
    });
    this._attached = attached;

    webviewView.onDidDispose(() => {
      attached.dispose();
      if (this._view === webviewView) {
        this._clearPendingMessages();
        this._view = undefined;
        this._attached = undefined;
      }
    });
  }

  public updateTheme(kind: vscode.ColorThemeKind) {
    if (this._view) {
      const themeKind = getThemeKindName(kind);
      void getWebviewShikiThemes().then((shikiThemes) => {
        this._view?.webview.postMessage({
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

  public addSelectionToInput(payload: {
    text: string;
    selectionContext?: {
      mentionText: string;
      filePath: string;
      startLine: number;
      endLine: number;
      selectedText: string;
      languageId?: string;
    };
  }) {
    if (this._view) {
      // Reveal the webview panel
      this._view.show(true);
      
      this._view.webview.postMessage({
        type: 'command',
        command: 'addToContext',
        payload,
      });
    }
  }

  public addFileMentions(paths: string[]) {
    if (!this._view) {
      return;
    }

    const cleanedPaths = paths
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (cleanedPaths.length === 0) {
      return;
    }

    this._view.show(true);
    this._view.webview.postMessage({
      type: 'command',
      command: 'addFileMentions',
      payload: { paths: cleanedPaths },
    });
  }

  public createNewSessionWithPrompt(prompt: string) {
    if (this._view) {
      // Reveal the webview panel
      this._view.show(true);
      
      this._view.webview.postMessage({
        type: 'command',
        command: 'createSessionWithPrompt',
        payload: { prompt }
      });
    }
  }

  public createNewSession() {
    if (this._view) {
      // Reveal the webview panel
      this._view.show(true);
      
      this._view.webview.postMessage({
        type: 'command',
        command: 'newSession'
      });
    }
  }

  public showSettings() {
    if (this._view) {
      // Reveal the webview panel
      this._view.show(true);
      
      this._view.webview.postMessage({
        type: 'command',
        command: 'showSettings'
      });
    }
  }

  public cyclePrimaryAgent() {
    if (this._view) {
      this._view.show(true);

      this._view.webview.postMessage({
        type: 'command',
        command: 'cyclePrimaryAgent'
      });
    }
  }

  public cyclePermissionMode() {
    if (this._view) {
      this._view.show(true);

      this._view.webview.postMessage({
        type: 'command',
        command: 'cyclePermissionMode'
      });
    }
  }

  public postMessage(message: unknown): void {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  public notifySettingsSynced(settings: unknown): void {
    if (!this._view) {
      return;
    }

    this._view.webview.postMessage({
      type: 'command',
      command: 'settingsSynced',
      payload: settings,
    });
  }

  // Message delivery confirmation
  private _confirmMessage(messageId: string) {
    this._pendingMessages.delete(messageId);

    const timeout = this._messageTimeouts.get(messageId);
    if (timeout) {
      clearTimeout(timeout);
      this._messageTimeouts.delete(messageId);
    }
  }

  // Send message with retry mechanism
  private async _sendMessageWithRetry(response: BridgeResponse, retryCount: number = 0, messageId?: string): Promise<boolean> {
    if (!this._view) {
      return false;
    }

    const pendingMessageId = messageId ?? this._createMessageId();
    const existingTimeout = this._messageTimeouts.get(pendingMessageId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
      this._messageTimeouts.delete(pendingMessageId);
    }

    try {
      const delivered = await this._view.webview.postMessage({
        ...response,
        _msgId: pendingMessageId,
      });
      if (!delivered) {
        throw new Error('Webview rejected message delivery');
      }

      this._pendingMessages.add(pendingMessageId);

      const timeout = setTimeout(() => {
        if (!this._pendingMessages.has(pendingMessageId)) {
          return;
        }

        if (retryCount < this._MAX_RETRIES) {
          console.warn(`[Message Retry] Message ${pendingMessageId} not confirmed, retrying (${retryCount + 1}/${this._MAX_RETRIES})...`);
          void this._sendMessageWithRetry(response, retryCount + 1, pendingMessageId);
          return;
        }

        console.error(`[Message Retry] Message ${pendingMessageId} failed after ${this._MAX_RETRIES} retries`);
        this._pendingMessages.delete(pendingMessageId);
        this._messageTimeouts.delete(pendingMessageId);
      }, this._MESSAGE_TIMEOUT);

      this._messageTimeouts.set(pendingMessageId, timeout);
      return true;

    } catch (error) {
      console.error(`[Message Retry] Failed to send message:`, error);

      if (retryCount < this._MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 100 * (retryCount + 1)));
        return this._sendMessageWithRetry(response, retryCount + 1, pendingMessageId);
      }

      this._pendingMessages.delete(pendingMessageId);
      this._messageTimeouts.delete(pendingMessageId);

      return false;
    }
  }

  private _sendCachedState() {
    if (!this._view) {
      return;
    }

    this._view.webview.postMessage({
      type: 'connectionStatus',
      status: this._cachedStatus,
      error: this._cachedError,
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    // Use cached values which are updated by onStatusChange callback
    const initialStatus = this._cachedStatus;
    return getWebviewHtml({
      webview,
      extensionUri: this._extensionUri,
      workspaceFolder,
      initialStatus,
      devServerUrl: this._webviewDevServerUrl,
    });
  }
}
