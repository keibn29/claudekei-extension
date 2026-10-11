#!/usr/bin/env bash
# Build + package the extension into a .vsix and install it into VS Code.
#
# Usage: scripts/package-install.sh [--check] [--skip-install] [--install-deps]
#   --check          type-check both packages and run `bun test` before packaging
#   --skip-install   package only, do not install
#   --install-deps   run `bun install` even if node_modules exists
# Env: CODE_BIN=<cli>  editor CLI to use (e.g. CODE_BIN=cursor); default: code
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/packages/vscode"
cd "$ROOT"

RUN_CHECK=0; SKIP_INSTALL=0; FORCE_DEPS=0
for arg in "$@"; do
  case "$arg" in
    --check) RUN_CHECK=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --install-deps) FORCE_DEPS=1 ;;
    -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }

# Resolve the editor CLI up front so we fail before a long build.
CODE_CMD=""
if [[ $SKIP_INSTALL -eq 0 ]]; then
  CODE_CMD="${CODE_BIN:-code}"
  if ! command -v "$CODE_CMD" >/dev/null 2>&1; then
    MAC_CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    if [[ -z "${CODE_BIN:-}" && -x "$MAC_CODE" ]]; then
      CODE_CMD="$MAC_CODE"
    else
      echo "Error: '$CODE_CMD' CLI not found." >&2
      echo "In VS Code run: Cmd+Shift+P -> 'Shell Command: Install \"code\" command in PATH'," >&2
      echo "or set CODE_BIN to another CLI (e.g. CODE_BIN=cursor)." >&2
      exit 1
    fi
  fi
fi

if [[ $FORCE_DEPS -eq 1 || ! -x "$PKG/node_modules/.bin/vsce" && ! -x "$ROOT/node_modules/.bin/vsce" ]]; then
  step "Installing dependencies (bun install)"
  bun install
fi

if [[ $RUN_CHECK -eq 1 ]]; then
  step "Type-check (all packages)"
  bun run type-check
  step "Tests (packages/vscode)"
  (cd "$PKG" && bun run test)
fi

step "Removing old .vsix files"
rm -f "$PKG"/*.vsix

# `package` runs vsce, whose vscode:prepublish performs the full build (extension + webview + SDK copy).
step "Building and packaging (bun run vscode:package)"
bun run vscode:package

VSIX="$(ls -t "$PKG"/*.vsix 2>/dev/null | head -n1 || true)"
if [[ -z "$VSIX" ]]; then
  echo "Error: no .vsix produced in $PKG" >&2
  exit 1
fi
VERSION="$(node -p "require('$PKG/package.json').version")"

if [[ $SKIP_INSTALL -eq 0 ]]; then
  step "Installing into editor ($CODE_CMD)"
  "$CODE_CMD" --install-extension "$VSIX" --force
fi

step "Done"
echo "VSIX:    $VSIX"
echo "Version: $VERSION"
[[ $SKIP_INSTALL -eq 1 ]] && echo "Install: skipped"
echo "Reminder: run \"Developer: Reload Window\" in VS Code to load the new build."
