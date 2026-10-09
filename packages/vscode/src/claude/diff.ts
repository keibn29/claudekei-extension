/**
 * Diff metadata for file-editing tools (docs/PHASE1_PLAN.md section 2, "Diffs").
 *
 * The UI reads `metadata.diff` (unified patch text) and `metadata.filediff = {file, additions, deletions, patch}`
 * (see `components/chat/changedFiles.ts` and `DiffPreview`). Live, Claude reports `tool_use_result.structuredPatch`;
 * in history replay (no `tool_use_result`) or when the patch is empty (Write create) the patch is synthesized from the
 * tool input with the `diff` package.
 */
import { isAbsolute, relative, sep } from 'node:path';
import { structuredPatch } from 'diff';

export type PatchHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

export type FileDiff = {
  /** Path relative to the workspace when inside it, otherwise as given. */
  file: string;
  additions: number;
  deletions: number;
  /** Unified diff text with `--- a/` / `+++ b/` headers and `@@` hunks. */
  patch: string;
};

/** Workspace-relative posix path when `filePath` is inside `cwd`, else the original path. */
export function toRelativePath(cwd: string, filePath: string): string {
  if (!filePath) return filePath;
  if (!isAbsolute(filePath)) return filePath;
  const rel = relative(cwd, filePath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return filePath;
  return sep === '/' ? rel : rel.split(sep).join('/');
}

function isHunk(value: unknown): value is PatchHunk {
  if (!value || typeof value !== 'object') return false;
  const h = value as Record<string, unknown>;
  return (
    typeof h.oldStart === 'number' &&
    typeof h.oldLines === 'number' &&
    typeof h.newStart === 'number' &&
    typeof h.newLines === 'number' &&
    Array.isArray(h.lines)
  );
}

/** Validates an untyped `structuredPatch` value; returns the hunks or `[]`. */
export function parseHunks(value: unknown): PatchHunk[] {
  return Array.isArray(value) ? value.filter(isHunk) : [];
}

function countLines(hunks: PatchHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
  }
  return { additions, deletions };
}

function formatHunk(hunk: PatchHunk): string {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
  return [header, ...hunk.lines].join('\n');
}

/** Builds a `FileDiff` from hunks. `isNew` writes `/dev/null` as the old side. */
export function fileDiffFromHunks(file: string, hunks: PatchHunk[], isNew = false): FileDiff | undefined {
  if (hunks.length === 0) return undefined;
  const { additions, deletions } = countLines(hunks);
  const patch = [isNew ? '--- /dev/null' : `--- a/${file}`, `+++ b/${file}`, ...hunks.map(formatHunk)].join('\n') + '\n';
  return { file, additions, deletions, patch };
}

/** Synthesizes hunks from two texts. */
export function hunksFromTexts(oldText: string, newText: string): PatchHunk[] {
  if (oldText === newText) return [];
  const result = structuredPatch('a', 'b', oldText, newText, '', '', { context: 3 });
  return result.hunks.map((h) => ({
    // Unified diff convention: an empty side (new file / emptied file) starts at line 0.
    oldStart: oldText === '' ? 0 : h.oldStart,
    oldLines: h.oldLines,
    newStart: newText === '' ? 0 : h.newStart,
    newLines: h.newLines,
    lines: [...h.lines],
  }));
}

/** Synthesized diff between two texts for `file`. */
export function fileDiffFromTexts(file: string, oldText: string, newText: string, isNew = false): FileDiff | undefined {
  return fileDiffFromHunks(file, hunksFromTexts(oldText, newText), isNew);
}

export type EditDiffInput = {
  filePath: string;
  oldString?: string;
  newString?: string;
};

/** Diff for an `Edit` call. Prefers Claude's `structuredPatch`, falls back to the tool input. */
export function buildEditDiff(cwd: string, input: EditDiffInput, toolUseResult?: unknown): FileDiff | undefined {
  const file = toRelativePath(cwd, input.filePath);
  const result = isRecord(toolUseResult) ? toolUseResult : undefined;
  const live = fileDiffFromHunks(file, parseHunks(result?.structuredPatch));
  if (live) return live;
  const oldText = typeof result?.oldString === 'string' ? result.oldString : (input.oldString ?? '');
  const newText = typeof result?.newString === 'string' ? result.newString : (input.newString ?? '');
  return fileDiffFromTexts(file, oldText, newText);
}

export type WriteDiffInput = { filePath: string; content?: string };

/** Diff for a `Write` call. `structuredPatch` is empty on create, so create is synthesized from the content. */
export function buildWriteDiff(cwd: string, input: WriteDiffInput, toolUseResult?: unknown): FileDiff | undefined {
  const file = toRelativePath(cwd, input.filePath);
  const result = isRecord(toolUseResult) ? toolUseResult : undefined;
  const live = fileDiffFromHunks(file, parseHunks(result?.structuredPatch));
  if (live) return live;
  const content = typeof result?.content === 'string' ? result.content : (input.content ?? '');
  const original = typeof result?.originalFile === 'string' ? result.originalFile : undefined;
  if (original !== undefined) return fileDiffFromTexts(file, original, content);
  return fileDiffFromTexts(file, '', content, true);
}

export type MultiEditDiffInput = {
  filePath: string;
  edits?: Array<{ oldString?: string; newString?: string }>;
};

/** Diff for a `MultiEdit` call (not present in current CLIs, kept for older ones): one file, several edits. */
export function buildMultiEditDiff(cwd: string, input: MultiEditDiffInput, toolUseResult?: unknown): FileDiff | undefined {
  const file = toRelativePath(cwd, input.filePath);
  const result = isRecord(toolUseResult) ? toolUseResult : undefined;
  const live = fileDiffFromHunks(file, parseHunks(result?.structuredPatch));
  if (live) return live;
  const hunks = (input.edits ?? []).flatMap((edit) => hunksFromTexts(edit.oldString ?? '', edit.newString ?? ''));
  return fileDiffFromHunks(file, hunks);
}

/** `metadata` fragment the renderers read: `diff`, `filediff` and `files`. */
export function diffMetadata(diffs: FileDiff[]): Record<string, unknown> {
  if (diffs.length === 0) return {};
  const first = diffs[0]!;
  return {
    diff: diffs.map((d) => d.patch).join('\n'),
    filediff: { file: first.file, additions: first.additions, deletions: first.deletions, patch: first.patch },
    files: diffs.map((d) => ({
      filePath: d.file,
      relativePath: d.file,
      additions: d.additions,
      deletions: d.deletions,
      patch: d.patch,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
