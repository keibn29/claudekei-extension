/**
 * `claude:terminal.run`: runs a command from a code block's Run button in a shared "ClaudeKei" terminal.
 * Only the explicit user click reaches this (dedicated route, not the generic `vscode:command` allowlist).
 */
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { ClaudeSessionManager } from './ClaudeSessionManager';

const TERMINAL_NAME = 'ClaudeKei';
let terminal: vscode.Terminal | undefined;

async function getTerminal(manager: ClaudeSessionManager): Promise<vscode.Terminal> {
  if (terminal && terminal.exitStatus === undefined && vscode.window.terminals.includes(terminal)) return terminal;
  const diag = await manager.diagnostics();
  terminal = vscode.window.createTerminal({
    name: TERMINAL_NAME,
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir(),
    // Same PATH as the login terminal: the login shell's, so tools installed by the user's shell profile resolve.
    env: diag.loginPath ? { PATH: diag.loginPath } : undefined,
  });
  return terminal;
}

export async function runInClaudeKeiTerminal(manager: ClaudeSessionManager, command: string): Promise<void> {
  manager.logCommand(command);
  const target = await getTerminal(manager);
  target.show(true);
  target.sendText(command, true);
}
