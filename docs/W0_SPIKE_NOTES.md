# W0 Spike Notes — Claude Agent SDK verification

Companion to `docs/PHASE1_PLAN.md` (§7 W0, §8 risks). Everything below was verified against the installed
`.d.ts` **and** against recorded runtime behaviour (fixtures in `packages/vscode/src/claude/__fixtures__/`).
Items marked **(d.ts only)** were not exercised at runtime.

## 1. Install

| | |
|---|---|
| SDK | `@anthropic-ai/claude-agent-sdk@0.3.295` (npm `latest`), pinned exact in `packages/vscode/package.json` (`bun add --exact`) |
| Bundled CLI | Claude Code `2.1.295` (`system/init.claude_code_version`) |
| Platform binary | `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.295` — a **239.7 MB** native `claude` executable. Bun installed only the host platform's optional dep (the other 7 are absent) |
| Layout | bun uses the isolated linker: `packages/vscode/node_modules/@anthropic-ai/claude-agent-sdk` is a **symlink** into `node_modules/.bun/...`; nothing is hoisted to the root `node_modules`. Anything copying the SDK must dereference symlinks |
| Peer deps | `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `zod` (bun installed them under `.bun/`). `sdk.mjs` inlines everything it needs at runtime; they are only needed for `.d.ts` resolution (type-check passes with them) |
| Runtime requirement | Node >= 18 (VS Code 1.133 ships Electron 42.8 / Node 24.18 — fine) |

Binary resolution inside the SDK: `createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude')`,
musl variants preferred on Alpine. If `pathToClaudeCodeExecutable` is not given and the package is missing it throws
`Native CLI binary for <platform>-<arch> not found...`. Verified that `pathToClaudeCodeExecutable` pointing at the user's own
`~/.local/bin/claude` (2.1.295) works (so the planned `claudekei.claudeExecutablePath` setting is viable).

## 2. API verification vs the plan

Legend: OK = matches the plan; **DIFF** = differs, see impact.

### 2.1 `query()` options

| Plan says | Actual (0.3.295) | Status / impact |
|---|---|---|
| `sessionId` | `sessionId?: string` — must be a UUID; "cannot be used with `continue`/`resume` unless `forkSession` is also set (then it names the fork)". Verified: `init.session_id` equals the supplied id, transcript is written under that id | OK |
| `resume` | `resume?: string`. Verified: resumed session keeps the same `session_id`, appends to the same JSONL | OK |
| `forkSession` | `forkSession?: boolean` ("resumed sessions fork to a new session id"). Verified with `resume` + `forkSession: true` + `sessionId: <new uuid>`; the supplied id is honoured | OK |
| `resumeSessionAt` | `resumeSessionAt?: string` — "resume only up to and including the message with this UUID"; accepts any chain-entry uuid. Verified (`fork` fixture: fork cut at the first assistant message; follow-up answered with only the first turn). New companion `resumeDropsTurn?: string` (validation, optional) | OK. **Better alternative:** `forkSession(sessionId, {dir, upToMessageId, title})` helper (see 2.4) forks on disk without spawning a process and returns `{sessionId}`; then `resume: newId`. Simpler for `claude:session.fork` (no draft-with-pending-fork state) |
| `includePartialMessages` | `includePartialMessages?: boolean` → `stream_event` messages | OK |
| `enableFileCheckpointing` | `enableFileCheckpointing?: boolean` (sets `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`). `Query.rewindFiles(userMessageId, {dryRun?})` takes a **user message uuid** (see 2.2: we can supply it) | OK (rewind itself not exercised) |
| `settingSources: ['user','project','local']` | `settingSources?: SettingSource[]`; omitted = all; `[]` = isolation; must include `'project'` for CLAUDE.md | OK — **but see 3.7: user settings can hijack the session** (`agent`, hooks, plugins) |
| `systemPrompt: {type:'preset', preset:'claude_code'}` | Also accepts `append`, `excludeDynamicSections`, `snapshot`; or `string` / `string[]` / `{type:'custom', prompt, snapshot?}` | OK |
| `pathToClaudeCodeExecutable` | Exists; `undefined` = native binary from the platform package | OK |
| `executable: process.execPath` (+ `ELECTRON_RUN_AS_NODE=1`) | `executable?: 'bun' \| 'deno' \| 'node'` — an **enum of runtimes, not a path** | **DIFF.** Not applicable to the native binary (default path) at all. If a JS CLI fallback is ever needed, use `spawnClaudeCodeProcess(options: SpawnOptions): SpawnedProcess` (custom spawn; we could spawn `process.execPath` with `ELECTRON_RUN_AS_NODE=1`). Plan §8 mitigation should drop the `executable: process.execPath` wording. Note: the 2.1.x SDK ships **no `cli.js`**; only the native binary |
| `env` | `env?: {[k]: string \| undefined}` — **replaces** the child environment entirely (not merged); omitted = inherits `process.env` | OK, but `env.ts` must spread `process.env` itself. `ELECTRON_RUN_AS_NODE=1` is inherited by the native child — harmless |
| `stderr` | `stderr?: (data: string) => void` | OK |
| `abortController` | `abortController?: AbortController` | OK |
| `permissionMode` | `'default' \| 'acceptEdits' \| 'bypassPermissions' \| 'plan' \| 'dontAsk' \| 'auto'`. **When omitted the CLI may pick `auto`** (or `permissions.defaultMode` from loaded settings) | **DIFF (minor):** always pass `permissionMode` explicitly (we do: plan §1). Two extra modes (`dontAsk`, `auto`) exist; D8's three-mode cycle is still fine |
| *(not in plan)* `thinking` | `thinking?: {type:'adaptive'\|'enabled'\|'disabled', display?: 'summarized'\|'omitted', budgetTokens?}`. **Without `display: 'summarized'` thinking blocks arrive with empty text** (only `system/thinking_tokens` estimates). Verified (`thinking` vs `thinking-default` fixtures) | **DIFF — must set** `thinking: {type:'adaptive', display:'summarized'}` or `ReasoningPart` will always be empty |
| *(not in plan)* `forwardSubagentText` | `forwardSubagentText?: boolean` — forwards full subagent text/thinking as `assistant` msgs with `parent_tool_use_id`. Default: only tool_use/tool_result. Observed: even without it the final subagent text/thinking appear in some orderings (`task` fixture) | Set `true` if child sessions should show subagent text (Phase 1 uses `sub_<toolUseId>`) |
| *(not in plan)* `persistSession` | `persistSession?: boolean` (default true); `false` = no JSONL | Useful for the catalog probe fallback / one-shots. `devHello` uses it |
| *(not in plan)* `allowedTools` / `tools` / `disallowedTools` | `allowedTools` auto-allows **and** adds tools to the set (see 3.4) | Needed to get `Grep`/`Glob`/`TodoWrite` |
| *(not in plan)* `title` | `title?: string` for a new session | Could replace the "first prompt" title until `renameSession` |
| *(not in plan)* `toolConfig.askUserQuestion.previewFormat` | `'markdown' \| 'html'` | Phase 2 |

