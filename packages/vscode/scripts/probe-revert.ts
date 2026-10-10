#!/usr/bin/env bun
/**
 * Spike for docs/REVERT_SPEC.md section 0 (S1-S4). Real Claude Haiku, throwaway sandbox (never the repo).
 *   bun scripts/probe-revert.ts            # writes src/claude/__fixtures__/revert-spike.json and prints a summary
 *
 * S1: a fresh `resume` process without any prompt can `rewindFiles(<uuid from an earlier process>, {dryRun:true})`.
 * S2: `resume` + `resumeSessionAt` (no fork) + a new prompt keeps the session id and branches the transcript.
 * S3: after S2, `rewindFiles` still works for a kept earlier message (dry run, then real).
 * S4: `deleteSession(id)`, then a spawn with `sessionId: id` starts a clean session under the same id.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { deleteSession, getSessionMessages, query, type Options, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { AsyncQueue, buildEnv, FIXTURES_DIR, redactEmails, SANDBOX_DIR, seedSandbox } from './_common';

const out: Record<string, unknown> = {};
const log = (...a: unknown[]) => console.log(...a);
const projectDir = join(homedir(), '.claude', 'projects', SANDBOX_DIR.replace(/[^a-zA-Z0-9]/g, '-'));

class Proc {
  readonly queue = new AsyncQueue<SDKUserMessage>();
  readonly q: Query;
  readonly messages: SDKMessage[] = [];
  initSessionId: string | undefined;
  private waiters: Array<() => void> = [];
  private pump: Promise<void>;

  constructor(options: Options) {
    this.q = query({
      prompt: this.queue,
      options: {
        cwd: SANDBOX_DIR,
        model: 'haiku',
        permissionMode: 'acceptEdits',
        settingSources: ['project'],
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        enableFileCheckpointing: true,
        env: buildEnv(),
        ...options,
      },
    });
    this.pump = (async () => {
      try {
        for await (const m of this.q) {
          this.messages.push(m);
          if (m.type === 'system' && m.subtype === 'init') this.initSessionId = m.session_id;
          if (m.type === 'result') this.waiters.splice(0).forEach((w) => w());
        }
      } catch (e) {
        log('  pump ended:', (e as Error).message);
      }
      this.waiters.splice(0).forEach((w) => w());
    })();
  }

  /** Sends one prompt with a known uuid and waits for its result. */
  async turn(text: string): Promise<string> {
    const uuid = randomUUID();
    const done = new Promise<void>((r) => this.waiters.push(r));
    this.queue.push({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, uuid } as SDKUserMessage);
    await done;
    return uuid;
  }

  async close(): Promise<void> {
    this.queue.end();
    this.q.close();
    await this.pump;
  }
}

const history = async (id: string) => (await getSessionMessages(id, { dir: SANDBOX_DIR, includeSystemMessages: true })) as Array<{ type: string; uuid: string; parent_tool_use_id?: string | null; message?: any }>;
const brief = (entries: Awaited<ReturnType<typeof history>>) =>
  entries.map((e) => `${e.type}:${e.uuid.slice(0, 8)}:${JSON.stringify(typeof e.message?.content === 'string' ? e.message.content : (e.message?.content ?? []).map((b: any) => b.text ?? b.name ?? b.type)).slice(0, 70)}`);
