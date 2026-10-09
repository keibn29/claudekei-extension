# ClaudeKei Phase 1.1 - UI spec: subagent visibility and agent switching

Status: design spec (no implementation). Owner: design. Implementer: @frontend-developer, after the backend data-model findings land.
Context: `docs/PHASE1_PLAN.md` (A1/A2), `docs/W0_SPIKE_NOTES.md` (Agent/`task_*` shapes). Width budget: sidebar 300-450px (design at 360px, check 300 and 450). Visual language = OpenKei: flat tool rows with a left rail, `typography-meta` / `typography-micro`, Remix icons, `agent-badge` chips, CSS variables only (the VS Code webview theme is fixed dark, so no hard-coded colors).

Two problems, two sections:

1. Subagent cards (`Agent` + `SendMessage`) and the child-session view.
2. Agent switching (session-bound agent).

---

## 0. Data the UI needs (to confirm with the backend investigation)

The UI is designed against this contract. Anything marked (?) is an assumption the backend must confirm or we degrade as noted.

| Need | Source | Used by | If missing |
|---|---|---|---|
| `agentId` -> one child session (`sub_<id>`), shared by the `Agent` part and every later `SendMessage` | part `metadata.sessionID` (+ `agentId`) | open link, status, live progress | card shows "No session" (disabled open) |
| Alias (`exp-1`) | `Agent` input `name` (?) or host-derived; `SendMessage.input.to` | chip, group rows | show `to` verbatim |
| Type + display name + color for **every** agent, not only primary | catalog `agents[]` (`color` is currently only mapped for primary agents in `lib/claude/catalog.ts buildAgents`) | chip color | `getAgentColor(name)` hash palette (already used today) |
| Initial prompt | `Agent` input `prompt` (already normalized as an input field) | Instructions block | hide block |
| Message text | `SendMessage` input `message` (+ optional `summary`) | Message block | hide block |
| Which child **user message** a `SendMessage` produced (?) | `metadata.messageID` on the part, else match by order | "progress since this message", jump links | progress is whole-session instead of "since message" |
| Child user messages tagged as instructions: `{kind:'initial'|'followup', fromSessionID, fromAgent, toolCallID}` (?) | child `UserMessage.claude`/metadata | Instruction timeline, "From Orchestrator" | derive: every user message in a child session is an instruction; `From` = parent session agent |
| Live status of the subagent (busy/idle/error/stopped), independent of the tool part | child `SessionStatus` + `task_notification` | card status | derive from tool state (wrong for async agents, see below) |
| Progress: `tool_uses`, `total_tokens`, `duration_ms`, `last_tool_name` | `task_progress` | progress line | count from child messages |
| Parent session agent | `Session.agent` | "From Orchestrator" label | "From main agent" |
| Does SendMessage to a finished subagent resume it (child goes busy again)? | backend | status semantics | assume yes |

Important consequence (from W0 notes): `Agent` runs in the **background by default**, its `tool_result` is "async launched". **Card status must be derived from the child session status, not from the tool part state**, otherwise every card says "done" immediately.

---

## 1. Subagent cards

### 1.1 Principles

- Keep the OpenKei tool-row look (icon, title, left rail, nested lines). Do not introduce a heavy boxed card inside the transcript: seven of them in a turn must stay scannable.
- Identity first: **type chip (agent color) + alias**. Description second. Status at the right edge.
- Same component for `Agent` and `SendMessage`; the header differs by verb/icon only.
- Collapsed row shows everything needed to answer "what is it, is it still working, what is it doing now". Expanded row answers "what exactly was it told, and what did it say".
- A subagent that is `running` always shows its current step on a third line, even when collapsed (peek line).

### 1.2 Anatomy (360px content width)

Collapsed, running (`Agent`):

```
 > (o) Subagent Task  [Explorer] exp-1        . 12s
      Ping explorer
      -> Grep "SendMessage"           7 tools
```

Collapsed, done (`SendMessage`):

```
 > (>) Message to  [Explorer] exp-1           ok sent
      "Also check the new schema in src/db..."
      Explorer is working  . 3 tools since this
```

Expanded (`Agent`):