### 2.2 `canUseTool` and `PermissionResult`

```ts
type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    mcpServer?: { name: string; source: string };
    decisionReason?: string;
    title?: string; displayName?: string; description?: string;
    defaultToNo?: boolean; suppressAlwaysAllowRule?: boolean;
    toolUseID: string;          // == tool_use block id
    agentID?: string;           // set when the call comes from a subagent
    requestId: string;          // control_request id
    matchedAskRule?: { source: string; toolName: string; ruleContent?: string };
    // runtime-only (not in the d.ts, observed in fixtures): decisionReasonType, requiresUserInteraction
  },
) => Promise<PermissionResult | null>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[]; toolUseID?: string; decisionClassification?: ... }
  | { behavior: 'deny'; message: string; interrupt?: boolean; toolUseID?: string; decisionClassification?: ... };
```

* `updatedInput` is **optional** (verified: `{behavior:'allow'}` alone applied the Edit — `permission-edit-noinput`). The plan's "allow unchanged" needs no input echo.
* Returning `null` = "I answered out-of-band"; never do this by accident (tool blocks forever).
* `PermissionUpdate` = `addRules | replaceRules | removeRules {rules:[{toolName, ruleContent?}], behavior, destination}` | `setMode {mode, destination}` | `addDirectories | removeDirectories`. `destination`: `'userSettings'|'projectSettings'|'localSettings'|'session'|'cliArg'`.
* **Real `suggestions` seen (impact on the "Always" UI, plan §3):**
  * `Edit` (recorded; `Write` presumably identical, not recorded in default mode): `[{type:'setMode', mode:'acceptEdits', destination:'session'}]` — "always" = "switch the session to acceptEdits" (not a rule!). Verified (`permission-always`): echoing it as `updatedPermissions` makes the second Edit run unprompted and the CLI emits `system/status {permissionMode:'acceptEdits'}`. The UI mode indicator should follow that message.
  * `Bash`: `[{type:'addRules', rules:[{toolName:'Bash', ruleContent:'mkdir -p out'}, {toolName:'Bash', ruleContent:'echo hi *'}], behavior:'allow', destination:'localSettings'}]` — compound commands are split into several rules; **destination `localSettings` persists to `.claude/settings.local.json` in the workspace**. Consider re-targeting to `'session'` before echoing, or warn the user.
  * Some Bash prompts carry `suggestions: []` or none (e.g. `cd ... && ... >> file`, "brace with quote" obfuscation): "Always" must be disabled when empty.
  * `AskUserQuestion` / `ExitPlanMode`: no suggestions, `options.requiresUserInteraction: true`.
* `AskUserQuestion` input: `{questions:[{question, header, options:[{label, description, preview?}], multiSelect}]}`. Answer shape verified: `{behavior:'allow', updatedInput:{...input, answers:{[question]: 'Red, Green'}}}` → tool_result text `Your questions have been answered: "Which colors do you like?"="Red, Green"`; `tool_use_result = {questions, answers}`. Multi-select = labels joined with `", "`. OK as planned.
* `ExitPlanMode` input: `{plan, planFilePath}` (plan was also written to `~/.claude/plans/<slug>.md` by a `Write` in plan mode — outside the workspace, auto-allowed in plan mode). On **allow** the CLI **itself** switches back to the previous mode (`system/status {permissionMode:'default'}`); to land in `acceptEdits` call `await query.setPermissionMode('acceptEdits')` from inside `canUseTool` before returning (verified, `plan-exit-accept`) or return `updatedPermissions:[{type:'setMode',mode:'acceptEdits',destination:'session'}]` **(d.ts only)**. The plan's "once → `setPermissionMode('default')`" is redundant. Deny message makes the model keep planning.
* **Interrupt while a permission is pending / tool running** (`interrupt` fixture): tool_result becomes an error ("The user doesn't want to proceed with this tool use..."), a synthetic `user` message with text `[Request interrupted by user for tool use]` appears, `result` = `error_during_execution`, `terminal_reason: 'aborted_tools'`. `options.signal` is the per-request abort (plan §3 "signal abort → resolve").
* **Denied tool** (`permission-denied`): no `system/permission_denied` message. The tool_result is `is_error: true` with the deny `message` as content; `tool_use_result` is the string `"Error: <message>"`; `result.permission_denials[]` lists `{tool_name, tool_use_id, tool_input}`; `tool_result_meta[].non_execution_kind: 'permission-rule'`. The plan's `permission_denied` mapping row can stay as a tolerant extra but the main path is the `is_error` tool_result.
* Read-only/trivial Bash (`echo hi && ls`) and `Read`/`Grep`/`Glob` are auto-allowed (`tool_result_meta.permission_decision.source: 'config'`) — `canUseTool` is not called.

