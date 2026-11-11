#!/bin/bash
# Grade every 5-minute snapshot of the main runs of one model, several runs side by side.
# usage: c0scoreall.sh MODEL_TAG PARALLEL [LABEL]     (run from ROOT; log: logs/c0score-MODEL_TAG.log)
set -uo pipefail
tag="$1"; parallel="$2"; label="${3:-}"
suffix=""; [ -n "$label" ] && suffix="-$label"
mkdir -p logs
ls -d "c0runs/$tag"/*-[A-Z]-r[0-9]"$suffix" | xargs -n 1 basename \
  | xargs -P "$parallel" -I{} commit0/.venv/bin/python harness/c0.py score "$tag" {} --snapshots >> "logs/c0score-$tag.log" 2>&1
echo "score-all done $(date -u +%FT%TZ) exit $?" >> "logs/c0score-$tag.log"
