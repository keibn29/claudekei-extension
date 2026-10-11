import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSnapshot, type GitSnapshot } from './snapshot';

const hasGit = spawnSync('git', ['--version']).status === 0;
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
};

const tmp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `claudekei-snap-${name}-`)));
  dirs.push(d);
  return d;
};

const repo = () => {
  const base = tmp('repo');
  const work = join(base, 'work');
  mkdirSync(work);
  sh(work, 'init', '--quiet');
  writeFileSync(join(work, 'a.txt'), 'A\n');
  sh(work, 'add', '.');
  sh(work, 'commit', '--quiet', '-m', 'init');
  return { base, work, root: join(base, 'store') };
};

const open = async (work: string, root: string, extra: { maxFileBytes?: number; home?: string } = {}): Promise<GitSnapshot> => {
  const r = await openSnapshot({ cwd: work, root, gitPath: 'git', env: process.env, log: () => undefined, home: join(tmpdir(), 'no-home-here'), ...extra });
  if ('unavailable' in r) throw new Error(r.unavailable);
  return r;
};

describe.skipIf(!hasGit)('snapshot', () => {
  test('non-git directory and a repository at HOME are unavailable', async () => {
    const plain = tmp('plain');
    const r1 = await openSnapshot({ cwd: plain, root: join(plain, 's'), gitPath: 'git', env: process.env, log: () => undefined, home: tmp('h') });
    expect(r1).toEqual({ unavailable: 'the workspace is not a Git repository' });
    const { work, root } = repo();
    const r2 = await openSnapshot({ cwd: work, root, gitPath: 'git', env: process.env, log: () => undefined, home: work });
    expect(r2).toEqual({ unavailable: 'the Git repository is your home directory' });
    const r3 = await openSnapshot({ cwd: work, root, gitPath: 'definitely-not-git-xyz', env: process.env, log: () => undefined });
    expect(r3).toEqual({ unavailable: 'Git was not found' });
  });

  test('track is stable when nothing changed and changes after edit, nested new file and deletion', async () => {
    const { work, root } = repo();
    const s = await open(work, root);
    const t0 = await s.track();
    expect(await s.track()).toBe(t0);
    writeFileSync(join(work, 'a.txt'), 'changed\n');
    const t1 = await s.track();
    expect(t1).not.toBe(t0);
    mkdirSync(join(work, 'x', 'y'), { recursive: true });
    writeFileSync(join(work, 'x', 'y', 'n.txt'), 'new\n');
    const t2 = await s.track();
    expect(t2).not.toBe(t1);
    rmSync(join(work, 'a.txt'));
    const t3 = await s.track();
    expect(t3).not.toBe(t2);
    expect((await s.changedFiles(t0, t3)).sort()).toEqual(['a.txt', 'x/y/n.txt']);
    const ns = await s.numstat(t2, t3);
    expect(ns.get('a.txt')).toEqual({ ins: 0, del: 1 });
  });

  test('ignored files and files over maxFileBytes are excluded', async () => {
    const { work, root } = repo();
    writeFileSync(join(work, '.gitignore'), 'ignored.txt\n');
    const s = await open(work, root, { maxFileBytes: 1024 });
    const t0 = await s.track();
    writeFileSync(join(work, 'ignored.txt'), 'x');
    writeFileSync(join(work, 'big.bin'), Buffer.alloc(2048, 1));
    const t1 = await s.track();
    expect(await s.changedFiles(t0, t1)).toEqual([]);
    writeFileSync(join(work, 'small.txt'), 'x');
    expect(await s.changedFiles(t1, await s.track())).toEqual(['small.txt']);
  });

  test('restore: edited, created (deleted again), deleted (recreated with parents) and byte-exact CRLF files', async () => {
    const { work, root } = repo();
    writeFileSync(join(work, '.gitattributes'), '* text=auto\n');
    mkdirSync(join(work, 'd', 'e'), { recursive: true });
    writeFileSync(join(work, 'd', 'e', 'f.txt'), 'deep\n');
    writeFileSync(join(work, 'crlf.txt'), 'one\r\ntwo\r\n');
    const s = await open(work, root);
    const t0 = await s.track();
    writeFileSync(join(work, 'a.txt'), 'edited by bash\n');
    mkdirSync(join(work, 'made', 'sub'), { recursive: true });
    writeFileSync(join(work, 'made', 'sub', 'new.txt'), 'new');
    rmSync(join(work, 'd'), { recursive: true });
    writeFileSync(join(work, 'crlf.txt'), 'other\n');
    const t1 = await s.track();
    const files = await s.changedFiles(t0, t1);
    const res = await s.restore(files.map((file) => ({ file, tree: t0 })));
    expect(res.failed).toEqual([]);
    expect(res.restored.sort()).toEqual([...files].sort());
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('A\n');
    expect(existsSync(join(work, 'made', 'sub', 'new.txt'))).toBe(false);
    expect(readFileSync(join(work, 'd', 'e', 'f.txt'), 'utf8')).toBe('deep\n');
    expect(readFileSync(join(work, 'crlf.txt'))).toEqual(Buffer.from('one\r\ntwo\r\n'));
    expect(await s.track()).toBe(t0);
  });

  test.skipIf(process.platform === 'win32')('restore recreates a symlink', async () => {
    const { work, root } = repo();
    symlinkSync('a.txt', join(work, 'link'));
    const s = await open(work, root);
    const t0 = await s.track();
    rmSync(join(work, 'link'));
    await s.restore([{ file: 'link', tree: t0 }]);
    expect(lstatSync(join(work, 'link')).isSymbolicLink()).toBe(true);
  });

  test("the user's repository is untouched and the store borrows its objects", async () => {
    const { work, root } = repo();
    writeFileSync(join(work, 'untracked.txt'), 'u');
    const snapshotOf = () => {
      const index = readFileSync(join(work, '.git', 'index')); // read before `status` may refresh it
      return { index, status: sh(work, 'status', '--porcelain'), head: sh(work, 'rev-parse', 'HEAD') };
    };
    sh(work, 'status', '--porcelain');
    const before = snapshotOf();
    const s = await open(work, root);
    const t0 = await s.track();
    writeFileSync(join(work, 'a.txt'), 'edit');
    const t1 = await s.track();
    await s.restore([{ file: 'a.txt', tree: t0 }]);
    await s.pin('x/y', t1);
    await s.maintenance();
    writeFileSync(join(work, 'a.txt'), 'A\n');
    const after = snapshotOf();
    expect(after.status).toBe(before.status);
    expect(after.head).toBe(before.head);
    expect(after.index.equals(before.index)).toBe(true);
    expect(readFileSync(join(s.gitDir, 'objects', 'info', 'alternates'), 'utf8')).toContain(join(work, '.git', 'objects'));
  });

  test('an old index.lock is removed when the store is opened, a fresh one is kept', async () => {
    const { work, root } = repo();
    const s = await open(work, root);
    await s.track();
    const lock = join(s.gitDir, 'index.lock');
    writeFileSync(lock, '');
    await open(work, root);
    expect(existsSync(lock)).toBe(true); // may belong to a live git process
    const old = new Date(Date.now() - 20 * 60_000);
    utimesSync(lock, old, old);
    const s2 = await open(work, root);
    expect(existsSync(lock)).toBe(false);
    await s2.track();
  });

  test('a lock that turns stale after the store was opened is cleared by track; a fresh one is not', async () => {
    const { work, root } = repo();
    const s = await open(work, root);
    await s.track();
    const lock = join(s.gitDir, 'index.lock');
    writeFileSync(lock, '');
    await expect(s.track()).rejects.toThrow('index.lock');
    expect(existsSync(lock)).toBe(true);
    const old = new Date(Date.now() - 20 * 60_000);
    utimesSync(lock, old, old);
    await s.track();
    expect(existsSync(lock)).toBe(false);
  });

  test('a corrupt private index is rebuilt by track', async () => {
    const { work, root } = repo();
    const s = await open(work, root);
    const t0 = await s.track();
    writeFileSync(join(s.gitDir, 'index'), 'garbage that is not an index');
    expect(await s.track()).toBe(t0);
  });

  test('a half-initialised store (missing attributes / alternates) is repaired on open', async () => {
    const { work, root } = repo();
    const s = await open(work, root);
    rmSync(join(s.gitDir, 'info', 'attributes'));
    rmSync(join(s.gitDir, 'objects', 'info', 'alternates'));
    await open(work, root);
    expect(readFileSync(join(s.gitDir, 'info', 'attributes'), 'utf8')).toContain('-text');
    expect(readFileSync(join(s.gitDir, 'objects', 'info', 'alternates'), 'utf8')).toContain(join(work, '.git', 'objects'));
  });

  test('a workspace folder that does not exist is not reported as a missing git', async () => {
    const r = await openSnapshot({ cwd: join(tmp('gone'), 'nope'), root: tmp('r'), gitPath: 'git', env: process.env, log: () => undefined });
    expect(r).toEqual({ unavailable: 'the workspace folder does not exist' });
  });

  test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unborn nested repository and an unreadable file do not break track', async () => {
    const { work, root } = repo();
    const s = await open(work, root);
    const t0 = await s.track();
    mkdirSync(join(work, 'nested'));
    sh(join(work, 'nested'), 'init', '--quiet');
    writeFileSync(join(work, 'locked.txt'), 'secret');
    chmodSync(join(work, 'locked.txt'), 0o000);
    writeFileSync(join(work, 'ok.txt'), 'fine');
    const warnings: string[] = [];
    const s2 = await open(work, root).then(() => openSnapshot({ cwd: work, root, gitPath: 'git', env: process.env, log: (l, m) => l === 'warn' && warnings.push(m), home: join(tmpdir(), 'no-home-here') }));
    if ('unavailable' in s2) throw new Error(s2.unavailable);
    const t1 = await s2.track();
    chmodSync(join(work, 'locked.txt'), 0o644);
    expect(await s2.changedFiles(t0, t1)).toEqual(['ok.txt']);
    expect(warnings).toContain('some files could not be snapshotted');
  });

  test('unpin deletes exact refs only; unpinPrefix deletes a whole session', async () => {
    const { work, root } = repo();
    const s = await open(work, root);
    const t = await s.track();
    for (const r of ['a/u1', 'a/u10', 'a/revert-head', 'ab/u1']) await s.pin(r, t);
    const refs = () => sh(work, '--git-dir', s.gitDir, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean).map((r) => r.replace('refs/claudekei/', ''));
    await s.unpin(['a/u1', 'a/missing']);
    expect(refs().sort()).toEqual(['a/revert-head', 'a/u10', 'ab/u1']);
    await s.unpinPrefix('a/');
    expect(refs()).toEqual(['ab/u1']);
  });

  test('restore reads every tree before touching anything: a bad second tree changes nothing', async () => {
    const { work, root } = repo();
    const s = await open(work, root);
    const t0 = await s.track();
    writeFileSync(join(work, 'new.txt'), 'created later');
    writeFileSync(join(work, 'a.txt'), 'changed');
    await expect(s.restore([{ file: 'new.txt', tree: t0 }, { file: 'a.txt', tree: 'f'.repeat(40) }])).rejects.toThrow();
    expect(existsSync(join(work, 'new.txt'))).toBe(true);
    expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('changed');
  });

  test('G3: restore removes the directories a deleted file leaves empty, but never the worktree or non-empty ones', async () => {
    const { work, root } = repo();
    mkdirSync(join(work, 'keep'));
    writeFileSync(join(work, 'keep', 'stays.txt'), 's');
    const s = await open(work, root);
    const t0 = await s.track();
    mkdirSync(join(work, 'x', 'y', 'z'), { recursive: true });
    writeFileSync(join(work, 'x', 'y', 'z', 'new.txt'), 'n');
    writeFileSync(join(work, 'keep', 'new2.txt'), 'n');
    writeFileSync(join(work, 'x', 'sibling.txt'), 'n');
    const t1 = await s.track();
    const res = await s.restore((await s.changedFiles(t0, t1)).map((file) => ({ file, tree: t0 })));
    expect(res.failed).toEqual([]);
    expect(existsSync(join(work, 'x', 'y'))).toBe(false); // empty chain pruned
    expect(existsSync(join(work, 'x'))).toBe(false); // sibling was deleted too, so x is empty as well
    expect(existsSync(join(work, 'keep', 'stays.txt'))).toBe(true);
    expect(existsSync(work)).toBe(true);
    // a directory that still holds an untracked-but-ignored file stays
    writeFileSync(join(work, '.gitignore'), 'keepme.txt\n');
    mkdirSync(join(work, 'd'));
    const t2 = await s.track();
    writeFileSync(join(work, 'd', 'gone.txt'), 'n');
    writeFileSync(join(work, 'd', 'keepme.txt'), 'ignored');
    const t3 = await s.track();
    await s.restore((await s.changedFiles(t2, t3)).map((file) => ({ file, tree: t2 })));
    expect(existsSync(join(work, 'd', 'gone.txt'))).toBe(false);
    expect(existsSync(join(work, 'd', 'keepme.txt'))).toBe(true);
  });

  test('G3: the workspace folder (and its ancestors) is never removed, even when everything in it came from the reverted turns', async () => {
    const { work, root } = repo();
    const ws = join(work, 'packages', 'ws');
    mkdirSync(ws, { recursive: true }); // the workspace is a subfolder of the repository, empty at the start
    const opened = await openSnapshot({ cwd: ws, root, gitPath: 'git', env: process.env, log: () => undefined, home: join(tmpdir(), 'no-home-here') });
    if ('unavailable' in opened) throw new Error(opened.unavailable);
    const t0 = await opened.track();
    mkdirSync(join(ws, 'a', 'b'), { recursive: true });
    writeFileSync(join(ws, 'a', 'b', 'new.txt'), 'n');
    const t1 = await opened.track();
    const res = await opened.restore((await opened.changedFiles(t0, t1)).map((file) => ({ file, tree: t0 })));
    expect(res.failed).toEqual([]);
    expect(existsSync(join(ws, 'a'))).toBe(false); // below the workspace: pruned
    expect(existsSync(ws)).toBe(true);
    expect(existsSync(join(work, 'packages'))).toBe(true);
  });

  test('G1/G2: a file the private index tracks is not reported even if an ignore rule matches it now', async () => {
    const { work, root } = repo();
    writeFileSync(join(work, 'tracked.txt'), 't');
    const s = await open(work, root);
    await s.track();
    writeFileSync(join(work, '.gitignore'), 'tracked.txt\nnever-tracked.txt\n');
    await s.track();
    expect([...(await s.unrestorable(['tracked.txt', 'never-tracked.txt', 'a.txt']))]).toEqual(['never-tracked.txt']);
  });

  test('G1/G2: unrestorable reports ignored, oversized and nested-repository paths only', async () => {
    const { work, root } = repo();
    writeFileSync(join(work, '.gitignore'), 'ignored.txt\nbuild/\n');
    mkdirSync(join(work, 'nested', '.git'), { recursive: true });
    mkdirSync(join(work, 'src'));
    writeFileSync(join(work, 'big.bin'), Buffer.alloc(4096, 1));
    const s = await open(work, root, { maxFileBytes: 1024 });
    await s.track();
    const flagged = await s.unrestorable(['ignored.txt', 'build/out.js', 'nested/file.ts', 'big.bin', 'a.txt', 'src/new.ts', 'does/not/exist.ts']);
    expect([...flagged].sort()).toEqual(['big.bin', 'build/out.js', 'ignored.txt', 'nested/file.ts']);
    expect((await s.unrestorable([])).size).toBe(0);
  });

  test('protectedFiles reports files the tree cannot bring back: ignored and over the size limit', async () => {
    const { work, root } = repo();
    writeFileSync(join(work, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(work, 'grows.txt'), 'small');
    const s = await open(work, root, { maxFileBytes: 1024 });
    const t0 = await s.track();
    writeFileSync(join(work, 'ignored.txt'), 'x');
    writeFileSync(join(work, 'grows.txt'), Buffer.alloc(4096, 1));
    writeFileSync(join(work, 'a.txt'), 'plain edit');
    const t1 = await s.track();
    expect(await s.protectedFiles(['ignored.txt', 'grows.txt', 'a.txt', 'gone.txt'], t1)).toEqual(['ignored.txt', 'grows.txt']);
    expect(t0).not.toBe(t1);
  });

  test.skipIf(process.platform === 'win32')('restore refuses to write through a directory that became a symlink', async () => {
    const { work, root } = repo();
    mkdirSync(join(work, 'd'));
    writeFileSync(join(work, 'd', 'f.txt'), 'inside');
    const s = await open(work, root);
    const t0 = await s.track();
    const outside = tmp('outside');
    writeFileSync(join(outside, 'f.txt'), 'outside content');
    rmSync(join(work, 'd'), { recursive: true });
    symlinkSync(outside, join(work, 'd'));
    const res = await s.restore([{ file: 'd/f.txt', tree: t0 }, { file: 'd/new.txt', tree: t0 }]);
    expect(res.failed.sort()).toEqual(['d/f.txt', 'd/new.txt']);
    expect(readFileSync(join(outside, 'f.txt'), 'utf8')).toBe('outside content');
  });

  test.skipIf(process.platform === 'win32')('names with spaces, combining characters and git magic survive track, restore and the size filter', async () => {
    const { work, root } = repo();
    const names = ['with space.txt', 'e\u0301.txt', '*.ts', '[a].ts', ':x', 'dir with space/inner [1].txt'];
    mkdirSync(join(work, 'dir with space'));
    for (const n of names) writeFileSync(join(work, n), 'v1');
    const s = await open(work, root, { maxFileBytes: 1024 });
    const t0 = await s.track();
    for (const n of names) writeFileSync(join(work, n), 'v2');
    writeFileSync(join(work, '[big].bin'), Buffer.alloc(4096, 1));
    const t1 = await s.track();
    // git precomposes unicode names on macOS, so compare in NFC
    expect((await s.changedFiles(t0, t1)).map((n) => n.normalize('NFC')).sort()).toEqual(names.map((n) => n.normalize('NFC')).sort());
    const res = await s.restore((await s.changedFiles(t0, t1)).map((file) => ({ file, tree: t0 })));
    expect(res.failed).toEqual([]);
    for (const n of names) expect(readFileSync(join(work, n), 'utf8')).toBe('v1');
    expect(existsSync(join(work, 'a.ts'))).toBe(false);
  });

  test('pinned trees survive gc --prune=now, unpinned ones do not; hasObject reports it', async () => {
    const { work, root } = repo();
    const s = await open(work, root);
    writeFileSync(join(work, 'p.txt'), 'pinned content');
    const pinned = await s.track();
    await s.pin('s1/u1', pinned);
    writeFileSync(join(work, 'q.txt'), 'loose content');
    const loose = await s.track();
    writeFileSync(join(work, 'q.txt'), 'later');
    await s.track(); // index no longer references `loose`
    sh(s.gitDir, '--git-dir', s.gitDir, 'reflog', 'expire', '--expire=now', '--all');
    sh(work, '--git-dir', s.gitDir, 'gc', '--quiet', '--prune=now');
    expect(await s.hasObject(pinned)).toBe(true);
    expect(await s.hasObject(loose)).toBe(false);
    await s.unpinPrefix('s1/');
    sh(work, '--git-dir', s.gitDir, 'gc', '--quiet', '--prune=now');
    expect(await s.hasObject(pinned)).toBe(false);
  });
});
