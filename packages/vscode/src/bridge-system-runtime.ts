import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { resolveAllowedWebviewCommand } from './webviewCommands';
import type { BridgeContext, BridgeResponse } from './bridge';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type SystemRuntimeDeps = {
  resolveUserPath: (value: string, baseDirectory: string) => string;
  clientReloadDelayMs: number;
};

type NotificationBridgePayload = {
  title?: string;
  body?: string;
  tag?: string;
};

type NotificationsNotifyRequestPayload = {
  payload?: NotificationBridgePayload;
};

const VIRTUAL_DIFF_SCHEME = 'claudekei-diff';

type ParsedDiffHunk = {
  newStart: number;
  oldLines: string[];
  newLines: string[];
};

const virtualDiffContents = new Map<string, string>();
let virtualDiffCounter = 0;
let virtualDiffProviderDisposable: vscode.Disposable | null = null;

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const ensureVirtualDiffProviderRegistered = (ctx?: BridgeContext): void => {
  if (virtualDiffProviderDisposable) {
    return;
  }

  virtualDiffProviderDisposable = vscode.workspace.registerTextDocumentContentProvider(
    VIRTUAL_DIFF_SCHEME,
    {
      provideTextDocumentContent: (uri: vscode.Uri) => {
        const key = new URLSearchParams(uri.query).get('key') || '';
        return virtualDiffContents.get(key) ?? '';
      },
    },
  );

  if (ctx?.context) {
    ctx.context.subscriptions.push(virtualDiffProviderDisposable);
  }
};

const createVirtualOriginalDiffUri = (modifiedPath: string, content: string): vscode.Uri => {
  const key = `${Date.now()}-${++virtualDiffCounter}`;
  virtualDiffContents.set(key, content);

  if (virtualDiffContents.size > 100) {
    const firstKey = virtualDiffContents.keys().next().value;
    if (firstKey) {
      virtualDiffContents.delete(firstKey);
    }
  }

  return vscode.Uri.from({
    scheme: VIRTUAL_DIFF_SCHEME,
    path: `/${path.basename(modifiedPath) || 'original'}`,
    query: `key=${encodeURIComponent(key)}`,
  });
};

