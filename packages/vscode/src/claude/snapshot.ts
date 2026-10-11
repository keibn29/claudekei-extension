/**
 * Private git snapshot store (no vscode imports). Trees of the workspace are written into a git dir owned by this
 * host (objects borrowed from the user's repo through alternates), so the user's index, refs and config are never touched.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export type SnapshotOptions = {
  cwd: string;
  /** `<storageDir>/snapshot` */
  root: string;
  gitPath: string;
  env: Record<string, string | undefined>;
  /** Files bigger than this are left out of snapshots (default 10 MiB). */
  maxFileBytes?: number;
  /** Home directory override (tests). */
  home?: string;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Lock files younger than this may belong to a live git process of this host. */
const STALE_LOCK_MS = 10 * 60 * 1000;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const SLOW_TRACK_MS = 3000;
const HASH_RE = /^[0-9a-f]{40,64}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_/-]*$/;

type RunResult = { code: number; stdout: Buffer; stderr: string };

function cleanEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !k.toUpperCase().startsWith('GIT_')) out[k] = v;
  out.GIT_TERMINAL_PROMPT = '0';
  return out;
}

function exec(gitPath: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string }): Promise<RunResult> {
  return new Promise((res, rej) => {
    const child = spawn(gitPath, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => out.push(c));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', rej);
    child.on('close', (code) => res({ code: code ?? -1, stdout: Buffer.concat(out), stderr }));
    child.stdin.on('error', () => undefined); // git may exit before reading all of stdin
    child.stdin.end(opts.stdin ?? '');
  });
}

const nulList = (buf: Buffer): string[] => buf.toString('utf8').split('\0').filter(Boolean);

export async function openSnapshot(o: SnapshotOptions): Promise<GitSnapshot | { unavailable: string }> {
  const env = cleanEnv(o.env);
  const git = (args: string[], extra?: NodeJS.ProcessEnv) => exec(o.gitPath, args, { cwd: o.cwd, env: extra ? { ...env, ...extra } : env });
  const cwdStat = await fsp.stat(o.cwd).catch(() => undefined);
  if (!cwdStat?.isDirectory()) return { unavailable: 'the workspace folder does not exist' };
  let version: RunResult;
  try {
    version = await git(['--version']);
  } catch {
    return { unavailable: 'Git was not found' };
  }
  if (version.code !== 0) return { unavailable: 'Git was not found' };
  const m = /(\d+)\.(\d+)/.exec(version.stdout.toString('utf8'));
  if (m && (Number(m[1]) < 2 || (Number(m[1]) === 2 && Number(m[2]) < 26))) return { unavailable: 'Git 2.26 or newer is required' };

  const top = await git(['-C', o.cwd, 'rev-parse', '--show-toplevel', '--git-common-dir']).catch(() => undefined);
  const lines = top && top.code === 0 ? top.stdout.toString('utf8').split(/\r?\n/).filter(Boolean) : [];
  if (lines.length < 2) return { unavailable: 'the workspace is not a Git repository' };
  const worktree = await fsp.realpath(resolve(o.cwd, lines[0]!)).catch(() => resolve(o.cwd, lines[0]!));
  const common = resolve(o.cwd, lines[1]!);
  const home = await fsp.realpath(o.home ?? homedir()).catch(() => o.home ?? homedir());
  if (home === worktree || home.startsWith(worktree.endsWith(sep) ? worktree : worktree + sep)) {
    return { unavailable: 'the Git repository is your home directory' };
  }

  const gitDir = join(o.root, createHash('sha1').update(worktree).digest('hex').slice(0, 16));
  try {
    const exists = await fsp.stat(join(gitDir, 'HEAD')).then(() => true, () => false);
    if (!exists) {
      await fsp.mkdir(gitDir, { recursive: true });
      const init = await git(['init', '--quiet'], { GIT_DIR: gitDir, GIT_WORK_TREE: worktree });
      if (init.code !== 0) return { unavailable: `the snapshot store could not be created: ${init.stderr.trim()}` };
    }
    // Everything below is idempotent: a previous run may have died half way through the init.
    for (const [k, v] of [['core.untrackedCache', 'true'], ['gc.auto', '0']] as const) {
      await git(['--git-dir', gitDir, 'config', k, v]);
    }
    const objects = join(common, 'objects');
    const upstream = await fsp.readFile(join(objects, 'info', 'alternates'), 'utf8').catch(() => '');
    const alternates = [objects, ...upstream.split(/\r?\n/).filter((l) => l && !l.startsWith('#')).map((l) => resolve(objects, l))];
    await fsp.mkdir(join(gitDir, 'objects', 'info'), { recursive: true });
    await fsp.writeFile(join(gitDir, 'objects', 'info', 'alternates'), alternates.join('\n') + '\n');
    await fsp.mkdir(join(gitDir, 'info'), { recursive: true });
    await fsp.writeFile(join(gitDir, 'info', 'attributes'), '* -text -filter -ident -working-tree-encoding\n');
    // Only this host uses the git dir; a lock left by a crashed run is stale once it is old enough.
    for (const lock of ['index.lock', 'packed-refs.lock']) {
      const st = await fsp.stat(join(gitDir, lock)).catch(() => undefined);
      if (st && Date.now() - st.mtimeMs > STALE_LOCK_MS) await fsp.rm(join(gitDir, lock), { force: true });
    }
  } catch (e) {
    return { unavailable: `the snapshot store could not be created: ${(e as Error).message}` };
  }
  const cwdReal = await fsp.realpath(o.cwd).catch(() => worktree);
  return new GitSnapshot(o, worktree, common, gitDir, cwdReal);
}

