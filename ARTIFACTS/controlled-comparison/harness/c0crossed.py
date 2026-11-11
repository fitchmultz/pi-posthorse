#!/usr/bin/env python3
"""Sessions that reached a context boundary against sessions that did not, and the first quit after a boundary.

Usage: c0crossed.py RESULTS_DIR [--arms A,B] [--names stock,Posthorse]     (RESULTS_DIR: results/MODEL_TAG)

Reads runs.jsonl (c0table.py) and stops.jsonl (c0stops.py --json). Main runs that have ended and count.
Per side, for the sessions with one or more boundaries and for the sessions with none: how they ended, minutes of
agent time, tests passing at the end, times the agent quit unfinished. Then, for each session with a boundary, the
first quit that came after a boundary: minutes and replies since the last boundary before it.
"""
import argparse
import json
import re
import statistics
from pathlib import Path


def ending(row):
    kinds = row["stop_kinds"]
    if "finished" in kinds:
        return "finished"
    return "time limit" if kinds and kinds[-1] == "wall-time" else "nudges used up"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("results_dir")
    parser.add_argument("--arms", default="A,B")
    parser.add_argument("--names", default="stock,Posthorse")
    args = parser.parse_args()
    arms, names = args.arms.split(","), args.names.split(",")
    main_run = re.compile(rf"^.+-({'|'.join(map(re.escape, arms))})-r\d$")
    folder = Path(args.results_dir)
    rows = [row for row in map(json.loads, open(folder / "runs.jsonl"))
            if main_run.match(row["run"]) and not row.get("void") and row.get("outcome") not in (None, "running")]
    stops = [stop for stop in map(json.loads, open(folder / "stops.jsonl")) if main_run.match(stop["run"]) and not stop["void"]]
    for arm, name in zip(arms, names):
        mine = [row for row in rows if row["arm"] == arm]
        print(f"## {name}: {len(mine)} sessions")
        for crossed, label in ((True, "with one or more boundaries"), (False, "with no boundary")):
            part = [row for row in mine if (row["boundaries"] > 0) == crossed]
            if not part:
                print(f"{label}: 0 sessions")
                continue
            ends = [ending(row) for row in part]
            share = statistics.mean(1.0 if end == "finished" else row["passed"] / row["reference_passed"] for row, end in zip(part, ends))
            print(f"{label}: {len(part)} sessions; " + ", ".join(f"{end} {ends.count(end)}" for end in ("finished", "time limit", "nudges used up"))
                  + f"; minutes {statistics.mean(row['working_minutes'] for row in part):.1f}; tests passing at the end {100 * share:.1f}%;"
                  f" times the agent quit unfinished {sum(row['agent_stops'] for row in part)}")
        ended = {row["run"]: ending(row) for row in mine}
        first = {}
        for stop in sorted(stops, key=lambda stop: (stop["run"], stop["stop"])):
            if stop["arm"] == arm and stop["run"] in ended and stop["kind"] == "agent" and stop["boundaries_before"] >= 1:
                first.setdefault(stop["run"], stop)
        with_boundary = [row["run"] for row in mine if row["boundaries"] > 0]
        print(f"first quit after a boundary: in {len(first)} of the {len(with_boundary)} sessions with a boundary")
        for run, stop in sorted(first.items()):
            print(f"    {run:<30} stop {stop['stop']}, after boundary {stop['boundaries_before']}: {stop['minutes_since_boundary']} min, {stop['replies_since_boundary']} replies later")
        never = [run for run in with_boundary if run not in first]
        if never:
            print("no quit after a boundary: " + ", ".join(f"{run} ({ended[run]})" for run in sorted(never)))
        print()


if __name__ == "__main__":
    main()