### 2.3 `SDKUserMessage` (streaming input)

```ts
type SDKUserMessage = {
  type: 'user';
  message: MessageParam;              // { role:'user', content: string | ContentBlockParam[] }
  parent_tool_use_id: string | null;  // required, null for the main thread
  uuid?: UUID;                        // YES: caller may supply it
  session_id?: string;                // optional (omitted in all recordings, works)
  priority?: 'now' | 'next' | 'later';
  shouldQuery?: boolean; isSynthetic?: boolean; timestamp?: string; origin?: SDKMessageOrigin;
  client_composed?: true; pasted_content?: ...; inline_pastes?: string[];
  tool_use_result?: unknown; agent_id?: string; subagent_type?: string; task_description?: string;
};
```

* **A supplied `uuid` is honoured**: it comes back as `command_lifecycle.command_uuid`, as `user_message_uuid(s)` on `stream_event`/`assistant`/`result`/`system/status`, and it is the uuid of the user entry in the JSONL (`getSessionMessages` user uuid == supplied uuid, verified). So the host can generate user-message uuids up front and use them for `forkSession({upToMessageId})`, `resumeSessionAt`, and `rewindFiles`. This also gives a clean way to bind assistant output to the user message it answers (`parentID`).
* Streaming-input user messages are **not echoed** back by the iterator (matches plan "prompt echo ignored live"): no `user` message with our text appears; only `command_lifecycle` `queued` → `started`.
* `priority` (`now|next|later`) exists for mid-turn sends **(d.ts only)**; plain pushes while busy queue as the plan assumes.
* Slash commands are sent as plain text (`/compact` worked, `compact` fixture). `verbatimPrompts`/`client_composed` disable `@path` expansion and slash dispatch.

### 2.4 `Query` methods

