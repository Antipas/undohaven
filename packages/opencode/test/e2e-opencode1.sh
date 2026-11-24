#!/usr/bin/env bash
# Loads this package in a real OpenCode 1.x and runs a snapshot -> break -> undo
# round trip through OpenCode's own tool executor. No model or API key needed.
# Usage: test/e2e-opencode1.sh   (needs `opencode` 1.x on PATH)
set -euo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home/.config/opencode" "$T/proj/.opencode/agent"
cd "$T/proj"
git init -q .
printf '{ "$schema": "https://opencode.ai/config.json", "plugin": ["file://%s"] }\n' "$PKG" > opencode.json
echo '# reviewer v1' > .opencode/agent/reviewer.md
export HOME="$T/home" XDG_CONFIG_HOME="$T/home/.config" XDG_DATA_HOME="$T/home/.local/share" \
  XDG_CACHE_HOME="$T/home/.cache" XDG_STATE_HOME="$T/home/.local/state" UNDOHAVEN_CLOUD=0
run() { opencode debug agent build --tool "$1" --params "${2:-{\}}" 2>&1; }
opencode --version
opencode debug agent build 2>&1 | grep -q '"undohaven_undo": true' && echo "tools registered"
run undohaven_snapshot | grep -o 'Saved snapshot snap_[0-9a-f]*'
echo '# reviewer BROKEN' > .opencode/agent/reviewer.md
run undohaven_undo | grep -o 'Restored snap_[0-9a-f]*'
test "$(cat .opencode/agent/reviewer.md)" = '# reviewer v1' && echo "PASS: undo restored .opencode/agent/reviewer.md"
