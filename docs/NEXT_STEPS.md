# ClaudeKei: trạng thái & việc cần làm tiếp

> Cập nhật: 2026-10-10. Đọc file này trước khi tiếp tục. Thiết kế chi tiết ở các file docs khác (xem cuối file).

## 1. Trạng thái hiện tại

**ClaudeKei** là extension VS Code fork từ OpenKei (OpenChamber, MIT). Backend OpenCode đã được thay bằng **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk@0.3.295`, kèm Claude Code CLI 2.1.295). Extension chỉ dùng cá nhân, đăng nhập bằng `claude login`, **không publish lên Marketplace**.

Các phần đã hoàn thành:
- **Phase 1:**
  - Chat streaming (text + thinking), hiển thị tool, cấp quyền / hỏi lại (AskUserQuestion), plan mode (ExitPlanMode).
  - Session: list / resume / fork / rename / delete.
  - Chọn model, diff, @file, ảnh đính kèm, slash command, interrupt.
- **Phase 1.1:**
  - **Subagent:** mỗi subagent là một session con. Lời gọi `Agent` và `SendMessage` hiện thành thẻ với 5 hành động gần nhất (realtime). Gọi nhiều subagent cùng lúc thì các thẻ được nhóm lại. Session con có các khối chỉ thị "From Orchestrator #n" căn phải.
  - **Đổi agent tại chỗ (phương án B):** Shift+Tab đổi primary agent của plugin claudekei. Lượt gửi sau khởi động lại CLI với `resume`, `agent` mới và `systemPrompt.snapshot:false`. Transcript có divider "Switched to …", vẫn còn sau reload.
  - **Model/effort theo agent:** đọc từ `primaryAgents` trong `claudekei.jsonc`. Composer có nút model và nút effort riêng (Cmd+Shift+T đổi effort). Tiêu đề câu trả lời hiển thị `Opus 5.5 [Agent] [High]`.
  - **Permission mode:** dropdown default / acceptEdits / plan / **bypassPermissions** (mặc định là bypass).
  - **Popup context window + usage limits** giống Claude desktop.
  - **Context window theo từng model:** đo thật trên probe, cache theo phiên bản SDK.
  - Code block shell có nút **Run** (chạy trong terminal "ClaudeKei") và **Copy**, luôn hiển thị.
- **Plugin `claudekei` 0.5.3** (repo `/Users/kei/Projects/claudekei-plugin`, đã publish):
  - Hook ưu tiên agent thật thay vì soft mode cũ.
  - Khoá `primaryAgents` (model/effort mặc định cho từng primary agent).
  - `presets` đổi tên thành `subAgents`; khoá `presets` vẫn đọc được, kèm cảnh báo deprecated.
  - Debugger dùng effort `xhigh`.

Kiểm thử gần nhất: host 288 test, UI 362 test, integration smoke với Claude thật 56/56. Type-check, lint và build đều sạch.

⚠️ **Repo ClaudeKei chưa có commit nào** (`git init`, chưa commit). Việc đầu tiên nên làm là tạo commit làm mốc.

## 2. Lệnh hay dùng

```bash
cd /Users/kei/Projects/claudekei-extension && bun run type-check:ui && bun run lint:ui && bun run vscode:type-check
```
```bash
cd /Users/kei/Projects/claudekei-extension && bun run --cwd packages/vscode test && bun test packages/ui/src
```
```bash
cd /Users/kei/Projects/claudekei-extension && bun run vscode:package
```
```bash
code --install-extension /Users/kei/Projects/claudekei-extension/packages/vscode/claudekei-darwin-arm64-0.1.0.vsix --force
```
Integration smoke (gọi Claude thật bằng Haiku, tốn usage):
```bash
cd /Users/kei/Projects/claudekei-extension/packages/vscode && bash scripts/run-integration-smoke.sh
```
Dev UI không cần host: chạy webview vite dev server với `?mock=claude&view=editor`. Kịch bản mock gồm `[mock:plan]`, `[mock:bash]`, `[mock:auth]`, `[mock:hook]`, `[mock:subagents]`, `[mock:code]`. Xem trong iframe rộng khoảng 360px (đừng resize xuống dưới 768px vì sẽ bật mobile mode).

## 3. Feature parity với OpenKei: những gì chưa làm

Đây là kết quả đối chiếu (2026-10-10) giữa danh sách tính năng người dùng thấy được trong OpenKei gốc (`/Users/kei/Projects/openkei`) với ClaudeKei hiện tại. Kế hoạch W0–W7 chỉ gồm Phase 1, nên các mục dưới đây là phần còn lại để ClaudeKei đạt mức "giống hệt OpenKei".

Phần lớn các tính năng này được ẩn bằng cờ trong `packages/ui/src/lib/claude/features.ts` (còn 3 cờ `providers`, `zen`, `updateCheck`, đều `false`; các cờ revert/agents/commands/mcp/skills/plugins/usage/quota đã bị xóa vì tính năng đã hoàn tất). Khi làm xong phần backend tương ứng thì bật cờ lên.

### 3.1 Phase 2 (2026-10-10): đã làm / đã xoá

**Đã triển khai:**
- Revert from here + `/undo` `/redo` + Timeline (Alt+T, nút đồng hồ trên header) + RevertConfirmDialog có preview file. Spec: `docs/REVERT_SPEC.md`.
- Settings: Agents / Commands / Skills (+ catalog qua git HTTPS) / MCP (+ dropdown) / Plugins, đọc ghi config Claude Code thật. Spec: `docs/SETTINGS_USAGE_SPEC.md`.
- Trang Usage (plan windows + pace, activity 24h/7d, link claude.ai) và nút "Details →" trong popup context.
- Stop main agent thì dừng luôn mọi subagent (mapper `stopRuns`, watchdog `stopTask`, `cancelQueued`). Xem `docs/STOP_SUBAGENTS_FIX.md`.
- Composer: đã thử TipTap rồi **rollback về textarea** theo yêu cầu (giữ `/undo` `/redo`, popup không nuốt Enter khi không có kết quả). `docs/COMPOSER_SPEC.md` giữ lại để tham khảo khi làm lại.
- Sửa lỗi cộng dồn cost (`total_cost_usd` là tổng tích luỹ theo query).

**Đã xoá khỏi source:** AI commit message / PR description, session trong editor tab / side panel, shell mode `!`, Agent Manager / Multi-run, worktree sessions, archive, GitHub, TTS / voice, scheduled tasks, OpenCode status dialog, share, custom project icons. Cờ còn lại trong `features.ts`: `providers`, `zen`, `updateCheck`.

**Cần test tay trên VS Code thật:** revert / redo với file thật, Stop khi có nhiều subagent song song, các trang Settings ở sidebar khoảng 360px, toggle MCP, install skill từ catalog.

### 3.2 Có trong OpenKei, chưa kiểm chứng trên ClaudeKei: cần test thủ công trên VS Code thật

Không bị stub trong code nhưng chưa ai thử end-to-end với backend Claude:
- **Thao tác trên tin nhắn:** copy message / code; fork from here (backend `claude:session.fork` đã có); Save as plan (đang ẩn trong VS Code, `MessageBody.tsx:1544`); Save as image; text selection menu ("Add to chat", "New session with selection", "Add to notes"); Timeline dialog (search, previous turn, fork from here).
- **Sidebar:** pin / unpin; folders kéo thả; move to folder; multi-select với bulk delete; display modes; search; rename; activity indicator; **Export Markdown** (kèm subagent: cần lấy dữ liệu từ session con mới).
- **PlanView:** Improve / Implement / Send to new session (magic prompts → `sendMessage`).
- **Composer:** focus mode (mod+shift+e); message queue; draft theo session; ArrowUp history; paste / drag file; @file / @agent / skill mention; inline comment drafts gửi kèm.
- **Magic-prompt "Summary" / "Workspace Review":** W6 đã gỡ handler local `/summary` `/review`. Cần quyết định có làm lại không (Claude Code có sẵn `/review`).
- **Header / layout:** command palette; quick open; go to line; keyboard shortcuts dialog; notes / todo panel; Files view; Diff tab; terminal dock (OpenKei VS Code vốn không nối).
- **Git view:** status / diff / commit / push / pull / fetch / branch / stash / rebase / merge / conflict / revert file (bridge còn nguyên, cần test); Git identities.
- **Notifications:** turn complete / subagent / error / question qua VS Code native. Phần AI summarization trong notification phụ thuộc magic prompt nên có thể lỗi giống 3.1 #2.
- **VS Code commands:** Explain / Improve Code / Add to Context (cmd+L) / Attach explorer file; open file / diff in editor từ tool card.
- **Settings OpenKei:** Visual (theme, font, spacing, chat render mode, diff layout…), Keyboard shortcuts rebinding, Defaults, Notifications, Session retention.

### 3.3 Bỏ hẳn (không có tương đương hoặc không cần)
- Multi-provider / Providers page / Zen free models / quota adapter của provider khác.
- OpenCode CLI settings, onboarding local / remote, remote instances, tunnel, passkey, PWA, update check của OpenChamber.
- Share link công khai (thay bằng Export Markdown).

## 4. Việc tồn đọng / lỗi nhỏ đã biết

**UI**
- [ ] Sidebar hẹp (~360px): thanh composer chật (effort / model / agent bị cắt chữ "Hi…", "Orchestr…"). **Chưa quyết định:** thu nút effort thành icon + chữ cái khi hẹp, hay để nguyên.
- [ ] Cold session: popup context hiện **ước lượng trên 200K** cho đến lượt chat đầu tiên. Người dùng đã chấp nhận, đã huỷ việc sửa. Nếu làm lại: ước lượng theo window đã đo của model, hoặc đo exact bằng probe.
- [ ] Mobile/compact layout: các phần effort / model / Run chưa xem trực quan.
- [ ] Popup context: "Skills" và "MCP tools" trùng màu trên theme tối. Header.tsx và MobileSessionStatusBar vẫn hiển thị kiểu cũ.
- [ ] Gộp nhóm subagent chỉ trong cùng một assistant message. Sorted render mode gộp hết subagent của message. Sidebar chưa có chấm trạng thái subagent.
- [ ] Theme luôn dark (giống OpenKei, `ThemeSystemContext` hard-code `dracula-dark`).
- [ ] Shift+Tab bị giữ trong textarea (giống OpenKei).
- [ ] Các trang settings ẩn, các store CRUD và chuỗi i18n cũ của OpenCode vẫn còn trong code. Dọn khi làm Phase 2 #4.
- [ ] Còn nhiều định danh `openchamber` (window globals, package `@openchamber/ui`, i18n keys) và code desktop `@tauri-apps/api`. Dọn dần.
- [ ] `extension.jpg` và `assets/app-icon.png` vẫn là branding OpenKei. Link GitHub trong `package.json` và AboutDialog vẫn trỏ về repo openkei.

**Host**
- [ ] Session tạo trước khi có agentLog không khôi phục được divider / effort cũ. Fork không mang theo agent / effort từng lượt (SDK remap uuid).
- [ ] `SendMessage` vào subagent **đang chạy** chưa có recording thật, mới test synthetic.
- [ ] Trạng thái logged-out mới test bằng fake account. Rule phát hiện là đoán.
- [ ] Phụ thuộc biến môi trường **không có trong tài liệu**: `CLAUDE_CODE_ENABLE_TASKS=false` (để có TodoWrite) và `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. Ngoài ra dùng API `usage_EXPERIMENTAL_MAY_CHANGE…`. **Phải kiểm tra lại mỗi lần nâng SDK** (chạy `scripts/record-all.sh` để ghi fixture mới, rồi chạy test golden và smoke).
- [ ] Chỉ đóng gói **darwin-arm64**. VSIX khoảng 115 MB vì chứa binary Claude Code.
- [ ] Dọn rác: khoảng 90 session test trong `~/.claude/projects/-private-tmp-claude-501-…-fixture-sandbox/`, xoá an toàn.

