/**
 * `claudeHost`: workspace/directory context, local filesystem helpers and catalog-derived reads
 * that used to live on `opencodeClient`. It never talks to an OpenCode server: filesystem calls
 * use the webview-local `/api/fs/*` routes and everything else is served by `claudeClient`.
 */

import type { FilesAPI, RuntimeAPIs } from '@/lib/api/types';
import { getDesktopHomeDirectory } from '@/lib/desktop';
import { buildAgents, buildAnthropicProvider, buildCommands } from './catalog';
import { claudeClient } from './client';
import { getBootstrapSnapshot, getCatalog, loadBootstrap } from './bootstrapCache';
import { sendPrompt, type SendFileInput, type SendAdditionalPart } from './send';
import type { Agent, Command, Provider, Session } from './types';

const API_BASE = '/api';

export type FilesystemEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink?: boolean;
};

export type ProjectFileSearchHit = {
  name: string;
  path: string;
  relativePath: string;
  extension?: string;
};

const normalizeFsPath = (path: string): string => path.replace(/\\/g, '/');
const FS_LIST_CACHE_TTL_MS = 400;

const getDesktopFilesApi = (): FilesAPI | null => {
  if (typeof window === 'undefined') return null;
  const apis = (window as typeof window & { __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs }).__OPENCHAMBER_RUNTIME_APIS__;
  return apis && apis.runtime?.isDesktop && apis.files ? apis.files : null;
};

const normalizeCandidatePath = (path?: string | null): string | null => {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  const normalized = trimmed
    .replace(/\\/g, '/')
    .replace(/^([a-z]):/, (_, letter: string) => `${letter.toUpperCase()}:`);
  const withoutTrailingSlash = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
  return withoutTrailingSlash || null;
};

const deriveHomeDirectory = (path: string): { homeDirectory: string; username?: string } => {
  const windowsMatch = path.match(/^([A-Za-z]:)(?:\/|$)/);
  if (windowsMatch) {
    const drive = windowsMatch[1];
    const remainder = path.slice(drive.length + (path.charAt(drive.length) === '/' ? 1 : 0));
    const segments = remainder.split('/').filter(Boolean);
    if (segments.length >= 2) return { homeDirectory: `${drive}/${segments[0]}/${segments[1]}`, username: segments[1] };
    if (segments.length === 1) return { homeDirectory: `${drive}/${segments[0]}`, username: segments[0] };
    return { homeDirectory: drive, username: undefined };
  }

  const absolute = path.startsWith('/');
  const segments = path.split('/').filter(Boolean);
  if (segments.length >= 2 && (segments[0] === 'Users' || segments[0] === 'home')) {
    return { homeDirectory: `${absolute ? '/' : ''}${segments[0]}/${segments[1]}`, username: segments[1] };
  }
  if (segments.length > 0) {
    return { homeDirectory: `${absolute ? '/' : ''}${segments.join('/')}`, username: segments[segments.length - 1] };
  }
  return { homeDirectory: '/', username: undefined };
};

class ClaudeHost {
  private currentDirectory: string | undefined = undefined;
  private directoryContextQueue: Promise<void> = Promise.resolve();
  private listDirectoryInFlight = new Map<string, Promise<FilesystemEntry[]>>();
  private listDirectoryCache = new Map<string, { entries: FilesystemEntry[]; expiresAt: number }>();

  // ---- Directory context ---------------------------------------------------

  setDirectory(directory: string | undefined) {
    this.currentDirectory = normalizeCandidatePath(directory) ?? directory;
  }

  getDirectory(): string | undefined {
    return this.currentDirectory;
  }

