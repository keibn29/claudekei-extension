import * as vscode from 'vscode';
import { handleBridgeMessage, type BridgeRequest, type BridgeResponse } from './bridge';
import type { Broadcaster } from './claude/broadcaster';
import type { ClaudeSessionManager } from './claude/ClaudeSessionManager';

export type AttachWebviewOptions = {
  webview: vscode.Webview;
  context: vscode.ExtensionContext;
  manager: ClaudeSessionManager;
  broadcaster: Broadcaster;
  /** Sends a bridge response to this webview (the sidebar adds ack/retry on top of `postMessage`). */
  deliver: (response: BridgeResponse) => void;
  /** Gets every raw message first; return true when it was handled (e.g. delivery acks). */
  preHandle?: (message: unknown) => boolean;
};

/**
 * Connects one webview to the session host: registers its `claude:events` sink, routes bridge requests and returns a
 * disposable that undoes exactly this registration (so a re-resolved view never disposes a newer view's sink).
 */
export function attachWebview(options: AttachWebviewOptions): vscode.Disposable {
  const { webview, context, manager, broadcaster, deliver, preHandle } = options;
  const sink = broadcaster.register({ post: (message) => webview.postMessage(message) });

  const listener = webview.onDidReceiveMessage(async (message: BridgeRequest) => {
    if (preHandle?.(message)) return;
    if (!message || typeof message !== 'object' || typeof message.id !== 'string' || typeof message.type !== 'string') return;
    const response = await handleBridgeMessage(message, { manager, context, sinkId: sink.id });
    deliver(response);
    if (message.type === 'api:config/settings:save' && response.success) {
      void vscode.commands.executeCommand('claudekei.internal.settingsSynced', response.data);
    }
  });

  return new vscode.Disposable(() => {
    listener.dispose();
    sink.dispose();
  });
}
