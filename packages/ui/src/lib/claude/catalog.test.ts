import { describe, expect, test } from 'bun:test';
import { buildAgents, buildAnthropicProvider, buildCommands, fallbackAgentColorName, resolveModelLimit, shortAgentDescription } from './catalog';
import type { Catalog } from './types';

const catalog: Catalog = {
  models: [
    { value: 'default', displayName: 'Default', description: 'd' },
    { value: 'opus[1m]', displayName: 'Opus 1M', description: 'o', resolvedModel: 'claude-opus-x' },
    { value: 'haiku', displayName: 'Haiku', description: 'h' },
  ],
  commands: [
    { name: 'compact', description: 'Compact', argumentHint: '[focus]', builtin: true },
    { name: 'deploy', description: 'Custom', argumentHint: '' },
  ],
  agents: [
    { name: 'claudekei:orchestrator', description: 'Orchestrates (claudekei primary agent)' },
    { name: 'claudekei:planner', description: 'Plans (claudekei primary agent)' },
    { name: 'Explore', description: 'Explore code', model: 'haiku' },
    { name: 'general-purpose', description: 'General', model: 'inherit' },
  ],
  primaryAgents: [
    { name: 'claudekei:orchestrator', displayName: 'Orchestrator', color: 'purple', description: 'Orchestrates' },
    { name: 'claudekei:planner', displayName: 'Planner', color: 'blue', description: 'Plans' },
  ],
  defaults: { model: 'default', mode: 'default', agent: 'claudekei:orchestrator' },
};

describe('resolveModelLimit', () => {
  test('uses the static table and the 1M extended context marker', () => {
    expect(resolveModelLimit({ value: 'default' })).toEqual({ context: 200_000, output: 32_000 });
    expect(resolveModelLimit({ value: 'haiku' })).toEqual({ context: 200_000, output: 64_000 });
    expect(resolveModelLimit({ value: 'opus[1m]' })).toEqual({ context: 1_000_000, output: 32_000 });
  });
});

describe('resolveModelLimit with a measured contextWindow', () => {
  test('the host-measured window wins over the static table', () => {
    expect(resolveModelLimit({ value: 'opus', contextWindow: 1_000_000 }).context).toBe(1_000_000);
    expect(resolveModelLimit({ value: 'sonnet', contextWindow: 500_000 })).toEqual({ context: 500_000, output: 64_000 });
    expect(resolveModelLimit({ value: 'opus[1m]', contextWindow: 200_000 }).context).toBe(200_000);
  });

  test('without it (or with a bogus value) the table applies', () => {
    expect(resolveModelLimit({ value: 'opus' }).context).toBe(200_000);
    expect(resolveModelLimit({ value: 'opus', contextWindow: 0 }).context).toBe(200_000);
  });

  test('providers built from the catalog carry the measured window', () => {
    const provider = buildAnthropicProvider({ models: [{ value: 'opus', displayName: 'Opus', description: '', contextWindow: 1_000_000 }, { value: 'haiku', displayName: 'Haiku', description: '' }] });
    expect(provider.models.opus.limit.context).toBe(1_000_000);
    expect(provider.models.haiku.limit.context).toBe(200_000);
  });
});

describe('buildAnthropicProvider', () => {
  test('builds one provider keyed by model value', () => {
    const provider = buildAnthropicProvider(catalog);
    expect(provider.id).toBe('anthropic');
    expect(Object.keys(provider.models)).toEqual(['default', 'opus[1m]', 'haiku']);
    expect(provider.models['opus[1m]'].limit.context).toBe(1_000_000);
    expect(provider.models['opus[1m]'].providerID).toBe('anthropic');
  });
});

describe('buildAgents', () => {
  test('exposes plugin primary agents in order, then every other agent as a subagent', () => {
    const agents = buildAgents(catalog);
    const primary = agents.filter((agent) => agent.mode === 'primary');
    expect(primary.map((agent) => agent.name)).toEqual(['claudekei:orchestrator', 'claudekei:planner']);
    expect(primary[0]).toMatchObject({ displayName: 'Orchestrator', color: 'purple' });
    const subagents = agents.filter((agent) => agent.mode === 'subagent');
    expect(subagents.map((agent) => agent.name)).toEqual(['Explore', 'general-purpose']);
    expect(subagents[0].model?.modelID).toBe('haiku');
    expect(subagents[1].model).toBeUndefined();
  });
});

