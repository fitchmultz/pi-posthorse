#!/bin/bash
# Usage: c0batch.sh LIST_FILE PARALLEL
# LIST_FILE has one run per line: LIB ARM REP [c0.py run options]. Finished runs are skipped, cut-off runs start again.
# Output goes to logs/c0batch.log. Start it detached: nohup setsid harness/c0batch.sh LIST 4 >/dev/null 2>&1 &
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/.."
mkdir -p logs
export C0_PARALLEL="${C0_PARALLEL:-$2}"  # set it beforehand when several batches run side by side
echo "batch $1 started $(date -u +%Y-%m-%dT%H:%M:%SZ) with $2 side by side" >> logs/c0batch.log
grep -v '^\s*\(#\|$\)' "$1" | xargs -P "$2" -L 1 bash "$here/c0run.sh" >> logs/c0batch.log 2>&1
echo "batch $1 finished $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> logs/c0batch.log
