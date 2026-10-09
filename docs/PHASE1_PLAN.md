# ClaudeKei — Architecture & Phase 1 Plan

> **Amendments (supersede the sections below where they conflict).** See also `docs/W0_SPIKE_NOTES.md`.
>
> **A1 — Main agent = claudekei plugin primary agents (replaces D8).** User decision: the UI is a companion to the `claudekei` Claude Code plugin (source `/Users/kei/Projects/claudekei`, installed via `enabledPlugins: claudekei@claudekei`). Shift+Tab cycles the session's **main-thread agent** among the plugin's primary agents, like OpenKei's primary-agent cycling.
> - Primary agents = catalog agents (`initializationResult().agents` / `system/init.agents`, run with user settings loaded) whose `description` contains `primary agent` (the plugin marks them "(claudekei primary agent)"). Fallback order/metadata table (overridable via `claudekei.primaryAgents` setting): `claudekei:orchestrator` "Orchestrator" purple · `claudekei:planner` "Planner" blue · `claudekei:sprinter` "Sprinter" green · `claudekei:business-analyst` "Business Analyst" orange. All other agents → `Agent{mode:'subagent'}` (for @agent mentions).
> - Default agent for a new session = effective `agent` setting, resolved by the host with precedence `<cwd>/.claude/settings.local.json` → `<cwd>/.claude/settings.json` → `~/.claude/settings.json` (currently `claudekei:orchestrator`). Unprefixed names (e.g. plugin-root `"orchestrator"`) are normalized to `claudekei:<name>` if such an agent exists.
> - Spawn with `Options.agent = <selected agent>`. Switching agent on a session: store the new agent per session; on the next send, if the live Query was spawned with a different agent → `close()` and respawn with `resume: id` + new `agent` (robust; ~1 s). Do not rely on `applyFlagSettings({agent})` (unverified). Persist per-session agent in `workspaceState`; `UserMessage.agent` = agent name.
> - **Permission mode becomes a separate control** (dropdown in the composer: default / acceptEdits / plan; command `claudekei.cyclePermissionMode` without default keybinding). ExitPlanMode handling unchanged.
> - Protocol: add `claude:session.setAgent {sessionId, agent}`; bootstrap/catalog carry `primaryAgents: {name, displayName, color, description}[]` and `defaults.agent`.
>
> **A2 — Load full user config.** `settingSources: ['user','project','local']` always (plugin, hooks, MCP, agents from `~/.claude`). Consequences for the host:
> - Plugin hooks run `node` → the spawned env must have a login-shell PATH (VS Code launched from Dock lacks nvm PATH): resolve once via `$SHELL -ilc 'printf %s "$PATH"'` (timeout 3 s, cached) and merge into `env.PATH`.
> - `UserPromptSubmit` hooks may return `decision: block` (e.g. `/claudekei:agent`): verify how it surfaces in the SDK stream and render the reason as an assistant/system notice.
> - Run env (from W0): `CLAUDE_CODE_ENABLE_TASKS=false` (+ allow `TodoWrite`), `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, explicit `permissionMode`, `thinking: {type:'adaptive', display:'summarized'}`, env = `{...process.env, PATH: loginPath}` minus `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` (unless `claudekei.useApiKey`).

Source of truth for the OpenKei → ClaudeKei migration (OpenCode backend → Claude Agent SDK).
Paths: `UI` = `packages/ui/src`, `VS` = `packages/vscode`.

User decisions: Claude-native sync layer (no OpenCode API emulation) · auth via local `claude login` (personal use only, do not distribute) · phased delivery · only `ui` + `vscode` packages.

## 0. Key decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Extension host owns all Claude state.** `ClaudeSessionManager` → one `ClaudeSession` per session id. Webviews are subscribers. | `canUseTool` + `Query` live in Node; sidebar / editor tab / Agent Manager become extra subscribers; webview reload = snapshot. |
| D2 | **One pure mapper** (`VS/src/claude/mapper.ts`) converts live `SDKMessage`s **and** JSONL history into domain events. | Single code path, unit-testable against recorded fixtures. |
| D3 | **Local types module** `UI/lib/claude/types.ts` replaces `@opencode-ai/sdk`. Parts keep field names the components read (`type: text/reasoning/tool/file`, `tool`, `state.{status,input,output,error,metadata,time}`). | Avoids rewriting ToolPart/ProgressiveGroup/changedFiles/ToolOutputDialog renderers. |
| D4 | **Tool names/inputs normalized in the mapper** (`Edit`→`edit` with `filePath/oldString/newString` …); raw `{name,input}` kept on the part. | Existing renderers work unchanged. |
| D5 | **Keep `event-reducer.ts` and its event names** as our internal vocabulary. | Perf-critical, generic. |
| D6 | **Host generates monotonically ascending ids** for messages/parts (`<ms timestamp><4-digit seq>`); Claude `uuid` kept as `claudeUuid`. | Reducer uses `Binary.search` by id; Claude ids aren't chronological. |
| D7 | Requests reuse the existing bridge (ids, ack/retry). **Push = `{type:'claude:events', seq, events[]}` batches**, per-webview `seq`; gap → snapshot reload. No ack/retry on events. | |
| D8 | **"Primary agents" become permission modes** `default`/`acceptEdits`/`plan` as `Agent{mode:'primary'}`; Claude subagents as `Agent{mode:'subagent'}`. | Shift+Tab cycling, AgentSelector, @agent mentions keep working. |
| D9 | **No optimistic layer.** Host emits the user message within ~1 ms of send. | Delete `optimistic.ts`. |

## 1. Architecture & Query lifecycle

```
Webview (React UI) ──bridge req (claude:*)──▶ ChatViewProvider ─▶ bridge.ts ─▶ bridge-claude-runtime.ts
       ▲                                                                       │
       └──── {type:'claude:events', seq, events[]} ◀── Broadcaster ◀── ClaudeSessionManager
                                                                     ├─ ClaudeSession (per id)
                                                                     │   ├─ AsyncQueue<SDKUserMessage>
                                                                     │   ├─ Query = query({prompt: queue, options})
                                                                     │   ├─ mapper state + in-memory SessionState
                                                                     │   └─ pending permissions/questions (resolvers)
                                                                     └─ Catalog (models/commands/agents/account)
