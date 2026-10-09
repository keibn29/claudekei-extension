/**
 * Effective default main-thread agent (plan amendment A1): the `agent` key of
 * `<cwd>/.claude/settings.local.json` -> `<cwd>/.claude/settings.json` -> `~/.claude/settings.json`.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';

const PLUGIN_PREFIX = 'claudekei:';

/** Normalizes `orchestrator` -> `claudekei:orchestrator` when only the prefixed agent exists in the catalog. */
export function normalizeAgentName(name: string, knownAgents: readonly string[] | undefined): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.includes(':') || !knownAgents) return trimmed;
  if (knownAgents.includes(trimmed)) return trimmed;
  const prefixed = `${PLUGIN_PREFIX}${trimmed}`;
  return knownAgents.includes(prefixed) ? prefixed : trimmed;
}

export type AgentSettingsOptions = {
  cwd: string;
  home?: string;
  /** Catalog agent names, used for prefix normalization. */
  knownAgents?: readonly string[];
  readFile?: (path: string) => string;
};

/** Returns the configured default agent (normalized) or undefined when no settings file defines one. */
export function resolveDefaultAgent(options: AgentSettingsOptions): string | undefined {
  const read = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const home = options.home ?? homedir();
  const files = [
    join(options.cwd, '.claude', 'settings.local.json'),
    join(options.cwd, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.json'),
  ];
  for (const file of files) {
    let raw: string;
    try {
      raw = read(file);
    } catch {
      continue;
    }
    const parsed = parseJsonc(raw) as { agent?: unknown } | undefined;
    if (parsed && typeof parsed.agent === 'string' && parsed.agent.trim()) {
      return normalizeAgentName(parsed.agent, options.knownAgents);
    }
  }
  return undefined;
}
