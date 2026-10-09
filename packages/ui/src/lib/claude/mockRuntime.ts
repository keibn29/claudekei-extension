/**
 * In-memory `ClaudeRuntimeAPI` for developing the UI without the extension host.
 *
 * Enabled only by an explicit flag (the webview checks `?mock=claude` or `VITE_CLAUDE_MOCK=1`),
 * never by default. `send` plays a scripted turn as protocol events:
 *   reasoning + streamed text -> `edit` tool (pending -> running -> permission.asked -> completed
 *   with metadata.filediff) -> `todowrite` + todo.updated -> question.asked -> final text.
 *
 * Other scripted turns are picked by a marker in the prompt: `[mock:plan]`, `[mock:bash]`, `[mock:auth]`,
 * `[mock:hook]` and `[mock:subagents]` (3 parallel `Agent` calls with child sessions that stream progress, a
 * hidden ToolSearch row, then `SendMessage` follow-ups: one resumes a subagent, one is not delivered).
 *
 * Main-agent switching follows the host: `setAgent` updates `Session.agent` at once (the pending target), and the
 * next `send` stamps the new agent on its user message, which is when the UI shows the switch divider.
 */

import type { ClaudeRuntimeAPI } from '@/lib/api/types';
import type {
  BootstrapResponse,
  ClaudeEvent,
  ClaudeEventsPush,
  ClaudeRequestMap,
  ClaudeRequestType,
  LiveSessionState,
  SessionSnapshot,
} from './protocol';
import { CLAUDE_EVENTS_PUSH_TYPE } from './protocol';
import {
  ANTHROPIC_PROVIDER_ID,
  type AssistantMessage,
  type Catalog,
  type ContextUsage,
  type EffortLevel,
  type Message,
  type Part,
  type PermissionMode,
  type PermissionRequest,
  type PermissionResponse,
  type QuestionAnswer,
  type QuestionRequest,
  type Session,
  type SessionStatus,
  type SubagentProgress,
  type SubagentToolMetadata,
  type Todo,
  type ToolPart,
  type UsageLimits,
  type UserMessage,
} from './types';

const MOCK_CWD = '/mock/workspace';
const EDIT_FILE = `${MOCK_CWD}/src/greeting.ts`;
const STREAM_STEP_MS = 35;

const MOCK_CATALOG: Catalog = {
  models: [
    { value: 'default', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5)', contextWindow: 1_000_000, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'opus', displayName: 'Opus', description: 'Mock most capable model', resolvedModel: 'claude-opus-5-5', contextWindow: 1_000_000, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'sonnet', displayName: 'Sonnet', description: 'Mock balanced model', resolvedModel: 'claude-sonnet-4-5-20250929', contextWindow: 500_000, supportedEffortLevels: ['low', 'medium', 'high'] },
    { value: 'haiku', displayName: 'Haiku', description: 'Mock fastest model', resolvedModel: 'claude-haiku-4-5', contextWindow: 200_000, supportsEffort: false },
  ],
  commands: [
    { name: 'compact', description: 'Compact the conversation', argumentHint: '', builtin: true },
    { name: 'review', description: 'Review the current changes', argumentHint: '', builtin: true },
  ],
  agents: [
    { name: 'claudekei:orchestrator', description: 'Coordinates work across agents (claudekei primary agent)' },
    { name: 'claudekei:planner', description: 'Plans before building (claudekei primary agent)' },
    { name: 'claudekei:sprinter', description: 'Fast focused implementation (claudekei primary agent)' },
    { name: 'claudekei:business-analyst', description: 'Requirements and research (claudekei primary agent)' },
    { name: 'Explore', description: 'Fast read-only codebase exploration' },
    { name: 'claudekei:explorer', description: 'Read-only codebase exploration', model: 'haiku' },
    { name: 'claudekei:librarian', description: 'Documentation and library research' },
    { name: 'claudekei:debugger', description: 'Root-cause analysis for failing code' },
  ],
  primaryAgents: [
    { name: 'claudekei:orchestrator', displayName: 'Orchestrator', color: 'purple', description: 'Coordinates work across agents', defaultModel: 'opus', defaultEffort: 'high' },
    { name: 'claudekei:planner', displayName: 'Planner', color: 'blue', description: 'Plans before building', defaultModel: 'opus', defaultEffort: 'max' },
    { name: 'claudekei:sprinter', displayName: 'Sprinter', color: 'green', description: 'Fast focused implementation', defaultModel: 'sonnet', defaultEffort: 'low' },
    { name: 'claudekei:business-analyst', displayName: 'Business Analyst', color: 'orange', description: 'Requirements and research', defaultModel: 'sonnet' },
  ],
  // The host defaults new sessions to bypassPermissions (user decision).
  defaults: { model: 'default', mode: 'bypassPermissions', agent: 'claudekei:orchestrator' },
};

type Pending<T> = { resolve: (value: T) => void };

