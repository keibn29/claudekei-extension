/**
 * Thin typed wrapper over `RuntimeAPIs.claude` (the extension-host bridge).
 * One method per request in `protocol.ts`. Holds no state; all UI code talks to the host through it.
 */

import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { ClaudeRuntimeAPI, RuntimeAPIs } from '@/lib/api/types';
import type {
  BootstrapResponse,
  ClaudeEventsPush,
  ClaudeRequestPayload,
  ClaudeRequestResponse,
  ClaudeRequestType,
  SessionSnapshot,
} from './protocol';
import type {
  Catalog,
  ConfigItem,
  ConfigItemDetail,
  ConfigScope,
  ConfigSnapshot,
  ContextUsage,
  EffortLevel,
  McpServerScope,
  McpStatusSnapshot,
  McpTransportConfig,
  PermissionMode,
  PermissionResponse,
  QuestionAnswer,
  RevertPreview,
  RevertResult,
  Session,
  SkillCatalogItem,
  UsageActivity,
  UsageLimits,
} from './types';

const resolveRuntime = (): ClaudeRuntimeAPI => {
  const apis =
    getRegisteredRuntimeAPIs() ??
    (typeof window !== 'undefined'
      ? (window as typeof window & { __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs }).__OPENCHAMBER_RUNTIME_APIS__
      : undefined);
  const claude = apis?.claude;
  if (!claude) {
    throw new Error('Claude runtime API is not available: RuntimeAPIs.claude has not been provided by this host');
  }
  return claude;
};

const request = <T extends ClaudeRequestType>(
  type: T,
  payload: ClaudeRequestPayload<T>,
): Promise<ClaudeRequestResponse<T>> => resolveRuntime().request(type, payload);

type SendPayload = ClaudeRequestPayload<'claude:session.send'>;
type ConfigSavePayload = ClaudeRequestPayload<'claude:config.save'>;

export const claudeClient = {
  bootstrap: (): Promise<BootstrapResponse> => request('claude:bootstrap', {}),

  listSessions: (limit?: number): Promise<Session[]> => request('claude:session.list', { limit }),

  createSession: (title?: string): Promise<Session> => request('claude:session.create', { title }),

  loadSession: (sessionId: string): Promise<SessionSnapshot> => request('claude:session.load', { sessionId }),

  send: (payload: SendPayload): Promise<{ messageId: string }> => request('claude:session.send', payload),

  interrupt: (sessionId: string): Promise<void> => request('claude:session.interrupt', { sessionId }),

  fork: (sessionId: string, atMessageId?: string): Promise<Session> =>
    request('claude:session.fork', { sessionId, atMessageId }),

  revertPreview: (sessionId: string, messageId: string): Promise<RevertPreview> =>
    request('claude:session.revertPreview', { sessionId, messageId }),

  revert: (sessionId: string, messageId: string): Promise<RevertResult> =>
    request('claude:session.revert', { sessionId, messageId }),

  unrevert: (sessionId: string): Promise<void> => request('claude:session.unrevert', { sessionId }),

  deleteSession: (sessionId: string): Promise<void> => request('claude:session.delete', { sessionId }),

  renameSession: (sessionId: string, title: string): Promise<void> =>
    request('claude:session.rename', { sessionId, title }),

  setModel: (sessionId: string, model: string): Promise<void> =>
    request('claude:session.setModel', { sessionId, model }),

  setAgent: (sessionId: string, agent: string): Promise<void> =>
    request('claude:session.setAgent', { sessionId, agent }),

  setMode: (sessionId: string, mode: PermissionMode): Promise<void> =>
    request('claude:session.setMode', { sessionId, mode }),

  setEffort: (sessionId: string, effort: EffortLevel | null): Promise<void> =>
    request('claude:session.setEffort', { sessionId, effort }),

  respondPermission: (sessionId: string, requestId: string, response: PermissionResponse): Promise<void> =>
    request('claude:permission.respond', { sessionId, requestId, response }),

  respondQuestion: (
    sessionId: string,
    requestId: string,
    answers: QuestionAnswer[] | { reject: true },
  ): Promise<void> =>
    request(
      'claude:question.respond',
      'reject' in answers ? { sessionId, requestId, reject: true } : { sessionId, requestId, answers },
    ),

  contextUsage: (sessionId: string): Promise<ContextUsage> => request('claude:session.contextUsage', { sessionId }),

  /** Runs a command in the host's "ClaudeKei" terminal right away. */
  runInTerminal: (command: string): Promise<void> => request('claude:terminal.run', { command }),

  refreshUsage: (): Promise<UsageLimits> => request('claude:usage.refresh', {}),

  refreshCatalog: (): Promise<Catalog> => request('claude:catalog.refresh', {}),

  // Settings: config files (agents / commands / skills), plugins, MCP, skills catalog, usage activity.
  listConfig: (): Promise<ConfigSnapshot> => request('claude:config.list', {}),

  readConfig: (path: string): Promise<ConfigItemDetail> => request('claude:config.read', { path }),

  saveConfig: (payload: ConfigSavePayload): Promise<ConfigItem> => request('claude:config.save', payload),

  deleteConfig: (path: string): Promise<void> => request('claude:config.delete', { path }),

  reloadConfig: (): Promise<Catalog> => request('claude:config.reload', {}),

  setPluginEnabled: (id: string, enabled: boolean): Promise<void> => request('claude:plugin.setEnabled', { id, enabled }),

  mcpStatus: (refresh?: boolean): Promise<McpStatusSnapshot> => request('claude:mcp.status', { refresh }),

  saveMcp: (name: string, scope: McpServerScope, config: McpTransportConfig, create: boolean): Promise<void> =>
    request('claude:mcp.save', { name, scope, config, create }),

  removeMcp: (name: string, scope: McpServerScope): Promise<void> => request('claude:mcp.remove', { name, scope }),

  toggleMcp: (name: string, enabled: boolean): Promise<void> => request('claude:mcp.toggle', { name, enabled }),

  skillsCatalog: (source?: string, refresh?: boolean): Promise<{ source: string; items: SkillCatalogItem[] }> =>
    request('claude:skills.catalog', { source, refresh }),

  installSkills: (
    source: string,
    dirs: string[],
    scope: ConfigScope,
    overwrite: boolean,
  ): Promise<{ installed: string[]; skipped: Array<{ name: string; reason: string }> }> =>
    request('claude:skills.install', { source, dirs, scope, overwrite }),

  usageActivity: (): Promise<UsageActivity | null> => request('claude:usage.activity', {}),

  subscribe: (listener: (push: ClaudeEventsPush) => void): (() => void) => resolveRuntime().subscribe(listener),
};
