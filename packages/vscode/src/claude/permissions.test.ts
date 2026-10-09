import { describe, expect, test } from 'bun:test';
import type { ClaudeEvent } from '@openchamber/ui/src/lib/claude/protocol';
import { PermissionBroker, summarizeSuggestion, type CanUseToolOptions } from './permissions';

const make = (setMode: (m: string) => Promise<void> = async () => undefined) => {
  const events: ClaudeEvent[] = [];
  const broker = new PermissionBroker({
    sessionId: 'main',
    cwd: '/w',
    emit: (e) => events.push(...e),
    findTool: (id) => (id === 'toolu_1' ? { messageID: 'msg1' } : undefined),
    setPermissionMode: setMode as never,
  });
  const ctl = new AbortController();
  const opts = (extra: Partial<CanUseToolOptions> = {}): CanUseToolOptions => ({ signal: ctl.signal, toolUseID: 'toolu_1', requestId: 'req1', ...extra });
  return { broker, events, ctl, opts };
};

describe('summarizeSuggestion', () => {
  test('readable summaries', () => {
    expect(summarizeSuggestion({ type: 'setMode', mode: 'acceptEdits', destination: 'session' })).toBe('Auto-accept edits for this session');
    expect(summarizeSuggestion({ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'mkdir -p out' }, { toolName: 'Bash', ruleContent: 'echo hi *' }] })).toBe(
      'Always allow Bash(mkdir -p out), Bash(echo hi *) (saved to .claude/settings.local.json)',
    );
    expect(summarizeSuggestion({ type: 'addDirectories', directories: ['/a'], destination: 'session' })).toBe('Allow access to /a');
  });
});

describe('PermissionBroker tools', () => {
  const edit = { file_path: '/w/src/a.ts', old_string: 'a', new_string: 'b' };
  const suggestions = [{ type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const }];

  test('request shape: normalized tool, relative pattern, diff, always summaries, tool ref', () => {
    const { broker, events, opts } = make();
    void broker.canUseTool('Edit', edit, opts({ suggestions, description: 'a.ts', displayName: 'Edit' }));
    const asked = events[0]!;
    if (asked.type !== 'permission.asked') throw new Error();
    expect(asked.properties).toMatchObject({
      id: 'req1',
      sessionID: 'main',
      permission: 'edit',
      patterns: ['src/a.ts'],
      always: ['Auto-accept edits for this session'],
      tool: { messageID: 'msg1', callID: 'toolu_1' },
    });
    expect(asked.properties.metadata.filepath).toBe('/w/src/a.ts');
    expect(String(asked.properties.metadata.diff)).toContain('+b');
    expect(broker.permissions).toHaveLength(1);
  });

  test('once / always / reject results', async () => {
    for (const [reply, expected] of [
      ['once', { behavior: 'allow', updatedInput: edit }],
      ['always', { behavior: 'allow', updatedInput: edit, updatedPermissions: suggestions }],
      ['reject', { behavior: 'deny', message: 'User rejected' }],
    ] as const) {
      const { broker, events, opts } = make();
      const promise = broker.canUseTool('Edit', edit, opts({ suggestions }));
      expect(broker.respondPermission('req1', reply)).toBe(true);
      expect(await promise).toEqual(expected);
      expect(events.at(-1)).toEqual({ type: 'permission.replied', properties: { sessionID: 'main', requestID: 'req1', reply } });
      expect(broker.permissions).toEqual([]);
      expect(broker.respondPermission('req1', reply)).toBe(false);
    }
  });

  test('always without suggestions degrades to once; always list is empty', async () => {
    const { broker, events, opts } = make();
    const promise = broker.canUseTool('Bash', { command: 'ls -la' }, opts());
    const asked = events[0]!;
    if (asked.type !== 'permission.asked') throw new Error();
    expect(asked.properties.always).toEqual([]);
    expect(asked.properties.patterns).toEqual(['ls -la']);
    broker.respondPermission('req1', 'always');
    expect(await promise).toEqual({ behavior: 'allow', updatedInput: { command: 'ls -la' } });
  });

  test('subagent prompts surface on the parent session', () => {
    const { broker, events, opts } = make();
    void broker.canUseTool('Bash', { command: 'x' }, opts({ agentID: 'agent-1' }));
    expect((events[0] as any).properties.sessionID).toBe('main');
  });

  test('abort rejects the prompt and clears it in the UI', async () => {
    const { broker, events, ctl, opts } = make();
    const promise = broker.canUseTool('Bash', { command: 'x' }, opts());
    ctl.abort();
    expect(await promise).toMatchObject({ behavior: 'deny', interrupt: true });
    expect(events.at(-1)).toMatchObject({ type: 'permission.replied', properties: { reply: 'reject' } });
    expect(broker.size).toBe(0);
  });

  test('already aborted signal denies immediately without a prompt', async () => {
    const { broker, events, ctl, opts } = make();
    ctl.abort();
    expect(await broker.canUseTool('Bash', { command: 'x' }, opts())).toMatchObject({ behavior: 'deny' });
    expect(events).toEqual([]);
  });

  test('denyAll clears permissions and questions', async () => {
    const { broker, events, opts } = make();
    const a = broker.canUseTool('Bash', { command: 'x' }, opts());
    const b = broker.canUseTool('AskUserQuestion', { questions: [] }, opts({ requestId: 'req2' }));
    broker.denyAll('bye');
    expect(await a).toMatchObject({ behavior: 'deny', message: 'bye' });
    expect(await b).toMatchObject({ behavior: 'deny' });
    expect(events.filter((e) => e.type === 'permission.replied' || e.type === 'question.rejected')).toHaveLength(2);
  });
});

