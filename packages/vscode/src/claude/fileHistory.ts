/** Per-session checkpoint log on top of the private git snapshot store (see snapshot.ts). */
import { promises as fsp } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { RevertPreview } from '@openchamber/ui/src/lib/claude/types';
import { openSnapshot, type GitSnapshot } from './snapshot';

type Checkpoint = { uuid: string; tree: string; files?: string[] };
/** `protected`: files the pending revert deliberately left alone (see `revert`); /redo must leave them alone too. */
type Log = { version: 1; worktree: string; checkpoints: Checkpoint[]; protected?: string[] };
type Logger = (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** An unavailable store (no git, not a repo) is probed again after this long; `begin` is called on every send. */
const RETRY_MS = 60 * 1000;
const OFF = 'file snapshots are turned off (claudekei.fileSnapshots)';
const NO_CHECKPOINT = 'no file snapshot was taken when this message was sent';
const EXPIRED = 'the file snapshots for this message have expired';

/** file -> tree holding its pre-image. The earliest checkpoint that covers a file wins. */
export function planRevert(cps: Checkpoint[], openFiles: string[]): Map<string, string> {
  const plan = new Map<string, string>();
  for (const cp of cps) for (const f of cp.files ?? openFiles) if (!plan.has(f)) plan.set(f, cp.tree);
  return plan;
}

export class FileHistory {
  private snap: GitSnapshot | undefined;
  private opening: Promise<GitSnapshot | { unavailable: string }> | undefined;
  private unavailable: { reason: string; at: number } | undefined;
  /** The worktree in the form the cwd was given (the snapshot reports a realpath), so paths line up with the cwd. */
  private top: string | undefined;
  private readonly logs = new Map<string, Log>();
  private readonly chains = new Map<string, Promise<unknown>>();
  /** uuid of the checkpoint a process of this host opened and has not closed yet, per session. */
  private readonly openUuid = new Map<string, string>();
  /** Sessions with a `reopen` queued: an `end()` issued meanwhile is chained behind it instead of being dropped. */
  private readonly reopening = new Set<string>();

  constructor(private readonly o: { storageDir: string; cwd: string; gitPath?: string; env: () => Promise<Record<string, string | undefined>>; enabled: () => boolean; log: Logger }) {}

  private dir = () => join(this.o.storageDir, 'checkpoints');
  private file = (sid: string) => join(this.dir(), `${sid}.json`);

  /** `fresh`: probe again even if a recent probe failed (explicit user actions, warm-up). */
  private async snapshot(fresh = false): Promise<GitSnapshot | { unavailable: string }> {
    if (!this.o.enabled()) return { unavailable: OFF };
    if (this.snap) return this.snap;
    if (!fresh && this.unavailable && Date.now() - this.unavailable.at < RETRY_MS) return { unavailable: this.unavailable.reason };
    this.opening ??= (async () => {
      try {
        const r = await openSnapshot({ cwd: this.o.cwd, root: join(this.o.storageDir, 'snapshot'), gitPath: this.o.gitPath ?? 'git', env: await this.o.env(), log: this.o.log });
        if ('unavailable' in r) {
          this.unavailable = { reason: r.unavailable, at: Date.now() };
          this.o.log('info', 'file snapshots unavailable', { reason: r.unavailable });
          return r;
        }
        this.snap = r;
        this.unavailable = undefined;
        return r;
      } catch (e) {
        // e.g. the environment could not be resolved: not remembered, the next call tries again.
        return { unavailable: `file snapshots could not be opened: ${(e as Error).message}` };
      } finally {
        this.opening = undefined;
      }
    })();
    return this.opening;
  }

  private chain<T>(sid: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(sid) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => undefined);
    this.chains.set(sid, tail);
    void tail.then(() => this.chains.get(sid) === tail && this.chains.delete(sid));
    return run;
  }

  private async load(sid: string, snap: GitSnapshot): Promise<Log> {
    const cached = this.logs.get(sid);
    if (cached) return cached;
    let log: Log = { version: 1, worktree: snap.worktree, checkpoints: [] };
    try {
      const parsed = JSON.parse(await fsp.readFile(this.file(sid), 'utf8')) as Log;
      if (parsed?.version === 1 && Array.isArray(parsed.checkpoints)) {
        // Trees of another repository are meaningless here.
        if (!parsed.worktree || parsed.worktree === snap.worktree) log = parsed;
        else this.o.log('warn', 'checkpoint log belongs to another worktree; ignored', { sid, was: parsed.worktree, now: snap.worktree });
      }
    } catch {
      /* missing or corrupt: start empty */
    }
    this.logs.set(sid, log);
    return log;
  }

  private async save(sid: string, log: Log, snap: GitSnapshot): Promise<void> {
    log.worktree = snap.worktree;
    await fsp.mkdir(this.dir(), { recursive: true });
    const tmp = `${this.file(sid)}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(log));
    await fsp.rename(tmp, this.file(sid));
  }

  /** Files changed between two trees; an unreadable (pruned) tree counts as "nothing known" instead of failing. */
  private async changed(snap: GitSnapshot, from: string, to: string): Promise<string[]> {
    try {
      return await snap.changedFiles(from, to);
    } catch (e) {
      this.o.log('warn', 'could not diff file snapshots; checkpoint treated as empty', { error: (e as Error).message });
      return [];
    }
  }

  private topOf(snap: GitSnapshot): string {
    if (!this.top) {
      // cwd may be a symlinked form of the realpath'd worktree: keep the cwd's form of the toplevel.
      const real = relative(snap.worktree, snap.cwdReal);
      const up = real === '' ? [] : real.split(sep).map(() => '..');
      this.top = resolve(this.o.cwd, ...up);
    }
    return this.top;
  }

  private abs(snap: GitSnapshot, rel: string): string {
    return join(this.topOf(snap), ...rel.split('/'));
  }

  /**
   * Of these absolute paths (files edited by tool calls in turns that are being reverted), the ones a revert cannot
   * restore: outside the repository, Git-ignored, over the size limit or inside a nested repository. Empty when the
   * store is unavailable (the caller already reports that).
   */
  async audit(paths: string[]): Promise<string[]> {
    try {
      const snap = await this.snapshot();
      if ('unavailable' in snap) return [];
      const top = this.topOf(snap);
      const bad: string[] = [];
      const inside: Array<{ path: string; rel: string }> = [];
      for (const path of new Set(paths.map((p) => resolve(this.o.cwd, p)))) {
        const rel = [relative(top, path), relative(snap.worktree, path)].find((r) => r !== '' && !r.startsWith('..') && !isAbsolute(r));
        if (rel === undefined) bad.push(path);
        else inside.push({ path, rel: rel.split(sep).join('/') });
      }
      const flagged = await snap.unrestorable(inside.map((i) => i.rel));
      return [...bad, ...inside.filter((i) => flagged.has(i.rel)).map((i) => i.path)];
    } catch (e) {
      this.o.log('warn', 'could not audit edited files', { error: (e as Error).message });
      return [];
    }
  }

  async warm(): Promise<void> {
    try {
      const snap = await this.snapshot(true);
      if ('unavailable' in snap) return;
      await snap.track();
      for (const name of await fsp.readdir(this.dir()).catch(() => [] as string[])) {
        const sid = name.endsWith('.json') ? name.slice(0, -5) : '';
        if (!ID_RE.test(sid)) continue;
        const st = await fsp.stat(join(this.dir(), name)).catch(() => undefined);
        if (st && Date.now() - st.mtimeMs > LOG_TTL_MS) await this.remove(sid);
      }
      await snap.maintenance();
    } catch (e) {
      this.o.log('warn', 'file snapshot warm-up failed', { error: (e as Error).message });
    }
  }

  begin(sid: string, uuid: string): Promise<void> {
    if (!ID_RE.test(sid) || !ID_RE.test(uuid)) return Promise.resolve();
    return this.chain(sid, async () => {
      let snap: GitSnapshot | undefined;
      try {
        const opened = await this.snapshot();
        if ('unavailable' in opened) return;
        snap = opened;
        const tree = await snap.track();
        const log = await this.load(sid, snap);
        if (log.checkpoints.some((c) => c.uuid === uuid)) return;
        const last = log.checkpoints.at(-1);
        const closed = last && !last.files ? await this.changed(snap, last.tree, tree) : undefined;
        await snap.pin(`${sid}/${uuid}`, tree); // pin first: a failure leaves the log untouched
        if (last && closed) last.files = closed;
        log.checkpoints.push({ uuid, tree });
        await this.save(sid, log, snap);
        this.openUuid.set(sid, uuid);
      } catch (e) {
        this.logs.delete(sid); // the in-memory log may be ahead of the disk: reload on next use
        this.o.log('warn', 'file snapshot checkpoint failed', { sid, error: (e as Error).message });
      }
    });
  }

  end(sid: string): Promise<void> {
    if (!ID_RE.test(sid)) return Promise.resolve();
    // Read synchronously: only the checkpoint that is open right now may be closed by this call. A checkpoint whose
    // `begin` is still running (the message is not pushed yet) is not in the map and must stay open.
    const uuid = this.openUuid.get(sid);
    if (!uuid && !this.reopening.has(sid)) return Promise.resolve();
    return this.chain(sid, async () => {
      // A queued reopen has set the open uuid by now (it ran first in the chain).
      const uuidNow = uuid ?? this.openUuid.get(sid);
      if (!uuidNow || this.openUuid.get(sid) !== uuidNow) return; // closed by someone else (a later begin, revert, drop) meanwhile
      try {
        const snap = await this.snapshot();
        if ('unavailable' in snap) return;
        const log = await this.load(sid, snap);
        const last = log.checkpoints.at(-1);
        if (last?.uuid === uuidNow && !last.files) {
          last.files = await this.changed(snap, last.tree, await snap.track());
          await this.save(sid, log, snap);
        }
        if (this.openUuid.get(sid) === uuidNow) this.openUuid.delete(sid);
      } catch (e) {
        this.logs.delete(sid);
        this.o.log('warn', 'closing file snapshot checkpoint failed', { sid, error: (e as Error).message });
      }
    });
  }

  /**
   * The session went busy again after an idle closed the last checkpoint without a newer `begin` (a queued message was
   * dequeued, the CLI continued on its own): that checkpoint covers the new turn too, so it is opened again and its
   * file list is recomputed from its start tree at the next close. No-op when a checkpoint is open or none exists.
   */
  reopen(sid: string): Promise<void> {
    if (!ID_RE.test(sid)) return Promise.resolve();
    this.reopening.add(sid);
    return this.chain(sid, async () => {
      if (this.openUuid.has(sid)) return;
      try {
        const snap = await this.snapshot();
        if ('unavailable' in snap) return;
        const log = await this.load(sid, snap);
        const last = log.checkpoints.at(-1);
        if (!last) return;
        if (last.files) {
          delete last.files;
          await this.save(sid, log, snap);
        }
        this.openUuid.set(sid, last.uuid); // (an open one found on disk after a reload is closed at the next idle)
      } catch (e) {
        this.logs.delete(sid);
        this.o.log('warn', 'reopening the file snapshot checkpoint failed', { sid, error: (e as Error).message });
      }
    }).finally(() => void this.reopening.delete(sid));
  }

  preview(sid: string, uuid: string, head?: string): Promise<RevertPreview & { files: string[] }> {
    const fail = (filesError: string) => ({ files: [], insertions: 0, deletions: 0, filesError });
    if (!ID_RE.test(sid) || !ID_RE.test(uuid)) return Promise.resolve(fail(NO_CHECKPOINT));
    return this.chain(sid, async () => {
      try {
        const snap = await this.snapshot(true);
        if ('unavailable' in snap) return fail(snap.unavailable);
        const log = await this.load(sid, snap);
        const idx = log.checkpoints.findIndex((c) => c.uuid === uuid);
        if (idx < 0) return fail(NO_CHECKPOINT);
        const cps = log.checkpoints.slice(idx);
        const to = head ?? (await snap.track());
        const last = cps[cps.length - 1]!;
        const plan = planRevert(cps, last.files ? [] : await this.changed(snap, last.tree, to));
        let insertions = 0;
        let deletions = 0;
        // Files a revert would leave alone are neither listed nor counted (same rule as `revert`).
        const skipped = new Set(await snap.protectedFiles([...plan.keys()], to));
        for (const tree of new Set(plan.values())) {
          if (!(await snap.hasObject(tree))) return fail(EXPIRED);
          for (const [f, n] of await snap.numstat(tree, to)) {
            if (plan.get(f) !== tree || skipped.has(f)) continue;
            insertions += n.ins;
            deletions += n.del;
          }
        }
        return {
          files: [...plan.keys()].filter((f) => !skipped.has(f)).map((f) => this.abs(snap, f)),
          insertions,
          deletions,
          ...(skipped.size ? { filesError: unchangedNote(skipped) } : {}),
        };
      } catch (e) {
        return fail((e as Error).message);
      }
    });
  }

  revert(sid: string, uuid: string): Promise<{ files: string[]; filesError?: string; head?: string }> {
    if (!ID_RE.test(sid) || !ID_RE.test(uuid)) return Promise.resolve({ files: [], filesError: NO_CHECKPOINT });
    return this.chain(sid, async () => {
      let head: string | undefined;
      try {
        const snap = await this.snapshot(true);
        if ('unavailable' in snap) return { files: [], filesError: snap.unavailable };
        const log = await this.load(sid, snap);
        const idx = log.checkpoints.findIndex((c) => c.uuid === uuid);
        if (idx < 0) return { files: [], filesError: NO_CHECKPOINT };
        head = await snap.track();
        const last = log.checkpoints[log.checkpoints.length - 1]!;
        if (!last.files) {
          last.files = await this.changed(snap, last.tree, head);
          await this.save(sid, log, snap);
        }
        this.openUuid.delete(sid);
        const plan = planRevert(log.checkpoints.slice(idx), []);
        for (const tree of new Set(plan.values())) if (!(await snap.hasObject(tree))) return { files: [], filesError: EXPIRED };
        // From here on the head exists: it is returned even when restoring fails, so /redo can still bring the files back.
        await snap.pin(`${sid}/revert-head`, head);
        const protectedFiles = new Set(await snap.protectedFiles([...plan.keys()], head));
        // Remembered for /redo: restoring the head over these files would destroy what revert protected.
        log.protected = protectedFiles.size ? [...protectedFiles] : undefined;
        await this.save(sid, log, snap);
        const { restored, failed } = await snap.restore([...plan].filter(([file]) => !protectedFiles.has(file)).map(([file, tree]) => ({ file, tree })));
        const files = restored.map((f) => this.abs(snap, f));
        const notes: string[] = [];
        if (failed.length) notes.push(`${failed.length} file(s) could not be restored: ${listed(failed)}`);
        if (protectedFiles.size) notes.push(unchangedNote(protectedFiles));
        return { files, head, ...(notes.length ? { filesError: notes.join('; ') } : {}) };
      } catch (e) {
        return { files: [], filesError: (e as Error).message, ...(head ? { head } : {}) };
      }
    });
  }

  /**
   * Puts the files a revert covered back to `head`. Throws when some file could not be written back (the head stays
   * pinned so it can be retried). `skipped` is set when there is nothing to restore from (expired head, no store, no
   * checkpoint): the caller restores the conversation only.
   */
  unrevert(sid: string, uuid: string, head: string): Promise<{ skipped?: string; unavailable?: boolean }> {
    if (!ID_RE.test(sid) || !ID_RE.test(uuid)) return Promise.resolve({ skipped: NO_CHECKPOINT });
    return this.chain(sid, async () => {
      const snap = await this.snapshot(true);
      if ('unavailable' in snap) return { skipped: snap.unavailable, unavailable: true };
      const log = await this.load(sid, snap);
      const idx = log.checkpoints.findIndex((c) => c.uuid === uuid);
      if (idx < 0) return { skipped: NO_CHECKPOINT };
      if (!(await snap.hasObject(head))) return { skipped: EXPIRED };
      const left = new Set(log.protected);
      const files = [...planRevert(log.checkpoints.slice(idx), []).keys()].filter((f) => !left.has(f));
      const { failed } = await snap.restore(files.map((file) => ({ file, tree: head })));
      if (failed.length) throw new Error(`${failed.length} file(s) could not be restored: ${listed(failed)}`);
      await snap.unpin([`${sid}/revert-head`]);
      if (log.protected) {
        delete log.protected;
        await this.save(sid, log, snap);
      }
      return {};
    });
  }

  drop(sid: string, fromUuid: string): Promise<void> {
    if (!ID_RE.test(sid) || !ID_RE.test(fromUuid)) return Promise.resolve();
    return this.chain(sid, async () => {
      const snap = await this.snapshot();
      if ('unavailable' in snap) return;
      const log = await this.load(sid, snap);
      const idx = log.checkpoints.findIndex((c) => c.uuid === fromUuid);
      const dropped = idx >= 0 ? log.checkpoints.slice(idx) : [];
      const open = this.openUuid.get(sid);
      if (open && dropped.some((c) => c.uuid === open)) this.openUuid.delete(sid);
      await snap.unpin([...dropped.map((c) => `${sid}/${c.uuid}`), `${sid}/revert-head`]);
      const hadProtected = log.protected !== undefined;
      delete log.protected;
      if (idx >= 0) log.checkpoints.splice(idx);
      if (idx >= 0 || hadProtected) await this.save(sid, log, snap);
    });
  }

  remove(sid: string): Promise<void> {
    if (!ID_RE.test(sid)) return Promise.resolve();
    return this.chain(sid, async () => {
      this.logs.delete(sid);
      this.openUuid.delete(sid);
      await fsp.rm(this.file(sid), { force: true });
      const snap = await this.snapshot();
      if (!('unavailable' in snap)) await snap.unpinPrefix(`${sid}/`);
    });
  }
}

const listed = (files: string[]): string => files.slice(0, 5).join(', ') + (files.length > 5 ? ', …' : '');

const unchangedNote = (files: Set<string>): string => `${files.size} file(s) were left unchanged because they are Git-ignored or over the size limit: ${listed([...files])}`;
