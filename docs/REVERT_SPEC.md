# Spec: Revert from here, /undo, /redo, Timeline revert, RevertConfirmDialog

Source: @oracle design (2026-10-10). Decision-complete; implement as written.

## 0. SDK facts (0.3.295) and spike gate
- `Query.rewindFiles(userMessageId, {dryRun?})` sends a `rewind_files` control request (sdk.mjs ~138) → `{canRewind, error?, filesChanged?, insertions?, deletions?, skippedLinks?}` (sdk.d.ts ~3353). Restores files to their absolute state at that user message vs. current disk, so a dry run lists exactly the net change of a real rewind.
- `resumeSessionAt` → CLI `--resume-session-at` (sdk.mjs ~136). Cut at the last entry of the kept turn (sdk.d.ts ~2096-2152). Do NOT use `resumeDropsTurn`.
- `getSessionMessages` walks from the most recently written non-sidechain leaf back via parentUuid (sdk.mjs ~108) ⇒ after a truncating resume writes a new branch into the same JSONL, history shows only that branch.
- User message `uuid` we supply = JSONL uuid ⇒ `UserMessage.claudeUuid` valid for `rewindFiles` (live and replay).
- Host message ids are NOT stable across reloads (`ids.ts:30-44`). **Persist markers by `claudeUuid`, never host message id.**

**Spike S (do first, ~1h, `packages/vscode/scripts/record-fixture.ts` supports `--resume`, `--resume-at`):**
- S1: fresh `resume` process with no prompt can `rewindFiles(<uuid from earlier process>, {dryRun:true})` → canRewind true + files. Record whether `filesChanged` paths are absolute or relative.
- S2: `resume` + `resumeSessionAt` (no forkSession) + new prompt ⇒ same `init.session_id`; new JSONL user entry with parentUuid = cut uuid; `getSessionMessages` returns kept prefix + new turn only.
- S3: after S2, `rewindFiles` still works for a kept earlier message.
- S4: `deleteSession(id)` then spawn with `sessionId: id` starts a clean session under the same id.
- S1 or S3 fail ⇒ stop and report. S2 fails ⇒ Plan B (§9). S4 fails ⇒ first-message revert uses Plan B "new session" branch.
- Record spike results in `docs/W0_SPIKE_NOTES.md`.

## 1. Decisions
- D1 Revert = mark + rewind files now; truncate conversation on next send. Host sets `Session.revert = {messageID}`; UI filters. Next send commits: close process, respawn with `resume` + `resumeSessionAt: cutUuid` (same id), remove hidden messages from host state, clear marker.
- D2 Only main-session user messages with `claudeUuid`, no `instruction`. Never in `sub_` children; no assistant targets.
- D3 Cut uuid = last kept chain entry before target — reuse fork logic `ClaudeSessionManager.ts` ~749-753 + `forkUuidOf` (~932-941), extracted into a shared helper. No cut uuid (first message) ⇒ on commit: `deleteSession`, fresh spawn with `sessionId`.
- D4 Process for rewinding: live query if any. Busy ⇒ `interrupt()` then `closeProcess()` first. Cold ⇒ `spawn()` with plain `resume` (never resumeSessionAt for a rewind spawn).
- D5 Redo copy: before every real rewind, save current bytes of each dry-run `filesChanged` path not already saved (or record "absent"). Invariant: saved files + untouched files = head state ⇒ redo = write every saved file back.
- D6 Storage: marker `{uuid, resumeAt}` in workspaceState key `claudekei.revertMarkers`. File copies at `<storageDir>/revert/<sessionId>/` (`manifest.json` + blobs). Cap 100 MB per session (exceed ⇒ revert fails, nothing changed). Cleared on commit, unrevert, session delete, and startup sweep of dirs without marker.
- D7 `canRewind:false` ⇒ revert conversation only, return `filesError`; dialog warns; /undo shows warning toast.
- D8 All revert ops run in `ClaudeSession.exclusive()` (serialized with send/close/idle-close). Send during revert waits then commits. No UI send guard, no OpenKei lock/cascade.
- D9 Subagents: before commit, children of reverted turns stay in sidebar (known limitation). On commit emit `session.deleted` for every `sub_` child owned by a removed message (transitively). History reload skips subagent transcripts whose owning tool_use isn't in the kept chain.
- D10 UX like OpenKei: reverted messages hidden, no banner. Reverted user message text replaces composer text (only if that session is current). /undo /redo no confirm; buttons + Timeline use RevertConfirmDialog.

