#!/usr/bin/env python3
"""Per-run table for the long-task comparison.

Usage: c0table.py RUNS_DIR [RUN_NAME_SUBSTRING]   (RUNS_DIR: c0runs/MODEL_TAG)
Reads meta.json, the session journal and score.json (when graded). One JSON object per run on stdout, a text table on stderr.
"""
import json
import sys
from pathlib import Path

from table import child_journals, journal_entries, parse_time


REFERENCE = {}
CLEAN = {"passed", "xfailed", "xpassed", "skipped"}


def reference_passed_ids(run_dir, lib):
    """Tests the reference implementation passes in the grading container (from `c0.py check`)."""
    if lib not in REFERENCE:
        report = json.loads((run_dir.parent.parent / "_check" / lib / "reference" / "report.json").read_text())
        REFERENCE[lib] = {test["nodeid"] for test in report["tests"] if test["outcome"] in ("passed", "xpassed")}
    return REFERENCE[lib]


def unfinished_tests(run_dir, meta, stop):
    """How many tests that the reference passes fail, error or are missing at this stop; None when the suite did not finish."""
    report = run_dir / "grade" / f"stop-{stop['index']}" / "report.json"
    if stop.get("suite_timed_out") or not report.exists():
        return None
    outcomes = {test["nodeid"]: test["outcome"] for test in json.loads(report.read_text()).get("tests", [])}
    return sum(1 for nodeid in reference_passed_ids(run_dir, meta["lib"]) if outcomes.get(nodeid) not in CLEAN)


def stop_kind(run_dir, meta, stop):
    """Why one Pi invocation ended.

    finished: no test that the reference passes fails here, whoever ended the invocation. A test that is skipped
    or is an expected failure counts as not failing: the suite reports success to the agent, although Commit0 does
    not count that test as passed (prompt-toolkit has one expected failure, one tornado test skips itself for some
    implementations). A session that the time limit ended with every test passing is finished at the limit.
    wall-time: the harness cut it with failing tests left. provider-error: Pi exited on a request the provider
    rejected. agent: the agent ended its turn with failing tests left.
    """
    if stop.get("passed") is not None and stop["passed"] >= meta.get("reference_passed", stop.get("tests", 0)):
        return "finished"
    if stop.get("timed_out"):
        return "wall-time"
    if stop.get("exit") not in (0, None):
        return "provider-error"
    if unfinished_tests(run_dir, meta, stop) == 0:
        return "finished"
    return "agent"


def assistant_replies(entries):
    return [e for e in entries if e.get("type") == "message" and e["message"].get("role") == "assistant"]


