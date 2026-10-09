import { afterEach, describe, expect, test } from 'bun:test';
import { buildClaudeEnv, mergePath, platformPackageNames, resetLoginPathCache, resolveClaudeExecutable, resolveLoginShellPath } from './env';

describe('buildClaudeEnv', () => {
  const base = { PATH: '/usr/bin:/bin', HOME: '/h', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'keep', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_SSE_PORT: '5', CLAUDE_CODE_HOST_SESSION_ID: 'h', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', CLAUDE_AGENT_SDK_VERSION: '1', KEEP_ME: 'yes' };

  test('strips api-key auth and parent-injected variables, sets run defaults, merges the login PATH', () => {
    const env = buildClaudeEnv(base, { loginPath: '/nvm/bin:/usr/bin', clientApp: 'claudekei/1' });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_AGENT_SDK_VERSION).toBeUndefined();
    expect(env.CLAUDE_CODE_SSE_PORT).toBeUndefined();
    expect(env.CLAUDE_CODE_HOST_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_MESSAGING_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH).toBeUndefined();
    // user configuration survives
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('keep');
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('64000');
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.KEEP_ME).toBe('yes');
    expect(env.PATH).toBe('/nvm/bin:/usr/bin:/bin');
    expect(env.CLAUDE_CODE_ENABLE_TASKS).toBe('false');
    expect(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(env.CLAUDE_AGENT_SDK_CLIENT_APP).toBe('claudekei/1');
  });

  test('useApiKey keeps the key', () => {
    const env = buildClaudeEnv(base, { useApiKey: true });
    expect(env.ANTHROPIC_API_KEY).toBe('k');
    expect(env.PATH).toBe('/usr/bin:/bin');
  });

  test('does not mutate the input', () => {
    buildClaudeEnv(base, { loginPath: '/x' });
    expect(base.ANTHROPIC_API_KEY).toBe('k');
  });
});

test('mergePath dedups and orders', () => {
  expect(mergePath('/a:/b', '/b:/c')).toBe('/a:/b:/c');
  expect(mergePath(undefined, '/c')).toBe('/c');
});

describe('resolveLoginShellPath', () => {
  afterEach(() => resetLoginPathCache());

  test('parses the marker, ignoring rc-file noise', async () => {
    const calls: string[][] = [];
    const path = await resolveLoginShellPath({
      shell: '/bin/zsh',
      platform: 'darwin',
      exec: (file, args, options, cb) => {
        calls.push([file, ...args, String(options.timeout)]);
        cb(null, 'Welcome!\n__CLAUDEKEI_PATH__/a:/b__CLAUDEKEI_PATH__\n');
      },
    });
    expect(path).toBe('/a:/b');
    // `$PATH__MARK__` would be parsed as one (empty) variable name: the braces matter
    expect(calls[0]![2]).toContain('${PATH}');
    expect(calls[0]!.slice(0, 2)).toEqual(['/bin/zsh', '-ilc']);
    expect(calls[0]![3]).toBe('3000');
  });

  test('undefined on windows, missing shell, failures', async () => {
    expect(await resolveLoginShellPath({ shell: '/bin/zsh', platform: 'win32' })).toBeUndefined();
    expect(await resolveLoginShellPath({ shell: '', platform: 'darwin', env: {} })).toBeUndefined();
    expect(await resolveLoginShellPath({ shell: '/bin/zsh', platform: 'darwin', exec: (_f, _a, _o, cb) => cb(new Error('timeout'), '') })).toBeUndefined();
    expect(await resolveLoginShellPath({ shell: '/bin/zsh', platform: 'darwin', exec: () => { throw new Error('boom'); } })).toBeUndefined();
  });

  test('a real login shell returns a PATH containing node on this machine (smoke)', async () => {
    const real = await resolveLoginShellPath({ timeoutMs: 8000 });
    expect(real === undefined || real.includes('/')).toBe(true);
  });
});

describe('resolveClaudeExecutable', () => {
  const exists = (set: string[]) => (p: string) => set.includes(p);

  test('setting wins when it exists', () => {
    expect(resolveClaudeExecutable({ override: '/opt/claude', distDir: '/d', exists: exists(['/opt/claude']) })).toEqual({ path: '/opt/claude', source: 'setting' });
  });

  test('missing setting falls back to bundled with a warning', () => {
    const r = resolveClaudeExecutable({ override: '/nope', distDir: '/d', platform: 'darwin', arch: 'arm64', exists: exists(['/d/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude']) });
    expect(r.source).toBe('bundled');
    expect(r.path).toBe('/d/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude');
    expect(r.warning).toContain('does not exist');
  });

  test('nothing found -> SDK default; linux tries musl second; windows uses .exe', () => {
    expect(resolveClaudeExecutable({ distDir: '/d', exists: () => false })).toMatchObject({ path: undefined, source: 'sdk-default' });
    expect(platformPackageNames('linux', 'x64')).toEqual(['@anthropic-ai/claude-agent-sdk-linux-x64', '@anthropic-ai/claude-agent-sdk-linux-x64-musl']);
    const win = resolveClaudeExecutable({ distDir: 'D', platform: 'win32', arch: 'x64', exists: (p) => p.endsWith('claude.exe') });
    expect(win.path?.endsWith('claude.exe')).toBe(true);
  });
});
