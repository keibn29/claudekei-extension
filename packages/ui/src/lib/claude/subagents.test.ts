import { describe, expect, test } from 'bun:test';
import {
  bareAgentName,
  buildSubagentActivity,
  buildSubagentSteps,
  candidateChildSessionId,
  collectSubagentRun,
  deriveSubagentEnd,
  deriveSubagentStatus,
  findAgentByType,
  findRunError,
  findRunRange,
  findRunReply,
  firstLine,
  formatSubagentAction,
  formatSubagentElapsed,
  formatSubagentTokens,
  getSubagentKind,
  getSubagentStepLabel,
  isHiddenToolPart,
  listInstructions,
  readSubagentInput,
  readSubagentLink,
  resolveSubagentAlias,
  shouldCollapseInstruction,
  isStaleBusyChild,
  shouldShowNoActivityHint,
  summarizeSubagentStatuses,
  type ChildRecord,
  type SubagentStatusInput,
} from './subagents';
import type { Message, Part, ToolPart } from './types';

const tool = (overrides: Partial<ToolPart> & { state: ToolPart['state'] }): ToolPart => ({
  id: 'part_1',
  sessionID: 's1',
  messageID: 'm1',
  type: 'tool',
  tool: 'task',
  callID: 'toolu_1',
  claude: { name: 'Agent', input: {} },
  ...overrides,
});

const running = (input: Record<string, unknown> = {}, metadata?: Record<string, unknown>): ToolPart['state'] => ({
  status: 'running',
  input,
  metadata,
  time: { start: 1000 },
});

describe('tool identification', () => {
  test('maps Agent/task and SendMessage', () => {
    expect(getSubagentKind('task')).toBe('agent');
    expect(getSubagentKind('Agent')).toBe('agent');
    expect(getSubagentKind('sendmessage')).toBe('message');
    expect(getSubagentKind('SendMessage')).toBe('message');
    expect(getSubagentKind('read')).toBeNull();
    expect(getSubagentKind(undefined)).toBeNull();
  });
});

describe('hidden tool parts', () => {
  test('state.metadata.hidden hides a tool part', () => {
    const hidden = tool({ tool: 'ToolSearch', state: { status: 'completed', input: {}, output: '', title: '', metadata: { hidden: true }, time: { start: 1, end: 2 } } });
    expect(isHiddenToolPart(hidden)).toBe(true);
  });

  test('part-level metadata.hidden is honoured too', () => {
    expect(isHiddenToolPart(tool({ state: running(), metadata: { hidden: true } }))).toBe(true);
  });

  test('visible parts, non-tool parts and hidden=false are not hidden', () => {
    expect(isHiddenToolPart(tool({ state: running({}, { hidden: false }) }))).toBe(false);
    expect(isHiddenToolPart(tool({ state: running() }))).toBe(false);
    expect(isHiddenToolPart({ type: 'text', text: 'x', metadata: { hidden: true } })).toBe(false);
    expect(isHiddenToolPart(null)).toBe(false);
  });
});

