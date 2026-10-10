import { describe, expect, test } from 'bun:test';
import type { ClaudeEvent } from '@openchamber/ui/src/lib/claude/protocol';
import type { Message, Part, Session, ToolPart, UserMessage } from '@openchamber/ui/src/lib/claude/types';
import { replayEntries, type HistoryEntry } from './history';
import { createMapper } from './mapper';
import { bucketFor, createSessionState, reduceEvents, type SessionBucket, type SessionState } from './sessionState';
import { isHiddenToolSearch, normalizeToolInput } from './toolNormalize';
import { allToolParts, fakeClock, loadJson, loadNdjson, runFixture } from './testUtils';

const sub = (name: string) => `subagents/${name}`;
const childOf = (state: SessionState, mainId: string): { id: string; bucket: SessionBucket } => {
  const kids = [...state.sessions.entries()].filter(([id]) => id !== mainId);
  expect(kids).toHaveLength(1);
  return { id: kids[0]![0], bucket: kids[0]![1] };
};
const toolsByName = (state: SessionState, tool: string) => allToolParts(state).filter((t) => t.tool === tool);
const meta = (t: ToolPart) => (t.state as { metadata?: Record<string, any> }).metadata ?? {};
const users = (b: SessionBucket): UserMessage[] => b.messages.filter((m): m is UserMessage => m.role === 'user');
const textOf = (b: SessionBucket, m: Message): string => (b.parts[m.id] ?? []).filter((p: Part) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
/** Role sequence with consecutive duplicates collapsed (an assistant turn may span several messages). */
const roles = (b: SessionBucket): string[] => b.messages.map((m) => m.role).filter((r, i, all) => i === 0 || r !== all[i - 1]);
const replyTexts = (b: SessionBucket): string[] => b.messages.filter((m) => m.role === 'assistant').map((m) => textOf(b, m)).filter(Boolean);
const childStatuses = (events: ClaudeEvent[], id: string) => events.filter((e) => e.type === 'session.status' && e.properties.sessionID === id).map((e) => (e as any).properties.status.type);

describe('golden invariants on the subagent recordings', () => {
  for (const name of ['q2-sendmessage-sync', 'q2-sendmessage-async', 'q2-sendmessage-alias']) {
    test(name, () => {
      const run = runFixture(sub(name));
      expect(run.logs.filter((l) => l.level === 'warn')).toEqual([]);
      for (const bucket of run.state.sessions.values()) {
        expect(bucket.status).toEqual({ type: 'idle' });
        expect(bucket.messages.map((m) => m.id)).toEqual([...bucket.messages.map((m) => m.id)].sort());
        for (const parts of Object.values(bucket.parts)) expect(parts.map((p) => p.id)).toEqual([...parts.map((p) => p.id)].sort());
      }
      for (const t of allToolParts(run.state)) expect(['completed', 'error']).toContain(t.state.status);
      // every instruction message in a child links back to a parent tool part that exists
      const toolIds = new Set(allToolParts(run.state).map((t) => t.callID));
      for (const [id, bucket] of run.state.sessions) {
        if (id === run.sessionId) continue;
        for (const u of users(bucket)) expect(toolIds.has(u.instruction!.toolCallID)).toBe(true);
      }
    });
  }
});

describe('SendMessage continuation (sync env)', () => {
  const run = runFixture(sub('q2-sendmessage-sync'));
  const { id: childId, bucket: child } = childOf(run.state, run.sessionId);
  const [agentPart] = toolsByName(run.state, 'task');
  const [sendPart] = toolsByName(run.state, 'sendmessage');

  test('one child per agent: id is sub_<original Agent tool_use id>, linked to the agent', () => {
    expect(childId).toBe(`sub_${agentPart!.callID}`);
    expect(child.info!.claude).toMatchObject({ agentId: expect.stringMatching(/^a[0-9a-f]{16}$/), agentType: 'helper' });
    expect(child.info!.parentID).toBe(run.sessionId);
    expect(run.logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  test('the child shows each incoming instruction as a user message (initial + followup, indexed)', () => {
    const [first, second] = users(child);
    expect(users(child)).toHaveLength(2);
    expect(first!.instruction).toMatchObject({ kind: 'initial', index: 1, toolCallID: agentPart!.callID, fromSessionID: run.sessionId, fromMessageID: agentPart!.messageID, fromAgent: 'lead' });
    expect(textOf(child, first!)).toContain('Remember the secret word KIWI');
    expect(second!.instruction).toMatchObject({ kind: 'followup', index: 2, toolCallID: sendPart!.callID, fromMessageID: sendPart!.messageID });
    expect(textOf(child, second!)).toBe('What was the secret word? Also read hello.txt and tell me its first line.');
    // reply #1 exists (foreground text-only reply, not forwarded: safety net) and answers the first instruction
    expect(roles(child)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const assistants = child.messages.filter((m) => m.role === 'assistant') as Array<{ parentID: string }>;
    expect(assistants[0]!.parentID).toBe(first!.id);
    expect(textOf(child, child.messages.filter((m) => m.role === 'assistant')[0]!)).toBe('stored.');
    // the continuation's work answers the follow-up
    expect(assistants.slice(1).every((a) => a.parentID === second!.id)).toBe(true);
  });

  test('tool parts carry the subagent link metadata', () => {
    const a = meta(agentPart!);
    expect(a).toMatchObject({ sessionID: childId, agentId: child.info!.claude!.agentId, agentType: 'helper', runStatus: 'completed', reply: 'stored.' });
    expect(a.childMessageID).toBe(users(child)[0]!.id);
    const s = meta(sendPart!);
    expect(s).toMatchObject({ sessionID: childId, agentId: a.agentId, agentType: 'helper', recipient: a.agentId, runStatus: 'completed' });
    expect(s.childMessageID).toBe(users(child)[1]!.id);
    expect(s.message).toContain('What was the secret word');
    expect(s.reply).toContain('KIWI');
    expect(sendPart!.state.status).toBe('completed');
    expect((sendPart!.state as { output: string }).output).toContain('KIWI');
  });

  test('SendMessage input is normalized; the ToolSearch that only loads SendMessage is hidden', () => {
    expect(sendPart!.state.input).toMatchObject({ to: expect.any(String), message: expect.any(String), summary: expect.any(String) });
    const search = toolsByName(run.state, 'ToolSearch')[0]!;
    expect(meta(search).hidden).toBe(true);
  });

  test('child status follows runs: busy/idle per run, idle at the end', () => {
    expect(childStatuses(run.events, childId)).toEqual(['busy', 'idle', 'busy', 'idle']);
    expect(child.status).toEqual({ type: 'idle' });
  });

  test('progress is announced through session.updated and cleared when the run ends', () => {
    const updates = run.events.filter((e) => e.type === 'session.updated' && e.properties.sessionID === childId).map((e) => (e as any).properties.info as Session);
    expect(updates.some((u) => u.claude?.progress?.lastToolName === 'Read')).toBe(true);
    expect(updates.at(-1)!.claude!.progress).toBeUndefined();
    expect(child.info!.claude!.progress).toBeUndefined();
  });
});

describe('SendMessage continuation (async, default env)', () => {
  const run = runFixture(sub('q2-sendmessage-async'));
  const { id: childId, bucket: child } = childOf(run.state, run.sessionId);
  const sendPart = toolsByName(run.state, 'sendmessage')[0]!;

  test('links through task_started and takes the reply from task_notification (the tool result comes first)', () => {
    expect(meta(sendPart)).toMatchObject({ sessionID: childId, runStatus: 'completed' });
    expect(meta(sendPart).reply).toContain('KIWI');
    expect(users(child).map((u) => u.instruction?.kind)).toEqual(['initial', 'followup']);
  });

  test('the child stays busy after the parent turn ended, until the run notification', () => {
    const idx = (pred: (e: ClaudeEvent) => boolean) => run.events.findIndex(pred);
    const lastChildBusy = run.events.map((e, i) => (e.type === 'session.status' && e.properties.sessionID === childId && e.properties.status.type === 'busy' ? i : -1)).filter((i) => i >= 0).at(-1)!;
    const parentIdleAfter = run.events.map((e, i) => (e.type === 'session.status' && e.properties.sessionID === run.sessionId && e.properties.status.type === 'idle' ? i : -1)).filter((i) => i > lastChildBusy);
    const childIdleAfter = run.events.map((e, i) => (e.type === 'session.status' && e.properties.sessionID === childId && e.properties.status.type === 'idle' ? i : -1)).filter((i) => i > lastChildBusy);
    expect(parentIdleAfter.length).toBeGreaterThan(0);
    expect(childIdleAfter.length).toBe(1);
    // the parent's `result` (idle) for the SendMessage turn arrives before the child is done
    expect(parentIdleAfter[0]!).toBeLessThan(childIdleAfter[0]!);
    void idx;
  });
});

describe('plugin alias (hook resolves exp-1 -> agentId)', () => {
  test('recipient keeps what the model sent; the link comes from task_started; alias via the plugin state', () => {
    const run = runFixture(sub('q2-sendmessage-alias'), undefined, { aliases: { forAgent: (id) => (id.startsWith('aedf') ? 'exp-1' : undefined), resolve: (a) => (a === 'exp-1' ? 'aedf2479dbcf2d6f5' : undefined) } });
    const { bucket: child } = childOf(run.state, run.sessionId);
    const send = toolsByName(run.state, 'sendmessage')[0]!;
    expect(meta(send)).toMatchObject({ recipient: 'exp-1', agentId: 'aedf2479dbcf2d6f5', agentType: 'claudekei:explorer', runStatus: 'completed' });
    expect(child.info!.claude).toMatchObject({ agentId: 'aedf2479dbcf2d6f5', alias: 'exp-1' });
    expect(users(child)).toHaveLength(2);
  });

  test('without plugin state the alias is simply absent', () => {
    const run = runFixture(sub('q2-sendmessage-alias'));
    expect(childOf(run.state, run.sessionId).bucket.info!.claude!.alias).toBeUndefined();
  });
});

describe('replay linking', () => {
  type Dump = { sessionId: string; main: HistoryEntry[]; subagents: Record<string, HistoryEntry[]> };
  const replay = (name: string, aliases?: Parameters<typeof replayEntries>[1]['aliases']) => {
    const dump = loadJson<Dump>(`subagents/history-${name}.json`);
    return replayEntries(dump.main, { sessionId: dump.sessionId, cwd: '/x', mode: 'default', model: 'm', now: fakeClock(), aliases }, Object.entries(dump.subagents).map(([agentId, entries]) => ({ agentId, entries })));
  };

  for (const name of ['q2-sendmessage-sync', 'q2-sendmessage-async']) {
    test(`${name}: (a) raw agentId in "to" / (b) resumedAgentId, instruction messages unwrapped and linked`, () => {
      const snap = replay(name);
      const main = bucketFor(snap.state, Object.keys(loadJson<Dump>(`subagents/history-${name}.json`).subagents).length ? snap.state.mainSessionId : '');
      const { bucket: child } = childOf(snap.state, snap.state.mainSessionId);
      const send = toolsByName(snap.state, 'sendmessage')[0]!;
      const agent = toolsByName(snap.state, 'task')[0]!;
      expect(meta(send)).toMatchObject({ sessionID: `sub_${agent.callID}`, runStatus: 'completed' });
      expect(meta(send).agentId).toBe(Object.keys(loadJson<Dump>(`subagents/history-${name}.json`).subagents)[0]);
      expect(child.info!.claude).toMatchObject({ agentId: meta(send).agentId, agentType: 'helper' });
      const us = users(child);
      expect(us.map((u) => u.instruction?.kind)).toEqual(['initial', 'followup']);
      expect(us[1]!.instruction).toMatchObject({ index: 2, toolCallID: send.callID, fromMessageID: send.messageID });
      expect(textOf(child, us[1]!)).toBe('What was the secret word? Also read hello.txt and tell me its first line.');
      expect(textOf(child, us[1]!)).not.toContain('coordinator sent a message');
      expect(meta(send).childMessageID).toBe(us[1]!.id);
      expect(meta(agent).childMessageID).toBe(us[0]!.id);
      void main;
    });

    test(`${name}: replay metadata matches live (agent link, instruction texts and kinds)`, () => {
      const live = runFixture(sub(name));
      const rep = replay(name);
      const l = childOf(live.state, live.sessionId).bucket;
      const r = childOf(rep.state, rep.state.mainSessionId).bucket;
      const sig = (b: SessionBucket) => users(b).map((u) => [u.instruction?.kind, u.instruction?.index, textOf(b, u)]);
      expect(sig(r)).toEqual(sig(l));
      const keys = (s: SessionState) => toolsByName(s, 'sendmessage').map((t) => [meta(t).agentType, meta(t).message, meta(t).runStatus]);
      expect(keys(rep.state)).toEqual(keys(live.state));
    });
  }

  test('alias variant: (c) plugin alias, else (d) message-text match', () => {
    const dump = loadJson<Dump>('subagents/history-q2-sendmessage-alias.json');
    const agentId = Object.keys(dump.subagents)[0]!;
    const viaPlugin = replay('q2-sendmessage-alias', { forAgent: (id) => (id === agentId ? 'exp-1' : undefined), resolve: (a) => (a === 'exp-1' ? agentId : undefined) });
    expect(meta(toolsByName(viaPlugin.state, 'sendmessage')[0]!)).toMatchObject({ agentId, recipient: 'exp-1' });
    expect(childOf(viaPlugin.state, viaPlugin.state.mainSessionId).bucket.info!.claude!.alias).toBe('exp-1');
    const viaText = replay('q2-sendmessage-alias');
    expect(meta(toolsByName(viaText.state, 'sendmessage')[0]!)).toMatchObject({ agentId, recipient: 'exp-1' });
    expect(childOf(viaText.state, viaText.state.mainSessionId).bucket.info!.claude!.alias).toBeUndefined();
  });

  test('a replay without subagent transcripts still learns the agent id from the Agent result trailer', () => {
    const dump = loadJson<Dump>('subagents/history-q2-sendmessage-sync.json');
    const snap = replayEntries(dump.main, { sessionId: dump.sessionId, cwd: '/x', mode: 'default', model: 'm', now: fakeClock() });
    const agent = toolsByName(snap.state, 'task')[0]!;
    expect(meta(agent).agentId).toBe(Object.keys(dump.subagents)[0]);
  });
});

describe('edge cases (synthetic streams)', () => {
  const make = (now = fakeClock()) => {
    const mapper = createMapper({ sessionId: 's', cwd: '/w', mode: 'default', model: 'm', agent: 'claudekei:orchestrator', now });
    const state = createSessionState('s');
    const events: ClaudeEvent[] = [];
    const feed = (e: ClaudeEvent[]) => {
      events.push(...e);
      reduceEvents(state, e);
    };
    const apply = (m: unknown) => feed(mapper.apply(m));
    mapper.startUserMessage({ content: 'go' });
    return { mapper, state, events, apply };
  };
  const assistantTool = (id: string, name: string, input: unknown, api = `msg_${id}`) => ({
    type: 'assistant', uuid: `u_${id}`, parent_tool_use_id: null, message: { id: api, model: 'm', content: [{ type: 'tool_use', id, name, input }] },
  });
  const started = (task: string, tool: string, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: tool, run_id: `run_${tool}`, ...extra });

  test('SendMessage to a running agent (no new task_started) links through resumedAgentId and ends with the run', () => {
    const t = make();
    t.apply(assistantTool('toolu_agent', 'Agent', { description: 'd', prompt: 'do it', subagent_type: 'helper' }));
    t.apply(started('agentX', 'toolu_agent', { prompt: 'do it', subagent_type: 'helper' }));
    t.apply(assistantTool('toolu_send', 'SendMessage', { to: 'agentX', message: 'also this' }));
    t.apply({ type: 'user', uuid: 'r1', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_send', content: '{"success":true,"message":"Message queued","resumedAgentId":"agentX"}' }] } });
    const send = toolsByName(t.state, 'sendmessage')[0]!;
    const child = bucketFor(t.state, 'sub_toolu_agent');
    expect(meta(send)).toMatchObject({ sessionID: 'sub_toolu_agent', agentId: 'agentX', runStatus: 'running', message: 'also this' });
    expect(users(child).map((u) => u.instruction?.kind)).toEqual(['initial', 'followup']);
    expect(child.status).toEqual({ type: 'busy' });
    t.apply({ type: 'system', subtype: 'task_notification', task_id: 'agentX', tool_use_id: 'toolu_agent', run_id: 'run_toolu_agent', status: 'completed', summary: 'all done' });
    expect(meta(toolsByName(t.state, 'sendmessage')[0]!)).toMatchObject({ runStatus: 'completed', reply: 'all done' });
    expect(bucketFor(t.state, 'sub_toolu_agent').status).toEqual({ type: 'idle' });
  });

  test('agent_id on subagent messages registers the instance even without task events', () => {
    const t = make();
    t.apply(assistantTool('toolu_agent', 'Agent', { description: 'd', prompt: 'p', subagent_type: 'helper' }));
    t.apply({ type: 'assistant', uuid: 'c1', parent_tool_use_id: 'toolu_agent', agent_id: 'agentY', message: { id: 'msg_c', model: 'm', content: [{ type: 'text', text: 'hi' }] } });
    expect(bucketFor(t.state, 'sub_toolu_agent').info!.claude!.agentId).toBe('agentY');
    // a user echo of the prompt (no task_started) becomes the initial instruction exactly once
    t.apply({ type: 'user', uuid: 'e1', parent_tool_use_id: 'toolu_agent', message: { role: 'user', content: [{ type: 'text', text: 'p' }] } });
    t.apply({ type: 'user', uuid: 'e2', parent_tool_use_id: 'toolu_agent', message: { role: 'user', content: [{ type: 'text', text: 'p' }] } });
    expect(users(bucketFor(t.state, 'sub_toolu_agent'))).toHaveLength(1);
  });

  test('task_started prompt is the instruction; the later echo is not duplicated', () => {
    const t = make();
    t.apply(assistantTool('toolu_agent', 'Agent', { description: 'd', prompt: 'p', subagent_type: 'helper' }));
    t.apply(started('agentZ', 'toolu_agent', { prompt: 'p' }));
    t.apply({ type: 'user', uuid: 'e1', parent_tool_use_id: 'toolu_agent', message: { role: 'user', content: [{ type: 'text', text: 'p' }] } });
    expect(users(bucketFor(t.state, 'sub_toolu_agent'))).toHaveLength(1);
  });

  test('task_progress is throttled to ~1 Hz and the first one is announced immediately', () => {
    let clock = 1_700_000_000_000;
    const t = make(() => clock);
    t.apply(assistantTool('toolu_agent', 'Agent', { description: 'd', prompt: 'p', subagent_type: 'helper' }));
    t.apply(started('agentP', 'toolu_agent', { prompt: 'p' }));
    const before = t.events.filter((e) => e.type === 'session.updated').length;
    const progress = (tools: number) => ({ type: 'system', subtype: 'task_progress', task_id: 'agentP', tool_use_id: 'toolu_agent', description: 'Reading', last_tool_name: 'Read', usage: { total_tokens: 100 * tools, tool_uses: tools, duration_ms: 10 } });
    t.apply(progress(1));
    clock += 200;
    t.apply(progress(2));
    clock += 200;
    t.apply(progress(3));
    expect(t.events.filter((e) => e.type === 'session.updated').length - before).toBe(1);
    clock += 1000;
    t.apply(progress(4));
    const updates = t.events.filter((e) => e.type === 'session.updated').map((e) => (e as any).properties.info as Session);
    expect(updates.length - before).toBe(2);
    expect(updates.at(-1)!.claude!.progress).toEqual({ toolUses: 4, totalTokens: 400, durationMs: 10, lastToolName: 'Read', description: 'Reading' });
  });

  test('a SendMessage for an agent the mapper never saw stays an unlinked, harmless tool part', () => {
    const t = make();
    t.apply(assistantTool('toolu_send', 'SendMessage', { to: 'ghost', message: 'hi' }));
    t.apply(started('ghost', 'toolu_send', { prompt: 'hi' }));
    t.apply({ type: 'user', uuid: 'r', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_send', content: '{"success":true}' }] } });
    const send = toolsByName(t.state, 'sendmessage')[0]!;
    expect(send.state.status).toBe('completed');
    expect(meta(send).sessionID).toBeUndefined();
  });

  test('finish() ends running subagent tool parts as errors and idles the child', () => {
    const t = make();
    t.apply(assistantTool('toolu_agent', 'Agent', { description: 'd', prompt: 'p', subagent_type: 'helper' }));
    t.apply(started('agentF', 'toolu_agent', { prompt: 'p' }));
    reduceEvents(t.state, t.mapper.finish('interrupted'));
    const agent = toolsByName(t.state, 'task')[0]!;
    expect(agent.state.status).toBe('error');
    expect(meta(agent).runStatus).toBe('stopped');
    expect(bucketFor(t.state, 'sub_toolu_agent').status).toEqual({ type: 'idle' });
  });
});

describe('child reply #1 (forwardSubagentText on/off) and live-vs-replay role sequences', () => {
  type Dump = { sessionId: string; main: HistoryEntry[]; subagents: Record<string, HistoryEntry[]> };
  const replay = (name: string) => {
    const dump = loadJson<Dump>(`subagents/history-${name}.json`);
    return replayEntries(dump.main, { sessionId: dump.sessionId, cwd: '/x', mode: 'default', model: 'm', now: fakeClock() }, Object.entries(dump.subagents).map(([agentId, entries]) => ({ agentId, entries })));
  };

  for (const [live, history] of [['q2-sendmessage-sync', 'q2-sendmessage-sync'], ['q2-sendmessage-sync-forward', 'q2-sendmessage-sync-forward']] as const) {
    test(`${live}: user,assistant,user,assistant live and in replay; each reply once, parented to its instruction`, () => {
      const l = childOf(runFixture(sub(live)).state, runFixture(sub(live)).sessionId).bucket;
      const run = runFixture(sub(live));
      const lb = childOf(run.state, run.sessionId).bucket;
      const rep = replay(history);
      const rb = childOf(rep.state, rep.state.mainSessionId).bucket;
      void l;
      expect(roles(lb)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(roles(rb)).toEqual(['user', 'assistant', 'user', 'assistant']);
      const first = (b: SessionBucket) => b.messages.find((m) => m.role === 'assistant')! as { parentID: string; id: string };
      for (const b of [lb, rb]) {
        const us = users(b);
        expect(first(b).parentID).toBe(us[0]!.id);
        expect(replyTexts(b)[0]).toBe('stored.');
        expect(replyTexts(b).filter((t) => t === 'stored.')).toHaveLength(1);
        expect(replyTexts(b).at(-1)).toMatch(/KIWI|kiwi/);
      }
      // the same reply texts in the same order
      expect(replyTexts(lb)).toEqual(replyTexts(rb));
    });
  }

  test('forwarded text means the safety net stays silent (no synthesized duplicate)', () => {
    const run = runFixture(sub('q2-sendmessage-sync-forward'));
    const child = childOf(run.state, run.sessionId).bucket;
    expect(child.messages.filter((m) => (m as { apiMessageId?: string }).apiMessageId?.startsWith('reply:'))).toHaveLength(0);
    const plain = runFixture(sub('q2-sendmessage-sync'));
    const synthesized = childOf(plain.state, plain.sessionId).bucket.messages.filter((m) => (m as { apiMessageId?: string }).apiMessageId?.startsWith('reply:'));
    expect(synthesized).toHaveLength(1);
    expect((synthesized[0] as { finish?: string }).finish).toBe('end_turn');
  });

  test('synthetic stream: no forwarded text -> exactly one reply parented to instruction #1; forwarded -> none', () => {
    for (const forwarded of [false, true]) {
      const mapper = createMapper({ sessionId: 's', cwd: '/w', mode: 'default', model: 'm', now: fakeClock() });
      const state = createSessionState('s');
      const feed = (m: unknown) => reduceEvents(state, mapper.apply(m));
      reduceEvents(state, mapper.startUserMessage({ content: 'go' }).events);
      feed({ type: 'assistant', uuid: 'ua', parent_tool_use_id: null, message: { id: 'ma', model: 'm', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { description: 'd', prompt: 'ping', subagent_type: 'helper' } }] } });
      feed({ type: 'system', subtype: 'task_started', task_id: 'ag', tool_use_id: 'toolu_a', run_id: 'r1', prompt: 'ping' });
      if (forwarded) feed({ type: 'assistant', uuid: 'c1', parent_tool_use_id: 'toolu_a', agent_id: 'ag', message: { id: 'mc', model: 'm', content: [{ type: 'text', text: 'pong' }] } });
      feed({ type: 'system', subtype: 'task_notification', task_id: 'ag', tool_use_id: 'toolu_a', run_id: 'r1', status: 'completed', summary: 'pong' });
      feed({ type: 'user', uuid: 'tr', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: [{ type: 'text', text: '[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output. The report follows:\n  pong\nagentId: ag (use SendMessage)' }] }] } });
      const child = bucketFor(state, 'sub_toolu_a');
      expect(roles(child)).toEqual(['user', 'assistant']);
      expect(replyTexts(child)).toEqual(['pong']);
      const reply = child.messages.find((m) => m.role === 'assistant') as { parentID: string; time: { completed?: number } };
      expect(reply.parentID).toBe(users(child)[0]!.id);
      expect(reply.time.completed).toBeDefined();
      const part = (child.parts[(reply as unknown as { id: string }).id] ?? [])[0] as { type: string; synthetic?: boolean };
      expect(part.type).toBe('text');
      expect(part.synthetic).toBeUndefined();
    }
  });

  test('the Agent tool_result text is preferred when it arrives before the notification', () => {
    const mapper = createMapper({ sessionId: 's', cwd: '/w', mode: 'default', model: 'm', now: fakeClock() });
    const state = createSessionState('s');
    const feed = (m: unknown) => reduceEvents(state, mapper.apply(m));
    reduceEvents(state, mapper.startUserMessage({ content: 'go' }).events);
    feed({ type: 'assistant', uuid: 'ua', parent_tool_use_id: null, message: { id: 'ma', model: 'm', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { description: 'd', prompt: 'ping', subagent_type: 'helper' } }] } });
    feed({ type: 'system', subtype: 'task_started', task_id: 'ag', tool_use_id: 'toolu_a', run_id: 'r1', prompt: 'ping' });
    feed({ type: 'user', uuid: 'tr', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: [{ type: 'text', text: '[Subagent hand-back] frame. The report follows:\n  full report\nagentId: ag (x)' }] }] } });
    feed({ type: 'system', subtype: 'task_notification', task_id: 'ag', tool_use_id: 'toolu_a', run_id: 'r1', status: 'completed', summary: 'truncated sum...' });
    expect(replyTexts(bucketFor(state, 'sub_toolu_a'))).toEqual(['full report']);
  });
});

