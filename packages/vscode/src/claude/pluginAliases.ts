/**
 * Read-only view of the claudekei Claude Code plugin's per-session state
 * (`~/.claude/plugins/data/<plugin>/sessions/<session_id>.json`, `children[{alias, agentId, agentType}]`).
 * The plugin registers aliases such as `exp-1` for subagents; the stream and transcript only carry the alias the
 * model typed, so this file is the one place that maps alias <-> agentId. Everything is optional: a missing or
 * unreadable file simply yields no aliases.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AliasResolver } from './mapper';

type PluginChild = { alias?: unknown; agentId?: unknown };

export type PluginAliasOptions = {
  home?: string;
  /** Test hooks. */
  listDirs?: (dir: string) => string[];
  readFile?: (path: string) => string;
};

/** Children recorded for a session across every claudekei plugin data directory (fresh read on each call). */
export function readPluginChildren(sessionId: string, options: PluginAliasOptions = {}): Array<{ alias: string; agentId: string }> {
  const home = options.home ?? homedir();
  const listDirs = options.listDirs ?? ((dir: string) => readdirSync(dir));
  const read = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const base = join(home, '.claude', 'plugins', 'data');
  let dirs: string[] = [];
  try {
    dirs = listDirs(base).filter((d) => /claudekei/i.test(d));
  } catch {
    return [];
  }
  const result: Array<{ alias: string; agentId: string }> = [];
  for (const dir of dirs) {
    try {
      const state = JSON.parse(read(join(base, dir, 'sessions', `${sessionId}.json`))) as { children?: PluginChild[] };
      for (const c of state.children ?? []) {
        if (typeof c.alias === 'string' && typeof c.agentId === 'string') result.push({ alias: c.alias, agentId: c.agentId });
      }
    } catch {
      /* no state for this session in this directory */
    }
  }
  return result;
}

export function pluginAliasResolver(sessionId: string, options: PluginAliasOptions = {}): AliasResolver {
  return {
    forAgent: (agentId) => readPluginChildren(sessionId, options).find((c) => c.agentId === agentId)?.alias,
    resolve: (alias) => readPluginChildren(sessionId, options).find((c) => c.alias === alias)?.agentId,
  };
}
