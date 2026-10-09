#!/usr/bin/env node
/**
 * Builds a platform-specific VSIX (the Claude Agent SDK ships a native binary per os/cpu).
 * vsce runs `vscode:prepublish` (the full build, including scripts/copy-sdk.mjs) before packaging.
 *
 *   bun run package                 # target = current platform, e.g. darwin-arm64
 *   bun run package -- --target linux-x64   # only works if that platform's binary package was copied
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extra = process.argv.slice(2);
const args = ['vsce', 'package', '--no-dependencies'];
if (!extra.includes('--target')) args.push('--target', `${process.platform}-${process.arch}`);
args.push(...extra);

const vsce = resolve(root, 'node_modules', '.bin', 'vsce');
const result = spawnSync(vsce, args.slice(1), { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