export class GitSnapshot {
  private readonly env: NodeJS.ProcessEnv;
  private readonly maxFileBytes: number;
  private lock: Promise<unknown> = Promise.resolve();

  /** @internal use `openSnapshot` */
  constructor(private readonly o: SnapshotOptions, readonly worktree: string, private readonly common: string, readonly gitDir: string, /** realpath of the cwd (inside `worktree`) */ readonly cwdReal: string) {
    this.env = cleanEnv(o.env);
    this.maxFileBytes = o.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  private async git(args: string[], stdin?: string): Promise<RunResult> {
    const base = ['--git-dir', this.gitDir, '--work-tree', this.worktree, '-c', 'core.longpaths=true', '-c', 'core.symlinks=true', '-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false'];
    return exec(this.o.gitPath, [...base, ...args], { cwd: this.worktree, env: this.env, stdin });
  }

  private async ok(args: string[], stdin?: string): Promise<Buffer> {
    const r = await this.git(args, stdin);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return r.stdout;
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private checkHash(h: string): void {
    if (!HASH_RE.test(h)) throw new Error(`invalid object id: ${h}`);
  }

  track(): Promise<string> {
    return this.locked(async () => {
      try {
        return await this.trackOnce();
      } catch (e) {
        const message = (e as Error).message;
        if (/index file (corrupt|smaller than expected)|bad (index )?signature/i.test(message)) {
          // The private index is only a cache of the working tree: rebuild it.
          this.o.log('warn', 'snapshot index was corrupt; rebuilding', { worktree: this.worktree });
          await fsp.rm(join(this.gitDir, 'index'), { force: true });
          return this.trackOnce();
        }
        if (/index\.lock.*File exists/is.test(message)) {
          // A lock that was young when the store opened may have gone stale since (crashed git).
          const lock = join(this.gitDir, 'index.lock');
          const st = await fsp.stat(lock).catch(() => undefined);
          if (st && Date.now() - st.mtimeMs > STALE_LOCK_MS) {
            this.o.log('warn', 'removing a stale index.lock', { worktree: this.worktree });
            await fsp.rm(lock, { force: true });
            return this.trackOnce();
          }
        }
        throw e;
      }
    });
  }

  private async trackOnce(): Promise<string> {
    const started = Date.now();
    const src = join(this.common, 'info', 'exclude');
    const dst = join(this.gitDir, 'info', 'exclude');
    const [want, have] = await Promise.all([fsp.readFile(src, 'utf8').catch(() => undefined), fsp.readFile(dst, 'utf8').catch(() => undefined)]);
    if (want !== undefined && want !== have) {
      await fsp.mkdir(join(this.gitDir, 'info'), { recursive: true });
      await fsp.writeFile(dst, want);
    }
    const candidates = nulList(await this.ok(['ls-files', '-z', '--others', '--modified', '--exclude-standard']));
    const large: string[] = [];
    await Promise.all(
      candidates.map(async (f) => {
        const st = await fsp.lstat(join(this.worktree, ...f.split('/'))).catch(() => undefined);
        if (st && st.isFile() && st.size > this.maxFileBytes) large.push(f);
      }),
    );
    // --ignore-errors: one unreadable file or unborn nested repo must not make every snapshot fail.
    const add = await this.git(['add', '--all', '--ignore-errors', '--pathspec-from-file=-', '--pathspec-file-nul'], '.\0' + large.map((f) => `:(exclude,literal)${f}\0`).join(''));
    if (add.code !== 0) {
      const fatal = add.stderr.split(/\r?\n/).filter((l) => /^fatal:/.test(l) && !/adding files failed/.test(l));
      if (fatal.length) throw new Error(`git add failed: ${fatal.join('; ')}`);
      this.o.log('warn', 'some files could not be snapshotted', { detail: add.stderr.trim().slice(0, 500) });
    }
    const tree = (await this.ok(['write-tree'])).toString('utf8').trim();
    const ms = Date.now() - started;
    if (ms > SLOW_TRACK_MS) this.o.log('warn', 'snapshot track was slow', { ms, worktree: this.worktree });
    return tree;
  }

  async changedFiles(from: string, to: string): Promise<string[]> {
    this.checkHash(from);
    this.checkHash(to);
    return nulList(await this.ok(['diff-tree', '-r', '-z', '--name-only', '--no-renames', from, to]));
  }

  async numstat(from: string, to: string): Promise<Map<string, { ins: number; del: number }>> {
    this.checkHash(from);
    this.checkHash(to);
    const out = new Map<string, { ins: number; del: number }>();
    for (const rec of nulList(await this.ok(['diff-tree', '-r', '-z', '--numstat', '--no-renames', from, to]))) {
      const [ins, del, ...rest] = rec.split('\t');
      out.set(rest.join('\t'), { ins: Number(ins) || 0, del: Number(del) || 0 }); // binary files report '-'
    }
    return out;
  }

  async hasObject(hash: string): Promise<boolean> {
    if (!HASH_RE.test(hash)) return false;
    return (await this.git(['cat-file', '-e', hash])).code === 0;
  }

  /**
   * Files that exist on disk but whose current content `tree` does not hold (Git-ignored, over the size limit or skipped
   * by `track`): restoring or deleting them would destroy content no snapshot has.
   */
  async protectedFiles(files: string[], tree: string): Promise<string[]> {
    this.checkHash(tree);
    const inTree = new Set(nulList(await this.ok(['ls-tree', '-r', '-z', '--name-only', tree])));
    const out: string[] = [];
    for (const f of files) {
      const st = await fsp.lstat(join(this.worktree, ...f.split('/'))).catch(() => undefined);
      if (!st || st.isDirectory()) continue;
      if (!inTree.has(f) || (st.isFile() && st.size > this.maxFileBytes)) out.push(f);
    }
    return out;
  }

  /** Removes the directories a deleted file leaves empty, up to (excluding) the worktree; anything else stops the walk. */
  private async pruneEmptyParents(file: string): Promise<void> {
    const parts = file.split('/');
    for (let i = parts.length - 1; i >= 1; i--) {
      const dir = join(this.worktree, ...parts.slice(0, i));
      // Never the workspace folder or one of its ancestors, even when everything in it was created by the reverted turns.
      if (this.cwdReal === dir || this.cwdReal.startsWith(dir.endsWith(sep) ? dir : dir + sep)) return;
      try {
        await fsp.rmdir(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return; // ENOTEMPTY, not a directory, no permission: leave it
      }
    }
  }

  /**
   * Of these worktree-relative paths, the ones a snapshot can never hold: Git-ignored, over the size limit or inside a
   * nested repository. Used to warn about edits a revert cannot undo.
   */
  async unrestorable(rels: string[]): Promise<Set<string>> {
    const out = new Set<string>();
    if (!rels.length) return out;
    // Against the private index (no --no-index): a file that index tracks is restorable even if it matches an ignore
    // rule now. One call for all paths; exit 1 = nothing ignored.
    const ignored = await this.git(['check-ignore', '-z', '--stdin'], rels.map((f) => `${f}\0`).join(''));
    if (ignored.code === 0) for (const f of nulList(ignored.stdout)) out.add(f);
    for (const f of rels) {
      if (out.has(f)) continue;
      const st = await fsp.lstat(join(this.worktree, ...f.split('/'))).catch(() => undefined);
      if ((st?.isFile() && st.size > this.maxFileBytes) || (await this.inNestedRepo(f))) out.add(f);
    }
    return out;
  }

  private async inNestedRepo(file: string): Promise<boolean> {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (await fsp.stat(join(this.worktree, ...parts.slice(0, i), '.git')).then(() => true, () => false)) return true;
    }
    return false;
  }

  /** True when a directory on the way to `file` (inside the worktree) is a symlink: writing through it could leave the worktree. */
  private async behindSymlink(file: string): Promise<boolean> {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      const st = await fsp.lstat(join(this.worktree, ...parts.slice(0, i))).catch(() => undefined);
      if (st?.isSymbolicLink()) return true;
    }
    return false;
  }

  restore(entries: Array<{ file: string; tree: string }>): Promise<{ restored: string[]; failed: string[] }> {
    return this.locked(async () => {
      const groups = new Map<string, string[]>();
      for (const e of entries) {
        this.checkHash(e.tree);
        const g = groups.get(e.tree) ?? [];
        g.push(e.file);
        groups.set(e.tree, g);
      }
      const restored: string[] = [];
      const failed: string[] = [];
      // Pass 0: read every tree before anything is touched, so a bad tree fails the whole call without side effects.
      const inTrees = new Map<string, Set<string>>();
      for (const tree of groups.keys()) inTrees.set(tree, new Set(nulList(await this.ok(['ls-tree', '-r', '-z', '--name-only', tree]))));
      const present = new Map<string, string[]>();
      // Pass 1: files that do not exist in their tree are deleted before anything is written back.
      for (const [tree, files] of groups) {
        const inTree = inTrees.get(tree)!;
        const keep: string[] = [];
        for (const f of files) {
          if (await this.behindSymlink(f)) {
            failed.push(f);
          } else if (inTree.has(f)) {
            keep.push(f);
          } else {
            try {
              await fsp.rm(join(this.worktree, ...f.split('/')), { force: true });
              await this.pruneEmptyParents(f);
              restored.push(f);
            } catch {
              failed.push(f);
            }
          }
        }
        present.set(tree, keep);
      }
      // Pass 2: write the rest back from their trees.
      for (const [tree, files] of present) {
        if (!files.length) continue;
        const checkout = (list: string[]) => this.git(['--literal-pathspecs', 'checkout', tree, '--pathspec-from-file=-', '--pathspec-file-nul'], list.map((f) => `${f}\0`).join(''));
        if ((await checkout(files)).code === 0) {
          restored.push(...files);
          continue;
        }
        for (const f of files) ((await checkout([f])).code === 0 ? restored : failed).push(f);
      }
      return { restored, failed };
    });
  }

  pin(ref: string, tree: string): Promise<void> {
    if (!REF_RE.test(ref)) return Promise.reject(new Error(`invalid ref name: ${ref}`));
    this.checkHash(tree);
    return this.locked(async () => void (await this.ok(['update-ref', `refs/claudekei/${ref}`, tree])));
  }

  /** Deletes exactly these refs (names relative to `refs/claudekei/`) in one transaction. */
  unpin(refs: string[]): Promise<void> {
    for (const r of refs) if (!REF_RE.test(r)) return Promise.reject(new Error(`invalid ref name: ${r}`));
    if (!refs.length) return Promise.resolve();
    return this.locked(async () => void (await this.ok(['update-ref', '--stdin'], refs.map((r) => `delete refs/claudekei/${r}\n`).join(''))));
  }

  /** Deletes every ref below `<prefix>/` (the prefix must name a whole path component, e.g. a session id). */
  unpinPrefix(prefix: string): Promise<void> {
    if (!REF_RE.test(prefix)) return Promise.reject(new Error(`invalid ref prefix: ${prefix}`));
    const dir = prefix.replace(/\/+$/, '');
    return this.locked(async () => {
      const refs = (await this.ok(['for-each-ref', '--format=%(refname)', `refs/claudekei/${dir}`])).toString('utf8').split(/\r?\n/).filter(Boolean);
      if (refs.length) await this.ok(['update-ref', '--stdin'], refs.map((r) => `delete ${r}\n`).join(''));
    });
  }

  maintenance(): Promise<void> {
    return this.locked(async () => {
      const stamp = join(this.gitDir, 'claudekei-gc');
      const st = await fsp.stat(stamp).catch(() => undefined);
      if (st && Date.now() - st.mtimeMs < DAY_MS) return;
      await this.ok(['gc', '--quiet', '--prune=7.days']);
      await fsp.writeFile(stamp, String(Date.now()));
    });
  }
}
