# Phase 1.1 investigation: agent switching and SendMessage subagents

Experiments only, no product code changed (the recorder `scripts/record-fixture.ts` gained flags `--agent`, `--agents-json`, `--out-dir`, `--no-snapshot`). Model: haiku 5.5 everywhere, CLI 2.1.295, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` unless stated. Fixtures: `packages/vscode/src/claude/__fixtures__/subagents/` (17 files, 0.9 MB, outside the golden-test glob). All sessions created here (7) and the plugin state files they produced were deleted afterwards. About 25 short haiku turns in total.

Plugin source: the path in the brief does not exist; the installed copy is `~/.claude/plugins/cache/claudekei/claudekei/0.5.0/hooks/lib/{handlers,sessions}.mjs` (same files as `/Users/kei/Projects/claudekei-plugin`).

## Q1. Does `resume` + a different `Options.agent` really switch the main agent?

**Short answer: tools and hook identity switch for real; the system prompt does NOT, unless `systemPrompt.snapshot: false` is passed.** With the default (what our host uses today) the resumed agent keeps the previous agent's instructions and only its tool set changes.

| Experiment | Result |
|---|---|
| `echo-a` ("reply A-ONLY", all tools) then `resume` as `echo-b` ("reply B-ONLY", `tools:['Read']`) | `system/init.tools` changes (29 tools -> `['Read']`); reply stays **A-ONLY**. A fresh `echo-b` session replies B-ONLY (control). |
| Same with `systemPrompt.snapshot:false` | tools = `['Read']`, reply still A-ONLY — but this test is polluted by the earlier A-ONLY turns in history (the model imitates them). |
| Disambiguating pair with a codename question (`quote-a` ALPHA-7 -> resume as `quote-b` BRAVO-9) | default snapshot: **ALPHA-7** (frozen prompt, B's tools). `snapshot:false`: **BRAVO-9** (prompt really switched). |
| JSONL | The first request records `attachment/prompt_snapshot` with the full `systemPrompt` (agent A's text) and the tool schemas; resume reuses it (SDK docs: "recorded once ... later `append`/`prompt` ignored"). **No agent name is stored anywhere** in the transcript (no `agent*` key, no `agent-setting` entry); `system/init` has no `agent` field either. |
| claudekei: `sprinter` then resume as `planner` (`snapshot:false`), ask it to delegate to `claudekei:frontend-developer` | init tools 29 -> 11 (planner's `tools:` frontmatter). PreToolUse hook **denies**: "planner may only delegate to: claudekei:explorer, ... Not allowed in planner mode" while plugin state `mode` was still `null`, i.e. the hook payload's `agent_type` followed the new `--agent` (`effectiveMode` falls back to `agent_type`). The deny arrives as an `is_error` tool_result: `PreToolUse:Agent hook error: <reason>`. |
| claudekei state override: `/claudekei:sprint` typed in the planner session, then the same delegation | The UserPromptSubmit hook writes `state.mode = "sprinter"` (file `~/.claude/plugins/data/claudekei-claudekei/sessions/<session_id>.json`), PreToolUse now **allows** it (`updatedInput` effort=high). So `state.mode` wins over `agent_type` inside the plugin's hooks. The Agent call still failed ("Agent type 'claudekei:frontend-developer' not found. Available: designer, explorer, librarian, oracle"): the SDK-level restriction from planner's `tools: Agent(...)` frontmatter follows the real agent, not the plugin state. |
| Model | `Options.model:'haiku'` kept the model after switching to `planner` (frontmatter `model: opus` did not override the explicit option). |

Conclusions and caveats:
1. A switch via `close()` + `resume` + new `agent` is a **real tool/permission/hook switch** but only a **prompt switch if `systemPrompt.snapshot:false`** is set on the respawn. Recommendation: always spawn with `snapshot:false` (or at least on respawn after an agent change); cost is one prompt-cache miss at the switch and then stable again.
2. History from the previous agent stays in context (and biases style, see the echo test). The UI should treat a switch as "new agent continues this conversation", not a fresh start.
3. The plugin's hook layer has **per-session state outside our control**: `mode` set by any earlier `/claudekei:orchestrate|plan|sprint|analyze` prompt overrides `agent_type` for reminders and delegation checks, and persists across respawns (file keyed by session id). A stale mode makes the plugin behave like the old agent even though our UI shows the new one. Mitigations: show a hint when a mode command was typed, or (hack) rewrite `mode` in that state file on a switch. Aliases (`children[]`) live in the same file.
4. The active agent is not observable from the stream or transcript; the host's per-session prefs are the only source of truth (already persisted in workspaceState; after losing them fall back to the settings default).
5. Not tested: `applyFlagSettings({agent})` on a live process (amendment A1 already says do not rely on it).

## Q2. SendMessage: stream and history

Fixtures: `q2-sendmessage-sync` (inline `lead` agent with Agent+SendMessage, sync env), `q2-sendmessage-async` (default CLI env), `q2-sendmessage-alias` (claudekei:sprinter -> `claudekei:explorer`, PreToolUse alias resolution), plus `history-q2-*.json` (main transcript + `listSubagents`/`getSubagentMessages`).

**SendMessage is deferred**: the main agent must first call `ToolSearch select:SendMessage` (shows up as a noisy ToolSearch row before every first use).

**Agent tool (turn 1)**
- `tool_use`: `{description, prompt, subagent_type}`. Sync: `task_started{task_id=<agentId>, tool_use_id=<Agent toolu>, prompt, is_backgrounded:false}` -> subagent messages with `parent_tool_use_id=<Agent toolu>` and `agent_id=<agentId>` -> `task_notification{task_id, tool_use_id, summary}` -> tool_result. The result text ends with `agentId: <id> (use SendMessage with to: ...)` (async launch text also has `agentId:`); `tool_use_result.agentId` is the structured copy (live only).

**SendMessage (turn 2), same agent**
- `tool_use.input` as the model emitted it: `{to, message, summary, type:'message', recipient, recipient_kind, content}`. `to` is the agentId (`recipient_kind:"agent"`) or, with the plugin, the alias (`"exp-1"`, `recipient_kind:"name"`). **A hook's `updatedInput` does not appear in the stream or transcript** (the tool_use block keeps the alias); it only shows up as `hook_response.output` when `includeHookEvents` is on (`"Resolved session alias exp-1 -> aedf2479dbcf2d6f5"`). The permission callback sees the updated input (not recorded here).
- `system/task_started` is emitted **again for the same `task_id` (= agentId)** with a new `run_id`, `tool_use_id = <SendMessage toolu>`, `prompt = <the sent message>`, `awaited:true`, `is_backgrounded:true` (even with background tasks disabled).
- The resumed subagent's `assistant`/`user` messages stream with `parent_tool_use_id = <ORIGINAL Agent toolu>` (never the SendMessage id) and `agent_id = <agentId>`. No `user` echo of the new instruction is emitted (the Agent turn did echo its prompt).
- `task_progress`/`task_notification` carry the SendMessage id as `tool_use_id` (`task_notification.summary` = the subagent's reply).
- Sync variant: tool_result arrives **after** the child's messages; content text = `{"success":true,"message":"Resumed agent. Its final report follows ..."}` + the usual hand-back frame; `tool_use_result = {success, message, inlineHandback:{displayName:<first 7 chars of agentId>, content}, pin:{id:<agentId>}}`. The text contains **no agentId**.
- Async variant (default env): tool_result arrives **before** the child works; text is `{"success":true,"message":"Resuming agent ac93bcd","resumedAgentId":"<full agentId>","pin":{...}}` (agentId is in the text, so it is in history). The turn's `result` fires before the child is done; the child's notification starts another turn (4 `result`s in the fixture).
- The first Agent call in async mode is the already-known "launched" shape (tool_result "Async agent launched ... agentId: X", completion via `task_notification`).

**History (`getSessionMessages` / `listSubagents` / `getSubagentMessages`)**
- One transcript per agentId, holding both the original run and every continuation, chronologically. Every entry has `parent_tool_use_id = <ORIGINAL Agent toolu>`; there is **no `agent_id` and no run id** on entries (`parent_agent_id` is null).
- The SendMessage text appears as a new user entry wrapped as `The coordinator sent a message while you were working:\n<message>\n\nAddress this before completing your current task.` (also in sync mode), followed by the subagent's new assistant/tool entries.
- The main transcript keeps the SendMessage tool_use exactly as emitted (alias, not agentId) and the result text above. So **alias -> agentId is not in the main transcript**; the sync result text has no id either.
- How a replay can resolve SendMessage -> agent: (a) `to` is a raw agentId; (b) async result JSON `resumedAgentId`; (c) otherwise match `input.message` against the wrapped user entries of each subagent transcript (unique text, in order); (d) optional: the plugin state file `children[{alias, agentId, agentType, description}]`. The agentId <-> Agent tool link needs no text parsing: `getSubagentMessages(agentId)` returns entries whose `parent_tool_use_id` is the Agent toolu.

What our mapper does today (run on the fixtures): the child session `sub_<Agent toolu>` correctly receives the continuation's assistant/tool messages (routing by `parent_tool_use_id` works), but there is **no user message for the new instruction**, the SendMessage part is a plain tool (`output` = the JSON/hand-back text, no link to the child), and `task_started`/`task_notification` for the SendMessage id are ignored. That matches the user's report.

## Q3. Proposal: one child session per agentId

**Id scheme: keep `sub_<ORIGINAL Agent tool_use_id>`; add an `agentId -> child` registry.** Reasons: the live content stream and history both carry that id on every subagent message (`parent_tool_use_id`) while the agentId is only known from `task_started`/`agent_id` (live) or from a text trailer / `listSubagents` (history); keeping the id avoids renaming a session after it was created and keeps live and replay ids identical. "One child per agentId" holds through the registry. (If `sub_<agentId>` is preferred, create the child at `task_started` instead of at the Agent tool_use and use `agent_id` for routing; history then needs the `listSubagents` pairing before replaying main — feasible but more moving parts.)

**Mapper (live)**
1. `agents: Map<agentId, {childId, agentType, description, ownerToolUseId, activeRunId?}>`. Fill it on `task_started` whose `tool_use_id` is an Agent/Task tool (task_id = agentId) and, defensively, from `agent_id` + `parent_tool_use_id` on any subagent message.
2. Give SendMessage its own normalized tool name (`sendmessage`, add to `toolNames.ts`) and input `{to, recipient, message, summary}`; hide `ToolSearch select:SendMessage` rows.
3. On `task_started` with `tool_use_id` = a SendMessage ref: resolve `agents.get(task_id)`; set the SendMessage part `metadata = {sessionID: childId, agentId, agentType, recipient: input.to (alias or id), message}` and emit `part.updated`; **create a user message in the child with `prompt`** (this is the instruction), mark the child busy, `activeRunId = run_id`.
4. Same for the Agent tool's first run: user message from `task_started.prompt` (drop the echo-based creation; keep it only as fallback if no `task_started` arrived). A user message per `run_id` (dedupe).
5. `task_notification` with a SendMessage `tool_use_id`: do not complete the SendMessage tool (its own tool_result does); store `summary` on `metadata.reply`, clear the run, set the child idle when no run is active. `handleResult` must keep children busy while `activeRunId` is set (today it keys on the spawning Agent tool being done, which is wrong for async continuations).
6. Fallback link if `task_started` never comes (denied/failed): at tool_result, `resumedAgentId` (async JSON) or `to` that matches `agents`.
7. Child messages keep routing by `parent_tool_use_id`; assistant `parentID` becomes the newest child user message automatically.

**Replay (`history.ts` / mapper replay)**
- Load subagent transcripts first (or in `Promise.all`, as now) and build `agentId -> ownerToolUseId` from the pair (agentId, `entries[0].parent_tool_use_id`); pass the index into the mapper.
- In child transcripts create one user message per user text entry (today only the first one, `promptCreated` guard) and unwrap the "coordinator sent a message ..." frame; entries are already timestamp-sorted so ids stay ascending.
- After replaying main + children run a `linkSendMessages` pass: for each SendMessage part without `metadata.sessionID` resolve by (a) raw agentId, (b) `resumedAgentId`, (c) message-text match against wrapped child user entries, (d) optional plugin state file; emit `part.updated` with the same metadata as live. The replay-vs-live equivalence test should cover it.

**sessionState**: no structural change (children are already buckets). Optionally expose `state.agents` for host lookups (permission prompts carry `agentID`: map to the child, instead of always the parent, so the prompt can be shown inside the opened subtask).

**Types / protocol (additive)**: `Session.claude` gains `agentId?`, `agentType?` for child sessions; SendMessage `ToolPart.metadata` keys as above (`sessionID`, `agentId`, `agentType`, `recipient`, `message`, `reply`). No new events or requests: `session.created` for the child already exists, `message.part.updated` carries the link, `claude:session.load` already serves `sub_` ids. UI (frontend): a SendMessage renderer ("To: Explorer (exp-1)", the message, "Open <name> subtask", reply in the output), reusing the Agent renderer's open-child logic via `metadata.sessionID`.

**Pitfalls**
- Never route by the SendMessage tool_use id; content messages use the original Agent id, `task_*` use the SendMessage id.
- `task_started.is_backgrounded` is true for continuations even in the sync env; tool_result timing differs between sync (after child work) and async (before): do not infer child completion from the SendMessage result, only from `task_notification` per run.
- A SendMessage to an agent that is still running probably injects into the current run (the "while you were working" wrapper suggests it) and may not emit a new `task_started`; **untested**, handle by falling back to the tool_result link and appending the instruction to the child.
- History has no run boundaries and no `agent_id`; matching by message text can be ambiguous if the same text is sent twice (resolve in order, one-to-one).
- The alias exists only in the SendMessage input and the plugin's state file; the stream never shows the resolved id except through `task_started.task_id` (so keep hook events off, they are not needed).
- Nested subagents (a child calling Agent/SendMessage) use the same container logic; keep the registry per mapper, not per container.
- `tool_use_result` is absent from history, so replay metadata can only use the text forms above.
- Plugin hook state (`mode`, aliases) is per session file and survives agent switches (see Q1), so alias-based continuation keeps working after a switch but delegation rules may reflect a stale mode.
