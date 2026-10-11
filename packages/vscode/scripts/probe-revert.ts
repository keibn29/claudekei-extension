#!/usr/bin/env bun
/**
 * Real-CLI probe of "revert to here" with a SUBAGENT (docs/REVERT_SPEC.md sections 0, 0c, 0d).
 *
 * Purpose: drives the real ClaudeSessionManager / ClaudeSession (real SDK, real `claude` binary, real FileHistory,
 * subagentCut and pluginStateCleanup) in a throwaway git repository and checks that a revert undoes what a subagent
 * did (Write, Edit, Bash sed -i, heredoc, mkdir -p), that /redo brings it back, and that committing the revert rolls
 * the subagent transcripts (and the claudekei plugin's alias state, when the plugin is loaded) back too.
 *
 * Run (manual, NOT part of `bun test`):
 *   bun scripts/probe-revert.ts
 *   PROBE_MODEL=haiku bun scripts/probe-revert.ts        # cheaper main model, may not call the Agent tool reliably
 *   PROBE_KEEP=1 bun scripts/probe-revert.ts             # keep the temp repo and the Claude session for inspection
 *
 * COST: it makes real model calls with your Claude login (5 short turns + one subagent run on haiku, main agent on
 * `sonnet` with low effort by default). Expect roughly 0.05-0.30 USD / a few percent of a subscription window; the
 * script prints the total from the result messages at the end. It needs `git` and network access.
 *
 * Flow: turn 1 "OK" (target boundary) -> turn 2 main agent launches a haiku subagent that edits files -> turn 3 main
 * agent continues the same subagent with SendMessage (skipped with a note if the tool is not available) ->
 * preview/revert to turn 2 -> unrevert -> revert again -> turn 4 commits the revert -> subagent transcripts and plugin
 * aliases are checked. The Claude session, its transcripts and the temp repo are deleted at the end (PROBE_KEEP=1 keeps them).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeEvent } from '@openchamber/ui/src/lib/claude/protocol';
import type { Part, PermissionMode } from '@openchamber/ui/src/lib/claude/types';
import { Broadcaster } from '../src/claude/broadcaster';
import { ClaudeSessionManager, DEFAULT_MANAGER_CONFIG } from '../src/claude/ClaudeSessionManager';
import { loadSdkRuntime, type ClaudeQuery, type QueryFactory, type SdkRuntime } from '../src/claude/sdk';
import { transcriptPaths } from '../src/claude/subagentCut';

const MAIN_MODEL = process.env.PROBE_MODEL ?? 'sonnet';
const KEEP = process.env.PROBE_KEEP === '1';
const IS_MAC = process.platform === 'darwin';

type Row = { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail?: string };
const rows: Row[] = [];
const record = (status: Row['status'], name: string, detail?: string): boolean => {
  rows.push({ name, status, detail });
  console.log(`${status}  ${name}${detail ? `  (${detail})` : ''}`);
  return status !== 'FAIL';
};
const check = (name: string, ok: boolean, detail?: string): boolean => record(ok ? 'PASS' : 'FAIL', name, ok ? undefined : detail);
const skip = (name: string, why: string): void => void record('SKIP', name, why);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 180_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${what}`);
    await sleep(100);
  }
}

// --- temp repository ----------------------------------------------------------------------------------------------
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'probe@example.com', GIT_COMMITTER_NAME: 'probe', GIT_COMMITTER_EMAIL: 'probe@example.com' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
};
if (spawnSync('git', ['--version']).status !== 0) {
  console.error('git is required');
  process.exit(2);
}
const base = realpathSync(mkdtempSync(join(tmpdir(), 'claudekei-probe-')));
const CWD = join(base, 'repo');
const STORAGE = join(base, 'storage');
mkdirSync(CWD, { recursive: true });
git(CWD, 'init', '--quiet');
const SEED = { 'README.md': '# Probe\nline\n', 'notes.txt': 'alpha\nbeta\ngamma\n', 'keep.txt': 'untouched\n' };
for (const [name, body] of Object.entries(SEED)) writeFileSync(join(CWD, name), body);
git(CWD, 'add', '.');
git(CWD, 'commit', '--quiet', '-m', 'seed');
const read = (name: string) => readFileSync(join(CWD, name), 'utf8');
const exists = (name: string) => existsSync(join(CWD, name));

// --- manager wiring (real SDK; the query factory is tapped to total the cost) ---------------------------------------
const events: ClaudeEvent[] = [];
const broadcaster = new Broadcaster({ batchMs: 5 });
broadcaster.register({ post: (push) => void events.push(...push.events) });
const cost = { usd: 0, turns: 0, input: 0, output: 0, results: 0 };
const tap = (real: QueryFactory): QueryFactory => (params) => {
  const query = real(params);
  const proxy: ClaudeQuery = new Proxy(query, {
    get(target, prop) {
      if (prop === 'next') {
        return async (...args: []) => {
          const r = await target.next(...args);
          const m = r.value as { type?: string; total_cost_usd?: number; num_turns?: number; usage?: { input_tokens?: number; output_tokens?: number } } | undefined;
          if (!r.done && m?.type === 'result') {
            cost.results++;
            cost.usd += m.total_cost_usd ?? 0;
            cost.turns += m.num_turns ?? 0;
            cost.input += m.usage?.input_tokens ?? 0;
            cost.output += m.usage?.output_tokens ?? 0;
          }
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
const runtime = async (): Promise<SdkRuntime> => {
  const real = await loadSdkRuntime();
  return { ...real, queryFactory: tap(real.queryFactory) };
};
const hostLogs: string[] = [];
const kv = new Map<string, unknown>();
const config = { ...DEFAULT_MANAGER_CONFIG, idleTimeoutMinutes: 0, defaultPermissionMode: 'bypassPermissions' as PermissionMode };
const manager = new ClaudeSessionManager({
  cwd: CWD,
  storageDir: STORAGE,
  store: { get: ((k: string, d?: unknown) => (kv.has(k) ? kv.get(k) : d)) as never, update: async (k, v) => void kv.set(k, v) },
  broadcaster,
  getConfig: () => config,
  runtime,
  clientApp: 'claudekei-probe/0',
  log: (level, message, data) => {
    if (level === 'warn' || level === 'error') {
      const line = `[host ${level}] ${message}${data ? ` ${data instanceof Error ? data.message : JSON.stringify(data).slice(0, 300)}` : ''}`;
      hostLogs.push(line);
      console.log(`  ${line}`);
    }
  },
  stderr: (d) => {
    if (/error|fail/i.test(d)) console.log(`  [claude stderr] ${d.trim().slice(0, 300)}`);
  },
});
setInterval(() => broadcaster.flush(), 20).unref();

/** Sends one prompt and waits until the main session reports idle after it. */
async function turn(sessionId: string, text: string): Promise<void> {
  const mark = events.length;
  await manager.send(sessionId, { text, model: MAIN_MODEL, effort: 'low', mode: 'bypassPermissions' });
  await waitFor(`idle after "${text.slice(0, 30)}"`, () => events.slice(mark).some((e) => e.type === 'session.status' && e.properties.sessionID === sessionId && e.properties.status.type === 'idle'));
  await sleep(300); // let the idle-triggered checkpoint close
}
const toolParts = async (sessionId: string): Promise<Array<{ session: string; tool: string; status: string }>> => {
  const snap = await manager.load(sessionId);
  const out: Array<{ session: string; tool: string; status: string }> = [];
  const add = (sid: string, parts: Part[]) => parts.filter((p) => p.type === 'tool').forEach((p) => out.push({ session: sid, tool: (p as { tool: string }).tool, status: (p as { state: { status: string } }).state.status }));
  add(sessionId, Object.values(snap.parts).flat() as Part[]);
  for (const child of snap.children) add(child.id, Object.values((await manager.load(child.id)).parts).flat() as Part[]);
  return out;
};
const listDir = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir) : []);