describe('seeding a new mapper (respawn)', () => {
  const firstRun = () => {
    const mapper = createMapper({ sessionId: 's', cwd: '/w', mode: 'default', model: 'm', agent: 'main-agent', now: fakeClock() });
    const state = createSessionState('s');
    const feed = (mp: ReturnType<typeof createMapper>, m: unknown) => reduceEvents(state, mp.apply(m));
    reduceEvents(state, mapper.startUserMessage({ content: 'go' }).events);
    feed(mapper, { type: 'assistant', uuid: 'ua', parent_tool_use_id: null, message: { id: 'ma', model: 'm', content: [{ type: 'tool_use', id: 'toolu_a', name: 'Agent', input: { description: 'd', prompt: 'ping', subagent_type: 'helper' } }] } });
    feed(mapper, { type: 'system', subtype: 'task_started', task_id: 'ag', tool_use_id: 'toolu_a', run_id: 'r1', prompt: 'ping', subagent_type: 'helper' });
    feed(mapper, { type: 'assistant', uuid: 'c1', parent_tool_use_id: 'toolu_a', agent_id: 'ag', message: { id: 'mc', model: 'm', content: [{ type: 'text', text: 'pong' }] } });
    feed(mapper, { type: 'system', subtype: 'task_notification', task_id: 'ag', tool_use_id: 'toolu_a', run_id: 'r1', status: 'completed', summary: 'pong' });
    return state;
  };

  test('a seeded mapper links a later SendMessage to the existing child: instruction #2, no session.created', () => {
    const state = firstRun();
    const fresh = createMapper({ sessionId: 's', cwd: '/w', mode: 'default', model: 'm', agent: 'main-agent', now: fakeClock(1_800_000_000_000) });
    fresh.seed(state);
    const events: ClaudeEvent[] = [];
    const feed = (m: unknown) => {
      const e = fresh.apply(m);
      events.push(...e);
      reduceEvents(state, e);
    };
    reduceEvents(state, fresh.startUserMessage({ content: 'again' }).events);
    feed({ type: 'assistant', uuid: 'us', parent_tool_use_id: null, message: { id: 'ms', model: 'm', content: [{ type: 'tool_use', id: 'toolu_s', name: 'SendMessage', input: { to: 'ag', message: 'second' } }] } });
    feed({ type: 'system', subtype: 'task_started', task_id: 'ag', tool_use_id: 'toolu_s', run_id: 'r2', prompt: 'second' });
    feed({ type: 'assistant', uuid: 'c2', parent_tool_use_id: 'toolu_a', agent_id: 'ag', message: { id: 'mc2', model: 'm', content: [{ type: 'text', text: 'second reply' }] } });
    feed({ type: 'system', subtype: 'task_notification', task_id: 'ag', tool_use_id: 'toolu_s', run_id: 'r2', status: 'completed', summary: 'second reply' });
    expect(events.filter((e) => e.type === 'session.created')).toHaveLength(0);
    const child = bucketFor(state, 'sub_toolu_a');
    expect(users(child).map((u) => [u.instruction?.kind, u.instruction?.index, textOf(child, u)])).toEqual([['initial', 1, 'ping'], ['followup', 2, 'second']]);
    expect(roles(child)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const reply2 = child.messages.filter((m) => m.role === 'assistant').at(-1) as { parentID: string };
    expect(reply2.parentID).toBe(users(child)[1]!.id);
    const send = toolsByName(state, 'sendmessage')[0]!;
    expect(meta(send)).toMatchObject({ sessionID: 'sub_toolu_a', agentId: 'ag', recipient: 'ag', runStatus: 'completed', childMessageID: users(child)[1]!.id });
    expect(child.info!.claude).toMatchObject({ agentId: 'ag', agentType: 'helper' });
    // ids stay ascending across the two mappers
    expect([...child.messages.map((m) => m.id)]).toEqual([...child.messages.map((m) => m.id)].sort());
  });

  test('seeding an empty or unrelated state is harmless', () => {
    const m = createMapper({ sessionId: 's', cwd: '/w', mode: 'default', model: 'm', now: fakeClock() });
    m.seed(createSessionState('s'));
    expect(m.info.childSessionIds).toEqual([]);
  });
});

describe('helpers', () => {
  test('isHiddenToolSearch: only selections of the deferred messaging tool', () => {
    expect(isHiddenToolSearch('ToolSearch', { query: 'select:SendMessage', max_results: 1 })).toBe(true);
    expect(isHiddenToolSearch('ToolSearch', { query: ' select: SendMessage ' })).toBe(true);
    expect(isHiddenToolSearch('ToolSearch', { query: 'select:SendMessage,SendMessage' })).toBe(true);
    expect(isHiddenToolSearch('ToolSearch', { query: 'select:SendMessage,TodoWrite' })).toBe(false);
    expect(isHiddenToolSearch('ToolSearch', { query: 'send message tool' })).toBe(false);
    expect(isHiddenToolSearch('Bash', { query: 'select:SendMessage' })).toBe(false);
    expect(isHiddenToolSearch('ToolSearch', null)).toBe(false);
  });

  test('SendMessage input normalization falls back to content', () => {
    expect(normalizeToolInput('SendMessage', { to: 'exp-1', content: 'hello', recipient_kind: 'name', summary: 's' })).toEqual({ to: 'exp-1', content: 'hello', recipientKind: 'name', summary: 's', message: 'hello' });
  });
});

describe('stopping the main agent stops every subagent (docs/STOP_SUBAGENTS_FIX.md)', () => {
  const make = () => {
    const mapper = createMapper({ sessionId: 's', cwd: '/w', mode: 'default', model: 'm', agent: 'claudekei:orchestrator', now: fakeClock() });
    const state = createSessionState('s');
    const events: ClaudeEvent[] = [];
    const feed = (e: ClaudeEvent[]) => {
      events.push(...e);
      reduceEvents(state, e);
    };
    const apply = (m: unknown) => feed(mapper.apply(m));
    const turn = (text = 'go') => feed(mapper.startUserMessage({ content: text }).events);
    turn();
    return { mapper, state, events, apply, turn };
  };
  const agentCall = (id: string, prompt = 'p') => ({ type: 'assistant', uuid: `u_${id}`, parent_tool_use_id: null, message: { id: `msg_${id}`, model: 'm', content: [{ type: 'tool_use', id, name: 'Agent', input: { description: 'd', prompt, subagent_type: 'helper' } }] } });
  const sendCall = (id: string, to: string) => ({ type: 'assistant', uuid: `u_${id}`, parent_tool_use_id: null, message: { id: `msg_${id}`, model: 'm', content: [{ type: 'tool_use', id, name: 'SendMessage', input: { to, message: 'again' } }] } });
  const started = (task: string, tool: string, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'task_started', task_id: task, tool_use_id: tool, run_id: `run_${tool}`, prompt: 'p', ...extra });
  const notification = (task: string, tool: string, status: string, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype: 'task_notification', task_id: task, tool_use_id: tool, run_id: `run_${tool}`, status, summary: '', ...extra });
  const abortedResult = { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', errors: [] };
  const okResult = { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
  const toolResult = (id: string, content: string, isError = false) => ({ type: 'user', uuid: `r_${id}`, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } });
  const agentTool = (state: SessionState, callId: string) => toolsByName(state, 'task').find((t) => t.callID === callId)!;

  test('aborted result without notifications: child idle, tool error, runStatus stopped, no running tasks', () => {
    const t = make();
    t.apply(agentCall('toolu_a'));
    t.apply(started('ag1', 'toolu_a'));
    expect(t.mapper.runningTasks()).toEqual([{ taskId: 'ag1', runId: 'run_toolu_a', toolUseId: 'toolu_a', childId: 'sub_toolu_a' }]);
    expect(bucketFor(t.state, 'sub_toolu_a').status).toEqual({ type: 'busy' });
    t.apply(abortedResult);
    const tool = agentTool(t.state, 'toolu_a');
    expect(tool.state.status).toBe('error');
    expect((tool.state as { error: string }).error).toBe('Interrupted by user');
    expect(meta(tool).runStatus).toBe('stopped');
    expect(bucketFor(t.state, 'sub_toolu_a').status).toEqual({ type: 'idle' });
    expect(bucketFor(t.state, 's').status).toEqual({ type: 'idle' });
    expect(t.mapper.runningTasks()).toEqual([]);
  });

  test('3 parallel Agents and a SendMessage run all end stopped', () => {
    const t = make();
    for (const n of ['a', 'b', 'c']) {
      t.apply(agentCall(`toolu_${n}`));
      t.apply(started(`ag_${n}`, `toolu_${n}`));
    }
    // a finished earlier (its result is in), then continued in the background through SendMessage
    t.apply(notification('ag_a', 'toolu_a', 'completed', { summary: 'first' }));
    t.apply(sendCall('toolu_s', 'ag_a'));
    t.apply(started('ag_a', 'toolu_s'));
    expect(t.mapper.runningTasks().map((r) => r.taskId).sort()).toEqual(['ag_a', 'ag_b', 'ag_c']);
    t.apply(abortedResult);
    expect(t.mapper.runningTasks()).toEqual([]);
    for (const n of ['b', 'c']) {
      expect(agentTool(t.state, `toolu_${n}`).state.status).toBe('error');
      expect(meta(agentTool(t.state, `toolu_${n}`)).runStatus).toBe('stopped');
      expect(bucketFor(t.state, `sub_toolu_${n}`).status).toEqual({ type: 'idle' });
    }
    const send = toolsByName(t.state, 'sendmessage')[0]!;
    expect(send.state.status).toBe('error');
    expect(meta(send).runStatus).toBe('stopped');
    expect(bucketFor(t.state, 'sub_toolu_a').status).toEqual({ type: 'idle' });
  });

  test('a normal result keeps a child with an active run busy (async runs end with their notification)', () => {
    const t = make();
    t.apply(agentCall('toolu_a'));
    t.apply(started('ag1', 'toolu_a', { is_backgrounded: true }));
    t.apply(toolResult('toolu_a', 'Async agent launched successfully\nagentId: ag1'));
    t.apply(okResult);
    expect(bucketFor(t.state, 'sub_toolu_a').status).toEqual({ type: 'busy' });
    expect(bucketFor(t.state, 's').status).toEqual({ type: 'idle' });
    expect(t.mapper.runningTasks()).toHaveLength(1);
    t.apply(notification('ag1', 'toolu_a', 'completed', { summary: 'done' }));
    expect(bucketFor(t.state, 'sub_toolu_a').status).toEqual({ type: 'idle' });
  });

  test('stop requested + `completed` notification of a foreground run is a stop, not a done card', () => {
    const t = make();
    t.apply(agentCall('toolu_a'));
    t.apply(started('ag1', 'toolu_a', { is_backgrounded: false }));
    t.mapper.markStopRequested();
    t.apply(notification('ag1', 'toolu_a', 'completed'));
    const tool = agentTool(t.state, 'toolu_a');
    expect(tool.state.status).toBe('error');
    expect(meta(tool).runStatus).toBe('stopped');
    expect(bucketFor(t.state, 'sub_toolu_a').status).toEqual({ type: 'idle' });
    // the aborted result and the tool_result that follow change nothing
    t.apply(toolResult('toolu_a', 'user cancelled', true));
    t.apply(abortedResult);
    expect(meta(agentTool(t.state, 'toolu_a')).runStatus).toBe('stopped');
  });

  test('without a stop request a foreground `completed` notification still completes the card', () => {
    const t = make();
    t.apply(agentCall('toolu_a'));
    t.apply(started('ag1', 'toolu_a', { is_backgrounded: false }));
    t.apply(notification('ag1', 'toolu_a', 'completed', { summary: 'fine' }));
    expect(agentTool(t.state, 'toolu_a').state.status).toBe('completed');
    expect(meta(agentTool(t.state, 'toolu_a')).runStatus).toBe('completed');
  });

  test('a background run reported `completed` while a stop is pending is not rewritten', () => {
    const t = make();
    t.apply(agentCall('toolu_a'));
    t.apply(started('ag1', 'toolu_a', { is_backgrounded: true }));
    t.mapper.markStopRequested();
    t.apply(notification('ag1', 'toolu_a', 'completed', { summary: 'finished anyway' }));
    expect(agentTool(t.state, 'toolu_a').state.status).toBe('completed');
  });

  test('a `stopped` notification and task_updated killed both end the run', () => {
    const t = make();
    t.apply(agentCall('toolu_a'));
    t.apply(started('ag1', 'toolu_a'));
    t.apply(agentCall('toolu_b'));
    t.apply(started('ag2', 'toolu_b'));
    t.apply(notification('ag1', 'toolu_a', 'stopped', { summary: 'Stopped by user' }));
    expect(agentTool(t.state, 'toolu_a').state.status).toBe('error');
    expect(meta(agentTool(t.state, 'toolu_a')).runStatus).toBe('stopped');
    expect(bucketFor(t.state, 'sub_toolu_a').status).toEqual({ type: 'idle' });
    t.apply({ type: 'system', subtype: 'task_updated', task_id: 'ag2', run_id: 'run_toolu_b', patch: { status: 'killed' } });
    expect(meta(agentTool(t.state, 'toolu_b')).runStatus).toBe('stopped');
    expect(bucketFor(t.state, 'sub_toolu_b').status).toEqual({ type: 'idle' });
    expect(t.mapper.runningTasks()).toEqual([]);
    // an unrelated status patch changes nothing
    t.apply(agentCall('toolu_c'));
    t.apply(started('ag3', 'toolu_c'));
    t.apply({ type: 'system', subtype: 'task_updated', task_id: 'ag3', run_id: 'run_toolu_c', patch: { status: 'running', description: 'x' } });
    expect(t.mapper.runningTasks()).toHaveLength(1);
  });

  test('a late notification after the aborted result is ignored (SendMessage card stays stopped)', () => {
    const t = make();
    t.apply(agentCall('toolu_a'));
    t.apply(started('ag1', 'toolu_a'));
    t.apply(notification('ag1', 'toolu_a', 'completed', { summary: 'first' }));
    t.apply(sendCall('toolu_s', 'ag1'));
    t.apply(started('ag1', 'toolu_s'));
    t.apply(abortedResult);
    const send = () => toolsByName(t.state, 'sendmessage')[0]!;
    expect(meta(send()).runStatus).toBe('stopped');
    t.apply(notification('ag1', 'toolu_s', 'completed', { summary: 'late reply' }));
    expect(meta(send()).runStatus).toBe('stopped');
    expect(meta(send()).reply).toBeUndefined();
    expect(bucketFor(t.state, 'sub_toolu_a').status).toEqual({ type: 'idle' });
  });

  test('interrupt, then a new SendMessage turn: the child runs again and ends idle', () => {
    const t = make();
    t.apply(agentCall('toolu_a'));
    t.apply(started('ag1', 'toolu_a'));
    t.mapper.markStopRequested();
    t.apply(abortedResult);
    expect(bucketFor(t.state, 'sub_toolu_a').status).toEqual({ type: 'idle' });
    t.turn('continue');
    t.apply(sendCall('toolu_s', 'ag1'));
    t.apply(started('ag1', 'toolu_s', { prompt: 'again' }));
    expect(bucketFor(t.state, 'sub_toolu_a').status).toEqual({ type: 'busy' });
    expect(t.mapper.runningTasks()).toHaveLength(1);
    t.apply(notification('ag1', 'toolu_s', 'completed', { summary: 'second' }));
    t.apply(okResult);
    expect(bucketFor(t.state, 'sub_toolu_a').status).toEqual({ type: 'idle' });
    expect(meta(toolsByName(t.state, 'sendmessage')[0]!).runStatus).toBe('completed');
  });

  test('"[Request interrupted by user" tool results read as an interrupt and mark the run stopped', () => {
    const t = make();
    t.apply(agentCall('toolu_a'));
    t.apply(started('ag1', 'toolu_a'));
    t.apply(toolResult('toolu_a', '[Request interrupted by user for tool use]', true));
    const tool = agentTool(t.state, 'toolu_a');
    expect((tool.state as { error: string }).error).toBe('Interrupted by user');
    expect(meta(tool).runStatus).toBe('stopped');
  });

  test('runFixture can skip finish() so a mapper that leaves children busy is caught', () => {
    const run = runFixture(sub('q2-sendmessage-async'), undefined, { skipFinish: true });
    for (const bucket of run.state.sessions.values()) expect(bucket.status).toEqual({ type: 'idle' });
  });
});

