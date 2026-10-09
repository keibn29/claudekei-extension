# VS Code Backend Modules

This document describes backend runtime modules used by the VS Code extension bridge (`packages/vscode/src/bridge.ts`).

## Purpose

Keep `bridge.ts` as a thin orchestration layer that delegates message handling to cohesive domain runtimes while preserving API behavior.

## Runtime modules

- `bridge.ts`
  - Entry orchestration layer for bridge messages.
  - Delegates to specialized runtimes in order and handles only unmatched fallthrough cases.

- `bridge-git-runtime.ts`
  - Standard Git message handlers.

- `bridge-claude-runtime.ts`
  - Handles every `claude:*` request of the shared protocol (`packages/ui/src/lib/claude/protocol.ts`) against the session host (`src/claude/ClaudeSessionManager.ts`). First in the chain.

- `bridge-git-special-runtime.ts`
  - Specialized Git flows (`conflict-details`; PR description generation is not available yet).

- `bridge-git-process-runtime.ts`
  - Git process execution and environment setup (`execGit`), including SSH agent socket resolution.

- `bridge-fs-runtime.ts`
  - Bridge handlers for filesystem-related message routes.
  - Uses shared FS helpers via injected dependencies.

- `bridge-fs-helpers-runtime.ts`
  - Filesystem/path/search helper functions:
    - path normalization and resolution
    - directory listing
    - file search
    - file read path safety checks
    - dropped-file parsing and attachment reading
    - models metadata fetch helper

- `bridge-config-runtime.ts`
  - UI settings, magic prompts and read-only stubs for hidden config sections (`api:config/*`).

- `bridge-settings-runtime.ts`
  - Settings read/write for bridge consumers.

- `bridge-system-runtime.ts`
  - System/editor/notification/update-check message handlers.

## Claude session host (`src/claude/`)

Vscode-free core (testable headless): `ClaudeSessionManager` (sessions, catalog, live cap, idle timeout), `ClaudeSession` (one streaming `Query`), `mapper.ts` (SDK messages -> events), `history.ts`, `permissions.ts` (`canUseTool` prompts), `broadcaster.ts` (16 ms batches, per-webview `seq`), `catalog.ts`, `env.ts`, `agentSettings.ts`. `vscodeHost.ts` is the thin vscode adapter.

## Extension guideline

When adding new bridge route families:

1. Prefer creating or extending a domain runtime module under `packages/vscode/src/bridge-*-runtime.ts`.
2. Keep `bridge.ts` focused on delegation order and minimal fallthrough behavior.
3. Inject dependencies into runtimes instead of reaching into unrelated modules directly.