```
 v (o) Subagent Task  [Explorer] exp-1        . 12s
 |    Ping explorer
 |
 |    INSTRUCTIONS                     [copy]
 |    Find every call site of
 |    SendMessage in packages/ui and
 |    report file:line ...            
 |    Show more
 |
 |    PROGRESS                    7 tools . 12.4k tok
 |    [r] Read   src/lib/claude/send.ts
 |    [g] Grep   "SendMessage"
 |    [r] Read   src/lib/toolNames.ts   (shine = current)
 |
 |    [^] Open Explorer session
 |    > Output
```

Expanded (`SendMessage`): same, with `MESSAGE` instead of `INSTRUCTIONS`, `PROGRESS (since this message)`, and `> Latest reply` instead of `> Output`.

Legend: `(o)` `RiAiAgentLine` in agent color; `(>)` `RiSendPlaneLine` (muted); `[Explorer]` = existing `agent-badge` chip styled via `getAgentColor(type)` (same chip as `MessageHeader`), text from catalog `displayName` (fallback `formatAgentName`); `exp-1` = `typography-micro font-mono text-muted-foreground`; `.` = status glyph, see 1.4.

Layout rules:
- Header line 1: `[chevron/icon] [title] [chip] [alias] ... [status]`. Title ("Subagent Task" / "Message to") is `flex-shrink-0` text; the chip never truncates; the alias truncates last; status is right-aligned and never wraps. Below 340px the title text is hidden (icon + chip + alias only; the title stays as `title`/aria-label).
- Header line 2: description (`Agent`) or first line of message (`SendMessage`), `truncate`, `typography-meta text-muted-foreground`. If empty, first line of the prompt.
- Header line 3 (only while the subagent is `running`): current step `-> <Tool> <label>` (reuse `getTaskSummaryLabel`) + `N tools` right-aligned in `typography-micro`. Animated with the existing `ToolRevealOnMount` / shine; respect `prefers-reduced-motion` (no shine, no wipe).
- Header is the existing `role="button"` toggle (`handleMainClick`, chevron appears on hover in place of the icon). Keep that behavior.
- Body keeps today's rail: `pl-[1.4375rem]` + `before:` 1px rail, `space-y-2`.

### 1.3 Body blocks

**Instructions / Message block** (`InstructionBlock`)
- Label `INSTRUCTIONS` (Agent) or `MESSAGE` (SendMessage): `typography-micro uppercase tracking-wide text-muted-foreground/80`.
- Content rendered with `SimpleMarkdownRenderer variant="tool"`; collapsed to 4 lines (`line-clamp-4`, ~`max-h-[5.5rem]` with the same bottom fade used in `PlanCard`) when it exceeds 4 lines or 280 chars; `Show more` / `Show less` text button below (`typography-micro`, `aria-expanded`). Expanded: `max-h-[40vh]` scrollable.
- Copy icon button top-right (same as `PlanCard`: `RiFileCopyLine` -> `RiCheckLine` for 1.2s).
- Prompts longer than ~4000 chars: expanded view still scrolls; add `Open full text` which calls the existing `onShowPopup` (ToolOutputDialog).

**Progress block** (`SubagentProgress`)
- Reuse today's `TaskToolSummary` entry list (icon + display name + label). Collapsed card: peek line only. Expanded: last 6 entries (today's behavior, `+N more...` when truncated), `max-h-56`; when the user expands the card manually allow `max-h-[40vh]`.
- Header of block: `PROGRESS` label left; right: `N tools . 12.4k tok` from `task_progress` (or counted from child messages). For `SendMessage`: label `PROGRESS (since this message)`, entries = child tool calls after the linked user message; if nothing yet: `Waiting for <Type> to pick this up...`.
- Idle/finished subagent: block shows the last 3 entries only, no peek.

**Actions row**
- `Open <Type> session` (existing style: `RiExternalLinkLine`, `text-primary`, full-width left aligned, `typography-meta`). Label includes alias when present: `Open Explorer (exp-1) session`. Keep calling `openSubtaskSession(sessionId, currentSessionId, parentDirectory)`.
- `Output` (Agent) / `Latest reply` (SendMessage): existing collapsible (chevron button + markdown, `max-h-[50vh]`). `Latest reply` = last assistant text part in the child session after the linked message; hidden if none yet. For async agents `Output` shows `Result will appear here when <Type> finishes.` (muted) while running.
- Keyboard: Open link and Output toggle are real `<button>`s in tab order inside the expanded body; header toggles with Enter/Space (existing).

