# ClaudeKei VS Code Extension

ClaudeKei brings Claude into VS Code with a focused, editor-native workflow. It is a personal-use extension built on the Claude Agent SDK and authenticates through your local `claude login` session.

> Requires the Claude Code CLI (`claude`) installed on your machine: `curl -fsSL https://claude.ai/install.sh | bash` (macOS/Linux), `irm https://claude.ai/install.ps1 | iex` (Windows) or `npm install -g @anthropic-ai/claude-code`. The extension does not bundle it; it is found on your login-shell PATH or in the usual install locations (override with `claudekei.claudeExecutablePath`).

> Status: early scaffold (`0.1.0`). Sessions run on the Claude Agent SDK; the extension host owns every Claude process and the webviews are subscribers.

## Features

- Chat directly beside your code
- Open sessions in editor tabs
- Run Agent Manager comparisons in parallel
- Add selected code or files into the composer quickly

## Commands

| Command | Description |
|---------|-------------|
| `ClaudeKei: Focus Chat` | Focus the chat panel |
| `ClaudeKei: New Session` | Start a new chat session |
| `ClaudeKei: Open Sidebar` | Open the ClaudeKei sidebar |
| `ClaudeKei: Open Agent Manager` | Launch parallel multi-model runs |
| `ClaudeKei: Open Session in Editor` | Open current or new session in an editor tab |
| `ClaudeKei: Settings` | Open extension settings |
| `ClaudeKei: Restart Claude Sessions` | Close every live Claude process (they resume on the next message) |
| `ClaudeKei: Show Claude Status` | Account, executable, PATH (`node` for plugin hooks), catalog and live-session diagnostics |
| `ClaudeKei: Claude Login` | Open a terminal running `claude login` with the resolved executable |
| `ClaudeKei: Cycle Primary Agent` | Shift+Tab: cycle the main-thread agent (claudekei plugin primary agents) |
| `ClaudeKei: Cycle Permission Mode` | default / acceptEdits / plan |
| `ClaudeKei: Dev: Replay Recorded Session Fixture` | Replay a recorded session without API cost (Extension Development Host only) |

## Shortcuts

- `Cmd+L` on macOS / `Ctrl+L` on Windows/Linux: insert the current selection into the chat composer as a file-range mention

## Editor context menu

Select code in the editor, right-click, and use the **ClaudeKei** submenu:

- Add to Context
- Explain
- Improve Code

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `claudekei.useApiKey` | `false` | Use `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` instead of the subscription login. |
| `claudekei.claudeExecutablePath` | _(empty)_ | Absolute path to a `claude` executable. Empty = auto-detect the installed `claude` CLI. |
| `claudekei.maxLiveSessions` | `3` | Max live Claude processes; least recently used idle ones are closed first. |
| `claudekei.idleTimeoutMinutes` | `10` | Close an idle session's process after this many minutes (0 = never). |
| `claudekei.primaryAgents` | `[]` | Order/labels/colors of the primary agents (empty = auto-detect the claudekei plugin agents). |

## Requirements

- VS Code 1.85+
- Claude Code CLI installed and logged in on this machine (`claude login`); the extension does not bundle it
- The `claudekei` Claude Code plugin enabled in `~/.claude/settings.json` for primary-agent cycling

## License

MIT. Derived from OpenKei / OpenChamber (MIT); original copyright retained in `LICENSE`.
