/**
 * Claude Code's own record of how a subagent was started:
 * `~/.claude/projects/<encoded cwd>/<parentSessionId>/subagents/agent-<agentId>.meta.json`
 * (`{ agentType, toolUseId, model, effort, ... }`). It reflects the Agent input after PreToolUse hooks (the claudekei
 * plugin's `updatedInput`), so it is the authoritative source for a subagent's model / effort. It may appear shortly
 * after the spawn; a missing file is simply "not known yet".
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EFFORT_LEVELS, type EffortLevel } from '@openchamber/ui/src/lib/claude/types';

export type SubagentMeta = { agentId: string; model?: string; effort?: EffortLevel };

export type SubagentMetaOptions = {
  cwd: string;
  sessionId: string;
  home?: string;
  /** Test hooks. */
  listDir?: (dir: string) => string[];
  readFile?: (path: string) => string;
};

/** Claude Code's project directory name: every non-alphanumeric character of the cwd becomes `-`. */
export const encodeProjectDir = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

const META_FILE = /^agent-(.+)\.meta\.json$/;

/** Looks up the meta of the subagent spawned by `toolUseId` (scans the subagents dir; reads one file when `agentId` is known). */
export function readSubagentMeta(toolUseId: string, agentId: string | undefined, options: SubagentMetaOptions): SubagentMeta | undefined {
  const read = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const list = options.listDir ?? ((d: string) => readdirSync(d));
  const dir = join(options.home ?? homedir(), '.claude', 'projects', encodeProjectDir(options.cwd), options.sessionId, 'subagents');
  const parse = (file: string): SubagentMeta | undefined => {
    const id = META_FILE.exec(file)?.[1];
    if (!id) return undefined;
    try {
      const meta = JSON.parse(read(join(dir, file))) as { toolUseId?: unknown; model?: unknown; effort?: unknown };
      if (meta.toolUseId !== toolUseId) return undefined;
      const model = typeof meta.model === 'string' && meta.model.trim() ? meta.model.trim() : undefined;
      const effort = EFFORT_LEVELS.find((level) => level === meta.effort);
      return { agentId: id, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
    } catch {
      return undefined;
    }
  };
  if (agentId) return parse(`agent-${agentId}.meta.json`);
  try {
    for (const file of list(dir)) {
      const found = parse(file);
      if (found) return found;
    }
  } catch {
    /* no subagents directory yet */
  }
  return undefined;
}
