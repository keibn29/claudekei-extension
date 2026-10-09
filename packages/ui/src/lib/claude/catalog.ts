/**
 * Pure helpers that turn the host `Catalog` (SDK models/commands/agents) into the shapes the
 * existing UI stores and sync state expect (Provider/Model/Agent/Command).
 */

import { matchCatalogModel } from './modelNames';
import {
  ANTHROPIC_PROVIDER_ID,
  type Agent,
  type Catalog,
  type Command,
  type Model,
  type ModelInfo,
  type Provider,
} from './types';

type ContextLimit = { context: number; output: number };

/** Static context-window table (Phase 1): `getContextUsage()` is not wired yet. */
const DEFAULT_CONTEXT_LIMIT: ContextLimit = { context: 200_000, output: 32_000 };
const CONTEXT_LIMIT_BY_FAMILY: Array<{ match: RegExp; limit: ContextLimit }> = [
  { match: /opus/i, limit: { context: 200_000, output: 32_000 } },
  { match: /sonnet/i, limit: { context: 200_000, output: 64_000 } },
  { match: /haiku/i, limit: { context: 200_000, output: 64_000 } },
];
const EXTENDED_CONTEXT_LIMIT = 1_000_000;

/** Resolve the `limit` block for a model alias or id (`sonnet`, `opus[1m]`, `claude-haiku-4-5`, ...). */
export const resolveModelLimit = (info: Pick<ModelInfo, 'value' | 'resolvedModel'> & { contextWindow?: number }): ContextLimit => {
  const haystack = `${info.value} ${info.resolvedModel ?? ''}`;
  const family = CONTEXT_LIMIT_BY_FAMILY.find((entry) => entry.match.test(haystack));
  const base = family?.limit ?? DEFAULT_CONTEXT_LIMIT;
  // The host measures the real window per model (`ModelInfo.contextWindow`); the static table is only the fallback.
  if (typeof info.contextWindow === 'number' && info.contextWindow > 0) return { ...base, context: info.contextWindow };
  return /\[1m\]/i.test(haystack) ? { ...base, context: EXTENDED_CONTEXT_LIMIT } : base;
};

const resolveFamily = (info: Pick<ModelInfo, 'value' | 'resolvedModel'>): string | undefined => {
  const haystack = `${info.value} ${info.resolvedModel ?? ''}`.toLowerCase();
  if (haystack.includes('opus')) return 'opus';
  if (haystack.includes('sonnet')) return 'sonnet';
  if (haystack.includes('haiku')) return 'haiku';
  return undefined;
};

export const toModel = (info: ModelInfo): Model => ({
  id: info.value,
  providerID: ANTHROPIC_PROVIDER_ID,
  name: info.displayName || info.value,
  family: resolveFamily(info),
  description: info.description,
  capabilities: {
    temperature: false,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: { text: true, audio: false, image: true, video: false, pdf: true },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: true,
  },
  limit: resolveModelLimit(info),
  status: 'active',
  claude: info,
});

/** Single synthetic `anthropic` provider holding every catalog model. */
export const buildAnthropicProvider = (catalog: Pick<Catalog, 'models'>): Provider => {
  const models: Record<string, Model> = {};
  for (const info of catalog.models) {
    models[info.value] = toModel(info);
  }
  return {
    id: ANTHROPIC_PROVIDER_ID,
    name: 'Anthropic',
    source: 'api',
    env: [],
    options: {},
    models,
  };
};

/**
 * Theme color names (see `agentColors.ts`) assigned to agents the host gives no color, i.e. every subagent.
 * Keyed by the bare agent name, so `explorer` and `claudekei:explorer` share a color and a given agent always
 * renders the same everywhere (type chips on subagent cards, group rows, child session header).
 */
const FALLBACK_AGENT_COLOR_NAMES = ['cyan', 'pink', 'red', 'yellow', 'green', 'blue', 'purple', 'orange'] as const;

export const fallbackAgentColorName = (agentName: string): string => {
  const bare = (agentName.includes(':') ? agentName.slice(agentName.lastIndexOf(':') + 1) : agentName).toLowerCase();
  let hash = 0;
  for (let index = 0; index < bare.length; index += 1) {
    hash = (hash * 31 + bare.charCodeAt(index)) >>> 0;
  }
  return FALLBACK_AGENT_COLOR_NAMES[hash % FALLBACK_AGENT_COLOR_NAMES.length];
};

/**
 * Plugin primary agents (`mode: 'primary'`, in cycling order) followed by every other catalog agent
 * as a subagent. Permission modes are not agents.
 */
export const buildAgents = (catalog: Pick<Catalog, 'agents' | 'primaryAgents'> & Partial<Pick<Catalog, 'models'>>): Agent[] => {
  const primary = catalog.primaryAgents.map<Agent>((agent) => {
    // The agent's default model (alias or full id) becomes its configured model, which `setAgent` applies right away.
    const defaultModel = matchCatalogModel(catalog.models ?? [], agent.defaultModel);
    return {
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      color: agent.color,
      mode: 'primary',
      native: true,
      permission: [],
      options: {},
      ...(defaultModel ? { model: { providerID: ANTHROPIC_PROVIDER_ID, modelID: defaultModel.value } } : {}),
    };
  });
  const primaryNames = new Set(catalog.primaryAgents.map((agent) => agent.name));
  const subagents = catalog.agents.filter((agent) => !primaryNames.has(agent.name)).map<Agent>((agent) => ({
    name: agent.name,
    description: agent.description,
    color: fallbackAgentColorName(agent.name),
    mode: 'subagent',
    native: true,
    permission: [],
    options: {},
    ...(agent.model && agent.model !== 'inherit' ? { model: { providerID: ANTHROPIC_PROVIDER_ID, modelID: agent.model } } : {}),
  }));
  return [...primary, ...subagents];
};

/** Slash commands in the legacy `Command` shape the sync state still stores. */
export const buildCommands = (catalog: Pick<Catalog, 'commands'>): Command[] =>
  catalog.commands.map<Command>((command) => ({
    name: command.name,
    description: command.description,
    source: command.builtin ? 'command' : 'skill',
    template: '',
    hints: command.argumentHint ? [command.argumentHint] : [],
  }));

const AGENT_DESCRIPTION_MAX_CHARS = 90;

/**
 * One sentence for agent pickers, tooltips and @mention lists. Plugin descriptions are long and carry a
 * "(claudekei primary agent)" marker: the marker and everything after the first sentence are dropped
 * ("Delegation-first coding coordinator (claudekei primary agent). Routes work to ..." ->
 * "Delegation-first coding coordinator."). Capped at ~90 characters with an ellipsis.
 */
export const shortAgentDescription = (description: string | undefined | null, maxChars: number = AGENT_DESCRIPTION_MAX_CHARS): string => {
  if (!description) return '';
  const cleaned = description
    .replace(/\s*\([^)]*primary agent[^)]*\)/gi, '')
    .replace(/\s+/g, (space) => (space.includes('\n') ? '\n' : ' '))
    .trim();
  // First sentence: up to a terminator followed by a capitalised word (so "e.g. foo" does not split), or a newline.
  const match = cleaned.match(/^[\s\S]*?(?:[.!?](?=\s+[A-Z0-9"'`(])|[.!?]$|\n)/);
  const sentence = (match ? match[0] : cleaned).trim();
  if (sentence.length <= maxChars) return sentence;
  return `${sentence.slice(0, maxChars - 1).trimEnd()}…`;
};
