#!/usr/bin/env bun
/**
 * W3 headless integration smoke: drives the real ClaudeSessionManager core (no VS Code) against the real Claude Code
 * binary with a handful of cheap Haiku turns, in a throwaway sandbox. Run it under Electron's Node like W0:
 *
 *   bash scripts/run-integration-smoke.sh
 *
 * Covers: login-shell PATH / node availability for plugin hooks, catalog probe (claudekei primary agents, no transcript),
 * create+send, Edit permission once / always, AskUserQuestion, interrupt, list/load/rename/fork/delete and an agent
 * switch (respawn + resume continues the conversation). Sessions it creates are deleted at the end.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaudeEvent } from '@openchamber/ui/src/lib/claude/protocol';
import type { Part, PermissionMode } from '@openchamber/ui/src/lib/claude/types';
import { Broadcaster } from '../src/claude/broadcaster';
import { ClaudeSessionManager, DEFAULT_MANAGER_CONFIG, findOnPath } from '../src/claude/ClaudeSessionManager';
import { buildClaudeEnv, resolveLoginShellPath } from '../src/claude/env';
import { loadSdkRuntime, type ClaudeQuery, type QueryFactory, type SdkRuntime } from '../src/claude/sdk';

const SANDBOX = '/private/tmp/claude-501/-Users-kei-Projects-claudekei-extension/a3f52df8-2dd5-4163-80a6-cde5dd3922c2/scratchpad/smoke-sandbox';
const AGENT_A = 'claudekei:sprinter';
const AGENT_B = 'claudekei:planner';

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail?: string): boolean => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 90_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${what}`);
    await sleep(100);
  }
}

// --- sandbox -----------------------------------------------------------------
rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(SANDBOX, { recursive: true });
writeFileSync(join(SANDBOX, 'notes.md'), '# Notes\n\n- alpha\n- beta\n- gamma\n');
// Per-agent presets (claudekei.jsonc) for this sandbox only: haiku for both agents (cheap), different effort. The home
// directory is a throwaway one so the real ~/.claude/claudekei.jsonc cannot leak in.
const SMOKE_HOME = mkdtempSync(join(tmpdir(), 'ck-smoke-home-'));
mkdirSync(join(SANDBOX, '.claude'), { recursive: true });
writeFileSync(join(SANDBOX, '.claude', 'claudekei.jsonc'), '// smoke presets\n{ "primaryAgents": { "sprinter": { "model": "haiku", "effort": "low" }, "planner": { "model": "haiku", "effort": "high", }, }, }\n');
const projectDir = join(homedir(), '.claude', 'projects', SANDBOX.replace(/[^a-zA-Z0-9]/g, '-'));
const transcripts = (): string[] => (existsSync(projectDir) ? readdirSync(projectDir).filter((f) => f.endsWith('.jsonl')) : []);

// --- wiring ------------------------------------------------------------------
const distDir = dirname(fileURLToPath(import.meta.url)); // bundled to <extension>/dist/: sibling node_modules has the SDK + binary
const events: ClaudeEvent[] = [];
const broadcaster = new Broadcaster({ batchMs: 5 });
broadcaster.register({ post: (push) => void events.push(...push.events) });

const spawnLog: Array<{ options: Record<string, unknown>; hookOutcomes: string[] }> = [];
function tap(real: QueryFactory): QueryFactory {
  return (params) => {
    const record = { options: params.options as Record<string, unknown>, hookOutcomes: [] as string[] };
    spawnLog.push(record);
    const query = real(params);
    const proxy: ClaudeQuery = new Proxy(query, {
      get(target, prop) {
        if (prop === 'next') {
          return async (...args: []) => {
            const r = await target.next(...args);
            const m = r.value as { type?: string; subtype?: string; hook_name?: string; outcome?: string } | undefined;
            if (!r.done && m?.type === 'system' && m.subtype === 'hook_response') record.hookOutcomes.push(`${m.hook_name}:${m.outcome}`);
            return r;
          };
        }
        if (prop === Symbol.asyncIterator) return () => proxy;
        const value = (target as never)[prop];
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as ClaudeQuery;
    return proxy;
  };
}
const runtime = async (): Promise<SdkRuntime> => {
  const real = await loadSdkRuntime();
  return { ...real, queryFactory: tap(real.queryFactory) };
};

const store = new Map<string, unknown>();
// New sessions default to `default` here so the permission scenarios stay explicit; scenario 10 flips it to the product default.
const smokeConfig = { ...DEFAULT_MANAGER_CONFIG, idleTimeoutMinutes: 0, defaultPermissionMode: 'default' as PermissionMode };
const manager = new ClaudeSessionManager({
  cwd: SANDBOX,
  home: SMOKE_HOME,
  distDir,
  store: { get: ((k: string, d?: unknown) => (store.has(k) ? store.get(k) : d)) as never, update: async (k, v) => void store.set(k, v) },
  broadcaster,
  getConfig: () => smokeConfig,
  runtime,
  clientApp: 'claudekei-smoke/0',
  log: (level, message, data) => {
    if (level === 'warn' || level === 'error') console.log(`  [host ${level}] ${message}${data ? ` ${data instanceof Error ? data.message : JSON.stringify(data).slice(0, 300)}` : ''}`);
  },
  stderr: (d) => {
    if (/error|fail/i.test(d)) console.log(`  [claude stderr] ${d.trim().slice(0, 300)}`);
  },
});

// Auto-responders, set per scenario.
let onPermission: ((req: Extract<ClaudeEvent, { type: 'permission.asked' }>['properties'], sessionId: string) => void) | undefined;
let onQuestion: ((req: Extract<ClaudeEvent, { type: 'question.asked' }>['properties'], sessionId: string) => void) | undefined;
let handled = 0;
setInterval(() => {
  broadcaster.flush();
  for (; handled < events.length; handled++) {
    const e = events[handled]!;
    if (e.type === 'permission.asked') onPermission?.(e.properties, e.properties.sessionID);
    if (e.type === 'question.asked') onQuestion?.(e.properties, e.properties.sessionID);
  }
}, 20).unref();

const idle = (id: string) => manager.load(id).then((s) => s.status.type === 'idle');
async function settle(id: string, since: number, timeoutMs = 120_000): Promise<void> {
  // a turn is done when a session.status idle arrives after `since`
  await waitFor(`session ${id.slice(0, 8)} idle`, () => events.slice(since).some((e) => e.type === 'session.status' && e.properties.sessionID === id && e.properties.status.type === 'idle'), timeoutMs);
}
const textOf = async (id: string): Promise<{ user: string[]; assistant: string[]; tools: Array<{ tool: string; status: string; error?: string }> }> => {
  const snap = await manager.load(id);
  const parts = Object.values(snap.parts).flat() as Part[];
  const byRole = (role: string) => snap.messages.filter((m) => m.role === role).flatMap((m) => (snap.parts[m.id] ?? []).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text));
  return {
    user: byRole('user'),
    assistant: byRole('assistant'),
    tools: parts.filter((p) => p.type === 'tool').map((p) => ({ tool: (p as { tool: string }).tool, status: (p as { state: { status: string } }).state.status, error: (p as { state: { error?: string } }).state.error })),
  };
};

const created: string[] = [];
const createdAll = new Set<string>();
let failureMessage: string | undefined;

try {
  // 1. environment: login-shell PATH and node for plugin hooks --------------------------------
  const loginPath = await resolveLoginShellPath();
  const env = buildClaudeEnv(process.env, { loginPath });
  const node = findOnPath('node', env.PATH);
  check('login-shell PATH resolved', !!loginPath, loginPath?.split(':').slice(0, 3).join(':'));
  check('node on the spawned PATH (plugin hooks)', !!node, node);
  if (node) {
    const version = await new Promise<string>((resolve) => execFile('node', ['-v'], { env: env as NodeJS.ProcessEnv }, (e, out) => resolve(e ? `ERR ${e.message}` : out.trim())));
    check('`node -v` runs with the child env', /^v\d+/.test(version), version);
  }
  check('API-key auth stripped from the child env', env.ANTHROPIC_API_KEY === undefined && env.CLAUDE_CODE_ENABLE_TASKS === 'false' && env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS === '1');

  // 2. catalog probe -------------------------------------------------------------------------
  const before = transcripts().length;
  const boot = await manager.bootstrap();
  check('executable resolves to the bundled binary', manager.executable().source === 'bundled', manager.executable().path);
  check('probe wrote no transcript', transcripts().length === before, `${before} -> ${transcripts().length}`);
  check('status connected + account present', manager.getStatus().status === 'connected' && !!boot.account?.email, JSON.stringify(manager.getStatus()));
  const primary = boot.catalog.primaryAgents.map((p) => p.name);
  check('claudekei primary agents in the catalog', ['claudekei:orchestrator', 'claudekei:planner', 'claudekei:sprinter', 'claudekei:business-analyst'].every((n) => primary.includes(n)), primary.join(', '));
  check('catalog models/commands present', boot.catalog.models.length > 3 && boot.catalog.commands.length > 10, `${boot.catalog.models.length} models, ${boot.catalog.commands.length} commands`);
  console.log(`  default agent: ${boot.catalog.defaults.agent}`);

  // per-model context windows: measured on a background no-turn probe (setModel + getContextUsage) ---------------
  await waitFor('model context windows', () => manager.catalog().models.filter((m) => (m.contextWindow ?? 0) > 0).length >= manager.catalog().models.length, 120_000).catch(() => undefined);
  // One snapshot: the catalog's model list can still change while later probes/inits refresh it (a model that only
  // appears in a later list is measured by the next refresh), so only require the measured ones to be sane.
  const windowModels = manager.catalog().models;
  const measured = windowModels.filter((m) => (m.contextWindow ?? 0) > 0);
  check('model windows measured for the catalog models (at least two, all > 0, more than one distinct value)', measured.length >= 2 && measured.length >= windowModels.length - 1 && new Set(measured.map((m) => m.contextWindow)).size >= 2, measured.map((m) => `${m.value}=${m.contextWindow}`).join(', '));

  // 3. create + send ---------------------------------------------------------------------------
  const s1 = manager.create();
  created.push(s1.id);
  createdAll.add(s1.id);
  let mark = events.length;
  await manager.send(s1.id, { text: 'Reply with exactly: hello', agent: AGENT_A, model: 'haiku', mode: 'default' });
  await settle(s1.id, mark);
  let t = await textOf(s1.id);
  check('create+send: assistant replied', t.assistant.some((x) => /hello/i.test(x)), JSON.stringify(t.assistant).slice(0, 120));
  check('user message recorded with agent', (await manager.load(s1.id)).messages.some((m) => m.role === 'user' && (m as { agent?: string }).agent === AGENT_A));
  const spawn1 = spawnLog.at(-1)!;
  check('spawn options: agent/sessionId/thinking/settingSources', spawn1.options.agent === AGENT_A && spawn1.options.sessionId === s1.id && JSON.stringify(spawn1.options.settingSources) === '["user","project","local"]' && JSON.stringify(spawn1.options.thinking) === '{"type":"adaptive","display":"summarized"}');
  check('SessionStart/plugin hooks did not fail', !spawn1.hookOutcomes.some((h) => h.endsWith(':error')), spawn1.hookOutcomes.join(', ') || 'none reported');

  // context usage + plan limits (no extra model turns) ------------------------------------------------------------
  await waitFor('context usage on the session', () => !!(events.some((e) => e.type === 'session.updated' && e.properties.sessionID === s1.id && !!e.properties.info.contextUsage)), 20_000);
  const cu = await manager.contextUsage(s1.id);
  const usedCats = cu.categories.filter((c) => c.kind === 'used');
  check('context usage: exact breakdown (categories, totals, free space, autocompact buffer)', cu.source === 'exact' && cu.maxTokens > 0 && cu.usedTokens > 0 && usedCats.length >= 3 && usedCats.reduce((n, c) => n + c.tokens, 0) === cu.usedTokens && cu.categories.some((c) => c.id === 'free-space') && cu.percent >= 0, JSON.stringify({ used: cu.usedTokens, max: cu.maxTokens, percent: cu.percent, cats: cu.categories.map((c) => `${c.id}:${c.tokens}`).slice(0, 8) }));
  check('context usage reaches the Session snapshot', !!(await manager.load(s1.id)).session.contextUsage?.categories.length);
  const account = (await manager.bootstrap()).account;
  const limits = await manager.refreshUsage();
  const isSubscription = account?.apiProvider === 'firstParty' && !account.apiKeySource;
  check('usage limits: plan windows with utilization and reset time (subscription) or none (API key)', isSubscription ? limits.windows.length > 0 && limits.windows.every((w) => w.utilization >= 0 && w.utilization <= 1 && /limit|Weekly/.test(w.label)) && limits.windows.some((w) => w.id === 'session') : limits.windows.length === 0, JSON.stringify({ plan: limits.plan, windows: limits.windows.map((w) => `${w.label} ${Math.round(w.utilization * 100)}% resets ${w.resetsAt ? new Date(w.resetsAt).toISOString() : '-'}`) }));
  check('bootstrap carries the usage limits', JSON.stringify((await manager.bootstrap()).usage?.windows.map((w) => w.id)) === JSON.stringify(limits.windows.map((w) => w.id)));

  // 4. Edit permission: once ---------------------------------------------------------------------
  let asked = 0;
  onPermission = (req, sid) => {
    asked++;
    manager.respondPermission(sid, req.id, 'once');
  };
  mark = events.length;
  await manager.send(s1.id, { text: "In notes.md use the Edit tool to change '- alpha' to '- ALPHA'. Reply 'done' only." });
  await settle(s1.id, mark);
  check('permission once: prompted exactly once and edit applied', asked === 1 && readFileSync(join(SANDBOX, 'notes.md'), 'utf8').includes('- ALPHA'), `asked=${asked}`);
  const editPart = (await textOf(s1.id)).tools.find((x) => x.tool === 'edit');
  check('edit tool part completed', editPart?.status === 'completed', JSON.stringify(editPart));

  // 5. Edit permission: always -> second edit not prompted ----------------------------------------------
  asked = 0;
  let suggestionsSeen: string[] = [];
  onPermission = (req, sid) => {
    asked++;
    suggestionsSeen = req.always;
    manager.respondPermission(sid, req.id, 'always');
  };
  await manager.setMode(s1.id, 'default');
  mark = events.length;
  await manager.send(s1.id, { text: "Make two separate Edit tool calls in notes.md: change '- beta' to '- BETA', then change '- gamma' to '- GAMMA'. Reply 'done' only." });
  await settle(s1.id, mark);
  const notes = readFileSync(join(SANDBOX, 'notes.md'), 'utf8');
  check('permission always: one prompt, both edits applied', asked === 1 && notes.includes('- BETA') && notes.includes('- GAMMA'), `asked=${asked}; always=${JSON.stringify(suggestionsSeen)}`);
  onPermission = undefined;

  // 6. AskUserQuestion -----------------------------------------------------------------------------------
  onQuestion = (req, sid) => manager.respondQuestion(sid, req.id, [['Red', 'Green']]);
  mark = events.length;
  await manager.send(s1.id, { text: 'Use the AskUserQuestion tool to ask me which colors I like (multiSelect, options Red, Green, Blue). Then tell me what I picked in one sentence.' });
  await settle(s1.id, mark);
  t = await textOf(s1.id);
  check('question answered and used', events.slice(mark).some((e) => e.type === 'question.replied') && /red/i.test(t.assistant.at(-1) ?? '') && /green/i.test(t.assistant.at(-1) ?? ''), (t.assistant.at(-1) ?? '').slice(0, 100));
  onQuestion = undefined;

  // 7. interrupt ------------------------------------------------------------------------------------------
  onPermission = (req, sid) => manager.respondPermission(sid, req.id, 'once');
  mark = events.length;
  await manager.send(s1.id, { text: 'Use the Bash tool to run exactly: ping -c 40 127.0.0.1. Then reply finished.' });
  await waitFor('ping tool running', () => events.slice(mark).some((e) => e.type === 'message.part.updated' && e.properties.part.type === 'tool' && e.properties.part.tool === 'bash' && e.properties.part.state.status === 'running'), 60_000);
  await sleep(4000);
  const t0 = Date.now();
  await manager.interrupt(s1.id);
  await settle(s1.id, mark, 30_000);
  const bash = (await textOf(s1.id)).tools.filter((x) => x.tool === 'bash').at(-1);
  check('interrupt: session idle quickly, bash errored as interrupted', Date.now() - t0 < 15_000 && bash?.status === 'error', `${Date.now() - t0}ms ${JSON.stringify(bash)}`);
  check('interrupt: no error notification', !events.slice(mark).some((e) => e.type === 'session.error'));
  onPermission = undefined;

  // 8. list / load / rename / fork / delete ------------------------------------------------------------------
  const listed = await manager.list();
  check('list contains the session', listed.some((s) => s.id === s1.id), `${listed.length} sessions`);
  const entry = listed.find((s) => s.id === s1.id);
  check('Session carries agent and mode', entry?.agent === AGENT_A && entry?.mode === 'acceptEdits', JSON.stringify({ agent: entry?.agent, mode: entry?.mode }));
  await manager.rename(s1.id, 'Smoke test session');
  check('rename visible in list', (await manager.list()).find((s) => s.id === s1.id)?.title === 'Smoke test session');
  const fork = await manager.fork(s1.id);
  created.push(fork.id);
  const forkSnap = await manager.load(fork.id);
  const sourceSnap = await manager.load(s1.id);
  check('fork: new session with the same history', fork.id !== s1.id && forkSnap.messages.length > 0 && forkSnap.messages.length <= sourceSnap.messages.length, `${forkSnap.messages.length}/${sourceSnap.messages.length} messages`);
  const firstAssistant = sourceSnap.messages.find((m) => m.role === 'assistant')!;
  const fork2 = await manager.fork(s1.id, firstAssistant.id);
  created.push(fork2.id);
  const fork2Snap = await manager.load(fork2.id);
  check('fork at a message truncates history', fork2Snap.messages.length < sourceSnap.messages.length, `${fork2Snap.messages.length} < ${sourceSnap.messages.length}`);
  await manager.delete(fork2.id);
  await manager.delete(fork.id);
  created.splice(created.indexOf(fork.id), 1);
  created.splice(created.indexOf(fork2.id), 1);
  check('delete removes the transcripts', !transcripts().includes(`${fork.id}.jsonl`) && !transcripts().includes(`${fork2.id}.jsonl`) && !(await manager.list()).some((s) => s.id === fork.id));
  // cold load of a session that has no live process
  await manager.restartSessions();
  const cold = await manager.load(s1.id);
  check('cold load after process close replays history', cold.messages.length === sourceSnap.messages.length && cold.status.type === 'idle', `${cold.messages.length} messages`);

  // 9. agent switch: close + respawn with resume, snapshot:false so the system prompt really switches ----------------
  const s2 = manager.create();
  created.push(s2.id);
  createdAll.add(s2.id);
  mark = events.length;
  await manager.send(s2.id, { text: 'Remember the secret word PINEAPPLE. Also say which role your system prompt gives you: SPRINTER or PLANNER. Reply exactly: ok <ROLE>.', agent: AGENT_A, model: 'haiku' });
  await settle(s2.id, mark);
  t = await textOf(s2.id);
  check('agent A answers as its role (SPRINTER)', /sprinter/i.test(t.assistant.at(-1) ?? ''), (t.assistant.at(-1) ?? '').slice(0, 80));
  const spawnsBefore = spawnLog.length;
  await manager.setAgent(s2.id, AGENT_B);
  mark = events.length;
  await manager.send(s2.id, { text: 'What was the secret word I asked you to remember, and which role does your system prompt give you now: SPRINTER or PLANNER? Reply exactly: <WORD> <ROLE>.' });
  await settle(s2.id, mark);
  t = await textOf(s2.id);
  const respawn = spawnLog.at(-1)!;
  check('agent switch: respawned with resume, the new agent and snapshot:false', spawnLog.length === spawnsBefore + 1 && respawn.options.resume === s2.id && respawn.options.agent === AGENT_B && respawn.options.sessionId === undefined && JSON.stringify(respawn.options.systemPrompt).includes('"snapshot":false'), `resume=${String(respawn.options.resume).slice(0, 8)} agent=${String(respawn.options.agent)}`);
  check('agent switch: the conversation continued (PINEAPPLE)', /pineapple/i.test(t.assistant.at(-1) ?? ''), (t.assistant.at(-1) ?? '').slice(0, 100));
  check('agent switch: the system prompt really switched (PLANNER, not SPRINTER)', /planner/i.test((t.assistant.at(-1) ?? '').split('\n')[0]!) && !/sprinter/i.test((t.assistant.at(-1) ?? '').split('\n')[0]!), (t.assistant.at(-1) ?? '').slice(0, 100));
  check('user messages record the agents', JSON.stringify((await manager.load(s2.id)).messages.filter((m) => m.role === 'user').map((m) => (m as { agent?: string }).agent)) === JSON.stringify([AGENT_A, AGENT_B]));

  // the per-turn agents survive a cold reload (the "Switched to" divider is derived from them)
  await manager.restartSessions();
  const coldAgents = (await manager.load(s2.id)).messages.filter((m) => m.role === 'user').map((m) => (m as { agent?: string }).agent);
  check('agent per turn survives a cold reload', JSON.stringify(coldAgents) === JSON.stringify([AGENT_A, AGENT_B]), JSON.stringify(coldAgents));

  // the agent presets (claudekei.jsonc) were applied on the first spawn and on the switch
  const firstSpawn = spawnLog[spawnLog.findIndex((r) => r.options.sessionId === s2.id)]!;
  check('presets: first spawn used the sprinter preset (haiku, effort low)', firstSpawn.options.model === 'haiku' && firstSpawn.options.effort === 'low', JSON.stringify({ model: firstSpawn.options.model, effort: firstSpawn.options.effort }));
  check('presets: agent switch applied the planner preset (haiku, effort high) to the respawn', respawn.options.model === 'haiku' && respawn.options.effort === 'high', JSON.stringify({ model: respawn.options.model, effort: respawn.options.effort }));
  const s2info = (await manager.load(s2.id)).session;
  check('Session carries model/effort/resolvedModel (resolved from system/init)', s2info.model === 'haiku' && s2info.effort === 'high' && /haiku/i.test(String(s2info.resolvedModel)), JSON.stringify({ model: s2info.model, effort: s2info.effort, resolvedModel: s2info.resolvedModel }));
  const bootAgents = (await manager.bootstrap()).catalog.primaryAgents;
  check('catalog: primary agents carry the presets', bootAgents.find((a) => a.name === AGENT_B)?.defaultEffort === 'high' && bootAgents.find((a) => a.name === AGENT_A)?.defaultModel === 'haiku', JSON.stringify(bootAgents.map((a) => [a.name, a.defaultModel, a.defaultEffort])));

  // 10. default permission mode (bypass) + live effort ------------------------------------------------------------
  smokeConfig.defaultPermissionMode = 'bypassPermissions';
  const s4 = manager.create();
  created.push(s4.id);
  createdAll.add(s4.id);
  check('new session starts in bypassPermissions (product default)', s4.mode === 'bypassPermissions', String(s4.mode));
  let askedBypass = 0;
  onPermission = (req, sid) => {
    askedBypass++;
    manager.respondPermission(sid, req.id, 'once');
  };
  mark = events.length;
  const spawnsBeforeS4 = spawnLog.length;
  await manager.send(s4.id, { text: 'Run this exact bash command and reply with only its output: echo EFFORT=$CLAUDE_EFFORT', agent: AGENT_A });
  await settle(s4.id, mark);
  t = await textOf(s4.id);
  const s4spawn = spawnLog.at(-1)!;
  check('bypass: spawned with allowDangerouslySkipPermissions, the Bash tool ran without a prompt', s4spawn.options.permissionMode === 'bypassPermissions' && s4spawn.options.allowDangerouslySkipPermissions === true && askedBypass === 0 && t.tools.some((x) => x.tool === 'bash' && x.status === 'completed'), `asked=${askedBypass} tools=${JSON.stringify(t.tools)}`);
  check('effort from the preset reaches the process (CLAUDE_EFFORT=low)', /EFFORT=low/.test(t.assistant.at(-1) ?? ''), (t.assistant.at(-1) ?? '').slice(0, 60));
  await manager.setEffort(s4.id, 'medium');
  mark = events.length;
  await manager.send(s4.id, { text: 'Run this exact bash command again and reply with only its output: echo EFFORT=$CLAUDE_EFFORT' });
  await settle(s4.id, mark);
  t = await textOf(s4.id);
  check('live effort change: next turn runs with medium, no respawn', /EFFORT=medium/.test(t.assistant.at(-1) ?? '') && spawnLog.length === spawnsBeforeS4 + 1, `${(t.assistant.at(-1) ?? '').slice(0, 60)} spawns=${spawnLog.length - spawnsBeforeS4}`);
  smokeConfig.defaultPermissionMode = 'default';
  onPermission = undefined;

  // 11. subagent + SendMessage continuation: one child session, instructions as user messages ------------------------
  const s3 = manager.create();
  created.push(s3.id);
  createdAll.add(s3.id);
  mark = events.length;
  await manager.send(s3.id, { text: "Use the Agent tool with subagent_type claudekei:explorer, model haiku, description 'remember kiwi', prompt 'Remember the secret word KIWI. Reply with exactly: stored.'. Then tell me what it replied. Nothing else.", agent: AGENT_A, model: 'haiku' });
  await settle(s3.id, mark);
  mark = events.length;
  await manager.send(s3.id, { text: "Now continue that SAME explorer with the SendMessage tool, using the exp-N session alias from the claudekei hook (not the raw agent id). Message: 'What was the secret word? Reply in one word.'. Then tell me its reply." });
  await settle(s3.id, mark);
  const snap3 = await manager.load(s3.id);
  check('subagent: exactly one child session for the agent', snap3.children.length === 1, snap3.children.map((c) => c.id).join(','));
  const child = snap3.children[0]!;
  const parts3 = Object.values(snap3.parts).flat() as Part[];
  const agentPart = parts3.find((p) => p.type === 'tool' && p.tool === 'task') as { callID: string; state: { metadata?: Record<string, unknown> } } | undefined;
  const sendPart = parts3.find((p) => p.type === 'tool' && p.tool === 'sendmessage') as { state: { metadata?: Record<string, unknown> } } | undefined;
  check('child id is sub_<original Agent tool_use id>', !!agentPart && child.id === `sub_${agentPart.callID}`, child.id);
  check('Agent part linked to the child (agentId, agentType, runStatus)', !!agentPart?.state.metadata && agentPart.state.metadata.sessionID === child.id && typeof agentPart.state.metadata.agentId === 'string' && agentPart.state.metadata.runStatus === 'completed', JSON.stringify(agentPart?.state.metadata ?? {}).slice(0, 140));
  check('SendMessage part linked to the SAME child with recipient/message/reply', !!sendPart?.state.metadata && sendPart.state.metadata.sessionID === child.id && sendPart.state.metadata.agentId === agentPart?.state.metadata?.agentId && /exp-/.test(String(sendPart.state.metadata.recipient)) && /kiwi/i.test(String(sendPart.state.metadata.reply)), JSON.stringify(sendPart?.state.metadata ?? {}).slice(0, 200));
  const childSnap = await manager.load(child.id);
  const instr = childSnap.messages.filter((m) => m.role === 'user').map((m) => (m as { instruction?: { kind: string; index: number } }).instruction);
  check('child shows both instructions as user messages (initial #1, followup #2)', instr.length === 2 && instr[0]?.kind === 'initial' && instr[1]?.kind === 'followup' && instr[1]?.index === 2, JSON.stringify(instr));
  const collapse = (msgs: Array<{ role: string }>) => msgs.map((m) => m.role).filter((r, i, all) => i === 0 || r !== all[i - 1]);
  const textsOf = (snap: typeof childSnap) => snap.messages.filter((m) => m.role === 'assistant').map((m) => ((snap.parts[m.id] ?? []) as Part[]).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('')).filter(Boolean);
  const liveReplies = textsOf(childSnap);
  check('text-only Agent ping then SendMessage: child has two assistant replies live (user,assistant,user,assistant)', JSON.stringify(collapse(childSnap.messages)) === '["user","assistant","user","assistant"]' && /stored/i.test(liveReplies[0] ?? '') && /kiwi/i.test(liveReplies.at(-1) ?? '') && liveReplies.length >= 2, JSON.stringify(collapse(childSnap.messages)) + ' ' + JSON.stringify(liveReplies).slice(0, 120));
  check('child carries the agent link and plugin alias', child.claude?.agentType === 'claudekei:explorer' && typeof child.claude?.agentId === 'string' && /^exp-\d+$/.test(String(childSnap.session.claude?.alias)), JSON.stringify(childSnap.session.claude));
  check('ToolSearch that only loads SendMessage is hidden', parts3.filter((p) => p.type === 'tool' && p.tool === 'ToolSearch').every((p) => (p as { state: { metadata?: { hidden?: boolean } } }).state.metadata?.hidden === true));
  // cold replay links the same way (history + subagent transcript + plugin state)
  await manager.restartSessions();
  const cold3 = await manager.load(s3.id);
  const coldSend = (Object.values(cold3.parts).flat() as Part[]).find((p) => p.type === 'tool' && p.tool === 'sendmessage') as { state: { metadata?: Record<string, unknown> } } | undefined;
  check('replay: SendMessage still linked to the child after a cold load', !!coldSend?.state.metadata && coldSend.state.metadata.sessionID === child.id && cold3.children.length === 1, JSON.stringify(coldSend?.state.metadata ?? {}).slice(0, 160));
  const coldChild = await manager.load(child.id);
  check('replay: the child shows the same two replies', JSON.stringify(collapse(coldChild.messages)) === '["user","assistant","user","assistant"]' && JSON.stringify(textsOf(coldChild)) === JSON.stringify(liveReplies), JSON.stringify(textsOf(coldChild)).slice(0, 140));
} catch (error) {
  failureMessage = error instanceof Error ? error.stack ?? error.message : String(error);
  check('scenario run completed without exceptions', false, failureMessage.split('\n')[0]);
} finally {
  // --- cleanup ------------------------------------------------------------------------------------------------
  for (const id of created) {
    try {
      await manager.delete(id);
    } catch (e) {
      console.log(`  cleanup: could not delete ${id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  await manager.dispose();
  // the claudekei plugin keeps per-session alias state; remove what this run created
  const pluginData = join(homedir(), '.claude', 'plugins', 'data');
  if (existsSync(pluginData)) {
    for (const dir of readdirSync(pluginData).filter((d) => /claudekei/i.test(d))) {
      for (const id of createdAll) rmSync(join(pluginData, dir, 'sessions', `${id}.json`), { force: true });
    }
  }
  const leftover = transcripts();
  check('cleanup: no session transcripts left in the sandbox project', leftover.length === 0, leftover.join(', '));
  rmSync(SANDBOX, { recursive: true, force: true });
  rmSync(SMOKE_HOME, { recursive: true, force: true });
  if (existsSync(projectDir) && readdirSync(projectDir).length === 0) rmSync(projectDir, { recursive: true, force: true });
  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed; ${spawnLog.length} Claude processes started`);
  if (failureMessage) console.log(failureMessage);
  process.exit(failed.length === 0 ? 0 : 1);
}
