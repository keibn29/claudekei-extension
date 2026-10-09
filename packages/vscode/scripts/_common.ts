// Shared helpers for the W0 spike scripts (fixture recorder + catalog probe).
// Not part of the extension bundle; run with `bun`.
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const FIXTURES_DIR = resolve(here, '../src/claude/__fixtures__');

// Throwaway sandbox: the recorder must NEVER run against the repo itself.
export const SANDBOX_DIR =
  '/private/tmp/claude-501/-Users-kei-Projects-claudekei-extension/a3f52df8-2dd5-4163-80a6-cde5dd3922c2/scratchpad/fixture-sandbox';

export const STDERR_LOG_DIR =
  '/private/tmp/claude-501/-Users-kei-Projects-claudekei-extension/a3f52df8-2dd5-4163-80a6-cde5dd3922c2/scratchpad/stderr-logs';

/** Re-create the sandbox with a few tiny files so tool fixtures have something to act on. */
export function seedSandbox(): string {
  if (!SANDBOX_DIR.includes('/scratchpad/fixture-sandbox')) {
    throw new Error(`Refusing to seed unexpected sandbox path: ${SANDBOX_DIR}`);
  }
  rmSync(SANDBOX_DIR, { recursive: true, force: true });
  mkdirSync(join(SANDBOX_DIR, 'src'), { recursive: true });
  writeFileSync(join(SANDBOX_DIR, 'hello.txt'), 'hello from the sandbox\nsecond line\nthird line\n');
  writeFileSync(join(SANDBOX_DIR, 'notes.md'), '# Notes\n\n- alpha\n- beta\n- gamma\n');
  writeFileSync(
    join(SANDBOX_DIR, 'src', 'app.ts'),
    "export function greet(name: string): string {\n  return 'Hello, ' + name;\n}\n\nexport const VERSION = '1.0.0';\n",
  );
  writeFileSync(
    join(SANDBOX_DIR, 'src', 'util.ts'),
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n\n// TODO: add subtract\n",
  );
  return SANDBOX_DIR;
}

/**
 * Environment for the spawned Claude Code process. Mimics what a VS Code extension host would
 * pass: no API-key auth (so the local `claude login` subscription is used) and none of the
 * variables a parent Claude Code / desktop host injects into its children.
 */
export function buildEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === 'ANTHROPIC_API_KEY' ||
      key === 'ANTHROPIC_AUTH_TOKEN' ||
      key === 'ANTHROPIC_BASE_URL' ||
      key === 'CLAUDECODE' ||
      key.startsWith('CLAUDE_CODE_') ||
      key.startsWith('CLAUDE_AGENT_SDK_') ||
      key === 'CLAUDE_EFFORT' ||
      key === 'CLAUDE_PID' ||
      key.startsWith('CLAUDE_PREVIEW_')
    ) {
      delete env[key];
    }
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'claudekei-w0-spike/0.0.1';
  return { ...env, ...extra };
}

/** Minimal async queue used as the streaming-input prompt iterable. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  end(): void {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((res) => this.waiters.push(res));
      },
    };
  }
}

export function sessionIdFromFixture(name: string): string {
  const file = join(FIXTURES_DIR, `${name}.ndjson`);
  if (!existsSync(file)) throw new Error(`Fixture not found: ${file}`);
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === 'system' && msg.subtype === 'init') return msg.session_id as string;
  }
  throw new Error(`No system/init message in fixture ${name}`);
}

/** Fixtures are committed: scrub e-mail addresses (e.g. the signed-in user's, which can leak via compaction summaries). */
export function redactEmails(text: string): string {
  return text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, 'user@example.com');
}
