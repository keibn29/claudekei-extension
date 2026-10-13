/**
 * Environment and executable resolution for the spawned Claude Code process
 * (docs/PHASE1_PLAN.md section 8, amendment A2, W0 notes section 3).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, posix, win32 } from 'node:path';

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
  /** Value for `pathToClaudeCodeExecutable`; undefined when no installed `claude` CLI was found. */
  path: string | undefined;
  source: 'setting' | 'path' | 'known-location' | 'not-found';
  /** Set when the setting pointed at a missing file (and we fell back to auto-detection). */
  warning?: string;
};

export type ResolveExecutableOptions = {
  /** `claudekei.claudeExecutablePath`. */
  override?: string;
  /** PATH of the user's login shell (preferred: a GUI-launched VS Code often lacks `~/.local/bin`). */
  loginPath?: string;
  /** Fallback PATH (the extension host's own). */
  pathEnv?: string;
  platform?: NodeJS.Platform;
  homedir?: string;
  /** Environment for `%USERPROFILE%` / `%APPDATA%` lookups on Windows. */
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
};

/**
 * Resolves a runnable file for a `claude.cmd` npm shim. Node cannot spawn `.cmd` without a shell, and the SDK only
 * special-cases `.js`/`.mjs` (run through node), so look next to the shim for the real package entry: the native
 * `bin\claude.exe` of current `@anthropic-ai/claude-code` releases, else the `cli.js` of older ones.
 */
function resolveCmdShim(shimPath: string, exists: (p: string) => boolean): string | undefined {
  const pkg = win32.join(win32.dirname(shimPath), 'node_modules', '@anthropic-ai', 'claude-code');
  return [win32.join(pkg, 'bin', 'claude.exe'), win32.join(pkg, 'cli.js')].find(exists);
}

/** First directory of `pathValue` holding a usable `claude`. On Windows: `claude.exe`, else a `claude.cmd` shim's real target. */
export function findClaudeOnPath(pathValue: string | undefined, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync): string | undefined {
  const win = platform === 'win32';
  const { join: joinPath, delimiter: sep } = win ? win32 : posix;
  for (const dir of (pathValue ?? '').split(sep)) {
    if (!dir) continue;
    if (!win) {
      const candidate = joinPath(dir, 'claude');
      if (exists(candidate)) return candidate;
      continue;
    }
    const exe = joinPath(dir, 'claude.exe');
    if (exists(exe)) return exe;
    const shim = joinPath(dir, 'claude.cmd');
    if (exists(shim)) {
      const target = resolveCmdShim(shim, exists);
      if (target) return target;
    }
  }
  return undefined;
}

/** Well-known install locations of the CLI (native installer, `claude migrate-installer`, Homebrew, npm prefixes). */
function knownLocations(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string[] {
  if (platform !== 'win32') {
    return [posix.join(home, '.local', 'bin', 'claude'), posix.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  }
  const profile = env.USERPROFILE || home;
  const found = [win32.join(profile, '.local', 'bin', 'claude.exe')];
  if (env.APPDATA) {
    const npmDir = win32.join(env.APPDATA, 'npm');
    const shimTarget = exists(win32.join(npmDir, 'claude.cmd')) ? resolveCmdShim(win32.join(npmDir, 'claude.cmd'), exists) : undefined;
    if (shimTarget) found.push(shimTarget);
  }
  return found;
}

/**
 * Locates the user's installed `claude` CLI (the extension no longer bundles a binary):
 * the `claudekei.claudeExecutablePath` setting, then `claude` on the login-shell PATH / process PATH,
 * then well-known install locations. Never falls back to the SDK's own resolution.
 */
export function resolveClaudeExecutable(options: ResolveExecutableOptions): ExecutableResolution {
  const exists = options.exists ?? existsSync;
  const platform = options.platform ?? process.platform;
  const override = options.override?.trim();
  let warning: string | undefined;
  if (override) {
    if (exists(override)) return { path: override, source: 'setting' };
    warning = `claudekei.claudeExecutablePath "${override}" does not exist; looking for an installed claude CLI instead`;
  }
  for (const pathValue of [options.loginPath, options.pathEnv]) {
    const found = findClaudeOnPath(pathValue, platform, exists);
    if (found) return { path: found, source: 'path', warning };
  }
  const home = options.homedir ?? homedir();
  const known = knownLocations(platform, home, options.env ?? process.env, exists).find(exists);
  if (known) return { path: known, source: 'known-location', warning };
  return { path: undefined, source: 'not-found', warning };
}

/** Shown (status error, error toast) when no CLI could be found. */
export const CLI_NOT_FOUND_MESSAGE = 'Claude Code CLI not found. ClaudeKei needs the `claude` CLI installed on this machine.';

/** Platform-specific install command for the CLI. */
export function installHint(platform: NodeJS.Platform = process.platform): string {
  const native = platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash';
  return `Install it with \`${native}\` or \`npm install -g @anthropic-ai/claude-code\`, or set claudekei.claudeExecutablePath.`;
}
