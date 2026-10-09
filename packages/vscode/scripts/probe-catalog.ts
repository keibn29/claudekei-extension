#!/usr/bin/env bun
/**
 * W0 spike: probe-without-message.
 *
 * Question: can a streaming-input query whose prompt iterator never yields a user message still answer
 * supportedModels()/supportedCommands()/supportedAgents()/accountInfo() (and initializationResult()),
 * and does it write a JSONL transcript?
 *
 * Variants:
 *   pending : prompt = async iterable that never yields and never ends
 *   ended   : prompt = async iterable that ends immediately (no messages)
 *
 * Output: src/claude/__fixtures__/catalog-probe.json
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildEnv, FIXTURES_DIR, seedSandbox, SANDBOX_DIR } from './_common';

/** Claude Code stores transcripts under ~/.claude/projects/<cwd with non-alphanumerics replaced by "-">. */
function projectDirFor(cwd: string): string {
  return join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

function listTranscripts(cwd: string): string[] {
  const dir = projectDirFor(cwd);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function neverYielding(): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<SDKUserMessage>>(() => {}) };
    },
  };
}

function immediatelyEnded(): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]() {
      return { next: async () => ({ value: undefined as never, done: true }) };
    },
  };
}

function withTimeout<T>(label: string, p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function timed<T>(label: string, fn: () => Promise<T>, timings: Record<string, number | string>, ms = 30000) {
  const t0 = performance.now();
  try {
    const value = await withTimeout(label, fn(), ms);
    timings[label] = Math.round(performance.now() - t0);
    return { ok: true as const, value };
  } catch (err) {
    timings[label] = `ERR ${(err as Error).message}`;
    return { ok: false as const, error: (err as Error).message };
  }
}

async function runVariant(variant: 'pending' | 'ended') {
  const before = listTranscripts(SANDBOX_DIR);
  const emitted: Array<{ type: string; subtype?: string }> = [];
  const timings: Record<string, number | string> = {};
  const options: Options = {
    cwd: SANDBOX_DIR,
    model: 'haiku',
    permissionMode: 'default',
    includePartialMessages: true,
    settingSources: ['project'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    env: buildEnv(),
    canUseTool: async () => ({ behavior: 'deny', message: 'probe' }),
  };

  const t0 = performance.now();
  const q = query({ prompt: variant === 'pending' ? neverYielding() : immediatelyEnded(), options });

  // Drain concurrently so we can see whether the iterator itself emits anything (init/etc.) without a user message.
  let drainDone = false;
  const drain = (async () => {
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        emitted.push({ type: m.type, subtype: (m as { subtype?: string }).subtype });
      }
    } catch (err) {
      emitted.push({ type: '_threw', subtype: (err as Error).message });
    } finally {
      drainDone = true;
    }
  })();

  const out: Record<string, unknown> = { variant };
  const init = await timed('initializationResult', () => q.initializationResult(), timings);
  out.initializationResult = init.ok ? init.value : { error: init.error };
  const models = await timed('supportedModels', () => q.supportedModels(), timings);
  out.supportedModels = models.ok ? models.value : { error: models.error };
  const commands = await timed('supportedCommands', () => q.supportedCommands(), timings);
  out.supportedCommands = commands.ok ? commands.value : { error: commands.error };
  const agents = await timed('supportedAgents', () => q.supportedAgents(), timings);
  out.supportedAgents = agents.ok ? agents.value : { error: agents.error };
  const account = await timed('accountInfo', () => q.accountInfo(), timings);
  out.accountInfo = account.ok ? account.value : { error: account.error };
  const ctx = await timed('getContextUsage', () => q.getContextUsage({ detail: 'summary' }), timings, 15000);
  out.getContextUsage = ctx.ok ? { ok: true, keys: Object.keys(ctx.value as object) } : { error: ctx.error };

  timings.totalUntilCatalogMs = Math.round(performance.now() - t0);
  const emittedBeforeClose = [...emitted];
  q.close();
  await withTimeout('drain after close', drain, 10000).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 500));

  const after = listTranscripts(SANDBOX_DIR);
  out.timingsMs = timings;
  out.messagesEmittedByIteratorBeforeClose = emittedBeforeClose;
  out.messagesEmittedTotal = emitted;
  out.iteratorFinishedAfterClose = drainDone;
  out.transcriptFilesBefore = before;
  out.transcriptFilesAfter = after;
  out.newTranscriptFiles = after.filter((f) => !before.includes(f));
  out.newTranscriptSizes = Object.fromEntries(
    out.newTranscriptFiles
      ? (out.newTranscriptFiles as string[]).map((f) => [f, statSync(join(projectDirFor(SANDBOX_DIR), f)).size])
      : [],
  );
  return out;
}

seedSandbox();
const results = [];
for (const variant of ['pending', 'ended'] as const) {
  console.log(`probing variant: ${variant}`);
  results.push(await runVariant(variant));
}
// Fixtures are meant to be committed: redact the signed-in user's identity.
const redact = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, v) =>
      key === 'email' ? 'user@example.com' : key === 'organization' ? 'Example Org' : key === 'pid' ? 0 : v,
    ),
  );
const file = join(FIXTURES_DIR, 'catalog-probe.json');
writeFileSync(file, JSON.stringify({ sdkProbe: redact(results) }, null, 2) + '\n');
console.log(`wrote ${file}`);
for (const r of results) {
  console.log(
    JSON.stringify(
      {
        variant: r.variant,
        timingsMs: r.timingsMs,
        emitted: r.messagesEmittedByIteratorBeforeClose,
        newTranscripts: r.newTranscriptFiles,
      },
      null,
      1,
    ),
  );
}
process.exit(0);
