# ClaudeKei composer (TipTap / ProseMirror) - UX and behaviour spec

Status: design spec (no implementation). Owner: design. Implementer: @frontend-developer.
Replaces the `<Textarea>` in `packages/ui/src/components/chat/ChatInput.tsx`. Reference behaviour: the Claude desktop app composer. Width budget: sidebar 300-450px (design at 360px).
Ignore: shell mode, voice/mic, GitHub pickers (being removed by another developer).

Owner's hard requirements (acceptance gate):
1. Typing ```` ``` ```` then Shift+Enter or Enter immediately creates a real, rendered, highlighted code block in the input.
2. Shift+Enter always inserts a new line.

---

## 0. Principles and architecture decisions

- The doc model is deliberately tiny: `doc > (paragraph | codeBlock)+`, with inline nodes `text` and four atomic mention chips. **Everything else stays literal markdown text.** `**bold**`, `- item`, `> quote`, `# h1` are typed and sent as characters; they are not converted (see section 2).
- **One paragraph = one line.** Enter-style newlines split the paragraph. No `hardBreak`. Paragraph margin is 0, so it looks exactly like the old textarea. This makes `serialize(parse(s)) === s` lossless for plain text.
- `ChatInput` keeps its string contract: the editor emits `message: string` (markdown) on every update, and external `setMessage(...)` (clear after send, command select, history, draft restore) is pushed into the editor only if `serialize(editor) !== message` (loop guard). Everything downstream (`hasContent`, `handleSubmit`, `handleQueueMessage`, `composePromptText`, drafts, attachments) is unchanged.
- Remove or disable these StarterKit parts: Bold, Italic, Strike, Code (mark), Heading, BulletList, OrderedList, ListItem, Blockquote, HorizontalRule, HardBreak, Link, and any Typography/smart-quote extension. Keep: Document, Paragraph, Text, UndoRedo/History, Dropcursor, Gapcursor, Placeholder, plus custom CodeBlock, mention nodes, and a trailing-node rule (a paragraph always follows a code block).
- Packages (TipTap v3; in v3 Placeholder/Gapcursor/Dropcursor/TrailingNode ship in `@tiptap/extensions`, verify at install): `@tiptap/core`, `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extensions`. Syntax highlighting uses `prismjs` (already a dependency, same engine as chat).
- Editor root: `data-chat-input="true"` preserved (other code focuses/queries it).

---

## 1. Key behaviour

Evaluate in this exact order (this is the new `handleKeyDown` pipeline; maps to old `ChatInput.tsx:1716-1905`).

