#!/usr/bin/env bun
/**
 * Spike for docs/SETTINGS_USAGE_SPEC.md section 8, S1 + S2 (S3/S4 were run by hand with the CLI; see W0_SPIKE_NOTES.md).
 *   bun scripts/probe-config.ts [serverToToggle]
 * S1: no-turn probe -> `mcpServerStatus()` until nothing is `pending`; records timing and the (redacted) result.
 * S2: probe A `toggleMcpServer(name, false)` -> close -> probe B status -> toggle back (true) and verify.
 * Runs in the throwaway sandbox cwd. Output: src/claude/__fixtures__/config/mcp-status-*.json
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import { buildEnv, FIXTURES_DIR, SANDBOX_DIR, seedSandbox } from './_common';

const never = (): AsyncIterable<never> => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }) });

async function withProbe<T>(fn: (q: Query) => Promise<T>): Promise<T> {
  const options: Options = { cwd: SANDBOX_DIR, permissionMode: 'default', settingSources: ['user', 'project', 'local'], systemPrompt: { type: 'preset', preset: 'claude_code' }, persistSession: false, env: buildEnv(), canUseTool: async () => ({ behavior: 'deny', message: 'probe' }) };
  const q = query({ prompt: never() as never, options });
  void (async () => { try { for await (const _ of q) void _; } catch { /* ignore */ } })();
  try {
    await q.initializationResult();
    return await fn(q);
  } finally {
    q.close();
  }
}

const redact = (servers: any[]) => servers.map((s) => ({
  ...s,
  tools: (s.tools ?? []).map((t: any) => t.name),
  config: s.config ? { ...s.config, ...(s.config.env ? { env: Object.fromEntries(Object.keys(s.config.env).map((k) => [k, '<redacted>'])) } : {}), ...(s.config.headers ? { headers: Object.fromEntries(Object.keys(s.config.headers).map((k) => [k, '<redacted>'])) } : {}) } : undefined,
}));

async function settled(q: Query, capMs = 10_000) {
  const start = Date.now();
  let samples = 0;
  for (;;) {
    const servers = (await q.mcpServerStatus()) as any[];
    samples++;
    if (servers.every((s) => s.status !== 'pending') || Date.now() - start > capMs) return { servers, ms: Date.now() - start, samples, timedOut: servers.some((s) => s.status === 'pending') };
    await new Promise((r) => setTimeout(r, 250));
  }
}

const disabledInClaudeJson = (): unknown => {
  const file = join(homedir(), '.claude.json');
  if (!existsSync(file)) return null;
  const project = JSON.parse(readFileSync(file, 'utf8')).projects?.[SANDBOX_DIR];
  return project ? { disabledMcpServers: project.disabledMcpServers, disabledMcpjsonServers: project.disabledMcpjsonServers } : null;
};

seedSandbox();
const out: Record<string, unknown> = {};
const s1 = await withProbe(async (q) => ({ ...(await settled(q)), init: undefined }));
out.S1 = { ms: s1.ms, samples: s1.samples, timedOut: s1.timedOut, servers: redact(s1.servers) };
console.log('S1', s1.ms, 'ms', s1.samples, 'samples', 'timedOut', s1.timedOut, s1.servers.map((x: any) => `${x.name}:${x.status}(${x.source ?? x.scope})`));

const target = process.argv[2] ?? (s1.servers.find((s: any) => /grep_app/.test(s.name)) ?? s1.servers[0])?.name;
out.S2 = { target } as Record<string, unknown>;
if (target) {
  const s2 = out.S2 as Record<string, unknown>;
  s2.claudeJsonBefore = disabledInClaudeJson();
  await withProbe(async (q) => {
    await q.toggleMcpServer(target, false);
    s2.afterToggleSameProbe = ((await settled(q, 3000)).servers as any[]).find((s) => s.name === target)?.status;
  });
  s2.claudeJsonAfterDisable = disabledInClaudeJson();
  s2.probeB = await withProbe(async (q) => ((await settled(q)).servers as any[]).find((s) => s.name === target)?.status);
  // toggle back
  await withProbe(async (q) => { await q.toggleMcpServer(target, true); await settled(q, 3000); });
  s2.claudeJsonAfterEnable = disabledInClaudeJson();
  s2.probeC = await withProbe(async (q) => ((await settled(q)).servers as any[]).find((s) => s.name === target)?.status);
  console.log('S2', JSON.stringify(s2));
}
writeFileSync(join(FIXTURES_DIR, 'config', 'mcp-status-spike.json'), JSON.stringify(out, null, 2) + '\n');
process.exit(0);
