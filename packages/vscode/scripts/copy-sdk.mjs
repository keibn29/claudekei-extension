#!/usr/bin/env node
/**
 * Copies the Claude Agent SDK and its native platform binary package(s) next to the bundled extension:
 *
 *   dist/node_modules/@anthropic-ai/claude-agent-sdk/                 (ESM entry, loaded via dynamic import())
 *   dist/node_modules/@anthropic-ai/claude-agent-sdk-<platform-arch>/ (native `claude` binary)
 *
 * Why: the SDK is ESM-only and locates its native binary through `createRequire(import.meta.url)`, so it
 * cannot be inlined into the esbuild CJS bundle. Keeping both packages as siblings under
 * dist/node_modules lets Node resolve them from dist/extension.js after installation, while
 * `vsce package --no-dependencies` (which skips node_modules) still ships them because .vscodeignore
 * re-includes dist/**.
 *
 * bun's isolated linker symlinks packages into node_modules/.bun, so everything is copied with symlinks
 * dereferenced. Only platform packages that were actually installed (bun installs the one matching the
 * current os/cpu) are copied.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
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

// The real SDK directory; its platform packages live beside it (bun: node_modules/.bun/<pkg>/node_modules/@anthropic-ai).
const sdkReal = realpathSync(sdkLink);
const scopeDir = dirname(sdkReal);
const platformPackages = readdirSync(scopeDir).filter((name) => name.startsWith(`${sdkName}-`));
if (platformPackages.length === 0) {
  console.error(`copy-sdk: no ${sdkName}-<platform> binary package found next to ${sdkReal}. Was it installed with --omit=optional?`);
  process.exit(1);
}

const destScope = join(root, 'dist', 'node_modules', scope);

function copyPackage(name) {
  const from = realpathSync(join(scopeDir, name));
  const to = join(destScope, name);
  const marker = join(to, 'package.json');
  // Cheap idempotency: skip when the destination already has the same package.json size and a binary of the same size.
  const binary = name === sdkName ? undefined : join(from, 'claude');
  if (existsSync(marker) && statSync(marker).size === statSync(join(from, 'package.json')).size) {
    if (!binary || (existsSync(join(to, 'claude')) && statSync(join(to, 'claude')).size === statSync(binary).size)) {
      return 'up-to-date';
    }
  }
  rmSync(to, { recursive: true, force: true });
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, dereference: true });
  if (binary) chmodSync(join(to, 'claude'), 0o755);
  return 'copied';
}

for (const name of [sdkName, ...platformPackages]) {
  console.log(`copy-sdk: ${scope}/${name} -> dist/node_modules/${scope}/${name} (${copyPackage(name)})`);
}
