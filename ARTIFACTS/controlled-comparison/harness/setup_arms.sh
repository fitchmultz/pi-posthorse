#!/bin/bash
# Usage: setup_arms.sh POSTHORSE_VERSION
# Creates the two Pi config directories. Arm A is official Pi alone. Arm B adds one package: Posthorse.
# Both use Pi's default compaction settings, written out so the run records them.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
version="${1:?usage: setup_arms.sh POSTHORSE_VERSION}"
pi="$root/pi-official/node_modules/.bin/pi"
for arm in A B; do
  dir="$root/agents/$arm"
  rm -rf "$dir"
  mkdir -p "$dir"
  printf '%s\n' '{ "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 } }' > "$dir/settings.json"
done
PI_CODING_AGENT_DIR="$root/agents/B" PI_SKIP_VERSION_CHECK=1 "$pi" install "npm:pi-posthorse@$version"
PI_CODING_AGENT_DIR="$root/agents/B" PI_SKIP_VERSION_CHECK=1 "$pi" list