  async withDirectory<T>(directory: string | undefined | null, fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (directory === undefined || directory === null) return fn();
      const previous = this.currentDirectory;
      this.currentDirectory = normalizeCandidatePath(directory) ?? directory;
      try {
        return await fn();
      } finally {
        this.currentDirectory = previous;
      }
    };
    const queued = this.directoryContextQueue.then(run, run);
    this.directoryContextQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async getSystemInfo(): Promise<{ homeDirectory: string; username?: string }> {
    const candidates: string[] = [];
    const add = (value?: string | null) => {
      const normalized = normalizeCandidatePath(value);
      if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
    };

    add(getBootstrapSnapshot()?.cwd);
    add(this.currentDirectory);
    if (typeof window !== 'undefined') {
      try {
        add(window.localStorage.getItem('lastDirectory'));
        add(window.localStorage.getItem('homeDirectory'));
      } catch {
        // Storage can be unavailable (privacy mode).
      }
    }

    return candidates.length > 0 ? deriveHomeDirectory(candidates[0]) : { homeDirectory: '/', username: undefined };
  }

  /** The workspace is fixed to the VS Code folder, so any non-empty directory counts as reachable. */
  async probeDirectory(directory: string): Promise<boolean> {
    return normalizeCandidatePath(directory) !== null;
  }

  // ---- Health / init (compat) ---------------------------------------------

  /** True when the host answers `claude:bootstrap`. */
  async checkHealth(): Promise<boolean> {
    try {
      await loadBootstrap();
      return true;
    } catch {
      return false;
    }
  }

  async initApp(): Promise<boolean> {
    return this.checkHealth();
  }

  // ---- Catalog-derived reads ----------------------------------------------

  async getProviders(): Promise<{ providers: Provider[]; default: Record<string, string> }> {
    const { catalog } = await loadBootstrap();
    return {
      providers: [buildAnthropicProvider(catalog)],
      default: { anthropic: catalog.defaults.model },
    };
  }

  async listAgents(): Promise<Agent[]> {
    const catalog = getCatalog() ?? (await loadBootstrap()).catalog;
    return buildAgents(catalog);
  }

  async listCommandsWithDetails(): Promise<Command[]> {
    const catalog = getCatalog() ?? (await loadBootstrap()).catalog;
    return buildCommands(catalog);
  }

  async listToolIds(): Promise<string[]> {
    return [];
  }

  // ---- Sessions / prompts (compat wrappers over claudeClient) --------------

  async createSession(params?: { parentID?: string; title?: string }): Promise<Session> {
    return claudeClient.createSession(params?.title);
  }

  async sendMessage(params: {
    id: string;
    providerID?: string;
    modelID: string;
    text: string;
    prefaceText?: string;
    prefaceTextSynthetic?: boolean;
    agent?: string;
    variant?: string;
    files?: SendFileInput[];
    additionalParts?: SendAdditionalPart[];
    messageId?: string;
  }): Promise<string> {
    return sendPrompt({
      sessionId: params.id,
      text: params.text,
      prefaceText: params.prefaceText,
      files: params.files,
      additionalParts: params.additionalParts,
      modelID: params.modelID,
      agent: params.agent,
    });
  }

  // ---- Filesystem ----------------------------------------------------------

