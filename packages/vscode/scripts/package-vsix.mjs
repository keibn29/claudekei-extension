#!/usr/bin/env node
/**
 * Builds the universal VSIX (no native binary inside: the extension uses the user's installed `claude` CLI).
 * vsce runs `vscode:prepublish` (the full build, including scripts/copy-sdk.mjs) before packaging.
 *
 *   bun run package                      # claudekei-<version>.vsix, works on every platform
 *   bun run package -- --pre-release     # extra arguments are passed through to `vsce package`
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extra = process.argv.slice(2);
const args = ['vsce', 'package', '--no-dependencies'];
args.push(...extra);

const vsce = resolve(root, 'node_modules', '.bin', 'vsce');
const result = spawnSync(vsce, args.slice(1), { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