| # | Context | Key | Behaviour |
|---|---|---|---|
| 1 | Any | any key while `view.composing` or `keyCode === 229` | Do nothing (let IME finish). Keep the WebKit `keyCode === 229` guard (`isIMECompositionEvent`). Input rules never run during composition (ProseMirror default). |
| 2 | Autocomplete open (/, @file, @agent, skill) | Up, Down, Tab, Enter, Escape | Routed to the popup (`handleKeyDown(key)`), `preventDefault`. Same as today. |
| 2b | Autocomplete open | **Shift+Enter** | Close popup, insert new paragraph. (Shift+Enter is never captured by a popup.) |
| 3 | Paragraph, caret at end, text matches `^```([\w+#.-]*)$` | **Enter or Shift+Enter** | Convert the paragraph to a code block with that language, caret inside, empty. Does **not** send. This is the "``` then Enter" requirement. Shift+Enter and Enter behave identically here. |
| 3b | Same paragraph, user types a space | `` ```ts `` + Space | Input rule: same conversion (the space is consumed). `` ``` `` + Space = no language. |
| 4 | Normal paragraph | **Shift+Enter** | Always: split paragraph at caret (new line). Never sends, never queues. |
| 5 | Normal paragraph | **Enter** | Send / queue per queue-mode table below. No-op when composer is empty. On mobile (`isMobile`): Enter inserts a new paragraph; only Cmd/Ctrl+Enter or the send button sends (existing behaviour). |
| 6 | Anywhere, including code block | **Cmd/Ctrl+Enter** | The "alternate" send action per queue-mode table below. |
| 7 | Code block | **Enter** | Newline inside the block (never sends). |
| 7b | Code block | **Shift+Enter** | Newline inside the block (same as Enter). |
| 7c | Code block, caret at end, content ends with `\n\n` (two empty lines) | **Enter** | "Triple Enter": delete the two trailing newlines and exit to the paragraph after the block. |
| 7d | Code block, caret on a line that is exactly ```` ``` ```` | **Enter** | "Closing fence": delete that line and exit to the paragraph after the block. (Muscle memory from markdown.) |
| 7e | Code block, caret on last line / at end | **ArrowDown, ArrowRight at end** | Move to the paragraph after the block (always exists via trailing node). |
| 7f | Code block is the first node, caret at offset 0 | **ArrowUp, ArrowLeft** | Gapcursor before the block; typing there creates a paragraph above. |
| 7g | Code block | **Escape** (no popup open) | Exit to the paragraph after the block (keyboard escape hatch for Tab trap). |
| 8 | Code block | **Tab** | No selection or single-line selection: insert 2 spaces. Multi-line selection: indent each selected line by 2 spaces. `preventDefault`. |
| 8b | Code block | **Shift+Tab** | Outdent current/selected lines by up to 2 spaces. If no line has leading whitespace, fall through to agent cycling (row 14), so the shortcut is never dead. |
| 9 | Code block, caret at offset 0 of the block, empty selection | **Backspace** | Empty block: replace with an empty paragraph. Non-empty block: unwrap, each line becomes a paragraph, language dropped. |
| 9b | Code block, Delete at end of the last line | Delete | No-op (does not merge into the following paragraph; avoids accidental fence loss). |
| 10 | Chip (mention) adjacent to caret | **Backspace / Delete** | Delete the whole chip (atomic). If the char after the chip is a single space, delete it too (matches current `removeUntil` behaviour). Also remove it from `confirmedMentionsRef`. |
| 11 | Expanded ("focus") mode, no popup, not in code block | **Escape** | Collapse expanded input (`setExpandedInput(false)`). Escape priority: popup > exit code block > collapse expanded. Never blur the editor. Do not stop propagation if nothing was consumed (global abort/escape handlers keep working). |
| 12 | Outside code block, VS Code runtime | **Shift+Tab** | `handleCycleAgent()`, `preventDefault`. Plain Tab keeps default focus navigation (not trapped). |
| 13 | Outside code block, non-VS Code runtime | **Tab** | `handleCycleAgent()` (existing behaviour) unless a popup is open. |
| 14 | Selection is empty, caret at doc start (offset 0 of the first textblock) or doc empty, **not in code block**, no popup | **ArrowUp** | History older (see below). Strict "offset 0" semantics, same as today; wrapped-line first row does not trigger it. |
| 14b | Caret at doc end or doc empty, `historyIndex >= 0`, not in code block, no popup | **ArrowDown** | History newer / restore draft. |
| 15 | Any | Cmd/Ctrl+Z, Shift+Cmd+Z / Ctrl+Y | Undo / redo (editor history). Cleared after send, after history recall, and after draft restore. |
| 16 | Any | Cmd/Ctrl+Alt+C | Toggle code block on the current paragraph (convenience, matches TipTap default). |
| 17 | Any | Cmd/Ctrl+B/I/K etc. | Not bound (no rich text). Let VS Code handle. |

### Queue-mode semantics (unchanged logic, rows 5 and 6)

`canQueue = !composerInteractionDisabled && hasContent && currentSessionId && sessionPhase !== 'idle'`.

| `queueModeEnabled` | Enter | Cmd/Ctrl+Enter |
|---|---|---|
| true | `canQueue ? queue : send` | send |
| false | send | `canQueue ? queue : send` |

Enter inside a code block never reaches this table; Cmd/Ctrl+Enter does. Show the hint in the footer/tooltip: "Enter to send, Shift+Enter for new line" (and when inside a code block: "Cmd+Enter to send").

### History (rows 14 and 14b)

- Entering history: store current markdown in `draftMessage`, load `userMessageHistory[0]` into the editor (parsed from markdown, section 5), caret at doc start (as today `setSelectionRange(0,0)`).
- Older: ArrowUp again at doc start. Newer: ArrowDown at doc end. Leaving index 0 restores `draftMessage`.
- If a recalled message starts with a code block, ArrowUp at its start does nothing (not in history mode logic) because the caret is in a code block; use row 7f/gapcursor or click. Accepted trade-off.
- Any user edit while `historyIndex >= 0` keeps the index (same as today).

---

## 2. Markdown input rules and paste

### Supported conversions (minimal set, matches Claude desktop)

| Input | Result |
|---|---|
| ```` ```lang ```` + Enter / Shift+Enter / Space at paragraph start | Code block (rows 3, 3b). Language optional, charset `[\w+#.-]`, lowercased for matching, stored as typed. |
| `` `text` `` (closing backtick typed) | **Visual only**: a ProseMirror inline decoration styles the span as inline code (mono font, `--markdown-inline-code-bg`, backticks stay visible at reduced opacity). The text stays literal backticks, so serialization is a no-op and Backspace/undo behave naturally. Decoration pattern: single backticks, same paragraph, non-empty, not adjacent to another backtick. Not applied inside code blocks. |

### Explicitly NOT supported (stay literal text, no input rules)

`**bold**`, `*italic*`, `~~strike~~`, `- ` / `1. ` lists, `> ` blockquote, `# ` headings, `---`, links, tables. Reason: the composer sends markdown source; Claude reads it fine, and conversion would create round-trip and Backspace-undo problems and a second "formatting" mental model in a 360px panel. Revisit later only if the owner asks.
Note: pressing Enter after `- foo` just sends/newlines; no list continuation.

### Paste

- Text: always **plain text** (`text/plain`); ignore `text/html` (VS Code puts colored HTML on the clipboard). Normalize `\r\n`/`\r` to `\n`. Tabs preserved.
- Multi-line plain text outside a code block: one paragraph per line, blank lines preserved.
- Text containing line-start fences (` ```lang ... ``` `): parsed with the same markdown parser as draft restore (section 5), producing code blocks + paragraphs. Unterminated fence: block runs to the end of the pasted text.
- Paste while the caret is **inside a code block**: insert the raw text (newlines stay in the block); no fence parsing (a pasted fenced snippet stays literal).
- Selection non-empty: replaced. Cmd/Ctrl+Shift+V behaves the same (no special "paste and match" needed).
- No auto-detection of code without fences; no auto-link; no auto-attachment of long text (out of scope).
- Images/files: **unchanged**. In `handlePaste`, read `clipboardData.files/items` first; if there are image files call `addAttachedFile` and `preventDefault`; otherwise fall through to the text path. Same `(!currentSessionId && !newSessionDraftOpen)` guard.
- Copy/cut: set `clipboardTextSerializer` to the markdown serializer (code blocks come out fenced, chips as `@path`), so copy then paste round-trips. Do not write `text/html`.
- Drag and drop: existing container handlers (`onDropCapture`, `dropZoneRef`, ring-2 ring-primary while dragging) stay on the wrapper. Dropped file paths insert a file chip + space (today inserts `@path `); dropped text inserts plain text; images attach as today.

---

## 3. Visual design

Keep the existing composer shell untouched: outer container `border border-border/80`, `borderRadius: var(--radius-xl)`, `backgroundColor: surface.subtle`, `focus-within:ring-1 ring-primary/50`, drag ring, footer. Only the inner `<Textarea>` + highlight overlay (`composerHighlightRef`, `:3649-3735`) are replaced by `<EditorContent>`. The overlay and `text-transparent caret` hack are deleted (colors now come from real nodes).

### Editor surface (replaces textarea)

- Typography: `typography-markdown md:typography-ui-label` (same as today). Padding: desktop `pt-4 pb-2 px-3`, mobile `py-2.5 px-3`, expanded `py-4 px-3`. `min-height: 52px`. `caret-color: var(--surface-foreground)`.
- Paragraph: margin 0; `white-space: pre-wrap; overflow-wrap: anywhere`.
- Selection: existing global `::selection` (primary 22%).
- Placeholder: i18n keys unchanged (`chat.chatInput.placeholder.chat` / `selectSession`). Rendered by the Placeholder extension on the first empty paragraph only (`showOnlyWhenEditable`), color `var(--surface-muted-foreground)`, `pointer-events: none`. Disappears on first character; not shown inside a code block. (Shell variant dropped with shell mode.)
- Auto-grow: no JS measuring. CSS only: `max-height: max(calc(8 * 1lh + padding), min(40dvh, 20rem))`; i.e. at least the old 8 lines, grows to 40% of the panel height capped at 20rem (code blocks need more room than prose); `overflow-y: auto; overscroll-behavior: contain` on the editor scroller. Delete `adjustTextareaHeight`, `textareaSize`, `MAX_VISIBLE_TEXTAREA_LINES` logic. ProseMirror scrolls the caret into view (set `scrollMargin`/`scrollThreshold` ~ 24px).
- Focus (expanded) mode: `isDesktopExpanded` -> editor `flex: 1; height: 100%; max-height: none`, code block max-height raised to `60dvh`. Esc collapses (row 11). Toggle button unchanged.
- Disabled (`composerInteractionDisabled` or no session and no new draft): `editable: false`, wrapper keeps `pointer-events-none opacity-60`, `aria-disabled="true"`.
- Spellcheck/autocorrect: root attrs follow existing props (`spellCheck={isMobile || inputSpellcheckEnabled}`, `autoCorrect/autoCapitalize` off on desktop). Code blocks always `spellcheck="false"`.

### Code block (NodeView with React or plain DOM)

```
+----------------------------------------------+  radius var(--radius-md) (0.5rem), 1px var(--interactive-border)
| typescript                              [copy]|  header 28px, surface-muted bg, border-bottom interactive-border
|----------------------------------------------|
| const a = 1;                                  |  body: surface-background bg, px-3 py-2
| ...                                           |
+----------------------------------------------+
```

- Chat uses `--surface-background` body, `--surface-muted` header, `--interactive-border`, radius 0.75rem (`.markdown-content [data-markdown="code-block"]`). The composer block mirrors that so a sent code block looks like the rendered one. Radius is `--radius-md` because it is nested inside the `--radius-xl` shell.
- Margin `0.375rem 0` (only vertical spacing on the block; paragraphs have none). First/last child margins collapse to 0.
- Font: `var(--font-mono)`, `font-size: var(--text-code)` (0.8125rem), `line-height: 1.5`, `tab-size: 2`, `white-space: pre`, **no wrap**, `overflow-x: auto` (horizontal scroll is the right trade-off at 360px).
- Max height: `12rem` (about 10 lines) then the **block body** scrolls vertically (`overflow-y: auto`, thin scrollbar, `overscroll-behavior: auto` so wheel chains to the editor scroller at the ends). Expanded mode: `60dvh`.
- Header (`contenteditable="false"`, NodeView chrome, `user-select: none`):
  - Left: language label, `typography-micro`, mono, `--surface-muted-foreground`; shows `text` when empty. Click opens a small listbox (popover) of ~16 languages + "Plain text" (typescript, javascript, tsx, jsx, json, bash, python, css, html, yaml, diff, sql, go, rust, java, markdown). Selecting sets the `language` attr. Free-text language typed via the fence is kept even if not in the list.
  - Right: copy-code icon button (Remix `RiFileCopyLine`; check icon + "Copied" tooltip 1.2s). Visible on hover and `focus-within`; **always visible on touch/mobile**. Hit area 28px desktop, 32px mobile.
  - Header buttons have `tabindex="-1"` (so Tab inside the editor never lands on them; keyboard users set language by typing the fence, copy via selection).
- Focus: when the caret is inside the block, border becomes `color-mix(in srgb, var(--primary) 40%, var(--interactive-border))` (same recipe as index.css:1371ff). No extra outer ring (composer shell already has one).
- Empty block shows a faint placeholder line "Code" in the body (decoration, `--surface-muted-foreground`), so the freshly created block is not a blank rectangle.
- Entry motion: 120ms opacity/translateY(2px) fade when a block is created by the fence rule only; none on draft restore; respect `prefers-reduced-motion`.

### Syntax highlighting

- Engine: `prismjs` (the same Prism family as the chat renderer `MarkdownRendererImpl.tsx` via react-syntax-highlighter), producing ProseMirror **inline decorations** (`Prism.tokenize` -> flatten nested tokens to `{from,to,type}` -> `Decoration.inline(from,to,{class:'token <type>'})`). No DOM mutation of editable text.
- Colors: map token types to the existing theme variables, the same ones chat uses: `--syntax-comment`, `--syntax-keyword`, `--syntax-string`, `--syntax-number`, `--syntax-function`, `--syntax-variable`, `--syntax-type`, `--syntax-operator`, `--syntax-foreground` for default. Add one scoped stylesheet `.composer-codeblock .token.comment { color: var(--syntax-comment) }` etc. (mirror index.css:82-211). No hard-coded colors (VS Code webview theme is fixed).
- Language aliases for Prism lookup: `ts`->typescript, `js`->javascript, `sh|shell|zsh`->bash, `py`->python, `yml`->yaml, `md`->markdown, `html|xml|svg`->markup, `rs`->rust, `golang`->go. Unknown or empty language: no highlighting (plain mono).
- Perf: language grammars are **lazy** (`import('prismjs/components/prism-xxx')`) and cached; recompute decorations only for the code block whose content changed; skip highlighting when a block exceeds 20k characters; never block typing (decorations computed synchronously for small blocks, `requestIdleCallback` for large).

### Mention chips (visual)

- Inline, `display: inline`, `border-radius: var(--radius-sm)`, `padding: 0 0.25rem`, `margin: 0 1px`, background `color-mix(in srgb, <accent> 14%, transparent)`, text color `<accent>`, no border. Accent: file `--status-info`, agent `--status-success` (unchanged from the old overlay), command and skill `--primary`.
- Label: file = basename (folders keep trailing `/`), tooltip/`title` = full relative path; agent = `@name`; command/skill = `/name`. `max-width: 100%` with `text-overflow: ellipsis`; chips never break layout at 360px.
- Hover: bg 22%. Selected (node selection): `outline: 1px solid color-mix(in srgb, <accent> 50%, transparent)`.

---

## 4. Mentions, commands, skills

**Decision: all four are atomic inline chips (ProseMirror inline nodes, `atom: true`, `selectable: true`, `draggable: false`), created only through the existing autocompletes, file drops, and restore of known tokens.** Rationale: Claude desktop shows mention chips; atomic nodes give the "Backspace removes the whole token" behaviour natively and delete the fragile whitespace-token scanning at `ChatInput.tsx:1738-1783`; each serializes to the exact text form already sent.

| Kind | Node attrs | Serializes to | Created by |
|---|---|---|---|
| `fileMention` | `path` (relative) | `@<path>` | `FileMentionAutocomplete` select, file drop, restore |
| `agentMention` | `name` | `@<name>` | `AgentMentionAutocomplete` select, restore |
| `skillMention` | `name` | `/<name>` | `SkillAutocomplete` select, restore |
| `commandMention` | `name`, `metadata` (the `CommandInfo`, replaces `textarea._commandMetadata`) | `/<name>` | `CommandAutocomplete` select |

- After inserting a chip, insert one trailing space and place the caret after it (same as today `@path ` / `/skill `). Command chip is only valid as the **first node of the doc**.
- Typed-by-hand `@foo`, `/bar` that never went through a popup stay plain text (no auto-conversion while typing). They are still sent as the same text. They convert to chips on restore only if they pass the existing known-name checks (`knownAgentNamesRef`, `isConfirmedFilePath` / `confirmedMentionsRef`, known skill/command lists).
- Autocomplete trigger detection (replaces `updateAutocompleteState`, `:2135-2199`): run on every transaction with the selection. Text before the caret is taken from the **current textblock only**, with chips as `\u0000` so they never match. Same rules: `/command` only if the entire doc text starts with `/` and the caret is in the first paragraph before any space; `/skill` and `@` need a word boundary before the trigger and no whitespace after it. **Never trigger inside a code block**, inline-code decoration range, or while composing (IME).
- Selecting an item replaces the range `[triggerPos, caretPos]` with the chip + space (not the whole text).
- Popup anchor: `view.coordsAtPos(caretPos)` replaces `measureCaretInTextarea` / `updateAutocompleteOverlayPosition`. Popup placement/maxHeight logic (`:1960-2000`) stays.
- Chip a11y: `contenteditable="false"`, `role="img"`, `aria-label` = `"File src/a.ts"`, `"Agent reviewer"`, `"Skill name"`, `"Command name"`.
- Arrow keys move over a chip as one unit. Click selects it; Backspace/Delete removes it (row 10).

---

## 5. Serialization, drafts, history

### doc -> markdown (`serializeComposer(doc): string`)

- Blocks joined by `\n`. Paragraph = its text with chips expanded (table in section 4); empty paragraph = `''` (blank line preserved).
- Code block = `` ```<language>\n<content>\n``` `` where fence length = max(3, longest backtick run in content + 1). Empty block = `` ```lang\n\n``` ``. No extra blank lines are added around it: `intro\n```ts\ncode\n```\noutro`.
- Inline code decoration contributes nothing.
- Hard cap/trim: result is trimmed only at the ends by the existing `message.trim()`-style guard in submit. Never trim inside a code block (a block always ends with its closing fence, so end trimming is safe).
- `hasContent` = serialized string has non-whitespace; an empty code block alone does not count as content (`"```\n\n```"` is treated as empty so Enter/Send is disabled until there is code).
- `composePromptText` / `send.ts` need no change; the string is sent as-is (selection-context parts still append as fenced blocks).

### markdown -> doc (`parseComposerMarkdown(s): JSONContent`)

- Split on `\n` (normalize `\r\n`). Fence open: `^(`{3,})([^\s`]*)\s*$` at column 0. Close: a line of only backticks with length >= open length. Content lines become the code block text. Unterminated fence: block extends to the end of input.
- Every other line -> one paragraph (empty line -> empty paragraph). Indented fences, `~~~`, and fences inside lists are not code blocks (they stay text).
- Inside non-code lines, replace known tokens by chips (section 4 rules). Do not convert tokens inside inline code spans.
- Always append an empty trailing paragraph if the last node is a code block (trailing-node rule), but it serializes to nothing visible: ensure `serialize()` strips that one synthetic trailing empty paragraph so round trip stays exact.
- Idempotence goal: `serialize(parse(s)) === s` for any `s` with terminated fences; for unterminated fences the serializer adds the closing fence (acceptable normalization).

### Where it applies

- **Draft persistence** (`getDraftKey`, `saveStoredDraft`, debounce 500ms `CHAT_DRAFT_PERSIST_DEBOUNCE_MS`): store the markdown string under the same localStorage keys. No migration: old plain-text drafts are valid markdown. Restore = `parseComposerMarkdown`, then `setContent(json, { emitUpdate: false })` and clear undo history; caret at end (matches current `initialDraftRef` select behaviour per setting).
- **History recall** (ArrowUp/Down): same parser, history cleared so Cmd+Z does not step into the previous message; caret at doc start on ArrowUp.
- **Confirmed mentions** (`confirmedMentionsRef`, persisted via `loadConfirmedMentions`): unchanged; filter by `draft.includes('@'+path)` on the serialized string.
- **Clear after send**: `setMessage('')` -> editor `clearContent()` + history reset + keep focus.
- Switching sessions swaps drafts exactly as today (per-session key).

---

## 6. Accessibility and narrow layouts

- Editor root (`.ProseMirror`): `role="textbox"`, `aria-multiline="true"`, `aria-label` = new i18n key `chat.chatInput.ariaLabel` ("Message composer"), `aria-placeholder` = current placeholder text, `aria-disabled` when disabled, `aria-keyshortcuts="Enter Shift+Enter Control+Enter Meta+Enter"` optional. `tabindex="0"`.
- While an autocomplete is open: root gets `aria-haspopup="listbox"`, `aria-expanded="true"`, `aria-controls=<popupId>`, `aria-activedescendant=<optionId>`; popups need `role="listbox"` and `role="option"` ids (small change in the four autocomplete components; frontend-developer to confirm current markup). Announce the number of results via a visually hidden `aria-live="polite"` region.
- Code block wrapper: `role="group"`, `aria-label="Code block, <language or plain text>"`. Language and copy are mouse/touch affordances; language remains keyboard-settable through the fence, copy via select-all. No keyboard trap: Escape (7g) and ArrowDown (7e) exit; Tab only indents inside a code block, plain Tab (VS Code) outside it is default focus movement.
- Visible focus: the shell `focus-within:ring-1 ring-primary/50` stays the only focus indicator (do not remove outline on the editor without the shell ring). Contrast: token colors come from the theme `--syntax-*` set; chip text on tinted background must keep >= 4.5:1 (14% tint only).
- Respect `prefers-reduced-motion` (no entry animation).
- Narrow sidebar (300-450px, design at 360px):
  - Code block: full width of the content box, `white-space: pre` + horizontal scroll; header 28px with language label truncating (`min-width: 0; text-overflow: ellipsis`), copy button never shrinks.
  - Max height uses `dvh` and a 20rem cap so the composer never covers the whole chat in short panels; the autocomplete popup logic keeps using available space above/below the caret.
  - Chips `max-width: 100%` with ellipsis; paragraphs `overflow-wrap: anywhere` (long paths/URLs do not cause horizontal scroll in prose).
  - No horizontal scroll on the editor root itself; only code block bodies scroll horizontally.
  - Mobile/touch: Enter inserts newline, send via button or Cmd/Ctrl+Enter; touch targets in the code header 32px; copy button always visible.
- RTL/IME: do not run input rules or fence conversion during composition; test Korean and Japanese IME (Enter commits the composition, must not send or convert).

---

## 7. Implementation map (for @frontend-developer)

- New: `packages/ui/src/components/chat/composer/` with `ComposerEditor.tsx` (EditorContent wrapper, props: `value`, `onChange`, `onKeyAction`, `placeholder`, `disabled`, `expanded`), `extensions/{codeBlock,mentions,fenceTrigger,inlineCodeDecoration,prismDecorations,composerKeymap}.ts`, `markdown/{serialize,parse}.ts` (pure, unit-tested), `composer.css`.
- `ChatInput.tsx` changes: replace `<Textarea>` + overlay (`:3649-3735`); replace `handleKeyDown` (`:1716-1905`) by the TipTap keymap + the ordered pipeline above; replace `handleTextChange`/`adjustTextareaHeight`/`measureCaretInTextarea`/`updateAutocompleteState` (`:2078-2217`) with editor `onUpdate`/`onSelectionUpdate`; `handlePaste` (`:2343`) moves to editor `handlePaste` prop with images first; `handleFileSelect`, `handleAgentSelect`, `handleSkillSelect`, `handleCommandSelect` (`:2395-2530`) insert chips via `editor.chain().insertContentAt(range, [...]).run()`; drafts (`:573-590`, `:1192-1210`) and history (`:1830-1874`) call `loadMarkdown(md)`.
- Keep `textareaRef`-dependent consumers working by exposing an imperative handle: `focus()`, `getMarkdown()`, `setMarkdown()`, `insertTextAtCaret()`, `getCaretCoords()`, `isEmpty()`.
- Pure unit tests (Vitest): serializer/parser round trip (fences, nested backticks, unterminated, empty lines, chips), `fenceTrigger` regex, input rules, queue-mode table, history guards (in code block, not at start).
- Bundle: Prism languages lazy; no `lowlight`/highlight.js; no Markdown extension.

## 8. Acceptance checklist

1. Type ```` ``` ```` + Enter -> code block, caret inside, nothing sent. Same with Shift+Enter. ```` ```ts ```` + Enter -> block labelled `ts`, highlighted as TypeScript while typing.
2. Shift+Enter in any paragraph inserts a new line and never sends, including with a popup open and with a mention before the caret.
3. In a code block: Enter newline, Tab indents, Shift+Tab outdents, Cmd/Ctrl+Enter sends/queues, triple Enter / closing fence / ArrowDown / Escape exit, Backspace at start unwraps.
4. Pasting multi-line text keeps newlines; pasting a fenced snippet yields a code block; pasting an image attaches it; pasting inside a code block stays literal.
5. `@file` chip: select from popup -> chip; Backspace removes it whole; sent text is `@relative/path `.
6. History ArrowUp only at doc start outside code blocks; recalled message with a code block renders as a block; ArrowDown restores the draft.
7. Reload the panel: draft with code block and chips restores identically; sent message in chat shows a rendered code block (same markdown).
8. 360px width: no horizontal scroll on the composer, code blocks scroll internally, header controls usable by touch.
9. Korean/Japanese IME composition never triggers send, fence conversion or autocomplete selection.
