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
import type { Catalog, ContextUsage, EffortLevel, PermissionMode, PermissionResponse, QuestionAnswer, Session, UsageLimits } from './types';

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

export const claudeClient = {
  bootstrap: (): Promise<BootstrapResponse> => request('claude:bootstrap', {}),

  listSessions: (limit?: number): Promise<Session[]> => request('claude:session.list', { limit }),

  createSession: (title?: string): Promise<Session> => request('claude:session.create', { title }),

  loadSession: (sessionId: string): Promise<SessionSnapshot> => request('claude:session.load', { sessionId }),

  send: (payload: SendPayload): Promise<{ messageId: string }> => request('claude:session.send', payload),

  interrupt: (sessionId: string): Promise<void> => request('claude:session.interrupt', { sessionId }),

  fork: (sessionId: string, atMessageId?: string): Promise<Session> =>
    request('claude:session.fork', { sessionId, atMessageId }),

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

  subscribe: (listener: (push: ClaudeEventsPush) => void): (() => void) => resolveRuntime().subscribe(listener),
};
