import type { ClaudeRequestMap, ClaudeRequestType } from '@openchamber/ui/src/lib/claude/protocol';
import { isAnswerList } from './claude/permissions';
import type { BridgeContext, BridgeResponse } from './bridge';

type BridgeMessageInput = { id: string; type: string; payload?: unknown };

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});

const requireString = (payload: Record<string, unknown>, key: string): string => {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing "${key}"`);
  return value;
};

const CLAUDE_REQUEST_TYPES: ReadonlySet<string> = new Set<ClaudeRequestType>([
  'claude:bootstrap',
  'claude:session.list',
  'claude:session.create',
  'claude:session.load',
  'claude:session.send',
  'claude:session.interrupt',
  'claude:session.fork',
  'claude:session.delete',
  'claude:session.rename',
  'claude:session.setModel',
  'claude:session.setAgent',
  'claude:session.setMode',
  'claude:session.setEffort',
  'claude:session.contextUsage',
  'claude:usage.refresh',
  'claude:permission.respond',
  'claude:question.respond',
  'claude:catalog.refresh',
]);

/**
 * Handles every `claude:*` request of the protocol (docs/PHASE1_PLAN.md section 3) against the session manager.
 * Returns `null` for messages that are not Claude requests so the bridge can continue down its chain.
 */
export async function handleClaudeBridgeMessage(message: BridgeMessageInput, ctx?: BridgeContext): Promise<BridgeResponse | null> {
  const { id, type } = message;
  if (!type.startsWith('claude:')) return null;
  if (!CLAUDE_REQUEST_TYPES.has(type)) return { id, type, success: false, error: `Unknown Claude request: ${type}` };
  const manager = ctx?.manager;
  if (!manager) return { id, type, success: false, error: 'ClaudeKei session host is not available' };

  const payload = asRecord(message.payload);
  const ok = (data?: unknown): BridgeResponse => ({ id, type, success: true, data });

  try {
    switch (type as ClaudeRequestType) {
      case 'claude:bootstrap':
        return ok(await manager.bootstrap(ctx?.sinkId));
      case 'claude:session.list':
        return ok(await manager.list(typeof payload.limit === 'number' ? payload.limit : undefined));
      case 'claude:session.create':
        return ok(manager.create(typeof payload.title === 'string' ? payload.title : undefined));
      case 'claude:session.load':
        return ok(await manager.load(requireString(payload, 'sessionId'), ctx?.sinkId));
      case 'claude:session.send': {
        const send = payload as ClaudeRequestMap['claude:session.send']['payload'];
        const result = await manager.send(requireString(payload, 'sessionId'), {
          text: typeof send.text === 'string' ? send.text : '',
          files: send.files,
          command: send.command,
          model: send.model,
          mode: send.mode,
          agent: send.agent,
        });
        return ok(result);
      }
      case 'claude:session.interrupt':
        await manager.interrupt(requireString(payload, 'sessionId'));
        return ok();
      case 'claude:session.fork':
        return ok(await manager.fork(requireString(payload, 'sessionId'), typeof payload.atMessageId === 'string' ? payload.atMessageId : undefined));
      case 'claude:session.delete':
        await manager.delete(requireString(payload, 'sessionId'));
        return ok();
      case 'claude:session.rename':
        await manager.rename(requireString(payload, 'sessionId'), requireString(payload, 'title'));
        return ok();
      case 'claude:session.setModel':
        await manager.setModel(requireString(payload, 'sessionId'), requireString(payload, 'model'));
        return ok();
      case 'claude:session.setAgent':
        await manager.setAgent(requireString(payload, 'sessionId'), requireString(payload, 'agent'));
        return ok();
      case 'claude:session.contextUsage':
        return ok(await manager.contextUsage(requireString(payload, 'sessionId')));
      case 'claude:usage.refresh':
        return ok(await manager.refreshUsage());
      case 'claude:session.setEffort': {
        const effort = (payload as { effort?: unknown } | undefined)?.effort;
        if (effort !== null && typeof effort !== 'string') throw new Error('Invalid effort');
        await manager.setEffort(requireString(payload, 'sessionId'), effort as never);
        return ok();
      }
      case 'claude:session.setMode':
        // The manager validates the mode (PERMISSION_MODES; bypassPermissions only when enabled) and ignores invalid ones.
        await manager.setMode(requireString(payload, 'sessionId'), requireString(payload, 'mode') as never);
        return ok();
      case 'claude:permission.respond': {
        const response = requireString(payload, 'response');
        if (response !== 'once' && response !== 'always' && response !== 'reject') throw new Error(`Invalid permission response "${response}"`);
        manager.respondPermission(requireString(payload, 'sessionId'), requireString(payload, 'requestId'), response);
        return ok();
      }
      case 'claude:question.respond': {
        const sessionId = requireString(payload, 'sessionId');
        const requestId = requireString(payload, 'requestId');
        if (payload.reject === true) manager.respondQuestion(sessionId, requestId, { reject: true });
        else if (isAnswerList(payload.answers)) manager.respondQuestion(sessionId, requestId, payload.answers);
        else throw new Error('"answers" must be an array of string arrays');
        return ok();
      }
      case 'claude:catalog.refresh':
        return ok(await manager.refreshCatalog());
    }
  } catch (error) {
    return { id, type, success: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { id, type, success: false, error: `Unhandled Claude request: ${type}` };
}
