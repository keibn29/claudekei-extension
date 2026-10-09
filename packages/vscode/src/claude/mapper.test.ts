import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import type { ToolPart } from '@openchamber/ui/src/lib/claude/types';
import { createMapper } from './mapper';
import {
  allToolParts,
  creationOrderIds,
  FIXTURES,
  fakeClock,
  normalizeBucket,
  runFixture,
} from './testUtils';

const fixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith('.ndjson'))
  .map((f) => f.replace(/\.ndjson$/, ''))
  .sort();

const INTERRUPT_FIXTURES = new Set(['interrupt', 'interrupt-text']);

describe('golden: every fixture maps cleanly', () => {
  for (const name of fixtures) {
    test(name, () => {
      const run = runFixture(name);

      // no exceptions swallowed by the mapper and no unknown-message noise
      expect(run.logs.filter((l) => l.level === 'warn')).toEqual([]);

      // ids ascend in creation order and are unique
      const order = creationOrderIds(run.events);
      expect([...order].sort()).toEqual(order);
      expect(new Set(order).size).toBe(order.length);

      // every tool part ends completed/error; interrupts end in error
      const tools = allToolParts(run.state);
      for (const t of tools) expect(['completed', 'error']).toContain(t.state.status);
      if (INTERRUPT_FIXTURES.has(name)) {
        expect(tools.every((t) => t.state.status === 'error')).toBe(true);
      }

      // every session ends idle
      for (const bucket of run.state.sessions.values()) expect(bucket.status).toEqual({ type: 'idle' });

      // messages / parts are sorted by id in the folded state
      for (const bucket of run.state.sessions.values()) {
        expect(bucket.messages.map((m) => m.id)).toEqual([...bucket.messages.map((m) => m.id)].sort());
        for (const parts of Object.values(bucket.parts)) expect(parts.map((p) => p.id)).toEqual([...parts.map((p) => p.id)].sort());
      }

      // assistant messages point at an existing user message, and none is left open
      const userIds = new Set(run.main.messages.filter((m) => m.role === 'user').map((m) => m.id));
      for (const m of run.main.messages) {
        if (m.role === 'assistant') {
          expect(m.parentID === '' || userIds.has(m.parentID)).toBe(true);
          expect(m.time.completed).toBeDefined();
        }
      }

      // golden snapshot of the final reduced state (+ event type histogram)
      const histogram: Record<string, number> = {};
      for (const e of run.events) histogram[e.type] = (histogram[e.type] ?? 0) + 1;
      expect({ histogram, main: normalizeBucket(run.main), children: [...run.state.sessions.keys()].filter((k) => k !== run.sessionId).map((k) => ({ id: k.replace(/^sub_.*/, 'sub_<toolUseId>'), state: normalizeBucket(run.state.sessions.get(k)!) })), errors: run.state.errors }).toMatchSnapshot();
    });
  }
});

const toolsOf = (name: string): ToolPart[] => allToolParts(runFixture(name).state);
const textOf = (name: string): string[] => {
  const run = runFixture(name);
  return run.main.messages.flatMap((m) => (run.main.parts[m.id] ?? []).filter((p) => p.type === 'text').map((p) => (p as { text: string }).text));
};