describe('PermissionBroker questions', () => {
  const input = { questions: [{ question: 'Q1', header: 'H1', multiSelect: true, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }, { question: 'Q2', header: 'H2', options: [{ label: 'X', description: 'x' }] }] };

  test('asked shape, answers joined with ", ", reply event', async () => {
    const { broker, events, opts } = make();
    const promise = broker.canUseTool('AskUserQuestion', input, opts());
    const asked = events[0]!;
    if (asked.type !== 'question.asked') throw new Error();
    expect(asked.properties.questions.map((q) => [q.question, q.multiple])).toEqual([['Q1', true], ['Q2', false]]);
    expect(broker.questions).toHaveLength(1);
    broker.respondQuestion('req1', [['A', 'B'], ['custom text']]);
    expect(await promise).toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { Q1: 'A, B', Q2: 'custom text' } } });
    expect(events.at(-1)).toMatchObject({ type: 'question.replied', properties: { requestID: 'req1', answers: [['A', 'B'], ['custom text']] } });
  });

  test('malformed answers deny instead of hanging', async () => {
    for (const bad of ['nope', 5, [1, 2], [['ok'], 'x'], null, { other: true }]) {
      const { broker, events, opts } = make();
      const promise = broker.canUseTool('AskUserQuestion', input, opts());
      expect(broker.respondQuestion('req1', bad)).toBe(true);
      expect(await promise).toMatchObject({ behavior: 'deny' });
      expect(broker.size).toBe(0);
      expect(events.at(-1)!.type).toBe('question.rejected');
    }
  });

  test('plan approval still resolves when the mode switch throws', async () => {
    const { broker, opts } = make(() => { throw new Error('boom'); });
    const promise = broker.canUseTool('ExitPlanMode', { plan: 'p' }, opts({ requestId: 'p' }));
    broker.respondPermission('p', 'always');
    expect((await promise).behavior).toBe('allow');
  });

  test('reject denies and emits question.rejected', async () => {
    const { broker, events, opts } = make();
    const promise = broker.canUseTool('AskUserQuestion', input, opts());
    broker.respondQuestion('req1', { reject: true });
    expect(await promise).toMatchObject({ behavior: 'deny' });
    expect(events.at(-1)).toMatchObject({ type: 'question.rejected' });
  });
});

describe('PermissionBroker ExitPlanMode', () => {
  const plan = { plan: '# Plan', planFilePath: '/home/x/.claude/plans/p.md' };

  test('prompt carries the plan; once allows without touching the mode', async () => {
    const modes: string[] = [];
    const { broker, events, opts } = make(async (m) => void modes.push(m));
    const promise = broker.canUseTool('ExitPlanMode', plan, opts({ requestId: 'plan1' }));
    const asked = events[0]!;
    if (asked.type !== 'permission.asked') throw new Error();
    expect(asked.properties).toMatchObject({ permission: 'plan_exit', always: ['Approve & auto-accept edits'], metadata: { plan: '# Plan' } });
    broker.respondPermission('plan1', 'once');
    expect(await promise).toEqual({ behavior: 'allow', updatedInput: plan });
    expect(modes).toEqual([]);
  });

  test('always sets acceptEdits before allowing', async () => {
    const order: string[] = [];
    const { broker, opts } = make(async (m) => void order.push(`mode:${m}`));
    const promise = broker.canUseTool('ExitPlanMode', plan, opts({ requestId: 'p' }));
    broker.respondPermission('p', 'always');
    const result = await promise;
    order.push(result.behavior);
    expect(order).toEqual(['mode:acceptEdits', 'allow']);
  });

  test('reject keeps planning', async () => {
    const { broker, opts } = make();
    const promise = broker.canUseTool('ExitPlanMode', plan, opts({ requestId: 'p' }));
    broker.respondPermission('p', 'reject');
    const result = await promise;
    expect(result.behavior).toBe('deny');
    expect((result as { message: string }).message).toContain('keep planning');
  });
});