type MockSession = {
  session: Session;
  messages: Message[];
  parts: Record<string, Part[]>;
  status: SessionStatus;
  todos: Todo[];
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  abort: AbortController | null;
  model: string;
  mode: PermissionMode;
  agent: string;
  effort?: EffortLevel;
  /** Concrete model id, known once the session has been spawned (first send). */
  resolvedModel?: string;
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

const uuid = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Concrete model id for a catalog value (`default` resolves like the real host: the currently recommended model). */
const resolveMockModel = (value: string): string => {
  const entry = MOCK_CATALOG.models.find((model) => model.value === value);
  if (entry?.resolvedModel) return entry.resolvedModel;
  return 'claude-opus-5-5';
};

const primaryAgentDefaults = (agent: string): { model: string; effort?: EffortLevel } => {
  const info = MOCK_CATALOG.primaryAgents.find((candidate) => candidate.name === agent);
  const model = MOCK_CATALOG.models.find((candidate) => candidate.value === info?.defaultModel)?.value ?? MOCK_CATALOG.defaults.model;
  return { model, effort: info?.defaultEffort ?? MOCK_CATALOG.defaults.effort };
};

/** Context breakdown shaped like the host's `getContextUsage` (1M window; messages grow with the transcript). */
const buildMockContextUsage = (messageCount: number, model: string): ContextUsage => {
  const maxTokens = 1_000_000;
  const messages = 800 + messageCount * 640;
  const base: Array<[string, string, number]> = [
    ['system-prompt', 'System prompt', 4_200],
    ['system-tools', 'System tools', 9_800],
    ['mcp-tools', 'MCP tools', 1_200],
    ['memory-files', 'Memory files', 2_100],
    ['custom-agents', 'Custom agents', 900],
    ['skills', 'Skills', 1_400],
    ['messages', 'Messages', messages],
  ];
  const categories: ContextUsage['categories'] = base.map(([id, label, tokens]) => ({ id, label, tokens, kind: 'used' as const }));
  const usedTokens = base.reduce((sum, [, , tokens]) => sum + tokens, 0);
  const buffer = 33_000;
  categories.push({ id: 'autocompact-buffer', label: 'Autocompact buffer', tokens: buffer, kind: 'buffer' });
  categories.push({ id: 'free-space', label: 'Free space', tokens: maxTokens - usedTokens - buffer, kind: 'free' });
  categories.push({ id: 'mcp-tools-deferred', label: 'MCP tools (deferred)', tokens: 14_000, kind: 'deferred' });
  return {
    usedTokens,
    maxTokens,
    percent: Math.round((usedTokens / maxTokens) * 1000) / 10,
    autocompactBufferTokens: buffer,
    autocompactThresholdTokens: maxTokens - buffer,
    autocompactEnabled: true,
    model: resolveMockModel(model),
    categories,
    sections: [
      { id: 'memory-files', label: 'Memory files', items: [{ name: 'CLAUDE.md', tokens: 1_400, detail: 'Project' }, { name: '~/.claude/CLAUDE.md', tokens: 700, detail: 'User' }] },
      { id: 'system-tools', label: 'System tools', items: [{ name: 'Bash', tokens: 1_900 }, { name: 'Edit', tokens: 1_100 }, { name: 'Read', tokens: 900 }, { name: 'Agent', tokens: 850 }] },
      { id: 'mcp-tools', label: 'MCP tools', items: [{ name: 'mcp__github__create_issue', tokens: 620 }, { name: 'mcp__github__list_prs', tokens: 580 }] },
      { id: 'custom-agents', label: 'Custom agents', items: [{ name: 'claudekei:explorer', tokens: 310, detail: 'Plugin' }, { name: 'claudekei:debugger', tokens: 290, detail: 'Plugin' }, { name: 'claudekei:librarian', tokens: 300, detail: 'Plugin' }] },
      { id: 'skills', label: 'Skills', items: [{ name: 'karpathy-guidelines', tokens: 700, detail: 'Plugin' }, { name: 'simplify', tokens: 700, detail: 'Plugin' }] },
      { id: 'messages', label: 'Messages', items: [{ name: 'User messages', tokens: Math.round(messages * 0.3) }, { name: 'Assistant messages', tokens: Math.round(messages * 0.45) }, { name: 'Tool results', tokens: Math.round(messages * 0.25) }] },
    ],
    updatedAt: Date.now(),
    source: 'exact',
  };
};

const buildMockUsageLimits = (): UsageLimits => {
  const now = Date.now();
  return {
    plan: 'Team',
    windows: [
      { id: 'session', kind: 'session', label: 'Session limit', utilization: 0.37, resetsAt: now + (2 * 60 + 12) * 60_000, severity: 'normal', active: true },
      { id: 'weekly', kind: 'weekly_all', label: 'Weekly · All models', utilization: 0.81, resetsAt: now + 3 * 24 * 3_600_000, severity: 'warning' },
      { id: 'weekly:fable', kind: 'weekly_scoped', label: 'Weekly · Fable', utilization: 0, resetsAt: now + 3 * 24 * 3_600_000, severity: 'normal' },
    ],
    updatedAt: now,
    source: 'usage',
  };
};

export function createMockClaudeRuntime(): ClaudeRuntimeAPI {
  const sessions = new Map<string, MockSession>();
  const listeners = new Set<(push: ClaudeEventsPush) => void>();
  let usageLimits: UsageLimits = buildMockUsageLimits();
  const permissionWaiters = new Map<string, Pending<PermissionResponse>>();
  const questionWaiters = new Map<string, Pending<QuestionAnswer[] | null>>();
  let seq = 0;
  let idCounter = 0;

  // Host-style ascending ids: <ms timestamp><4-digit sequence>.
  const nextId = (prefix: string): string => `${prefix}_${Date.now()}${String(idCounter++ % 10000).padStart(4, '0')}`;

  const emit = (events: ClaudeEvent[]) => {
    if (events.length === 0) return;
    const push: ClaudeEventsPush = { type: CLAUDE_EVENTS_PUSH_TYPE, seq: ++seq, events };
    setTimeout(() => {
      for (const listener of listeners) listener(push);
    }, 0);
  };

  const createSession = (title = 'New session'): MockSession => {
    const now = Date.now();
    const id = uuid();
    const defaults = primaryAgentDefaults(MOCK_CATALOG.defaults.agent);
    const entry: MockSession = {
      session: {
        id,
        title,
        directory: MOCK_CWD,
        time: { created: now, updated: now },
        agent: MOCK_CATALOG.defaults.agent,
        mode: MOCK_CATALOG.defaults.mode,
        model: defaults.model,
        effort: defaults.effort,
      },
      messages: [],
      parts: {},
      status: { type: 'idle' },
      todos: [],
      permissions: [],
      questions: [],
      abort: null,
      model: defaults.model,
      mode: MOCK_CATALOG.defaults.mode,
      agent: MOCK_CATALOG.defaults.agent,
      effort: defaults.effort,
    };
    sessions.set(id, entry);
    return entry;
  };

  const requireSession = (sessionId: string): MockSession => {
    const entry = sessions.get(sessionId);
    if (!entry) throw new Error(`Unknown session ${sessionId}`);
    return entry;
  };

  const setStatus = (entry: MockSession, status: SessionStatus) => {
    entry.status = status;
    entry.session = { ...entry.session, time: { ...entry.session.time, updated: Date.now() } };
    emit([
      { type: 'session.status', properties: { sessionID: entry.session.id, status } },
      { type: 'session.updated', properties: { sessionID: entry.session.id, info: entry.session } },
    ]);
  };

  /** Update host-owned session fields (mode / agent / model / effort) and push `session.updated`, like the real host. */
  const setSessionFields = (
    entry: MockSession,
    fields: { mode?: PermissionMode; agent?: string; model?: string; effort?: EffortLevel | null; resolvedModel?: string },
  ) => {
    if (fields.mode) entry.mode = fields.mode;
    if (fields.agent) entry.agent = fields.agent;
    if (fields.model) entry.model = fields.model;
    if (fields.effort !== undefined) entry.effort = fields.effort ?? undefined;
    if (fields.resolvedModel) entry.resolvedModel = fields.resolvedModel;
    entry.session = {
      ...entry.session,
      mode: entry.mode,
      agent: entry.agent,
      model: entry.model,
      effort: entry.effort,
      resolvedModel: entry.resolvedModel,
      time: { ...entry.session.time, updated: Date.now() },
    };
    emit([{ type: 'session.updated', properties: { sessionID: entry.session.id, info: entry.session } }]);
  };

  const upsertPart = (entry: MockSession, part: Part) => {
    const messageId = (part as { messageID: string }).messageID;
    const list = entry.parts[messageId] ?? (entry.parts[messageId] = []);
    const index = list.findIndex((candidate) => candidate.id === part.id);
    // Keep a private copy: the emitted object ends up in the UI store and must not be mutated here.
    if (index >= 0) list[index] = { ...part };
    else list.push({ ...part });
    emit([{ type: 'message.part.updated', properties: { part } }]);
  };

  /** Stream `text` into a text/reasoning part word by word. */
  const streamText = async (
    entry: MockSession,
    part: Extract<Part, { type: 'text' | 'reasoning' }>,
    text: string,
    signal: AbortSignal,
  ) => {
    upsertPart(entry, { ...part, text: '' });
    let current = '';
    for (const word of text.split(/(?<=\s)/)) {
      await sleep(STREAM_STEP_MS, signal);
      current += word;
      const parts = entry.parts[part.messageID];
      const stored = parts.find((candidate) => candidate.id === part.id) as typeof part;
      stored.text = current;
      emit([
        {
          type: 'message.part.delta',
          properties: { sessionID: entry.session.id, messageID: part.messageID, partID: part.id, field: 'text', delta: word },
        },
      ]);
    }
    const end = Date.now();
    upsertPart(entry, { ...part, text: current, time: part.type === 'text' ? { start: part.time?.start ?? end, end } : { start: part.time.start, end } });
  };

  const askPermission = (entry: MockSession, request: PermissionRequest, signal: AbortSignal): Promise<PermissionResponse> =>
    // bypassPermissions skips tool prompts (plan approval is not a tool permission and is still asked).
    entry.mode === 'bypassPermissions' && request.permission !== 'plan_exit'
      ? Promise.resolve('once')
      : new Promise((resolve, reject) => {
      entry.permissions.push(request);
      emit([{ type: 'permission.asked', properties: request }]);
      permissionWaiters.set(request.id, { resolve });
      signal.addEventListener('abort', () => {
        permissionWaiters.delete(request.id);
        entry.permissions = entry.permissions.filter((candidate) => candidate.id !== request.id);
        emit([{ type: 'permission.replied', properties: { sessionID: entry.session.id, requestID: request.id, reply: 'reject' } }]);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });

  const askQuestion = (entry: MockSession, request: QuestionRequest, signal: AbortSignal): Promise<QuestionAnswer[] | null> =>
    new Promise((resolve, reject) => {
      entry.questions.push(request);
      emit([{ type: 'question.asked', properties: request }]);
      questionWaiters.set(request.id, { resolve });
      signal.addEventListener('abort', () => {
        questionWaiters.delete(request.id);
        entry.questions = entry.questions.filter((candidate) => candidate.id !== request.id);
        emit([{ type: 'question.rejected', properties: { sessionID: entry.session.id, requestID: request.id } }]);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });

  const newAssistant = (entry: MockSession, userMessage: UserMessage): AssistantMessage => {
    const assistant: AssistantMessage = {
      id: nextId('message'),
      sessionID: entry.session.id,
      role: 'assistant',
      parentID: userMessage.id,
      time: { created: Date.now() },
      // The API reports the concrete model id, not the catalog alias.
      modelID: entry.resolvedModel ?? resolveMockModel(entry.model),
      providerID: ANTHROPIC_PROVIDER_ID,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    };
    entry.messages.push(assistant);
    emit([{ type: 'message.updated', properties: { sessionID: entry.session.id, info: assistant } }]);
    return assistant;
  };

  const finishAssistant = (entry: MockSession, assistant: AssistantMessage) => {
    const completed: AssistantMessage = {
      ...assistant,
      finish: 'end_turn',
      time: { created: assistant.time.created, completed: Date.now() },
      tokens: { input: 800, output: 120, reasoning: 0, cache: { read: 600, write: 0 } },
      cost: 0.004,
    };
    entry.messages[entry.messages.indexOf(assistant)] = completed;
    emit([{ type: 'message.updated', properties: { sessionID: entry.session.id, info: completed } }]);
  };

  const textPartFor = (entry: MockSession, assistant: AssistantMessage): Extract<Part, { type: 'text' }> => ({
    id: nextId('part'),
    sessionID: entry.session.id,
    messageID: assistant.id,
    type: 'text',
    text: '',
    time: { start: Date.now() },
  });

  /** `[mock:plan]`: plan mode turn ending in an ExitPlanMode (`plan_exit`) approval card. */
  const playPlanTurn = async (entry: MockSession, userMessage: UserMessage, signal: AbortSignal) => {
    const sessionID = entry.session.id;
    setSessionFields(entry, { mode: 'plan' });
    const assistant = newAssistant(entry, userMessage);
    await streamText(entry, textPartFor(entry, assistant), 'I explored the code and wrote a plan.\n\n', signal);

    const plan = '## Plan\n\n1. Add a `name` parameter to `greet`\n2. Update the callers\n3. Add a unit test\n\n**Risk:** low';
    const partId = nextId('part');
    const input = { plan };
    const base = { id: partId, sessionID, messageID: assistant.id, type: 'tool' as const, tool: 'plan_exit', callID: `toolu_${partId}`, claude: { name: 'ExitPlanMode', input } };
    const start = Date.now();
    upsertPart(entry, { ...base, state: { status: 'running', input, time: { start } } } satisfies ToolPart);

    const decision = await askPermission(
      entry,
      {
        id: nextId('perm'),
        sessionID,
        permission: 'plan_exit',
        patterns: [],
        metadata: { plan },
        always: ['Auto-accept edits'],
        tool: { messageID: assistant.id, callID: base.callID },
      },
      signal,
    );

    if (decision === 'reject') {
      upsertPart(entry, { ...base, state: { status: 'error', input, error: 'Keep planning', time: { start, end: Date.now() } } } satisfies ToolPart);
      await streamText(entry, textPartFor(entry, assistant), 'Understood, I will keep planning.', signal);
    } else {
      // "always" = approve + auto-accept edits, "once" = approve with default permissions.
      setSessionFields(entry, { mode: decision === 'always' ? 'acceptEdits' : 'default' });
      upsertPart(entry, {
        ...base,
        state: { status: 'completed', input, output: 'Plan approved', title: 'Plan approved', metadata: {}, time: { start, end: Date.now() } },
      } satisfies ToolPart);
      await streamText(entry, textPartFor(entry, assistant), 'Plan approved. Starting implementation.', signal);
    }
    finishAssistant(entry, assistant);
  };

  /** `[mock:bash]`: a Bash permission without "always" suggestions. */
  const playBashTurn = async (entry: MockSession, userMessage: UserMessage, signal: AbortSignal) => {
    const sessionID = entry.session.id;
    const assistant = newAssistant(entry, userMessage);
    const partId = nextId('part');
    const input = { command: 'git status --short', description: 'Show working tree status' };
    const base = { id: partId, sessionID, messageID: assistant.id, type: 'tool' as const, tool: 'bash', callID: `toolu_${partId}`, claude: { name: 'Bash', input: { command: input.command } } };
    const start = Date.now();
    upsertPart(entry, { ...base, state: { status: 'running', input, time: { start } } } satisfies ToolPart);
    const decision = await askPermission(
      entry,
      {
        id: nextId('perm'),
        sessionID,
        permission: 'bash',
        patterns: [input.command],
        metadata: { input, command: input.command, description: input.description },
        always: [],
        tool: { messageID: assistant.id, callID: base.callID },
      },
      signal,
    );
    upsertPart(entry, decision === 'reject'
      ? { ...base, state: { status: 'error', input, error: 'User rejected', time: { start, end: Date.now() } } } satisfies ToolPart
      : { ...base, state: { status: 'completed', input, output: ' M src/greeting.ts', title: input.command, metadata: {}, time: { start, end: Date.now() } } } satisfies ToolPart);
    finishAssistant(entry, assistant);
  };

  /** `[mock:code]`: markdown with shell and non-shell fenced blocks (the Run button shows on the shell ones). */
  const playCodeTurn = async (entry: MockSession, userMessage: UserMessage, signal: AbortSignal) => {
    const assistant = newAssistant(entry, userMessage);
    const text = 'Run the tests, then check the types:\n\n```bash\n$ bun test packages/ui/src\n```\n\nA multi-line script:\n\n```sh\ncd packages/ui\nbun run type-check\n```\n\nAnd some TypeScript (no Run button):\n\n```ts\nexport const answer = 42;\n```\n\nUntagged blocks never get a Run button:\n\n```\nnpm test\n```\n';
    await streamText(entry, textPartFor(entry, assistant), text, signal);
    finishAssistant(entry, assistant);
  };

  /** `[mock:auth]`: the host reports that Claude is not signed in. */
  const playAuthError = async (entry: MockSession) => {
    emit([
      {
        type: 'session.error',
        properties: { sessionID: entry.session.id, error: { name: 'AuthenticationError', message: 'Invalid API key. Please run /login', kind: 'auth' } },
      },
    ]);
  };

  /** `[mock:hook]`: a UserPromptSubmit hook blocked the prompt (info notice, not an error). */
  const playHookBlock = async (entry: MockSession) => {
    emit([
      {
        type: 'session.error',
        properties: { sessionID: entry.session.id, error: { name: 'HookBlocked', message: 'Blocked by hook: use /claudekei:agent to switch agents.', kind: 'hook' } },
      },
    ]);
  };

  // ---------------------------------------------------------------------------
  // [mock:subagents]
  // ---------------------------------------------------------------------------

  type SubagentStepSpec = { tool: string; claudeName: string; input: Record<string, unknown>; title: string; tokens: number };
  type SubagentSpec = {
    alias: string;
    type: string;
    description: string;
    prompt: string;
    steps: SubagentStepSpec[];
    reply: string;
    /** Finishes with an assistant error (runStatus `error`). */
    fails?: boolean;
    /** Async launch: the Agent tool part completes immediately while the child keeps working. */
    async: boolean;
    stepMs: number;
  };

  const SUBAGENT_SPECS: SubagentSpec[] = [
    {
      alias: 'exp-1',
      type: 'claudekei:explorer',
      description: 'Map SendMessage usage',
      prompt: 'Find every call site of `SendMessage` in packages/ui and report `file:line` for each.\n\nInclude:\n- the component that renders it\n- how the tool name is normalized\n- anything that still shows the raw "Sendmessage" label\n\nKeep the report short; no code changes.',
      steps: [
        { tool: 'grep', claudeName: 'Grep', input: { pattern: 'SendMessage', path: 'packages/ui/src' }, title: 'SendMessage', tokens: 2100 },
        { tool: 'read', claudeName: 'Read', input: { filePath: `${MOCK_CWD}/packages/ui/src/lib/claude/toolNames.ts` }, title: 'packages/ui/src/lib/claude/toolNames.ts', tokens: 3900 },
        { tool: 'read', claudeName: 'Read', input: { filePath: `${MOCK_CWD}/packages/ui/src/components/chat/message/parts/ToolPart.tsx` }, title: 'packages/ui/src/components/chat/message/parts/ToolPart.tsx', tokens: 7800 },
        { tool: 'grep', claudeName: 'Grep', input: { pattern: 'sendmessage', path: 'packages/ui/src' }, title: 'sendmessage', tokens: 9400 },
      ],
      reply: 'Found **4 call sites**:\n\n- `packages/ui/src/lib/claude/toolNames.ts:24` maps `SendMessage` to `sendmessage`\n- `packages/ui/src/components/chat/message/parts/toolRenderUtils.ts:5` registers it as expandable\n- `packages/ui/src/components/chat/message/parts/ToolPart.tsx:1750` routes it to the subagent card\n- `packages/ui/src/lib/toolHelpers.ts:115` display metadata',
      async: false,
      stepMs: 650,
    },
    {
      alias: 'lib-1',
      type: 'claudekei:librarian',
      description: 'Check task_progress fields in the Agent SDK docs',
      prompt: 'Look up what `task_progress` carries in the Claude Agent SDK (token usage, tool uses, last tool name) and whether it fires once per second.',
      steps: [
        { tool: 'websearch', claudeName: 'WebSearch', input: { query: 'claude agent sdk task_progress message' }, title: 'claude agent sdk task_progress message', tokens: 1800 },
        { tool: 'webfetch', claudeName: 'WebFetch', input: { url: 'https://docs.claude.com/en/api/agent-sdk/typescript' }, title: 'https://docs.claude.com/en/api/agent-sdk/typescript', tokens: 6200 },
        { tool: 'webfetch', claudeName: 'WebFetch', input: { url: 'https://docs.claude.com/en/api/agent-sdk/subagents' }, title: 'https://docs.claude.com/en/api/agent-sdk/subagents', tokens: 11800 },
      ],
      reply: '`task_progress` includes `total_tokens`, `tool_uses`, `duration_ms` and `last_tool_name`. It is emitted roughly once per second while a subagent run is active.',
      async: true,
      stepMs: 900,
    },
    {
      alias: 'dbg-1',
      type: 'claudekei:debugger',
      description: 'Reproduce the flaky reducer test',
      prompt: 'Run `bun test packages/ui/src/sync` ten times and find out why `event-reducer` is flaky.',
      steps: [
        { tool: 'bash', claudeName: 'Bash', input: { command: 'bun test packages/ui/src/sync', description: 'Run the sync tests' }, title: 'bun test packages/ui/src/sync', tokens: 2400 },
        { tool: 'read', claudeName: 'Read', input: { filePath: `${MOCK_CWD}/packages/ui/src/sync/event-reducer.ts` }, title: 'packages/ui/src/sync/event-reducer.ts', tokens: 5200 },
      ],
      reply: 'Test run exited with code 1: the sandbox blocks writes to `/tmp`, so the persisted-cache test cannot run here.',
      fails: true,
      async: true,
      stepMs: 1500,
    },
  ];

  const updateSession = (entry: MockSession, patch: (session: Session) => Session) => {
    entry.session = patch({ ...entry.session, time: { ...entry.session.time, updated: Date.now() } });
    emit([{ type: 'session.updated', properties: { sessionID: entry.session.id, info: entry.session } }]);
  };

  const setProgress = (entry: MockSession, progress: SubagentProgress | undefined) => {
    updateSession(entry, (session) => ({ ...session, claude: { ...session.claude, progress } }));
  };

  /** Virtual child session `sub_<Agent tool_use_id>`, like the host creates on `task_started`. */
  const createChildSession = (parent: MockSession, callID: string, spec: SubagentSpec, agentId: string): MockSession => {
    const now = Date.now();
    const id = `sub_${callID}`;
    const child: MockSession = {
      session: {
        id,
        title: spec.description,
        directory: MOCK_CWD,
        parentID: parent.session.id,
        time: { created: now, updated: now },
        claude: { agentId, agentType: spec.type, alias: spec.alias },
      },
      messages: [],
      parts: {},
      status: { type: 'idle' },
      todos: [],
      permissions: [],
      questions: [],
      abort: null,
      model: parent.model,
      mode: parent.mode,
      agent: spec.type,
    };
    sessions.set(id, child);
    emit([{ type: 'session.created', properties: { sessionID: id, info: child.session } }]);
    return child;
  };

  /** Instruction user message in a child session (initial `Agent` prompt or a `SendMessage` follow-up). */
  const addInstruction = (
    parent: MockSession,
    child: MockSession,
    params: { kind: 'initial' | 'followup'; index: number; text: string; toolCallID: string; fromMessageID: string },
  ): UserMessage => {
    const id = nextId('message');
    const user: UserMessage = {
      id,
      sessionID: child.session.id,
      role: 'user',
      time: { created: Date.now() },
      agent: child.agent,
      model: { providerID: ANTHROPIC_PROVIDER_ID, modelID: child.model },
      instruction: {
        kind: params.kind,
        index: params.index,
        fromSessionID: parent.session.id,
        fromMessageID: params.fromMessageID,
        toolCallID: params.toolCallID,
        fromAgent: parent.agent,
      },
    };
    const textPart: Part = { id: nextId('part'), sessionID: child.session.id, messageID: id, type: 'text', text: params.text };
    child.messages.push(user);
    child.parts[id] = [textPart];
    emit([
      { type: 'message.updated', properties: { sessionID: child.session.id, info: user } },
      { type: 'message.part.updated', properties: { part: textPart } },
    ]);
    return user;
  };

  /** One child run: tool steps with `task_progress`-style updates, then the reply (or an error). */
  const runChildInstruction = async (
    child: MockSession,
    instruction: UserMessage,
    spec: SubagentSpec,
    steps: SubagentStepSpec[],
    reply: string,
    fails: boolean,
    signal: AbortSignal,
  ) => {
    const started = Date.now();
    const sessionID = child.session.id;
    setStatus(child, { type: 'busy' });
    const assistant = newAssistant(child, instruction);
    let toolUses = 0;
    let tokens = 0;
    for (const step of steps) {
      const partId = nextId('part');
      const base = { id: partId, sessionID, messageID: assistant.id, type: 'tool' as const, tool: step.tool, callID: `toolu_${partId}`, claude: { name: step.claudeName, input: step.input } };
      const start = Date.now();
      upsertPart(child, { ...base, state: { status: 'running', input: step.input, title: step.title, time: { start } } } satisfies ToolPart);
      setProgress(child, { toolUses, totalTokens: tokens, durationMs: start - started, lastToolName: step.claudeName, description: step.title });
      await sleep(spec.stepMs, signal);
      toolUses += 1;
      tokens = step.tokens;
      upsertPart(child, { ...base, state: { status: 'completed', input: step.input, output: 'ok', title: step.title, metadata: {}, time: { start, end: Date.now() } } } satisfies ToolPart);
      setProgress(child, { toolUses, totalTokens: tokens, durationMs: Date.now() - started, lastToolName: step.claudeName, description: step.title });
    }
    if (fails) {
      const failed: AssistantMessage = {
        ...assistant,
        finish: 'error',
        error: { name: 'SubagentError', message: reply, data: { message: reply } },
        time: { created: assistant.time.created, completed: Date.now() },
      };
      child.messages[child.messages.indexOf(assistant)] = failed;
      emit([{ type: 'message.updated', properties: { sessionID, info: failed } }]);
    } else {
      await streamText(child, textPartFor(child, assistant), reply, signal);
      finishAssistant(child, assistant);
    }
    updateSession(child, (session) => ({ ...session, claude: { ...session.claude, progress: undefined } }));
    setStatus(child, { type: 'idle' });
    return { toolUses, tokens, durationMs: Date.now() - started };
  };

  const playSubagentsTurn = async (entry: MockSession, userMessage: UserMessage, signal: AbortSignal) => {
    const sessionID = entry.session.id;
    const first = newAssistant(entry, userMessage);
    await streamText(entry, textPartFor(entry, first), "I'll fan this out to three subagents in parallel.\n\n", signal);

    // 1. Three Agent calls at once.
    type Launched = { spec: SubagentSpec; part: ToolPart; child: MockSession; agentId: string; instruction: UserMessage; callID: string };
    const launched: Launched[] = [];
    for (const spec of SUBAGENT_SPECS) {
      const partId = nextId('part');
      const callID = `toolu_${partId}`;
      const agentId = `a${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 10)}`;
      const input = { description: spec.description, prompt: spec.prompt, subagent_type: spec.type, name: spec.alias };
      const base = { id: partId, sessionID, messageID: first.id, type: 'tool' as const, tool: 'task', callID, claude: { name: 'Agent', input } };
      upsertPart(entry, { ...base, state: { status: 'pending', input: {}, raw: '' } } satisfies ToolPart);
      await sleep(STREAM_STEP_MS * 3, signal);
      const child = createChildSession(entry, callID, spec, agentId);
      const instruction = addInstruction(entry, child, { kind: 'initial', index: 1, text: spec.prompt, toolCallID: callID, fromMessageID: first.id });
      const metadata: SubagentToolMetadata = {
        sessionID: child.session.id,
        agentId,
        agentType: spec.type,
        recipient: spec.alias,
        message: spec.prompt,
        childMessageID: instruction.id,
        runStatus: 'running',
      };
      const start = Date.now();
      const part: ToolPart = spec.async
        ? { ...base, state: { status: 'completed', input, output: `Async agent launched successfully.\nagentId: ${agentId} (use SendMessage with to: '${agentId}' to continue this agent)`, title: spec.description, metadata, time: { start, end: start + 90 } } }
        : { ...base, state: { status: 'running', input, title: spec.description, metadata, time: { start } } };
      upsertPart(entry, part);
      launched.push({ spec, part, child, agentId, instruction, callID });
    }

    // 2. Children work concurrently; each updates its parent part when its run ends.
    await Promise.all(launched.map(async (item) => {
      const { spec, child, instruction } = item;
      await runChildInstruction(child, instruction, spec, spec.steps, spec.reply, Boolean(spec.fails), signal);
      const previous = item.part.state as { input: Record<string, unknown>; metadata?: Record<string, unknown>; time: { start: number; end?: number } };
      const metadata: SubagentToolMetadata & Record<string, unknown> = {
        ...previous.metadata,
        runStatus: spec.fails ? 'error' : 'completed',
        reply: spec.reply,
      };
      item.part = spec.async
        ? { ...item.part, state: { ...(item.part.state as ToolPart['state'] & { status: 'completed' }), metadata } as ToolPart['state'] }
        : { ...item.part, state: { status: 'completed', input: previous.input, output: `${spec.reply}\n\nagentId: ${item.agentId} (use SendMessage with to: '${item.agentId}' to continue this agent)`, title: spec.description, metadata, time: { start: previous.time.start, end: Date.now() } } };
      upsertPart(entry, item.part);
    }));
    finishAssistant(entry, first);

    // 3. Follow-ups: a hidden ToolSearch row, a SendMessage that resumes exp-1, and one that is not delivered.
    const second = newAssistant(entry, userMessage);
    await streamText(entry, textPartFor(entry, second), 'Explorer found the call sites. I will ask it to check the schema too.\n\n', signal);

    const searchId = nextId('part');
    const searchInput = { query: 'select:SendMessage', max_results: 1 };
    const searchStart = Date.now();
    upsertPart(entry, {
      id: searchId, sessionID, messageID: second.id, type: 'tool', tool: 'ToolSearch', callID: `toolu_${searchId}`,
      claude: { name: 'ToolSearch', input: searchInput },
      state: { status: 'completed', input: searchInput, output: 'SendMessage', title: '', metadata: { hidden: true }, time: { start: searchStart, end: searchStart + 40 } },
    } satisfies ToolPart);

    const exp = launched[0];
    const message = 'Also check the new schema in `src/db` and report any type that changed.\n\nReply with a short list.';
    const sendId = nextId('part');
    const sendCall = `toolu_${sendId}`;
    const sendInput = { to: exp.spec.alias, recipient: exp.spec.alias, message, summary: 'Check the src/db schema' };
    const sendBase = { id: sendId, sessionID, messageID: second.id, type: 'tool' as const, tool: 'sendmessage', callID: sendCall, claude: { name: 'SendMessage', input: sendInput } };
    const followUp = addInstruction(entry, exp.child, { kind: 'followup', index: 2, text: message, toolCallID: sendCall, fromMessageID: second.id });
    const sendMetadata: SubagentToolMetadata = {
      sessionID: exp.child.session.id,
      agentId: exp.agentId,
      agentType: exp.spec.type,
      recipient: exp.spec.alias,
      message,
      childMessageID: followUp.id,
      runStatus: 'running',
    };
    const sendStart = Date.now();
    // Async resume: the tool result is already "completed" while the subagent still works.
    const sendPart: ToolPart = { ...sendBase, state: { status: 'completed', input: sendInput, output: `{"success":true,"message":"Resuming agent ${exp.agentId.slice(0, 7)}","resumedAgentId":"${exp.agentId}"}`, title: '', metadata: sendMetadata, time: { start: sendStart, end: sendStart + 120 } } };

    const bogusId = nextId('part');
    const bogusInput = { to: 'zzz-9', recipient: 'zzz-9', message: 'Are you there?', summary: 'Ping unknown agent' };
    const bogusStart = Date.now();
    const bogusPart: ToolPart = {
      id: bogusId, sessionID, messageID: second.id, type: 'tool', tool: 'sendmessage', callID: `toolu_${bogusId}`,
      claude: { name: 'SendMessage', input: bogusInput },
      state: { status: 'error', input: bogusInput, error: 'No agent named "zzz-9" is running. Known aliases: exp-1, lib-1, dbg-1.', metadata: { recipient: 'zzz-9', message: bogusInput.message }, time: { start: bogusStart, end: bogusStart + 60 } },
    };

    upsertPart(entry, sendPart);

    const followSteps: SubagentStepSpec[] = [
      { tool: 'glob', claudeName: 'Glob', input: { pattern: 'src/db/**/*.ts' }, title: 'src/db/**/*.ts', tokens: 11200 },
      { tool: 'read', claudeName: 'Read', input: { filePath: `${MOCK_CWD}/src/db/schema.ts` }, title: 'src/db/schema.ts', tokens: 12900 },
    ];
    const followReply = 'Two types changed in `src/db/schema.ts`:\n\n- `Session.agentId` is now optional\n- `Message.instruction` was added';
    // The resumed run keeps working in the background while the parent moves on (a plain, single SendMessage card).
    const followRun = runChildInstruction(exp.child, followUp, exp.spec, followSteps, followReply, false, signal);
    await sleep(STREAM_STEP_MS * 4, signal);
    finishAssistant(entry, second);

    // Third message: one more SendMessage, to an agent that does not exist (tool error, "Not delivered").
    const third = newAssistant(entry, userMessage);
    await streamText(entry, textPartFor(entry, third), 'And one more ping to an agent that does not exist.\n\n', signal);
    upsertPart(entry, { ...bogusPart, messageID: third.id, sessionID });
    await followRun;
    upsertPart(entry, { ...sendPart, state: { ...(sendPart.state as ToolPart['state'] & { status: 'completed' }), metadata: { ...sendMetadata, runStatus: 'completed', reply: followReply } } as ToolPart['state'] });

    await streamText(
      entry,
      textPartFor(entry, third),
      'Summary: Explorer mapped the call sites and the schema changes, Librarian confirmed the `task_progress` fields, and the Debugger run failed because the sandbox blocks `/tmp` writes.',
      signal,
    );
    finishAssistant(entry, third);
  };

  const playTurn = async (entry: MockSession, userMessage: UserMessage, signal: AbortSignal, prompt: string) => {
    if (prompt.includes('[mock:plan]')) return playPlanTurn(entry, userMessage, signal);
    if (prompt.includes('[mock:bash]')) return playBashTurn(entry, userMessage, signal);
    if (prompt.includes('[mock:code]')) return playCodeTurn(entry, userMessage, signal);
    if (prompt.includes('[mock:auth]')) return playAuthError(entry);
    if (prompt.includes('[mock:hook]')) return playHookBlock(entry);
    if (prompt.includes('[mock:subagents]')) return playSubagentsTurn(entry, userMessage, signal);

    const sessionID = entry.session.id;
    const assistantId = nextId('message');
    const now = Date.now();
    const assistant: AssistantMessage = {
      id: assistantId,
      sessionID,
      role: 'assistant',
      parentID: userMessage.id,
      time: { created: now },
      // The API reports the concrete model id, not the catalog alias.
      modelID: entry.resolvedModel ?? resolveMockModel(entry.model),
      providerID: ANTHROPIC_PROVIDER_ID,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
    };
    entry.messages.push(assistant);
    emit([{ type: 'message.updated', properties: { sessionID, info: assistant } }]);

    // 1. Reasoning
    await streamText(
      entry,
      { id: nextId('part'), sessionID, messageID: assistantId, type: 'reasoning', text: '', time: { start: Date.now() } },
      'The user wants a greeting helper. I will update the greeting function and track the work in a todo list.',
      signal,
    );

    // 2. Intro text
    await streamText(
      entry,
      { id: nextId('part'), sessionID, messageID: assistantId, type: 'text', text: '', time: { start: Date.now() } },
      "I'll update the greeting helper so it accepts an optional name.\n\n",
      signal,
    );

    // 3. Edit tool: pending -> running -> permission -> completed
    const toolPartId = nextId('part');
    const input = { filePath: EDIT_FILE, oldString: 'return "Hello";', newString: 'return `Hello, ${name}`;' };
    const claude = { name: 'Edit', input: { file_path: EDIT_FILE, old_string: input.oldString, new_string: input.newString } };
    const base = { id: toolPartId, sessionID, messageID: assistantId, type: 'tool' as const, tool: 'edit', callID: `toolu_${toolPartId}`, claude };
    upsertPart(entry, { ...base, state: { status: 'pending', input: {}, raw: '' } } satisfies ToolPart);
    await sleep(STREAM_STEP_MS * 4, signal);
    const start = Date.now();
    upsertPart(entry, { ...base, state: { status: 'running', input, time: { start } } } satisfies ToolPart);

    const decision = await askPermission(
      entry,
      {
        id: nextId('perm'),
        sessionID,
        permission: 'edit',
        patterns: ['src/greeting.ts'],
        metadata: { input: claude.input, filepath: EDIT_FILE },
        always: ['Edit files in src/'],
        tool: { messageID: assistantId, callID: base.callID },
      },
      signal,
    );

    if (decision === 'reject') {
      upsertPart(entry, { ...base, state: { status: 'error', input, error: 'User rejected', time: { start, end: Date.now() } } } satisfies ToolPart);
    } else {
      const patch = [
        '--- a/src/greeting.ts',
        '+++ b/src/greeting.ts',
        '@@ -1,3 +1,3 @@',
        '-export function greet() {',
        '-  return "Hello";',
        '+export function greet(name: string) {',
        '+  return `Hello, ${name}`;',
        ' }',
      ].join('\n');
      upsertPart(entry, {
        ...base,
        state: {
          status: 'completed',
          input,
          output: 'The file src/greeting.ts has been updated.',
          title: 'src/greeting.ts',
          metadata: { diff: patch, filediff: { file: EDIT_FILE, additions: 2, deletions: 2, patch } },
          time: { start, end: Date.now() },
        },
      } satisfies ToolPart);
    }

    // 4. Todos
    const todos: Todo[] = [
      { id: 'todo-1', content: 'Update greeting helper', status: 'completed', priority: 'medium', activeForm: 'Updating greeting helper' },
      { id: 'todo-2', content: 'Confirm the output format', status: 'in_progress', priority: 'medium', activeForm: 'Confirming the output format' },
    ];
    entry.todos = todos;
    const todoPartId = nextId('part');
    const todoBase = { id: todoPartId, sessionID, messageID: assistantId, type: 'tool' as const, tool: 'todowrite', callID: `toolu_${todoPartId}`, claude: { name: 'TodoWrite', input: { todos } } };
    const todoStart = Date.now();
    upsertPart(entry, { ...todoBase, state: { status: 'running', input: { todos }, time: { start: todoStart } } } satisfies ToolPart);
    emit([{ type: 'todo.updated', properties: { sessionID, todos } }]);
    await sleep(STREAM_STEP_MS * 3, signal);
    upsertPart(entry, {
      ...todoBase,
      state: { status: 'completed', input: { todos }, output: '', title: '2 todos', metadata: { todos }, time: { start: todoStart, end: Date.now() } },
    } satisfies ToolPart);

    // 5. Question
    const questionAnswer = await askQuestion(
      entry,
      {
        id: nextId('question'),
        sessionID,
        questions: [
          {
            question: 'Which greeting style do you prefer?',
            header: 'Style',
            options: [
              { label: 'Formal', description: 'Hello, Name' },
              { label: 'Casual', description: 'Hey Name!' },
            ],
            multiple: false,
          },
        ],
      },
      signal,
    );

    const choice = questionAnswer?.[0]?.[0];
    await streamText(
      entry,
      { id: nextId('part'), sessionID, messageID: assistantId, type: 'text', text: '', time: { start: Date.now() } },
      choice
        ? `Done. I kept the ${choice.toLowerCase()} style and updated the greeting helper.`
        : 'Done. The greeting helper now takes a name.',
      signal,
    );

    const completed: AssistantMessage = {
      ...assistant,
      finish: 'end_turn',
      time: { created: now, completed: Date.now() },
      tokens: { input: 1200, output: 340, reasoning: 80, cache: { read: 900, write: 0 } },
      cost: 0.0123,
    };
    entry.messages[entry.messages.indexOf(assistant)] = completed;
    emit([{ type: 'message.updated', properties: { sessionID, info: completed } }]);
  };

  const send = async (payload: ClaudeRequestMap['claude:session.send']['payload']): Promise<{ messageId: string }> => {
    const entry = requireSession(payload.sessionId);
    if (payload.model) entry.model = payload.model;
    // The (re)spawn on send is when the concrete model becomes known.
    setSessionFields(entry, {
      mode: payload.mode,
      agent: payload.agent,
      model: payload.model,
      effort: payload.effort,
      resolvedModel: resolveMockModel(payload.model ?? entry.model),
    });

    const text = payload.command ? `/${payload.command.name} ${payload.command.args}`.trim() : payload.text;
    const userId = nextId('message');
    const user: UserMessage = {
      id: userId,
      sessionID: entry.session.id,
      role: 'user',
      time: { created: Date.now() },
      agent: entry.agent,
      // Proposed host contract: the effort the turn runs with travels as `model.variant` (the header shows it).
      model: { providerID: ANTHROPIC_PROVIDER_ID, modelID: entry.model, ...(entry.effort ? { variant: entry.effort } : {}) },
    };
    const textPart: Part = { id: nextId('part'), sessionID: entry.session.id, messageID: userId, type: 'text', text };
    entry.messages.push(user);
    entry.parts[userId] = [textPart];
    if (entry.session.title === 'New session') {
      entry.session = { ...entry.session, title: text.slice(0, 48) || 'New session' };
    }
    emit([
      { type: 'message.updated', properties: { sessionID: entry.session.id, info: user } },
      { type: 'message.part.updated', properties: { part: textPart } },
    ]);

    entry.abort?.abort();
    const controller = new AbortController();
    entry.abort = controller;
    setStatus(entry, { type: 'busy' });
    void playTurn(entry, user, controller.signal, text)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) console.error('[mock-claude] turn failed', error);
      })
      .finally(() => {
        if (entry.abort === controller) {
          entry.abort = null;
          // The host refreshes the context breakdown after each turn and announces it on `session.updated`.
          entry.session = { ...entry.session, contextUsage: buildMockContextUsage(entry.messages.length, entry.model) };
          setStatus(entry, { type: 'idle' });
        }
      });

    return { messageId: userId };
  };

  const snapshotOf = (entry: MockSession): SessionSnapshot =>
    structuredClone({
      session: entry.session,
      messages: entry.messages,
      parts: entry.parts,
      status: entry.status,
      permissions: entry.permissions,
      questions: entry.questions,
      todos: entry.todos,
      children: Array.from(sessions.values(), (candidate) => candidate.session).filter((session) => session.parentID === entry.session.id),
    });

  const handlers: { [K in ClaudeRequestType]: (payload: ClaudeRequestMap[K]['payload']) => Promise<ClaudeRequestMap[K]['response']> | ClaudeRequestMap[K]['response'] } = {
    'claude:bootstrap': (): BootstrapResponse => {
      const live: Record<string, LiveSessionState> = {};
      for (const [id, entry] of sessions) {
        if (entry.status.type !== 'idle' || entry.permissions.length > 0 || entry.questions.length > 0) {
          live[id] = { status: entry.status, permissions: entry.permissions, questions: entry.questions };
        }
      }
      return {
        cwd: MOCK_CWD,
        account: { email: 'mock@example.com', subscriptionType: 'max', apiProvider: 'firstParty' },
        catalog: MOCK_CATALOG,
        usage: usageLimits,
        sessions: Array.from(sessions.values(), (entry) => entry.session),
        live,
        eventSeq: seq,
      };
    },
    'claude:session.list': () => Array.from(sessions.values(), (entry) => entry.session),
    'claude:session.create': (payload) => {
      const entry = createSession(payload.title);
      emit([{ type: 'session.created', properties: { sessionID: entry.session.id, info: entry.session } }]);
      return entry.session;
    },
    'claude:session.load': (payload) => snapshotOf(requireSession(payload.sessionId)),
    'claude:session.send': send,
    'claude:session.interrupt': (payload) => {
      requireSession(payload.sessionId).abort?.abort();
    },
    'claude:session.fork': (payload) => {
      const source = requireSession(payload.sessionId);
      const forked = createSession(`${source.session.title} (fork)`);
      emit([{ type: 'session.created', properties: { sessionID: forked.session.id, info: forked.session } }]);
      return forked.session;
    },
    'claude:session.delete': (payload) => {
      const entry = sessions.get(payload.sessionId);
      entry?.abort?.abort();
      sessions.delete(payload.sessionId);
      if (entry) emit([{ type: 'session.deleted', properties: { sessionID: payload.sessionId, info: entry.session } }]);
    },
    'claude:session.rename': (payload) => {
      const entry = requireSession(payload.sessionId);
      entry.session = { ...entry.session, title: payload.title, time: { ...entry.session.time, updated: Date.now() } };
      emit([{ type: 'session.updated', properties: { sessionID: payload.sessionId, info: entry.session } }]);
    },
    'claude:session.setModel': (payload) => {
      setSessionFields(requireSession(payload.sessionId), { model: payload.model });
    },
    'claude:session.setEffort': (payload) => {
      setSessionFields(requireSession(payload.sessionId), { effort: payload.effort });
    },
    'claude:session.setAgent': (payload) => {
      // Like the host: switching agent applies that agent's default model and effort at once (the process restarts on send).
      const defaults = primaryAgentDefaults(payload.agent);
      setSessionFields(requireSession(payload.sessionId), { agent: payload.agent, model: defaults.model, effort: defaults.effort ?? null });
    },
    'claude:session.setMode': (payload) => {
      setSessionFields(requireSession(payload.sessionId), { mode: payload.mode });
    },
    'claude:permission.respond': (payload) => {
      const entry = requireSession(payload.sessionId);
      entry.permissions = entry.permissions.filter((request) => request.id !== payload.requestId);
      emit([{ type: 'permission.replied', properties: { sessionID: payload.sessionId, requestID: payload.requestId, reply: payload.response } }]);
      permissionWaiters.get(payload.requestId)?.resolve(payload.response);
      permissionWaiters.delete(payload.requestId);
    },
    'claude:question.respond': (payload) => {
      const entry = requireSession(payload.sessionId);
      entry.questions = entry.questions.filter((request) => request.id !== payload.requestId);
      if ('reject' in payload) {
        emit([{ type: 'question.rejected', properties: { sessionID: payload.sessionId, requestID: payload.requestId } }]);
        questionWaiters.get(payload.requestId)?.resolve(null);
      } else {
        emit([{ type: 'question.replied', properties: { sessionID: payload.sessionId, requestID: payload.requestId, answers: payload.answers } }]);
        questionWaiters.get(payload.requestId)?.resolve(payload.answers);
      }
      questionWaiters.delete(payload.requestId);
    },
    'claude:session.contextUsage': (payload) => {
      const entry = requireSession(payload.sessionId);
      return buildMockContextUsage(entry.messages.length, entry.model);
    },
    'claude:usage.refresh': () => {
      usageLimits = buildMockUsageLimits();
      emit([{ type: 'usage.updated', properties: { usage: usageLimits } }]);
      return usageLimits;
    },
    'claude:terminal.run': (payload) => {
      // No terminal in the mock: log what the host would run.
      console.info('[mock-claude] terminal.run', payload.command);
    },
    'claude:catalog.refresh': () => MOCK_CATALOG,
  };

  return {
    request: async (type, payload) => {
      const handler = handlers[type] as (payload: unknown) => unknown;
      return (await handler(payload)) as never;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