describe('reading the tool part', () => {
  test('reads the SubagentToolMetadata keys', () => {
    const link = readSubagentLink(tool({
      state: running({}, {
        sessionID: 'sub_toolu_1',
        agentId: 'a1',
        agentType: 'claudekei:explorer',
        recipient: 'exp-1',
        message: 'hi',
        childMessageID: 'm_child',
        reply: 'done',
        runStatus: 'completed',
      }),
    }));
    expect(link).toEqual({
      sessionId: 'sub_toolu_1',
      agentId: 'a1',
      agentType: 'claudekei:explorer',
      recipient: 'exp-1',
      message: 'hi',
      childMessageId: 'm_child',
      reply: 'done',
      runStatus: 'completed',
    });
  });

  test('missing or invalid fields degrade to undefined', () => {
    const link = readSubagentLink(tool({ state: running({}, { runStatus: 'weird', sessionID: '  ' }) }));
    expect(link.sessionId).toBeUndefined();
    expect(link.runStatus).toBeUndefined();
    const pending = readSubagentLink(tool({ state: { status: 'pending', input: {}, raw: '' } }));
    expect(Object.values(pending).every((value) => value === undefined)).toBe(true);
  });

  test('reads Agent and SendMessage inputs', () => {
    expect(readSubagentInput(tool({ state: running({ description: 'd', prompt: 'p', subagent_type: 'claudekei:explorer', name: 'exp-1' }) }))).toMatchObject({
      description: 'd', prompt: 'p', subagentType: 'claudekei:explorer', name: 'exp-1',
    });
    expect(readSubagentInput(tool({ tool: 'sendmessage', state: running({ to: 'exp-1', message: 'm', summary: 's' }) }))).toMatchObject({
      to: 'exp-1', message: 'm', summary: 's',
    });
  });

  test('candidate child id follows sub_<tool_use_id>', () => {
    expect(candidateChildSessionId({ callID: 'toolu_9' })).toBe('sub_toolu_9');
    expect(candidateChildSessionId({ callID: '' })).toBeUndefined();
  });
});

describe('alias resolution', () => {
  const base = { link: {}, input: {} };
  test('Agent uses the spawn name, then the child alias', () => {
    expect(resolveSubagentAlias({ kind: 'agent', ...base, input: { name: 'exp-1' }, childAlias: 'x' })).toBe('exp-1');
    expect(resolveSubagentAlias({ kind: 'agent', ...base, childAlias: 'exp-1' })).toBe('exp-1');
    expect(resolveSubagentAlias({ kind: 'agent', ...base })).toBeUndefined();
  });

  test('SendMessage shows the recipient verbatim when it is an alias', () => {
    expect(resolveSubagentAlias({ kind: 'message', link: { recipient: 'exp-1' }, input: {}, childAlias: 'other' })).toBe('exp-1');
  });

  test('SendMessage with a raw agent id prefers the child alias, then a short id', () => {
    const id = 'aedf2479dbcf2d6f5';
    expect(resolveSubagentAlias({ kind: 'message', link: { recipient: id }, input: {}, childAlias: 'exp-1', agentId: id })).toBe('exp-1');
    expect(resolveSubagentAlias({ kind: 'message', link: { recipient: id }, input: {}, agentId: id })).toBe('aedf247');
  });
});