const parseUnifiedDiffHunks = (patch: string): ParsedDiffHunk[] => {
  const lines = patch.split(/\r?\n/);
  const hunks: ParsedDiffHunk[] = [];

  let current: ParsedDiffHunk | null = null;

  for (const line of lines) {
    const headerMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (headerMatch) {
      if (current) {
        hunks.push(current);
      }
      current = {
        newStart: Number(headerMatch[1] || 1),
        oldLines: [],
        newLines: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('\\ No newline')) {
      continue;
    }

    if (line.startsWith('-')) {
      current.oldLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith('+')) {
      current.newLines.push(line.slice(1));
      continue;
    }

    if (line.startsWith(' ')) {
      const content = line.slice(1);
      current.oldLines.push(content);
      current.newLines.push(content);
    }
  }

  if (current) {
    hunks.push(current);
  }

  return hunks;
};

const reconstructOriginalContentFromPatch = (modifiedContent: string, patch: string): string | null => {
  const hunks = parseUnifiedDiffHunks(patch);
  if (hunks.length === 0) {
    return null;
  }

  const lines = modifiedContent.split('\n');
  for (let index = hunks.length - 1; index >= 0; index -= 1) {
    const hunk = hunks[index];
    if (!hunk) {
      continue;
    }
    const startIndex = Math.max(0, hunk.newStart - 1);
    const replaceCount = hunk.newLines.length;
    lines.splice(startIndex, replaceCount, ...hunk.oldLines);
  }

  return lines.join('\n');
};

export async function handleSystemBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
  deps: SystemRuntimeDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:models/metadata': {
      // The host never phones home: no third-party model catalog. Claude models come from the SDK catalog.
      return { id, type, success: true, data: {} };
    }

    case 'api:openchamber:update-check': {
      // ClaudeKei is a personal build: it never phones home. The extension is updated by installing a new VSIX.
      return { id, type, success: true, data: { available: false } };
    }

    case 'editor:openFile': {
      const { path: filePath, line, column } = payload as { path: string; line?: number; column?: number };
      try {
        const doc = await vscode.workspace.openTextDocument(filePath);
        const options: vscode.TextDocumentShowOptions = {};
        if (typeof line === 'number') {
          const pos = new vscode.Position(Math.max(0, line - 1), column || 0);
          options.selection = new vscode.Range(pos, pos);
        }
        await vscode.window.showTextDocument(doc, options);
        return { id, type, success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'editor:openDiff': {
      const { original, modified, label, line, patch } = payload as {
        original: string;
        modified: string;
        label?: string;
        line?: number;
        patch?: string;
      };
      try {
        const modifiedUri = vscode.Uri.file(modified);
        const modifiedDoc = await vscode.workspace.openTextDocument(modifiedUri);
        let originalUri = original ? vscode.Uri.file(original) : modifiedUri;

        if (typeof patch === 'string' && patch.trim().length > 0) {
          const originalContent = reconstructOriginalContentFromPatch(modifiedDoc.getText(), patch);
          if (typeof originalContent === 'string') {
            ensureVirtualDiffProviderRegistered(ctx);
            originalUri = createVirtualOriginalDiffUri(modified, originalContent);
          }
        }

        const leftLabel = original ? path.basename(original) : `${path.basename(modified)} (before)`;
        const title = label || `${leftLabel} ↔ ${path.basename(modified)}`;

        await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, title);

        if (typeof line === 'number' && Number.isFinite(line)) {
          const targetLine = Math.max(0, Math.trunc(line) - 1);
          await new Promise((resolve) => setTimeout(resolve, 0));
          const targetEditor = vscode.window.visibleTextEditors.find(
            (editor) => editor.document.uri.toString() === modifiedUri.toString(),
          );
          if (targetEditor) {
            const target = new vscode.Position(targetLine, 0);
            targetEditor.selection = new vscode.Selection(target, target);
            targetEditor.revealRange(new vscode.Range(target, target), vscode.TextEditorRevealType.InCenter);
          }
        }

        return { id, type, success: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'vscode:command': {
      const { command, args } = (payload || {}) as { command?: string; args?: unknown[] };
      if (!command) {
        return { id, type, success: false, error: 'Command is required' };
      }
      const resolved = resolveAllowedWebviewCommand(command, args || []);
      if (!resolved.ok) {
        ctx?.manager?.warn(`blocked webview command "${command}": ${resolved.reason}`);
        return { id, type, success: false, error: `Command not allowed: ${command}` };
      }
      try {
        const result = await vscode.commands.executeCommand(resolved.command, ...resolved.args);
        return { id, type, success: true, data: { result } };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'vscode:openExternalUrl': {
      const { url } = (payload || {}) as { url?: string };
      const target = typeof url === 'string' ? url.trim() : '';
      if (!target) {
        return { id, type, success: false, error: 'URL is required' };
      }
      try {
        await vscode.env.openExternal(vscode.Uri.parse(target));
        return { id, type, success: true, data: { opened: true } };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { id, type, success: false, error: errorMessage };
      }
    }

    case 'notifications:can-notify': {
      return { id, type, success: true, data: true };
    }

    case 'notifications:notify': {
      const request = (payload || {}) as NotificationsNotifyRequestPayload;
      const notification = request.payload || {};
      const title = typeof notification.title === 'string' ? notification.title.trim() : '';
      const body = typeof notification.body === 'string' ? notification.body.trim() : '';

      const message = title && body
        ? `${title}: ${body}`
        : title || body;

      if (!message) {
        return { id, type, success: true, data: { shown: false } };
      }

      void vscode.window.showInformationMessage(message);
      return { id, type, success: true, data: { shown: true } };
    }

    default:
      return null;
  }
}
