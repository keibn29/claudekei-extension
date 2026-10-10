import * as vscode from 'vscode';
import type { ClaudeSessionManager } from './claude/ClaudeSessionManager';
import { handleStandardGitBridgeMessage } from './bridge-git-runtime';
import { handleSpecialGitBridgeMessage } from './bridge-git-special-runtime';
import { handleFsBridgeMessage } from './bridge-fs-runtime';
import { handleConfigBridgeMessage } from './bridge-config-runtime';
import { handleSystemBridgeMessage } from './bridge-system-runtime';
import { handleClaudeBridgeMessage } from './bridge-claude-runtime';
import {
  persistSettings,
  readSettings,
  readMagicPromptOverrides,
  saveMagicPromptOverride,
  resetMagicPromptOverride,
  resetAllMagicPromptOverrides,
} from './bridge-settings-runtime';
import { execGit } from './bridge-git-process-runtime';
import {
  parseDroppedFileReference,
  readUriAsAttachment,
  resolveUserPath,
  listDirectoryEntries,
  normalizeFsPath,
  searchDirectory,
  resolveFileReadPath,
} from './bridge-fs-helpers-runtime';

export interface BridgeRequest {
  id: string;
  type: string;
  payload?: unknown;
}

export interface BridgeResponse {
  id: string;
  type: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface BridgeContext {
  manager?: ClaudeSessionManager;
  context?: vscode.ExtensionContext;
  /** Broadcaster registration of the calling webview (snapshot barrier for `claude:events`). */
  sinkId?: string;
}

const CLIENT_RELOAD_DELAY_MS = 800;


export async function handleBridgeMessage(message: BridgeRequest, ctx?: BridgeContext): Promise<BridgeResponse> {
  const { id, type, payload } = message;

  try {
    // Claude session host requests first (docs/PHASE1_PLAN.md section 3).
    const claudeResponse = await handleClaudeBridgeMessage({ id, type, payload }, ctx);
    if (claudeResponse) {
      return claudeResponse;
    }
    const standardGitResponse = await handleStandardGitBridgeMessage({ id, type, payload });
    if (standardGitResponse) {
      return standardGitResponse;
    }
    const specialGitResponse = await handleSpecialGitBridgeMessage(
      { id, type, payload },
      ctx,
      { readSettings, execGit }
    );
    if (specialGitResponse) {
      return specialGitResponse;
    }
    const fsResponse = await handleFsBridgeMessage(
      { id, type, payload },
      {
        resolveUserPath,
        listDirectoryEntries,
        normalizeFsPath,
        execGit,
        searchDirectory,
        resolveFileReadPath,
        parseDroppedFileReference,
        readUriAsAttachment,
      }
    );
    if (fsResponse) {
      return fsResponse;
    }
    const configResponse = await handleConfigBridgeMessage(
      { id, type, payload },
      ctx,
      {
        readSettings,
        persistSettings,
        readMagicPromptOverrides,
        saveMagicPromptOverride,
        resetMagicPromptOverride,
        resetAllMagicPromptOverrides,
      },
    );
    if (configResponse) {
      return configResponse;
    }
    const systemResponse = await handleSystemBridgeMessage(
      { id, type, payload },
      ctx,
      {
        resolveUserPath,
        clientReloadDelayMs: CLIENT_RELOAD_DELAY_MS,
      },
    );
    if (systemResponse) {
      return systemResponse;
    }
    return { id, type, success: false, error: `Unknown message type: ${type}` };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return { id, type, success: false, error: errorMessage };
  }
}
