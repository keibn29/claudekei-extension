/**
 * Environment and executable resolution for the spawned Claude Code process
 * (docs/PHASE1_PLAN.md section 8, amendment A2, W0 notes section 3).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type ClaudeEnvOptions = {
  /** `claudekei.useApiKey`: keep ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (default: strip, use the subscription login). */
  useApiKey?: boolean;
  /** Login-shell PATH (see `resolveLoginShellPath`), merged in front of the current PATH. */
  loginPath?: string;
  /** Identifies the host in the User-Agent. */
  clientApp?: string;
  extra?: Record<string, string>;
};

/**
 * Variables a parent Claude Code host (CLI, desktop app, SDK) injects into its children. Only these are dropped:
 * user configuration such as CLAUDE_CODE_MAX_OUTPUT_TOKENS, CLAUDE_CODE_OAUTH_TOKEN or CLAUDE_CODE_USE_BEDROCK is kept.
 */
const PARENT_HOST_VARS: readonly RegExp[] = [
  /^CLAUDECODE$/,
  /^CLAUDE_AGENT_SDK_/,
  /^CLAUDE_PID$/,
  /^CLAUDE_EFFORT$/,
  /^CLAUDE_PREVIEW_/,
  /^CLAUDE_CODE_(ENTRYPOINT|EXECPATH|SSE_PORT|SIMPLE|CHILD_SESSION|SESSION_ATTENDED|REPORT_FINDINGS)$/,
  /^CLAUDE_CODE_(HOST_)?SESSION_ID$/,
  /^CLAUDE_CODE_MESSAGING_/,
  /^CLAUDE_CODE_DESKTOP_/,
  /^CLAUDE_CODE_.*_BY_HOST$/,
  /^CLAUDE_CODE_SDK_HAS_/,
  /^CLAUDE_CODE_(ACCOUNT_UUID|ORGANIZATION_UUID|USER_EMAIL|OAUTH_SCOPES|TERMINAL_MCP_TOOLS)$/,
  /^CLAUDE_CODE_(EMIT_TOOL_USE_SUMMARIES|ENABLE_ASK_USER_QUESTION_TOOL|ENABLE_SDK_FILE_CHECKPOINTING|EAGER_FLUSH|DISABLE_CRON|DISABLE_TERMINAL_TITLE)$/,
];

/** Merge PATH lists, first list wins ordering, duplicates removed. */
export function mergePath(first: string | undefined, second: string | undefined, sep = delimiter): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [first, second]) {
    for (const entry of (list ?? '').split(sep)) {
      if (entry && !seen.has(entry)) {
        seen.add(entry);
        out.push(entry);
      }
    }
  }
  return out.join(sep);
}

/**
 * Builds the child environment. `env` replaces the child environment entirely in the SDK, so everything is spread.
 * - subscription auth wins: API-key variables are stripped unless `useApiKey`;
 * - variables injected by a parent Claude Code host (see PARENT_HOST_VARS) are dropped, user configuration is kept;
 * - PATH gets the login-shell PATH so plugin hooks (`node`, ...) work when VS Code was launched from the Dock;
 * - run defaults from W0: TodoWrite instead of task-v2 tools, synchronous subagents.
 */
export function buildClaudeEnv(base: NodeJS.ProcessEnv, options: ClaudeEnvOptions = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  if (!options.useApiKey) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  for (const key of Object.keys(env)) {
    if (PARENT_HOST_VARS.some((re) => re.test(key))) delete env[key];
  }
  if (options.loginPath) env.PATH = mergePath(options.loginPath, env.PATH);
  env.CLAUDE_CODE_ENABLE_TASKS = 'false';
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  env.CLAUDE_AGENT_SDK_CLIENT_APP = options.clientApp ?? 'claudekei';
  return { ...env, ...(options.extra ?? {}) };
}

type ExecFileFn = (
  file: string,
  args: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv; encoding: 'utf8' },
  callback: (error: Error | null, stdout: string) => void,
) => unknown;

export type LoginPathOptions = {
  shell?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exec?: ExecFileFn;
};

const MARK = '__CLAUDEKEI_PATH__';
let cachedLoginPath: Promise<string | undefined> | undefined;

/**
 * PATH of the user's interactive login shell (`$SHELL -ilc`), 3 s timeout, cached for the process lifetime.
 * Resolves to `undefined` on Windows, when no shell is known, on timeout or failure. A marker protects against
 * rc-file noise on stdout.
 */
export function resolveLoginShellPath(options: LoginPathOptions = {}): Promise<string | undefined> {
  const cacheable = !options.exec && !options.shell;
  if (cacheable && cachedLoginPath) return cachedLoginPath;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const shell = options.shell ?? env.SHELL;
  const run = (): Promise<string | undefined> =>
    new Promise((resolve) => {
      if (platform === 'win32' || !shell) return resolve(undefined);
      const exec = (options.exec ?? (execFile as unknown as ExecFileFn));
      try {
        exec(
          shell,
          ['-ilc', `printf '%s' "${MARK}\${PATH}${MARK}"`],
          { timeout: options.timeoutMs ?? 3000, env, encoding: 'utf8' },
          (_error, stdout) => {
            const text = String(stdout ?? '');
            const start = text.indexOf(MARK);
            const end = text.lastIndexOf(MARK);
            if (start >= 0 && end > start) resolve(text.slice(start + MARK.length, end) || undefined);
            else resolve(undefined);
          },
        );
      } catch {
        resolve(undefined);
      }
    });
  const promise = run();
  if (cacheable) cachedLoginPath = promise;
  return promise;
}

/** Test hook. */
export function resetLoginPathCache(): void {
  cachedLoginPath = undefined;
}

export type ExecutableResolution = {
  /** Value for `pathToClaudeCodeExecutable`; undefined lets the SDK resolve its own platform package. */
  path: string | undefined;
  source: 'setting' | 'bundled' | 'sdk-default';
  /** Set when the setting pointed at a missing file (and we fell back). */
  warning?: string;
};

/** Candidate package names for the native binary, preferred first (musl variants on Alpine-like systems). */
export function platformPackageNames(platform: string = process.platform, arch: string = process.arch, musl = false): string[] {
  const base = '@anthropic-ai/claude-agent-sdk';
  if (platform === 'linux') return musl ? [`${base}-linux-${arch}-musl`, `${base}-linux-${arch}`] : [`${base}-linux-${arch}`, `${base}-linux-${arch}-musl`];
  return [`${base}-${platform}-${arch}`];
}

/**
 * `claudekei.claudeExecutablePath` override, else the binary bundled next to the extension
 * (`<dist>/node_modules/@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude`), else the SDK default.
 */
export function resolveClaudeExecutable(options: {
  override?: string;
  distDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (p: string) => boolean;
}): ExecutableResolution {
  const exists = options.exists ?? existsSync;
  const override = options.override?.trim();
  let warning: string | undefined;
  if (override) {
    if (exists(override)) return { path: override, source: 'setting' };
    warning = `claudekei.claudeExecutablePath "${override}" does not exist; falling back to the bundled binary`;
  }
  if (options.distDir) {
    const exe = (options.platform ?? process.platform) === 'win32' ? 'claude.exe' : 'claude';
    for (const pkg of platformPackageNames(options.platform, options.arch)) {
      const candidate = join(options.distDir, 'node_modules', ...pkg.split('/'), exe);
      if (exists(candidate)) return { path: candidate, source: 'bundled', warning };
    }
  }
  return { path: undefined, source: 'sdk-default', warning };
}
