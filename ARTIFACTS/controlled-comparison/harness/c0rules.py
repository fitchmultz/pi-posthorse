#!/usr/bin/env python3
"""Whether the rules given once in the first message were kept, by position in the session.

Usage: c0rules.py RUNS_DIR [RUN_NAME_SUBSTRING]   (RUNS_DIR: c0runs/MODEL_TAG)

Rule 3 says: after every run of the whole test suite, commit with the message `tests: N passed`.
A whole-suite run is a bash call that runs pytest without narrowing it: no path below the test directory,
no `::` test id, no -k, -m, --lf or --ff. The rule is kept for that run when a commit with a well-formed message
follows before the next whole-suite run (or the end of the session).
Each whole-suite run is counted under the number of context boundaries that came before it.
Whole-suite runs of child agents count as well (the rule says every run); boundaries are those of the session itself.
One JSON object per run on stdout.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

from table import child_journals, journal_entries, parse_time

MESSAGE = re.compile(r"^tests: \d+ passed$")
NARROWING = {"-k", "-m", "--lf", "--last-failed", "--ff", "--failed-first"}


def whole_suite(command, test_dir):
    if "pytest" not in command:
        return False
    tokens = re.sub(r"([;|&<>]+)", r" \1 ", command.replace('"', " ").replace("'", " ")).split()
    start = next(
        (i for i, token in enumerate(tokens) if token.endswith("pytest")
         and (i == 0 or tokens[i - 1].endswith("envrun") or tokens[i - 1] == "-m" or re.fullmatch(r"[;|&]+", tokens[i - 1]))),
        None,
    )
    if start is None:
        return False
    test_dir = test_dir.strip("/")
    for token in tokens[start + 1:]:
        if re.fullmatch(r"[;|&<>]+", token):
            break
        if token in NARROWING or "::" in token:
            return False
        if not token.startswith("-") and (token.endswith(".py") or (token.strip("/") != test_dir and token.strip("/").startswith(test_dir + "/"))):
            return False
    return True


def run_row(run_dir):
    meta = json.loads((run_dir / "meta.json").read_text())
    task = json.loads((run_dir.parent.parent.parent / "c0cache" / meta["lib"] / "task.json").read_text())
    entries = journal_entries(run_dir)
    boundaries = [parse_time(e["timestamp"]) for e in entries if e.get("type") == "compaction"]
    full_runs = []
    child_runs = 0
    for own, journal in [(True, entries), *((False, journal) for journal in child_journals(run_dir))]:
        for entry in journal:
            if entry.get("type") != "message" or entry["message"].get("role") != "assistant":
                continue
            for call in entry["message"]["content"]:
                if call.get("type") == "toolCall" and call["name"] == "bash" and whole_suite(call["arguments"].get("command", ""), task["test_dir"]):
                    full_runs.append(parse_time(entry["timestamp"]))
                    child_runs += not own
    full_runs.sort()
    log = subprocess.run(["git", "-C", str(run_dir / "ws" / "repo"), "log", "--reverse", "--format=%cI%x09%s"], capture_output=True, text=True).stdout
    commits = [(parse_time(line.split("\t", 1)[0]), line.split("\t", 1)[1]) for line in log.splitlines()[1:]]
    by_position = {}
    for index, at in enumerate(full_runs):
        until = full_runs[index + 1] if index + 1 < len(full_runs) else None
        kept = any(at <= when and (until is None or when < until) and MESSAGE.match(message) for when, message in commits)
        position = sum(boundary < at for boundary in boundaries)
        cell = by_position.setdefault(position, {"whole_suite_runs": 0, "followed_by_commit": 0})
        cell["whole_suite_runs"] += 1
        cell["followed_by_commit"] += kept
    stops = meta.get("stops") or [{}]
    return {
        "run": meta["run"], "arm": meta["arm"], "void": bool(meta.get("void")), "ended": "ended" in meta,
        "boundaries": len(boundaries), "whole_suite_runs": len(full_runs),
        "whole_suite_runs_by_children": child_runs,
        "commits": len(commits), "well_formed_commits": sum(bool(MESSAGE.match(m)) for _, m in commits),
        "kept_by_boundaries_before": {str(k): v for k, v in sorted(by_position.items())},
        "test_files_changed": len(stops[-1].get("test_files_changed", [])),
    }


def main():
    runs_dir = Path(sys.argv[1])
    wanted = sys.argv[2] if len(sys.argv) > 2 else ""
    for meta_path in sorted(runs_dir.glob("*/meta.json")):
        if wanted in meta_path.parent.name:
            print(json.dumps(run_row(meta_path.parent)))


if __name__ == "__main__":
    main()