describe('deriveSubagentStatus', () => {
  const input = (overrides: Partial<SubagentStatusInput>): SubagentStatusInput => ({
    kind: 'agent', toolStatus: 'completed', hasSession: true, linkTimedOut: false, ...overrides,
  });

  test('pending tool input means preparing', () => {
    expect(deriveSubagentStatus(input({ toolStatus: 'pending' }))).toBe('preparing');
  });

  test('async Agent: tool completed but the child is busy stays running', () => {
    expect(deriveSubagentStatus(input({ childPhase: 'busy' }))).toBe('running');
    expect(deriveSubagentStatus(input({ childPhase: 'retry' }))).toBe('running');
  });

  test('the host run status is authoritative per instruction', () => {
    expect(deriveSubagentStatus(input({ runStatus: 'running', childPhase: 'idle' }))).toBe('running');
    expect(deriveSubagentStatus(input({ runStatus: 'completed', childPhase: 'busy' }))).toBe('done');
    expect(deriveSubagentStatus(input({ runStatus: 'error' }))).toBe('failed');
    expect(deriveSubagentStatus(input({ runStatus: 'stopped' }))).toBe('stopped');
  });

  test('settled and idle means done; tool error means failed', () => {
    expect(deriveSubagentStatus(input({ childPhase: 'idle' }))).toBe('done');
    expect(deriveSubagentStatus(input({ toolStatus: 'error', toolError: 'boom' }))).toBe('failed');
    expect(deriveSubagentStatus(input({ childPhase: 'idle', childFailed: true }))).toBe('failed');
  });

  test('a user abort reads as stopped, not failed', () => {
    expect(deriveSubagentStatus(input({ toolStatus: 'error', toolError: 'Interrupted by user' }))).toBe('stopped');
  });

  test('no session: running inside the link window, no-session after it', () => {
    expect(deriveSubagentStatus(input({ toolStatus: 'running', hasSession: false }))).toBe('running');
    expect(deriveSubagentStatus(input({ toolStatus: 'running', hasSession: false, linkTimedOut: true }))).toBe('no-session');
    expect(deriveSubagentStatus(input({ hasSession: false, linkTimedOut: true }))).toBe('no-session');
    expect(deriveSubagentStatus(input({ hasSession: false, linkTimedOut: false }))).toBe('running');
  });

  test('SendMessage: delivered and idle is sent, a tool error is not delivered', () => {
    expect(deriveSubagentStatus(input({ kind: 'message' }))).toBe('sent');
    expect(deriveSubagentStatus(input({ kind: 'message', toolStatus: 'error', toolError: 'unknown alias' }))).toBe('not-delivered');
  });

  test('SendMessage: tool completed while the resumed run is still going is running', () => {
    expect(deriveSubagentStatus(input({ kind: 'message', runStatus: 'running' }))).toBe('running');
    expect(deriveSubagentStatus(input({ kind: 'message', childPhase: 'busy' }))).toBe('running');
    expect(deriveSubagentStatus(input({ kind: 'message', runStatus: 'completed' }))).toBe('sent');
    expect(deriveSubagentStatus(input({ kind: 'message', runStatus: 'error' }))).toBe('failed');
  });
});

describe('stale busy child safety net', () => {
  const base = { childPhase: 'busy', parentIdle: true, toolStatus: 'error', runStatus: 'stopped' };
  test('busy child of an idle parent whose tool settled is ignored', () => {
    expect(isStaleBusyChild(base)).toBe(true);
    expect(isStaleBusyChild({ ...base, toolStatus: 'completed', runStatus: undefined })).toBe(true);
  });
  test('a running run, a busy parent, a running tool or a non-busy child keep their phase', () => {
    expect(isStaleBusyChild({ ...base, runStatus: 'running' })).toBe(false);
    expect(isStaleBusyChild({ ...base, parentIdle: false })).toBe(false);
    expect(isStaleBusyChild({ ...base, toolStatus: 'running' })).toBe(false);
    expect(isStaleBusyChild({ ...base, childPhase: 'retry' })).toBe(false);
  });
});

describe('group summary', () => {
  test('counts running, done and failed (delivery included)', () => {
    expect(summarizeSubagentStatuses(['preparing', 'running', 'done', 'sent', 'failed', 'not-delivered', 'stopped'])).toEqual({
      total: 7, running: 2, done: 2, failed: 2, stopped: 1,
    });
  });
});

describe('collectSubagentRun (parallel grouping)', () => {
  type Item = { kind: 'agent' | 'text' | 'reasoning' | 'read' };
  const isSubagent = (item: Item) => item.kind === 'agent';
  const isTransparent = (item: Item) => item.kind === 'reasoning';
  const run = (kinds: Item['kind'][], start = 0) =>
    collectSubagentRun(kinds.map((kind) => ({ kind })), start, isSubagent, isTransparent);

  test('adjacent subagent parts form one run', () => {
    expect(run(['agent', 'agent', 'agent'])).toEqual({ indexes: [0, 1, 2], next: 3 });
  });

  test('reasoning between calls does not break the run', () => {
    expect(run(['agent', 'reasoning', 'agent', 'agent'])).toEqual({ indexes: [0, 2, 3], next: 4 });
  });

  test('other parts end the run; trailing transparent items are not consumed', () => {
    expect(run(['agent', 'read', 'agent'])).toEqual({ indexes: [0], next: 1 });
    expect(run(['agent', 'agent', 'reasoning', 'text'])).toEqual({ indexes: [0, 1], next: 2 });
    expect(run(['agent', 'text', 'agent'])).toEqual({ indexes: [0], next: 1 });
  });

  test('a lone call is a run of one (renders as a plain card)', () => {
    expect(run(['read', 'agent', 'read'], 1).indexes).toEqual([1]);
  });
});