```

States: `draft → cold → starting → live-idle ⇄ live-busy → closing → cold`.

- **create**: host makes `randomUUID()` and returns a draft `Session`. Nothing spawned.
- **First send**: spawn `query()` in streaming-input mode; prompt = session `AsyncQueue`. Options: `cwd` = workspace folder; `sessionId: id` (no transcript yet) else `resume: id`; `model`/`permissionMode` from prefs; `canUseTool`; `includePartialMessages: true`; `settingSources: ['user','project','local']`; `systemPrompt: {type:'preset', preset:'claude_code'}`; `enableFileCheckpointing: true`; `abortController`; sanitized `env` (§8); `stderr` → OutputChannel; optional `pathToClaudeCodeExecutable`.
- **Send while busy**: push onto the queue; UI shows the user message immediately.
- **Pump**: `for await (m of query)` → `mapper.apply(m)` → apply to host `SessionState` → broadcast. On end/throw: deny pending permissions/questions, mark running tools `error: "Session ended"`, status idle, `session.error` if unexpected, → `cold`.
- **Idle shutdown**: `close()` 10 min after last `result` if nothing pending (`claudekei.idleTimeoutMinutes`).
- **Concurrency**: max `claudekei.maxLiveSessions` (default 3) live processes; evict LRU *idle*; never kill busy.
- **Model/mode**: `setModel()`/`setPermissionMode()` if live, else stored for next spawn. Per-session `{model, mode}` in `workspaceState`.
- **Across reloads**: only JSONL persists. List = `listSessions({dir: cwd})`; open = `getSessionMessages`. Unsent drafts are lost.
- **Webview reload**: `claude:bootstrap` + `claude:session.load` return snapshots incl. pending permissions.
- **Catalog probe** at activation: throwaway streaming query, call `supportedModels()`, `supportedCommands()`, `supportedAgents()`, `accountInfo()`, then `close()`. Cache in `globalState`. Refresh on every `system/init`. Fallback static models `default/opus/sonnet/haiku`. **Verify in W0** that init completes without a user message.

## 2. Domain model (`UI/lib/claude/types.ts`)

```ts
type Session = { id: string; title: string; directory: string; parentID?: string /* virtual subagent child */;
  time: { created: number; updated: number }; claude?: { gitBranch?: string; fileSize?: number } }
