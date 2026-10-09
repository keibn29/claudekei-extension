import { describe, expect, test } from 'bun:test';
import { normalizeAgentName, resolveDefaultAgent } from './agentSettings';

const files = (map: Record<string, string>) => (p: string) => {
  if (p in map) return map[p]!;
  throw new Error('ENOENT');
};

describe('resolveDefaultAgent', () => {
  const known = ['claudekei:orchestrator', 'claudekei:planner', 'general-purpose'];

  test('precedence: local > project > user', () => {
    const readFile = files({
      '/w/.claude/settings.local.json': '{"agent":"claudekei:planner"}',
      '/w/.claude/settings.json': '{"agent":"claudekei:sprinter"}',
      '/h/.claude/settings.json': '{"agent":"claudekei:orchestrator"}',
    });
    expect(resolveDefaultAgent({ cwd: '/w', home: '/h', readFile, knownAgents: known })).toBe('claudekei:planner');
    delete (readFile as never as Record<string, unknown>)['x'];
    const noLocal = files({ '/w/.claude/settings.json': '{"agent":"claudekei:sprinter"}', '/h/.claude/settings.json': '{"agent":"claudekei:orchestrator"}' });
    expect(resolveDefaultAgent({ cwd: '/w', home: '/h', readFile: noLocal })).toBe('claudekei:sprinter');
    const userOnly = files({ '/h/.claude/settings.json': '{"agent":"claudekei:orchestrator"}' });
    expect(resolveDefaultAgent({ cwd: '/w', home: '/h', readFile: userOnly })).toBe('claudekei:orchestrator');
  });

  test('skips files without an agent, tolerates JSONC and broken files', () => {
    const readFile = files({
      '/w/.claude/settings.local.json': '{ not json',
      '/w/.claude/settings.json': '// comment\n{"model":"x"}',
      '/h/.claude/settings.json': '{\n // c\n "agent": "orchestrator",\n}',
    });
    expect(resolveDefaultAgent({ cwd: '/w', home: '/h', readFile, knownAgents: known })).toBe('claudekei:orchestrator');
  });

  test('nothing configured -> undefined', () => {
    expect(resolveDefaultAgent({ cwd: '/w', home: '/h', readFile: files({}) })).toBeUndefined();
  });
});

test('normalizeAgentName', () => {
  const known = ['claudekei:orchestrator', 'explorer'];
  expect(normalizeAgentName('orchestrator', known)).toBe('claudekei:orchestrator');
  expect(normalizeAgentName('explorer', known)).toBe('explorer');
  expect(normalizeAgentName('claudekei:orchestrator', known)).toBe('claudekei:orchestrator');
  expect(normalizeAgentName('unknown', known)).toBe('unknown');
  expect(normalizeAgentName(' orchestrator ', undefined)).toBe('orchestrator');
});
