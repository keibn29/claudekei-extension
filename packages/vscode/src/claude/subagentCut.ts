/**
 * Rolls subagent transcripts back together with a committed revert (docs/REVERT_SPEC.md, "Subagent context").
 *
 * Claude Code keeps every subagent as `<project>/<sessionId>/subagents/agent-<agentId>.jsonl` (+ `.meta.json`) and
 * reloads the whole file when the agent is resumed through SendMessage, so `resumeSessionAt` (which only cuts the
 * main message list) leaves reverted work in their context. Every user entry of the main and the subagent transcripts
 * carries the `promptId` of the main user turn it ran under; assistant / attachment entries carry none. Lines are
 * therefore attributed to a turn by their own `promptId`, or, for chain entries without one, by the nearest preceding
 * line that has one in the same file. Pure logic over an injectable fs; the process must be closed while it runs.
 */
import { promises as nodeFs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { encodeProjectDir } from './subagentMeta';

export type CutFs = {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
};

export const nodeCutFs: CutFs = {
  readFile: (p) => nodeFs.readFile(p, 'utf8'),
  writeFile: (p, d) => nodeFs.writeFile(p, d),
  rename: (a, b) => nodeFs.rename(a, b),
  rm: (p) => nodeFs.rm(p, { force: true }),
  readdir: (p) => nodeFs.readdir(p),
};

export type TranscriptPaths = { main: string; subagents: string };

export function transcriptPaths(o: { home?: string; cwd: string; sessionId: string }): TranscriptPaths {
  const project = join(o.home ?? homedir(), '.claude', 'projects', encodeProjectDir(o.cwd));
  return { main: join(project, `${o.sessionId}.jsonl`), subagents: join(project, o.sessionId, 'subagents') };
}

type Entry = Record<string, unknown>;

const parseLine = (line: string): Entry | undefined => {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' ? (value as Entry) : undefined;
  } catch {
    return undefined;
  }
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const splitLines = (text: string): string[] => text.split('\n').filter((l) => l.trim() !== '');

/**
 * `promptId`s of the reverted turns: that of the target user entry and of every non-sidechain user entry at or after it
 * in the main transcript, minus the ids of any main user entry before it. Returns undefined when the transcript or the target entry cannot be found (nothing to cut by).
 */
export async function revertedPromptIds(mainPath: string, targetUuid: string, fs: CutFs = nodeCutFs): Promise<string[] | undefined> {
  let text: string;
  try {
    text = await fs.readFile(mainPath);
  } catch {
    return undefined;
  }
  const entries = splitLines(text).map(parseLine);
  const start = entries.findIndex((e) => e?.type === 'user' && e.uuid === targetUuid && e.isSidechain !== true);
  if (start < 0) return undefined;
  const promptOf = (e: Entry | undefined) => (e?.type === 'user' && e.isSidechain !== true ? str(e.promptId) : undefined);
  // A later entry can carry an earlier turn's promptId (a prompt queued during that turn is injected under it): such a
  // turn started before the target and is kept, so ids seen before the target are never reverted.
  const kept = new Set<string>();
  for (const e of entries.slice(0, start)) {
    const id = promptOf(e);
    if (id) kept.add(id);
  }
  const ids = new Set<string>();
  for (const e of entries.slice(start)) {
    const id = promptOf(e);
    if (id && !kept.has(id)) ids.add(id);
  }
  return [...ids];
}

export type CutResult = {
  /** Subagents whose transcript (and meta file) was deleted because nothing was left. */
  removed: string[];
  /** Subagents whose transcript lost reverted lines but kept earlier ones. */
  trimmed: string[];
  /** Kept lines whose `parentUuid` pointed at a dropped line and was re-pointed (only when the dropped lines were not a suffix). */
  relinked: number;
  failed: Array<{ file: string; error: string }>;
};

const AGENT_FILE = /^agent-(.+)\.jsonl$/;

/**
 * Drops every chain line attributed to one of `promptIds` from each `agent-*.jsonl` in `dir`. A file left without chain
 * lines is deleted with its meta file. Appends are chronological, so dropped lines are normally a suffix and the
 * `parentUuid` chain of the rest stays valid; if one is not (interleaved turns), the kept lines are re-pointed to their
 * nearest kept ancestor. Idempotent: a second run finds nothing to drop and writes nothing.
 */
export async function trimSubagents(dir: string, promptIds: ReadonlyArray<string>, fs: CutFs = nodeCutFs, options: { dryRun?: boolean } = {}): Promise<CutResult> {
  const result: CutResult = { removed: [], trimmed: [], relinked: 0, failed: [] };
  if (promptIds.length === 0) return result;
  const reverted = new Set(promptIds);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return result; // no subagents directory
  }
  for (const name of files) {
    const agentId = AGENT_FILE.exec(name)?.[1];
    if (!agentId) continue;
    const path = join(dir, name);
    try {
      const lines = splitLines(await fs.readFile(path));
      const entries = lines.map(parseLine);
      const drop = entries.map(() => false);
      let current: string | undefined;
      let droppedAny = false;
      entries.forEach((e, i) => {
        if (!e) {
          drop[i] = droppedAny; // an unparsable line after a dropped one is a truncated tail of the reverted turn
          return;
        }
        const own = str(e.promptId);
        if (own) current = own;
        const owner = own ?? (str(e.uuid) ? current : undefined); // entries without a uuid are metadata: never inherited
        drop[i] = owner !== undefined && reverted.has(owner);
        if (drop[i]) droppedAny = true;
      });
      if (!drop.some(Boolean)) continue;

      const keptChain = entries.filter((e, i) => !drop[i] && e && str(e.uuid)).length;
      if (keptChain === 0) {
        if (!options.dryRun) {
          await fs.rm(path);
          await fs.rm(join(dir, `agent-${agentId}.meta.json`));
        }
        result.removed.push(agentId);
        continue;
      }
      const parentOf = new Map<string, string | undefined>();
      const droppedUuids = new Set<string>();
      entries.forEach((e, i) => {
        const uuid = e && str(e.uuid);
        if (uuid) parentOf.set(uuid, str(e!.parentUuid));
        if (uuid && drop[i]) droppedUuids.add(uuid);
      });
      const kept: string[] = [];
      lines.forEach((line, i) => {
        if (drop[i]) return;
        const e = entries[i];
        const parent = e && str(e.parentUuid);
        if (e && parent && droppedUuids.has(parent)) {
          let up: string | undefined = parent;
          while (up && droppedUuids.has(up)) up = parentOf.get(up);
          kept.push(JSON.stringify({ ...e, parentUuid: up ?? null }));
          result.relinked++;
        } else {
          kept.push(line);
        }
      });
      if (!options.dryRun) {
        const tmp = `${path}.${process.pid}.tmp`;
        await fs.writeFile(tmp, kept.join('\n') + '\n');
        await fs.rename(tmp, path);
      }
      result.trimmed.push(agentId);
    } catch (error) {
      result.failed.push({ file: name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
