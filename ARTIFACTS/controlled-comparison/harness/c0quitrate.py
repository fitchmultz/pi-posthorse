#!/usr/bin/env python3
"""How often the agent ended its turn unfinished, before the first context boundary and after it.

Usage: c0quitrate.py RUNS_DIR [--arms A,B] [--names stock,Posthorse]     (RUNS_DIR: c0runs/MODEL_TAG)

Main runs that have ended and count. Agent time (the Pi invocations, without the grading between them) is split by
how many boundaries came before each moment: none, one or more. A quit is a stop of kind "agent" (c0table.stop_kind).
Per side: agent hours, quits, and quits per agent hour in each part; and the same for the time from each
"Continue." to the next stop (how long the agent worked after it was told to continue).
"""
import argparse
import json
import re
import statistics
from datetime import timedelta
from pathlib import Path

from c0table import stop_kind
from table import journal_entries, parse_time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("runs_dir")
    parser.add_argument("--arms", default="A,B")
    parser.add_argument("--names", default="stock,Posthorse")
    args = parser.parse_args()
    arms, names = args.arms.split(","), args.names.split(",")
    pattern = re.compile(rf"^.+-({'|'.join(map(re.escape, arms))})-r\d$")
    hours = {arm: [0.0, 0.0] for arm in arms}
    quits = {arm: [0, 0] for arm in arms}
    runs = {arm: [set(), set()] for arm in arms}
    after_continue = {arm: [[], []] for arm in arms}
    for meta_path in sorted(Path(args.runs_dir).glob("*/meta.json")):
        run_dir = meta_path.parent
        meta = json.loads(meta_path.read_text())
        if not pattern.match(run_dir.name) or meta.get("void") or "ended" not in meta:
            continue
        arm = meta["arm"]
        boundaries = sorted(parse_time(e["timestamp"]) for e in journal_entries(run_dir) if e.get("type") == "compaction")
        first = boundaries[0] if boundaries else None
        for stop in meta.get("stops") or []:
            if not stop.get("ended") or not stop.get("started"):
                continue
            start, end = parse_time(stop["started"]), parse_time(stop["ended"]) + timedelta(seconds=1)
            cut = min(max(first, start), end) if first else end
            hours[arm][0] += (cut - start).total_seconds() / 3600
            hours[arm][1] += (end - cut).total_seconds() / 3600
            part = 1 if first and first <= end else 0
            for index, seconds in ((0, (cut - start).total_seconds()), (1, (end - cut).total_seconds())):
                if seconds > 0:
                    runs[arm][index].add(run_dir.name)
            kind = stop_kind(run_dir, meta, stop)
            if kind == "agent":
                quits[arm][part] += 1
            # The invocation after a "Continue.": how long did the agent work before its next stop of any kind?
            if stop["index"] > 0 and kind in ("agent", "finished", "wall-time"):
                after_continue[arm][1 if first and first <= start else 0].append(((end - start).total_seconds() / 60, kind))
    print(f"{'':<44}" + "".join(f"{name:>26}" for name in names))
    for index, title in ((0, "Before the first boundary"), (1, "After the first boundary")):
        print(title)
        for label, cell in (
            ("  sessions with agent time there", lambda arm: f"{len(runs[arm][index])}"),
            ("  agent hours", lambda arm: f"{hours[arm][index]:.1f}"),
            ("  times the agent quit unfinished", lambda arm: f"{quits[arm][index]}"),
            ("  quits per agent hour", lambda arm: f"{quits[arm][index] / hours[arm][index]:.2f}" if hours[arm][index] else "-"),
        ):
            print(f"{label:<44}" + "".join(f"{cell(arm):>26}" for arm in arms))
    print('Minutes of work after a "Continue." until the next stop (median; count; of these ended by the agent unfinished)')
    for index, title in ((0, "  sent before the first boundary"), (1, "  sent after the first boundary")):
        cells = []
        for arm in arms:
            values = after_continue[arm][index]
            cells.append("-" if not values else
                         f"{statistics.median(v for v, _ in values):.1f}; {len(values)}; {sum(k == 'agent' for _, k in values)}")
        print(f"{title:<44}" + "".join(f"{cell:>26}" for cell in cells))


if __name__ == "__main__":
    main()
