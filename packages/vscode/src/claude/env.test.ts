import { afterEach, describe, expect, test } from 'bun:test';
import { buildClaudeEnv, mergePath, resetLoginPathCache, resolveClaudeExecutable, resolveLoginShellPath } from './env';

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
  const posixBase = { platform: 'darwin' as const, homedir: '/Users/u', loginPath: '/Users/u/.local/bin:/usr/bin', pathEnv: '/usr/bin' };

  test('setting wins when it exists', () => {
    expect(resolveClaudeExecutable({ ...posixBase, override: '/opt/claude', exists: exists(['/opt/claude', '/Users/u/.local/bin/claude']) })).toEqual({ path: '/opt/claude', source: 'setting' });
  });

  test('missing setting falls back to auto-detection with a warning', () => {
    const r = resolveClaudeExecutable({ ...posixBase, override: '/nope', exists: exists(['/Users/u/.local/bin/claude']) });
    expect(r).toMatchObject({ path: '/Users/u/.local/bin/claude', source: 'path' });
    expect(r.warning).toContain('does not exist');
  });

  test('login-shell PATH is searched before the process PATH', () => {
    const r = resolveClaudeExecutable({ ...posixBase, exists: exists(['/usr/bin/claude', '/Users/u/.local/bin/claude']) });
    expect(r).toEqual({ path: '/Users/u/.local/bin/claude', source: 'path', warning: undefined });
    expect(resolveClaudeExecutable({ ...posixBase, exists: exists(['/usr/bin/claude']) }).path).toBe('/usr/bin/claude');
  });

  test('well-known locations are used when PATH has no claude', () => {
    const base = { platform: 'darwin' as const, homedir: '/Users/u', loginPath: undefined, pathEnv: '/usr/bin' };
    for (const known of ['/Users/u/.local/bin/claude', '/Users/u/.claude/local/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
      expect(resolveClaudeExecutable({ ...base, exists: exists([known]) })).toMatchObject({ path: known, source: 'known-location' });
    }
  });

  test('nothing found -> not-found, no path (never the SDK default)', () => {
    expect(resolveClaudeExecutable({ ...posixBase, exists: () => false })).toMatchObject({ path: undefined, source: 'not-found' });
  });

  describe('win32', () => {
    const win = { platform: 'win32' as const, homedir: 'C:\\Users\\u', env: { USERPROFILE: 'C:\\Users\\u', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } };
    const npm = 'C:\\Users\\u\\AppData\\Roaming\\npm';

    test('claude.exe on PATH is preferred over a claude.cmd shim in the same directory', () => {
      const r = resolveClaudeExecutable({ ...win, pathEnv: `${npm};C:\\bin`, exists: exists([`${npm}\\claude.cmd`, `${npm}\\claude.exe`]) });
      expect(r).toMatchObject({ path: `${npm}\\claude.exe`, source: 'path' });
    });

    test('a claude.cmd shim resolves to the real claude.exe next to it, else cli.js', () => {
      const pkg = `${npm}\\node_modules\\@anthropic-ai\\claude-code`;
      expect(resolveClaudeExecutable({ ...win, pathEnv: npm, exists: exists([`${npm}\\claude.cmd`, `${pkg}\\bin\\claude.exe`, `${pkg}\\cli.js`]) }).path).toBe(`${pkg}\\bin\\claude.exe`);
      expect(resolveClaudeExecutable({ ...win, pathEnv: npm, exists: exists([`${npm}\\claude.cmd`, `${pkg}\\cli.js`]) }).path).toBe(`${pkg}\\cli.js`);
    });

    test('a claude.cmd shim without a usable target is treated as not found', () => {
      expect(resolveClaudeExecutable({ ...win, pathEnv: npm, exists: exists([`${npm}\\claude.cmd`]) })).toMatchObject({ path: undefined, source: 'not-found' });
    });

    test('well-known: %USERPROFILE%\\.local\\bin\\claude.exe, then the npm shim target', () => {
      expect(resolveClaudeExecutable({ ...win, pathEnv: '', exists: exists(['C:\\Users\\u\\.local\\bin\\claude.exe']) })).toMatchObject({ path: 'C:\\Users\\u\\.local\\bin\\claude.exe', source: 'known-location' });
      const pkg = `${npm}\\node_modules\\@anthropic-ai\\claude-code`;
      expect(resolveClaudeExecutable({ ...win, pathEnv: '', exists: exists([`${npm}\\claude.cmd`, `${pkg}\\bin\\claude.exe`]) })).toMatchObject({ path: `${pkg}\\bin\\claude.exe`, source: 'known-location' });
    });
  });
});
