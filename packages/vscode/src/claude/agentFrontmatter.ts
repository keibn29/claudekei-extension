/**
 * `model` / `effort` declared in the frontmatter of subagent definitions (`.claude/agents/*.md`, `~/.claude/agents`,
 * plugin agents). The SDK's `AgentInfo` carries the model only, so the effort has to be read from the files.
 */
import { readConfigItem, listConfig, type ConfigFsOptions } from './claudeConfig';
import type { AgentPreset } from './claudekeiConfig';
import { EFFORT_LEVELS, type EffortLevel } from '@openchamber/ui/src/lib/claude/types';

const effortOf = (value: string | undefined): EffortLevel | undefined => EFFORT_LEVELS.find((level) => level === value?.trim().toLowerCase());

/** Definitions keyed by agent type (`planner`, `claudekei:planner`); a project agent wins over a user / plugin one. */
export async function loadAgentFrontmatter(options: ConfigFsOptions): Promise<Map<string, AgentPreset>> {
  const result = new Map<string, AgentPreset>();
  const { items } = await listConfig(options);
  // `listConfig` sorts project, user, plugin: the first definition of a name is the effective one.
  for (const item of items) {
    if (item.kind !== 'agent' || item.error || result.has(item.name)) continue;
    try {
      const { fields } = await readConfigItem(options, item.path);
      const model = fields.model?.trim();
      const effort = effortOf(fields.effort);
      result.set(item.name, { ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    } catch {
      // An unreadable definition simply contributes nothing.
    }
  }
  return result;
}