const user = (id: string, text: string, extra: Record<string, unknown> = {}): ChildRecord => ({
  info: { id, sessionID: 'sub', role: 'user', time: { created: 1 }, agent: 'x', model: { providerID: 'anthropic', modelID: 'm' }, ...extra } as Message,
  parts: [{ id: `${id}_t`, sessionID: 'sub', messageID: id, type: 'text', text } as Part],
});
const assistant = (id: string, parts: Part[], extra: Record<string, unknown> = {}): ChildRecord => ({
  info: { id, sessionID: 'sub', role: 'assistant', parentID: 'u', time: { created: 2 }, ...extra } as Message,
  parts,
});
const toolStep = (id: string, name: string, input: Record<string, unknown>, status = 'completed', extra: Record<string, unknown> = {}): Part => ({
  id, sessionID: 'sub', messageID: 'a', type: 'tool', tool: name, callID: `c_${id}`, claude: { name, input },
  state: { status, input, title: '', output: '', metadata: extra, time: { start: 1, end: 2 } },
} as unknown as Part);
const textPart = (id: string, text: string): Part => ({ id, sessionID: 'sub', messageID: 'a', type: 'text', text } as Part);

describe('child session content', () => {
  const records: ChildRecord[] = [
    user('u1', 'Find call sites', { instruction: { kind: 'initial', index: 1, fromSessionID: 'p', toolCallID: 'toolu_agent', fromAgent: 'claudekei:orchestrator' } }),
    assistant('a1', [toolStep('t1', 'grep', { pattern: 'SendMessage' }), toolStep('t2', 'read', { filePath: '/a/b.ts' }), toolStep('t3', 'task', {}), textPart('x1', 'first reply')]),
    user('u2', 'Also check the schema', { instruction: { kind: 'followup', index: 2, fromSessionID: 'p', toolCallID: 'toolu_send', fromAgent: 'claudekei:orchestrator' } }),
    assistant('a2', [toolStep('t4', 'glob', { pattern: 'src/**' }, 'running'), textPart('x2', 'second reply')]),
  ];

  test('steps skip nested agent calls, todo bookkeeping and hidden parts', () => {
    const steps = buildSubagentSteps([
      ...records.slice(0, 2),
      assistant('a3', [toolStep('t9', 'ToolSearch', {}, 'completed', { hidden: true }), toolStep('t10', 'todowrite', {})]),
    ]);
    expect(steps.map((step) => step.tool)).toEqual(['grep', 'read']);
    expect(getSubagentStepLabel(steps[0])).toBe('SendMessage');
    expect(getSubagentStepLabel(steps[1])).toBe('/a/b.ts');
  });

  test('Agent run = the first instruction up to the next one', () => {
    const range = findRunRange(records, { kind: 'agent', toolCallId: 'toolu_agent' });
    expect(range).toMatchObject({ start: 1, end: 2, matched: true, userMessageId: 'u1' });
    expect(buildSubagentSteps(records, range).map((step) => step.tool)).toEqual(['grep', 'read']);
    expect(findRunReply(records, range)).toBe('first reply');
  });

  test('SendMessage run is found by child message id, then by tool call id', () => {
    const byId = findRunRange(records, { kind: 'message', childMessageId: 'u2' });
    expect(byId).toMatchObject({ start: 3, end: 4, matched: true });
    const byCall = findRunRange(records, { kind: 'message', toolCallId: 'toolu_send' });
    expect(byCall.userMessageId).toBe('u2');
    expect(buildSubagentSteps(records, byCall).map((step) => step.tool)).toEqual(['glob']);
    expect(findRunReply(records, byCall)).toBe('second reply');
  });

  test('SendMessage falls back to the message text, then to the whole session', () => {
    expect(findRunRange(records, { kind: 'message', messageText: 'Also check the schema' }).userMessageId).toBe('u2');
    const whole = findRunRange(records, { kind: 'message', toolCallId: 'unknown' });
    expect(whole).toEqual({ start: 0, end: 4, matched: false });
  });

  test('Agent without instruction markers uses the first user message; no user message = whole session', () => {
    const plain = [user('u1', 'go'), assistant('a1', [toolStep('t1', 'read', { filePath: 'x' })])];
    expect(findRunRange(plain, { kind: 'agent', toolCallId: 'nope' })).toMatchObject({ start: 1, end: 2, matched: true });
    expect(findRunRange([assistant('a', [])], { kind: 'agent' })).toEqual({ start: 0, end: 1, matched: false });
  });

  test('run error comes from the last assistant message of the run', () => {
    const failing = [user('u1', 'go'), assistant('a1', [], { error: { name: 'E', message: 'boom' } })];
    expect(findRunError(failing, { start: 1, end: 2 })).toBe('boom');
    expect(findRunError(records, { start: 1, end: 2 })).toBeUndefined();
  });

  test('instruction timeline uses host markers and falls back to user message order', () => {
    expect(listInstructions(records).map((entry) => [entry.index, entry.kind, entry.toolCallId, entry.fromAgent])).toEqual([
      [1, 'initial', 'toolu_agent', 'claudekei:orchestrator'],
      [2, 'followup', 'toolu_send', 'claudekei:orchestrator'],
    ]);
    const plain = [user('u1', 'a'), assistant('a1', []), user('u2', 'b')];
    expect(listInstructions(plain).map((entry) => [entry.index, entry.kind, entry.text])).toEqual([
      [1, 'initial', 'a'],
      [2, 'followup', 'b'],
    ]);
  });
});