def run_row(run_dir):
    meta = json.loads((run_dir / "meta.json").read_text())
    entries = journal_entries(run_dir)
    replies = assistant_replies(entries)
    # Tokens and cost count every request of the run: the session's own and those of the child agents it started.
    children = child_journals(run_dir)
    child_replies = [reply for journal in children for reply in assistant_replies(journal)]
    child_usage = [e["message"].get("usage") or {} for e in child_replies]
    child_summaries = [e.get("usage") or {} for journal in children for e in journal if e.get("type") == "compaction"]
    child_cost = sum((u.get("cost") or {}).get("total") or 0 for u in child_usage + child_summaries)
    own_usage = [e["message"].get("usage") or {} for e in replies]
    usage = own_usage + child_usage
    boundaries = [(i, e) for i, e in enumerate(entries) if e.get("type") == "compaction"]
    waits, summary_cost, kinds, summary_tokens = [], 0.0, [], {"input": 0, "output": 0}
    for index, entry in boundaries:
        details = entry.get("details") if isinstance(entry.get("details"), dict) else {}
        kinds.append("posthorse" if details.get("posthorse") == 1 else "stock")
        waits.append((parse_time(entry["timestamp"]) - parse_time(entries[index - 1]["timestamp"])).total_seconds())
        summary_usage = entry.get("usage") or {}
        summary_cost += (summary_usage.get("cost") or {}).get("total") or 0
        summary_tokens["input"] += (summary_usage.get("input") or 0) + (summary_usage.get("cacheRead") or 0) + (summary_usage.get("cacheWrite") or 0)
        summary_tokens["output"] += summary_usage.get("output") or 0
    commands = [c["arguments"].get("command", "") for e in replies + child_replies for c in e["message"]["content"]
                if c.get("type") == "toolCall" and c.get("name") == "bash"]
    tools = {}
    for e in replies:
        for c in e["message"]["content"]:
            if c.get("type") == "toolCall":
                tools[c["name"]] = tools.get(c["name"], 0) + 1
    score_path = run_dir / "score.json"
    stops = meta.get("stops", [])
    final = json.loads(score_path.read_text()).get("final", {}) if score_path.exists() else (stops[-1] if stops else {})
    ended = meta.get("ended")
    last = replies[-1]["timestamp"] if replies else None
    minutes = (parse_time(ended or last) - parse_time(meta["started"])).total_seconds() / 60 if (ended or last) else None
    stop_kinds = [stop_kind(run_dir, meta, stop) for stop in stops]
    # Time the agent had: the Pi invocations only, without the grading between them.
    working = sum((parse_time(stop["ended"]) - parse_time(stop["started"])).total_seconds() for stop in stops if stop.get("ended")) / 60
    finished_at = next((i for i, kind in enumerate(stop_kinds) if kind == "finished"), None)
    # The first stop that was the agent's own doing: a provider error is not its decision.
    own_at = next((i for i, kind in enumerate(stop_kinds) if kind != "provider-error"), None)

    def working_until(index):
        return round(sum((parse_time(stop["ended"]) - parse_time(stop["started"])).total_seconds() for stop in stops[:index + 1]) / 60, 1)

    def spent_until(index):
        """Tokens and list-price cost of every request up to the end of one stop, summary requests included."""
        limit = parse_time(stops[index]["ended"]).timestamp() + 1
        total = {"cost": 0.0, "output_tokens": 0, "uncached_input_tokens": 0, "cache_read_tokens": 0}
        for entry in [*entries, *(entry for journal in children for entry in journal)]:
            if "timestamp" not in entry or parse_time(entry["timestamp"]).timestamp() > limit:
                continue
            if entry.get("type") == "message" and entry["message"].get("role") == "assistant":
                u = entry["message"].get("usage") or {}
            elif entry.get("type") == "compaction":
                u = entry.get("usage") or {}
            else:
                continue
            total["cost"] += (u.get("cost") or {}).get("total") or 0
            total["output_tokens"] += u.get("output") or 0
            total["uncached_input_tokens"] += u.get("input") or 0
            total["cache_read_tokens"] += u.get("cacheRead") or 0
        total["cost"] = round(total["cost"], 2)
        return total

    def children_cut_at(stop):
        """Child agents at work when this invocation ended: their last reply, in its last 5 minutes, still called a tool.

        The sandbox ends every process of the run when the parent exits, so these children did not finish.
        A lead for a human to check: a child the parent stopped itself looks the same.
        """
        if not stop.get("ended"):
            return None
        end = parse_time(stop["ended"]).timestamp() + 1
        cut = 0
        for journal in children:
            before = [r for r in assistant_replies(journal) if parse_time(r["timestamp"]).timestamp() <= end]
            if before and before[-1]["message"].get("stopReason") == "toolUse" and end - parse_time(before[-1]["timestamp"]).timestamp() <= 300:
                cut += 1
        return cut

    return {
        "children_cut_at_stops": [children_cut_at(stop) for stop in stops],
        "failing_at_stops": [unfinished_tests(run_dir, meta, stop) for stop in stops],
        "first_own_stop_kind": None if own_at is None else stop_kinds[own_at],
        "passed_at_first_own_stop": None if own_at is None else stops[own_at]["passed"],
        "minutes_to_first_own_stop": None if own_at is None else working_until(own_at),
        "spent_to_finish": None if finished_at is None else spent_until(finished_at),
        "stop_kinds": stop_kinds, "agent_stops": stop_kinds.count("agent"), "provider_error_stops": stop_kinds.count("provider-error"),
        "working_minutes": round(working, 1),
        "minutes_to_finish": None if finished_at is None else round(
            sum((parse_time(stop["ended"]) - parse_time(stop["started"])).total_seconds() for stop in stops[:finished_at + 1]) / 60, 1),
        "uncached_input_tokens": sum(u.get("input") or 0 for u in usage),
        "cache_read_tokens": sum(u.get("cacheRead") or 0 for u in usage),
        "cache_write_tokens": sum(u.get("cacheWrite") or 0 for u in usage),
        "summary_input_tokens": summary_tokens["input"], "summary_output_tokens": summary_tokens["output"],
        "run": meta["run"], "lib": meta["lib"], "arm": meta["arm"], "rep": meta["rep"], "window": meta["window"],
        "outcome": meta.get("outcome", "running"), "void": (meta.get("void") or {}).get("why"), "passed": final.get("passed"), "tests": final.get("tests"), "share": final.get("share"),
        "reference_passed": meta.get("reference_passed"),
        "passed_at_stops": [stop["passed"] for stop in stops],
        # Only where Commit0's command runs every test twice (c0once.py): the count with each test run once.
        "passed_once_at_stops": [(stop.get("once") or {}).get("passed") for stop in stops],
        "minutes_at_stops": [round((parse_time(stop["ended"]) - parse_time(meta["started"])).total_seconds() / 60, 1) for stop in stops],
        "test_files_changed": len(final.get("test_files_changed", [])) if final else None,
        "replies": len(replies), "boundaries": len(boundaries), "boundary_kinds": sorted(set(kinds)),
        "boundary_wait_s": round(sum(waits), 1), "minutes": None if minutes is None else round(minutes, 1),
        "peak_context": max((u.get("totalTokens") or 0 for u in own_usage), default=0),
        "context_now": (own_usage[-1].get("totalTokens") if own_usage else None),
        "child_agents": len(children), "child_replies": len(child_replies), "child_cost": round(child_cost, 2),
        "child_output_tokens": sum(u.get("output") or 0 for u in child_usage),
        "child_boundaries": sum(1 for journal in children for e in journal if e.get("type") == "compaction"),
        "child_peak_context": max((u.get("totalTokens") or 0 for u in child_usage), default=0),
        "input_tokens": sum((u.get("input") or 0) + (u.get("cacheRead") or 0) + (u.get("cacheWrite") or 0) for u in usage),
        "output_tokens": sum(u.get("output") or 0 for u in usage),
        "cost": round(sum((u.get("cost") or {}).get("total") or 0 for u in usage + child_summaries) + summary_cost, 2),
        "summary_cost": round(summary_cost, 2),
        "tools": tools,
        "direct_docker_or_pip": [c[:120] for c in commands if "docker" in c or "pip install" in c or "pip download" in c],
    }


def main():
    runs_dir = Path(sys.argv[1])
    wanted = sys.argv[2] if len(sys.argv) > 2 else ""
    rows = [run_row(p.parent) for p in sorted(runs_dir.glob("*/meta.json")) if wanted in p.parent.name]
    for row in rows:
        print(json.dumps(row))
    columns = ["run", "outcome", "passed", "tests", "share", "passed_at_stops", "test_files_changed", "replies", "boundaries", "boundary_wait_s",
               "minutes", "peak_context", "context_now", "output_tokens", "cost", "summary_cost"]
    print("\t".join(columns), file=sys.stderr)
    for row in rows:
        print("\t".join(str(row[c]) for c in columns), file=sys.stderr)


if __name__ == "__main__":
    main()