describe('targeted behaviour', () => {
  test('text: streamed deltas fold into the final text; user message + assistant link', () => {
    const run = runFixture('text');
    const [user, assistant] = run.main.messages;
    expect(user!.role).toBe('user');
    expect(assistant!.role).toBe('assistant');
    expect((assistant as { parentID: string }).parentID).toBe(user!.id);
    expect(textOf('text')).toEqual(['Reply with exactly: hello', 'hello']);
    expect((assistant as { cost: number }).cost).toBeGreaterThan(0);
    expect((assistant as { tokens: { output: number } }).tokens.output).toBeGreaterThan(0);
    expect(run.events.some((e) => e.type === 'message.part.delta')).toBe(true);
  });

  test('thinking: summarized reasoning text vs empty by default', () => {
    const reasoning = (name: string) => {
      const run = runFixture(name);
      return run.main.messages.flatMap((m) => (run.main.parts[m.id] ?? []).filter((p) => p.type === 'reasoning').map((p) => (p as { text: string }).text));
    };
    expect(reasoning('thinking').some((t) => t.length > 0)).toBe(true);
    expect(reasoning('thinking-default').every((t) => t === '')).toBe(true);
  });

  test('edit: completed with filediff, normalized input, relative title', () => {
    const edit = toolsOf('edit').find((t) => t.tool === 'edit')!;
    expect(edit.claude.name).toBe('Edit');
    expect(edit.state.status).toBe('completed');
    const state = edit.state as Extract<ToolPart['state'], { status: 'completed' }>;
    expect(state.input).toMatchObject({ filePath: expect.stringContaining('src/app.ts'), oldString: "'Hello, '", newString: "'Hi, '" });
    expect(state.title).toBe('src/app.ts');
    const fd = state.metadata.filediff as { file: string; additions: number; deletions: number; patch: string };
    expect(fd).toMatchObject({ file: 'src/app.ts', additions: 1, deletions: 1 });
    expect(fd.patch).toContain("+  return 'Hi, ' + name;");
    expect(typeof state.metadata.diff).toBe('string');
  });

  test('edit-parallel: both edits complete with their own diffs', () => {
    const edits = toolsOf('edit-parallel').filter((t) => t.tool === 'edit');
    expect(edits).toHaveLength(2);
    expect(edits.every((t) => t.state.status === 'completed')).toBe(true);
  });

  test('write: create diff synthesized against /dev/null', () => {
    const write = toolsOf('write').find((t) => t.tool === 'write')!;
    const meta = (write.state as unknown as { metadata: Record<string, any> }).metadata;
    expect(meta.filediff.file).toBe('docs/out.txt');
    expect(meta.filediff.additions).toBe(1);
    expect(meta.filediff.patch).toContain('--- /dev/null');
  });

  test('bash / read / grep / glob', () => {
    expect(toolsOf('bash').find((t) => t.tool === 'bash')!.state.status).toBe('completed');
    const read = toolsOf('read').find((t) => t.tool === 'read')!;
    expect((read.state as unknown as { metadata: Record<string, unknown> }).metadata.totalLines).toBeDefined();
    const names = toolsOf('grep').map((t) => t.tool);
    expect(names).toContain('grep');
    expect(names).toContain('glob');
  });

  test('todowrite: todo.updated events, final list', () => {
    const run = runFixture('todowrite');
    expect(run.main.todos.map((t) => [t.content, t.status])).toEqual([
      ['a', 'completed'],
      ['b', 'pending'],
      ['c', 'pending'],
    ]);
    expect(run.main.todos[0]!.activeForm).toBe('Working on a');
    expect(run.events.filter((e) => e.type === 'todo.updated').length).toBeGreaterThanOrEqual(2);
  });

  test('tasks-v2 (default CLI env): TaskCreate/TaskUpdate become todos', () => {
    const run = runFixture('tasks-v2');
    expect(run.main.todos.map((t) => [t.content, t.status])).toEqual([
      ['a', 'completed'],
      ['b', 'pending'],
      ['c', 'pending'],
    ]);
  });

  test('task-sync: child session created, tool completed with unwrapped report, child idle', () => {
    const run = runFixture('task-sync');
    const task = allToolParts(run.state).find((t) => t.tool === 'task')!;
    expect(task.claude.name).toBe('Agent');
    expect(task.state.status).toBe('completed');
    expect((task.state as unknown as { output: string }).output).toBe('hello from the sandbox');
    const childId = `sub_${task.callID}`;
    expect((task.state as unknown as { metadata: { sessionID: string } }).metadata.sessionID).toBe(childId);
    expect(run.events.some((e) => e.type === 'session.created' && e.properties.sessionID === childId && e.properties.info.parentID === run.sessionId)).toBe(true);
    const child = run.state.sessions.get(childId)!;
    expect(child.status).toEqual({ type: 'idle' });
    // subagent prompt + its own Read tool live in the child
    expect(child.messages.some((m) => m.role === 'user')).toBe(true);
    expect(allToolParts(run.state).some((t) => t.tool === 'read' && t.sessionID === childId)).toBe(true);
  });

  test('task (default background mode): stays running after the async launch, completes on task_notification', () => {
    const run = runFixture('task');
    const task = allToolParts(run.state).find((t) => t.tool === 'task')!;
    expect(task.state.status).toBe('completed');
    expect((task.state as unknown as { output: string }).output).toBe('hello from the sandbox');
    // it was observed running (async) before completion
    const states = run.events
      .filter((e) => e.type === 'message.part.updated' && e.properties.part.type === 'tool' && e.properties.part.callID === task.callID)
      .map((e) => (e.type === 'message.part.updated' ? (e.properties.part as ToolPart).state.status : ''));
    expect(states).toContain('running');
    expect(states.lastIndexOf('running')).toBeLessThan(states.indexOf('completed'));
    // two results in one stream: main ends idle
    expect(run.main.status).toEqual({ type: 'idle' });
  });

  test('permission-denied: tool ends in error with the deny message', () => {
    const edit = toolsOf('permission-denied').find((t) => t.tool === 'edit')!;
    expect(edit.state.status).toBe('error');
    expect((edit.state as unknown as { error: string }).error).toContain('User rejected');
  });

  test('interrupt: running Bash becomes an error, no session.error is raised', () => {
    const run = runFixture('interrupt');
    const bash = allToolParts(run.state).find((t) => t.tool === 'bash')!;
    expect(bash.state.status).toBe('error');
    expect((bash.state as unknown as { error: string }).error).toBe('Interrupted by user');
    expect(run.state.errors).toEqual([]);
  });

  test('interrupt-text: streamed thinking is kept, session idle, no error notification', () => {
    const run = runFixture('interrupt-text');
    expect(run.state.errors).toEqual([]);
    expect(run.main.status).toEqual({ type: 'idle' });
  });

  test('error: invalid model -> message.error + session.error(kind api)', () => {
    const run = runFixture('error');
    const assistant = run.main.messages.find((m) => m.role === 'assistant') as { error?: { name: string } };
    expect(assistant.error?.name).toBe('model_not_found');
    expect(run.state.errors).toHaveLength(1);
    expect(run.state.errors[0]).toMatchObject({ kind: 'api', name: 'model_not_found' });
  });

  test('askuserquestion / plan-exit tool parts', () => {
    const q = toolsOf('askuserquestion').find((t) => t.tool === 'question')!;
    expect(q.state.status).toBe('completed');
    expect((q.state as unknown as { input: { questions: Array<{ multiple: boolean }> } }).input.questions[0]!.multiple).toBe(true);
    expect((q.state as unknown as { metadata: { answers: Record<string, string> } }).metadata.answers).toEqual({ 'Which colors do you like?': 'Red, Green' });
    const plan = toolsOf('plan-exit').find((t) => t.tool === 'plan_exit')!;
    expect(plan.state.status).toBe('completed');
    expect(typeof (plan.state as unknown as { metadata: { plan: string } }).metadata.plan).toBe('string');
  });

  test('compact: synthetic "Context compacted" message', () => {
    const run = runFixture('compact');
    const synthetic = run.main.messages.flatMap((m) => (run.main.parts[m.id] ?? []).filter((p) => p.type === 'text' && (p as { synthetic?: boolean }).synthetic));
    expect(synthetic.map((p) => (p as { text: string }).text)).toEqual(['Context compacted']);
    expect(run.main.messages.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  test('hook-block: a UserPromptSubmit decision:block becomes session.error(kind hook) with the reason, no assistant notice', () => {
    for (const name of ['hook-block', 'hook-block-events']) {
      const run = runFixture(name);
      expect(run.main.messages.filter((m) => m.role === 'assistant')).toHaveLength(0);
      expect(run.state.errors).toEqual([{ sessionID: run.sessionId, name: 'HookBlocked', message: 'Blocked by test hook: switched agent', kind: 'hook' }]);
      expect(run.main.status).toEqual({ type: 'idle' });
    }
  });

  test('informational messages other than hook blocks still render as a synthetic notice', () => {
    const { mapper } = (() => {
      const m = createMapper({ sessionId: 's', cwd: '/w', mode: 'default', model: 'm', now: fakeClock() });
      return { mapper: m };
    })();
    mapper.startUserMessage({ content: 'x' });
    const events = mapper.apply({ type: 'system', subtype: 'informational', content: 'Heads up', level: 'notice' });
    const part = events.map((e) => (e.type === 'message.part.updated' ? e.properties.part : undefined)).filter((p) => p?.type === 'text').at(-1);
    expect(part && part.type === 'text' && [part.text, part.synthetic]).toEqual(['Heads up', true]);
  });

  test('multi-turn: second assistant answers the second user message', () => {
    const run = runFixture('multi-turn');
    const users = run.main.messages.filter((m) => m.role === 'user');
    const assistants = run.main.messages.filter((m) => m.role === 'assistant') as Array<{ parentID: string }>;
    expect(users).toHaveLength(2);
    expect(assistants[0]!.parentID).toBe(users[0]!.id);
    expect(assistants[assistants.length - 1]!.parentID).toBe(users[1]!.id);
    expect(run.inits).toBe(2);
  });

  test('status: busy then idle, never leaves the session busy', () => {
    const run = runFixture('edit');
    const statuses = run.events.filter((e) => e.type === 'session.status').map((e) => (e.type === 'session.status' ? e.properties.status.type : ''));
    expect(statuses[0]).toBe('busy');
    expect(statuses[statuses.length - 1]).toBe('idle');
  });

  test('hooks: onInit receives init info; user settings hook/commands messages do not warn', () => {
    const seen: string[] = [];
    const commands: number[] = [];
    const run = runFixture('text-usersettings', { onCommandsChanged: (c) => commands.push(c.length) });
    expect(run.logs.filter((l) => l.level === 'warn')).toEqual([]);
    expect(commands.length).toBe(1);
    expect(seen).toEqual([]);
    expect(run.inits).toBe(1);
  });
});

describe('tolerance', () => {
  const make = () => {
    const logs: string[] = [];
    const mapper = createMapper({ sessionId: 's', cwd: '/w', mode: 'default', model: 'haiku', now: fakeClock(), log: (_l, m) => logs.push(m) });
    return { mapper, logs };
  };

  test('unknown and malformed messages never throw and are logged once', () => {
    const { mapper, logs } = make();
    for (const bad of [null, undefined, 1, 'x', [], {}, { type: 'weird' }, { type: 'weird' }, { type: 'system', subtype: 'nope' }, { type: 'stream_event' }, { type: 'assistant' }, { type: 'user', message: 5 }, { type: 'result' }, { type: 'stream_event', event: { type: 'content_block_delta', index: 3 } }]) {
      expect(() => mapper.apply(bad)).not.toThrow();
    }
    expect(logs.filter((l) => l.includes('weird'))).toHaveLength(1);
  });

  test('stream gap: assistant message alone (no stream events) still builds the parts', () => {
    const { mapper } = make();
    mapper.startUserMessage({ content: 'hi' });
    const events = mapper.apply({
      type: 'assistant',
      uuid: 'u1',
      parent_tool_use_id: null,
      message: { id: 'msg_1', model: 'm', stop_reason: null, content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] },
    });
    const parts = events.filter((e) => e.type === 'message.part.updated').map((e) => (e.type === 'message.part.updated' ? e.properties.part : undefined));
    expect(parts.map((p) => p?.type)).toContain('text');
    expect(parts.some((p) => p?.type === 'tool' && p.state.status === 'running')).toBe(true);
  });

  test('late deltas after the assistant block is reconciled are dropped (no duplicated text)', () => {
    const { mapper } = make();
    mapper.startUserMessage({ content: 'hi' });
    const base = { session_id: 's', parent_tool_use_id: null, api_message_id: 'msg_1' };
    mapper.apply({ type: 'stream_event', ...base, event: { type: 'message_start', message: { id: 'msg_1', model: 'm' } } });
    mapper.apply({ type: 'stream_event', ...base, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
    mapper.apply({ type: 'stream_event', ...base, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } } });
    mapper.apply({ type: 'assistant', uuid: 'u', parent_tool_use_id: null, message: { id: 'msg_1', content: [{ type: 'text', text: 'hello' }] } });
    const late = mapper.apply({ type: 'stream_event', ...base, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } } });
    expect(late).toEqual([]);
  });

  test('finish() fails still-running tools and idles the session', () => {
    const { mapper } = make();
    mapper.startUserMessage({ content: 'hi' });
    mapper.apply({ type: 'assistant', uuid: 'u', parent_tool_use_id: null, message: { id: 'msg_1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 1' } }] } });
    const events = mapper.finish('ended');
    const tool = events.map((e) => (e.type === 'message.part.updated' ? e.properties.part : undefined)).find((p) => p?.type === 'tool');
    expect(tool && tool.type === 'tool' && tool.state.status).toBe('error');
    expect(events.some((e) => e.type === 'session.status' && e.properties.status.type === 'idle')).toBe(true);
  });

  test('user message carries agent (A1), falls back to the mode; configure() updates defaults', () => {
    const a = createMapper({ sessionId: 's', cwd: '/w', mode: 'plan', model: 'm', agent: 'claudekei:orchestrator', now: fakeClock() });
    const first = a.startUserMessage({ content: 'x' }).events.find((e) => e.type === 'message.updated');
    expect(first && first.type === 'message.updated' && (first.properties.info as { agent: string }).agent).toBe('claudekei:orchestrator');
    a.configure({ agent: 'claudekei:planner' });
    const second = a.startUserMessage({ content: 'y' }).events.find((e) => e.type === 'message.updated');
    expect(second && second.type === 'message.updated' && (second.properties.info as { agent: string }).agent).toBe('claudekei:planner');
    const b = createMapper({ sessionId: 's', cwd: '/w', mode: 'plan', model: 'm', now: fakeClock() });
    const ev = b.startUserMessage({ content: 'x' }).events.find((e) => e.type === 'message.updated');
    expect(ev && ev.type === 'message.updated' && (ev.properties.info as { agent: string }).agent).toBe('plan');
  });

  test('image attachments become FileParts on the user message', () => {
    const { mapper } = make();
    const { events } = mapper.startUserMessage({
      content: [{ type: 'text', text: 'see' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
    });
    const file = events.map((e) => (e.type === 'message.part.updated' ? e.properties.part : undefined)).find((p) => p?.type === 'file');
    expect(file && file.type === 'file' && file.url).toBe('data:image/png;base64,AAAA');
  });
});
