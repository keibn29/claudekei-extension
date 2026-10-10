import type { ClaudeRequestMap, ClaudeRequestType } from '@openchamber/ui/src/lib/claude/protocol';
import type { ConfigField, ConfigItemKind, ConfigScope, McpServerScope, McpTransportConfig } from '@openchamber/ui/src/lib/claude/types';
import { deleteConfigItem, listConfig, readConfigItem, saveConfigItem } from './claude/claudeConfig';
import { installSkills, scanSkillsSource } from './claude/skillsCatalog';
import { isAnswerList } from './claude/permissions';
import { validateTerminalCommand } from './claude/terminalCommand';
import type { BridgeContext, BridgeResponse } from './bridge';

type BridgeMessageInput = { id: string; type: string; payload?: unknown };

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});

const requireString = (payload: Record<string, unknown>, key: string): string => {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing "${key}"`);
  return value;
};

const requireEnum = <T extends string>(payload: Record<string, unknown>, key: string, allowed: readonly T[]): T => {
  const value = payload[key];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new Error(`Invalid "${key}"`);
  return value as T;
};

const requireBoolean = (payload: Record<string, unknown>, key: string): boolean => {
  if (typeof payload[key] !== 'boolean') throw new Error(`Invalid "${key}"`);
  return payload[key] as boolean;
};

const isStringRecord = (value: unknown): value is Record<string, string> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string');

const requireMcpConfig = (payload: Record<string, unknown>): McpTransportConfig => {
  const config = asRecord(payload.config);
  const type = requireEnum(config, 'type', ['stdio', 'http', 'sse'] as const);
  if (type === 'stdio') {
    const { command, args, env } = config;
    if (typeof command !== 'string' || !command.trim()) throw new Error('Invalid "config.command"');
    if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === 'string'))) throw new Error('Invalid "config.args"');
    if (env !== undefined && !isStringRecord(env)) throw new Error('Invalid "config.env"');
    return { type, command, ...(args ? { args: args as string[] } : {}), ...(env ? { env } : {}) };
  }
  const { url, headers } = config;
  if (typeof url !== 'string' || !url.trim()) throw new Error('Invalid "config.url"');
  if (headers !== undefined && !isStringRecord(headers)) throw new Error('Invalid "config.headers"');
  return { type, url, ...(headers ? { headers } : {}) };
};

const CONFIG_KINDS = ['agent', 'command', 'skill'] as const satisfies readonly ConfigItemKind[];
const CONFIG_SCOPES = ['user', 'project'] as const satisfies readonly ConfigScope[];
const MCP_SCOPES = ['user', 'local', 'project'] as const satisfies readonly McpServerScope[];

const CLAUDE_REQUEST_TYPES: ReadonlySet<string> = new Set<ClaudeRequestType>([
  'claude:bootstrap',
  'claude:session.list',
  'claude:session.create',
  'claude:session.load',
  'claude:session.send',
  'claude:session.interrupt',
  'claude:session.fork',
  'claude:session.revertPreview',
  'claude:session.revert',
  'claude:session.unrevert',
  'claude:session.delete',
  'claude:session.rename',
  'claude:session.setModel',
  'claude:session.setAgent',
  'claude:session.setMode',
  'claude:session.setEffort',
  'claude:session.contextUsage',
  'claude:usage.refresh',
  'claude:terminal.run',
  'claude:permission.respond',
  'claude:question.respond',
  'claude:catalog.refresh',
  'claude:config.list',
  'claude:config.read',
  'claude:config.save',
  'claude:config.delete',
  'claude:config.reload',
  'claude:plugin.setEnabled',
  'claude:mcp.status',
  'claude:mcp.save',
  'claude:mcp.remove',
  'claude:mcp.toggle',
  'claude:skills.catalog',
  'claude:skills.install',
  'claude:usage.activity',
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
          effort: send.effort,
          agent: send.agent,
        });
        return ok(result);
      }
      case 'claude:session.interrupt':
        await manager.interrupt(requireString(payload, 'sessionId'));
        return ok();
      case 'claude:session.fork':
        return ok(await manager.fork(requireString(payload, 'sessionId'), typeof payload.atMessageId === 'string' ? payload.atMessageId : undefined));
      case 'claude:session.revertPreview':
        return ok(await manager.revertPreview(requireString(payload, 'sessionId'), requireString(payload, 'messageId')));
      case 'claude:session.revert':
        return ok(await manager.revert(requireString(payload, 'sessionId'), requireString(payload, 'messageId')));
      case 'claude:session.unrevert':
        await manager.unrevert(requireString(payload, 'sessionId'));
        return ok();
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
      case 'claude:terminal.run': {
        // Validate first; the vscode-dependent glue is loaded only for a valid command (keeps this module testable).
        const command = validateTerminalCommand(payload.command);
        await (await import('./claude/terminalRun')).runInClaudeKeiTerminal(manager, command);
        return ok();
      }
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
      case 'claude:config.list':
        return ok(await listConfig(manager.configFs()));
      case 'claude:config.read':
        return ok(await readConfigItem(manager.configFs(), requireString(payload, 'path')));
      case 'claude:config.save': {
        const fields = asRecord(payload.fields);
        if (!isStringRecord(fields)) throw new Error('Invalid "fields"');
        if (typeof payload.body !== 'string') throw new Error('Invalid "body"');
        const item = await saveConfigItem(manager.configFs(), {
          kind: requireEnum(payload, 'kind', CONFIG_KINDS),
          scope: requireEnum(payload, 'scope', CONFIG_SCOPES),
          name: requireString(payload, 'name'),
          create: requireBoolean(payload, 'create'),
          fields: fields as Partial<Record<ConfigField, string>>,
          body: payload.body,
        });
        void manager.reloadConfig();
        return ok(item);
      }
      case 'claude:config.delete':
        await deleteConfigItem(manager.configFs(), requireString(payload, 'path'));
        void manager.reloadConfig();
        return ok();
      case 'claude:config.reload':
        return ok(await manager.reloadConfig());
      case 'claude:plugin.setEnabled':
        await manager.setPluginEnabled(requireString(payload, 'id'), requireBoolean(payload, 'enabled'));
        return ok();
      case 'claude:mcp.status':
        return ok(await manager.mcpStatus(payload.refresh === true));
      case 'claude:mcp.save':
        await manager.saveMcp({ name: requireString(payload, 'name'), scope: requireEnum(payload, 'scope', MCP_SCOPES), config: requireMcpConfig(payload), create: requireBoolean(payload, 'create') });
        return ok();
      case 'claude:mcp.remove':
        await manager.removeMcp({ name: requireString(payload, 'name'), scope: requireEnum(payload, 'scope', MCP_SCOPES) });
        return ok();
      case 'claude:mcp.toggle':
        await manager.toggleMcp(requireString(payload, 'name'), requireBoolean(payload, 'enabled'));
        return ok();
      case 'claude:skills.catalog':
        return ok(await scanSkillsSource(await manager.skillsOptions(), typeof payload.source === 'string' && payload.source ? payload.source : undefined, payload.refresh === true));
      case 'claude:skills.install': {
        const dirs = payload.dirs;
        if (!Array.isArray(dirs) || dirs.length === 0 || !dirs.every((d) => typeof d === 'string' && d.length > 0)) throw new Error('Invalid "dirs"');
        const result = await installSkills(await manager.skillsOptions(), {
          source: requireString(payload, 'source'),
          dirs: dirs as string[],
          scope: requireEnum(payload, 'scope', CONFIG_SCOPES),
          overwrite: requireBoolean(payload, 'overwrite'),
        });
        void manager.reloadConfig();
        return ok(result);
      }
      case 'claude:usage.activity':
        return ok(await manager.usageActivity());
    }
  } catch (error) {
    return { id, type, success: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { id, type, success: false, error: `Unhandled Claude request: ${type}` };
}
