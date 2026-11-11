#!/usr/bin/env python3
"""How does each stock summary state the end condition of the first message?

Usage: c0endcond.py RUNS_DIR [--labels STOP_LABELS_TSV] [--lines]     (RUNS_DIR: c0runs/MODEL_TAG)

The first message ends: "You are done when the whole test suite passes, or when you can state for each remaining
failure why it cannot be fixed." One mark per summary of a main run that counts:
  F  full: a line about the end says that the remaining failures must be unfixable
  E  explanation only: a line about the end asks to explain or document the remaining failures, without "cannot be fixed"
  P  pass only: the lines about the end name only the passing tests
  -  no line about the end
Posthorse records are skipped (they carry the first message itself; see c0carried.py).
With --labels: the labels of the run's own stops beside each run, and counts of runs by the mark of their first summary.
With --lines: the lines that decided each mark.
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

# The last two alternatives are the goal line: "... so the entire test suite passes, or explain why ..." and
# "... so all `repo/tests` pass."
END = re.compile(r"\buntil\b|\bdone when\b|\bfinish(ed)? (only )?when\b|\bstopping condition\b|\bwork (autonomously|independently) until\b"
                 r"|\bpass(es)?,? or\b|\bso (that )?[^.]{0,80}\b(tests?|suite)\b[^.]{0,40}\bpass(es)?\b", re.I)
UNFIXABLE = re.compile(r"cannot be fixed|can't be fixed|unfixable|not fixable|unavoidable|impossible to fix", re.I)
EXPLAIN = re.compile(r"expla|document|justif|unresolved limitations", re.I)


def mark(summary):
    lines = [line.strip() for line in summary.split("\n") if END.search(line) and re.search(r"pass|fail", line, re.I)]
    for letter, pattern in (("F", UNFIXABLE), ("E", EXPLAIN)):
        hits = [line for line in lines if pattern.search(line)]
        if hits:
            return letter, hits[0]
    return ("P", lines[0]) if lines else ("-", "")


def main():
    runs_dir = Path(sys.argv[1])
    args = sys.argv[2:]
    labels = defaultdict(list)
    if "--labels" in args:
        for line in open(args[args.index("--labels") + 1]):
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 3:
                labels[parts[0]].append(parts[2])
    by_first = defaultdict(lambda: defaultdict(list))
    for run_dir in sorted(runs_dir.iterdir()):
        named = re.fullmatch(r".+-([A-Z])-r\d", run_dir.name)
        if not named or not (run_dir / "session").is_dir():
            continue
        marks = []
        for path in sorted((run_dir / "session").glob("*.jsonl")):
            for line in open(path, errors="replace"):
                if '"type":"compaction"' not in line:
                    continue
                summary = json.loads(line).get("summary") or ""
                if not summary.lstrip().startswith("Automatic context rollover recovery record"):
                    marks.append(mark(summary))
        if not marks:
            continue
        letters = "".join(letter for letter, _ in marks)
        print(f"{run_dir.name:<34} {letters:<9} {' '.join(labels.get(run_dir.name, []))}")
        if "--lines" in args:
            for number, (letter, text) in enumerate(marks, 1):
                print(f"    {number} {letter} {text[:240]}")
        by_first[named.group(1)][letters[0]].append(run_dir.name)
    for arm in sorted(by_first):
        for letter in "FEP-":
            runs = by_first[arm].get(letter, [])
            documented = [run for run in runs if "documented" in labels.get(run, [])]
            stops = sum(labels.get(run, []).count("documented") for run in runs)
            print(f"# arm {arm}: first summary {letter}: {len(runs)} runs; with a stop labelled documented: {len(documented)} runs, {stops} stops")


if __name__ == "__main__":
    main()