describe('timing and formatting', () => {
  test('end time prefers task_progress duration, then child update, then tool end', () => {
    expect(deriveSubagentEnd({ startedAt: 1000, progressDurationMs: 5000, childUpdatedAt: 9000, toolEnd: 1100 })).toBe(6000);
    expect(deriveSubagentEnd({ startedAt: 1000, childUpdatedAt: 9000, toolEnd: 1100 })).toBe(9000);
    expect(deriveSubagentEnd({ startedAt: 1000, childUpdatedAt: 500, toolEnd: 1100 })).toBe(1100);
  });

  test('elapsed and token formatting', () => {
    expect(formatSubagentElapsed(12_400)).toBe('12s');
    expect(formatSubagentElapsed(12_340, true)).toBe('12.3s');
    expect(formatSubagentElapsed(65_000)).toBe('1m 05s');
    expect(formatSubagentTokens(950)).toBe('950');
    expect(formatSubagentTokens(12_400)).toBe('12.4k');
    expect(formatSubagentTokens(2000)).toBe('2k');
  });

  test('instructions collapse past 4 lines or 280 characters', () => {
    expect(shouldCollapseInstruction('short')).toBe(false);
    expect(shouldCollapseInstruction('a\nb\nc\nd')).toBe(false);
    expect(shouldCollapseInstruction('a\nb\nc\nd\ne')).toBe(true);
    expect(shouldCollapseInstruction('x'.repeat(281))).toBe(true);
    expect(firstLine('\n  \nhello\nworld')).toBe('hello');
  });
});

describe('agent type lookup', () => {
  const agents = [{ name: 'claudekei:explorer' }, { name: 'Explore' }];
  test('matches exact names, then the bare name without the plugin prefix', () => {
    expect(findAgentByType(agents, 'claudekei:explorer')?.name).toBe('claudekei:explorer');
    expect(findAgentByType(agents, 'explorer')?.name).toBe('claudekei:explorer');
    expect(findAgentByType(agents, 'unknown')).toBeUndefined();
    expect(findAgentByType(agents, undefined)).toBeUndefined();
    expect(bareAgentName('claudekei:explorer')).toBe('explorer');
  });
});

