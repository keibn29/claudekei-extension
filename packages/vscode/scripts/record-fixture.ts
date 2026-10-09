#!/usr/bin/env bun
/**
 * W0 spike: records raw SDKMessages from a streaming-input `query()` into an NDJSON fixture.
 *
 * Usage (from packages/vscode):
 *   bun scripts/record-fixture.ts --name text --prompt "Reply with exactly: hi"
 *   bun scripts/record-fixture.ts --name multi-turn --prompt "Say A" --prompt "Say B"
 *   bun scripts/record-fixture.ts --name interrupt --prompt "Run: sleep 30" --interrupt-after-ms 4000
 *   bun scripts/record-fixture.ts --name resume --resume multi-turn --prompt "What did I ask first?"
 *   bun scripts/record-fixture.ts --history multi-turn        # dumps getSessionMessages -> history-multi-turn.json
 *
 * Fixture format: one JSON object per line, in arrival order.
 *   - every raw SDKMessage as emitted by the Query iterator (unmodified)
 *   - synthetic lines prefixed with "_":
 *       {"type":"_options", "options": {...}}      (always the first line: options used for this recording)
 *       {"type":"_input", "message": <SDKUserMessage sent>}
 *       {"type":"_canUseTool", "toolName", "input", "options": {suggestions, ...}, "result": <PermissionResult returned>}
 *       {"type":"_interrupt", "afterMs", "response": <interrupt() resolution>}
 *       {"type":"_error", "message", "stack"}      (iterator threw)
 *
 * Safety: cwd is ALWAYS the throwaway sandbox (re-seeded on every run); never the repo.
 * Auth: local `claude login` subscription; API-key env vars are stripped.
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  getSessionMessages,
  query,
  type CanUseTool,
  type Options,
  type PermissionMode,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  AsyncQueue,
  buildEnv,
  FIXTURES_DIR,
  redactEmails,
  seedSandbox,
  SANDBOX_DIR,
  sessionIdFromFixture,
  STDERR_LOG_DIR,
} from './_common';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    prompt: { type: 'string', multiple: true },
    model: { type: 'string', default: 'haiku' },
    mode: { type: 'string', default: 'default' },
    'interrupt-after-ms': { type: 'string' },
    resume: { type: 'string' },
    'resume-at': { type: 'string' },
    fork: { type: 'boolean', default: false },
    'session-id': { type: 'string' },
    'setting-sources': { type: 'string', default: 'project' },
    thinking: { type: 'string' }, // see below
    'max-turns': { type: 'string' },
    deny: { type: 'string', multiple: true }, // tool names to deny
    'forward-subagent-text': { type: 'boolean', default: false },
    'no-partial': { type: 'boolean', default: false },
    'allow-without-input': { type: 'boolean', default: false },
    always: { type: 'boolean', default: false }, // "always allow": echo the SDK's suggestions back as updatedPermissions
    'exit-plan-mode': { type: 'string' }, // permission mode to switch to when ExitPlanMode is allowed
    tools: { type: 'string' }, // csv of built-in tools, or "preset"
    'allowed-tools': { type: 'string' }, // csv, auto-allowed (and added to the tool set, e.g. Grep,Glob)
    env: { type: 'string', multiple: true }, // KEY=VALUE extras for the CLI process
    history: { type: 'string' },
    timeout: { type: 'string', default: '240000' },
    'keep-sandbox': { type: 'boolean', default: false },
    agent: { type: 'string' }, // Options.agent (main-thread agent)
    'agents-json': { type: 'string' }, // inline Options.agents as JSON, or @path to a JSON file
    'out-dir': { type: 'string' }, // fixtures sub-directory (relative to __fixtures__), default: the root
    'no-snapshot': { type: 'boolean', default: false }, // systemPrompt.snapshot=false (render the system prompt fresh on resume)
    // Writes a project-level UserPromptSubmit command hook into the sandbox that answers {"decision":"block","reason":<value>}.
    'hook-block-reason': { type: 'string' },
    'include-hook-events': { type: 'boolean', default: false },
  },
});

function fail(msg: string): never {
  console.error(`record-fixture: ${msg}`);
  process.exit(2);
}

/** Resolve "<fixtureName>" or a raw uuid to a session id. */
function resolveSessionId(ref: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(ref) ? ref : sessionIdFromFixture(ref);
}

