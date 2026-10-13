#!/usr/bin/env bash
# Bump version, build + package the extension into a .vsix, install it into VS Code,
# then commit, tag and push the release.
#
# Usage: scripts/release.sh [bump] [--check] [--skip-install] [--install-deps] [--no-push | --no-git]
#   Version bump (mutually exclusive; default: --patch):
#     --patch          X.Y.Z -> X.Y.(Z+1)
#     --minor          X.Y.Z -> X.(Y+1).0
#     --major          X.Y.Z -> (X+1).0.0
#     --no-bump        keep the current version
#   Build:
#     --check          type-check both packages and run `bun test` (runs before the bump)
#     --skip-install   package only, do not install
#     --install-deps   run `bun install` even if node_modules exists
#   Git:
#     --no-push        commit + tag locally, do not push
#     --no-git         skip commit, tag and push entirely
#   -h, --help         show this help
# Versions are bumped in packages/vscode/package.json (source of truth) and the root package.json.
# Git step: `git add -A`, commit "chore(release): v<version>", annotated tag v<version>,
# then `git push origin <branch> v<version>`.
# If the build/package/install fails after the bump, both package.json files are restored.
# Env: CODE_BIN=<cli>  editor CLI to use (e.g. CODE_BIN=cursor); default: code
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/packages/vscode"
ROOT_JSON="$ROOT/package.json"
PKG_JSON="$PKG/package.json"

step() { printf '\n==> %s\n' "$*"; }
die() { echo "Error: $*" >&2; exit 1; }

# Print the next version for "$1" (X.Y.Z) and bump kind "$2" (patch|minor|major|none).
next_version() {
  local cur="$1" kind="$2" major minor patch
  [[ "$cur" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "current version '$cur' is not X.Y.Z"
  IFS=. read -r major minor patch <<<"$cur"
  case "$kind" in
    patch) patch=$((patch + 1)) ;;
    minor) minor=$((minor + 1)); patch=0 ;;
    major) major=$((major + 1)); minor=0; patch=0 ;;
    none) ;;
  esac
  echo "$major.$minor.$patch"
}

# Rewrite only the first top-level "version" line of package.json file "$1" to "$2".
write_version() {
  node -e '
    const fs = require("fs");
    const [file, next] = process.argv.slice(1);
    const src = fs.readFileSync(file, "utf8");
    const re = /^(\s*"version"\s*:\s*")(\d+\.\d+\.\d+)(")/m;
    if (!re.test(src)) { console.error("no X.Y.Z \"version\" line in " + file); process.exit(1); }
    fs.writeFileSync(file, src.replace(re, "$1" + next + "$3"));
  ' "$1" "$2"
}

# Allow tests to source the helpers above without running the release.
if [[ "${RELEASE_SOURCE_ONLY:-0}" == "1" ]]; then return 0 2>/dev/null || exit 0; fi

cd "$ROOT"

RUN_CHECK=0; SKIP_INSTALL=0; FORCE_DEPS=0
BUMP=""; NO_PUSH=0; NO_GIT=0
set_bump() {
  [[ -z "$BUMP" ]] || { echo "Error: only one of --patch/--minor/--major/--no-bump may be given" >&2; exit 2; }
  BUMP="$1"
}
for arg in "$@"; do
  case "$arg" in
    --check) RUN_CHECK=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --install-deps) FORCE_DEPS=1 ;;
    --patch) set_bump patch ;;
    --minor) set_bump minor ;;
    --major) set_bump major ;;
    --no-bump) set_bump none ;;
    --no-push) NO_PUSH=1 ;;
    --no-git) NO_GIT=1 ;;
    -h|--help) sed -n '2,23p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
BUMP="${BUMP:-patch}"
[[ $NO_GIT -eq 1 ]] && NO_PUSH=1

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

# Preflight: compute the target version and validate git state before doing any work.
OLD_VERSION="$(node -p "require('$PKG_JSON').version")"
VERSION="$(next_version "$OLD_VERSION" "$BUMP")"
TAG="v$VERSION"
BRANCH=""
if [[ $NO_GIT -eq 0 ]]; then
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not inside a git repository"
  BRANCH="$(git symbolic-ref -q --short HEAD || true)"
  [[ -n "$BRANCH" ]] || die "detached HEAD; check out a branch first"
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "tag $TAG already exists locally"
  if [[ $NO_PUSH -eq 0 ]]; then
    git remote get-url origin >/dev/null 2>&1 || die "no 'origin' remote configured"
    REMOTE_TAG="$(git ls-remote --tags origin "refs/tags/$TAG")" || die "cannot reach origin"
    [[ -z "$REMOTE_TAG" ]] || die "tag $TAG already exists on origin"
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

# Bump the version, keeping backups so a failed build leaves no stray version change.
BACKUP_DIR="$(mktemp -d)"
ROLLBACK_ARMED=0
cleanup() {
  local status=$?
  if [[ $ROLLBACK_ARMED -eq 1 ]]; then
    cp "$BACKUP_DIR/root.json" "$ROOT_JSON"
    cp "$BACKUP_DIR/vscode.json" "$PKG_JSON"
    echo "Release failed; restored package.json files to v$OLD_VERSION" >&2
  fi
  rm -rf "$BACKUP_DIR"
  return $status
}
trap cleanup EXIT

if [[ "$BUMP" != "none" ]]; then
  step "Bumping version $OLD_VERSION -> $VERSION ($BUMP)"
  cp "$ROOT_JSON" "$BACKUP_DIR/root.json"
  cp "$PKG_JSON" "$BACKUP_DIR/vscode.json"
  ROLLBACK_ARMED=1
  write_version "$PKG_JSON" "$VERSION"
  write_version "$ROOT_JSON" "$VERSION"
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

if [[ $SKIP_INSTALL -eq 0 ]]; then
  step "Installing into editor ($CODE_CMD)"
  "$CODE_CMD" --install-extension "$VSIX" --force
fi

GIT_STATUS="skipped (--no-git)"
if [[ $NO_GIT -eq 0 ]]; then
  step "Committing release $TAG"
  git add -A
  if git diff --cached --quiet; then
    echo "Nothing to commit"
  else
    git commit -m "chore(release): $TAG"
  fi
  ROLLBACK_ARMED=0  # version change is now committed (or there was nothing to roll back)

  step "Tagging $TAG"
  git tag -a "$TAG" -m "$TAG"
  GIT_STATUS="committed and tagged locally (--no-push)"

  if [[ $NO_PUSH -eq 0 ]]; then
    step "Pushing $BRANCH and $TAG to origin"
    if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
      git push origin "$BRANCH" "$TAG"
    else
      git push -u origin "$BRANCH" "$TAG"
    fi
    GIT_STATUS="pushed $BRANCH and $TAG to origin"
  fi
fi
ROLLBACK_ARMED=0

step "Done"
echo "VSIX:    $VSIX"
echo "Version: $VERSION"
echo "Tag:     $TAG"
echo "Git:     $GIT_STATUS"
[[ $SKIP_INSTALL -eq 1 ]] && echo "Install: skipped"
echo "Reminder: run \"Developer: Reload Window\" in VS Code to load the new build."