type SessionStatus = { type: 'idle' } | { type: 'busy' } | { type: 'retry'; attempt: number; message: string; next: number }
type UserMessage = { id; sessionID; role: 'user'; time: { created }; claudeUuid?: string; agent?: PermissionMode; model?: { providerID: 'anthropic'; modelID } }
type AssistantMessage = { id; sessionID; role: 'assistant'; parentID: string; time: { created; completed? };
  modelID; providerID: 'anthropic'; finish?: string; error?: { name; message };
  tokens?: { input; output; reasoning; cache: { read; write } }; cost?: number; claudeUuid?: string; apiMessageId?: string }
type TextPart      = { id; sessionID; messageID; type: 'text'; text: string; synthetic?: boolean; time?: { start; end? } }
type ReasoningPart = { id; sessionID; messageID; type: 'reasoning'; text: string; time?: {...} }
type FilePart      = { id; sessionID; messageID; type: 'file'; mime; filename; url }
type ToolState =
  | { status: 'pending';   input: {}; raw: string }
  | { status: 'running';   input; title?; metadata?; time: { start } }
  | { status: 'completed'; input; output: string; title?; metadata; time: { start; end } }
  | { status: 'error';     input; error: string; metadata?; time: { start; end } }
type ToolPart = { id; sessionID; messageID; type: 'tool'; tool: string; callID: string; state: ToolState; claude: { name: string; input: unknown } }
type Todo = { id; content; status: 'pending'|'in_progress'|'completed'; priority: 'medium'; activeForm? }
type PermissionRequest = { id; sessionID; permission: string; patterns: string[]; metadata: Record<string, unknown>; always: string[]; tool?: { messageID; callID } }
type QuestionRequest = { id; sessionID; questions: Array<{ question; header; options: {label; description}[]; multiple: boolean }>; tool?: {...} }
```
Plus `ModelInfo`, `SlashCommand`, `AgentInfo` (SDK shapes); synthetic `Provider {id:'anthropic', models}`; `Agent {name, mode, description}`.

### SDK → domain mapping

Routing: `parent_tool_use_id == null` → session; else → virtual child session `sub_<parentToolUseId>`.

| SDK input | Domain effect |
|---|---|
| `system/init` | record model/tools/permissionMode/slash_commands → `catalog.updated`; assert `session_id === id` |
| `stream_event message_start` | new AssistantMessage (ascending id, `apiMessageId`, `parentID` = last user msg) → `message.updated` |
| `content_block_start` text/thinking | empty text/reasoning part → `message.part.updated` |
| `content_block_start` tool_use | ToolPart `pending`, `callID` = block id, `tool = normalize(name)` |
| `text_delta` / `thinking_delta` | `message.part.delta {field:'text'}` (coalesced 16 ms in host) |
| `input_json_delta` | accumulate in host only |
| `content_block_stop` (tool) | parse JSON → `running` with normalized input + `time.start`; TodoWrite → also `todo.updated`; Task/Agent → also `session.created` child `sub_<id>` (`parentID`, title = description) and `metadata.sessionID = child` |
| `message_delta` | `finish = stop_reason`, tokens from usage |
| full `assistant` | idempotent reconcile: tool_use by block id; text/thinking by ordinal of block type within `apiMessageId`; upsert final content (covers stream gaps + history) |
| `user` with `tool_result` | tool part → `completed` / `error` (`is_error`), `output` = joined text; images → `metadata.attachments`; metadata from `tool_use_result`; Task result → child idle |
| `user` prompt echo | ignored live (host already emitted); history replay creates UserMessage |
| `result` | last assistant `time.completed`, `cost`, `tokens`; status idle; `error_*` → `session.error`; auth-ish → `session.error{kind:'auth'}` |
| `api_retry` / `rate_limit_event` | `session.status {type:'retry'}` |
| `compact_boundary` | synthetic assistant text "Context compacted" |
| `permission_denied` | tool part → `error: "Permission denied"` |
| `tool_progress` | `metadata.elapsed` (1 Hz) |
| `task_*`, unknown | log to OutputChannel; no-op |

**Tool normalization** (`claude/toolNormalize.ts`): Bash→`bash` · BashOutput/KillShell→generic · Read→`read` (`file_path`→`filePath`, offset, limit) · Write→`write` · Edit→`edit` (filePath, oldString, newString, replaceAll) · MultiEdit→`multiedit` · Grep→`grep` · Glob→`glob` · LS→`list` · WebFetch→`webfetch` · WebSearch→`websearch` · TodoWrite→`todowrite` · Task/Agent→`task` (keeps `subagent_type`) · AskUserQuestion→`question` · ExitPlanMode→`plan_exit` · Skill→`skill` · NotebookEdit, `mcp__*`→unchanged/generic.

**Diffs**: `tool_use_result.structuredPatch` → unified patch → `metadata.diff` + `metadata.filediff = {file, additions, deletions, patch}` (what `UI/components/chat/changedFiles.ts:74` and `DiffPreview` read). Fallback: synthesize from `oldString/newString`/`content` with `diff` package. MultiEdit → `metadata.files[]`.

**History** (`claude/history.ts`): `getSessionMessages(id, {dir})` → same mapper in replay mode. Phase 1: truncate tool outputs > 100 KB (`metadata.truncated`); subagent sidechains not loaded (child shows Task result only); no paging.

**Session list**: `listSessions({dir})` → `title = customTitle ?? summary ?? firstPrompt ?? 'New session'`, `time.updated = lastModified`.

## 3. Extension ↔ webview protocol (`UI/lib/claude/protocol.ts`, host imports types only)

| Request | Payload → Response |
|---|---|
| `claude:bootstrap` | `{}` → `{cwd, account, catalog:{models, commands, agents, defaults:{model, mode}}, sessions, live: Record<id,{status, permissions, questions}>, eventSeq}` |
| `claude:session.list` | `{limit?}` → `Session[]` |
| `claude:session.create` | `{title?}` → `Session` |
| `claude:session.load` | `{sessionId}` → `{session, messages, parts: Record<msgId, Part[]>, status, permissions, questions, todos, children}` |
| `claude:session.send` | `{sessionId, text, files?: {mime, filename, dataUrl}[], command?: {name, args}, model?, mode?}` → `{messageId}` (immediate) |
| `claude:session.interrupt` | `{sessionId}` |
| `claude:session.fork` | `{sessionId, atMessageId?}` → `Session` (draft; first send uses `resume` + `forkSession: true` + `resumeSessionAt: claudeUuid` — **verify names in W0**) |
| `claude:session.delete` | `{sessionId}` — close live query, unlink `<id>.jsonl` + `<id>/` |
| `claude:session.rename` | `{sessionId, title}` → `renameSession` |
| `claude:session.setModel` / `setMode` | `{sessionId, model}` / `{sessionId, mode}` |
| `claude:permission.respond` | `{sessionId, requestId, response: 'once'|'always'|'reject'}` |
| `claude:question.respond` | `{sessionId, requestId, answers: string[][]} | {reject: true}` |
| `claude:catalog.refresh` | → catalog |

Push events in `claude:events`: `session.created/updated/deleted/status/error`, `message.updated/removed`, `message.part.updated/delta`, `permission.asked/replied`, `question.asked/replied/rejected`, `todo.updated`, `catalog.updated`, `account.updated`. `connectionStatus` kept (= SDK ready / auth error).

**Permissions** (`claude/permissions.ts`), by `canUseTool` toolName:
- **AskUserQuestion** → `question.asked` (`multiSelect`→`multiple`). Reply → `{behavior:'allow', updatedInput:{...input, answers:{[question]: labels.join(', ')}}}`; reject → deny.
- **ExitPlanMode** → `permission.asked{permission:'plan_exit', metadata:{plan}}`. `always` → `setPermissionMode('acceptEdits')` + allow; `once` → `setPermissionMode('default')` + allow; `reject` → deny "Keep planning".
- **Others** → `permission.asked` with normalized `permission`, `patterns` = [command or cwd-relative path], `metadata = {input, command, filepath, diff, suggestions}`, `always` = readable summaries of `suggestions`. `once` → allow unchanged; `always` → allow + `updatedPermissions: suggestions`; `reject` → deny "User rejected".
- Subagent permissions surface on the **parent** session. `signal` abort → resolve + `permission.replied`.

## 4. UI changes

**Types codemod (W4)**: rewrite all `@opencode-ai/sdk/v2` and `/v2/client` imports (~80 lines, ~75 files) to `@/lib/claude/types`; remove `@opencode-ai/sdk` from `packages/ui/package.json`; legacy-only types (`Config`, `LspStatus`, `VcsInfo`, `Project`, `Path`, `ProviderAuthResponse`, `PermissionConfig`, `Command`, `McpStatus`, `Event`) get `/** @deprecated legacy shape */` stand-ins.

**Transport**: new `UI/lib/claude/client.ts` (`claudeClient`) replaces `UI/lib/opencode/client.ts` (delete), backed by new `RuntimeAPIs.claude` (in `UI/lib/api/types.ts`). Rewrite `getSdkClient`/`getScopedSdkClient` callers: `App.tsx:819/864/881/905`, `ChatInput.tsx:1683`, `ToolPart.tsx:2233/2373`, `useGlobalSessionsStore.ts:209`, `useSessionAutoCleanup.ts:155`, `gitApi.ts:376`, `useAgentGroupsStore.ts:228`, `useMcpStore.ts:37`, `DirectoryTree.tsx:400`.

**`UI/sync/`**

| File | Action |
|---|---|
| `event-pipeline.ts` | **Replace** with `claude-event-source.ts` (~100 lines): subscribe to `claude:events`, check `seq` → snapshot reload on gap, feed existing flush handler. |
| `event-reducer.ts` | **Keep**; swap imports; drop global/vcs/lsp cases + optimistic-replace branch; extend `message.updated` unchanged-check (:236-238) to include `tokens`/`cost`/`error`; `trimSessions` evicts by `time.updated`. |
| `bootstrap.ts` | **Rewrite** on `claude:bootstrap` (agent = modes + subagents, command = slash commands, provider = synthetic anthropic). |
| `sync-context.tsx` | **Rewrite `SyncProvider` internals**, drop `sdk` prop; **keep all exported hook signatures**; keep `ChildStoreManager`. |
| `session-actions.ts` | **Rewrite** on `claudeClient` (create/delete/rename/fork/abort/permission/question); remove share/unshare/archive. |
| `submit.ts` | **Rewrite**: `claudeClient.send`, no optimistic; command as `{name, args}`. |
| `session-ui-store.ts` | **Edit**: new submit; share/unshare/revert/undo/redo → "Phase 2" toast stubs; `forkFromMessage` → `claude:session.fork`. |
| `use-sync.ts` | **Edit**: drop optimistic + SDK paging; load = snapshot. |
| `optimistic.ts`, `revert-plan.ts`(+test), `reconnect-recovery.ts`(+test), `session-delete.test.ts` | **Delete** |
| `session-actions.test.ts`, `__tests__/event-reducer.test.js`, `__tests__/event-pipeline.*` | Rewrite or delete |
| `binary.ts`, `child-store.ts`, `live-aggregate.ts`, `streaming.ts`, `viewport-store.ts`, `input-store.ts`, `selection-store.ts`, `notification-store.ts`, `voice-store.ts`, `session-cache.ts`, `sanitize.ts`, `debug.ts` | Keep (imports only) |
| `session-worktree-*`, `persist-cache.ts`, `session-prefetch-cache.ts` | Keep compiling; worktree UI hidden |

**Stores**: `useConfigStore` (single provider `anthropic`, agents = modes, drop `checkHealth`/`initApp`) · `useAgentsStore` (catalog; CRUD Phase 2) · `useCommandsStore` (`catalog.commands` + client-only `/clear`; hide `/undo` `/redo` `/share`) · `permissionStore` (from snapshot; drop polling) · `useGlobalSessionsStore` + `globalSessions.ts` (`claudeClient.listSessions`, archived = []) · `useFileSearchStore` (bridge fs search, `VS/src/bridge-fs-helpers-runtime.ts`) · `useDirectoryStore`/`useProjectsStore` (fixed to workspace) · `useMcpStore` (read-only or hidden) · `useMultiRunStore`, `useAgentGroupsStore`, `useSkills*`, `useMcpConfigStore` → stub + hide.

**Components to edit**: `ChatInput.tsx` (send path, mode cycling, label "Agent"→"Mode", hide variants, :1683) · `ModelControls.tsx`, `UnifiedControlsDrawer.tsx`, `MobileSessionStatusBar.tsx` (single provider) · `PermissionCard.tsx` (`plan_exit` / route to `PlanCard.tsx`, `always` summaries) · `ToolPart.tsx` (:2233/:2373 only) · `SessionSidebar.tsx` + `sidebar/hooks/useSessionActions.ts` (drop share/archive/worktree) · `layout/Header.tsx` (drop OpenCode status/quota) · `App.tsx` (SyncProvider props, gating) · `sections/*` (hide providers, agents CRUD, MCP, skills, plugins, quota, Zen, opencode-resolution, TTS, GitHub).

**Untouched**: `MessageList`, `ChatContainer`, `ChatMessage`, `lib/turns/*`, `ProgressiveGroup`, `toolRenderers.tsx`, `ToolOutputDialog`, `DiffPreview`, `changedFiles.ts`, `ReasoningPart`, `AssistantTextPart`, `UserTextPart`, `StatusRow`, `QuestionCard`, `FileMentionAutocomplete`/`CommandAutocomplete` (data sources only), Markdown/Shiki/theme.

## 5. Extension host changes

| Action | Files |
|---|---|
| **Delete** | `src/opencode.ts`, `opencode-ready.ts`, `opencodeAuth.ts`, `sseProxy.ts`, `sessionActivityWatcher.ts`, `quotaProviders.ts`, `bridge-proxy-runtime.ts`, `githubAuth.ts`, `githubIssues.ts`, `githubPr.ts`, `githubPulls.ts`. `opencodeConfig.ts`, `skillsCatalog.ts` → Phase 2 (`claudeConfig.ts` for `.claude/*`). |
| **New** | `src/claude/{ClaudeSessionManager, ClaudeSession, mapper, toolNormalize, diff, history, permissions, catalog, broadcaster, asyncQueue, ids, env}.ts`, `src/bridge-claude-runtime.ts` |
| **Rewrite** | `extension.ts` (manager; `restartApi`→`claudekei.restartSessions`; `showOpenCodeStatus`→`showClaudeStatus`; `cyclePrimaryAgent`→`cyclePermissionMode`, shift+tab when webview focused) · `ChatViewProvider.ts` (remove SSE :91-101, :327-413; register with Broadcaster; `connectionStatus` from manager) |
| **Edit** | `bridge.ts` (Claude runtime first, drop proxy runtime) · `bridge-config-runtime.ts` (stub agents/commands/mcp/skills) · `bridge-system-runtime.ts` (drop quota/Zen/provider-auth/session-activity) · `bridge-settings-runtime.ts` (drop `fetchOpenCodeSkillsFromApi`) · `bridge-localfs-proxy-runtime.ts` (keep `/api/fs/read`/`raw`) · `webviewHtml.ts` |
| **Keep** | `bridge-fs-*`, `bridge-git-*`, `gitService.ts`, `theme.ts`, `shikiThemes.ts`, `webviewDevServer.ts`; `AgentManagerPanelProvider.ts`, `SessionEditorPanelProvider.ts` compile only (wire Phase 2) |
| **Webview** | `webview/main.tsx`: delete OpenCode SSE/proxy (:1045-1142, :402-403); keep local `/api/*` (fs, settings, files, magic prompts); unknown `/api/*` → 501 + `console.warn`; loading overlay waits on `claude:bootstrap`. New `webview/api/claude.ts` implements `RuntimeAPIs.claude`. |

## 6. Phase 1 feature mapping

| OpenKei feature | Claude implementation | Notes |
|---|---|---|
| Streaming text / reasoning | `stream_event` → `message.part.delta` | 16 ms coalescing |
| Tool rendering | normalized ToolParts | existing renderers |
| TodoWrite | `todo.updated` + `todowrite` part | `StatusRow` unchanged |
| Subagents | virtual child `sub_<toolUseId>` | history shows result only |
| Permissions | `canUseTool` → `permission.asked` | `always` = SDK suggestions |
| Questions | AskUserQuestion via `canUseTool` | `QuestionCard` unchanged |
| Plan mode | `permissionMode:'plan'` + ExitPlanMode card | |
| Shift+Tab | modes as primary agents | default → acceptEdits → plan |
| Model picker | `supportedModels()` | single provider, no variants |
| Sessions | `listSessions` / draft UUID / `resume` / `renameSession` / unlink / `forkSession` | archive hidden |
| Diff view | `structuredPatch` → `metadata.diff`/`filediff` | synthetic fallback |
| @file mentions | keep `@path` in prompt | |
| Selection context | fenced block `path:Lstart-end` | |
| Attachments/images | `image` / `document` base64 blocks | text files inlined |
| Slash commands | `supportedCommands()` → `/name args` prompt | `/clear` client-side |
| Abort | `query.interrupt()` | running tools → error |
| Context usage | assistant `tokens` + static limit table | `getContextUsage()` Phase 2 |
| **Hidden/stubbed** | share, archive, undo/redo/revert, worktrees, multi-run, Agent Manager, provider/quota/Zen, MCP/skills/agents settings, TTS/voice, GitHub, LSP, variants | |

## 7. Phase 1 work packages

| WP | Owner | Scope | Depends | Acceptance |
|---|---|---|---|---|
| **W0 Spike** | Backend | Install `@anthropic-ai/claude-agent-sdk` in `packages/vscode`; verify against `sdk.d.ts`: `canUseTool` signature, `sessionId`/`resume`/`forkSession`/`resumeSessionAt`, `listSessions`/`getSessionMessages`/`renameSession`, `SDKUserMessage` shape/uuid, `tool_use_result`; probe-without-message; VSIX spawns from Extension Development Host with `claude login`. Record NDJSON fixtures: text, thinking, Edit, MultiEdit, Write, Bash, Read, Grep, TodoWrite, Task, AskUserQuestion, permission prompt, ExitPlanMode, interrupt, error, compact. | — | API-diff notes; `fixtures/*.ndjson`; VSIX runs a "hello" turn |
| **W1 Contracts** | Shared | `UI/lib/claude/types.ts`, `protocol.ts`, normalization table | — | both packages compile against them |
| **W2 Mapper** | Backend | `mapper.ts`, `toolNormalize.ts`, `diff.ts`, `history.ts` + golden tests | W0, W1 | all fixtures map; ids ascending; live ≡ replay final state |
| **W3 Session host** | Backend | manager, lifecycle, queue, permissions, catalog, broadcaster, `bridge-claude-runtime.ts`, `extension.ts`/`ChatViewProvider.ts` rewiring, delete OpenCode files; dev cmd `claudekei.dev.replayFixture` | W1 (W2 to integrate) | no `opencode` symbols; idle close/cap/interrupt; pending permission survives webview reload |
| **W4 Type codemod** | Frontend | import rewrite, remove SDK dep, stand-ins, `claudeClient` skeleton | W1 | `tsc` passes for `packages/ui` |
| **W5 Sync rewrite** | Frontend | §4 sync table, `RuntimeAPIs.claude`, `webview/api/claude.ts`, `main.tsx` cleanup; develop against a fixture-replay mock runtime | W4 (W3 for e2e) | fixture replay renders like OpenKei; reducer tests pass |
| **W6 Stores & components** | Frontend | config/agents/commands/models/modes, ChatInput, Permission/Question/Plan cards, sidebar, hide dropped features | W5 | smoke checklist |
| **W7 Integration & packaging** | Both | e2e in Extension Development Host, platform VSIX, OutputChannel diagnostics | W3, W6 | smoke checklist on packaged VSIX |

Parallelism: W0 ∥ W1 → backend W2 → W3 ∥ frontend W4 → W5 → W6 → W7.

**Smoke checklist**
1. New session → streamed reply with thinking
2. Edit → permission card → "Always" → second edit not prompted → diff + changed files
3. Bash + interrupt mid-run
4. TodoWrite live updates
5. Task subagent → open child session
6. AskUserQuestion multi-select
7. Shift+Tab to plan → ExitPlanMode card → approve with auto-accept
8. Model switch mid-session
9. `/compact` and a custom `.claude/commands` command
10. Image paste + @file mention
11. Reload Window → list → resume → continue
12. Fork + rename; delete removes JSONL
13. 4 concurrent sessions → cap closes idle
14. Logged-out state shows "Run `claude login`" CTA

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| SDK is ESM, resolves executable via `import.meta.url`, platform binaries; esbuild→CJS breaks it | Mark SDK `external`, dynamic `import()`, ship in VSIX `node_modules` (drop `--no-dependencies`), `vsce package --target darwin-arm64`, `claudekei.claudeExecutablePath` setting + `which claude` fallback. Prove in W0. |
| Electron/Node PATH (Dock-launched VS Code lacks nvm PATH) | Prefer native binary; else `executable: process.execPath` + `ELECTRON_RUN_AS_NODE=1`; diagnostics in `showClaudeStatus`. |
| Auth: stray `ANTHROPIC_API_KEY` overrides subscription | `env.ts` strips `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` unless `claudekei.useApiKey`; show `accountInfo()`; auth errors → "Run `claude login`" action. **Policy: personal use only, do not distribute.** |
| SDK 0.x / JSONL format drift | Use `getSessionMessages`, never raw JSONL; tolerant mapper; fixture golden tests; pin SDK version exactly. |
| Text-block ordinal mis-pairing | Tools pair by id; text/thinking fallback = append new part; fixtures cover interleaved thinking. |
| Probe query side effects | close immediately; delete/filter any transcript it writes; cache catalog. |
| Memory / process count | live cap, idle close, close all on deactivate. |
| No delete API | unlink `<id>.jsonl` + `<id>/` after `close()`, confirm modal. |
| Subagent history hidden in Phase 1 | accepted; Phase 2 lazy sidechain load. |
| UUID session ids vs sorted-by-id reducer | session arrays sorted by id for `Binary.search`; display/trim by `time.updated`; messages/parts use host ascending ids. |

**Biggest unknowns for W0**: VSIX/executable spawn path · probe-without-message handshake · exact fork/resume-at option names.