### 1.4 States

| State | Trigger | Right-edge status | Notes |
|---|---|---|---|
| Preparing | tool part `pending` (input streaming) | `RiLoader4Line` spin + `Starting...` | title + chip only; no body |
| Running | child session `busy`/`retry` (or tool `running` when no child yet) | muted dot spinner + elapsed `12s` (ticks via `useDurationTicker`) | peek line visible; shine on title |
| Done | child idle after completion, or `task_notification: completed` | `RiCheckLine` `--status-success` + duration `12.3s` | peek line removed |
| Failed | tool error / `task_notification: failed` / child error | `RiCloseCircleLine` `--status-error` + `Failed` | description gets error text in `--status-error` (first line); Output block shows error |
| Stopped | user abort / `stopped` | `RiStopCircleLine` muted + `Stopped` | |
| No session | no `metadata.sessionID` after the existing 3s/8s fallback window | `RiLinkUnlinkM` muted, text `No session` | Open link disabled (`aria-disabled`, tooltip `Session not available yet`); never shows a spinner forever |
| SendMessage delivered | tool result ok | `RiCheckLine` + `sent` | the second line shows the live subagent state (`Explorer is working` / `Explorer replied`) |
| SendMessage failed | tool error (unknown alias, etc.) | `RiCloseCircleLine` + `Not delivered` | error text from result, no Open link |
| Empty prompt/message | field missing | n/a | block omitted, no empty label |

Status is announced, not ticked: elapsed time is `aria-hidden`; a visually hidden `role="status" aria-live="polite"` span in the card announces only transitions (`Explorer exp-1 finished`, `... failed`).

### 1.5 Parallel grouping (7 agents pinged at once)

Rule: **2 or more adjacent `Agent`/`SendMessage` parts in the same assistant turn** (ignoring reasoning/justification between them) render as one `SubagentGroup`. A single part renders as a plain card. Mixed spawn + message parts are allowed in one group.

Group header (`role="group"`, `aria-labelledby`), collapsible, default expanded while any member is running, default collapsed when all are settled and there are 4 or more members:

```
 v (o) 7 subagents  . 4 running  ok 2  x 1   0:42
 |   [Explorer]  exp-1  Ping explorer     . 12s
 |   [Librarian] lib-1  Ping librarian    . 9s
 |   [Debugger]  dbg-1  Ping debugger     ok 8s
 |   [Oracle]    ora-1  > Review plan     . 5s
 |   [Designer]  des-1  > Re-check styles ok 3s
 |   [Frontend]  fed-1  Ping frontend     x
 |   [Backend]   bed-1  Ping backend      . 4s
```

- Counts in the header: running / done / failed (omit zeros); right side = elapsed since first start while any is running, else total wall time.
- Compact row = one line: chip, alias, description (truncate), status. `Agent` rows have no extra glyph; `SendMessage` rows are prefixed with `>` (`RiSendPlaneLine`, 12px) so a re-ping is distinguishable from a spawn.
- Row click expands **inline** into the full card body (accordion, multiple can be open; only one per row). A trailing icon button `RiExternalLinkLine` (24x24 hit area, `aria-label="Open Explorer (exp-1) session"`) opens the session without expanding.
- Row height 24px, so 7 rows = ~170px; no inner scroll.
- Rows keep call order (no re-sorting by status), so positions stay stable while agents finish.

### 1.6 Child session view (opened subagent)

Replaces the floating `Return to parent` button in `ChatContainer.tsx` with a sticky `SubagentHeader` (same `Button xs outline` back control inside it):

```
 [<- Back to Orchestrator]
 (o) [Explorer] exp-1              . Running 12s
 Ping explorer
 3 instructions v     8 tools . 14.1k tok
```

- Row 1: back button (existing aria/labels), label `Back to <ParentAgent>` (fallback existing `Return to parent`).
- Row 2: identity (icon + chip + alias) and live status.
- Row 3: description (truncate), then `N instructions v` disclosure listing the **instruction timeline**:

```
 3 instructions ^
  #1 Initial task   10:02  Find every call site...
  #2 Follow-up      10:09  Also check the new...
  #3 Follow-up      10:15  Summarize what you...
```
  Each row is a button that scrolls the transcript to that instruction (`scrollIntoView`, focus moves to the message, `aria-current` on the active one).
