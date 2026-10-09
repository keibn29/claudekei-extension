import { describe, expect, test } from 'bun:test';
import {
  deriveAgentSwitchDividers,
  derivePendingAgentSwitch,
  findLatestUserAgent,
  hasUserMessage,
  planHostAdoption,
} from './agentSwitch';

describe('derivePendingAgentSwitch', () => {
  test('a new session has nothing pending: the agent is free to change', () => {
    expect(derivePendingAgentSwitch({ sessionStarted: false, selectedAgent: 'p', appliedAgent: undefined, busy: false }).pending).toBe(false);
  });

  test('a started session is pending when the selected agent differs from the one that ran the last message', () => {
    expect(derivePendingAgentSwitch({ sessionStarted: true, selectedAgent: 'planner', appliedAgent: 'orchestrator', busy: false })).toEqual({
      pending: true, from: 'orchestrator', to: 'planner', deferred: false,
    });
  });

  test('switching back (undo) clears the pending state', () => {
    expect(derivePendingAgentSwitch({ sessionStarted: true, selectedAgent: 'orchestrator', appliedAgent: 'orchestrator', busy: false }).pending).toBe(false);
  });

  test('a running turn defers the switch until the reply finishes', () => {
    expect(derivePendingAgentSwitch({ sessionStarted: true, selectedAgent: 'planner', appliedAgent: 'orchestrator', busy: true }).deferred).toBe(true);
  });

  test('unknown agents never produce a pending switch', () => {
    expect(derivePendingAgentSwitch({ sessionStarted: true, selectedAgent: undefined, appliedAgent: 'o', busy: false }).pending).toBe(false);
    expect(derivePendingAgentSwitch({ sessionStarted: true, selectedAgent: 'p', appliedAgent: undefined, busy: false }).pending).toBe(false);
  });

  test('the first message sent after a switch applies it (applied agent catches up)', () => {
    const before = derivePendingAgentSwitch({ sessionStarted: true, selectedAgent: 'planner', appliedAgent: 'orchestrator', busy: false });
    const afterSend = derivePendingAgentSwitch({ sessionStarted: true, selectedAgent: 'planner', appliedAgent: 'planner', busy: true });
    expect(before.pending).toBe(true);
    expect(afterSend.pending).toBe(false);
  });
});

describe('deriveAgentSwitchDividers', () => {
  test('puts a divider above a user message whose agent differs from the previous one', () => {
    const dividers = deriveAgentSwitchDividers([
      { id: 'u1', agent: 'orchestrator' },
      { id: 'u2', agent: 'orchestrator' },
      { id: 'u3', agent: 'planner' },
      { id: 'u4', agent: 'planner' },
      { id: 'u5', agent: 'orchestrator' },
    ]);
    expect([...dividers.entries()]).toEqual([
      ['u3', { from: 'orchestrator', to: 'planner' }],
      ['u5', { from: 'planner', to: 'orchestrator' }],
    ]);
  });

  test('the first message never gets a divider and agentless messages are skipped', () => {
    expect(deriveAgentSwitchDividers([{ id: 'u1', agent: 'a' }]).size).toBe(0);
    const dividers = deriveAgentSwitchDividers([{ id: 'u1', agent: 'a' }, { id: 'u2' }, { id: 'u3', agent: 'a' }, { id: 'u4', agent: '  ' }]);
    expect(dividers.size).toBe(0);
  });
});

describe('message helpers', () => {
  const messages = [
    { role: 'user', agent: 'orchestrator' },
    { role: 'assistant', agent: 'ignored' },
    { role: 'user', agent: 'planner' },
    { role: 'assistant' },
  ];
  test('latest user agent', () => {
    expect(findLatestUserAgent(messages)).toBe('planner');
    expect(findLatestUserAgent([{ role: 'assistant' }])).toBeUndefined();
    expect(findLatestUserAgent(undefined)).toBeUndefined();
  });

  test('has user message', () => {
    expect(hasUserMessage(messages)).toBe(true);
    expect(hasUserMessage([{ role: 'assistant' }])).toBe(false);
    expect(hasUserMessage(undefined)).toBe(false);
  });
});

describe('planHostAdoption (composer follows Session.agent / Session.model, e.g. after a reload)', () => {
  const known = { knownAgents: ['claudekei:orchestrator', 'claudekei:planner'], knownModels: ['default', 'opus', 'sonnet'] };

  test('a reload starts from a fresh memory: the first host values are adopted, not the catalog defaults', () => {
    const plan = planHostAdoption({ previous: { sessionId: null }, sessionId: 's1', hostAgent: 'claudekei:planner', hostModel: 'opus', ...known });
    expect(plan.agent).toBe('claudekei:planner');
    expect(plan.model).toBe('opus');
    expect(plan.next).toEqual({ sessionId: 's1', agent: 'claudekei:planner', model: 'opus' });
  });

  test('unchanged host values are not re-applied (a local choice is not overwritten by a stale echo)', () => {
    const plan = planHostAdoption({ previous: { sessionId: 's1', agent: 'claudekei:planner', model: 'opus' }, sessionId: 's1', hostAgent: 'claudekei:planner', hostModel: 'opus', ...known });
    expect(plan.agent).toBeUndefined();
    expect(plan.model).toBeUndefined();
  });

  test('host changes (agent defaults applied on setAgent) are adopted live', () => {
    const plan = planHostAdoption({ previous: { sessionId: 's1', agent: 'claudekei:orchestrator', model: 'opus' }, sessionId: 's1', hostAgent: 'claudekei:planner', hostModel: 'sonnet', ...known });
    expect(plan.agent).toBe('claudekei:planner');
    expect(plan.model).toBe('sonnet');
  });

  test('switching sessions adopts that session again; unknown agents/models and missing values are ignored', () => {
    expect(planHostAdoption({ previous: { sessionId: 's1', agent: 'claudekei:planner' }, sessionId: 's2', hostAgent: 'claudekei:planner', ...known }).agent).toBe('claudekei:planner');
    const plan = planHostAdoption({ previous: { sessionId: null }, sessionId: 's3', hostAgent: 'gone', hostModel: 'mystery', ...known });
    expect(plan.agent).toBeUndefined();
    expect(plan.model).toBeUndefined();
    expect(planHostAdoption({ previous: { sessionId: null }, sessionId: 's4', ...known }).agent).toBeUndefined();
  });
});
