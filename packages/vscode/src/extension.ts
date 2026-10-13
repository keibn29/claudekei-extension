import * as vscode from 'vscode';
import { ChatViewProvider } from './ChatViewProvider';
import { CLI_NOT_FOUND_MESSAGE, installHint } from './claude/env';
import { createClaudeHost, resolveTerminalClaude, type ClaudeHost } from './claude/vscodeHost';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

let chatViewProvider: ChatViewProvider | undefined;
let claudeHost: ClaudeHost | undefined;
let outputChannel: vscode.OutputChannel | undefined;

const SETTINGS_KEY = 'claudekei.settings';

export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('ClaudeKei');

  let moveToRightSidebarScheduled = false;

  const isCursorLikeHost = () => /\bcursor\b/i.test(vscode.env.appName);

  const findMoveToRightSidebarCommandId = async (): Promise<string | null> => {
    const commands = await vscode.commands.getCommands(true);

    const preferred = [
      // Newer VS Code naming
      'workbench.action.moveViewToSecondarySideBar',
      'workbench.action.moveViewToSecondarySidebar',
      'workbench.action.moveFocusedViewToSecondarySideBar',
      'workbench.action.moveFocusedViewToSecondarySidebar',

      // Some builds use "Auxiliary Bar" naming
      'workbench.action.moveViewToAuxiliaryBar',
      'workbench.action.moveFocusedViewToAuxiliaryBar',
    ];

    for (const commandId of preferred) {
      if (commands.includes(commandId)) return commandId;
    }

    const fuzzy = commands.find((commandId) => {
      const id = commandId.toLowerCase();
      const looksLikeMoveView = id.includes('workbench.action') && id.includes('move') && id.includes('view');
      if (!looksLikeMoveView) return false;

      // Support both "secondary sidebar" and "auxiliary bar" naming.
      return (id.includes('secondary') && id.includes('side') && id.includes('bar')) || (id.includes('auxiliary') && id.includes('bar'));
    });

    return fuzzy || null;
  };

  const attemptMoveChatToRightSidebar = async (): Promise<'moved' | 'unsupported' | 'failed'> => {
    const moveCommandId = await findMoveToRightSidebarCommandId();
    if (!moveCommandId) return 'unsupported';

    try {
      await vscode.commands.executeCommand('claudekei.chatView.focus');
      await vscode.commands.executeCommand(moveCommandId);
      return 'moved';
    } catch (error) {
      outputChannel?.appendLine(
        `[ClaudeKei] Failed moving chat view to right sidebar (command=${moveCommandId}): ${error instanceof Error ? error.message : String(error)}`
      );
      return 'failed';
    }
  };

  const maybeMoveChatToRightSidebarOnStartup = async () => {
    if (context.extensionMode === vscode.ExtensionMode.Development) return;
    if (isCursorLikeHost()) return;

    const attempted = context.globalState.get<boolean>('claudekei.sidebarAutoMoveAttempted') || false;
    if (attempted) return;
    await context.globalState.update('claudekei.sidebarAutoMoveAttempted', true);

    if (moveToRightSidebarScheduled) return;
    moveToRightSidebarScheduled = true;

    // Defer until after activation to avoid stealing focus during startup.
    setTimeout(() => {
      void (async () => {
        try {
          await attemptMoveChatToRightSidebar();
        } finally {
          moveToRightSidebarScheduled = false;
        }
      })();
    }, 800);
  };


  // Dev-only commands (fixture replay) are hidden from the palette unless running from the Extension Development Host.
  void vscode.commands.executeCommand('setContext', 'claudekei.devMode', context.extensionMode === vscode.ExtensionMode.Development);

  // Session host: owns every Claude session (the webviews are subscribers).
  claudeHost = createClaudeHost(context, outputChannel);
  const { manager, broadcaster } = claudeHost;

  // Create chat view provider; the webview shows a loading state until the first bootstrap answers.
  chatViewProvider = new ChatViewProvider(context, context.extensionUri, manager, broadcaster);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatViewProvider.viewType,
      chatViewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Register sidebar/focus commands AFTER the webview view provider is registered
  context.subscriptions.push(
    vscode.commands.registerCommand('claudekei.openSidebar', async () => {
      // Best-effort: open the container (if available), then focus the chat view.
      try {
        await vscode.commands.executeCommand('workbench.view.extension.claudekei');
      } catch (e) {
        outputChannel?.appendLine(`[ClaudeKei] workbench.view.extension.claudekei failed: ${e}`);
      }

      try {
        await vscode.commands.executeCommand('claudekei.chatView.focus');
      } catch (e) {
        outputChannel?.appendLine(`[ClaudeKei] claudekei.chatView.focus failed: ${e}`);
        vscode.window.showErrorMessage(`ClaudeKei: Failed to open sidebar - ${e}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudekei.focusChat', async () => {
      await vscode.commands.executeCommand('claudekei.chatView.focus');
    })
  );

  void maybeMoveChatToRightSidebarOnStartup();

  context.subscriptions.push(
    vscode.commands.registerCommand('claudekei.internal.settingsSynced', (settings: unknown) => {
      chatViewProvider?.notifySettingsSynced(settings);
    })
  );

  context.subscriptions.push(
    // Kept for the webview's "remember the active session" call; the host no longer tracks it.
    vscode.commands.registerCommand('claudekei.setActiveSession', () => undefined)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudekei.restartSessions', async () => {
      try {
        await manager.restartSessions();
        vscode.window.showInformationMessage('ClaudeKei: Claude sessions restarted');
      } catch (e) {
        vscode.window.showErrorMessage(`ClaudeKei: Failed to restart sessions - ${e}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudekei.addToContext', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('ClaudeKei [Add to Context]:No active editor');
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);

      if (!selectedText) {
        vscode.window.showWarningMessage('ClaudeKei [Add to Context]: No text selected');
        return;
      }

      // Get file info for context
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const languageId = editor.document.languageId;
      
      // Get line numbers (1-based for display)
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;
      const rangeText = startLine === endLine ? `#L${startLine}` : `#L${startLine}-#L${endLine}`;
      const mentionText = `@${filePath}:<${rangeText}>`;

      // Send visible mention text plus structured selection metadata to the webview.
      chatViewProvider?.addSelectionToInput({
        text: mentionText,
        selectionContext: {
          mentionText,
          filePath,
          startLine,
          endLine,
          selectedText,
          languageId,
        },
      });

      // Focus the chat panel
      vscode.commands.executeCommand('claudekei.focusChat');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudekei.attachExplorerToChat', async (resource?: vscode.Uri, resources?: vscode.Uri[]) => {
      const uriCandidates: vscode.Uri[] = [];
      if (Array.isArray(resources)) {
        uriCandidates.push(...resources.filter((entry): entry is vscode.Uri => entry instanceof vscode.Uri));
      }
      if (resource instanceof vscode.Uri) {
        uriCandidates.push(resource);
      }
      if (uriCandidates.length === 0) {
        const activeEditorUri = vscode.window.activeTextEditor?.document.uri;
        if (activeEditorUri) {
          uriCandidates.push(activeEditorUri);
        }
      }

      const uniqueUris = Array.from(new Map(uriCandidates.map((uri) => [uri.toString(), uri])).values());
      const mentionPaths: string[] = [];
      const skippedEntries: string[] = [];

      for (const uri of uniqueUris) {
        if (uri.scheme !== 'file') {
          skippedEntries.push(uri.toString());
          continue;
        }

        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if ((stat.type & vscode.FileType.Directory) !== 0) {
            skippedEntries.push(vscode.workspace.asRelativePath(uri, false));
            continue;
          }
        } catch {
          skippedEntries.push(vscode.workspace.asRelativePath(uri, false));
          continue;
        }

        const relativePath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/').trim();
        if (!relativePath) {
          skippedEntries.push(uri.fsPath || uri.toString());
          continue;
        }
        mentionPaths.push(relativePath);
      }

      if (mentionPaths.length === 0) {
        vscode.window.showWarningMessage('ClaudeKei: No file selected to mention');
        return;
      }

      await vscode.commands.executeCommand('claudekei.openSidebar');
      await new Promise((resolve) => setTimeout(resolve, 80));
      chatViewProvider?.addFileMentions(mentionPaths);

      if (skippedEntries.length > 0) {
        vscode.window.showInformationMessage('ClaudeKei: Some selected entries were skipped (folders or unsupported resources)');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudekei.explain', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('ClaudeKei [Explain]: No active editor');
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const languageId = editor.document.languageId;

      let prompt: string;

      if (selectedText) {
        // Selection exists - explain the selected code
        const startLine = selection.start.line + 1;
        const endLine = selection.end.line + 1;
        const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
        prompt = `Explain the following Code / Text:\n\n${filePath}:${lineRange}\n\`\`\`${languageId}\n${selectedText}\n\`\`\``;
      } else {
        // No selection - explain the entire file
        prompt = `Explain the following Code / Text:\n\n${filePath}`;
      }

      // Create new session and send the prompt
      chatViewProvider?.createNewSessionWithPrompt(prompt);
      vscode.commands.executeCommand('claudekei.focusChat');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudekei.improveCode', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('ClaudeKei [Improve Code]: No active editor');
        return;
      }

      const selection = editor.selection;
      const selectedText = editor.document.getText(selection);

      if (!selectedText) {
        vscode.window.showWarningMessage('ClaudeKei [Improve Code]: No text selected');
        return;
      }

      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      const languageId = editor.document.languageId;
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;
      const lineRange = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;

      const prompt = `Improve the following Code:\n\n${filePath}:${lineRange}\n\`\`\`${languageId}\n${selectedText}\n\`\`\``;

      // Create new session and send the prompt
      chatViewProvider?.createNewSessionWithPrompt(prompt);
      vscode.commands.executeCommand('claudekei.focusChat');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudekei.newSession', () => {
      chatViewProvider?.createNewSession();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudekei.showSettings', () => {
      chatViewProvider?.showSettings();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudekei.cyclePrimaryAgent', () => {
      chatViewProvider?.cyclePrimaryAgent();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudekei.cyclePermissionMode', () => {
      chatViewProvider?.cyclePermissionMode();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudekei.showClaudeStatus', async () => {
      const diag = await manager.diagnostics();
      const config = vscode.workspace.getConfiguration('claudekei');
      const extensionVersion = String(context.extension?.packageJSON?.version || '');
      const workspaceFolders = (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
      const storedSettings = context.globalState.get<Record<string, unknown>>(SETTINGS_KEY) || {};
      const settingsKeys = Object.keys(storedSettings).filter((key) => key !== 'lastDirectory');
      const lines = [
        `Time: ${new Date().toISOString()}`,
        `ClaudeKei version: ${extensionVersion || '(unknown)'}`,
        `VS Code version: ${vscode.version}`,
        `Platform: ${process.platform} ${process.arch} (extension host node ${process.version})`,
        `Workspace folders: ${workspaceFolders.length}${workspaceFolders.length ? ` (${workspaceFolders.join(', ')})` : ''}`,
        `Working directory: ${diag.cwd}`,
        `Status: ${diag.status}${diag.error ? ` (${diag.error})` : ''}`,
        `Account: ${diag.account ? [diag.account.email, diag.account.subscriptionType, diag.account.organization].filter(Boolean).join(' / ') : '(not logged in)'}`,
        `Claude executable: ${diag.executable.path ?? '(NOT FOUND - install the claude CLI)'} [${diag.executable.source}]${diag.executable.warning ? ` WARNING: ${diag.executable.warning}` : ''}`,
        `Executable setting: ${(config.get<string>('claudeExecutablePath') || '').trim() || '(none)'}`,
        `Use API key: ${config.get<boolean>('useApiKey', false) ? 'yes' : 'no (subscription login)'}`,
        `Login-shell PATH: ${diag.loginPath ?? '(unavailable)'}`,
        `node on PATH (plugin hooks): ${diag.nodeOnPath ?? 'NOT FOUND - hooks that run node will fail'}`,
        `Catalog: ${diag.catalog.models} models, ${diag.catalog.commands} commands, ${diag.catalog.agents} agents`,
        `Primary agents: ${diag.catalog.primaryAgents.join(', ') || '(none - is the claudekei plugin enabled?)'}`,
        `Live sessions: ${diag.liveSessions.length}${diag.liveSessions.map((s) => `\n  - ${s.id} ${s.lifecycle} agent=${s.agent ?? '(default)'} spawns=${s.spawns}`).join('')}`,
        `Max live sessions: ${config.get<number>('maxLiveSessions', 3)}, idle timeout: ${config.get<number>('idleTimeoutMinutes', 10)} min`,
        `Settings keys (stored): ${settingsKeys.length ? settingsKeys.join(', ') : '(none)'}`,
        '',
      ];
      outputChannel?.appendLine(lines.join('\n'));
      outputChannel?.show(true);
    })
  );

  // Terminals opened by "Claude Login": one listener for the extension's lifetime refreshes the catalog when they close.
  const loginTerminals = new Set<vscode.Terminal>();
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => {
      if (loginTerminals.delete(closed)) void manager.refreshCatalog();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudekei.claudeLogin', async () => {
      const resolved = await resolveTerminalClaude(manager);
      if (!resolved) {
        void notifyIfCliMissing(manager);
        return;
      }
      const terminal = vscode.window.createTerminal({
        name: 'Claude Login',
        shellPath: resolved.path,
        shellArgs: ['login'],
        env: resolved.envPath ? { PATH: resolved.envPath } : undefined,
      });
      loginTerminals.add(terminal);
      terminal.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudekei.dev.replayFixture', async () => {
      const dir = path.join(context.extensionPath, 'src', 'claude', '__fixtures__');
      let names: string[] = [];
      try {
        names = readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort();
      } catch {
        vscode.window.showWarningMessage('ClaudeKei: fixtures are only available when running from the repository (Extension Development Host).');
        return;
      }
      const pick = await vscode.window.showQuickPick(names, { placeHolder: 'Replay a recorded Claude session (no API cost)' });
      if (!pick) return;
      const lines = readFileSync(path.join(dir, pick), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
      const id = await manager.replayFixture(pick.replace(/\.ndjson$/, ''), lines);
      outputChannel?.appendLine(`[ClaudeKei] replaying ${pick} as session ${id}`);
      await vscode.commands.executeCommand('claudekei.openSidebar');
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme((theme) => {
      chatViewProvider?.updateTheme(theme.kind);
    })
  );

  // Theme changes can update the `workbench.colorTheme` setting slightly after the
  // `activeColorTheme` event. Listen for config changes too so we can re-resolve
  // the contributed theme JSON and update Shiki themes in the webview.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('workbench.colorTheme') ||
        event.affectsConfiguration('workbench.preferredLightColorTheme') ||
        event.affectsConfiguration('workbench.preferredDarkColorTheme')
      ) {
        chatViewProvider?.updateTheme(vscode.window.activeColorTheme.kind);
      }
    })
  );

  // Subscribe to status changes - this broadcasts to webviews
  context.subscriptions.push(
    manager.onStatusChange((status, error) => {
      chatViewProvider?.updateConnectionStatus(status, error);
    })
  );

  // Close every live Claude process when the extension host shuts down.
  context.subscriptions.push({ dispose: () => void manager.dispose() });

  // Probe the catalog (models, commands, agents, account) without blocking activation:
  // blocking here delays webview resolution and causes a blank panel until startup completes.
  void manager.start().then(() => notifyIfCliMissing(manager));
}

/** Tells the user (once per activation) that the `claude` CLI is required and could not be found. Never throws. */
async function notifyIfCliMissing(manager: ClaudeHost['manager']): Promise<void> {
  try {
    if ((await manager.diagnostics()).executable.path) return;
    const choice = await vscode.window.showErrorMessage(`ClaudeKei: ${CLI_NOT_FOUND_MESSAGE} ${installHint()}`, 'Open Setting');
    if (choice === 'Open Setting') await vscode.commands.executeCommand('workbench.action.openSettings', 'claudekei.claudeExecutablePath');
  } catch {
    /* best-effort notification */
  }
}

export async function deactivate() {
  await claudeHost?.manager.dispose();
  claudeHost = undefined;
  chatViewProvider = undefined;
  outputChannel?.dispose();
  outputChannel = undefined;
}