| Plan | Actual | Status |
|---|---|---|
| `interrupt()` | `interrupt(): Promise<{still_queued: string[]} \| undefined>` (receipt, uuids of queued async user messages that will still run). Verified in `interrupt` / `interrupt-text` fixtures | OK. Note: a message that was queued before the interrupt **still runs** unless cancelled (`cancel_queued` is a control-request option, not exposed on `interrupt()` in 0.3.295's typing) |
| `setModel(model?)` | `setModel(model?: string): Promise<void>` (streaming-input only) | OK **(d.ts only)** |
| `setPermissionMode(mode)` | OK; verified working from inside `canUseTool` | OK |
| `supportedModels()` | `Promise<ModelInfo[]>` — `{value, resolvedModel?, displayName, description, supportsEffort?, supportedEffortLevels?, supportsAdaptiveThinking?, supportsFastMode?, supportsAutoMode?}`. Real catalog: `default` (→ opus 5.5), `opus`, `fable`, `sonnet`, `haiku`, + 8 pinned ids (13 rows) | OK |
| `supportedCommands()` | `Promise<SlashCommand[]>` — `{name (no leading '/'), description, argumentHint, aliases?, builtin?}`; 54 rows incl. skills | OK |
| `supportedAgents()` | `Promise<AgentInfo[]>` — `{name, description, model?}` (names like `general-purpose`, `Explore`, `Plan`, `statusline-setup`, `claude`; plugin agents appear when user settings load) | OK |
| `accountInfo()` | `{email?, organization?, subscriptionType?, tokenSource?, apiKeySource?, apiProvider?}` (`subscriptionType` e.g. `"Claude Team"`, `apiProvider: 'firstParty'`) | OK |
| `rewindFiles(id)` | `rewindFiles(userMessageId, {dryRun?}): Promise<{canRewind, error?, filesChanged?, insertions?, deletions?, skippedLinks?}>` | OK **(d.ts only)** |
| `close()` | `close(): void` — kills the process; the iterator then ends | OK |
| `getContextUsage()` | `getContextUsage({detail?: 'summary'\|'full'}): Promise<SDKControlGetContextUsageResponse>` (`totalTokens, maxTokens, percentage, categories[], model, isAutoCompactEnabled, autoCompactThreshold, ...`). **Works before any user message** (probe) | OK — Phase-2 context meter is cheap |
| *(new)* `initializationResult()` | Returns `{commands, agents, models, account, output_style, available_output_styles, pid, current_permission_mode, ...}` in **one** control request | **Use this for the catalog probe** instead of four calls |
| *(new)* | `stopTask(taskId)`, `backgroundTasks(toolUseId?)`, `reinitialize()`, `mcpServerStatus()`, `applyFlagSettings()`, `streamInput()`, `setMaxThinkingTokens()` (deprecated) | Phase 2 candidates |

### 2.5 Session helpers (module-level functions)

| Plan | Actual | Status |
|---|---|---|
| `listSessions({dir})` | `listSessions({dir?, limit?, offset?, includeWorktrees?, includeProgrammatic?}): Promise<SDKSessionInfo[]>`; sorted by `lastModified` desc. `SDKSessionInfo = {sessionId, summary, lastModified, fileSize?, customTitle?, firstPrompt?, gitBranch?, cwd?, tag?, createdAt?}`. **`includeProgrammatic: false` returned 0 of 60 sessions** — everything this SDK spawns carries entrypoint `sdk-ts` and is hidden by that flag | OK, but **never pass `includeProgrammatic:false`** (default `true`). Alternatively set `env.CLAUDE_CODE_ENTRYPOINT` (SDK defaults it to `sdk-ts` when unset) to make sessions look like IDE sessions in the terminal `/resume` picker |
| title = `customTitle ?? summary ?? firstPrompt` | `summary` already = custom title, else auto-generated title, else first prompt. The CLI **auto-generates** `customTitle` (e.g. "History of the bicycle") in the background (one extra small model call per new session) | OK — `title = customTitle ?? summary` suffices |
| `getSessionMessages(id, {dir})` | `getSessionMessages(id, {dir?, limit?, offset?, includeSystemMessages?}): Promise<SessionMessage[]>`; `[]` when not found. Runtime object has extra fields beyond the d.ts: `timestamp`, `isCompactSummary`, `is_meta` | OK. **No `tool_use_result` in history** (see 2.6) |
| `getSessionInfo` *(plan: not mentioned)* | `getSessionInfo(id, {dir?}): Promise<SDKSessionInfo \| undefined>` | Handy for fork/rename refresh |
| `renameSession(id, title, {dir})` | Verified: appends a custom-title entry; `getSessionInfo`/`listSessions` reflect it immediately | OK |
| "No delete API; unlink `<id>.jsonl` + `<id>/`" (plan §8) | **`deleteSession(id, {dir?})` exists** — removes `{id}.jsonl` and the `{id}/` subagent dir; throws `Session <id> not found in project directory for <dir>` when missing. Verified | **DIFF — use it; drop the manual unlink** (still `close()` the live query first) |
| `forkSession` via query options | **`forkSession(id, {dir?, upToMessageId?, title?}): Promise<{sessionId}>`** helper: copies the transcript with remapped uuids (verified: all uuids differ, truncation at `upToMessageId` inclusive, title applied). Forks start without file-history/undo | **DIFF (improvement)** — see 2.1 |
| subagent history "not loaded in Phase 1" | **`listSubagents(sessionId,{dir})` → `string[]` (agent ids) and `getSubagentMessages(sessionId, agentId, {dir})`** both work (verified on a background subagent: 5 messages with `parent_tool_use_id` set) | **DIFF (opportunity):** Phase 2 "lazy sidechain load" is essentially free. Even Phase 1 could use it |
| — | `tagSession(id, tag\|null)` | **(d.ts only)** |

### 2.6 `tool_use_result` on user messages

Present on **live** `user` messages (the tool-result carrier), **absent from `getSessionMessages` history**. History only has the string `tool_result.content`. Consequently the diff builder must work from the **tool_use input** in replay (`old_string/new_string`, `content`) and may use `structuredPatch` only live. Extra undocumented field on live user messages: `tool_result_meta: [{id, permission_decision:{decision, source, reason_type?}, non_execution_kind?}]`.

Observed shapes (all verified in fixtures):

| Tool (tool_use `name`) | `tool_use_result` |
|---|---|
| `Edit` | `{filePath, oldString, newString, originalFile, structuredPatch:[{oldStart,oldLines,newStart,newLines,lines:[" ctx","-old","+new"]}], userModified, replaceAll, contentNotInModelContext?}` (`gitDiff?` per d.ts). `tool_result.content` = "The file ... has been updated successfully..." |
| `Write` | `{type:'create'\|'update', filePath, content, structuredPatch, originalFile, userModified}` — **`structuredPatch` is `[]` and `originalFile` is `null` on create** → synthesize from `content` |
| `Read` | `{type:'text', file:{filePath, content, numLines, startLine, totalLines}}`; `tool_result.content` is cat -n text |
| `Bash` | `{stdout, stderr, interrupted, isImage, noOutputExpected, backgroundTaskId?}` |
| `Grep` | `{mode, filenames, numFiles, totalFiles}` (mode `files_with_matches` in the fixture) |
| `Glob` | `{filenames, durationMs, numFiles, truncated, totalMatches, countIsComplete}` |
| `TodoWrite` | `{oldTodos[], newTodos[]}` each `{content, status, activeForm}` |
| `AskUserQuestion` | `{questions, answers}` |
| `ExitPlanMode` | `{plan, isAgent, filePath?, ...}` |
| `Agent` sync (completed) | `{status:'completed', prompt, agentId, agentType, content:[{type:'text',text}], resolvedModel, totalDurationMs, totalTokens, totalToolUseCount, usage}` |
| `Agent` async launch | `{isAsync:true, status:'async_launched', agentId, description, prompt, resolvedModel, outputFile}` |
| `TaskCreate` / `TaskUpdate` (v2) | `{task:{id,subject}}` / `{success, taskId, updatedFields, statusChange:{from,to}}` |
| error / denied / interrupted | plain **string** `"Error: <message>"` / `"User rejected tool use"` |

### 2.7 All `SDKMessage` variants

Union in the d.ts (`SDKMessage`), 39 members. "Seen" = present in at least one fixture.

| `type` / `subtype` | Seen | Notes |
|---|---|---|
| `assistant` | yes | `message: BetaMessage` — **one message per content block** (thinking / text / tool_use each get their own `assistant`), same `message.id`, `stop_reason: null`. Also `error?: SDKAssistantMessageError` (`model_not_found`, `rate_limit`, `authentication_failed`, ...), `user_message_uuid(s)`, `aborted?`, `agent_id?`, `parent_tool_use_id` |
| `user` | yes | tool_result carriers (+ `tool_use_result`, `tool_result_meta`); `[Request interrupted by user]` text; the subagent's initial prompt (with `parent_tool_use_id`); `isSynthetic` compaction summary (`content` is a **string**); `isReplay: true` `<local-command-stdout>Compacted </local-command-stdout>` |
| `user` (`SDKUserMessageReplay`) | yes | `isReplay: true` — only for the compact output above |
| `stream_event` | yes | `event: BetaRawMessageStreamEvent`; extra fields `api_message_id`, `ttft_ms`, `thinking_display`, `user_message_uuid(s)`. Block types seen: `text`, `thinking`, `tool_use`; deltas: `text_delta`, `thinking_delta` (`{thinking, estimated_tokens}`), `signature_delta`, `input_json_delta` |
| `result` (`success`) | yes | **May be emitted more than once per user message** (background subagent/task completion auto-starts a follow-up turn; `task` fixture has 2). Also `is_error: true` with `subtype:'success'` for API errors (`error` fixture: `terminal_reason:'api_error'`, `api_error_status:404`) |
| `result` (`error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`) | `error_during_execution` only | After interrupt: `result:null`, `errors:["[ede_diagnostic] ..."]`, `terminal_reason: 'aborted_streaming' \| 'aborted_tools'`, `stop_reason` null/`tool_use` |
| `system/init` | yes | **Emitted once per turn** (multi-turn: 2, compact: 2), *not* before the first user message. `model` echoes the requested id even when invalid |
| `system/status` | yes | `status: 'requesting' \| 'compacting' \| null`, optional `permissionMode` (this is how mode changes are announced), `compact_result` |
| `system/compact_boundary` | yes | `compact_metadata:{trigger, pre_tokens, post_tokens, duration_ms, cumulative_dropped_tokens?, ...}`, `logical_parent_uuid` |
| `system/thinking_tokens` | yes | **Not in the plan.** `{estimated_tokens, estimated_tokens_delta, user_message_uuid}` — emitted ~10x per turn; ignore |
| `system/task_started`, `task_progress`, `task_updated`, `task_notification` | yes | Subagents *and* background Bash tasks. `task_started{task_id, tool_use_id, description, subagent_type?, is_backgrounded, task_type:'local_agent'\|'local_bash', prompt?}`; `task_progress{usage:{total_tokens,tool_uses,duration_ms}, last_tool_name, description}`; `task_notification{status:'completed'\|'failed'\|'stopped', summary, output_file, usage}` |
| `system/background_tasks_changed` | yes | `{tasks:[...]}` snapshot of running background tasks |
| `system/hook_started`, `hook_response` | yes | `SessionStart` hooks are **always** emitted, before `init` (user settings enabled) |
| `system/commands_changed` | yes | `{commands: SlashCommand[]}` — arrives right after init when user/plugin skills load; use to refresh catalog |
| `system/api_retry`, `permission_denied`, `hook_progress`, `local_command_output`, `files_persisted`, `plugin_install`, `notification`, `elicitation_complete`, `session_state_changed`, `memory_recall`, `informational`, `mirror_error`, `model_refusal_fallback`, `model_refusal_no_fallback`, `worker_shutting_down`, `control_request_progress` | no | Shapes in d.ts. `session_state_changed {state:'idle'\|'running'\|'requires_action'}` is the documented authoritative turn-over signal but was **not emitted** with default env (use `result`) |
| `tool_progress` | no | `{tool_use_id, tool_name, parent_tool_use_id, elapsed_time_seconds, ...}` — not emitted for a 40 s `ping` (maybe needs a flag) |
| `rate_limit_event` | yes | `{rate_limit_info:{status, resetsAt, rateLimitType, utilization, overageStatus, ...}}`; also carries `unifiedWindows` at runtime |
| `auth_status`, `tool_use_summary`, `prompt_suggestion`, `conversation_reset` | no | |
| **`command_lifecycle`** | yes | **Undeclared in the `SDKMessage` union.** `{command_uuid, state:'queued'\|'started'\|..., uuid, session_id}` echoes each streamed user message; the mapper must tolerate it (it is a free "message accepted" ack) |
| (`_options`, `_input`, `_canUseTool`, `_interrupt`, `_error`) | — | Synthetic recorder lines, see §6 |

## 3. Behavioural findings that change the plan

1. **Thinking text is empty by default** — set `thinking: {type:'adaptive', display:'summarized'}` (2.1).
2. **`TodoWrite` is not in the default tool set.** This CLI exposes the task-v2 tools (`TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet`, loaded through the deferred-tool mechanism `ToolSearch`). `TodoWrite` is available only with `env CLAUDE_CODE_ENABLE_TASKS=false` + `allowedTools:['TodoWrite']` (tested together; fixture `todowrite`). `allowedTools:['TodoWrite']` alone produced the v2 tools (fixture `tasks-v2`). **Decision needed for W2/W3:** (a) set `CLAUDE_CODE_ENABLE_TASKS=false` in the host env and keep the planned TodoWrite→`todo.updated` mapping (smallest change), or (b) derive todos from `TaskCreate`/`TaskUpdate` results (`tool_use_result.task.id/subject`, `statusChange`). Also: `ToolSearch` appears as a tool call in transcripts (`tool_result` content `[{type:'tool_reference', tool_name}]`) — render hidden/generic.
3. **Subagents run in the background by default** (`Agent` tool_result is immediately `"Async agent launched successfully..."` with `tool_use_result.isAsync`; the parent turn can finish — `result` #1 — and a second auto-turn starts on `task_notification` — `result` #2). The plan's "Task `tool_result` → child idle" only holds with `env CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (fixture `task-sync`: tool_result arrives after the subagent finishes, `tool_use_result.status:'completed'`). **Recommendation:** set that env in the host (also disables background Bash — e.g. `sleep 40` then runs foreground/blocked instead of `run_in_background`), or implement the `task_*` lifecycle (map `task_started.tool_use_id` → child `sub_<id>`, `task_notification` → child idle). The tool_use name is `Agent` while `init.tools` lists it as `Task`; normalize both.
4. **Default tool set differs from the plan's table**: `init.tools` = Task, AskUserQuestion, Bash, Cron*, DesignSync, Edit, EnterPlanMode, EnterWorktree, ExitPlanMode, ExitWorktree, ListAgents, Monitor, NotebookEdit, PushNotification, Read, RemoteTrigger, ReportFindings, ScheduleWakeup, SendMessage, ShareOnboardingGuide, Skill, TaskStop, ToolSearch, WebFetch, WebSearch, Workflow, Write. **No `Grep`, `Glob`, `LS`, `MultiEdit`, `BashOutput`, `KillShell`, `TodoWrite`.** `Grep`/`Glob` appear when listed in `allowedTools` (fixture `grep`, `tools` shown in init). So **`MultiEdit` was not recorded** — the model uses parallel `Edit` calls instead (`edit-parallel` fixture: two `Edit` tool_use blocks in one assistant turn, interleaved `assistant`/`user` messages). The `multiedit` renderer path is dead code for this CLI.
5. **`assistant` precedes the block's `content_block_stop`/`message_delta`/`message_stop`**, and each block is its own `assistant` message with `stop_reason: null` (final `stop_reason` only arrives in `message_delta`). The mapper's "reconcile by ordinal within `apiMessageId`" must tolerate that ordering; tools pair by block id as planned.
6. **Process exit after an error result**: when input is closed after an `is_error` result (our recorder does this to finish) the CLI exits with code 1 and the iterator **throws** `Claude Code process exited with code 1` *after* the final `result` (seen in `error`, `interrupt`, `interrupt-text`). With stdin kept open (the host's normal mode) the process stays alive; the host should still treat "throw after a `result`" as a normal end.
7. **User settings can change behaviour.** The author's `~/.claude/settings.json` has `agent: "claudekei:orchestrator"`, `enabledPlugins`, and Orca hooks for `PermissionRequest`/`PreToolUse`/etc. With `settingSources` including `user` (plan default) the session loads those (fixture `text-usersettings`: SessionStart hook messages, `commands_changed`, 16 agents incl. plugin agents). A user-level `PermissionRequest`/`PreToolUse` hook can pre-decide permissions before `canUseTool` is consulted and a user-level `agent` replaces the main-thread system prompt. All other fixtures were recorded with `settingSources:['project']` for determinism. Recommend: `claudekei.settingSources` setting; consider passing `agent: undefined`-style override via `settings` or documenting the behaviour.
8. **Env**: the recorder strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_AGENT_SDK_*` (variables injected by a parent Claude Code). A real extension host normally lacks the latter, but a VS Code launched from a `claude` terminal would inherit them — `env.ts` should strip `CLAUDECODE`/`CLAUDE_CODE_*` too. Auth worked with only the keychain/`~/.claude` login (`apiKeySource: "none"`).
9. `result.modelUsage[...]` carries `contextWindow` (1,000,000 for haiku-5-5/opus) and `maxOutputTokens` — can replace the "static limit table" for the context meter. `usage.output_tokens_details.thinking_tokens` is available for `AssistantMessage.tokens.reasoning`.
10. Mid-turn permission mode changes are announced via `system/status.permissionMode`; also `initializationResult().current_permission_mode`.

## 4. Probe-without-message result (plan §1 "Catalog probe", §8 "Probe query side effects")

`probe-catalog.ts`, two variants, output in `fixtures/catalog-probe.json` (identity redacted):

| Variant | `initializationResult()` | `supportedModels/Commands/Agents/accountInfo` | `getContextUsage` | Messages emitted by the iterator | Transcript written |
|---|---|---|---|---|---|
| prompt iterable that **never yields** (stays pending) | ~260–530 ms | 0 ms each (cached from the initialize response) | ok (~35 ms) | **none** | **no new JSONL**, no model call |
| prompt iterable that **ends immediately** | ~250–280 ms | 0 ms each | fails: `Query closed before response received` (stdin already closed) | none | no |

* Total wall time to full catalog ≈ 0.3–0.6 s; no tokens spent; `close()` ends the iterator cleanly (`iteratorFinishedAfterClose: true`).
* **Use the never-yielding iterable** (`new Promise(() => {})`), call `initializationResult()` once (gives commands, agents, models, account, output styles), then `close()`. No transcript cleanup needed — the §8 mitigation "delete/filter any transcript it writes" is unnecessary.
* `system/init` is **not** emitted without a user message; `init`-driven refresh only happens per turn.

## 5. Extension-host spawn proof & packaging

**Approach (implemented):**

1. `packages/vscode/package.json`: `build:extension` now bundles `src/extension.ts` **and** `src/claude/devHello.ts` with `--outdir=dist --entry-names=[name]`, `--external:@anthropic-ai/claude-agent-sdk`, format `cjs`. esbuild keeps `await import("@anthropic-ai/claude-agent-sdk")` untouched (checked in the minified output) — so the ESM-only SDK is loaded by Node's native loader at runtime. Then `node scripts/copy-sdk.mjs` runs.
2. `scripts/copy-sdk.mjs` (idempotent) copies, with symlinks dereferenced, `@anthropic-ai/claude-agent-sdk` (5.3 MB) and every installed `@anthropic-ai/claude-agent-sdk-<platform>` package (229 MB `claude` binary, `chmod 755`) into `dist/node_modules/@anthropic-ai/`. Node resolves them from `dist/extension.js` (`dist/node_modules` is the first lookup), and the SDK finds its sibling platform package through its own `createRequire`. Works regardless of bun/npm layout.
3. `.vscodeignore`: root `node_modules/**` stays excluded but `!dist/**` already re-includes `dist/node_modules/**`; added `scripts/**` and `*.vsix`. Packaging keeps `--no-dependencies` (nothing outside `dist` is needed).
4. `bun run vscode:package` → `scripts/package-vsix.mjs` → `vsce package --no-dependencies --target <process.platform>-<process.arch>` (platform-specific VSIX, e.g. `claudekei-darwin-arm64-0.1.0.vsix`); vsce's `vscode:prepublish` runs the full build first (which includes the copy step). `watch:extension` (dev host) needs no copy: `dist/` resolves the SDK via `packages/vscode/node_modules`.
5. Temporary command `claudekei.dev.hello` (contributed in `package.json`, registered in `src/extension.ts`, implemented in `src/claude/devHello.ts`): one-shot `query({prompt:'Reply with exactly: hello'})` with `persistSession:false`, logging every SDKMessage to the `ClaudeKei` OutputChannel. `devHello.ts` has no `vscode` import so the exact bundle (`dist/devHello.js`) is loadable outside VS Code.

**Proof (Electron's Node, VS Code 1.133.0 → Electron 42.8.0 / Node v24.18.0; the binary is `Contents/MacOS/Code`, not `Electron`):**

```
ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" scripts/prove-electron-hello.cjs [distDir]
```

* Against `packages/vscode/dist` → `ok=true text="hello"`.
* Against the **extracted VSIX** (`unzip` into the scratchpad, no `node_modules` anywhere above it) → `ok=true text="hello"`; confirms resolution works purely from `dist/node_modules` and that the exec bit survives (`zipinfo`: `-rwxr-xr-x` on `claude`).
* The proof script cleans parent-injected `CLAUDE_CODE_*` variables to mimic a real extension host. Auth = existing `claude login` (`apiKeySource: "none"`).
* Not done (impossible headless): actually clicking the command in an Extension Development Host. The `extension.ts` registration is a 12-line `registerCommand` calling the same `runDevHello`.

**VSIX:** `claudekei-darwin-arm64-0.1.0.vsix` = **115,511,436 bytes (110.2 MiB)**, 544 files, 272.6 MB unpacked. Contents of note: `extension/dist/extension.js` (407 KB), `extension/dist/devHello.js`, `extension/dist/node_modules/@anthropic-ai/claude-agent-sdk/{sdk.mjs, core*.mjs, bridge.mjs, browser-sdk.js, *.d.ts, manifest*.json, package.json,...}` (5.3 MB) and `.../claude-agent-sdk-darwin-arm64/claude` (239,695,888 B, `rwxr-xr-x`). Webview assets are 24 MB. vsce prints two warnings (548 JS files in webview assets; the 228 MB binary is "large") — both expected. Size trimming options for W7: drop `bridge.mjs`, `browser-sdk.js` and `*.d.ts` from the copy (~4.7 MB), nothing else is compressible (the binary dominates: ~110 MB compressed).

Known packaging limitations: one VSIX per platform (only darwin-arm64 is installed by bun here; building another target needs that target's optional package present, e.g. a CI matrix running `bun install` on each platform); size is not an issue for a personal local install.

## 6. Fixtures

Location: `packages/vscode/src/claude/__fixtures__/`. Recorded with `bun scripts/record-all.sh` (from `packages/vscode`), model `haiku` (= `claude-haiku-5-5`), `settingSources:['project']` unless noted, `thinking: {type:'adaptive', display:'summarized'}`, `includePartialMessages: true`, streaming input, cwd = throwaway sandbox (`.../scratchpad/fixture-sandbox`, re-seeded per run, never the repo). E-mail addresses are scrubbed. Absolute paths inside fixtures point at the sandbox / `~/.claude`.

NDJSON line format: every raw `SDKMessage` unmodified, plus synthetic lines (all prefixed `_`): `_options` (first line: options used), `_input` (the `SDKUserMessage` pushed), `_canUseTool` (`{toolName, input, options:{suggestions,...}, result}` — written at invocation time, so ordering vs messages is faithful), `_interrupt` (`{afterMs, response}`), `_error` (iterator threw).

| Fixture | Bytes | Scenario / what it shows |
|---|---:|---|
| `text.ndjson` | 10,234 | Minimal turn: stream events, per-block `assistant`, `result` |
| `thinking.ndjson` | 21,058 | Summarized thinking blocks (`thinking_delta` with text) interleaved with text |
| `thinking-default.ndjson` | 18,250 | Same prompt, default `thinking` config: thinking blocks are **empty** |
| `text-usersettings.ndjson` | 39,946 | `settingSources` incl. `user`: hook messages, `commands_changed`, plugin agents |
| `multi-turn.ndjson` | 32,912 | 2 user messages in one streaming session (2x `init`, 2x `result`) |
| `resume.ndjson` | 13,143 | New `query` with `resume` of `multi-turn`'s session (same `session_id`) |
| `fork.ndjson` | 10,589 | `resume` + `forkSession` + `resumeSessionAt: <first assistant uuid>` + custom `sessionId` |
| `compact.ndjson` | 20,699 | Turn then `/compact`: `status compacting`, `compact_boundary`, synthetic summary user msg, replay user msg |
| `error.ndjson` | 8,130 | Invalid model: `assistant.error='model_not_found'`, `result` `is_error` (404), then iterator throw |
| `read.ndjson` | 27,827 | `Read` |
| `edit.ndjson` | 32,517 | `Edit` (acceptEdits): `structuredPatch` |
| `edit-parallel.ndjson` | 38,623 | Two parallel `Edit` calls in one assistant turn (stand-in for MultiEdit, which does not exist) |
| `write.ndjson` | 20,140 | `Write` create (`structuredPatch: []`) |
| `grep.ndjson` | 35,754 | `Grep` + `Glob` (enabled via `allowedTools`) |
| `bash-readonly.ndjson` | 27,555 | `Bash` auto-allowed (no `canUseTool`) |
| `bash.ndjson` | 29,617 | `Bash` needing permission: `addRules`/`localSettings` suggestions |
| `todowrite.ndjson` | 66,284 | `TodoWrite` (env `CLAUDE_CODE_ENABLE_TASKS=false`) incl. `ToolSearch` |
| `tasks-v2.ndjson` | 65,205 | Same prompt with default env: `TaskCreate`/`TaskUpdate` |
| `task.ndjson` | 54,027 | `Agent` subagent, default = background: async launch, 2 `result`s, `task_*` messages |
| `task-forward.ndjson` | 59,856 | Same with `forwardSubagentText: true` |
| `task-sync.ndjson` | 37,565 | Subagent with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`: synchronous, `tool_use_result.status:'completed'` |
| `permission-edit.ndjson` | 40,726 | Default mode, `Edit`: `canUseTool` with `setMode acceptEdits` suggestion |
| `permission-edit-noinput.ndjson` | 37,871 | Same, answered with `{behavior:'allow'}` only (no `updatedInput`) |
| `permission-always.ndjson` | 60,203 | "Always": `updatedPermissions` = suggestions; 2nd Edit not prompted; `status permissionMode:acceptEdits` |
| `permission-denied.ndjson` | 33,207 | Deny: `is_error` tool_result, `permission_denials` |
| `askuserquestion.ndjson` | 29,820 | `AskUserQuestion` multi-select, answered with 2 labels |
| `plan-exit.ndjson` | 91,622 | `permissionMode:'plan'` → plan file `Write` → `ExitPlanMode` (allow) → CLI returns to `default` → continues executing |
| `plan-exit-accept.ndjson` | 84,176 | Same, `setPermissionMode('acceptEdits')` called inside `canUseTool` |
| `interrupt.ndjson` | 15,776 | `interrupt()` 8 s into a running `Bash` (`ping`): `aborted_tools` |
| `interrupt-text.ndjson` | 65,635 | `interrupt()` during streaming (thinking deltas): `aborted_streaming` |
| `catalog-probe.json` | 131,613 | Probe-without-message (both variants) — models/commands/agents/account/init result, timings |
| `session-helpers-probe.json` | 56,053 | `listSessions` (incl. `includeProgrammatic:false` => 0), `getSessionInfo`, `getSessionMessages` (+system), `renameSession`, `forkSession`, `deleteSession`, `listSubagents`/`getSubagentMessages` |
| `history-<name>.json` ×15 | 3.7–19.9 KB | `getSessionMessages(id,{dir, includeSystemMessages:true})` dumps for: `multi-turn` (includes the `resume` turn, same session), `edit`, `task`, `task-sync`, `compact`, `askuserquestion`, `thinking`, `todowrite`, `grep`, `bash`, `interrupt`, `permission-denied`, `edit-parallel`, `write`, `read` |

Total ≈ 1.6 MB. Not recorded: `MultiEdit` (tool absent in this CLI; see `edit-parallel`), `tool_progress`, `api_retry`, auth-error (cannot be provoked without logging out).

Re-record: `cd packages/vscode && bash scripts/record-all.sh` (~3.5 min, ~30 short Haiku sessions). Single scenario: `bun scripts/record-fixture.ts --name <n> --prompt "..." [--mode plan] [--model m] [--resume <fixture>] [--fork --resume-at first-assistant] [--interrupt-after-ms N] [--deny Tool] [--always] [--exit-plan-mode acceptEdits] [--allowed-tools A,B] [--env K=V] [--thinking default|disabled|adaptive[:omitted]|enabled:N] [--setting-sources user,project,local|none] [--forward-subagent-text]`; history: `--history <fixture>`. Probes: `bun scripts/probe-catalog.ts`, `bun scripts/probe-sessions.ts`. Scripts and sandbox helpers: `scripts/{record-fixture.ts, record-all.sh, probe-catalog.ts, probe-sessions.ts, _common.ts}`.

## 7. Open items / handoff to W2–W3

* Decide TodoWrite-vs-TaskCreate (3.2) and background-vs-sync subagents (3.3) — both are one-line env changes in `env.ts` if the planned mapper semantics are kept (`CLAUDE_CODE_ENABLE_TASKS=false`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`). Caveat: these are undocumented CLI env vars; verify again when bumping the pinned SDK.
* Pass `thinking: {type:'adaptive', display:'summarized'}`; pass `permissionMode` explicitly; add `Grep,Glob` to `allowedTools` only if the legacy renderers are wanted.
* Use `initializationResult()` for the catalog probe; `deleteSession`/`forkSession`/`getSessionInfo` helpers instead of hand-rolled unlink/fork; never `includeProgrammatic:false`.
* "Always" semantics (2.2): `setMode` (session) for edits, `addRules` → `localSettings` (persistent file) for Bash; hide "Always" when `suggestions` is empty/absent.
* Mapper must tolerate `command_lifecycle`, `system/thinking_tokens`, multiple `result`s per user message, `result` after interrupt (`error_during_execution`), `tool_use_result` being a string, and per-block `assistant` messages arriving before block stop events.
* History replay has no `tool_use_result`; diffs must be synthesized from tool inputs. `getSessionMessages` user entries keep our supplied uuids.
* VSIX is ~110 MB/platform; W7 should script a platform matrix and consider trimming the SDK copy.
* Temporary artifacts to remove with W3: `src/claude/devHello.ts`, the `claudekei.dev.hello` command/activation event/registration in `extension.ts`, `scripts/prove-electron-hello.cjs`, the second esbuild entry for `devHello`.
* Side effects of this spike outside the repo: ~90 small JSONL sessions in `~/.claude/projects/-private-tmp-claude-501--Users-kei-Projects-claudekei-extension-a3f52df8-2dd5-4163-80a6-cde5dd3922c2-scratchpad-fixture-sandbox/` (safe to delete the directory); plan-mode runs wrote six `~/.claude/plans/plan-how-to-append-*.md` files, which were deleted afterwards.
* Concurrent work note: at the end of this spike `tsc -p tsconfig.webview.json` failed only because another work package's `webview/main.tsx` imports `@openchamber/ui/lib/claude/mockRuntime`, which does not exist yet; `tsc -p tsconfig.json` (the extension host) passes.