describe('subagent activity (last actions)', () => {
  const records: ChildRecord[] = [
    user('u1', 'go'),
    assistant('a1', [
      textPart('x0', 'Let me look.\nSecond line'),
      toolStep('t1', 'grep', { pattern: 'SendMessage' }),
      toolStep('t2', 'read', { filePath: '/a/b.ts' }),
      toolStep('t3', 'bash', { command: 'npm test\n# more' }),
      toolStep('t4', 'ToolSearch', {}, 'completed', { hidden: true }),
      toolStep('t5', 'task', {}),
    ], { time: { created: 2, completed: 3 } }),
    assistant('a2', [toolStep('t6', 'glob', { pattern: 'src/**' }, 'running'), textPart('x1', 'Found it.')]),
  ];

  test('lists tool calls and text snippets in order, hiding hidden and nested-agent parts', () => {
    const items = buildSubagentActivity(records, undefined, 10);
    expect(items.map((item) => [item.kind, item.tool ?? item.text])).toEqual([
      ['text', 'Let me look.'],
      ['tool', 'grep'],
      ['tool', 'read'],
      ['tool', 'bash'],
      ['tool', 'glob'],
      ['text', 'Found it.'],
    ]);
  });

  test('keeps only the last N, newest last', () => {
    expect(buildSubagentActivity(records, undefined, 3).map((item) => item.id)).toEqual(['t3', 't6', 'x1']);
    expect(buildSubagentActivity(records).length).toBe(5);
  });

  test('the in-progress item is a running tool or streaming text', () => {
    const running = buildSubagentActivity(records.slice(0, 2).concat(assistant('a3', [toolStep('t9', 'read', { filePath: 'x' }, 'running')])));
    expect(running[running.length - 1].active).toBe(true);
    expect(running.filter((item) => item.active)).toHaveLength(1);
    // a2 has no completion time: its trailing text is still streaming
    expect(buildSubagentActivity(records).at(-1)?.active).toBe(true);
    const settled = [...records.slice(0, 2), assistant('a2', [textPart('x1', 'Done.')], { time: { created: 3, completed: 4 } })];
    expect(buildSubagentActivity(settled).every((item) => !item.active)).toBe(true);
  });

  test('is scoped to the run range', () => {
    const range = { start: 1, end: 2 };
    expect(buildSubagentActivity(records, range, 10).map((item) => item.id)).toEqual(['x0', 't1', 't2', 't3']);
    expect(buildSubagentActivity([], undefined)).toEqual([]);
  });

  test('formats short action labels', () => {
    expect(formatSubagentAction({ tool: 'read', input: { filePath: 'src/foo.ts' } })).toEqual({ verb: 'Read', detail: 'src/foo.ts' });
    expect(formatSubagentAction({ tool: 'bash', input: { command: 'npm test\nmore' } })).toEqual({ verb: 'Bash', detail: 'npm test' });
    expect(formatSubagentAction({ tool: 'grep', input: { pattern: 'x' } })).toEqual({ verb: 'Grep', detail: "'x'" });
    expect(formatSubagentAction({ tool: 'webfetch', title: 'https://a.b' })).toEqual({ verb: 'Fetch', detail: 'https://a.b' });
    expect(formatSubagentAction({ tool: 'custom_tool' }).verb).toBe('Custom_tool');
  });
});

describe('empty activity state', () => {
  test('"No activity yet" only while the run is running', () => {
    expect(shouldShowNoActivityHint('running')).toBe(true);
    for (const status of ['done', 'sent', 'failed', 'stopped', 'no-session'] as const) {
      expect(shouldShowNoActivityHint(status)).toBe(false);
    }
  });
});
