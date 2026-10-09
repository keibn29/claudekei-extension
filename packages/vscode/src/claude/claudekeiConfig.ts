/**
 * Per-agent model / effort presets from the claudekei plugin config:
 * `~/.claude/claudekei.jsonc` and `<cwd>/.claude/claudekei.jsonc` (JSONC; the project file wins per field).
 *
 * ```jsonc
 * { "primaryAgents": { "planner": { "model": "opus", "effort": "high" } } }
 * ```
 * Keys are bare agent names (`planner` -> `claudekei:planner`); a prefixed key is accepted too.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { EFFORT_LEVELS, type EffortLevel } from '@openchamber/ui/src/lib/claude/types';

const PLUGIN_PREFIX = 'claudekei:';

export type AgentPreset = { model?: string; effort?: EffortLevel };

export type ClaudekeiConfigOptions = {
  cwd: string;
  home?: string;
  readFile?: (path: string) => string;
};

/** The files read, user first then project (later ones win). */
export function claudekeiConfigPaths(options: Pick<ClaudekeiConfigOptions, 'cwd' | 'home'>): string[] {
  return [join(options.home ?? homedir(), '.claude', 'claudekei.jsonc'), join(options.cwd, '.claude', 'claudekei.jsonc')];
}

const isEffort = (value: unknown): value is EffortLevel => typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);

/** Presets keyed by full agent type (`claudekei:planner`). Missing or malformed files and fields are ignored. */
export function readAgentPresets(options: ClaudekeiConfigOptions): Record<string, AgentPreset> {
  const read = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const merged: Record<string, AgentPreset> = {};
  for (const file of claudekeiConfigPaths(options)) {
    let raw: string;
    try {
      raw = read(file);
    } catch {
      continue;
    }
    const parsed = parseJsonc(raw, undefined, { allowTrailingComma: true, disallowComments: false }) as { primaryAgents?: unknown } | undefined;
    const agents = parsed?.primaryAgents;
    if (!agents || typeof agents !== 'object' || Array.isArray(agents)) continue;
    for (const [key, value] of Object.entries(agents as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const name = key.includes(':') ? key.trim() : `${PLUGIN_PREFIX}${key.trim()}`;
      const { model, effort } = value as { model?: unknown; effort?: unknown };
      const next: AgentPreset = {};
      if (typeof model === 'string' && model.trim()) next.model = model.trim();
      if (isEffort(effort)) next.effort = effort;
      if (next.model !== undefined || next.effort !== undefined) merged[name] = { ...merged[name], ...next };
    }
  }
  return merged;
}
