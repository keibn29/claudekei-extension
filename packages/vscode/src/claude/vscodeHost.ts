/**
 * VS Code adapter for the session host core: reads `claudekei.*` settings, wires the Memento store and the
 * OutputChannel logger. Everything else stays vscode-free (see ClaudeSessionManager).
 */
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { PermissionMode } from '@openchamber/ui/src/lib/claude/types';
import { Broadcaster } from './broadcaster';
import type { PrimaryAgentSetting } from './catalog';
import { claudekeiConfigPaths } from './claudekeiConfig';
import { ClaudeSessionManager, findOnPath, type ManagerConfig } from './ClaudeSessionManager';

export function readManagerConfig(): ManagerConfig {
  const config = vscode.workspace.getConfiguration('claudekei');
  const primary = config.get<unknown>('primaryAgents');
  return {
    maxLiveSessions: Math.max(1, config.get<number>('maxLiveSessions', 3)),
    idleTimeoutMinutes: Math.max(0, config.get<number>('idleTimeoutMinutes', 10)),
    useApiKey: config.get<boolean>('useApiKey', false),
    claudeExecutablePath: (config.get<string>('claudeExecutablePath', '') || '').trim(),
    allowBypassPermissions: config.get<boolean>('allowBypassPermissions', true),
    defaultPermissionMode: config.get<PermissionMode>('defaultPermissionMode', 'bypassPermissions'),
    primaryAgents: Array.isArray(primary)
      ? primary.filter((p): p is PrimaryAgentSetting => !!p && typeof (p as PrimaryAgentSetting).name === 'string')
      : [],
  };
}

export type ClaudeHost = { manager: ClaudeSessionManager; broadcaster: Broadcaster; cwd: string };

export function createClaudeHost(context: vscode.ExtensionContext, output: vscode.OutputChannel): ClaudeHost {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  const broadcaster = new Broadcaster({
    onSinkError: (id, error) => output.appendLine(`[ClaudeKei] webview sink ${id} failed: ${error instanceof Error ? error.message : String(error)}`),
  });
  const manager = new ClaudeSessionManager({
    cwd,
    distDir: path.join(context.extensionPath, 'dist'),
    store: context.workspaceState,
    globalStore: context.globalState,
    // Without a workspace folder there is no per-workspace storage: the global dir is shared by every such window, and
    // the revert-copy sweep (dirs without a marker in THIS window's state) would delete the other windows' copies.
    storageDir: context.storageUri?.fsPath ?? path.join(context.globalStorageUri.fsPath, 'no-workspace', vscode.env.sessionId),
    trash: (absPath) => Promise.resolve(vscode.workspace.fs.delete(vscode.Uri.file(absPath), { recursive: true, useTrash: true })),
    broadcaster,
    getConfig: readManagerConfig,
    clientApp: `claudekei/${String(context.extension?.packageJSON?.version ?? '0')}`,
    log: (level, message, data) => {
      if (level === 'debug') return; // model-window measurement problems are logged at warn/info on purpose
      output.appendLine(`[ClaudeKei] ${level} ${message}${data === undefined ? '' : ` ${safeJson(data)}`}`);
    },
    stderr: (data) => output.appendLine(`[claude stderr] ${data.trimEnd()}`),
  });
  // claudekei.jsonc presets and the permission-mode settings feed the catalog: rebuild it when they change.
  const reload = () => manager.reloadAgentPresets();
  for (const file of claudekeiConfigPaths({ cwd })) {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file)));
    watcher.onDidChange(reload);
    watcher.onDidCreate(reload);
    watcher.onDidDelete(reload);
    context.subscriptions.push(watcher);
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('claudekei.defaultPermissionMode') || event.affectsConfiguration('claudekei.allowBypassPermissions') || event.affectsConfiguration('claudekei.primaryAgents')) reload();
    }),
  );
  return { manager, broadcaster, cwd };
}

const safeJson = (value: unknown): string => {
  try {
    return value instanceof Error ? value.message : JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/** Resolved `claude` binary for terminal use (login): the configured/bundled executable, else `claude` on PATH. */
export async function resolveTerminalClaude(manager: ClaudeSessionManager): Promise<{ path: string; envPath: string | undefined } | undefined> {
  const diag = await manager.diagnostics();
  const exe = diag.executable.path ?? findOnPath('claude', diag.loginPath ?? process.env.PATH);
  return exe ? { path: exe, envPath: diag.loginPath } : undefined;
}
