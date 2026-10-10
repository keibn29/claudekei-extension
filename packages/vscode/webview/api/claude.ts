import type { ClaudeRuntimeAPI } from '@openchamber/ui/lib/api/types';
import {
  CLAUDE_EVENTS_PUSH_TYPE,
  type ClaudeEventsPush,
  type ClaudeRequestType,
} from '@openchamber/ui/lib/claude/protocol';
import { sendBridgeMessageWithOptions } from './bridge';

// Snapshot-sized requests can wait on the SDK probe or a transcript read; everything else is quick.
const LONG_REQUEST_TYPES: ReadonlySet<ClaudeRequestType> = new Set([
  'claude:bootstrap',
  'claude:catalog.refresh',
  'claude:session.load',
  // Probe / CLI / git backed requests.
  'claude:config.reload',
  'claude:mcp.status',
  'claude:mcp.toggle',
  'claude:mcp.save',
  'claude:skills.catalog',
  'claude:skills.install',
  'claude:usage.activity',
]);
const LONG_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

type PushListener = (push: ClaudeEventsPush) => void;

const listeners = new Set<PushListener>();
let attached = false;

const isEventsPush = (value: unknown): value is ClaudeEventsPush => {
  if (!value || typeof value !== 'object') return false;
  const push = value as Partial<ClaudeEventsPush>;
  return push.type === CLAUDE_EVENTS_PUSH_TYPE && typeof push.seq === 'number' && Array.isArray(push.events);
};

// Pushes carry no request id, so the bridge response listener ignores them (no ack, no retry).
const attach = () => {
  if (attached) return;
  attached = true;
  window.addEventListener('message', (event: MessageEvent) => {
    if (!isEventsPush(event.data)) return;
    const push = event.data;
    for (const listener of listeners) {
      try {
        listener(push);
      } catch (error) {
        console.error('[ClaudeKei] claude:events listener failed', error);
      }
    }
  });
};

/** `RuntimeAPIs.claude` over the extension bridge: typed requests out, `claude:events` batches in. */
export const createVSCodeClaudeAPI = (): ClaudeRuntimeAPI => {
  attach();
  return {
    request: (type, payload) =>
      sendBridgeMessageWithOptions(type, payload, {
        timeoutMs: LONG_REQUEST_TYPES.has(type) ? LONG_REQUEST_TIMEOUT_MS : DEFAULT_REQUEST_TIMEOUT_MS,
      }) as Promise<never>,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
