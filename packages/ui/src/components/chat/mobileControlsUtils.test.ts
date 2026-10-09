import { describe, expect, test } from 'bun:test';
import { agentLabel, formatAgentName, getAgentDisplayName, getDefaultAgent } from './mobileControlsUtils';
import type { Agent } from '@/lib/claude/types';

const agent = (name: string, mode: Agent['mode'], displayName?: string): Agent => ({
  name,
  displayName,
  mode,
  permission: [],
  options: {},
});

describe('formatAgentName', () => {
  test('strips the plugin namespace and title-cases hyphenated names', () => {
    expect(formatAgentName('claudekei:orchestrator')).toBe('Orchestrator');
    expect(formatAgentName('claudekei:business-analyst')).toBe('Business Analyst');
    expect(formatAgentName('Explore')).toBe('Explore');
  });
});

describe('agentLabel', () => {
  test('prefers the host display name', () => {
    expect(agentLabel(agent('claudekei:planner', 'primary', 'The Planner'))).toBe('The Planner');
    expect(agentLabel(agent('claudekei:sprinter', 'primary'))).toBe('Sprinter');
  });
});

describe('getDefaultAgent / getAgentDisplayName', () => {
  const agents = [agent('Explore', 'subagent'), agent('claudekei:orchestrator', 'primary', 'Orchestrator'), agent('claudekei:planner', 'primary', 'Planner')];

  test('falls back to the first primary agent when no catalog default is known', () => {
    expect(getDefaultAgent(agents)?.name).toBe('claudekei:orchestrator');
    expect(getAgentDisplayName(agents)).toBe('Orchestrator');
    expect(getAgentDisplayName(agents, 'claudekei:planner')).toBe('Planner');
    expect(getAgentDisplayName(agents, 'claudekei:unknown')).toBe('Unknown');
  });
});
