/** Open an integrated terminal and run `claude login` (uses the generic `vscode:command` bridge). */
export const openClaudeLoginTerminal = async (
  executeCommand: ((command: string, ...args: unknown[]) => Promise<unknown>) | undefined,
): Promise<void> => {
  if (!executeCommand) {
    throw new Error('Run `claude login` in a terminal');
  }
  await executeCommand('workbench.action.terminal.new');
  await executeCommand('workbench.action.terminal.sendSequence', { text: 'claude login\n' });
};