## 2. Shared contract (`packages/ui/src/lib/claude/`)
- `types.ts`: doc comment of `Session.revert` (~92-93): "Set by the host while messages from `messageID` onward are reverted (hidden) and not yet committed. Cleared by unrevert or the next send." Host sets only `{messageID}`. Add:
```ts
export type RevertPreview = { files: string[]; insertions: number; deletions: number; filesError?: string };
export type RevertResult = { files: string[]; filesError?: string };
```
`files` relative to workspace cwd when inside it, else absolute.
- `protocol.ts` `ClaudeRequestMap` after `claude:session.fork`:
```ts
/** Dry run of the file rewind for reverting to `messageId` (main-session user message). May spawn a cold session's process; never interrupts. */
'claude:session.revertPreview': { payload: { sessionId: string; messageId: string }; response: RevertPreview };
/** Restores files (when possible) and hides `messageId` and everything after it until the next send (commit) or unrevert. Interrupts a busy turn first. */
'claude:session.revert': { payload: { sessionId: string; messageId: string }; response: RevertResult };
/** Restores the files saved by revert and shows the hidden messages again. No-op without a marker. */
'claude:session.unrevert': { payload: { sessionId: string }; response: void };
```
No new event types (use `session.updated`; on commit `message.removed` + `session.deleted` (children) + `session.updated` in one batch).
- `client.ts`: `revertPreview(sessionId, messageId)`, `revert(sessionId, messageId)`, `unrevert(sessionId)`.
- `features.ts`: `revert: true`.

## 3. Host (`packages/vscode/src/`)
- 3.1 `claude/sdk.ts` `ClaudeQuery`: `rewindFiles?(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>` (optional so fakes compile); re-export `RewindFilesResult`.
- 3.2 New `claude/transcriptCut.ts`: move `forkUuidOf` here; add `cutUuidBefore(messages, partsByMessage, index): string | undefined` (loop from index-1 down, first forkUuidOf hit). `fork()` uses it (no behaviour change).
- 3.3 New `claude/revertStore.ts` (no vscode imports; injectable fs):
```ts
export type RevertMarker = { uuid: string; resumeAt: string | null };
export const REVERT_KEY = 'claudekei.revertMarkers';
export const REVERT_CAP_BYTES = 100 * 1024 * 1024;
export class RevertStore {
  constructor(kv: KeyValueStore, rootDir: string);
  get(id: string): RevertMarker | undefined;
  set(id: string, m: RevertMarker): Promise<void>;
  /** Removes the marker and rm -rf <root>/<id>. */
  clear(id: string): Promise<void>;
  /** Adds paths not yet in manifest: blob = current bytes or null if missing. Stat all new paths first; if existing+new bytes > cap throw "Too much file data to keep for /redo (over 100 MB). Nothing was changed." Write blobs first, then manifest.json via tmp+rename. */
  capture(id: string, absPaths: string[]): Promise<void>;
  /** For each entry: blob → mkdir -p + write; null → unlink if present. Returns paths. */
  restore(id: string): Promise<string[]>;
  /** Deletes <root>/* dirs that have no marker. */
  sweep(): Promise<void>;
}
```
Manifest `{ files: Array<{ path: string; blob: string | null }> }`, blobs named `0`,`1`,….
- 3.4 `ClaudeSessionManager.ts`: options `storageDir?: string` ⇒ `RevertStore(options.store, join(storageDir,'revert'))` into `deps.revertStore`, `void sweep()`. `vscodeHost.ts`: pass `storageDir: (context.storageUri ?? context.globalStorageUri).fsPath`. Methods `revertPreview`, `revert`, `unrevert` (each `resolve()`; preview/revert also `if (!session.isLive) await this.makeRoom(session)` like send). `delete()`: `await revertStore?.clear(id)`. `trimSessions()`: skip `s.hasRevert`. `list()`: `(s.exists || s.isLive) && !seen.has(s.id)`.
- 3.5 `ClaudeSession.ts`: deps `revertStore?`; fields `revertMarker` (from store in ctor), `resumeAt`, `get hasRevert()`.
  - `ensureLoaded()`: if marker, find main message with `claudeUuid === marker.uuid` → `info.revert = {messageID: msg.id}`, `bucket.info = this.info`; not found → log warn, clear store, drop marker.
  - `spawn()`: `...(this.exists ? { resume: this.id, ...(this.resumeAt ? { resumeSessionAt: this.resumeAt } : {}) } : { sessionId: this.id })`.
  - `runPump()`: on `system/init` set `this.resumeAt = undefined` (spawn that dies before init keeps the cut).
  - `revertTarget(messageId)`: throw "Nothing to revert yet" if !exists; ensureLoaded; target must be main-bucket user message with claudeUuid and no instruction else "This message cannot be reverted"; return `{uuid, messageId, resumeAt: cutUuidBefore(...) ?? null}`.
  - `previewQuery()`: live → this.query, else spawn(); never interrupt. `idleQuery()`: if `live-busy`/`starting` → `await query?.interrupt().catch(()=>{})` then `closeProcess()`; spawn if not live. Both throw "This Claude Code version cannot rewind files" if rewindFiles missing.
  - `revertPreview(messageId)` (exclusive): dryRun; canRewind false → `{files:[],insertions:0,deletions:0,filesError: error ?? 'No file checkpoint for this message'}`, else display paths + counts.
  - `revert(messageId)` (exclusive): same target as marker → `{files:[]}`; `q = idleQuery()`; dry; if canRewind: abs paths (resolve against cwd) → `store.capture` (cap error propagates) → real rewind → files/filesError; else filesError from dry. Set marker `{uuid,resumeAt}` + store.set; `info.revert={messageID}`; publish session.updated; `deps.onActivity?.(this,'idle')`; return display paths + filesError.
  - `unrevert()` (exclusive): no marker → return; `store.restore`, `store.clear`, drop marker, `info.revert = undefined`, publish session.updated.
  - `send()`: after `await this.ensureLoaded()`: `if (this.revertMarker) await this.commitRevert()`.
  - `commitRevert()`: closeProcess(); if marker.resumeAt → `this.resumeAt = it`, else `deleteSession(id,{dir})` (ignore not found), `exists=false`, `setLifecycle('draft')`; events: `message.removed` for every main message with `id >= info.revert.messageID` (string compare like UI) and `session.deleted` for child buckets referenced by ToolPart `metadata.sessionID` in those messages + descendants by parentID; store.clear; drop marker; `info.revert = undefined`; publish all + session.updated in ONE batch.
