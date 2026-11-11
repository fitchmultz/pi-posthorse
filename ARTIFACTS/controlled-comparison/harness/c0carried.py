#!/usr/bin/env python3
"""Which rules of the first message does the text written at each context boundary still state?

Usage: c0carried.py RUNS_DIR [--lines]     (RUNS_DIR: c0runs/MODEL_TAG; main runs LIB-ARM-rN, void runs included and marked)

At a boundary stock Pi writes a summary and Posthorse writes a recovery record. The agent's later context holds that
text in place of the first message. For a stock summary only its sections on the request and its constraints are read
("Original Request", "Goal", "Constraints & Preferences", "Constraints"); for a Posthorse record the whole text.
One line per run, one mark per boundary: three letters for rule 1 (test files), rule 2 (write it yourself),
rule 3 (commit message); Y = some words of the rule are there, - = none. The patterns are loose on purpose:
a Y can be a weak mention, a - means no word of the rule was found.
With --lines: for every stock run, the lines that state rule 2 in any of its summaries.
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

RULES = (
    re.compile(r"\btests?\b", re.I),
    re.compile(r"yourself|ourselves|\bcopy|copying|copied|install the library|not install|no install|installing the|from anywhere|"
               r"from elsewhere|own implementation|write the implementation|independently implement|external (source|code|cop)|"
               r"upstream|reference implementation|download", re.I),
    re.compile(r"tests: ", re.I),
)
STOCK_SECTIONS = ("Original Request", "Goal", "Constraints & Preferences", "Constraints")


def carried_text(summary):
    """(kind, text that stands for the first message): a Posthorse record whole, a stock summary by its request sections."""
    if summary.lstrip().startswith("Automatic context rollover recovery record"):
        return "record", summary
    parts = []
    for name in STOCK_SECTIONS:
        found = re.search(r"^## " + re.escape(name) + r"\s*\n(.*?)(?=^## |\Z)", summary, re.S | re.M)
        if found:
            parts.append(found.group(1))
    return "summary", "\n".join(parts)


def main():
    runs_dir = Path(sys.argv[1])
    lines_wanted = "--lines" in sys.argv[2:]
    totals = defaultdict(lambda: [0, 0, 0, 0])
    runs = defaultdict(list)
    for run_dir in sorted(runs_dir.iterdir()):
        named = re.fullmatch(r".+-([A-Z])-r\d(-harnessfault|-usedcopy|-providererror)?", run_dir.name)
        if not named or not (run_dir / "session").is_dir():
            continue
        arm, marks, rule2_lines = named.group(1), [], set()
        for path in sorted((run_dir / "session").glob("*.jsonl")):
            for line in open(path, errors="replace"):
                if '"type":"compaction"' not in line:
                    continue
                kind, text = carried_text(json.loads(line).get("summary") or "")
                kept = [bool(rule.search(text)) for rule in RULES]
                marks.append("".join("Y" if k else "-" for k in kept))
                if not named.group(2):
                    totals[arm][0] += 1
                    for index, k in enumerate(kept):
                        totals[arm][index + 1] += k
                if kind == "summary":
                    rule2_lines.update(l.strip()[:170] for l in text.splitlines() if RULES[1].search(l))
        if lines_wanted:
            if arm != "B":
                print(f"{run_dir.name:34} {' | '.join(sorted(rule2_lines))[:420] or '(no line states rule 2)'}")
        else:
            print(f"{run_dir.name:34} {' '.join(marks)}")
        if not named.group(2):
            runs[arm].append(marks)
    if lines_wanted:
        return
    for arm in sorted(totals):
        n, r1, r2, r3 = totals[arm]
        with_boundary = [m for m in runs[arm] if m]
        print(f"# arm {arm}: {n} boundaries in {len(with_boundary)} runs; text states rule 1 in {r1}, rule 2 in {r2}, rule 3 in {r3}; "
              f"runs where rule 2 is missing after some boundary: {sum(any(x[1] == '-' for x in m) for m in with_boundary)}, "
              f"after the first boundary: {sum(m[0][1] == '-' for m in with_boundary)}")


if __name__ == "__main__":
    main()