describe('real recordings: interrupting a foreground Agent run', () => {
  const STOP_LINES = new Set(['task_updated', 'task_notification']);
  for (const name of ['interrupt-agent-sync', 'interrupt-agent-running']) {
    const assertStopped = (run: ReturnType<typeof runFixture>) => {
      const { id: childId, bucket } = childOf(run.state, run.sessionId);
      const agent = toolsByName(run.state, 'task')[0]!;
      expect(agent.state.status).toBe('error');
      expect(meta(agent).runStatus).toBe('stopped');
      expect(bucket.status).toEqual({ type: 'idle' });
      expect(run.state.sessions.get(run.sessionId)!.status).toEqual({ type: 'idle' });
      expect(childId).toBe(`sub_${agent.callID}`);
      expect(run.mapper.runningTasks()).toEqual([]);
      expect(run.logs.filter((l) => l.level === 'warn')).toEqual([]);
    };

    // The CLI reports task_updated killed + task_notification `stopped` for an aborted foreground agent (not `completed`).
    test(`${name}: the CLI's own stop notifications end the run as stopped (no finish() needed)`, () => {
      assertStopped(runFixture(sub(name), undefined, { skipFinish: true }));
    });

    // The mapper must not depend on those notifications: the aborted `result` alone has to settle everything.
    test(`${name}: without the stop notifications the aborted result still stops the children`, () => {
      assertStopped(runFixture(sub(name), undefined, { skipFinish: true, filter: (l) => !(l.type === 'system' && STOP_LINES.has(l.subtype)) }));
    });

    // The worst case the CLI could produce: `completed` instead of `stopped`, after the host asked to stop.
    test(`${name}: a "completed" notification right after a stop request is still a stop`, () => {
      const lines = loadNdjson(sub(name));
      const started = lines.find((l) => l.type === 'system' && l.subtype === 'task_started')!;
      const mapper = createMapper({ sessionId: 's', cwd: '/w', mode: 'default', model: 'm', now: fakeClock() });
      const state = createSessionState('s');
      const feed = (e: ClaudeEvent[]) => reduceEvents(state, e);
      feed(mapper.startUserMessage({ content: 'go' }).events);
      const agentCall = lines.find((l) => l.type === 'assistant' && l.parent_tool_use_id == null && l.message.content.some((b: any) => b.name === 'Agent'))!;
      feed(mapper.apply(agentCall));
      feed(mapper.apply(started));
      mapper.markStopRequested();
      feed(mapper.apply({ ...lines.find((l) => l.type === 'system' && l.subtype === 'task_notification'), status: 'completed' }));
      feed(mapper.apply(lines.find((l) => l.type === 'result')));
      const agent = toolsByName(state, 'task')[0]!;
      expect(agent.state.status).toBe('error');
      expect(meta(agent).runStatus).toBe('stopped');
      expect(bucketFor(state, `sub_${agent.callID}`).status).toEqual({ type: 'idle' });
    });
  }
});
