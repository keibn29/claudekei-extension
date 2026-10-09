/** Validation of `claude:terminal.run` commands (the terminal glue itself lives in terminalRun.ts). */

/** Longest accepted command; a code block's Run button never needs more. */
export const MAX_TERMINAL_COMMAND_LENGTH = 10_000;

/** Returns the command to execute, or throws a user-facing error. */
export function validateTerminalCommand(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Missing "command"');
  const command = value.replace(/\s+$/u, '');
  if (command.trim().length === 0) throw new Error('Missing "command"');
  if (command.length > MAX_TERMINAL_COMMAND_LENGTH) throw new Error(`Command is too long (max ${MAX_TERMINAL_COMMAND_LENGTH} characters)`);
  if (command.includes('\0')) throw new Error('Command contains a NUL character');
  return command;
}
