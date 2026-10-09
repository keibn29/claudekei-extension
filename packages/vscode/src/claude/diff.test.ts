import { describe, expect, test } from 'bun:test';
import {
  buildEditDiff,
  buildMultiEditDiff,
  buildWriteDiff,
  diffMetadata,
  fileDiffFromHunks,
  toRelativePath,
} from './diff';

const cwd = '/work/proj';

describe('toRelativePath', () => {
  test('inside / outside / relative', () => {
    expect(toRelativePath(cwd, '/work/proj/src/a.ts')).toBe('src/a.ts');
    expect(toRelativePath(cwd, '/other/a.ts')).toBe('/other/a.ts');
    expect(toRelativePath(cwd, 'src/a.ts')).toBe('src/a.ts');
    expect(toRelativePath(cwd, cwd)).toBe(cwd);
  });
});

describe('buildEditDiff', () => {
  const hunks = [
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [' export function greet() {', "-  return 'Hello, '", "+  return 'Hi, '", ' }'],
    },
  ];

  test('uses structuredPatch when present', () => {
    const diff = buildEditDiff(cwd, { filePath: '/work/proj/src/app.ts' }, { structuredPatch: hunks });
    expect(diff?.file).toBe('src/app.ts');
    expect(diff?.additions).toBe(1);
    expect(diff?.deletions).toBe(1);
    expect(diff?.patch.startsWith('--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,3 @@\n')).toBe(true);
  });

  test('synthesizes from old/new strings when no structuredPatch (history replay)', () => {
    const diff = buildEditDiff(cwd, { filePath: '/work/proj/a.txt', oldString: 'one\ntwo', newString: 'one\n2' });
    expect(diff).toBeDefined();
    expect(diff!.additions).toBe(1);
    expect(diff!.deletions).toBe(1);
    expect(diff!.patch).toContain('-two');
    expect(diff!.patch).toContain('+2');
  });

  test('falls back to synthesis when structuredPatch is empty', () => {
    const diff = buildEditDiff(cwd, { filePath: '/work/proj/a.txt', oldString: 'x', newString: 'y' }, { structuredPatch: [] });
    expect(diff?.additions).toBe(1);
  });

  test('identical strings produce no diff', () => {
    expect(buildEditDiff(cwd, { filePath: '/work/proj/a', oldString: 'x', newString: 'x' })).toBeUndefined();
  });
});

describe('buildWriteDiff', () => {
  test('create: all additions against /dev/null', () => {
    const diff = buildWriteDiff(cwd, { filePath: '/work/proj/docs/out.txt', content: 'a\nb\n' }, { type: 'create', structuredPatch: [], originalFile: null });
    expect(diff?.file).toBe('docs/out.txt');
    expect(diff?.additions).toBe(2);
    expect(diff?.deletions).toBe(0);
    expect(diff?.patch.startsWith('--- /dev/null\n+++ b/docs/out.txt\n@@ -0,0 +1,2 @@\n')).toBe(true);
  });

  test('update with originalFile diffs against it', () => {
    const diff = buildWriteDiff(cwd, { filePath: '/work/proj/a', content: 'a\nB\n' }, { type: 'update', structuredPatch: [], originalFile: 'a\nb\n' });
    expect(diff?.additions).toBe(1);
    expect(diff?.deletions).toBe(1);
    expect(diff?.patch.startsWith('--- a/a\n')).toBe(true);
  });

  test('empty content yields no diff', () => {
    expect(buildWriteDiff(cwd, { filePath: '/work/proj/e', content: '' }, { type: 'create', structuredPatch: [] })).toBeUndefined();
  });
});

test('buildMultiEditDiff concatenates the hunks of each edit', () => {
  const diff = buildMultiEditDiff(cwd, {
    filePath: '/work/proj/a.ts',
    edits: [
      { oldString: 'a', newString: 'b' },
      { oldString: 'c', newString: 'd' },
    ],
  });
  expect(diff?.additions).toBe(2);
  expect(diff?.deletions).toBe(2);
});

test('diffMetadata exposes diff, filediff and files', () => {
  const d = fileDiffFromHunks('a.ts', [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }])!;
  const meta = diffMetadata([d]) as { diff: string; filediff: { file: string }; files: Array<{ relativePath: string }> };
  expect(meta.diff).toBe(d.patch);
  expect(meta.filediff.file).toBe('a.ts');
  expect(meta.files[0]!.relativePath).toBe('a.ts');
  expect(diffMetadata([])).toEqual({});
});
