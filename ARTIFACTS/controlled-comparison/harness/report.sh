#!/bin/bash
# Usage: report.sh MODEL_TAG [ARMS]     (run on the machine that holds the runs, from any directory)
# Writes every table of one model to ROOT/results/MODEL_TAG/: per-run rows, side-by-side summaries for each pair of
# sides, the planted rule, the boundary mechanics, the rules carried across boundaries, the audit leads and the
# agent's last message at every stop. ARMS is the list of sides present, first the baseline (default: A,B).
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/.."
tag="$1"; arms="${2:-A,B}"
out="results/$tag"; mkdir -p "$out"
name() { case "$1" in A) echo stock;; B) echo Posthorse;; G) echo "stock + paragraph";; *) echo "$1";; esac; }
python3 "$here/c0table.py" "c0runs/$tag" > "$out/runs.jsonl" 2> "$out/runs.txt"
IFS=, read -ra list <<< "$arms"
for ((i = 0; i < ${#list[@]}; i++)); do for ((j = i + 1; j < ${#list[@]}; j++)); do
  a="${list[i]}"; b="${list[j]}"; pair="$a-$b"; names="$(name "$a"),$(name "$b")"
  python3 "$here/c0summary.py" --arms "$a,$b" --names "$names" < "$out/runs.jsonl" > "$out/summary-$pair.txt" 2>&1
  python3 "$here/c0summary.py" --arms "$a,$b" --names "$names" --once < "$out/runs.jsonl" > "$out/summary-$pair-once.txt" 2>&1
  python3 "$here/c0summary.py" --arms "$a,$b" --names "$names" --json < "$out/runs.jsonl" > "$out/summary-$pair.jsonl" 2>/dev/null
  python3 "$here/c0rules.py" "c0runs/$tag" 2>/dev/null | python3 "$here/c0rulesum.py" --arms "$a,$b" --names "$names" > "$out/rule3-$pair.txt" 2>&1
  python3 "$here/c0mech.py" "c0runs/$tag" 2>/dev/null | python3 "$here/c0mechsum.py" --arms "$a,$b" --names "$names" > "$out/boundaries-$pair.txt" 2>&1
done; done
python3 "$here/c0carried.py" "c0runs/$tag" > "$out/rules-carried.txt" 2>&1
python3 "$here/c0carried.py" "c0runs/$tag" --lines > "$out/rule2-lines.txt" 2>&1
python3 "$here/c0audit.py" "c0runs/$tag" > "$out/audit.txt" 2>&1
python3 "$here/c0stops.py" "c0runs/$tag" --chars 1500 > "$out/stops.txt" 2>&1
python3 "$here/c0stops.py" "c0runs/$tag" --json > "$out/stops.jsonl" 2>/dev/null
for ((i = 0; i < ${#list[@]}; i++)); do for ((j = i + 1; j < ${#list[@]}; j++)); do
  a="${list[i]}"; b="${list[j]}"; pair="$a-$b"; names="$(name "$a"),$(name "$b")"
  python3 "$here/c0quitrate.py" "c0runs/$tag" --arms "$a,$b" --names "$names" > "$out/quit-rate-$pair.txt" 2>&1
  python3 "$here/c0crossed.py" "$out" --arms "$a,$b" --names "$names" > "$out/crossed-$pair.txt" 2>&1
done; done
rounds=(); for round in labels/"${tag##*-}"-*/; do [ -f "$round/labels.tsv" ] && rounds+=("$round"); done
[ ${#rounds[@]} -gt 0 ] && python3 "$here/stoplabels.py" join "${rounds[@]}" < "$out/stops.jsonl" > "$out/stop-labels.tsv" 2> "$out/stop-labels-counts.txt"
labels=(); [ -f "$out/stop-labels.tsv" ] && labels=(--labels "$out/stop-labels.tsv")
python3 "$here/c0endcond.py" "c0runs/$tag" "${labels[@]}" --lines > "$out/end-condition.txt" 2>&1
ls -la "$out" | awk '{print $5, $9}' | tail -n +2
