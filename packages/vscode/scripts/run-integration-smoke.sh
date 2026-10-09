#!/usr/bin/env bash
# Builds scripts/integration-smoke.ts next to the bundled SDK (dist/) and runs it under Electron's Node, like W0.
# Requires a prior `bun run build` (dist/node_modules with the SDK + binary). Makes ~15 short Haiku calls.
set -euo pipefail
cd "$(dirname "$0")/.."
CODE="${VSCODE_BIN:-/Applications/Visual Studio Code.app/Contents/MacOS/Code}"
node_modules/.bin/esbuild scripts/integration-smoke.ts --bundle --platform=node --format=esm --main-fields=module,main --banner:js="import {createRequire as __cr} from 'module'; const require = __cr(import.meta.url);" \
  --external:@anthropic-ai/claude-agent-sdk --external:vscode --outfile=dist/integration-smoke.mjs --log-level=warning
if [ -x "$CODE" ]; then
  ELECTRON_RUN_AS_NODE=1 "$CODE" dist/integration-smoke.mjs
else
  echo "VS Code not found at $CODE; running under node"
  node dist/integration-smoke.mjs
fi
