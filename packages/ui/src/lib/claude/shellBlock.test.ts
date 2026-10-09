import { describe, expect, test } from 'bun:test';
import { isRunnableShellLanguage, toTerminalCommand } from './shellBlock';

describe('isRunnableShellLanguage', () => {
  test('only explicit shell languages', () => {
    for (const language of ['bash', 'sh', 'shell', 'zsh', 'console', 'BASH', ' sh ']) expect(isRunnableShellLanguage(language)).toBe(true);
    for (const language of ['', 'text', 'javascript', 'json', 'diff', undefined, null]) expect(isRunnableShellLanguage(language)).toBe(false);
  });
});

describe('toTerminalCommand', () => {
  test('strips $ and % prompts per line', () => {
    expect(toTerminalCommand('$ bun test', 'bash')).toBe('bun test');
    expect(toTerminalCommand('% ls -la', 'zsh')).toBe('ls -la');
    expect(toTerminalCommand('$ cd app\n$ bun install', 'bash')).toBe('cd app\nbun install');
  });

  test('multi-line commands without prompts are sent as-is', () => {
    const script = 'cd app\nbun install && \\\n  bun run build';
    expect(toTerminalCommand(script, 'bash')).toBe(script);
    expect(toTerminalCommand('echo "$HOME"', 'sh')).toBe('echo "$HOME"');
  });

  test('console transcripts keep only the prompted lines', () => {
    expect(toTerminalCommand('$ git status\nOn branch main\nnothing to commit', 'console')).toBe('git status');
    // without any prompt a console block is sent as written
    expect(toTerminalCommand('npm test', 'console')).toBe('npm test');
  });

  test('trims surrounding blank lines and handles CRLF', () => {
    expect(toTerminalCommand('\n$ pwd\r\n', 'bash')).toBe('pwd');
  });
});