describe('subagent colors', () => {
  test('every subagent gets a deterministic palette color', () => {
    const subagents = buildAgents(catalog).filter((agent) => agent.mode === 'subagent');
    for (const agent of subagents) {
      expect(typeof agent.color).toBe('string');
      expect(agent.color).toBe(fallbackAgentColorName(agent.name));
    }
  });

  test('the color depends on the bare name, not the plugin prefix', () => {
    expect(fallbackAgentColorName('claudekei:explorer')).toBe(fallbackAgentColorName('explorer'));
    expect(fallbackAgentColorName('Explorer')).toBe(fallbackAgentColorName('explorer'));
  });

  test('different agents spread over the palette', () => {
    const names = ['explorer', 'librarian', 'oracle', 'designer', 'debugger', 'frontend-developer', 'backend-developer'];
    expect(new Set(names.map(fallbackAgentColorName)).size).toBeGreaterThanOrEqual(4);
  });

  test('primary agents keep the host-provided color', () => {
    const primary = buildAgents(catalog).filter((agent) => agent.mode === 'primary');
    expect(primary.map((agent) => agent.color)).toEqual(['purple', 'blue']);
  });
});

describe('buildCommands', () => {
  test('maps slash commands to the legacy command shape', () => {
    const commands = buildCommands(catalog);
    expect(commands[0]).toMatchObject({ name: 'compact', hints: ['[focus]'], source: 'command' });
    expect(commands[1]).toMatchObject({ name: 'deploy', hints: [], source: 'skill' });
  });
});

describe('primary agent default model', () => {
  test('maps an agent default model (alias or full id) to its configured catalog model', () => {
    const withDefaults: Catalog = {
      ...catalog,
      models: [
        { value: 'default', displayName: 'Default', description: 'd' },
        { value: 'opus', displayName: 'Opus', description: 'o', resolvedModel: 'claude-opus-5-5' },
        { value: 'sonnet', displayName: 'Sonnet', description: 's', resolvedModel: 'claude-sonnet-4-5' },
      ],
      primaryAgents: [
        { name: 'claudekei:orchestrator', displayName: 'Orchestrator', color: 'purple', description: 'o', defaultModel: 'opus', defaultEffort: 'high' },
        { name: 'claudekei:planner', displayName: 'Planner', color: 'blue', description: 'p', defaultModel: 'claude-sonnet-4-5' },
        { name: 'claudekei:sprinter', displayName: 'Sprinter', color: 'green', description: 's' },
      ],
    };
    const primary = buildAgents(withDefaults).filter((agent) => agent.mode === 'primary');
    expect(primary[0].model).toEqual({ providerID: 'anthropic', modelID: 'opus' });
    expect(primary[1].model).toEqual({ providerID: 'anthropic', modelID: 'sonnet' });
    expect(primary[2].model).toBeUndefined();
  });
});

describe('shortAgentDescription', () => {
  test('drops the primary-agent marker and everything after the first sentence', () => {
    expect(shortAgentDescription('Delegation-first coding coordinator (claudekei primary agent). Routes work to specialist subagents, never edits.')).toBe('Delegation-first coding coordinator.');
    expect(shortAgentDescription('Interview-first planning agent (claudekei primary agent). Asks questions before building.')).toBe('Interview-first planning agent.');
    expect(shortAgentDescription('Fast self-executing coding agent (claudekei primary agent)')).toBe('Fast self-executing coding agent');
    expect(shortAgentDescription('Business analysis agent. (claudekei primary agent) More text here.')).toBe('Business analysis agent.');
  });

  test('descriptions without the marker keep their first sentence or first line', () => {
    expect(shortAgentDescription('Fast read-only codebase exploration. Use it for searching.')).toBe('Fast read-only codebase exploration.');
    expect(shortAgentDescription('First line only\nsecond line')).toBe('First line only');
    expect(shortAgentDescription('Uses e.g. grep and glob. Then more.')).toBe('Uses e.g. grep and glob.');
    expect(shortAgentDescription('No terminator at all')).toBe('No terminator at all');
  });

  test('caps long sentences with an ellipsis and handles empty input', () => {
    const long = `${'word '.repeat(40).trim()}.`;
    const short = shortAgentDescription(long);
    expect(short.length <= 90).toBe(true);
    expect(short.endsWith('…')).toBe(true);
    expect(shortAgentDescription(undefined)).toBe('');
    expect(shortAgentDescription('')).toBe('');
  });
});