// --- the probe ------------------------------------------------------------------------------------------------------
const sed = IS_MAC ? "sed -i '' 's/beta/BETA/' notes.txt" : "sed -i 's/beta/BETA/' notes.txt";
const TURN2 =
  'Use the Agent tool exactly once: subagent_type "general-purpose", model "haiku", and wait for it to finish. ' +
  'Give the subagent this complete job (it must do all steps itself, with its own tools, in the current directory, and nothing else): ' +
  '1) use the Write tool to create a.txt containing the single line "alpha". ' +
  '2) use the Edit tool on README.md to replace the text "line" with "edited line". ' +
  `3) run this Bash command: ${sed}. ` +
  '4) run this Bash command to create b.txt with a heredoc: cat > b.txt <<\'EOF\'\nheredoc body\nEOF\n. ' +
  '5) run this Bash command: mkdir -p nested/dir && echo x > nested/dir/c.txt. ' +
  'When the subagent is done, reply only with: done.';
const TURN3 =
  'Continue the SAME subagent you launched in your previous turn with the SendMessage tool (to = its agentId or alias; if SendMessage is not loaded, ' +
  'load it first with ToolSearch query "select:SendMessage"). Do not launch a new Agent. Ask it to append the line "more" to a.txt with Bash: echo more >> a.txt. Then reply only with: done.';

