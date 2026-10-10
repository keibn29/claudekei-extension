/** Model / effort of subagent child sessions: Agent input > configured defaults > parent; the transcript's model wins as `resolvedModel`. */
import { describe, expect, test } from 'bun:test';
import type { ClaudeEvent } from '@openchamber/ui/src/lib/claude/protocol';
import type { EffortLevel } from '@openchamber/ui/src/lib/claude/types';
import { createMapper, type SubagentDefaults } from './mapper';
import { bucketFor, createSessionState, reduceEvents } from './sessionState';
import { fakeClock } from './testUtils';

const make = (opts: { effort?: EffortLevel | null; defaults?: Record<string, SubagentDefaults> } = {}) => {
  const lookups: string[] = [];
  const mapper = createMapper({
    sessionId: 's',
    cwd: '/w',
    mode: 'default',
    model: 'claude-opus-5-5',
    effort: opts.effort ?? null,
    now: fakeClock(),
    subagentDefaults: (type) => {
      lookups.push(type);
      return opts.defaults?.[type];
    },
  });
  const state = createSessionState('s');
  const apply = (m: unknown) => reduceEvents(state, mapper.apply(m) as ClaudeEvent[]);
  const spawn = (input: Record<string, unknown>, id = 'toolu_a') =>
    apply({ type: 'assistant', uuid: `u_${id}`, parent_tool_use_id: null, message: { id: `m_${id}`, model: 'claude-opus-5-5', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'd', prompt: 'p', ...input } }] } });
  const childSay = (model: string | undefined, id = 'toolu_a') =>
    apply({ type: 'assistant', uuid: `c_${id}_${model}`, parent_tool_use_id: id, message: { id: `cm_${id}_${model}`, ...(model ? { model } : {}), content: [{ type: 'text', text: 'hi' }] } });
  const info = (id = 'toolu_a') => bucketFor(state, `sub_${id}`).info;
  return { spawn, childSay, info, lookups };
};

describe('subagent child session model / effort', () => {
  test('Agent input model wins over the configured default and the parent', () => {
    const t = make({ defaults: { helper: { model: 'sonnet', effort: 'high' } } });
    t.spawn({ subagent_type: 'helper', model: 'haiku' });
    expect(t.info()).toMatchObject({ model: 'haiku', effort: 'high' });
  });

  test('without an input model the configured default applies; effort from the input beats the default', () => {
    const t = make({ defaults: { helper: { model: 'sonnet', effort: 'high' } } });
    t.spawn({ subagent_type: 'helper', effort: 'low' });
    expect(t.info()).toMatchObject({ model: 'sonnet', effort: 'low' });
  });

  test('`inherit` and unconfigured agents take the parent model and effort', () => {
    const t = make({ effort: 'medium', defaults: { helper: { model: 'inherit' } } });
    t.spawn({ subagent_type: 'helper' });
    expect(t.info()).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
    t.spawn({ subagent_type: 'other' }, 'toolu_b');
    expect(t.info('toolu_b')).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium' });
  });

  test('no effort anywhere leaves it unset', () => {
    const t = make();
    t.spawn({ subagent_type: 'helper' });
    expect(t.info()?.model).toBe('claude-opus-5-5');
    expect(t.info()?.effort).toBeUndefined();
  });

  test('an invalid input effort is ignored', () => {
    const t = make({ defaults: { helper: { effort: 'max' } } });
    t.spawn({ subagent_type: 'helper', effort: 'turbo' });
    expect(t.info()?.effort).toBe('max');
  });

  test('the model reported by the subagent transcript becomes resolvedModel; synthetic ids are ignored', () => {
    const t = make();
    t.spawn({ subagent_type: 'helper', model: 'haiku' });
    expect(t.info()?.resolvedModel).toBeUndefined();
    t.childSay('<synthetic>');
    expect(t.info()?.resolvedModel).toBeUndefined();
    t.childSay('claude-haiku-5-5');
    expect(t.info()).toMatchObject({ model: 'haiku', resolvedModel: 'claude-haiku-5-5' });
  });

  test('the defaults of a type are looked up once per child', () => {
    const t = make({ defaults: { helper: { model: 'sonnet' } } });
    t.spawn({ subagent_type: 'helper' });
    t.childSay('claude-sonnet-5-5');
    expect(t.lookups.length).toBe(1);
  });
});
