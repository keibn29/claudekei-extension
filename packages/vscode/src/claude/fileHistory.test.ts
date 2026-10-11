import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileHistory, planRevert } from './fileHistory';

const hasGit = spawnSync('git', ['--version']).status === 0;
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
};

const setup = (git = true) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'claudekei-fh-')));
  dirs.push(base);
  const work = join(base, 'work');
  const storage = join(base, 'storage');
  mkdirSync(work);
  if (git) {
    sh(work, 'init', '--quiet');
    writeFileSync(join(work, 'seed.txt'), 'seed\n');
    sh(work, 'add', '.');
    sh(work, 'commit', '--quiet', '-m', 'init');
  }
  const make = () => new FileHistory({ storageDir: storage, cwd: work, env: async () => process.env, enabled: () => true, log: () => undefined });
  return { work, storage, fh: make(), make, f: (n: string) => join(work, n), read: (n: string) => readFileSync(join(work, n), 'utf8'), w: (n: string, c: string) => writeFileSync(join(work, n), c) };
};

const refs = (work: string, storage: string): string[] => {
  const root = join(storage, 'snapshot');
  const gitDirs = existsSync(root) ? readdirSync(root) : [];
  return gitDirs.flatMap((d) => sh(work, '--git-dir', join(root, d), 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean));
};

describe('FileHistory ids', () => {
  test('path-like session ids and uuids are rejected without touching the disk', async () => {
    const { fh, storage } = setup(false);
    await fh.begin('../evil', 'u1');
    await fh.begin('s1', 'a/b');
    await fh.begin('..', 'u1');
    await fh.remove('a/b');
    expect((await fh.revert('..', 'u1')).filesError).toBeDefined();
    expect(existsSync(join(storage, 'checkpoints'))).toBe(false);
  });
});

describe('planRevert', () => {
  test('the earliest checkpoint covering a file wins; open checkpoints use openFiles', () => {
    const plan = planRevert(
      [
        { uuid: 'a', tree: 'T1', files: ['x', 'y'] },
        { uuid: 'b', tree: 'T2', files: ['y', 'z'] },
        { uuid: 'c', tree: 'T3' },
      ],
      ['z', 'w'],
    );
    expect([...plan]).toEqual([['x', 'T1'], ['y', 'T1'], ['z', 'T2'], ['w', 'T3']]);
  });
});

