#!/usr/bin/env python3
"""The agent's last message at every stop of every run, for a human to read.

Usage: c0stops.py RUNS_DIR [RUN_NAME_SUBSTRING] [--chars N] [--json]
One line per stop: run, stop number, kind (c0table.stop_kind), minute, tests passing, boundaries before it, then the text.
With --json: one JSON object per stop with the whole text (input of stoplabels.py).
"""
import json
import sys
from datetime import timedelta
from pathlib import Path

from c0table import stop_kind
from table import journal_entries, parse_time


def main():
    runs_dir = Path(sys.argv[1])
    rest = sys.argv[2:]
    chars = 500
    if "--chars" in rest:
        at = rest.index("--chars")
        chars = int(rest[at + 1])
        del rest[at:at + 2]
    as_json = "--json" in rest
    rest = [word for word in rest if word != "--json"]
    wanted = rest[0] if rest else ""
    for meta_path in sorted(runs_dir.glob("*/meta.json")):
        run_dir = meta_path.parent
        if wanted not in run_dir.name:
            continue
        meta = json.loads(meta_path.read_text())
        entries = journal_entries(run_dir)
        boundaries = [parse_time(e["timestamp"]) for e in entries if e.get("type") == "compaction"]
        replies = [e for e in entries if e.get("type") == "message" and e["message"].get("role") == "assistant"]
        for stop in meta.get("stops") or []:
            if not stop.get("ended"):
                continue
            # The harness stamps the end in whole seconds; the last reply can carry the same second with milliseconds.
            end = parse_time(stop["ended"]) + timedelta(seconds=1)
            before = [r for r in replies if parse_time(r["timestamp"]) <= end]
            text = ""
            if before:
                text = " ".join(part.get("text", "") for part in before[-1]["message"]["content"] if part.get("type") == "text")
            minute = (end - parse_time(meta["started"])).total_seconds() / 60
            # Since the last boundary, or since the start: replies, and minutes of agent time (grading between invocations left out).
            last = max([b for b in boundaries if b <= end], default=parse_time(meta["started"]))
            replies_since = sum(last < parse_time(r["timestamp"]) <= end for r in replies)
            agent_seconds = sum(
                max(0.0, (min(end, parse_time(other["ended"]) + timedelta(seconds=1)) - max(last, parse_time(other["started"]))).total_seconds())
                for other in meta["stops"] if other.get("ended") and other.get("started"))
            if as_json:
                print(json.dumps({
                    "run": meta["run"], "arm": meta["arm"], "lib": meta["lib"], "void": bool(meta.get("void")), "stop": stop["index"],
                    "kind": stop_kind(run_dir, meta, stop), "minute": round(minute, 1), "passed": stop.get("passed"),
                    "reference_passed": meta.get("reference_passed"), "boundaries_before": sum(b <= end for b in boundaries), "text": text,
                    "replies_since_boundary": replies_since, "minutes_since_boundary": round(agent_seconds / 60, 1),
                }))
                continue
            print(f"{meta['run']}{' VOID' if meta.get('void') else ''} | stop {stop['index']} | {stop_kind(run_dir, meta, stop)} | min {minute:.0f} | "
                  f"{stop.get('passed')} of {meta.get('reference_passed')} | boundaries before {sum(b <= end for b in boundaries)} | "
                  + text[:chars].replace("\n", " "))


if __name__ == "__main__":
    main()
