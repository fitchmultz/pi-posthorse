#!/usr/bin/env python3
"""Grade stops again with every test run once, for a library whose Commit0 command runs every test twice.

Usage: c0once.py check LIB                 (the finished library must pass the same tests in one pass)
       c0once.py grade MODEL_TAG RUN...    (ended runs only; adds `once` to each stop in meta.json)

Commit0's command for networkx is `pytest --pyargs networkx ... networkx/`. The package name and its directory
both name the whole suite, so pytest runs each test twice in one process, and the report keeps the second result.
A half-built library can leave state behind in the first pass and then fail most of the second pass, although
the same tests pass when each runs once (sol run, networkx-A-r0 and -r2: a failing configuration test left a
backend selected; 4701 and 4801 tests passed in the first pass, 1737 and 1765 count officially).
The official grade stays where it is. The one-pass grade goes beside it: `once` on the stop, files in
grade/stop-N.once/.
"""
import json
import sys

import c0

TWICE = {"networkx"}


def once(task):
    """The task with a test command that names the suite one time."""
    if task["lib"] not in TWICE:
        sys.exit(f"{task['lib']}: Commit0's command already runs each test once.")
    line = next(l for l in task["eval_script"].splitlines() if "--json-report" in l)
    if "--pyargs" not in line or "{test_ids}" not in line:
        sys.exit(f"{task['lib']}: Commit0's test command changed shape: {line}")
    return {**task, "test_dir": ""}


def cmd_check(lib):
    task = c0.load_task(lib)
    out = c0.RUNS / "_check" / lib / "once"
    result = c0.grade(once(task), (c0.CACHE / lib / "reference.diff").read_text(), out)
    twice = json.loads((c0.RUNS / "_check" / lib / "check.json").read_text())["reference"]["passed"]
    print(f"{lib} reference: once={result['passed']} twice={twice} of {result['tests']} ({result['test_seconds']}s)", flush=True)
    if result["passed"] != twice:
        sys.exit(f"{lib}: the finished library passes a different number of tests in one pass.")


def cmd_grade(model_tag, run_names):
    for run_name in run_names:
        run_dir = c0.RUNS / model_tag / run_name
        meta = json.loads((run_dir / "meta.json").read_text())
        if "ended" not in meta:
            sys.exit(f"{run_name} has not ended.")
        task = c0.load_task(meta["lib"])
        for stop in meta["stops"]:
            if "once" in stop:
                continue
            patch, _ = c0.run_patch(run_dir, meta, task, stop["commit"])
            result = c0.grade(once(task), patch, run_dir / "grade" / f"stop-{stop['index']}.once")
            stop["once"] = {key: result[key] for key in ("passed", "tests", "share", "xfail", "patch_applied", "suite_timed_out", "test_seconds")}
            (run_dir / "meta.json").write_text(json.dumps(meta, indent=1))
        print(f"{run_name} once={[stop['once']['passed'] for stop in meta['stops']]} official={[stop['passed'] for stop in meta['stops']]}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "check":
        cmd_check(sys.argv[2])
    elif len(sys.argv) >= 4 and sys.argv[1] == "grade":
        cmd_grade(sys.argv[2], sys.argv[3:])
    else:
        sys.exit(__doc__)
