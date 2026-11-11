#!/usr/bin/env python3
"""What happened at each context boundary of a long-task run.

Usage: c0mech.py RUNS_DIR [RUN_NAME_SUBSTRING]   (RUNS_DIR: c0runs/MODEL_TAG)
One JSON object per boundary on stdout. Per boundary:
  wait_s           time between the entry before the boundary and the boundary entry (the stock summary request runs here)
  context_before   tokens in context when the boundary fired
  context_after    tokens in context at the first reply after the boundary
  summary_cost     recorded cost of the stock summary request
  rereads_10       in the 10 replies after the boundary, `read` calls on files the session had already read or written
  reads_10         all `read` calls in those 10 replies
  control_rereads  the same count for the 10 replies before the boundary (same session, no boundary)
  passed_before / passed_after   tests passing at the last snapshot before and the first snapshot 10 minutes after, when graded
Also one line per run with the replies that only updated notes (arm B) and their cost.
"""
import json
import sys
from pathlib import Path

from table import journal_entries, parse_time

WINDOW = 10


def calls(entry):
    return [c for c in entry["message"]["content"] if c.get("type") == "toolCall"]


def reread_counts(replies, touched_before):
    reads = rereads = 0
    seen = set(touched_before)
    for entry in replies:
        for call in calls(entry):
            path = call["arguments"].get("path")
            if call["name"] == "read" and path:
                reads += 1
                rereads += path in seen
            if call["name"] in ("read", "write", "edit") and path:
                seen.add(path)
    return reads, rereads


def touched(replies):
    return {c["arguments"].get("path") for e in replies for c in calls(e) if c["name"] in ("read", "write", "edit") and c["arguments"].get("path")}


def run_rows(run_dir):
    meta = json.loads((run_dir / "meta.json").read_text())
    entries = journal_entries(run_dir)
    score_path = run_dir / "score.json"
    snapshots = sorted(json.loads(score_path.read_text()).get("snapshots", {}).values(), key=lambda s: s["at"]) if score_path.exists() else []
    reply_positions = [i for i, e in enumerate(entries) if e.get("type") == "message" and e["message"].get("role") == "assistant"]
    rows = []
    for index, entry in enumerate(entries):
        if entry.get("type") != "compaction":
            continue
        before = [entries[i] for i in reply_positions if i < index]
        after = [entries[i] for i in reply_positions if i > index]
        details = entry.get("details") if isinstance(entry.get("details"), dict) else {}
        at = parse_time(entry["timestamp"])
        reads, rereads = reread_counts(after[:WINDOW], touched(before))
        _, control = reread_counts(before[-WINDOW:], touched(before[:-WINDOW]))
        earlier = [s for s in snapshots if parse_time(s["at"]) <= at]
        later = [s for s in snapshots if (parse_time(s["at"]) - at).total_seconds() >= 600]
        usage = entry.get("usage") or {}
        rows.append({
            "run": meta["run"], "arm": meta["arm"], "void": bool(meta.get("void")), "ended": "ended" in meta,
            "kind": "posthorse" if details.get("posthorse") == 1 else "stock",
            "at_minute": round((at - parse_time(meta["started"])).total_seconds() / 60, 1), "reply": len(before),
            "wait_s": round((at - parse_time(entries[index - 1]["timestamp"])).total_seconds(), 1),
            "context_before": entry.get("tokensBefore"),
            "context_after": (after[0]["message"].get("usage") or {}).get("totalTokens") if after else None,
            "summary_cost": round((usage.get("cost") or {}).get("total") or 0, 3),
            "summary_input": (usage.get("input") or 0) + (usage.get("cacheRead") or 0), "summary_output": usage.get("output") or 0,
            "reads_10": reads, "rereads_10": rereads, "control_rereads": control,
            "passed_before": earlier[-1]["passed"] if earlier else None, "passed_after": later[0]["passed"] if later else None,
        })
    replies = [entries[i] for i in reply_positions]
    notes_only = [e for e in replies if calls(e) and all(c["name"] == "notes" for c in calls(e))]
    cost = lambda items: round(sum(((e["message"].get("usage") or {}).get("cost") or {}).get("total") or 0 for e in items), 3)
    summary = {
        "run": meta["run"], "arm": meta["arm"], "void": bool(meta.get("void")), "ended": "ended" in meta,
        "replies": len(replies), "notes_only_replies": len(notes_only),
        "notes_only_cost": cost(notes_only), "cost": cost(replies),
        "notes_calls": sum(c["name"] == "notes" for e in replies for c in calls(e)),
        "history_calls": sum(c["name"] == "history" for e in replies for c in calls(e)),
    }
    return rows, summary


def main():
    runs_dir = Path(sys.argv[1])
    wanted = sys.argv[2] if len(sys.argv) > 2 else ""
    for meta_path in sorted(runs_dir.glob("*/meta.json")):
        if wanted not in meta_path.parent.name:
            continue
        rows, summary = run_rows(meta_path.parent)
        for row in rows:
            print(json.dumps(row))
        print(json.dumps(summary))


if __name__ == "__main__":
    main()