## 5. Quyết định quan trọng đã chốt (đừng đảo ngược khi chưa cân nhắc)
- **Sync layer Claude-native** (không giả lập API OpenCode). Host giữ toàn bộ state, webview chỉ hiển thị. Push event qua `claude:events` có `seq`.
- **Đổi agent tại chỗ** = restart CLI kèm `resume`, `agent` mới và `systemPrompt.snapshot:false`. Shift+Tab đổi agent. Permission mode chỉ đổi qua dropdown.
- **Effort của primary agent chỉ để trong `claudekei.jsonc`**, không đặt trong frontmatter `agents/*.md` (nếu đặt sẽ đè effort của session).
- **Load full user config** (`settingSources: user/project/local`). PATH lấy từ login shell để hook plugin chạy được.
- **Bypass permissions mặc định** (setting `claudekei.defaultPermissionMode`, chặn bằng `claudekei.allowBypassPermissions`). Nút Run chạy lệnh ngay khi người dùng click.
- `vscode:command` từ webview có **allowlist**. Chạy terminal dùng route riêng `claude:terminal.run`.

## 6. Settings của extension
`claudekei.useApiKey`, `claudeExecutablePath`, `maxLiveSessions` (3), `idleTimeoutMinutes` (10), `primaryAgents` (override metadata hiển thị), `allowBypassPermissions` (true), `defaultPermissionMode` (bypassPermissions).

