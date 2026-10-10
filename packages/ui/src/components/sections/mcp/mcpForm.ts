import type { McpTransportConfig } from '@/lib/claude/types';

export type McpTransportType = McpTransportConfig['type'];

/** Text form of a server config: multi-value fields are edited as one entry per line. */
export type McpFormState = {
  type: McpTransportType;
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
};

export type McpFormErrors = {
  name?: 'invalid';
  command?: 'required';
  env?: number;
  url?: 'invalid';
  headers?: number;
};

export const MCP_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const emptyMcpForm = (): McpFormState => ({ type: 'stdio', command: '', args: '', env: '', url: '', headers: '' });

const lines = (text: string): Array<{ line: number; value: string }> =>
  text
    .split(/\r?\n/)
    .map((raw, index) => ({ line: index + 1, value: raw.trim() }))
    .filter((entry) => entry.value !== '');

const splitOnce = (value: string, separator: string): [string, string] | null => {
  const index = value.indexOf(separator);
  return index === -1 ? null : [value.slice(0, index).trim(), value.slice(index + 1).trim()];
};

/** First invalid line number (1-based) or the parsed record. */
const parsePairs = (text: string, separator: string, validKey: (key: string) => boolean): { ok: Record<string, string> } | { badLine: number } => {
  const result: Record<string, string> = {};
  for (const { line, value } of lines(text)) {
    const pair = splitOnce(value, separator);
    if (!pair || !validKey(pair[0])) return { badLine: line };
    result[pair[0]] = pair[1];
  }
  return { ok: result };
};

const formatPairs = (record: Record<string, string> | undefined, separator: string): string =>
  Object.entries(record ?? {})
    .map(([key, value]) => `${key}${separator}${value}`)
    .join('\n');

export const formFromConfig = (config: McpTransportConfig | undefined): McpFormState => {
  if (!config) return emptyMcpForm();
  if (config.type === 'stdio') {
    return { ...emptyMcpForm(), type: 'stdio', command: config.command, args: (config.args ?? []).join('\n'), env: formatPairs(config.env, '=') };
  }
  return { ...emptyMcpForm(), type: config.type, url: config.url, headers: formatPairs(config.headers, ': ') };
};

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

/** Validation errors for the fields relevant to the selected transport type (name checked on create only). */
export const validateMcpForm = (form: McpFormState, name: string | null): McpFormErrors => {
  const errors: McpFormErrors = {};
  if (name !== null && !MCP_NAME_PATTERN.test(name)) errors.name = 'invalid';
  if (form.type === 'stdio') {
    if (form.command.trim() === '') errors.command = 'required';
    const env = parsePairs(form.env, '=', (key) => ENV_KEY_PATTERN.test(key));
    if ('badLine' in env) errors.env = env.badLine;
  } else {
    if (!isHttpUrl(form.url.trim())) errors.url = 'invalid';
    const headers = parsePairs(form.headers, ':', (key) => key !== '');
    if ('badLine' in headers) errors.headers = headers.badLine;
  }
  return errors;
};

/** Build the host config from a form that passed `validateMcpForm`. */
export const configFromForm = (form: McpFormState): McpTransportConfig => {
  if (form.type === 'stdio') {
    const args = lines(form.args).map((entry) => entry.value);
    const env = parsePairs(form.env, '=', (key) => ENV_KEY_PATTERN.test(key));
    const envRecord = 'ok' in env ? env.ok : {};
    return {
      type: 'stdio',
      command: form.command.trim(),
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(envRecord).length > 0 ? { env: envRecord } : {}),
    };
  }
  const headers = parsePairs(form.headers, ':', (key) => key !== '');
  const headersRecord = 'ok' in headers ? headers.ok : {};
  return {
    type: form.type,
    url: form.url.trim(),
    ...(Object.keys(headersRecord).length > 0 ? { headers: headersRecord } : {}),
  };
};

/** Compare by the config that would be saved so cosmetic whitespace edits do not count as changes. */
export const isMcpFormDirty = (form: McpFormState, baseline: McpFormState): boolean => {
  const errors = validateMcpForm(form, null);
  if (Object.keys(errors).length > 0) return true;
  return JSON.stringify(configFromForm(form)) !== JSON.stringify(configFromForm(baseline));
};