describe.skipIf(!hasGit)('FileHistory', () => {
  test('three turns: reverting to turn 2 restores later changes, unrevert brings the head back', async () => {
    const { fh, w, read, f } = setup();
    await fh.begin('s1', 'u1');
    w('a.txt', 'a1');
    await fh.end('s1');
    await fh.begin('s1', 'u2');
    w('a.txt', 'a2');
    w('b.txt', 'b2');
    await fh.end('s1');
    await fh.begin('s1', 'u3');
    w('a.txt', 'a3');
    await fh.end('s1');

    const pre = await fh.preview('s1', 'u2');
    expect(pre.filesError).toBeUndefined();
    expect(pre.files.sort()).toEqual([f('a.txt'), f('b.txt')]);
    expect(pre.insertions).toBe(2); // a.txt: a1 -> a3 (+1/-1), b.txt created (+1)
    expect(pre.deletions).toBe(1);
    const res = await fh.revert('s1', 'u2');
    expect(res.filesError).toBeUndefined();
    expect(res.files.sort()).toEqual([f('a.txt'), f('b.txt')]);
    expect(read('a.txt')).toBe('a1');
    expect(existsSync(f('b.txt'))).toBe(false);
    await fh.unrevert('s1', 'u2', res.head!);
    expect(read('a.txt')).toBe('a3');
    expect(read('b.txt')).toBe('b2');
  });

  test('manual edit to an untouched file between turns survives', async () => {
    const { fh, w, read } = setup();
    w('keep.txt', 'orig');
    await fh.begin('s1', 'u1');
    w('a.txt', 'a1');
    await fh.end('s1');
    w('keep.txt', 'manual'); // never changed by a turn span? it is: between end and next begin
    await fh.begin('s1', 'u2');
    w('a.txt', 'a2');
    await fh.end('s1');
    await fh.revert('s1', 'u2');
    expect(read('a.txt')).toBe('a1');
    expect(read('keep.txt')).toBe('manual');
  });

  test('two sessions share one git dir but keep separate logs', async () => {
    const { fh, w, storage, read } = setup();
    await fh.begin('s1', 'u1');
    w('a.txt', 'one');
    await fh.end('s1');
    await fh.begin('s2', 'u1');
    w('b.txt', 'two');
    await fh.end('s2');
    expect(existsSync(join(storage, 'checkpoints', 's1.json'))).toBe(true);
    expect(existsSync(join(storage, 'checkpoints', 's2.json'))).toBe(true);
    await fh.revert('s2', 'u1');
    expect(existsSync(join(storage, 'checkpoints', 's2.json'))).toBe(true);
    expect(read('a.txt')).toBe('one'); // s2's span started after a.txt changed
  });

  test('after a reload the open checkpoint on disk is closed at revert', async () => {
    const { fh, make, w, read } = setup();
    await fh.begin('s1', 'u1');
    w('a.txt', 'mid-turn');
    const fresh = make(); // host reloaded: no in-memory open checkpoint
    await fresh.end('s1'); // no-op
    const res = await fresh.revert('s1', 'u1');
    expect(res.filesError).toBeUndefined();
    expect(() => read('a.txt')).toThrow();
  });

  test('a message without a checkpoint reports filesError', async () => {
    const { fh } = setup();
    await fh.begin('s1', 'u1');
    expect((await fh.revert('s1', 'nope')).filesError).toBe('no file snapshot was taken when this message was sent');
    expect((await fh.preview('s1', 'nope')).filesError).toBe('no file snapshot was taken when this message was sent');
    expect((await fh.revert('../evil', 'u1')).filesError).toBeDefined();
  });

  test('a workspace that is not a git repository reports the reason and never throws', async () => {
    const { fh } = setup(false);
    await fh.begin('s1', 'u1');
    await fh.end('s1');
    expect((await fh.revert('s1', 'u1')).filesError).toBe('the workspace is not a Git repository');
    expect((await fh.preview('s1', 'u1')).filesError).toBe('the workspace is not a Git repository');
    await fh.warm();
  });

  test('disabled setting reports the reason', async () => {
    const { work, storage } = setup();
    const fh = new FileHistory({ storageDir: storage, cwd: work, env: async () => process.env, enabled: () => false, log: () => undefined });
    expect((await fh.revert('s1', 'u1')).filesError).toBe('file snapshots are turned off (claudekei.fileSnapshots)');
  });

  test('revert Y, unrevert, revert earlier X, unrevert: both return to the head state', async () => {
    const { fh, w, read, f } = setup();
    for (const [u, c] of [['ux', 'x1'], ['uy', 'y1'], ['uz', 'z1']] as const) {
      await fh.begin('s1', u);
      w('a.txt', c);
      w(`${u}.txt`, c);
      await fh.end('s1');
    }
    const headState = () => ['a.txt', 'ux.txt', 'uy.txt', 'uz.txt'].map((n) => (existsSync(f(n)) ? read(n) : null));
    const head0 = headState();
    const r1 = await fh.revert('s1', 'uy');
    expect(read('a.txt')).toBe('x1');
    expect(existsSync(f('uz.txt'))).toBe(false);
    await fh.unrevert('s1', 'uy', r1.head!);
    expect(headState()).toEqual(head0);
    const r2 = await fh.revert('s1', 'ux');
    expect(existsSync(f('a.txt'))).toBe(false);
    await fh.unrevert('s1', 'ux', r2.head!);
    expect(headState()).toEqual(head0);
    // revert Y, then a later Z (previous marker unreverted first), then unrevert Z
    const r3 = await fh.revert('s1', 'uy');
    await fh.unrevert('s1', 'uy', r3.head!);
    const r4 = await fh.revert('s1', 'uz');
    expect(read('a.txt')).toBe('y1');
    await fh.unrevert('s1', 'uz', r4.head!);
    expect(headState()).toEqual(head0);
  });

  test('preview with a head override ignores later working-tree edits', async () => {
    const { fh, w } = setup();
    await fh.begin('s1', 'u1');
    w('a.txt', 'l1\nl2\n');
    await fh.end('s1');
    const r = await fh.revert('s1', 'u1');
    w('a.txt', 'edited after the revert\n');
    const withHead = await fh.preview('s1', 'u1', r.head);
    expect(withHead.files.length).toBe(1);
    expect(withHead.insertions).toBe(2);
    expect(withHead.deletions).toBe(0);
  });

  test('drop removes checkpoints from the uuid onward and their refs; remove deletes log and refs', async () => {
    const { fh, w, work, storage } = setup();
    for (const u of ['u1', 'u2', 'u3']) {
      await fh.begin('s1', u);
      w('a.txt', u);
      await fh.end('s1');
    }
    await fh.revert('s1', 'u2'); // creates revert-head
    expect(refs(work, storage).sort()).toEqual(['refs/claudekei/s1/revert-head', 'refs/claudekei/s1/u1', 'refs/claudekei/s1/u2', 'refs/claudekei/s1/u3']);
    await fh.drop('s1', 'u2');
    expect(refs(work, storage)).toEqual(['refs/claudekei/s1/u1']);
    const log = JSON.parse(readFileSync(join(storage, 'checkpoints', 's1.json'), 'utf8'));
    expect(log.checkpoints.map((c: { uuid: string }) => c.uuid)).toEqual(['u1']);
    await fh.remove('s1');
    expect(existsSync(join(storage, 'checkpoints', 's1.json'))).toBe(false);
    expect(refs(work, storage)).toEqual([]);
  });
});