  async createDirectory(
    dirPath: string,
    options?: { allowOutsideWorkspace?: boolean },
  ): Promise<{ success: boolean; path: string }> {
    const desktopFiles = getDesktopFilesApi();
    if (desktopFiles?.createDirectory) {
      return desktopFiles.createDirectory(dirPath);
    }

    const response = await fetch(`${API_BASE}/fs/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: dirPath,
        ...(options?.allowOutsideWorkspace ? { allowOutsideWorkspace: true } : {}),
      }),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to create directory' }));
      throw new Error(error.error || 'Failed to create directory');
    }
    return response.json();
  }

  async listLocalDirectory(
    directoryPath: string | null | undefined,
    options?: { respectGitignore?: boolean },
  ): Promise<FilesystemEntry[]> {
    const normalizedDirectoryPath = typeof directoryPath === 'string' ? normalizeFsPath(directoryPath.trim()) : '';
    const cacheKey = `${normalizedDirectoryPath}|${options?.respectGitignore ? '1' : '0'}`;
    const cached = this.listDirectoryCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.entries;

    const inFlight = this.listDirectoryInFlight.get(cacheKey);
    if (inFlight) return inFlight;

    const task = (async () => {
      const desktopFiles = getDesktopFilesApi();
      let entries: FilesystemEntry[];
      if (desktopFiles) {
        const result = await desktopFiles.listDirectory(directoryPath || '', options);
        if (!result || !Array.isArray(result.entries)) return [];
        entries = result.entries.map<FilesystemEntry>((entry) => ({
          name: entry.name,
          path: normalizeFsPath(entry.path),
          isDirectory: !!entry.isDirectory,
          isFile: !entry.isDirectory,
          isSymbolicLink: false,
        }));
      } else {
        const params = new URLSearchParams();
        if (directoryPath && directoryPath.trim().length > 0) params.set('path', directoryPath);
        if (options?.respectGitignore) params.set('respectGitignore', 'true');
        const query = params.toString();
        const response = await fetch(`${API_BASE}/fs/list${query ? `?${query}` : ''}`);
        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(typeof error.error === 'string' ? error.error : 'Failed to list directory');
        }
        const result = await response.json();
        if (!result || !Array.isArray(result.entries)) return [];
        entries = result.entries as FilesystemEntry[];
      }
      this.listDirectoryCache.set(cacheKey, { entries, expiresAt: Date.now() + FS_LIST_CACHE_TTL_MS });
      return entries;
    })();

    const tracked = task.finally(() => {
      if (this.listDirectoryInFlight.get(cacheKey) === tracked) this.listDirectoryInFlight.delete(cacheKey);
    });
    this.listDirectoryInFlight.set(cacheKey, tracked);
    return tracked;
  }

  async searchFiles(
    query: string,
    options?: {
      directory?: string | null;
      limit?: number;
      includeHidden?: boolean;
      respectGitignore?: boolean;
      dirs?: boolean;
      type?: 'file' | 'directory';
    },
  ): Promise<ProjectFileSearchHit[]> {
    const directory =
      typeof options?.directory === 'string' && options.directory.trim().length > 0
        ? options.directory.trim()
        : this.currentDirectory;
    const normalizedDirectory = directory ? normalizeFsPath(directory) : null;

    const params = new URLSearchParams();
    if (directory) params.set('directory', directory);
    params.set('query', query);
    if (typeof options?.limit === 'number' && Number.isFinite(options.limit)) params.set('limit', String(options.limit));
    if (options?.includeHidden) params.set('includeHidden', 'true');
    if (options?.respectGitignore === false) params.set('respectGitignore', 'false');
    if (options?.type === 'directory' || options?.dirs === true) params.set('type', 'directory');

    const response = await fetch(`${API_BASE}/fs/search?${params.toString()}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(typeof error.error === 'string' ? error.error : 'Failed to search files');
    }
    const payload = (await response.json()) as { files?: Array<Partial<ProjectFileSearchHit>> };
    const files = Array.isArray(payload?.files) ? payload.files : [];

    return files
      .filter((item): item is Partial<ProjectFileSearchHit> & { path: string } => typeof item?.path === 'string')
      .map<ProjectFileSearchHit>((item) => {
        const path = normalizeFsPath(item.path);
        const relativePath =
          typeof item.relativePath === 'string' && item.relativePath.length > 0
            ? normalizeFsPath(item.relativePath)
            : normalizedDirectory && path.startsWith(`${normalizedDirectory}/`)
              ? path.slice(normalizedDirectory.length + 1)
              : path;
        const name = item.name || relativePath.split('/').filter(Boolean).pop() || relativePath;
        return {
          name,
          path,
          relativePath,
          extension: name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined,
        };
      });
  }

  async getFilesystemHome(): Promise<string | null> {
    const desktopHome = await getDesktopHomeDirectory();
    if (desktopHome) return desktopHome;

    try {
      const response = await fetch(`${API_BASE}/fs/home`, { headers: { Accept: 'application/json' } });
      if (!response.ok) return null;
      const payload = await response.json();
      return payload && typeof payload.home === 'string' && payload.home.length > 0 ? payload.home : null;
    } catch (error) {
      console.warn('Failed to resolve filesystem home directory:', error);
      return null;
    }
  }
}

export const claudeHost = new ClaudeHost();