- 3.6 `claude/history.ts` `replayEntries` (~99-116): keep only subagent transcripts whose `parent_tool_use_id` owner is in toolUseIds(main) ∪ toolUseIds(kept transcripts), fixed point; log skipped at debug.
- 3.7 `bridge-claude-runtime.ts`: add 3 routes to allowlist + switch, `requireString` for sessionId/messageId.

## 4. UI
- 4.1 `sync/session-actions.ts`: replace stubs. Extract `userMessageText(sessionId, messageId)` from `forkFromMessage` and reuse. `revertToMessage(sessionId, messageId): Promise<RevertResult>`: waitForConnectionOrThrow; text = userMessageText; result = claudeClient.revert; if current session === sessionId && text → `useInputStore.setState({pendingInputText: text, pendingInputMode: 'replace'})`; if filesError → `toast.warning(t('chat.revert.toast.filesNotRestored'), {description})`; return. No optimistic patch. `unrevertSession` → claudeClient.unrevert. Delete `phase2Toast` if unused.
- 4.2 `sync/session-ui-store.ts` handleSlashUndo/handleSlashRedo: port OpenKei verbatim (`/Users/kei/Projects/openkei/packages/ui/src/sync/session-ui-store.ts` ~1139-1196) with user-message list `getSyncMessages(sessionId).filter(m => m.role==='user' && m.claudeUuid && !m.instruction)` and i18n strings. Keep `computeSlashUndoTarget`/`computeSlashRedoAction`.
- 4.3 `components/chat/ChatInput.tsx` slash command handling (next to `clear`): `if ((commandName==='undo'||commandName==='redo') && currentSessionId && isFeatureEnabled('revert')) { await (undo ? handleSlashUndo : handleSlashRedo)(currentSessionId); scrollToBottom?.({instant:true, force:true}); return; }`
- 4.4 `CommandAutocomplete.tsx`: hoist duplicated `builtInCommands` into one module-level fn; when flag on and session has messages add `{id:'claudekei:undo', name:'undo', description:'Revert the last message and its file changes', isBuiltIn:true}` and `{id:'claudekei:redo', name:'redo', description:'Restore what /undo reverted', isBuiltIn:true}`.
- 4.5 `ChatMessage.tsx` (both onRevert sites): `onRevert={isFeatureEnabled('revert') && isUser && !isInstructionMessage && !!(message.info as UserMessage).claudeUuid ? handleRevert : undefined}`.
- 4.6 `TimelineDialog.tsx`: revert button only when `!currentSessionId.startsWith('sub_') && (message.info as UserMessage).claudeUuid`.
- 4.7 `RevertConfirmDialog.tsx`: on open+target call `claudeClient.revertPreview` (stale-response guard via request counter); busy state from `session_status[target.sessionId]`. Body (replace `subagentHelp`): loading spinner + `checkingFiles` (confirm disabled until settled); `filesError` → amber `filesUnavailable` + confirm label `confirmConversationOnly`; no files → `filesNone`; else `filesHeading({count})` + `+ins −del`, first 8 paths mono truncate, `moreFiles({count})`, then `filesNote`; busy → `busyNote`; preview request failure → existing error box, confirm stays enabled. `executeRevertConfirm`/`revertConfirmUtils.ts` unchanged.
- 4.8 i18n (en + same copied into es, pt-BR, uk, zh-CN), under the existing revert dialog keys:
  title "Revert to before this message?"; description "This message and everything after it will be hidden, and its text goes back into the composer. Sending a new message makes this permanent. Use /redo to undo the revert."; checkingFiles "Checking files…"; filesHeading "Files that will be restored ({count})"; filesNone "No file changes to restore."; filesUnavailable "Files can't be restored for this message ({error}). Only the conversation will be reverted."; filesNote "Only edits made by Claude's file tools are restored; changes from shell commands are not. Edits you made to these files since then are overwritten (/redo brings them back)."; busyNote "Claude's current reply will be stopped first."; moreFiles "and {count} more"; confirmConversationOnly "Revert conversation only"; `chat.revert.toast.filesNotRestored` "Files were not restored"; toasts undidTo "Undid to: {preview}", redidTo, restoredAll. Delete `subagentHelp`. `chat.timeline.help.undoToPoint` → "Revert to before this message (its text goes back into the composer)".