/** Resolve --resume-at keywords against the source fixture's messages. */
function resolveResumeAt(ref: string, sourceFixture: string | undefined): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(ref)) return ref;
  if (!sourceFixture) fail('--resume-at keyword requires --resume <fixtureName>');
  const lines = readFileSync(join(FIXTURES_DIR, `${sourceFixture}.ndjson`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const wanted = ref === 'first-assistant' ? 'assistant' : fail(`unknown --resume-at keyword: ${ref}`);
  const hit = lines.find((m) => m.type === wanted && m.parent_tool_use_id == null);
  if (!hit) fail(`no ${wanted} message in fixture ${sourceFixture}`);
  return hit.uuid as string;
}

async function dumpHistory(fixtureName: string): Promise<void> {
  const sessionId = sessionIdFromFixture(fixtureName);
  const messages = await getSessionMessages(sessionId, { dir: SANDBOX_DIR, includeSystemMessages: true });
  const file = join(FIXTURES_DIR, `history-${fixtureName}.json`);
  writeFileSync(file, redactEmails(JSON.stringify(messages, null, 2)) + '\n');
  console.log(`wrote ${file} (${messages.length} messages, session ${sessionId})`);
}

async function record(): Promise<void> {
  const name = values.name ?? fail('--name is required');
  const prompts = values.prompt ?? [];
  if (prompts.length === 0) fail('at least one --prompt is required');

  mkdirSync(FIXTURES_DIR, { recursive: true });
  mkdirSync(STDERR_LOG_DIR, { recursive: true });
  const outDir = values['out-dir'] ? join(FIXTURES_DIR, values['out-dir']) : FIXTURES_DIR;
  mkdirSync(outDir, { recursive: true });
  const fixtureFile = join(outDir, `${name}.ndjson`);
  const stderrFile = join(STDERR_LOG_DIR, `${name}.stderr.log`);
  writeFileSync(fixtureFile, '');
  writeFileSync(stderrFile, '');

  if (!values['keep-sandbox']) seedSandbox();
  if (values['hook-block-reason']) {
    mkdirSync(join(SANDBOX_DIR, '.claude'), { recursive: true });
    const hookOutput = JSON.stringify({ decision: 'block', reason: values['hook-block-reason'] });
    writeFileSync(
      join(SANDBOX_DIR, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `printf '%s' '${hookOutput}'` }] }] } }, null, 2),
    );
  }
  const cwd = SANDBOX_DIR;

  const emit = (line: unknown): void => {
    appendFileSync(fixtureFile, redactEmails(JSON.stringify(line)) + '\n');
  };

  const denied = new Set(values.deny ?? []);
  const mode = values.mode as PermissionMode;
  const queue = new AsyncQueue<SDKUserMessage>();
  let q: ReturnType<typeof query> | undefined;

  const canUseTool: CanUseTool = async (toolName, input, options) => {
    const { signal: _signal, ...serializableOptions } = options;
    let result: PermissionResult;

    if (denied.has(toolName)) {
      result = { behavior: 'deny', message: 'User rejected (fixture recorder)' };
    } else if (toolName === 'AskUserQuestion') {
      // Answer every question: first option, or first two for multi-select.
      const questions = (input.questions ?? []) as Array<{
        question: string;
        multiSelect?: boolean;
        options: Array<{ label: string }>;
      }>;
      const answers: Record<string, string> = {};
      for (const item of questions) {
        const picked = item.multiSelect ? item.options.slice(0, 2) : item.options.slice(0, 1);
        answers[item.question] = picked.map((o) => o.label).join(', ');
      }
      result = { behavior: 'allow', updatedInput: { ...input, answers } };
    } else if (toolName === 'ExitPlanMode') {
      result = { behavior: 'allow', updatedInput: input };
      if (values['exit-plan-mode']) {
        await q?.setPermissionMode(values['exit-plan-mode'] as PermissionMode);
      }
    } else {
      result = values['allow-without-input'] ? { behavior: 'allow' } : { behavior: 'allow', updatedInput: input };
      if (values.always && options.suggestions?.length && result.behavior === 'allow') {
        result = { ...result, updatedPermissions: options.suggestions };
      }
    }

    emit({ type: '_canUseTool', toolName, input, options: serializableOptions, result });
    return result;
  };

  const settingSources =
    values['setting-sources'] === 'none'
      ? []
      : (values['setting-sources'] as string).split(',').map((s) => s.trim() as 'user' | 'project' | 'local');

  const abortController = new AbortController();
  const options: Options = {
    cwd,
    model: values.model,
    permissionMode: mode,
    includePartialMessages: !values['no-partial'],
    forwardSubagentText: values['forward-subagent-text'],
    includeHookEvents: values['include-hook-events'],
    settingSources,
    systemPrompt: values['no-snapshot'] ? { type: 'preset', preset: 'claude_code', snapshot: false } : { type: 'preset', preset: 'claude_code' },
    enableFileCheckpointing: true,
    abortController,
    canUseTool,
    env: buildEnv(Object.fromEntries((values.env ?? []).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]))),
    stderr: (data) => appendFileSync(stderrFile, data),
  };
  if (values.agent) options.agent = values.agent;
  if (values['agents-json']) {
    const raw = values['agents-json'];
    options.agents = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw);
  }
  if (values['max-turns']) options.maxTurns = Number(values['max-turns']);
  if (values.tools) {
    options.tools =
      values.tools === 'preset' ? { type: 'preset', preset: 'claude_code' } : values.tools.split(',').map((t) => t.trim());
  }
  if (values['allowed-tools']) options.allowedTools = values['allowed-tools'].split(',').map((t) => t.trim());
  // Default: adaptive thinking with display "summarized" (otherwise thinking blocks arrive with empty text).
  // --thinking default | disabled | adaptive[:summarized|omitted] | enabled:<budget>[:summarized|omitted]
  {
    const spec = values.thinking ?? 'adaptive:summarized';
    const [kind, a, b] = spec.split(':');
    if (kind === 'enabled') {
      options.thinking = { type: 'enabled', budgetTokens: Number(a ?? 2048), display: (b ?? 'summarized') as 'summarized' | 'omitted' };
    } else if (kind === 'adaptive') {
      options.thinking = { type: 'adaptive', display: (a ?? 'summarized') as 'summarized' | 'omitted' };
    } else if (kind === 'disabled') {
      options.thinking = { type: 'disabled' };
    } // "default": leave unset
  }

  if (values.resume) {
    options.resume = resolveSessionId(values.resume);
    if (values.fork) {
      options.forkSession = true;
      options.sessionId = values['session-id'] ?? randomUUID();
    }
    if (values['resume-at']) options.resumeSessionAt = resolveResumeAt(values['resume-at'], values.resume);
  } else {
    options.sessionId = values['session-id'] ?? randomUUID();
  }

  const sendUser = (text: string): void => {
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      uuid: randomUUID(),
    };
    emit({ type: '_input', message });
    queue.push(message);
  };

  // First line of every fixture: the (serializable) options this recording used.
  emit({
    type: '_options',
    options: {
      model: options.model,
      permissionMode: options.permissionMode,
      includePartialMessages: options.includePartialMessages,
      forwardSubagentText: options.forwardSubagentText,
      settingSources: options.settingSources,
      thinking: options.thinking,
      tools: options.tools,
      allowedTools: options.allowedTools,
      agent: options.agent,
      agents: options.agents ? Object.keys(options.agents) : undefined,
      sessionId: options.sessionId,
      resume: options.resume,
      forkSession: options.forkSession,
      resumeSessionAt: options.resumeSessionAt,
      extraEnv: values.env ?? [],
    },
  });

  q = query({ prompt: queue, options });

  let nextPrompt = 0;
  const interruptAfterMs = values['interrupt-after-ms'] ? Number(values['interrupt-after-ms']) : undefined;
  const sendNext = (): void => {
    sendUser(prompts[nextPrompt++]!);
    // Only the first turn is interrupted.
    if (interruptAfterMs !== undefined && nextPrompt === 1) {
      setTimeout(() => {
        q!
          .interrupt()
          .then((response) => emit({ type: '_interrupt', afterMs: interruptAfterMs, response: response ?? null }))
          .catch((err) => emit({ type: '_interrupt', afterMs: interruptAfterMs, error: String(err) }));
      }, interruptAfterMs);
    }
  };

  const watchdog = setTimeout(() => {
    console.error(`record-fixture: timeout after ${values.timeout}ms, closing`);
    emit({ type: '_error', message: 'recorder watchdog timeout' });
    q!.close();
  }, Number(values.timeout));

  sendNext();
  let messageCount = 0;
  let resultCount = 0;
  try {
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      messageCount++;
      emit(msg);
      if (msg.type === 'result') {
        resultCount++;
        if (nextPrompt < prompts.length) sendNext();
        else queue.end();
      }
    }
  } catch (err) {
    const e = err as Error;
    emit({ type: '_error', message: e.message, stack: e.stack });
    console.error(`record-fixture: iterator threw: ${e.message}`);
  } finally {
    clearTimeout(watchdog);
    queue.end();
    q.close();
  }
  console.log(`wrote ${fixtureFile}: ${messageCount} messages, ${resultCount} result(s)`);
}

if (values.history) await dumpHistory(values.history);
else await record();
process.exit(0);
