/**
 * Extension-side cleanup of the claudekei plugin's per-session alias state
 * (`~/.claude/plugins/data/<plugin dir>/sessions/<session id>.json`) after subagent transcripts were rolled back by a
 * revert. The plugin is not modified: this follows its protocol (claudekei-plugin hooks/lib/store.mjs) exactly: a
 * `<file>.lock` directory made with mkdir (stale after 5 s, 3 s wait), the state read under the lock and written to a
 * tmp file that is renamed over the original. Anything unexpected (no file, other schema, lock not acquired) skips
 * the file and logs: the state is never touched without the lock and never rewritten when unrecognised.
 */
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOCK_STALE_MS = 5_000;
const LOCK_TIMEOUT_MS = 3_000;

type Logger = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;

export type PluginStateCleanup = {
  home?: string;
  sessionId: string;
  /** Subagents whose transcript was deleted: their aliases are dropped. */
  removedAgentIds: string[];
  /** Subagents whose transcript was trimmed: they stay resumable but forget what they "read" in the reverted turns. */
  trimmedAgentIds: string[];
  /**
   * `<project>/<sid>/subagents`. When given, every child whose `agent-<agentId>.jsonl` is not in that directory is
   * dropped as well (reconciled under the lock, so a cleanup interrupted after the files were deleted is completed by
   * the retry). Only when the listing succeeds: a directory that cannot be listed removes nothing.
   */
  subagentsDir?: string;
  log: Logger;
  /** Tests. */
  lockTimeoutMs?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '_');

async function acquireLock(lock: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fsp.mkdir(lock);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const st = await fsp.stat(lock).catch(() => undefined);
      if (!st) continue;
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await fsp.rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) return false;
      await sleep(15);
    }
  }
}

/** Applies the cleanup to every claudekei plugin data directory holding a state file for the session. */
export async function cleanPluginState(o: PluginStateCleanup): Promise<void> {
  if (o.removedAgentIds.length === 0 && o.trimmedAgentIds.length === 0 && !o.subagentsDir) return;
  const base = join(o.home ?? homedir(), '.claude', 'plugins', 'data');
  const dirs = (await fsp.readdir(base).catch(() => [] as string[])).filter((d) => /claudekei/i.test(d));
  const removed = new Set(o.removedAgentIds);
  const trimmed = new Set(o.trimmedAgentIds);
  for (const dir of dirs) {
    const file = join(base, dir, 'sessions', `${safeId(o.sessionId)}.json`);
    if (!(await fsp.stat(file).then(() => true, () => false))) continue; // never create lock dirs for sessions the plugin does not know
    const lock = `${file}.lock`;
    try {
      if (!(await acquireLock(lock, o.lockTimeoutMs ?? LOCK_TIMEOUT_MS))) {
        o.log('warn', 'plugin alias state is locked; not cleaned', { file });
        continue;
      }
      try {
        let state: { version?: unknown; children?: unknown };
        try {
          state = JSON.parse(await fsp.readFile(file, 'utf8'));
        } catch {
          o.log('warn', 'plugin alias state is unreadable; not cleaned', { file });
          continue;
        }
        if (state?.version !== 1 || !Array.isArray(state.children)) {
          o.log('warn', 'plugin alias state has an unknown schema; not cleaned', { file });
          continue;
        }
        let present: Set<string> | undefined;
        if (o.subagentsDir) {
          try {
            present = new Set((await fsp.readdir(o.subagentsDir)).map((n) => /^agent-(.+)\.jsonl$/.exec(n)?.[1]).filter((id): id is string => !!id));
          } catch (error) {
            // No subagents directory (the session never ran one) is normal; anything else is worth a warning.
            o.log((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'debug' : 'warn', 'subagents directory unreadable; alias reconcile skipped', { dir: o.subagentsDir });
          }
        }
        let changed = false;
        const children: unknown[] = [];
        for (const child of state.children as Array<Record<string, unknown>>) {
          const agentId = typeof child?.agentId === 'string' ? child.agentId : undefined;
          if (agentId && (removed.has(agentId) || (present && !present.has(agentId)))) {
            changed = true;
            continue;
          }
          if (agentId && trimmed.has(agentId)) {
            // The reverted continuation is gone: no process runs it any more and its file reads are unknown.
            child.reads = [];
            child.status = 'idle';
            if (typeof child.createdAt === 'number') child.lastUsedAt = child.createdAt;
            changed = true;
          }
          children.push(child);
        }
        if (!changed) continue;
        state.children = children;
        const tmp = `${file}.${process.pid}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(state));
        await fsp.rename(tmp, file);
      } finally {
        await fsp.rm(lock, { recursive: true, force: true });
      }
    } catch (error) {
      o.log('warn', 'could not clean the plugin alias state', { file, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
