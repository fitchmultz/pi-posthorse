#!/bin/bash
# Usage: c0run.sh LIB ARM REP [c0.py run options]   (model: openai-codex/gpt-6.1-sol unless MODEL is set)
# One run can be listed in several batches that work side by side; a lock makes the others skip it while it runs.
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/.."
export PATH="$(mise where node)/bin:$PATH"
mkdir -p locks
exec 9> "locks/$(echo "${MODEL:-openai-codex/gpt-6.1-sol} $*" | tr -c 'A-Za-z0-9._\n-' '_').lock"
flock -n 9 || { echo "$1-$2-r$3 is running in another batch; skipped here"; exit 0; }
lib="$1"; arm="$2"; rep="$3"; shift 3
exec commit0/.venv/bin/python "$here/c0.py" run "$lib" "$arm" "$rep" "${MODEL:-openai-codex/gpt-6.1-sol}" "$@" 2> >(grep -v -i warning >&2)