let sessionId = '';
let failure: string | undefined;
try {
  const boot = await manager.bootstrap();
  check('manager connects (logged in)', manager.getStatus().status === 'connected', JSON.stringify(manager.getStatus()));
  if (manager.getStatus().status !== 'connected') throw new Error('not connected: run `claude login` first');
  void boot;

  const session = manager.create();
  sessionId = session.id;
  const paths = transcriptPaths({ cwd: CWD, sessionId });
  const checkpointLog = join(STORAGE, 'checkpoints', `${sessionId}.json`);
  const stateFiles = (): string[] => {
    const data = join(homedir(), '.claude', 'plugins', 'data');
    return listDir(data).filter((d) => /claudekei/i.test(d)).map((d) => join(data, d, 'sessions', `${sessionId}.json`)).filter((f) => existsSync(f));
  };

  // 1. target boundary ------------------------------------------------------------------------------------------------
  await turn(sessionId, 'Reply with exactly: OK');
  const userIds = async () => (await manager.load(sessionId)).messages.filter((m) => m.role === 'user').map((m) => m.id);
  check('turn 1 produced a user message', (await userIds()).length === 1);

  // 2. subagent edits ---------------------------------------------------------------------------------------------------
  await turn(sessionId, TURN2);
  const afterTurn2 = await toolParts(sessionId);
  const usedAgent = afterTurn2.some((t) => t.session === sessionId && t.tool === 'task');
  const subEdits = afterTurn2.filter((t) => t.session !== sessionId);
  check('turn 2: the main agent called the Agent tool', usedAgent, `tools: ${afterTurn2.map((t) => `${t.session === sessionId ? 'main' : 'sub'}:${t.tool}`).join(', ')}`);
  check('turn 2: the subagent ran tools of its own', subEdits.length > 0, `${subEdits.length} subagent tool calls`);
  const edited = read('README.md') === '# Probe\nedited line\n' && /BETA/.test(read('notes.txt')) && exists('a.txt') && exists('b.txt') && exists('nested/dir/c.txt');
  if (!check('precondition: the subagent edited README.md and notes.txt and created a.txt, b.txt, nested/dir/c.txt', edited, `README=${JSON.stringify(read('README.md'))} notes=${JSON.stringify(read('notes.txt'))} a=${exists('a.txt')} b=${exists('b.txt')} c=${exists('nested/dir/c.txt')}`)) {
    throw new Error('the subagent did not perform the edits; the model did not follow the prompt (try PROBE_MODEL=sonnet)');
  }
  const agentFiles = () => listDir(paths.subagents).filter((f) => /^agent-.+\.jsonl$/.test(f));
  check('precondition: a subagent transcript exists on disk', agentFiles().length >= 1, paths.subagents);
  const agentIds = agentFiles().map((f) => f.replace(/^agent-|\.jsonl$/g, ''));
  const pluginBefore = stateFiles().map((f) => ({ f, ids: ((JSON.parse(readFileSync(f, 'utf8')).children ?? []) as Array<{ agentId: string }>).map((c) => c.agentId) }));
  const pluginActive = pluginBefore.some((p) => p.ids.some((id) => agentIds.includes(id)));

  // 3. follow-up through SendMessage ----------------------------------------------------------------------------
  await turn(sessionId, TURN3);
  const afterTurn3 = await toolParts(sessionId);
  const sentMessage = afterTurn3.some((t) => t.session === sessionId && t.tool === 'sendmessage');
  if (sentMessage) {
    check('turn 3: SendMessage continued the subagent and appended to a.txt', /more/.test(exists('a.txt') ? read('a.txt') : ''), JSON.stringify(exists('a.txt') ? read('a.txt') : null));
  } else {
    skip('turn 3: SendMessage continuation', 'the main agent did not call SendMessage (tool unavailable in this SDK build or model skipped it); the continuation is not covered');
  }
  const checkpoints = (JSON.parse(readFileSync(checkpointLog, 'utf8')) as { checkpoints: unknown[] }).checkpoints.length;
  check('a checkpoint was recorded for every turn so far', checkpoints >= 3, `${checkpoints} checkpoints`);

  // 4. preview + revert to turn 2 -----------------------------------------------------------------------------------
  const target = (await userIds())[1]!;
  const preview = await manager.revertPreview(sessionId, target);
  const want = ['a.txt', 'b.txt', 'nested/dir/c.txt', 'README.md', 'notes.txt'];
  const got = preview.files.map((f) => f.replace(/\\/g, '/'));
  check('preview lists every file the subagent touched (relative paths)', want.every((f) => got.includes(f)), `got: ${got.join(', ')}`);
  check('preview does not list untouched files', !got.includes('keep.txt'), got.join(', '));
  check('preview counts insertions and deletions', preview.insertions > 0 && preview.deletions > 0, `+${preview.insertions} -${preview.deletions}`);
  check('preview has no warnings', preview.filesError === undefined, preview.filesError);

  const reverted = await manager.revert(sessionId, target);
  check('revert reports no filesError', reverted.filesError === undefined, reverted.filesError);
  check('revert: README.md and notes.txt are back to the committed content', read('README.md') === SEED['README.md'] && read('notes.txt') === SEED['notes.txt'], `README=${JSON.stringify(read('README.md'))} notes=${JSON.stringify(read('notes.txt'))}`);
  check('revert: a.txt, b.txt and nested/ (including the emptied directories) are gone', !exists('a.txt') && !exists('b.txt') && !exists('nested'), `a=${exists('a.txt')} b=${exists('b.txt')} nested=${exists('nested')}`);
  check('revert: untouched files stay untouched', read('keep.txt') === SEED['keep.txt']);
  check('revert: git status of the user repository is clean again', git(CWD, 'status', '--porcelain').trim() === '', git(CWD, 'status', '--porcelain').trim());
  check('revert leaves the subagent transcript alone (so /redo works)', agentFiles().length === agentIds.length);

  // 5. /redo, then revert again ----------------------------------------------------------------------------------------
  await manager.unrevert(sessionId);
  check('unrevert (/redo) brings the subagent edits back', read('README.md') === '# Probe\nedited line\n' && /BETA/.test(read('notes.txt')) && exists('a.txt') && exists('b.txt') && exists('nested/dir/c.txt'), `a=${exists('a.txt')} b=${exists('b.txt')} c=${exists('nested/dir/c.txt')}`);
  const again = await manager.revert(sessionId, target);
  check('revert again after /redo restores the files again', again.filesError === undefined && !exists('a.txt') && !exists('nested') && read('README.md') === SEED['README.md']);

  // 6. commit with turn 4 -----------------------------------------------------------------------------------------------
  const mainBefore = existsSync(paths.main) ? readFileSync(paths.main, 'utf8').split('\n').filter(Boolean).length : 0;
  await turn(sessionId, 'Reply with exactly: OK');
  const snap = await manager.load(sessionId);
  const users = snap.messages.filter((m) => m.role === 'user').length;
  check('commit: the conversation was cut (turn 1 and the new prompt remain)', users === 2, `${users} user messages`);
  check('commit: the session is no longer marked as reverted', snap.session.revert === undefined);
  check('commit: the child sessions of the reverted turns are gone from the host state', snap.children.length === 0, snap.children.map((c) => c.id).join(', '));
  check('commit: files are still in the restored state', !exists('a.txt') && !exists('nested') && read('README.md') === SEED['README.md']);
  const remaining = agentFiles();
  check('commit: the subagent transcripts of the reverted turns were deleted', remaining.length === 0, remaining.join(', '));
  check('commit: their .meta.json files were deleted too', listDir(paths.subagents).filter((f) => f.endsWith('.meta.json')).length === 0, listDir(paths.subagents).join(', '));
  check('commit: the main transcript still has turn 1 and the new branch', existsSync(paths.main) && mainBefore > 0);
  if (pluginActive) {
    const after = stateFiles().flatMap((f) => ((JSON.parse(readFileSync(f, 'utf8')).children ?? []) as Array<{ agentId: string }>).map((c) => c.agentId));
    check('commit: the plugin alias state no longer lists the reverted subagent', agentIds.every((id) => !after.includes(id)), `still listed: ${agentIds.filter((id) => after.includes(id)).join(', ')}`);
  } else {
    skip('commit: plugin alias state cleanup', 'no claudekei plugin state file with this session\'s subagent (plugin not loaded for this run)');
  }
  const cutWarnings = hostLogs.filter((l) => /subagent|plugin alias|checkpoint|snapshot/i.test(l));
  check('no snapshot / subagent-cut warnings were logged by the host', cutWarnings.length === 0, cutWarnings.join(' | '));
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  console.log(`\nABORTED: ${failure}`);
} finally {
  try {
    if (sessionId && !KEEP) await manager.delete(sessionId);
  } catch (error) {
    console.log(`cleanup: could not delete the Claude session: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!KEEP) {
    rmSync(join(homedir(), '.claude', 'projects', CWD.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  } else {
    console.log(`\nkept: repo ${CWD}, storage ${STORAGE}, session ${sessionId}`);
  }
}

const failed = rows.filter((r) => r.status === 'FAIL');
console.log('\n================ summary ================');
for (const r of rows) console.log(`${r.status.padEnd(4)}  ${r.name}${r.detail && r.status !== 'PASS' ? `\n        ${r.detail}` : ''}`);
console.log(`\n${rows.filter((r) => r.status === 'PASS').length} passed, ${failed.length} failed, ${rows.filter((r) => r.status === 'SKIP').length} skipped${failure ? ' (aborted early)' : ''}`);
console.log(`usage: ${cost.results} result messages, ${cost.turns} model turns, ${cost.input} input / ${cost.output} output tokens, total cost ${cost.usd.toFixed(4)} USD (as reported by the CLI; subscription runs are not billed per token)`);
process.exit(failed.length > 0 || failure ? 1 : 0);
