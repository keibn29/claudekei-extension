# Fix: stopping the main agent must stop all subagents

Source: @debugger investigation (2026-10-10). Paths relative to `packages/vscode/src/claude/` unless noted. Line numbers are approximate; use function names.

## Root cause
- `query.interrupt()` does stop in-flight foreground subagents in the CLI (abort signal shared), and kills backgrounded `local_agent` tasks (SendMessage continuations are `is_backgrounded:true, awaited:true`) emitting `task_notification status:'stopped'` — as long as we do NOT declare `perTaskStopAffordance` (keep it that way; never abort the AbortController for interrupt — that kills the process).
- **Main bug (mapper):** on an aborted `result`, `abortOpenTools(..., false)` fails open non-async tools, but `finishChildOf` (`mapper.ts` ~836: `if (child.agentRec && child.agentRec.runs.size > 0 && !replay) return;`) and the child loop in `handleResult` (~1433-1443: `if (c.agentRec.runs.size > 0) continue;`) keep children busy. `rec.runs` is only emptied by `endRun` (task_notification) or `finish()` (process close → idle timeout 10 min). UI keeps spinners (child status `busy`).
- **Probable second bug:** an aborted foreground agent emits `task_notification` with status `completed` (CLI `finally`), so the mapper `completeAsyncTask` → card shows "done" with empty output and the later is_error tool_result is ignored (`if (ref.done) return`).
- Gaps: `ClaudeSession.interrupt()` ignores `still_queued`; `interrupt({cancelQueued:true})` is accepted by sdk.mjs but untyped. `ClaudeSessionManager.interrupt('sub_…')` is a silent no-op. `task_updated` (killed/failed) ignored (~1580). `testUtils.ts:77` `runFixture` always calls `mapper.finish('ended')`, hiding the bug in golden tests.

## Fix (host)
1. `mapper.ts` new `stopRuns(reason)` near `endRun`: for every agents rec, for each `[key, ref]` of `rec.runs`: delete key; `updateSubMeta(ref, {runStatus:'stopped'})`; if Agent tool part not done → set runStatus stopped then `failTool(ref, reason)` (failTool only rewrites 'running'); then `finalizeContainer(child)`, `setStatus(child,{type:'idle'})`, clear `claude.progress`.
2. `handleResult`: when aborted (`terminal_reason` starts with `aborted`, or is_error + error_during_execution after a host interrupt), call `abortOpenTools('Interrupted by user', true)` (include async parts) then `stopRuns(...)` before the child-idle loop. Non-aborted results unchanged (regression guard `subagents.test.ts:118-129`: normal result must NOT idle children with active runs).
3. `Mapper.markStopRequested()`: flag cleared in `startUserMessage` and after the aborted result. Record `foreground = task_started.is_backgrounded === false` per run in `startRun`. While flag set, `task_notification status:'completed'` for a foreground run is treated as `stopped` (failTool, not completeTool).
4. `task_updated` with `patch.status` killed/failed for a known run → `endRun(rec, run_id, 'stopped'|'failed')`.
5. `INTERRUPT_TEXT` also matches `/^\[Request interrupted by user/`; `failTool` uses `runStatus='stopped'` for interrupt text (update expectation at `subagents.test.ts` ~295 for `finish('interrupted')` → 'stopped').
6. `Mapper.runningTasks(): {taskId, runId, toolUseId, childId}[]`.
7. `ClaudeSession.interrupt()`: `mapper?.markStopRequested()` first; `query.interrupt({cancelQueued:true})` via cast; watchdog `deps.timers.setTimeout(~4000)` cleared in runPump on `result`: if tasks still running or main busy → `query.stopTask?.(taskId)` for each `runningTasks()`; after a second timeout (~4000) → `closeProcess()` (finish() idles everything). Add a comment near options: do not declare perTaskStopAffordance / do not abort the AbortController for interrupt.
8. `sdk.ts` `ClaudeQuery`: add `stopTask?(taskId: string): Promise<void>`; interrupt accepts optional `{cancelQueued?: boolean}`.
9. `ClaudeSessionManager.interrupt(id)`: if `id` starts with `sub_`, resolve owning session and interrupt the owner (Stop in a subagent view = stop everything).

## UI safety net (small)
- `packages/ui/src/components/chat/message/parts/useSubagentInfo.ts` ~182-203: ignore `childPhase === 'busy'` when parent session idle, tool part settled and `runStatus !== 'running'`.
- `packages/ui/src/lib/claude/subagents.ts` `summarizeSubagentStatuses`: count `stopped`.

## Tests
- `subagents.test.ts` synthetic: Agent run + aborted result without notification → child idle, tool error 'Interrupted by user', runStatus stopped, runningTasks() empty; 3 parallel Agents + SendMessage run → all stopped; normal result with active run keeps child busy; markStopRequested + completed notification → stopped; stopped notification and task_updated killed both end run; late notification after force-finish harmless; interrupt then new SendMessage turn → child ends idle.
- `testUtils.ts`: let `runFixture` skip final `finish()` (option) so fixtures can catch this.
- `manager.test.ts` + `fakes.ts` FakeQuery `stopTask` + `stopped: string[]`; aborted segment ends with child idle; watchdog with fake timers → stopTask per running task then close; `interrupt('sub_…')` resolves owner; interrupt passes `cancelQueued:true`.
- Optional real recording via `packages/vscode/scripts/record-fixture.ts` (`--interrupt-after-ms`, `--env CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`) e.g. `subagents/interrupt-agent-sync` — learn whether foreground abort yields completed / stopped / no notification; add to `INTERRUPT_FIXTURES` (`mapper.test.ts`) and record-all.sh.
