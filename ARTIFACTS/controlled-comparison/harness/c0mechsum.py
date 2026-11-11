#!/usr/bin/env python3
"""Context boundaries per side: wait, context kept, summary cost, files read again, notes upkeep.

Usage: c0mech.py RUNS_DIR | c0mechsum.py [--arms A,B] [--names stock,Posthorse] [--label LABEL]
Counts main runs only (LIB-ARM-rN, or with -LABEL) that have ended and are not void.
"""
import argparse
import json
import re
import statistics
import sys


def mean(values):
    return sum(values) / len(values) if values else None


def show(value, digits=1, unit=""):
    return "-" if value is None else f"{value:,.{digits}f}{unit}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--arms", default="A,B")
    parser.add_argument("--names", default="stock,Posthorse")
    parser.add_argument("--label", default="")
    args = parser.parse_args()
    arms, names = args.arms.split(","), args.names.split(",")
    suffix = f"-{args.label}" if args.label else ""
    pattern = re.compile(rf"^.+-({'|'.join(map(re.escape, arms))})-r\d+{re.escape(suffix)}$")
    # Runs that do not count (void) and runs that have not ended are left out, as in c0summary.py.
    rows = [row for row in map(json.loads, sys.stdin) if pattern.match(row["run"]) and not row.get("void") and row.get("ended", True)]
    boundaries = {arm: [row for row in rows if row["arm"] == arm and "kind" in row] for arm in arms}
    runs = {arm: [row for row in rows if row["arm"] == arm and "kind" not in row] for arm in arms}
    lines = [
        ("Boundaries", lambda arm: str(len(boundaries[arm]))),
        ("Seconds blocked per boundary, median", lambda arm: show(statistics.median([b["wait_s"] for b in boundaries[arm]]) if boundaries[arm] else None)),
        ("Seconds blocked per boundary, mean", lambda arm: show(mean([b["wait_s"] for b in boundaries[arm]]))),
        ("Seconds blocked, largest", lambda arm: show(max([b["wait_s"] for b in boundaries[arm]], default=None))),
        ("Hours blocked, all runs", lambda arm: show(sum(b["wait_s"] for b in boundaries[arm]) / 3600, 2)),
        ("Context before a boundary, median", lambda arm: show(statistics.median([b["context_before"] for b in boundaries[arm]]) if boundaries[arm] else None, 0)),
        ("Context after a boundary, median", lambda arm: show(statistics.median([b["context_after"] for b in boundaries[arm]]) if boundaries[arm] else None, 0)),
        ("Summary request cost per boundary, mean", lambda arm: show(mean([b["summary_cost"] for b in boundaries[arm]]), 3, " USD")),
        ("Summary request input tokens, mean", lambda arm: show(mean([b["summary_input"] for b in boundaries[arm]]), 0)),
        ("Summary request output tokens, mean", lambda arm: show(mean([b["summary_output"] for b in boundaries[arm]]), 0)),
        ("File reads in the 10 replies after, mean", lambda arm: show(mean([b["reads_10"] for b in boundaries[arm]]), 2)),
        ("  of files already seen (after)", lambda arm: show(mean([b["rereads_10"] for b in boundaries[arm]]), 2)),
        ("  of files already seen (10 replies before)", lambda arm: show(mean([b["control_rereads"] for b in boundaries[arm]]), 2)),
        ("Tests gained in the 10 min after, mean", lambda arm: show(mean([b["passed_after"] - b["passed_before"] for b in boundaries[arm]
                                                                          if b.get("passed_after") is not None and b.get("passed_before") is not None]), 1)),
        ("Replies that only updated notes, per run", lambda arm: show(mean([r["notes_only_replies"] for r in runs[arm]]), 1)),
        ("  their share of the run's cost", lambda arm: show(100 * sum(r["notes_only_cost"] for r in runs[arm]) / max(sum(r["cost"] for r in runs[arm]), 1e-9), 1, "%")),
        ("Notes tool calls per run", lambda arm: show(mean([r["notes_calls"] for r in runs[arm]]), 1)),
        ("History tool calls per run", lambda arm: show(mean([r["history_calls"] for r in runs[arm]]), 1)),
    ]
    print(f"{'':<46}" + "".join(f"{name:>16}" for name in names))
    for title, cell in lines:
        print(f"{title:<46}" + "".join(f"{cell(arm):>16}" for arm in arms))
    # The stock wait grows with the number of boundaries already passed in the session.
    print("\nSeconds blocked by position of the boundary in its session (mean, count):")
    for arm, name in zip(arms, names):
        by_position = {}
        seen = {}
        for b in boundaries[arm]:
            seen[b["run"]] = seen.get(b["run"], 0) + 1
            by_position.setdefault(seen[b["run"]], []).append(b["wait_s"])
        print(f"  {name}: " + ", ".join(f"#{position} {mean(values):.0f} s (n={len(values)})" for position, values in sorted(by_position.items())))


if __name__ == "__main__":
    main()
