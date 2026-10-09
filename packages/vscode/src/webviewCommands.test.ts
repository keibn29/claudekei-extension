import { describe, expect, test } from 'bun:test';
import { LOGIN_SEQUENCE, resolveAllowedWebviewCommand } from './webviewCommands';

describe('resolveAllowedWebviewCommand', () => {
  test('extension commands and the login terminal flow are allowed', () => {
    expect(resolveAllowedWebviewCommand('claudekei.newSession', [])).toEqual({ ok: true, command: 'claudekei.newSession', args: [] });
    expect(resolveAllowedWebviewCommand('workbench.action.terminal.new', ['ignored'])).toEqual({ ok: true, command: 'workbench.action.terminal.new', args: [] });
    expect(resolveAllowedWebviewCommand('workbench.action.terminal.sendSequence', [{ text: LOGIN_SEQUENCE }])).toMatchObject({ ok: true });
    expect(LOGIN_SEQUENCE).toBe('claude login\n');
  });

  test('legacy active-session id maps to the extension command', () => {
    expect(resolveAllowedWebviewCommand('openchamber.setActiveSession', ['id', 'title'])).toEqual({ ok: true, command: 'claudekei.setActiveSession', args: ['id', 'title'] });
  });

  test('everything else is rejected, including other terminal sequences', () => {
    for (const [command, args] of [
      ['workbench.action.terminal.sendSequence', [{ text: 'rm -rf ~\n' }]],
      ['workbench.action.terminal.sendSequence', [{ text: 'claude login\nrm -rf ~\n' }]],
      ['workbench.action.terminal.sendSequence', [{ text: LOGIN_SEQUENCE, extra: 1 }]],
      ['workbench.action.terminal.sendSequence', []],
      ['workbench.action.terminal.sendSequence', [{ text: LOGIN_SEQUENCE }, 'x']],
      ['workbench.action.files.save', []],
      ['vscode.open', ['file:///etc/passwd']],
      ['notclaudekei.x', []],
      ['claudekei', []],
    ] as Array<[string, unknown[]]>) {
      expect(resolveAllowedWebviewCommand(command, args).ok).toBe(false);
    }
  });
});