Cấu hình plugin: `~/.claude/claudekei.jsonc` (đã chuyển sang `subAgents` + `primaryAgents`). Project có thể override bằng `.claude/claudekei.jsonc`.

## 7. Bản đồ tài liệu & code
- `docs/PHASE1_PLAN.md`: kiến trúc gốc và amendments A1/A2.
- `docs/W0_SPIKE_NOTES.md`: SDK thực tế khác tài liệu chỗ nào.
- `docs/PHASE1_1_SUBAGENTS_AGENTSWITCH_NOTES.md`: thực nghiệm về subagent / SendMessage / đổi agent.
- `docs/PHASE1_1_UI_SPEC.md`: spec UI subagent và đổi agent.
- **Host:** `packages/vscode/src/claude/`
  - `ClaudeSessionManager.ts`, `ClaudeSession.ts`: lifecycle.
  - `mapper.ts`, `sessionState.ts`, `history.ts`: chuyển SDK message thành event.
  - `permissions.ts`, `catalog.ts`, `claudekeiConfig.ts`, `agentLog.ts`, `contextUsage.ts`, `usageLimits.ts`, `env.ts`.
  - `__fixtures__/`: recording thật.
- **Bridge:** `packages/vscode/src/bridge-claude-runtime.ts`.
- **Contract dùng chung:** `packages/ui/src/lib/claude/{types,protocol,toolNames}.ts`.
- **UI sync:** `packages/ui/src/sync/` (`claude-event-source`, `event-reducer`, `sync-context`, …).
- **Mock:** `packages/ui/src/lib/claude/mockRuntime.ts`.

## 8. Gợi ý thứ tự cho ngày mai
1. Commit mốc hiện tại.
2. Quyết định cách xử lý composer khi sidebar hẹp.
3. Làm mục "Dọn nhanh" ở 3.1 (ẩn nút / lệnh không hoạt động).
4. 3.1 #1 Revert / undo-redo, rồi #2 AI commit message / PR description, rồi #3 Session trong editor tab.
5. Chạy checklist test thủ công 3.2 trên VS Code thật, ghi lỗi thành task.
6. 3.1 #5 Settings MCP / skills / plugins kèm dọn code OpenCode cũ.
7. Dọn branding và định danh `openchamber`.
