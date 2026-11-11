#!/usr/bin/env python3
"""Per-run table for the controlled comparison.

Usage: table.py RUNS_DIR [REPORTS_DIR]

RUNS_DIR holds one directory per run (as written by cc.py). REPORTS_DIR, when given, holds the
SWE-bench evaluation logs (logs/run_evaluation); resolved counts are read from the report.json files.
Writes one JSON object per run to stdout, then a short text table to stderr.
"""
import json
import re
import sys
from datetime import datetime
from pathlib import Path

# A directory named "tests" or a pytest-style file name. "django/test/" is library code, not tests.
TEST_PATH = re.compile(r"(^|/)tests/|(^|/)test_[^/]*\.py$|_test\.py$|(^|/)conftest\.py$")
LOG_LINE = re.compile(r"^(\d+) \| (fixed|not fixed) \| \S.*$")


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def journal_entries(run_dir):
    entries = []
    for path in sorted((run_dir / "session").glob("*.jsonl")):
        entries += [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return entries


def child_journals(run_dir):
    """Journals of the child agents a run started (pi-subagents keeps them in the run's own agent directory)."""
    journals = []
    for path in sorted((run_dir / "agent" / "sessions" / "agent-runs").glob("**/*.jsonl")):
        entries = []
        for line in path.read_text(errors="replace").splitlines():
            if line.strip():
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        journals.append(entries)
    return journals


def patch_paths(text):
    return [line.split(" b/", 1)[1] for line in text.splitlines() if line.startswith("diff --git ") and " b/" in line]


def resolved_ids(reports_dir, model_name):
    if reports_dir is None:
        return None
    resolved = set()
    for report in reports_dir.glob(f"*/{model_name}/*/report.json"):
        for instance_id, result in json.loads(report.read_text()).items():
            if result.get("resolved"):
                resolved.add(instance_id)
    return resolved


def run_row(run_dir, reports_dir):
    meta = json.loads((run_dir / "meta.json").read_text())
    entries = journal_entries(run_dir)
    replies = [e["message"] for e in entries if e.get("type") == "message" and e["message"].get("role") == "assistant"]
    usage = [m.get("usage") or {} for m in replies]
    boundaries = [(i, e) for i, e in enumerate(entries) if e.get("type") == "compaction"]
    waits, summary_cost, summary_in, summary_out, kinds = [], 0.0, 0, 0, []
    for index, entry in boundaries:
        details = entry.get("details") if isinstance(entry.get("details"), dict) else {}
        kinds.append("posthorse" if details.get("posthorse") == 1 else "stock")
        waits.append((parse_time(entry["timestamp"]) - parse_time(entries[index - 1]["timestamp"])).total_seconds())
        entry_usage = entry.get("usage") or {}
        summary_cost += (entry_usage.get("cost") or {}).get("total") or 0
        summary_in += (entry_usage.get("input") or 0) + (entry_usage.get("cacheRead") or 0)
        summary_out += entry_usage.get("output") or 0
    ws = run_dir / "ws"
    total = len(meta["issues"])
    saves = (ws / ".harness" / "saves.tsv").read_text().splitlines() if (ws / ".harness" / "saves.tsv").exists() else []
    saved_by_script = {int(line.split("\t")[1]) for line in saves}
    test_touch = 0
    for n in range(1, total + 1):
        final = run_dir / "final" / f"{n}.diff"
        test_touch += any(TEST_PATH.search(p) for p in patch_paths(final.read_text())) if final.exists() else 0
    log_lines = (ws / "LOG.md").read_text().splitlines() if (ws / "LOG.md").exists() else []
    logged = {int(m.group(1)) for m in map(LOG_LINE.match, log_lines) if m}
    model_name = f"{run_dir.parent.name}-{meta.get('run', run_dir.name)}"
    resolved = resolved_ids(reports_dir, model_name)
    started, ended = parse_time(meta["started"]), parse_time(meta["ended"])
    work = [parse_time(i["ended"]) - parse_time(i["started"]) for i in meta["invocations"]]
    return {
        "run": run_dir.name, "arm": meta["arm"], "queue": meta["queue"], "rep": meta["rep"], "window": meta["window"],
        "test_rule": meta.get("test_rule", True),
        "issues": total, "outcome": meta["outcome"], "nudges": len(meta["invocations"]) - 1,
        "saved_by_script": len(saved_by_script), "logged": len(logged & set(range(1, total + 1))), "test_files_touched": test_touch,
        "resolved": None if resolved is None else sum(i["instance_id"] in resolved for i in meta["issues"]),
        "replies": len(replies), "boundaries": len(boundaries), "boundary_kinds": sorted(set(kinds)),
        "boundary_wait_s": round(sum(waits), 1),
        "pi_minutes": round(sum(w.total_seconds() for w in work) / 60, 1),
        "wall_minutes": round((ended - started).total_seconds() / 60, 1),
        "peak_context": max((u.get("totalTokens") or 0 for u in usage), default=0),
        "input_tokens": sum((u.get("input") or 0) + (u.get("cacheRead") or 0) + (u.get("cacheWrite") or 0) for u in usage) + summary_in,
        "uncached_input": sum(u.get("input") or 0 for u in usage),
        "output_tokens": sum(u.get("output") or 0 for u in usage) + summary_out,
        "cost": round(sum((u.get("cost") or {}).get("total") or 0 for u in usage) + summary_cost, 3),
        "summary_cost": round(summary_cost, 3),
    }


def main():
    runs_dir = Path(sys.argv[1])
    reports_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    rows = [run_row(path.parent, reports_dir) for path in sorted(runs_dir.glob("*/meta.json"))]
    for row in rows:
        print(json.dumps(row))
    columns = ["run", "outcome", "nudges", "issues", "saved_by_script", "logged", "test_files_touched", "resolved", "replies",
               "boundaries", "boundary_wait_s", "pi_minutes", "peak_context", "input_tokens", "output_tokens", "cost", "summary_cost"]
    print("\t".join(columns), file=sys.stderr)
    for row in rows:
        print("\t".join(str(row[c]) for c in columns), file=sys.stderr)


if __name__ == "__main__":
    main()
