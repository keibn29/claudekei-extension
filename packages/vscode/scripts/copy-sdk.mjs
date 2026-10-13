#!/usr/bin/env node
/**
 * Copies the Claude Agent SDK JS package next to the bundled extension:
 *
 *   dist/node_modules/@anthropic-ai/claude-agent-sdk/   (ESM entry, loaded via dynamic import())
 *
 * The native Claude Code binary (`claude-agent-sdk-<platform>-<arch>` packages) is deliberately NOT shipped: the
 * extension uses the `claude` CLI the user has installed (see resolveClaudeExecutable in src/claude/env.ts), which
 * keeps the VSIX small and universal (one package for macOS, Windows and Linux).
 *
 * Why the SDK is copied at all: it is ESM-only, so it cannot be inlined into the esbuild CJS bundle; esbuild
 * externalizes it and Node resolves it from dist/extension.js after installation. `vsce package --no-dependencies`
 * (which skips node_modules) still ships it because .vscodeignore re-includes dist/**.
 *
 * bun's isolated linker symlinks packages into node_modules/.bun, so the package is copied with symlinks
 * dereferenced. The whole @anthropic-ai scope under dist/node_modules is wiped first so stale platform packages
 * from earlier builds never end up in the VSIX.
 */
import { cpSync, existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scope = '@anthropic-ai';
const sdkName = 'claude-agent-sdk';

const sdkLink = join(root, 'node_modules', scope, sdkName);
if (!existsSync(sdkLink)) {
  console.error(`copy-sdk: ${sdkLink} not found. Run \`bun install\` first.`);
  process.exit(1);
}

const destScope = join(root, 'dist', 'node_modules', scope);
rmSync(destScope, { recursive: true, force: true });
mkdirSync(destScope, { recursive: true });
cpSync(realpathSync(sdkLink), join(destScope, sdkName), { recursive: true, dereference: true });
console.log(`copy-sdk: ${scope}/${sdkName} -> dist/node_modules/${scope}/${sdkName}`);
