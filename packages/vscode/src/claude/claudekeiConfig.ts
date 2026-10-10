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

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Reads one `{ name: { model, effort } }` table into `into` (a later entry of the same name replaces the earlier one). */
function readTable(table: unknown, into: Record<string, AgentPreset>): void {
  if (!isRecord(table)) return;
  for (const [key, value] of Object.entries(table)) {
    if (!isRecord(value)) continue;
    const name = key.includes(':') ? key.trim() : `${PLUGIN_PREFIX}${key.trim()}`;
    const { model, effort } = value;
    const next: AgentPreset = {};
    if (typeof model === 'string' && model.trim()) next.model = model.trim();
    if (isEffort(effort)) next.effort = effort;
    if (next.model !== undefined || next.effort !== undefined) into[name] = next;
  }
}

/**
 * Presets keyed by full agent type (`claudekei:planner`) from one table: `primaryAgents` or the subagents (`subAgents`,
 * plus the deprecated `presets`, which `subAgents` overrides within one file). Files merge per field, project last.
 * Missing or malformed files and fields are ignored.
 */
function readPresetTables(options: ClaudekeiConfigOptions, keys: readonly string[]): Record<string, AgentPreset> {
  const read = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const merged: Record<string, AgentPreset> = {};
  for (const file of claudekeiConfigPaths(options)) {
    let raw: string;
    try {
      raw = read(file);
    } catch {
      continue;
    }
    const parsed = parseJsonc(raw, undefined, { allowTrailingComma: true, disallowComments: false }) as Record<string, unknown> | undefined;
    if (!isRecord(parsed)) continue;
    const fileAgents: Record<string, AgentPreset> = {};
    for (const key of keys) readTable(parsed[key], fileAgents);
    for (const [name, preset] of Object.entries(fileAgents)) merged[name] = { ...merged[name], ...preset };
  }
  return merged;
}

/** Primary-agent presets keyed by full agent type (`claudekei:planner`). */
export function readAgentPresets(options: ClaudekeiConfigOptions): Record<string, AgentPreset> {
  return readPresetTables(options, ['primaryAgents']);
}

/** Subagent presets (`subAgents`, deprecated `presets`) keyed by full agent type: what the plugin's hook applies to the Agent tool. */
export function readSubagentPresets(options: ClaudekeiConfigOptions): Record<string, AgentPreset> {
  return readPresetTables(options, ['presets', 'subAgents']);
}
