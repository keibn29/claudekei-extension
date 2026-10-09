import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { BridgeContext } from './bridge';

const SETTINGS_KEY = 'claudekei.settings';
const OPENCHAMBER_SHARED_SETTINGS_PATH = path.join(os.homedir(), '.config', 'openchamber', 'settings.json');
const OPENCHAMBER_MAGIC_PROMPTS_PATH = path.join(os.homedir(), '.config', 'openchamber', 'magic-prompts.json');
const MAGIC_PROMPTS_FILE_VERSION = 1;
const MAGIC_PROMPT_ID_PATTERN = /^[a-z0-9._-]{1,160}$/;
const MAGIC_PROMPT_TEXT_MAX_LENGTH = 200_000;
const isVisiblePromptId = (id: string): boolean => id.endsWith('.visible');

const readSharedSettingsFromDisk = (): Record<string, unknown> => {
  try {
    const raw = fs.readFileSync(OPENCHAMBER_SHARED_SETTINGS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
};

const writeSharedSettingsToDisk = async (changes: Record<string, unknown>): Promise<void> => {
  try {
    await fs.promises.mkdir(path.dirname(OPENCHAMBER_SHARED_SETTINGS_PATH), { recursive: true });
    const current = readSharedSettingsFromDisk();
    const next: Record<string, unknown> = { ...current, ...changes };
    // Atomic write: tmp file + rename. Readers never see a partial/truncated
    // JSON that would fail to parse and silently get coerced to {}.
    const tmp = `${OPENCHAMBER_SHARED_SETTINGS_PATH}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.promises.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fs.promises.rename(tmp, OPENCHAMBER_SHARED_SETTINGS_PATH);
  } catch {
    // ignore
  }
};

// Fields derived from runtime context — never persisted, always recomputed.
const DERIVED_FIELDS = new Set(['themeVariant', 'lastDirectory']);

const sanitizeMagicPromptOverrides = (input: unknown): Record<string, string> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!MAGIC_PROMPT_ID_PATTERN.test(key) || typeof value !== 'string') {
      continue;
    }
    next[key] = value;
  }
  return next;
};

const readMagicPromptFile = (): { version: number; overrides: Record<string, string> } => {
  try {
    const raw = fs.readFileSync(OPENCHAMBER_MAGIC_PROMPTS_PATH, 'utf8');
    const parsed = JSON.parse(raw) as { overrides?: unknown };
    return {
      version: MAGIC_PROMPTS_FILE_VERSION,
      overrides: sanitizeMagicPromptOverrides(parsed?.overrides),
    };
  } catch {
    return {
      version: MAGIC_PROMPTS_FILE_VERSION,
      overrides: {},
    };
  }
};

const writeMagicPromptFile = async (state: { version: number; overrides: Record<string, string> }): Promise<void> => {
  await fs.promises.mkdir(path.dirname(OPENCHAMBER_MAGIC_PROMPTS_PATH), { recursive: true });
  await fs.promises.writeFile(OPENCHAMBER_MAGIC_PROMPTS_PATH, JSON.stringify(state, null, 2), 'utf8');
};

const stripDerived = (source: Record<string, unknown>): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...source };
  for (const key of DERIVED_FIELDS) {
    delete next[key];
  }
  return next;
};

let eagerMigrationAttempted = false;

// Read the merged persisted settings: shared file is canonical (synced with
// Desktop and Web clients). globalState is a secondary cache — disk wins on
// conflicts. On first read per process, sync any disk keys that globalState
// is missing so the cache stays current, but never let stale globalState
// values re-corrupt disk.
const readPersistedSettings = (ctx?: BridgeContext): Record<string, unknown> => {
  const fromGlobalState = stripDerived(
    ctx?.context?.globalState.get<Record<string, unknown>>(SETTINGS_KEY) || {},
  );
  const fromDisk = stripDerived(readSharedSettingsFromDisk());

  if (!eagerMigrationAttempted) {
    eagerMigrationAttempted = true;
    // Sync disk → globalState so the cache stays current.
    const missingFromGlobalState: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fromDisk)) {
      if (!(key in fromGlobalState)) {
        missingFromGlobalState[key] = value;
      }
    }
    if (Object.keys(missingFromGlobalState).length > 0) {
      // Fire-and-forget; globalState is a cache, disk is the truth.
      void ctx?.context?.globalState.update(SETTINGS_KEY, { ...fromGlobalState, ...missingFromGlobalState });
    }
  }

  // When the shared settings file exists on disk, it is the sole source of
  // truth.  This prevents stale globalState values (e.g. a defaultModel the
  // user cleared, but globalState.update didn't flush before reload) from
  // being resurrected.  Only fall back to globalState when no shared file
  // exists yet (initial migration from the pre-shared-sync era).
  if (fs.existsSync(OPENCHAMBER_SHARED_SETTINGS_PATH)) {
    return fromDisk;
  }

  return { ...fromGlobalState, ...fromDisk };
};

export const readSettings = (ctx?: BridgeContext): Record<string, unknown> => {
  const persisted = readPersistedSettings(ctx);
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const themeVariant =
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
      ? 'light'
      : 'dark';

  return {
    ...persisted,
    themeVariant,
    lastDirectory: workspaceFolder,
  };
};

export const persistSettings = async (changes: Record<string, unknown>, ctx?: BridgeContext): Promise<Record<string, unknown>> => {
  const current = readSettings(ctx);
  const restChanges = stripDerived({ ...(changes || {}) });

  const keysToClear = new Set<string>();

  for (const key of ['defaultModel', 'defaultVariant', 'defaultAgent', 'defaultGitIdentityId']) {
    const value = restChanges[key];
    if (typeof value === 'string' && value.trim().length === 0) {
      keysToClear.add(key);
      delete restChanges[key];
    }
  }

  if (typeof restChanges.usageAutoRefresh !== 'boolean') {
    delete restChanges.usageAutoRefresh;
  }

  if (typeof restChanges.usageRefreshIntervalMs === 'number' && Number.isFinite(restChanges.usageRefreshIntervalMs)) {
    restChanges.usageRefreshIntervalMs = Math.max(30000, Math.min(300000, Math.round(restChanges.usageRefreshIntervalMs)));
  } else {
    delete restChanges.usageRefreshIntervalMs;
  }

  // Persistable state = current persisted (no derived fields) + sanitized changes.
  const persistedCurrent = readPersistedSettings(ctx);
  const persistable: Record<string, unknown> = { ...persistedCurrent, ...restChanges };
  for (const key of keysToClear) {
    delete persistable[key];
  }

  // Write to the shared file (canonical, cross-client). Also mirror into
  // globalState so older builds can still read recent values if a user
  // downgrades the extension.
  await writeSharedSettingsToDisk(persistable);
  await ctx?.context?.globalState.update(SETTINGS_KEY, persistable);

  // Return the same shape as readSettings (with derived fields re-applied).
  return {
    ...persistable,
    themeVariant: current.themeVariant,
    lastDirectory: current.lastDirectory,
  };
};

export const readMagicPromptOverrides = (): { version: number; overrides: Record<string, string> } => {
  return readMagicPromptFile();
};

export const saveMagicPromptOverride = async (id: string, text: string): Promise<{ version: number; overrides: Record<string, string> }> => {
  const normalizedId = typeof id === 'string' ? id.trim() : '';
  if (!MAGIC_PROMPT_ID_PATTERN.test(normalizedId)) {
    throw new Error('Invalid prompt id');
  }
  if (typeof text !== 'string') {
    throw new Error('Prompt text must be a string');
  }
  if (isVisiblePromptId(normalizedId) && text.trim().length === 0) {
    throw new Error('Visible prompt text cannot be empty');
  }
  if (text.length > MAGIC_PROMPT_TEXT_MAX_LENGTH) {
    throw new Error('Prompt text is too long');
  }

  const current = readMagicPromptFile();
  const next = {
    version: MAGIC_PROMPTS_FILE_VERSION,
    overrides: {
      ...current.overrides,
      [normalizedId]: text,
    },
  };
  await writeMagicPromptFile(next);
  return next;
};

export const resetMagicPromptOverride = async (id: string): Promise<{ version: number; overrides: Record<string, string> }> => {
  const normalizedId = typeof id === 'string' ? id.trim() : '';
  if (!MAGIC_PROMPT_ID_PATTERN.test(normalizedId)) {
    throw new Error('Invalid prompt id');
  }

  const current = readMagicPromptFile();
  if (!Object.prototype.hasOwnProperty.call(current.overrides, normalizedId)) {
    return current;
  }
  const nextOverrides = { ...current.overrides };
  delete nextOverrides[normalizedId];
  const next = {
    version: MAGIC_PROMPTS_FILE_VERSION,
    overrides: nextOverrides,
  };
  await writeMagicPromptFile(next);
  return next;
};

export const resetAllMagicPromptOverrides = async (): Promise<{ version: number; overrides: Record<string, string> }> => {
  const next = {
    version: MAGIC_PROMPTS_FILE_VERSION,
    overrides: {},
  };
  await writeMagicPromptFile(next);
  return next;
};