const logOf = (storage: string, sid = 's1') => JSON.parse(readFileSync(join(storage, 'checkpoints', `${sid}.json`), 'utf8')) as { worktree: string; protected?: string[]; checkpoints: Array<{ uuid: string; tree: string; files?: string[] }> };
const root0 = process.platform === 'win32' || process.getuid?.() === 0;

describe.skipIf(!hasGit)('FileHistory review fixes', () => {
  test('H1: an end() issued while begin() runs does not close the new checkpoint', async () => {
    const { fh, w, storage } = setup();
    await fh.begin('s1', 'u1');
    await fh.end('s1');
    const begin = fh.begin('s1', 'u2'); // the message is not pushed yet
    const early = fh.end('s1'); // e.g. a publish() from a context-usage refresh
    await begin;
    await early;
    w('late.txt', 'written by the turn');
    await fh.end('s1');
    const u2 = logOf(storage).checkpoints.find((c) => c.uuid === 'u2')!;
    expect(u2.files).toEqual(['late.txt']);
  });

  test('H1: an end() queued for the previous checkpoint does not close the next one', async () => {
    const { fh, w, storage } = setup();
    await fh.begin('s1', 'u1');
    const staleEnd = fh.end('s1'); // belongs to u1
    const begin = fh.begin('s1', 'u2');
    await Promise.all([staleEnd, begin]);
    w('late.txt', 'x');
    await fh.end('s1');
    const cps = logOf(storage).checkpoints;
    expect(cps.find((c) => c.uuid === 'u1')!.files).toEqual([]);
    expect(cps.find((c) => c.uuid === 'u2')!.files).toEqual(['late.txt']);
  });

  test.skipIf(root0)('H2: a failing unrevert throws, keeps the redo head pinned and works after a retry', async () => {
    const { fh, w, work, storage, read } = setup();
    mkdirSync(join(work, 'sub'));
    await fh.begin('s1', 'u1');
    w('sub/f.txt', 'created by the turn');
    await fh.end('s1');
    const r = await fh.revert('s1', 'u1');
    expect(existsSync(join(work, 'sub', 'f.txt'))).toBe(false);
    expect(existsSync(join(work, 'sub'))).toBe(false); // G3: the emptied directory is pruned
    mkdirSync(join(work, 'sub'));
    chmodSync(join(work, 'sub'), 0o500);
    try {
      await expect(fh.unrevert('s1', 'u1', r.head!)).rejects.toThrow('could not be restored');
      expect(refs(work, storage)).toContain('refs/claudekei/s1/revert-head');
    } finally {
      chmodSync(join(work, 'sub'), 0o755);
    }
    expect(await fh.unrevert('s1', 'u1', r.head!)).toEqual({});
    expect(read('sub/f.txt')).toBe('created by the turn');
    expect(refs(work, storage)).not.toContain('refs/claudekei/s1/revert-head');
  });

  test('M7: an expired head or a missing checkpoint is reported as skipped, not thrown', async () => {
    const { fh } = setup();
    await fh.begin('s1', 'u1');
    await fh.end('s1');
    expect(await fh.unrevert('s1', 'u1', 'f'.repeat(40))).toEqual({ skipped: 'the file snapshots for this message have expired' });
    expect((await fh.unrevert('s1', 'nope', 'f'.repeat(40))).skipped).toBeDefined();
  });

  test('M1: when restoring throws, the head is still returned', async () => {
    const { fh, w } = setup();
    await fh.begin('s1', 'u1');
    w('a.txt', 'a');
    await fh.end('s1');
    (fh as unknown as { snap: { restore: () => Promise<never> } }).snap.restore = async () => {
      throw new Error('boom');
    };
    const r = await fh.revert('s1', 'u1');
    expect(r.filesError).toBe('boom');
    expect(r.head).toMatch(/^[0-9a-f]{40,}$/);
  });

  test('M2: a planned file that grew past the size limit is neither overwritten nor deleted, and is reported', async () => {
    const { fh, w, work, read } = setup();
    await fh.begin('s1', 'u1');
    w('big.txt', 'small');
    w('x.txt', 'x1');
    w('big.txt', 'medium');
    await fh.end('s1');
    await fh.begin('s1', 'u2');
    writeFileSync(join(work, 'big.txt'), Buffer.alloc(11 * 1024 * 1024, 7)); // over the 10 MiB default: not snapshotted
    w('x.txt', 'x2');
    await fh.end('s1');
    const r = await fh.revert('s1', 'u1');
    expect(r.filesError).toContain('left unchanged');
    expect(r.filesError).toContain('big.txt');
    expect(readFileSync(join(work, 'big.txt')).length).toBe(11 * 1024 * 1024);
    expect(existsSync(join(work, 'x.txt'))).toBe(false); // created by u1: restored (deleted)
    expect(read('seed.txt')).toBe('seed\n');
    // /redo must not replace the 11 MiB file with the stale small copy the head snapshot holds
    expect(await fh.unrevert('s1', 'u1', r.head!)).toEqual({});
    expect(readFileSync(join(work, 'big.txt')).length).toBe(11 * 1024 * 1024);
    expect(read('x.txt')).toBe('x2');
  });

  test('M2/preview: files a revert would leave alone are neither listed nor counted', async () => {
    const { fh, w, work } = setup();
    await fh.begin('s1', 'u1');
    w('big.txt', 'small');
    w('x.txt', 'x1');
    w('big.txt', 'medium');
    await fh.end('s1');
    await fh.begin('s1', 'u2');
    writeFileSync(join(work, 'big.txt'), Buffer.alloc(11 * 1024 * 1024, 7));
    await fh.end('s1');
    const preview = await fh.preview('s1', 'u1');
    expect(preview.files).toEqual([join(work, 'x.txt')]);
    expect(preview.insertions).toBe(1);
    expect(preview.filesError).toContain('big.txt');
  });

  test('M2: the protected list is forgotten once /redo ran or the checkpoints were dropped', async () => {
    const { fh, w, work, storage } = setup();
    await fh.begin('s1', 'u1');
    w('big.txt', 'small');
    w('big.txt', 'medium');
    await fh.end('s1');
    await fh.begin('s1', 'u2');
    writeFileSync(join(work, 'big.txt'), Buffer.alloc(11 * 1024 * 1024, 7));
    await fh.end('s1');
    const r = await fh.revert('s1', 'u1');
    expect(logOf(storage).protected).toEqual(['big.txt']);
    await fh.unrevert('s1', 'u1', r.head!);
    expect(logOf(storage).protected).toBeUndefined();
    await fh.revert('s1', 'u1');
    expect(logOf(storage).protected).toEqual(['big.txt']);
    await fh.drop('s1', 'u1');
    expect(logOf(storage).protected).toBeUndefined();
  });

  test('M4: an open checkpoint whose tree is gone does not break begin; a log of another worktree is ignored', async () => {
    const { fh, make, storage, work } = setup();
    await fh.begin('s1', 'u1');
    await fh.end('s1');
    const log = logOf(storage);
    writeFileSync(join(storage, 'checkpoints', 's1.json'), JSON.stringify({ ...log, checkpoints: [{ uuid: 'u1', tree: '0'.repeat(40) }] }));
    const fresh = make();
    await fresh.begin('s1', 'u2');
    const cps = logOf(storage).checkpoints;
    expect(cps.map((c) => c.uuid)).toEqual(['u1', 'u2']);
    expect(cps[0]!.files).toEqual([]);

    writeFileSync(join(storage, 'checkpoints', 's2.json'), JSON.stringify({ version: 1, worktree: '/somewhere/else', checkpoints: [{ uuid: 'old', tree: '1'.repeat(40) }] }));
    await make().begin('s2', 'new');
    expect(logOf(storage, 's2').checkpoints.map((c) => c.uuid)).toEqual(['new']);
    expect(work).toBeDefined();
  });

  test('L4: a failing env() is not remembered', async () => {
    const { work, storage, w, read } = setup();
    let calls = 0;
    const fh = new FileHistory({ storageDir: storage, cwd: work, env: async () => (++calls === 1 ? Promise.reject(new Error('no env yet')) : process.env), enabled: () => true, log: () => undefined });
    await fh.begin('s1', 'u1'); // swallowed: no checkpoint
    expect(existsSync(join(storage, 'checkpoints', 's1.json'))).toBe(false);
    await fh.begin('s1', 'u1');
    w('a.txt', 'a');
    await fh.end('s1');
    await fh.revert('s1', 'u1');
    expect(existsSync(join(work, 'a.txt'))).toBe(false);
    expect(read('seed.txt')).toBe('seed\n');
  });

  test('L4: an unavailable store is probed again on an explicit revert', async () => {
    const { work, storage } = setup(false);
    const fh = new FileHistory({ storageDir: storage, cwd: work, env: async () => process.env, enabled: () => true, log: () => undefined });
    expect((await fh.revert('s1', 'u1')).filesError).toBe('the workspace is not a Git repository');
    sh(work, 'init', '--quiet'); // now it is one
    expect((await fh.revert('s1', 'u1')).filesError).toBe('no file snapshot was taken when this message was sent');
  });

  test.skipIf(process.platform === 'win32')('L5: paths follow the cwd even when it is a symlink to the repository', async () => {
    const { work, storage } = setup();
    const link = join(work, '..', 'link-to-work');
    symlinkSync(work, link);
    const fh = new FileHistory({ storageDir: storage, cwd: link, env: async () => process.env, enabled: () => true, log: () => undefined });
    await fh.begin('s1', 'u1');
    writeFileSync(join(work, 'a.txt'), 'a');
    await fh.end('s1');
    const preview = await fh.preview('s1', 'u1');
    expect(preview.files).toEqual([join(link, 'a.txt')]);
  });

  test('L2: drop removes exactly the dropped refs (u1 survives a drop from u10)', async () => {
    const { fh, work, storage } = setup();
    for (const u of ['u1', 'u10', 'u11']) {
      await fh.begin('s1', u);
      await fh.end('s1');
    }
    await fh.drop('s1', 'u10');
    expect(refs(work, storage)).toEqual(['refs/claudekei/s1/u1']);
  });

  test('L3: dropping the open checkpoint forgets it', async () => {
    const { fh, w, storage } = setup();
    await fh.begin('s1', 'u1');
    await fh.end('s1');
    await fh.begin('s1', 'u2');
    await fh.drop('s1', 'u2');
    w('a.txt', 'x');
    await fh.end('s1'); // nothing open any more: must not touch the log
    expect(logOf(storage).checkpoints.map((c) => c.uuid)).toEqual(['u1']);
  });

  test('G1/G2: audit maps paths through the cwd form, flags outside/ignored ones and ignores restorable ones', async () => {
    const { fh, w, work } = setup();
    w('.gitignore', 'ignored.txt\n');
    await fh.begin('s1', 'u1');
    expect(await fh.audit([join(work, 'a.txt'), join(work, 'ignored.txt'), '/elsewhere/x.ts', 'relative.ts', join(work, 'sub', '..', 'a.txt')])).toEqual(['/elsewhere/x.ts', join(work, 'ignored.txt')]);
    expect(await fh.audit([])).toEqual([]);
  });

  test('G1/G2: audit is empty when the store is unavailable', async () => {
    const { fh } = setup(false);
    expect(await fh.audit(['/elsewhere/x.ts'])).toEqual([]);
  });

  test('G4/reopen: no-op without checkpoints or while one is open; a closed last checkpoint is recomputed from its start at the next close', async () => {
    const { fh, w, storage } = setup();
    await fh.reopen('s1'); // nothing to reopen
    expect(existsSync(join(storage, 'checkpoints', 's1.json'))).toBe(false);
    await fh.begin('s1', 'u1');
    w('a.txt', 'a');
    await fh.reopen('s1'); // already open
    expect(logOf(storage).checkpoints[0]!.files).toBeUndefined();
    await fh.end('s1');
    expect(logOf(storage).checkpoints[0]!.files).toEqual(['a.txt']);
    const reopened = fh.reopen('s1');
    const early = fh.end('s1'); // issued before the reopen finished: chained behind it, not dropped
    await Promise.all([reopened, early]);
    w('b.txt', 'b'); // after the close ...
    await fh.reopen('s1');
    expect(logOf(storage).checkpoints[0]!.files).toBeUndefined(); // ... reopened: persisted as open
    await fh.end('s1');
    expect(logOf(storage).checkpoints[0]!.files!.sort()).toEqual(['a.txt', 'b.txt']);
  });

  test('G4/reopen: a revert closes it for good and a drop of it forgets it', async () => {
    const { fh, w, storage } = setup();
    await fh.begin('s1', 'u1');
    w('a.txt', 'a');
    await fh.end('s1');
    await fh.reopen('s1');
    await fh.revert('s1', 'u1'); // closes the reopened checkpoint with the head
    expect(logOf(storage).checkpoints[0]!.files).toEqual(['a.txt']);
    await fh.reopen('s1');
    await fh.drop('s1', 'u1');
    await fh.end('s1'); // nothing open any more
    expect(logOf(storage).checkpoints).toEqual([]);
  });
});
