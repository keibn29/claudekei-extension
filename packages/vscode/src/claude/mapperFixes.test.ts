/** Review fixes in the mapper: cumulative cost per turn, task_updated ending a background Agent, compact notice uuid. */
import { describe, expect, test } from 'bun:test';
import type { ClaudeEvent } from '@openchamber/ui/src/lib/claude/protocol';
import type { AssistantMessage } from '@openchamber/ui/src/lib/claude/types';
import { replayEntries } from './history';
import { createMapper } from './mapper';
import { bucketFor, createSessionState, reduceEvents } from './sessionState';
import { allToolParts, fakeClock } from './testUtils';
import { forkUuidOf } from './transcriptCut';

const make = () => {
  const mapper = createMapper({ sessionId: 's', cwd: '/w', mode: 'default', model: 'm', now: fakeClock() });
  const state = createSessionState('s');
  const feed = (e: ClaudeEvent[]) => reduceEvents(state, e);
  return {
    mapper,
    state,
    apply: (m: unknown) => feed(mapper.apply(m)),
    turn: (text = 'go') => feed(mapper.startUserMessage({ content: text, uuid: `u_${text}` }).events),
    assistants: () => bucketFor(state, 's').messages.filter((m): m is AssistantMessage => m.role === 'assistant'),
  };
};
const reply = (id: string, text: string) => ({ type: 'assistant', uuid: `uu_${id}`, parent_tool_use_id: null, message: { id, model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const result = (total: number, extra: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: total, ...extra });

describe('cost per turn from the cumulative total_cost_usd', () => {
  test('0.10 then 0.25 gives 0.10 and 0.15', () => {
    const t = make();
    t.turn('one');
    t.apply(reply('m1', 'A'));
    t.apply(result(0.1));
    t.turn('two');
    t.apply(reply('m2', 'B'));
    t.apply(result(0.25));
    const [a, b] = t.assistants();
    expect(a!.cost).toBeCloseTo(0.1);
    expect(b!.cost).toBeCloseTo(0.15);
  });

  test('a turn that ends without a new assistant message does not overwrite the earlier cost, and its cost is not lost for the next', () => {
    const t = make();
    t.turn('one');
    t.apply(reply('m1', 'A'));
    t.apply(result(0.1));
    t.turn('aborted before any reply');
    t.apply({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', total_cost_usd: 0.25, errors: [] });
    expect(t.assistants()[0]!.cost).toBeCloseTo(0.1);
    t.turn('three');
    t.apply(reply('m3', 'C'));
    t.apply(result(0.4));
    const [a, c] = t.assistants();
    expect(a!.cost).toBeCloseTo(0.1);
    expect(c!.cost).toBeCloseTo(0.15); // 0.40 - 0.25: the aborted turn's 0.15 is not billed to this one
  });

  test('several results for one turn add up on the same message', () => {
    const t = make();
    t.turn('one');
    t.apply(reply('m1', 'A'));
    t.apply(result(0.1));
    t.apply(result(0.3));
    expect(t.assistants()[0]!.cost).toBeCloseTo(0.3);
  });
});

describe('task_updated killed / failed', () => {
  const setup = () => {
    const t = make();
    t.turn();
    t.apply({ type: 'assistant', uuid: 'ua', parent_tool_use_id: null, message: { id: 'msg_a', model: 'm', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { description: 'd', prompt: 'p', subagent_type: 'helper' } }] } });
    t.apply({ type: 'system', subtype: 'task_started', task_id: 'ag1', tool_use_id: 'toolu_a', run_id: 'run_a', prompt: 'p', is_backgrounded: true });
    return t;
  };
  const runStatus = (part: { state: unknown }): unknown => (part.state as { metadata?: { runStatus?: string } }).metadata?.runStatus;
  const tool = (t: ReturnType<typeof make>) => allToolParts(t.state).find((p) => p.callID === 'toolu_a')!;

  test('killed ends the Agent tool part as stopped and a late notification cannot revive it', () => {
    const t = setup();
    expect(tool(t).state.status).toBe('running');
    t.apply({ type: 'system', subtype: 'task_updated', task_id: 'ag1', run_id: 'run_a', patch: { status: 'killed' } });
    expect(tool(t).state.status).toBe('error');
    expect((tool(t).state as { error: string }).error).toBe('Interrupted by user');
    expect(runStatus(tool(t))).toBe('stopped');
    t.apply({ type: 'system', subtype: 'task_notification', task_id: 'ag1', tool_use_id: 'toolu_a', run_id: 'run_a', status: 'completed', summary: 'done' });
    expect(tool(t).state.status).toBe('error');
    expect(runStatus(tool(t))).toBe('stopped');
    expect(bucketFor(t.state, 'sub_toolu_a').status).toEqual({ type: 'idle' });
    expect(t.mapper.runningTasks()).toEqual([]);
  });

  test('failed ends the tool part as an error', () => {
    const t = setup();
    t.apply({ type: 'system', subtype: 'task_updated', task_id: 'ag1', run_id: 'run_a', patch: { status: 'failed' } });
    expect(tool(t).state.status).toBe('error');
    expect((tool(t).state as { error: string }).error).toBe('Subagent failed');
    expect(runStatus(tool(t))).toBe('error');
  });
});

describe('compaction notice replay', () => {
  test('the notice carries the summary entry uuid so it is a valid cut point', () => {
    const entries = [
      { type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', uuid: 'a1', timestamp: '2026-01-01T00:00:01.000Z', message: { id: 'm1', model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'user', uuid: 'sum1', isCompactSummary: true, timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: 'summary of the conversation' } },
      { type: 'user', uuid: 'u2', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'user', content: 'next' } },
    ];
    const { state } = replayEntries(entries as never, { sessionId: 's', cwd: '/w', mode: 'default', model: 'm', now: fakeClock() });
    const bucket = bucketFor(state, 's');
    const notice = bucket.messages.find((m) => m.role === 'assistant' && (bucket.parts[m.id] ?? []).some((p) => p.type === 'text' && p.synthetic))!;
    expect(notice.claudeUuid).toBe('sum1');
    expect(forkUuidOf(notice, bucket.parts[notice.id] ?? [])).toBe('sum1');
  });
});
