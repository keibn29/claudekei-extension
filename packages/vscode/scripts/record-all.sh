#!/usr/bin/env bash
# Re-records every W0 fixture (haiku, tiny prompts; ~30 model calls). Run from packages/vscode:
#   bash scripts/record-all.sh
# Each scenario re-seeds the throwaway sandbox; the repo itself is never touched.
set -uo pipefail
cd "$(dirname "$0")/.."
rec() { echo "== $2"; bun scripts/record-fixture.ts "$@" 2>&1 | tail -2; }

# --- plain turns
rec --name text --prompt "Reply with exactly: hello"
rec --name thinking --prompt "A bat and a ball cost 1.10 total; the bat costs 1.00 more than the ball. Think carefully, then give the ball price in one sentence."
rec --name thinking-default --thinking default --prompt "A bat and a ball cost 1.10 total; the bat costs 1.00 more than the ball. Think carefully, then give the ball price in one sentence."
rec --name text-usersettings --setting-sources user,project,local --prompt "Reply with exactly: hello"
rec --name multi-turn --prompt "Reply with exactly: one" --prompt "Reply with exactly: two"
rec --name resume --resume multi-turn --prompt "What two words did you reply with earlier? One line."
rec --name fork --resume multi-turn --fork --resume-at first-assistant --prompt "What did you reply with earlier? One line."
rec --name compact --prompt "Reply with exactly: ok" --prompt "/compact"
rec --name error --model not-a-real-model-xyz --prompt "hello"

# --- file tools
rec --name read --prompt "Read hello.txt with the Read tool and tell me the second line, nothing else."
rec --name edit --mode acceptEdits --prompt "In src/app.ts use the Edit tool to change 'Hello, ' to 'Hi, '. Reply 'done' only."
rec --name edit-parallel --mode acceptEdits --prompt "In src/util.ts, make two separate Edit tool calls in the same response: change 'a + b' to 'b + a' and change '// TODO: add subtract' to '// TODO: add multiply'. Reply 'done' only."
rec --name write --mode acceptEdits --prompt "Use the Write tool to create docs/out.txt with the content 'written by fixture'. Reply 'done' only."
rec --name grep --allowed-tools Grep,Glob --prompt "Use the Grep tool to search for 'greet' in the current directory, then use the Glob tool to list *.ts files. Reply 'done' only."
rec --name bash-readonly --prompt "Use the Bash tool to run: echo hi && ls. Then reply 'done' only."
rec --name bash --prompt "Use the Bash tool to run exactly: mkdir -p out && echo hi > out/a.txt && cat out/a.txt. Then reply 'done' only."

# --- todos (this CLI defaults to TaskCreate/TaskUpdate; TodoWrite needs CLAUDE_CODE_ENABLE_TASKS=false)
rec --name tasks-v2 --allowed-tools TodoWrite --prompt "Use the TodoWrite tool to create a todo list with 3 items (a, b, c), then mark the first completed using TodoWrite again. Reply 'done' only."
rec --name todowrite --env CLAUDE_CODE_ENABLE_TASKS=false --allowed-tools TodoWrite --prompt "Use the TodoWrite tool to create a todo list with 3 items (a, b, c), then mark the first completed using TodoWrite again. Reply 'done' only."

# --- subagents (default = background/async; sync needs CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1)
rec --name task --prompt "Use the Task tool with subagent_type general-purpose to read hello.txt and report its first line. Then reply with that line only."
rec --name task-forward --forward-subagent-text --prompt "Use the Task tool with subagent_type general-purpose to read hello.txt and report its first line. Then reply with that line only."
rec --name task-sync --env CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 --prompt "Use the Task tool with subagent_type general-purpose to read hello.txt and report its first line. Then reply with that line only."

# --- permissions / questions / plan
rec --name permission-edit --prompt "In notes.md use the Edit tool to change '- alpha' to '- ALPHA'. Reply 'done' only."
rec --name permission-edit-noinput --allow-without-input --prompt "In notes.md use the Edit tool to change '- alpha' to '- ALPHA'. Reply 'done' only."
rec --name permission-always --always --prompt "In notes.md use the Edit tool to change '- alpha' to '- ALPHA', then in a separate Edit call change '- beta' to '- BETA'. Reply 'done' only."
rec --name permission-denied --deny Edit --prompt "In notes.md use the Edit tool to change '- beta' to '- BETA'. If denied, just say 'denied'."
rec --name askuserquestion --prompt "Use the AskUserQuestion tool to ask me which colors I like. Make it a multiSelect question with options red, green, blue. Then tell me what I picked in one sentence."
rec --name plan-exit --mode plan --prompt "Plan how to append the line 'done' to notes.md. When your plan is ready, call ExitPlanMode with it. Keep the plan to 2 bullets."
rec --name plan-exit-accept --mode plan --exit-plan-mode acceptEdits --prompt "Plan how to append the line 'done' to notes.md. When your plan is ready, call ExitPlanMode with it. Keep the plan to 2 bullets."

# --- interrupts
rec --name interrupt --env CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 --interrupt-after-ms 8000 --prompt "Use the Bash tool to run exactly: ping -c 40 127.0.0.1. Then reply 'finished'."
rec --name interrupt-agent-sync --out-dir subagents --env CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 --forward-subagent-text --interrupt-after-ms 25000 --timeout 90000 --prompt "Use the Agent tool with subagent_type general-purpose. Tell the subagent to use the Bash tool to run exactly: ping -c 60 127.0.0.1, and then report 'finished'. Wait for it, then reply 'done'."
rec --name interrupt-agent-running --out-dir subagents --mode bypassPermissions --env CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 --forward-subagent-text --interrupt-after-ms 25000 --timeout 90000 --prompt "Use the Agent tool with subagent_type general-purpose. Tell the subagent to use the Bash tool to run exactly: ping -c 60 127.0.0.1, and then report 'finished'. Wait for it, then reply 'done'."
rec --name interrupt-text --interrupt-after-ms 5500 --prompt "Write a detailed 600-word essay about the history of the bicycle. No preamble."

# --- UserPromptSubmit hook answering decision:block (no model call expected)
rec --name hook-block --hook-block-reason "Blocked by test hook: switched agent" --prompt "/claudekei:agent planner"
rec --name hook-block-events --include-hook-events --hook-block-reason "Blocked by test hook: switched agent" --prompt "/claudekei:agent planner"

# --- history dumps (no model calls)
for n in multi-turn edit task task-sync compact askuserquestion thinking todowrite grep bash interrupt permission-denied edit-parallel write read; do
  bun scripts/record-fixture.ts --history "$n" 2>&1 | tail -1
done
