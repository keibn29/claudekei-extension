/**
 * Commands the webview may run (`vscode:command`). A compromised or buggy webview must not be able to run arbitrary
 * VS Code commands: only the extension's own commands and the two terminal commands behind the "Run claude login"
 * button, with the exact login sequence.
 */
export const LOGIN_SEQUENCE = 'claude login\n';

export function resolveAllowedWebviewCommand(
  command: string,
  args: unknown[],
): { ok: true; command: string; args: unknown[] } | { ok: false; reason: string } {
  // The shared UI still sends the legacy id for "remember the active session"; it maps to the extension's command.
  if (command === 'openchamber.setActiveSession') return { ok: true, command: 'claudekei.setActiveSession', args };
  if (command.startsWith('claudekei.')) return { ok: true, command, args };
  if (command === 'workbench.action.terminal.new') return { ok: true, command, args: [] };
  if (command === 'workbench.action.terminal.sendSequence') {
    const first = args[0] as { text?: unknown } | undefined;
    if (args.length === 1 && first && typeof first === 'object' && first.text === LOGIN_SEQUENCE && Object.keys(first).length === 1) {
      return { ok: true, command, args };
    }
    return { ok: false, reason: 'only the "claude login" sequence may be sent to the terminal' };
  }
  return { ok: false, reason: 'not in the webview command allowlist' };
}

