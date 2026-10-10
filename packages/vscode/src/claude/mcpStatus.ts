/** Maps the SDK's `mcpServerStatus()` entries to the webview's `McpServerInfo` (docs/SETTINGS_USAGE_SPEC.md section 2.4). */
import type { McpServerInfo, McpServerScope, McpTransportConfig } from '@openchamber/ui/src/lib/claude/types';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const strRecord = (v: unknown): Record<string, string> | undefined => {
  if (!isRec(v)) return undefined;
  const entries = Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const STATUSES: ReadonlySet<string> = new Set(['connected', 'failed', 'needs-auth', 'pending', 'disabled']);
const EDITABLE_SCOPES: ReadonlySet<string> = new Set(['user', 'local', 'project']);

/** stdio (`type` absent or `stdio`) and http / sse are editable; anything else (claudeai proxy, sdk, ...) has no config. */
export function toTransportConfig(raw: unknown): McpTransportConfig | undefined {
  if (!isRec(raw)) return undefined;
  const type = raw.type;
  if ((type === undefined || type === 'stdio') && str(raw.command)) {
    const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : undefined;
    const env = strRecord(raw.env);
    return { type: 'stdio', command: raw.command as string, ...(args && args.length > 0 ? { args } : {}), ...(env ? { env } : {}) };
  }
  if ((type === 'http' || type === 'sse') && str(raw.url)) {
    const headers = strRecord(raw.headers);
    return { type, url: raw.url as string, ...(headers ? { headers } : {}) };
  }
  return undefined;
}

export function mapMcpServers(raw: readonly unknown[]): McpServerInfo[] {
  const servers: McpServerInfo[] = [];
  for (const entry of raw) {
    if (!isRec(entry) || !str(entry.name)) continue;
    const origin = str(entry.source) ?? str(entry.scope) ?? 'unknown';
    const config = toTransportConfig(entry.config);
    const scope = config && EDITABLE_SCOPES.has(origin) ? (origin as McpServerScope) : undefined;
    const serverInfo = isRec(entry.serverInfo) && str(entry.serverInfo.name) ? { name: entry.serverInfo.name as string, version: str(entry.serverInfo.version) ?? '' } : undefined;
    servers.push({
      name: entry.name as string,
      status: (STATUSES.has(entry.status as string) ? entry.status : 'pending') as McpServerInfo['status'],
      origin,
      ...(scope ? { scope, config } : {}),
      ...(str(entry.error) ? { error: str(entry.error) } : {}),
      ...(serverInfo ? { serverInfo } : {}),
      toolCount: Array.isArray(entry.tools) ? entry.tools.length : 0,
    });
  }
  return servers;
}

/** `claude mcp add-json` payload of a transport config. */
export function mcpConfigJson(config: McpTransportConfig): string {
  if (config.type === 'stdio') return JSON.stringify({ type: 'stdio', command: config.command, ...(config.args?.length ? { args: config.args } : {}), ...(config.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}) });
  return JSON.stringify({ type: config.type, url: config.url, ...(config.headers && Object.keys(config.headers).length > 0 ? { headers: config.headers } : {}) });
}

/** Rejects configs the CLI would accept but that cannot work (and would lose the previous entry on an update). */
export function validateMcpConfig(config: McpTransportConfig): void {
  if (config.type === 'stdio') {
    if (!config.command?.trim()) throw new Error('A stdio server needs a command');
  } else if (config.type === 'http' || config.type === 'sse') {
    let url: URL;
    try {
      url = new URL(config.url);
    } catch {
      throw new Error('The server URL is not valid');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The server URL must start with http:// or https://');
  } else throw new Error('Unsupported MCP transport type');
}

const isStringMap = (v: unknown): v is Record<string, unknown> => isRec(v);

/** Edited key/value map over the original one: unchanged entries keep their raw value, removed keys disappear. */
function mergeMap(raw: unknown, edited: Record<string, string> | undefined): Record<string, unknown> | undefined {
  if (!edited || Object.keys(edited).length === 0) return undefined;
  const base = isStringMap(raw) ? raw : {};
  return Object.fromEntries(Object.entries(edited).map(([k, v]) => [k, k in base && String(base[k]) === v ? base[k] : v]));
}

const STDIO_KEYS = ['command', 'args', 'env'];
const REMOTE_KEYS = ['url', 'headers'];

/**
 * The server's stored config (as `mcpServerStatus()` reported it) with the form's fields applied. Every key the form does
 * not know (oauth, headersHelper, timeout, ...) survives; a transport change starts from a clean config.
 */
export function mergeMcpConfig(raw: unknown, edited: McpTransportConfig): Record<string, unknown> {
  const original = toTransportConfig(raw);
  if (!isRec(raw) || !original || original.type !== edited.type) return JSON.parse(mcpConfigJson(edited)) as Record<string, unknown>;
  const managed = edited.type === 'stdio' ? STDIO_KEYS : REMOTE_KEYS;
  const merged: Record<string, unknown> = Object.fromEntries(Object.entries(raw).filter(([k]) => !managed.includes(k)));
  merged.type = edited.type;
  if (edited.type === 'stdio') {
    merged.command = edited.command;
    if (edited.args?.length) merged.args = edited.args;
    const env = mergeMap(raw.env, edited.env);
    if (env) merged.env = env;
  } else {
    merged.url = edited.url;
    const headers = mergeMap(raw.headers, edited.headers);
    if (headers) merged.headers = headers;
  }
  return merged;
}
