# ClaudeKei

ClaudeKei is a personal-use VS Code extension for working with Claude directly inside your editor.

It is built on the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) and uses your local `claude login` session for authentication.

> Status: early scaffold (`0.1.0`). The codebase was just forked from OpenKei and the backend is still being migrated from OpenCode to the Claude Agent SDK, so some features and settings (for example `claudekei.apiUrl` and `claudekei.opencodeBinary`) still reflect the OpenCode-based origin.

## What it does

- Chat beside your code inside VS Code
- Add files and selected code to the composer quickly
- Run Agent Manager workflows in a dedicated panel
- Open sessions in editor tabs

## Requirements

- VS Code 1.85+
- [bun](https://bun.sh) and Node.js (see `.nvmrc`)
- Claude Code CLI authenticated locally via `claude login`

## Development

```bash
bun install
bun run vscode:build        # build extension + webview
bun run vscode:type-check   # type-check extension + webview
bun run vscode:dev          # launch an Extension Development Host
```

Optional overrides for `vscode:dev`:

```bash
OPENCHAMBER_VSCODE_BIN=cursor bun run vscode:dev
OPENCHAMBER_VSCODE_DEV_WORKSPACE=/path/to/workspace bun run vscode:dev
bun run vscode:dev /path/to/workspace
```

## Package locally

```bash
bun run vscode:build
bun run vscode:package
code --install-extension packages/vscode/claudekei-*.vsix
```

## Layout

- `packages/ui` - shared React UI (type-checked only; bundled by the extension webview)
- `packages/vscode` - the VS Code extension host code and webview entry

## Origin and license

ClaudeKei is derived from OpenKei, which is itself a fork of [OpenChamber](https://github.com/btriapitsyn/openchamber). All are MIT licensed. The original copyright notice is retained in `LICENSE`.