const read = (rel: string) => (existsSync(join(SANDBOX_DIR, rel)) ? readFileSync(join(SANDBOX_DIR, rel), 'utf8') : null);
const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label}: timeout after ${ms}ms`)), ms))]);

seedSandbox();
const A = randomUUID();
log('session', A);

// --- Process 1: three turns (a created file, an edit, another created file) --------------------------------------
const p1 = new Proc({ sessionId: A });
const u1 = await p1.turn('Use the Write tool to create docs/one.txt with the content "one". Reply "done" only.');
const u2 = await p1.turn('Use the Edit tool in src/app.ts to change "Hello, " to "Hi, ". Reply "done" only.');
const u3 = await p1.turn('Use the Write tool to create docs/three.txt with the content "three". Reply "done" only.');
await p1.close();
const h1 = await history(A);
log('history after 3 turns:', brief(h1));
out.userUuids = { u1, u2, u3 };
// Cut uuid = the last chain entry before the u3 user message.
const idx3 = h1.findIndex((e) => e.uuid === u3);
const cut = h1[idx3 - 1]!.uuid;
out.cutBeforeU3 = { uuid: cut, type: h1[idx3 - 1]!.type };
out.filesAfterP1 = { 'docs/one.txt': read('docs/one.txt'), 'docs/three.txt': read('docs/three.txt'), appHasHi: read('src/app.ts')!.includes('Hi, ') };

// --- S1 -----------------------------------------------------------------------------------------------------
const p2 = new Proc({ resume: A });
let s1: Record<string, unknown>;
try {
  const init = await withTimeout(p2.q.initializationResult(), 60000, 'initializationResult');
  void init;
  const dryU2 = await withTimeout(p2.q.rewindFiles(u2, { dryRun: true }), 60000, 'rewindFiles(u2, dry)');
  const dryU3 = await withTimeout(p2.q.rewindFiles(u3, { dryRun: true }), 60000, 'rewindFiles(u3, dry)');
  const dryU1 = await withTimeout(p2.q.rewindFiles(u1, { dryRun: true }), 60000, 'rewindFiles(u1, dry)');
  s1 = { pass: dryU2.canRewind === true, dryU1, dryU2, dryU3, initSessionIdSeen: p2.initSessionId ?? null, filesUntouchedByDryRun: { 'docs/three.txt': read('docs/three.txt'), appHasHi: read('src/app.ts')!.includes('Hi, ') } };
} catch (e) {
  s1 = { pass: false, error: (e as Error).message };
}
await p2.close();
out.S1 = s1;
log('S1', JSON.stringify(s1));

// --- S2: resume + resumeSessionAt, no fork, new prompt ----------------------------------------------------------
const p3 = new Proc({ resume: A, resumeSessionAt: cut });
const u4 = await p3.turn('Reply with exactly: branch');
const h2 = await history(A);
log('history after S2:', brief(h2));
const jsonl = readFileSync(join(projectDir, `${A}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const u4Entry = jsonl.find((e) => e.uuid === u4);
const u3Entry = jsonl.find((e) => e.uuid === u3);
const s2 = {
  pass: p3.initSessionId === A && u4Entry?.parentUuid === cut && !h2.some((e) => e.uuid === u3) && h2.some((e) => e.uuid === u4) && h2.some((e) => e.uuid === u2),
  initSessionId: p3.initSessionId,
  sameId: p3.initSessionId === A,
  u4ParentUuidIsCut: u4Entry?.parentUuid === cut,
  u4ParentUuid: u4Entry?.parentUuid,
  u3StillInJsonl: Boolean(u3Entry),
  historyKeepsU1U2: h2.some((e) => e.uuid === u1) && h2.some((e) => e.uuid === u2),
  historyHasU3: h2.some((e) => e.uuid === u3),
  historyHasU4: h2.some((e) => e.uuid === u4),
  historyUserTexts: h2.filter((e) => e.type === 'user').map((e) => (typeof e.message?.content === 'string' ? e.message.content : (e.message?.content ?? []).map((b: any) => b.text).join('')).slice(0, 60)),
  fileSizeEntries: jsonl.length,
};
out.S2 = s2;
log('S2', JSON.stringify(s2));

// --- S3: rewind still works for a kept message (same process, then a fresh one) --------------------------------------
let s3: Record<string, unknown>;
try {
  const dryLive = await withTimeout(p3.q.rewindFiles(u2, { dryRun: true }), 60000, 'S3 live dry run');
  await p3.close();
  const p4 = new Proc({ resume: A });
  await withTimeout(p4.q.initializationResult(), 60000, 'init p4');
  const dryCold = await withTimeout(p4.q.rewindFiles(u2, { dryRun: true }), 60000, 'S3 cold dry run');
  const dryDeadBranch = await withTimeout(p4.q.rewindFiles(u3, { dryRun: true }), 60000, 'S3 dead-branch dry run').catch((e: Error) => ({ error: e.message }));
  const real = await withTimeout(p4.q.rewindFiles(u2), 60000, 'S3 real rewind');
  s3 = {
    pass: dryLive.canRewind === true && dryCold.canRewind === true,
    dryLive,
    dryCold,
    dryDeadBranch,
    real,
    afterReal: { 'docs/one.txt': read('docs/one.txt'), 'docs/three.txt': read('docs/three.txt'), appHasHi: read('src/app.ts')!.includes('Hi, '), appHasHello: read('src/app.ts')!.includes('Hello, ') },
  };
  await p4.close();
} catch (e) {
  s3 = { pass: false, error: (e as Error).message };
  await p3.close().catch(() => undefined);
}
out.S3 = s3;
log('S3', JSON.stringify(s3));

// --- S4: deleteSession, then spawn with sessionId: <same id> -----------------------------------------------------
let s4: Record<string, unknown>;
try {
  await deleteSession(A, { dir: SANDBOX_DIR });
  const existsAfterDelete = existsSync(join(projectDir, `${A}.jsonl`));
  const p5 = new Proc({ sessionId: A });
  const u5 = await p5.turn('Use the Write tool to create docs/five.txt with the content "five". Reply "done" only.');
  const dry = await withTimeout(p5.q.rewindFiles(u5, { dryRun: true }), 60000, 'S4 dry run').catch((e: Error) => ({ error: e.message }));
  const dryOld = await withTimeout(p5.q.rewindFiles(u2, { dryRun: true }), 60000, 'S4 dry run of an old uuid').catch((e: Error) => ({ error: e.message }));
  await p5.close();
  const h5 = await history(A);
  s4 = {
    pass: p5.initSessionId === A && !h5.some((e) => e.uuid === u1) && h5.some((e) => e.uuid === u5),
    existsAfterDelete,
    initSessionId: p5.initSessionId,
    historyAfter: brief(h5),
    dryNewMessage: dry,
    dryOldUuidFromDeletedTranscript: dryOld,
  };
} catch (e) {
  s4 = { pass: false, error: (e as Error).message };
}
out.S4 = s4;
log('S4', JSON.stringify(s4));

writeFileSync(join(FIXTURES_DIR, 'revert-spike.json'), redactEmails(JSON.stringify(out, null, 2)) + '\n');
log('\nSUMMARY', { S1: (out.S1 as any).pass, S2: (out.S2 as any).pass, S3: (out.S3 as any).pass, S4: (out.S4 as any).pass });
process.exit(0);