- 4.9 `lib/claude/mockRuntime.ts`: `reverted?` on MockSession. revertPreview: list filePath/path inputs of edit/write tool parts in messages >= messageId, insertions 3n deletions n. revert: set `session.revert={messageID}`, emit session.updated, return {files}. unrevert: clear + emit. send: if revert set → remove messages id >= messageID (+parts), emit message.removed each, clear revert, session.updated, same emit call, then continue.

## 5. Concurrency
All serialized by `exclusive`. Revert while busy interrupts+closes (pending permissions denied, running tools error via runPump finally). Preview never interrupts. Revert-only spawned process closed by idle timer. Reload: marker in workspaceState, resolved by uuid. trimSessions never evicts sessions with marker.

## 6. Edge cases
No file changes → conversation-only works, dialog `filesNone`. canRewind false → D7. Files edited outside Claude → overwritten but saved first, /redo restores; Bash changes never tracked. First message → resumeAt null, delete + fresh spawn same id. Same target as marker → no-op. Moving back/forward → any target; D5 guarantees full unrevert. Revert pending then send → commits last marker only. Marker uuid missing after reload → dropped with warning. Terminal continuation after revert → truncated too (known limitation). Queued-not-processed target → conversation-only.

## 7. Tests
Host (`fakes.ts`: FakeQuery `rewindFiles` driven by `rewind: Map<uuid,{dry,real,apply?()}>` recording calls):
1. `revertStore.test.ts` (tmpdir): capture keeps first copy + records absent; restore writes back + unlinks; cap throws before writing; clear; sweep.
2. `revert.test.ts` with `createHarness('multi-turn')`: a cold revert (one spawn with resume, no resumeSessionAt; dry before real; marker; session.updated revert set); b busy revert (interrupt, close, respawn); c canRewind false → filesError, no capture, marker set; d send after revert → close, next spawn has resumeSessionAt === cutUuidBefore, one batch with message.removed + session.deleted sub_ child + cleared marker, copy dir gone; e first-message revert then send → deleteSession, spawn uses sessionId; f unrevert restores files w/o spawn; g undo X then earlier Y then unrevert → head restored both; h revert Y then later Z then unrevert → head; i reload via second manager over shared store → revert.messageID = replayed id; stale uuid drops marker; j resumeAt cleared after init, kept if spawn fails pre-init; k trimSessions keeps marker sessions; list includes live !exists; l preview on busy does not interrupt.
3. `history.test.ts`: dead-branch subagent transcripts skipped incl. nested.
4. `manager.test.ts`: fork unchanged after extracting cutUuidBefore.
5. Bridge: new routes reject missing messageId.
UI: mock-runtime-flow (revert hides via useVisibleSessionMessages; send removes + clears; unrevert shows; /undo twice then /redo steps marker per computeSlash*); RevertConfirmDialog preview states; session-actions prefill only when current + filesError toast; no revert button in child sessions / instruction messages / without claudeUuid.

## 8. Out of scope
OpenKei cascade/lockRevertSessions, UI send guard, revert banner, assistant targets, hiding children before commit, terminal-continuation detection, resumeDropsTurn.

## 9. Plan B (only if S2 fails)
Commit: `forkSession(id,{dir, upToMessageId: resumeAt})` → newId, adopt like `fork()` (copy prefs), send to newId; first-message → `create()`. Clear marker/copy on old session (kept). Protocol: `claude:session.send` response gains `sessionId?`. UI `sendPrompt` (`lib/claude/send.ts`) → if differs, upsertSession + setCurrentSession. Cost: fork has no file history ⇒ later reverts conversation-only.
