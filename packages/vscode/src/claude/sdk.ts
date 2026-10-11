/**
 * Thin abstraction over `@anthropic-ai/claude-agent-sdk` so the session host core can be tested with fakes.
 * The SDK is ESM-only and external to the esbuild bundle: it is loaded lazily with a dynamic import()
 * (docs/W0_SPIKE_NOTES.md section 5).
 */
import type { Options, PermissionMode as SdkPermissionMode, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HistoryEntry } from './history';

export type { Options as SdkOptions, SDKMessage, SDKUserMessage, SdkPermissionMode };

/** The subset of the SDK `Query` the host uses. */
export interface ClaudeQuery extends AsyncGenerator<SDKMessage, void> {
  /** `cancelQueued` also cancels queued prompts (sdk.mjs accepts it; the 0.3.295 typings only declare `interrupt()`). */
  interrupt(options?: { cancelQueued?: boolean }): Promise<unknown>;
  /** Optional so fakes may omit it. Emits a `task_notification` with status `stopped` for that task. */
  stopTask?(taskId: string): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: SdkPermissionMode): Promise<void>;
  /** Optional so fakes may omit it; the host falls back to a respawn when it is missing or fails. */
  applyFlagSettings?(settings: { effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null }): Promise<void>;
  /** Optional so fakes may omit them; the host treats a missing or failing method as "no data". */
  getContextUsage?(options?: { detail?: 'summary' | 'full' }): Promise<unknown>;
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(options?: { skipBehaviors?: boolean }): Promise<unknown>;
  /** Optional so fakes may omit them; every MCP server the process knows (config + live status). */
  mcpServerStatus?(): Promise<unknown[]>;
  /** Persisted by Claude Code (`disabledMcpServers` of the project entry in `~/.claude.json`), docs/W0_SPIKE_NOTES.md section 10. */
  toggleMcpServer?(name: string, enabled: boolean): Promise<void>;
  initializationResult(): Promise<InitializationResult>;
  close(): void;
}

export type InitializationResult = {
  commands?: Array<{ name: string; description: string; argumentHint?: string; aliases?: string[]; builtin?: boolean }>;
  agents?: Array<{ name: string; description: string; model?: string }>;
  models?: Array<Record<string, unknown> & { value: string; displayName: string; description: string }>;
  account?: { email?: string; organization?: string; subscriptionType?: string; tokenSource?: string; apiKeySource?: string; apiProvider?: string };
  current_permission_mode?: string;
  output_style?: string;
};

export type QueryParams = { prompt: AsyncIterable<SDKUserMessage>; options: Options };
export type QueryFactory = (params: QueryParams) => ClaudeQuery;

/** Session helpers of the SDK (`listSessions`, `renameSession`, ...), injectable for tests. */
export interface SessionApi {
  listSessions(options: { dir: string; limit?: number }): Promise<SdkSessionInfo[]>;
  getSessionInfo(sessionId: string, options: { dir: string }): Promise<SdkSessionInfo | undefined>;
  renameSession(sessionId: string, title: string, options: { dir: string }): Promise<void>;
  deleteSession(sessionId: string, options: { dir: string }): Promise<void>;
  forkSession(sessionId: string, options: { dir: string; upToMessageId?: string; title?: string }): Promise<{ sessionId: string }>;
  getSessionMessages(sessionId: string, options: { dir: string }): Promise<HistoryEntry[]>;
  listSubagents(sessionId: string, options: { dir: string }): Promise<string[]>;
  getSubagentMessages(sessionId: string, agentId: string, options: { dir: string }): Promise<HistoryEntry[]>;
}

export type SdkSessionInfo = {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  firstPrompt?: string;
  gitBranch?: string;
  cwd?: string;
  createdAt?: number;
};

export type SdkRuntime = { queryFactory: QueryFactory; sessions: SessionApi };

let cached: Promise<SdkRuntime> | undefined;

/** Loads the real SDK once. Never pass `includeProgrammatic: false` to `listSessions` (it hides every SDK session). */
export function loadSdkRuntime(): Promise<SdkRuntime> {
  cached ??= import('@anthropic-ai/claude-agent-sdk').then((sdk): SdkRuntime => ({
    queryFactory: ((params) => sdk.query(params)) as QueryFactory,
    sessions: {
      listSessions: (o) => sdk.listSessions({ dir: o.dir, limit: o.limit }),
      getSessionInfo: (id, o) => sdk.getSessionInfo(id, o),
      renameSession: (id, title, o) => sdk.renameSession(id, title, o),
      deleteSession: (id, o) => sdk.deleteSession(id, o),
      forkSession: (id, o) => sdk.forkSession(id, o),
      getSessionMessages: (id, o) => sdk.getSessionMessages(id, o) as unknown as Promise<HistoryEntry[]>,
      listSubagents: (id, o) => sdk.listSubagents(id, o),
      getSubagentMessages: (id, agent, o) => sdk.getSubagentMessages(id, agent, o) as unknown as Promise<HistoryEntry[]>,
    },
  })).catch((error) => {
    // A failed import (e.g. missing files during an update) must not stick: allow a retry on the next call.
    cached = undefined;
    throw error;
  });
  return cached;
}