- Sticky, single border-bottom, `bg-background`; collapses row 3 into one line on scroll is not required.

**Instruction messages** (the child session's user messages) get a distinct renderer, not the right-aligned user bubble:

```
 | FROM ORCHESTRATOR . #2 Follow-up      10:09
 | Also check the new schema in src/db and
 | report any type that changed.
 | Show more                    [^ View in Orchestrator]
```
- Left-aligned block, 2px left border in the **parent agent's color**, `bg-[var(--surface-subtle)]`, `rounded-lg`, `typography-meta`; eyebrow row: `FROM <PARENT AGENT>` micro caps + `#n Initial task|Follow-up` + time.
- Same collapse behavior as the Instructions block (4 lines + Show more).
- `View in Orchestrator` jumps back to the originating tool part in the parent (sets current session to parent and scrolls to `toolCallID`; fallback: back button behavior).
- Role semantics: `role="article"` with `aria-label="Instruction 2 from Orchestrator"`.

**Composer in a child session**: already disabled (`composerInteractionDisabled`). Replace the dimmed controls with a single read-only footer:

```
 Read-only. Instructions come from Orchestrator.
 [Back to Orchestrator]
```
Hide model/agent/permission controls there (they are `pointer-events-none opacity-50` today, which reads as broken). A `Stop` control for a running subagent is Phase 2 (needs `TaskStop` plumbing).

**Sidebar / session list (optional, P2)**: subagent children already nest under their parent (`SessionNodeItem`). Add: a 6px status dot on the child row (busy = spinner, error = `--status-error`), the alias as micro text after the title, and on the collapsed parent a `3 running` micro badge when any child is busy. Child rows use the agent color for the dot only.

### 1.7 Copy

| Where | Text |
|---|---|
| Agent title | `Subagent Task` (unchanged) |
| SendMessage title | `Message to` (aria: `Message to Explorer exp-1`) |
| Block labels | `INSTRUCTIONS`, `MESSAGE`, `PROGRESS`, `PROGRESS (since this message)`, `Output`, `Latest reply` |
| Expand/collapse | `Show more` / `Show less` (existing `inlineComment.actions.showMore/showLess`) |
| Open | `Open {type} ({alias}) session` (existing key `chat.toolPart.openSubtask` becomes `Open {type} session`; add alias variant) |
| Status | `Starting...`, `{n}s`, `Failed`, `Stopped`, `No session`, `sent`, `Not delivered` |
| SendMessage live line | `{Type} is working`, `{Type} replied`, `Waiting for {Type} to pick this up...` |
| Async output placeholder | `Result will appear here when {Type} finishes.` |
| Unlinked tooltip | `Session not available yet` |
| Group header | `{n} subagents`, then `{n} running`, `{n} done`, `{n} failed` |
| Child header | `Back to {ParentAgent}`, `{n} instructions`, `#1 Initial task`, `#{n} Follow-up` |
| Instruction eyebrow | `FROM {PARENT AGENT}` |
| Child footer | `Read-only. Instructions come from {ParentAgent}.` |
| Group/unknown parent | `main agent` |

### 1.8 Accessibility

- Card header: `role="button"`, `tabIndex=0`, `aria-expanded`, `aria-controls` the body id; `aria-label` = `Subagent Task, Explorer exp-1, running, 12 seconds, Ping explorer` (status words, not color).
- Chip is text, status always has an icon shape (spinner/check/x/stop/unlink) so color is never the only signal; agent colors only tint the chip and dot.
- Group: `role="group"` + `aria-labelledby` the header; compact rows are `<li>` in a `<ul>`; row button `aria-expanded`; open icon button has its own label.
- Live region: transitions only (see 1.4). Never make the elapsed counter or progress lines live.
- Focus: after `Show more`, focus stays on the toggle; after jump from the instruction timeline, focus moves to the target message (`tabIndex=-1`).
- Hit targets: header row stays at today's density (24px), icon buttons 24x24 minimum, spacing >= 4px.
- Motion: shine/wipe animations disabled under `prefers-reduced-motion`.
- Contrast: use existing text tokens; agent chip text uses the same `agent-badge` classes already audited in `MessageHeader`.

### 1.9 Components and files

New:
- `packages/ui/src/components/chat/message/parts/SubagentCard.tsx`: header (3-line rule), status glyph, `InstructionBlock`, `SubagentProgress`, actions. Used by `Agent` and `SendMessage`.
- `.../parts/SubagentGroup.tsx`: grouping wrapper + compact rows.
- `packages/ui/src/lib/claude/subagents.ts`: `useSubagentInfo(part)` returning `{ sessionId, agentId, alias, type, displayName, colorKey, prompt|message, status, startedAt, endedAt, toolCount, tokens, currentStep, lastReply }` (merges tool state, child session status and child messages; keeps the existing child-session resolution/polling now inside `ToolPart.tsx` behind this hook).
- `packages/ui/src/components/chat/SubagentHeader.tsx`, `.../message/InstructionMessage.tsx`.

Change:
- `lib/claude/toolNames.ts`: map `SendMessage` -> `sendmessage`.
- `lib/toolHelpers.ts`: `sendmessage` metadata (`displayName: 'Message'`, input fields `to`, `message`, `summary`); `task` unchanged.
- `components/chat/message/parts/toolPresentation.tsx`: `sendmessage` icon (`RiSendPlaneLine`).
- `.../parts/toolRenderUtils.ts`: add `sendmessage` to `STANDALONE_TOOL_NAMES` and `EXPANDABLE_TOOL_NAMES` (kills the generic "Sendmessage" row).
- `.../parts/ToolPart.tsx`: for `task`/`sendmessage` render `SubagentCard` (header block ~L2516-2600, `TaskToolSummary` ~L1050-1225 folds into the card; keep resolution/polling logic).
- `components/chat/message/MessageBody.tsx` (~L1318) and `components/chat/lib/turns/projectTurnActivity.ts`: detect adjacent standalone subagent parts and emit a `SubagentGroup`.
- `.../message/ToolOutputDialog.tsx` (has a `task` branch): add a `sendmessage` branch (message + latest reply, markdown).
- `lib/claude/catalog.ts buildAgents`: pass `color`/`displayName` for subagents as well.
- `components/chat/ChatContainer.tsx` (`returnToParentButton` ~L428): render `SubagentHeader`; `ChatInput.tsx` (`composerInteractionDisabled`): read-only footer; `ChatMessage.tsx`/`UserTextPart.tsx`: `InstructionMessage` when the current session is a subagent child.
- `lib/i18n/messages/en.ts` (+ other locales fall back to en): new keys above.
- Mock: add `[mock:subagents]` to `lib/claude/mockRuntime.ts` (3 `Agent` + 4 `SendMessage` in parallel, one failing, one async/running, one unknown alias) as the acceptance fixture; verify at 300, 360, 450px.

---

## 2. Agent switching

### 2.1 Facts and problem

The main-thread agent is fixed per Claude process. ClaudeKei switches by restarting with `resume` + new `--agent` on the next send. Today Shift+Tab silently changes the chip mid-session (OpenCode habit) while nothing visibly changes until the next message, and it is unverified that the system prompt really changes. Users read the chip as a live toggle, so it misleads.

Principle: **the agent is a property of the session**, shown honestly. Switching is an explicit action with a stated consequence.

### 2.2 Option A (recommended): session-bound agent, "new session" as default

States:

1. **New session (draft, no message sent)**: the picker is prominent and free; changing it is instant and costless.
   - `ChatEmptyState` shows an agent chooser above the composer (4 tiles; see wireframe). The composer chip mirrors it.
   - Shift+Tab cycles agents (current behavior, in the only state where it is truthful). Announce `Agent: Planner`.
2. **Started session**: the chip shows the session's agent (read from `Session.agent`, not the draft/config store). Shift+Tab no longer changes the agent; it cycles the **permission mode** (Claude Code parity: Shift+Tab = default -> auto-accept edits -> plan) by dispatching the existing `CYCLE_PERMISSION_MODE_EVENT`; the permission chip pulses once and announces `Permission mode: Plan`. Clicking the agent chip opens the switch menu (below).
3. **Switch menu**, new session is the default action:
   - Row click = **Start new session as <Agent>**: `openNewSessionDraft({ agent })` in the same directory, composer text carried over, focus in composer. Zero risk, history of the old session untouched.
   - Only when verified by the backend: a second section **Continue this session as <Agent>** (restarts Claude, keeps history). Selecting it shows the state in 2.4 and the divider in 2.5.
   - "Hand off with summary" is not in v1 (needs a summarize call); revisit in Phase 2 as a third section.
4. **Subagent child session**: chip and Shift+Tab are inert (read-only footer, see 1.6).

Wireframe, new session at 360px:

```
 Chat
            [ cube ]
        Start a new chat
   Who should lead this session?
  +-------------------+ +-------------------+
  | (o) Orchestrator  | | ( ) Planner       |
  | Coordinates work  | | Plans before      |
  | across agents  ok | | building          |
  +-------------------+ +-------------------+
  +-------------------+ +-------------------+
  | ( ) Sprinter      | | ( ) Business An.. |
  | Fast focused      | | Requirements and  |
  | implementation    | | research          |
  +-------------------+ +-------------------+
  +-----------------------------------------+
  | @ for files/agents; / for commands      |
  | [clip] [ ] [sh]  Default (rec.) (o) Orch|
  +-----------------------------------------+
   Shift+Tab switches agent
```
Selected tile: 1px border and 10% tint in the agent color, `RiCheckLine` at top-right, name in agent color. Below 340px width tiles drop the description (name + dot only). Tiles are a `role="radiogroup"` (`aria-label="Agent for this session"`), roving tabindex, Arrow keys move selection, Space/Enter select; mirrors `setAgent` so the composer chip and Shift+Tab stay in sync. The hint line is `typography-micro text-muted-foreground`; it disappears after the first send.

Wireframe, switch menu in a started session (anchored to the agent chip, `w-[min(280px,calc(100vw-2rem))]`):

```
 +----------------------------------------+
 | This session runs as  [Orchestrator]   |
 | Claude can't change agent mid-session  |
 | without restarting.                    |
 |----------------------------------------|
 | START NEW SESSION AS                   |
 | . Planner            Plans before ...  |
 | . Sprinter           Fast focused ...  |
 | . Business Analyst   Requirements ...  |
 |----------------------------------------|   (only if verified)
 | CONTINUE THIS SESSION AS               |
 | R Planner   restarts Claude, keeps     |
 |             history (about 1s)         |
 | R Sprinter  ...                        |
 +----------------------------------------+
```
Menu items: `role="menuitem"`, first item focused on open, Escape returns focus to the chip, the header paragraph is `role="presentation"` text linked via `aria-describedby` on the menu. The "Continue" section lists the same agents; if the list feels long, collapse each agent to one row with a trailing `RiRestartLine` icon button instead (tooltip `Continue this session as Planner (restarts Claude, keeps history)`), main click stays "new session".

Shift+Tab by state:

| State | Shift+Tab | Chip |
|---|---|---|
| Draft, composer empty or typing | cycle agent (announce) | live, colored |
| Started, idle | cycle permission mode | shows session agent, menu on click |
| Started, busy | cycle permission mode (applies live) | same |
| Autocomplete open | unchanged (autocomplete owns Tab) | n/a |
| Subagent child session | no-op | inert |

Copy: tile hint `Shift+Tab switches agent`; started-session tooltip on the agent chip `Session agent: Orchestrator. Click to switch.`; Shift+Tab tooltip on permission chip `Shift+Tab: next permission mode`; toast after starting a new session from the menu: none (the new empty chat with the chosen tile is the feedback).

### 2.3 Option B: in-place switching, made explicit

Keep the chip freely switchable (and Shift+Tab cycling agents everywhere) but make the consequence visible. Only acceptable if the backend verifies that the restart really changes the system prompt.

- Picking a different agent in a started session does **not** swap the chip at once. It enters a **pending** state: chip shows the new agent with a dashed outline and micro text `next message`, plus an `Undo` icon button; the old agent stays in the message headers until the next send.
- First pending change shows a one-time popover under the chip: `Claude restarts as Planner on your next message. History is kept. [Switch] [Start new session instead]`. Subsequent changes in the same session skip it.
- Busy turn: switching is queued (`Applies after this reply`) because restarting would kill the running turn.
- Shift+Tab cycles agents in all states; permission mode is reachable only through its own chip (loses Claude Code parity).
- Transcript divider on the first message sent after a switch (see 2.5).

### 2.4 Recommendation

**Choose A.** It matches how Claude Code actually works (agent per session, Shift+Tab = permission mode as in the CLI), removes the false "live toggle" affordance, and costs nothing if the restart behavior turns out not to change the prompt. Add B's mechanics only as the optional "Continue this session as ..." menu section, behind a flag, when verified: pending state (2.3) + divider (2.5) apply to that path.

### 2.5 Transcript marker for a switch (Continue-here path only)

Derived, no new stored data: when a user message's `agent` differs from the previous user message's `agent`, render a divider above it:

```
 --------- (o) Switched to Planner ---------
             Claude restarted . history kept
```
- Centered, `typography-micro text-muted-foreground`, hairline rules (`border-border/40`), agent-colored dot, agent name in its color.
- `role="separator"` with `aria-label="Switched to Planner"`.
- Message header badge (already `Orchestrator`/`Planner` per assistant message) stays as is.
- New-session path needs no divider; optionally the new session's first line in the sidebar carries the agent dot (P2, same dot as 1.6 sidebar).

### 2.6 Components and files

- `components/chat/ChatEmptyState.tsx`: `AgentChooser` tiles (new file `components/chat/AgentChooser.tsx`), wired to `useConfigStore.setAgent`.
- `components/chat/ModelControls.tsx` (desktop agent trigger ~L2680-2760, already has `role="button"`/live region): state-aware trigger: draft = current dropdown (unchanged); started = switch menu above. Reuse `DropdownMenu`, `agent-dot`, `agentLabel`.
- `components/chat/ChatInput.tsx` (~L1810-1830 Shift+Tab handler): branch on `currentSessionId && hasMessages`: draft -> `handleCycleAgent()`, started -> `window.dispatchEvent(new CustomEvent(CYCLE_PERMISSION_MODE_EVENT))`; `handleCycleAgent` also gets the draft-only guard.
- `sync/session-ui-store.ts openNewSessionDraft`: accept `{ agent }` and carry the unsent text.
- Agent source for the chip in a started session: `useSession(currentSessionId).agent` (host-owned), not `useConfigStore`.
- `components/chat/message/AgentSwitchDivider.tsx` + insertion in `MessageList.tsx` (only for the Continue-here path).
- `lib/claude/send.ts` and the host path stay as they are unless "Continue here" ships.
- Docs to update: `PHASE1_PLAN.md` A1 (Shift+Tab semantics) once this is accepted.

### 2.7 Accessibility

- Agent chooser: radiogroup, roving tabindex, visible focus ring (`focus-visible:ring-1 ring-primary`), selection announced via the existing live region.
- Agent changes (draft) and permission-mode changes (started) are announced politely; a blocked/inert Shift+Tab announces nothing.
- Shift+Tab is only intercepted inside the composer textarea and only for these two purposes; Escape then Tab remains the way out for keyboard users (document in the tooltip: `Shift+Tab ... Esc, then Shift+Tab to leave`). Do not intercept it elsewhere.
- Menu: focus returns to the chip on close; the explanatory header is described by `aria-describedby`.
- Color is never the sole carrier: tiles/menu rows have the agent name, dots are decorative (`aria-hidden`).

---

## 3. Delivery order

1. Backend confirms section 0 (alias source, message-id link, instruction tags, per-agent color, restart verification).
2. `sendmessage` normalization + standalone/expandable registration (removes the "Sendmessage" row immediately, smallest visible win).
3. `SubagentCard` (Agent + SendMessage) + `useSubagentInfo`.
4. `SubagentGroup` + `[mock:subagents]` fixture.
5. Child session header + `InstructionMessage` + read-only footer.
6. Agent chooser + state-aware Shift+Tab + agent chip menu (Option A).
7. P2: sidebar status dots, "Continue here" + divider (if verified), hand-off.

## 4. Open decisions (design calls made; flag if you disagree)

- Shift+Tab after the first message cycles **permission mode** (Claude Code parity) rather than doing nothing. Fallback: no-op plus the hint `Agent is fixed for this session`.
- Subagent status comes from the child session, not the tool part.
- Grouping threshold is 2 adjacent parts; groups auto-collapse only when all settled and 4 or more members.
- No heavy boxed card; flat row + rail, to stay consistent with OpenKei and dense with seven agents.
