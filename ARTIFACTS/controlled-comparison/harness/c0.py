#!/usr/bin/env python3
"""Controlled comparison, long tasks: one Pi session implements one Commit0 library against its tests.

Usage (run with ROOT/commit0/.venv/bin/python):
  c0.py prepare LIB...                      copy the library skeleton and its Python environment out of the Commit0 image
  c0.py check LIB...                        grade the skeleton and the reference implementation (no model call)
  c0.py run LIB ARM REP MODEL [options]     ARM is a directory under agents/ (A = stock Pi, B = Pi with Posthorse); MODEL is provider/id
      --window N        context window in tokens for both arms (default: 128000)
      --wall-hours H    stop the run after H hours (default: 5)
      --nudges K        when Pi stops with tests still failing, send "Continue." up to K times (default: 0)
      --label TEXT      suffix for the run directory name
  c0.py score MODEL_TAG [RUN...]            grade each run's final tree with Commit0's own test script
      --snapshots       also grade every snapshot taken during the run
  c0.py regrade MODEL_TAG RUN... --why TEXT grade the stops of ended runs again when their grading patch was wrong during the run
  c0.py recover-stop MODEL_TAG RUN --why TEXT  record and grade a stop the harness lost when it failed after Pi ended its turn

Layout (ROOT is the directory above this script's directory):
  ROOT/c0cache/LIB/         repo/ (skeleton, one baseline commit, no upstream history), venv/, task.json, reference.diff
  ROOT/c0runs/MODEL_TAG/RUN/ one directory per run: ws/ (what the agent sees), shadow.git (harness snapshots), session/, meta.json
"""
import argparse
import bz2
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import c0open
import cc
from cc import ROOT, sh, now

DATASET, SPLIT = "wentingzhao/commit0_combined", "test"
CACHE = ROOT / "c0cache"
RUNS = ROOT / "c0runs"
DEFAULT_WINDOW = 128_000
SNAPSHOT_SECONDS = 300
# Commit0's default limit for a whole suite is 1800 s. No reference suite here takes longer than 141 s, and a tree
# with a runaway loop would hold a run up for half an hour at every stop, so the limits are lower.
EVAL_TIMEOUT_SECONDS = 900  # when a run stops and at its end
SNAPSHOT_TIMEOUT_SECONDS = 600  # for the 5-minute snapshots
# One hanging test would otherwise turn a whole score into zero, so grading adds a per-test limit with
# pytest-timeout (installed from ROOT/wheels into the throwaway grading container; the agent's environment is untouched).
TEST_TIMEOUT_SECONDS = 120
WHEELS = ROOT / "wheels"
NUDGE = "Continue."
# Paths that hold tests, when they differ from the dataset's test_dir.
TEST_PATHS = {"chardet": ["test.py", "tests"]}

PROMPT = """The directory repo/ holds the Python library {name} with the bodies of its functions and methods removed (each is now `pass`). Implement the library so that its test suite passes. I am away until you are done, so do not stop to ask questions or to report progress.

The current directory holds:
- repo/: the library. The code to implement is under repo/{src}. The tests are {tests}.
- bin/envrun COMMAND: runs COMMAND in the library's prepared Python environment, with repo/ as its working directory. Use it to run the tests, for example `bin/envrun {test_cmd} {test_dir}`. Python on this machine does not have the dependencies, and there is no network access.

Rules:
1. Do not create, change or delete any test file. Put scratch files in scratch/ instead.
2. Write the implementation yourself. Do not install the library or copy its code from anywhere.
3. After every run of the whole test suite, commit your work in repo/ with git. The commit message must be the result in this exact form: `tests: N passed` (N is the number of passing tests).

You are done when the whole test suite passes, or when you can state for each remaining failure why it cannot be fixed.
"""

ENVRUN = """#!/bin/bash
# Usage: bin/envrun COMMAND
# Runs COMMAND in the library's prepared Python environment, with repo/ as the working directory.
# For shell syntax, pass COMMAND as one quoted string: bin/envrun "cd tests && pytest -x test_a.py"
set -euo pipefail
if [ $# -lt 1 ]; then
  sed -n 2,4p "$0" >&2
  exit 2
fi
if [ $# -eq 1 ]; then command="$1"; else command="$(printf '%q ' "$@")"; fi
exec docker exec -i --user {uid}:{gid} --env HOME={home} --workdir /testbed "{container}" \\
  bash -c 'command="$1"; set --; source /testbed/.venv/bin/activate && eval "$command"' envrun "$command"
"""

GIT_ID = ["-c", "user.name=harness", "-c", "user.email=harness@localhost"]


def git(repo, *args, capture=False, check=True, stdin=None):
    return sh("git", "-C", repo, *args, capture=capture, check=check, stdin=stdin)


def task_rows():
    from datasets import load_dataset

    return {row["repo"].split("/")[-1]: row for row in load_dataset(DATASET, split=SPLIT)}


def load_task(lib):
    path = CACHE / lib / "task.json"
    if not path.exists():
        sys.exit(f"{lib} is not prepared. Run: c0.py prepare {lib}")
    return json.loads(path.read_text())


def test_paths(task):
    return TEST_PATHS.get(task["lib"], [task["test_dir"].rstrip("/")])


# networkx keeps its tests inside the package (test_dir equals src_dir), so its test files are named by pattern.
# Without this the grading patch left out the whole package and every grade was the empty skeleton.
TEST_FILE_PATTERNS = {"networkx": ["networkx/**/tests/**", "networkx/conftest.py"]}


def test_specs(task, exclude=False):
    """Git pathspecs for the library's test files."""
    specs = []
    for path in TEST_FILE_PATTERNS.get(task["lib"], test_paths(task)):
        magic = (["exclude"] if exclude else []) + (["glob"] if "*" in path else [])
        specs.append(f":({','.join(magic)}){path}" if magic else path)
    return specs


def official_test_ids(lib):
    import commit0

    path = Path(commit0.__file__).parent / "data" / "test_ids" / f"{lib.lower().replace('.', '-')}.bz2"
    with bz2.open(path, "rt") as handle:
        return handle.read().split("\n")


def cmd_prepare(args):
    from commit0.harness.spec import make_spec

    rows = task_rows()
    for lib in args.libs:
        row = rows[lib]
        spec = make_spec(row)
        image = spec.repo_image_tag
        out = CACHE / lib
        if (out / "task.json").exists():
            print(f"{lib} already prepared", flush=True)
            continue
        shutil.rmtree(out, ignore_errors=True)
        out.mkdir(parents=True)
        if sh("docker", "image", "inspect", image, capture=True, check=False).returncode:
            sh("docker", "pull", "-q", image, capture=True)
        created = sh("docker", "create", image, capture=True).stdout.strip().splitlines()[-1]
        try:
            sh("docker", "cp", "-q", f"{created}:/testbed", out / "repo")
        finally:
            sh("docker", "rm", "-f", created, capture=True)
        repo = out / "repo"
        head = git(repo, "rev-parse", "HEAD", capture=True).stdout.strip()
        if head != row["base_commit"] or git(repo, "status", "--porcelain", capture=True).stdout.strip():
            sys.exit(f"{lib}: the image's checkout is not a clean copy of base_commit {row['base_commit']}")
        tracked = git(repo, "ls-files", "-z", capture=True).stdout
        reference = sh("git", "-C", repo, "diff", "--binary", row["base_commit"], row["reference_commit"], capture=True).stdout
        (out / "reference.diff").write_text(reference)
        # The image keeps the upstream history (the reference implementation is one `git show` away) and, for some
        # libraries, compiled files of the reference. The agent gets neither.
        shutil.rmtree(repo / ".git")
        shutil.move(repo / ".venv", out / "venv")
        removed = 0
        for cached in list(repo.rglob("__pycache__")):
            shutil.rmtree(cached)
            removed += 1
        # Packaging output that is not tracked can hold the whole reference (pylint's image has build/lib/pylint).
        built = [name for name in ("build", "dist") if (repo / name).is_dir() and f"{name}/" not in tracked]
        for name in built:
            shutil.rmtree(repo / name)
        (repo / ".venv").mkdir()
        git(repo, "init", "-q", "-b", "main")
        (repo / ".git" / "info" / "exclude").write_text(".venv/\n")
        git(repo, "config", "user.name", "agent")
        git(repo, "config", "user.email", "agent@localhost")
        (out / "tracked").write_text(tracked)
        git(repo, "add", "-f", "--pathspec-from-file", out / "tracked", "--pathspec-file-nul")
        git(repo, "commit", "-q", "-m", f"{lib}: skeleton")
        task = {
            "lib": lib, "repo": row["repo"], "image": image, "base_commit": row["base_commit"],
            "reference_commit": row["reference_commit"], "src_dir": row["src_dir"], "test_dir": row["test"]["test_dir"],
            "test_cmd": row["test"]["test_cmd"], "python": row["setup"].get("python"),
            "eval_script": spec.eval_script, "test_ids": len(official_test_ids(lib)),
            "tracked_files": tracked.count("\0"), "pycache_dirs_removed": removed, "untracked_build_dirs_removed": built,
        }
        (out / "task.json").write_text(json.dumps(task, indent=1))
        print(f"{lib} prepared: {task['tracked_files']} files, {task['test_ids']} tests, {removed} compiled-file directories removed", flush=True)


def shadow(run_dir, *args, capture=False, check=True):
    return sh("git", "--git-dir", run_dir / "shadow.git", "--work-tree", run_dir / "ws" / "repo", *GIT_ID, *args, capture=capture, check=check)


def snapshot(run_dir, label):
    shadow(run_dir, "add", "-A", capture=True)
    shadow(run_dir, "commit", "-q", "--allow-empty", "-m", f"{label} {now()}", capture=True)
    return shadow(run_dir, "rev-parse", "HEAD", capture=True).stdout.strip()


def build_workspace(run_dir, lib, container):
    """What the agent sees is ws/. The Python environment and the snapshot repository stay outside it."""
    task = load_task(lib)
    ws = run_dir / "ws"
    for sub in ("bin", "scratch"):
        (ws / sub).mkdir(parents=True)
    sh("cp", "-a", "--reflink=auto", CACHE / lib / "repo", ws / "repo")
    sh("cp", "-a", "--reflink=auto", CACHE / lib / "venv", run_dir / "venv")
    sh("git", "init", "-q", "--bare", run_dir / "shadow.git")
    (run_dir / "shadow.git" / "info" / "exclude").write_text(".venv/\n")
    shadow(run_dir, "add", "-f", "--pathspec-from-file", CACHE / lib / "tracked", "--pathspec-file-nul")
    shadow(run_dir, "commit", "-q", "-m", "baseline")
    baseline = shadow(run_dir, "rev-parse", "HEAD", capture=True).stdout.strip()
    sh("docker", "run", "-d", "--name", container, "--network", "none", *cc.MEMORY_FLAGS, "-v", f"{ws / 'repo'}:/testbed",
       "-v", f"{run_dir / 'venv'}:/testbed/.venv", "-w", "/testbed", task["image"], "sleep", "infinity", capture=True)
    setup = [
        f"echo 'cc:x:{cc.UID}:{cc.GID}::{cc.CONTAINER_HOME}:/bin/bash' >> /etc/passwd",
        f"mkdir -p {cc.CONTAINER_HOME} && chown {cc.UID}:{cc.GID} {cc.CONTAINER_HOME}",
        "git config --system --add safe.directory '*'",
        # Python 3.12 environments point at an interpreter under /root, which only root can enter by default.
        "chmod 755 /root && if [ -d /root/.local ]; then chmod -R a+rX /root/.local; fi",
        # The installer's cache holds an unpacked copy of the finished library in some images (jinja, pydantic, pylint).
        "rm -rf /root/.cache",
    ]
    sh("docker", "exec", container, "bash", "-c", " && ".join(setup), capture=True)
    envrun = ws / "bin" / "envrun"
    envrun.write_text(ENVRUN.format(uid=cc.UID, gid=cc.GID, home=cc.CONTAINER_HOME, container=container))
    envrun.chmod(0o755)
    return task, baseline


def teardown(run_dir, container):
    sh("docker", "rm", "-f", container, capture=True, check=False)
    shutil.rmtree(run_dir / "venv", ignore_errors=True)


def grade(task, patch, out_dir, timeout=EVAL_TIMEOUT_SECONDS):
    """Run Commit0's test script on a fresh container of the library's image, with the patch applied to the skeleton.

    A suite that does not finish in time counts as no tests passing, as in Commit0.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "patch.diff").write_text(patch, errors=PATCH_ERRORS)
    script = task["eval_script"].format(test_ids=task["test_dir"], coverage="")
    marker, activate = " --json-report ", "source .venv/bin/activate\n"
    if script.count(marker) != 1 or script.count(activate) != 1:
        sys.exit(f"{task['lib']}: Commit0's test script changed shape; the per-test limit cannot be added")
    script = script.replace(activate, activate + "uv pip install --offline --no-deps /wheels/pytest_timeout-*.whl\n")
    script = script.replace(marker, f" --timeout={TEST_TIMEOUT_SECONDS}{marker}")
    (out_dir / "eval.sh").write_text(script + "\ncp report.json test_output.txt pytest_exit_code.txt /out/ 2>/dev/null\nchmod -R a+rwX /out\n")
    started = time.time()
    name = f"c0-grade-{os.getpid()}-{int(started * 1000)}"
    try:
        result = subprocess.run(
            ["docker", "run", "--rm", "--name", name, "--network", "none", *cc.MEMORY_FLAGS, "-v", f"{out_dir}:/out", "-v", f"{WHEELS}:/wheels:ro",
             "-v", f"{out_dir / 'patch.diff'}:/patch.diff:ro", task["image"], "/bin/bash", "/out/eval.sh"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=timeout,
        )
        (out_dir / "eval_stdout.txt").write_text(result.stdout)
        timed_out = False
    except subprocess.TimeoutExpired:
        timed_out = True
        sh("docker", "rm", "-f", name, capture=True, check=False)
    ids = official_test_ids(task["lib"])
    report_path = out_dir / "report.json"
    outcomes = {}
    if report_path.exists() and not timed_out:
        for test in json.loads(report_path.read_text()).get("tests", []):
            if test.get("call") is not None:
                outcomes[test["nodeid"]] = test["call"]["outcome"]
    status = Counter(outcomes.get(test_id, "failed") for test_id in ids)
    passed = status["passed"] + status["xfail"]
    applied = "error:" not in (out_dir / "eval_stdout.txt").read_text() if not timed_out else None
    return {
        "passed": passed, "tests": len(ids), "share": round(passed / len(ids), 4), "xfail": status["xfail"],
        "patch_bytes": len(patch), "patch_applied": applied, "suite_timed_out": timed_out,
        "test_seconds": round(time.time() - started, 1),
    }


def library_copies(run_dir, task, container):
    """Files outside the library's own source directory that are named like its largest modules.

    Looks through the whole container, which holds everything the agent can read of the library: the workspace is
    mounted at /testbed and its Python environment at /testbed/.venv. The skeleton is the only copy the agent may
    have; any other is a finished implementation (a build directory, an installer cache, an installed package).
    """
    source = run_dir / "ws" / "repo" / task["src_dir"].strip("/")
    modules = sorted((path.relative_to(source) for path in source.rglob("*.py") if not {"tests", "test"} & set(path.relative_to(source).parts)),
                     key=lambda path: (source / path).stat().st_size, reverse=True)[:5]
    found = set()
    for module in modules:
        listed = sh("docker", "exec", container, "bash", "-c",
                    f"find / \\( -path /proc -o -path /sys \\) -prune -o -type f -path '*/{source.name}/{module}' -print 2>/dev/null", capture=True, check=False)
        found.update(line for line in listed.stdout.split("\n") if line and not line.startswith(f"/testbed/{task['src_dir'].strip('/')}/"))
    return sorted(found)


def cmd_check(args):
    for lib in args.libs:
        task = load_task(lib)
        out = RUNS / "_check" / lib
        shutil.rmtree(out, ignore_errors=True)
        skeleton = grade(task, "", out / "skeleton")
        reference = grade(task, (CACHE / lib / "reference.diff").read_text(), out / "reference")
        # The same reference through the route the agent uses: workspace copy, bin/envrun, no upstream history.
        run_dir = out / "route"
        container = f"c0-check-{lib}"
        sh("docker", "rm", "-f", container, capture=True, check=False)
        _, baseline = build_workspace(run_dir, lib, container)
        try:
            repo = run_dir / "ws" / "repo"
            copies = library_copies(run_dir, task, container)
            if copies:
                sys.exit(f"{lib}: the agent could read a copy of the library outside its skeleton: {copies[:6]}")
            git(repo, "apply", "-", stdin=(CACHE / lib / "reference.diff").read_text())
            # The same reference through the patch a run is graded with: snapshot, then the diff without test files.
            patch, touched = run_patch(run_dir, {"baseline": baseline}, task, snapshot(run_dir, "reference"))
            as_run = grade(task, patch, out / "as-run")
            if as_run["passed"] != reference["passed"] or touched:
                sys.exit(f"{lib}: the reference passes {reference['passed']} tests, but only {as_run['passed']} through the patch a run is graded with "
                         f"(test files in the reference: {len(touched)}). The test paths of this library are wrong.")
            command = f"{task['test_cmd']} --json-report --json-report-file=.c0-report.json --continue-on-collection-errors {task['test_dir']} > /dev/null 2>&1"
            started = time.time()
            sh(run_dir / "ws" / "bin" / "envrun", command, capture=True, check=False)
            seconds = round(time.time() - started, 1)
            outcomes = {t["nodeid"]: t["call"]["outcome"] for t in json.loads((repo / ".c0-report.json").read_text())["tests"] if t.get("call") is not None}
            status = Counter(outcomes.get(test_id, "failed") for test_id in official_test_ids(lib))
            route = {"passed": status["passed"] + status["xfail"], "test_seconds": seconds}
        finally:
            teardown(run_dir, container)
        result = {"lib": lib, "tests": skeleton["tests"], "skeleton": skeleton, "reference": reference, "route": route}
        (out / "check.json").write_text(json.dumps(result, indent=1))
        print(f"{lib} tests={skeleton['tests']} skeleton={skeleton['passed']} reference={reference['passed']} ({reference['test_seconds']}s) "
              f"agent-route={route['passed']} ({route['test_seconds']}s) applied={reference['patch_applied']}", flush=True)


def cmd_run(args):
    provider, _, model_id = args.model.partition("/")
    run_name = f"{args.lib}-{args.arm}-r{args.rep}" + (f"-{args.label}" if args.label else "")
    run_dir = RUNS / model_id / run_name
    container = f"c0-{model_id.replace('.', '-')}-{run_name}"
    if run_dir.exists():
        meta_path = run_dir / "meta.json"
        if meta_path.exists() and "ended" in json.loads(meta_path.read_text()):
            print(f"{run_name} already done", flush=True)
            return
        if sh("docker", "inspect", "-f", "{{.State.Running}}", container, capture=True, check=False).stdout.strip() == "true":
            sys.exit(f"{run_name} is running now.")
        # The run was cut off (for example by a reboot). Keep what it left and start again.
        aside = RUNS / model_id / "_interrupted"
        aside.mkdir(exist_ok=True)
        shutil.rmtree(run_dir / "venv", ignore_errors=True)
        run_dir.rename(aside / f"{run_name}-{int(time.time())}")
        sh("docker", "rm", "-f", container, capture=True, check=False)
        print(f"{run_name} was interrupted; moved aside and starting again", flush=True)
    arm_dir = ROOT / "agents" / args.arm
    if not (arm_dir / "settings.json").exists():
        sys.exit(f"No arm {args.arm}: {arm_dir}/settings.json is missing.")
    # An arm can name its own Pi build (pi.json) and describe a Posthorse build that is not a release (posthorse-build.json).
    pi_build = json.loads((arm_dir / "pi.json").read_text()) if (arm_dir / "pi.json").exists() else None
    posthorse_build = json.loads((arm_dir / "posthorse-build.json").read_text()) if (arm_dir / "posthorse-build.json").exists() else None
    node, node_prefix = cc.node_paths()
    wall = int(args.wall_hours * 3600)
    run_dir.mkdir(parents=True)
    sh("cp", "-a", "--reflink=auto", arm_dir, run_dir / "agent")  # an arm with packages holds thousands of files
    cc.write_run_auth(run_dir / "agent", provider, wall + 3600)
    (run_dir / "agent" / "models.json").write_text(
        json.dumps({"providers": {provider: {"modelOverrides": {model_id: {"contextWindow": args.window}}}}})
    )
    (run_dir / "session").mkdir()
    task, baseline = build_workspace(run_dir, args.lib, container)
    paths = test_paths(task)
    prompt = PROMPT.format(
        name=args.lib, src=task["src_dir"].rstrip("/"), tests=" and ".join(f"repo/{p}" for p in paths) if len(paths) > 1 else f"under repo/{paths[0]}",
        test_cmd=task["test_cmd"], test_dir=task["test_dir"],
    )
    (run_dir / "PROMPT.md").write_text(prompt)
    check_path = RUNS / "_check" / args.lib / "check.json"
    if not check_path.exists():
        sys.exit(f"{args.lib} has no reference result. Run: c0.py check {args.lib}")
    ceiling = json.loads(check_path.read_text())["reference"]["passed"]
    posthorse = arm_dir / "npm" / "node_modules" / "pi-posthorse" / "package.json"
    meta = {
        "run": run_name, "lib": args.lib, "arm": args.arm, "rep": args.rep, "model": args.model, "thinking": args.thinking,
        "window": args.window, "wall_hours": args.wall_hours, "nudges_allowed": args.nudges, "reference_passed": ceiling,
        "baseline": baseline, "container": container,
        "pi_version": json.loads((cc.PI_PACKAGE / "package.json").read_text())["version"] if pi_build is None else pi_build["version"],
        "pi_build": pi_build, "posthorse_build": posthorse_build, "container_memory": cc.CONTAINER_MEMORY,
        "posthorse_version": json.loads(posthorse.read_text())["version"] if posthorse.exists() else None,
        "arm_settings": json.loads((arm_dir / "settings.json").read_text()),
        "harness_sha256": {name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest() for name in ("c0.py", "cc.py")},
        "image": task["image"], "image_id": sh("docker", "image", "inspect", "-f", "{{.Id}}", task["image"], capture=True).stdout.strip(),
        "base_commit": task["base_commit"], "test_timeout_seconds": TEST_TIMEOUT_SECONDS, "suite_timeout_seconds": EVAL_TIMEOUT_SECONDS,
        "runs_side_by_side": os.environ.get("C0_PARALLEL"), "host": os.uname().nodename, "kernel": os.uname().release,
        "started": now(), "snapshots": [], "stops": [],
    }
    # A setup whose agent ends a turn to wait for background work needs a Pi that stays open (c0open.py).
    stays_open = bool((pi_build or {}).get("stays_open"))
    meta["invocation"] = "rpc mode, open until nothing can wake the session" if stays_open else "print mode"
    if stays_open:
        meta["harness_sha256"]["c0open.py"] = hashlib.sha256((Path(__file__).parent / "c0open.py").read_bytes()).hexdigest()
    base = [*(["--mode", "rpc"] if stays_open else ["-p"]), "--model", args.model, "--thinking", args.thinking, "--session-dir", str(run_dir / "session")]
    (run_dir / "meta.json").write_text(json.dumps(meta, indent=1))
    # An arm that is somebody's whole setup brings its own global instructions file; the other arms load none.
    if not (pi_build or {}).get("context_files"):
        base.append("--no-context-files")
    stop = threading.Event()
    working = threading.Event()  # snapshots are taken only while Pi is working, not while the harness grades a stop

    def snapshots():
        while not stop.wait(SNAPSHOT_SECONDS):
            if working.is_set():
                meta["snapshots"].append({"at": now(), "commit": snapshot(run_dir, "snapshot")})

    watcher = threading.Thread(target=snapshots, daemon=True)
    watcher.start()
    deadline = time.time() + wall
    outcome = None
    try:
        while outcome is None:
            index = len(meta["stops"])
            message = prompt if index == 0 else NUDGE
            pi_args = base + ([] if index == 0 else ["--continue"]) + ([] if stays_open else ["--", message])
            record = {"index": index, "started": now(), "timed_out": False}
            with open(run_dir / f"stdout-{index}.txt", "w") as out, open(run_dir / f"stderr-{index}.txt", "w") as err:
                command = cc.sandbox(run_dir, node, node_prefix, pi_args, provider, pi_build)
                working.set()
                if stays_open:
                    record.update(c0open.invocation(command, message, deadline, run_dir, out, err))
                else:
                    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=out, stderr=err, start_new_session=True)
                    try:
                        record["exit"] = process.wait(timeout=max(1, deadline - time.time()))
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        record["exit"] = process.wait()
                        record["timed_out"] = True
                working.clear()
            record.update(ended=now(), commit=snapshot(run_dir, f"stop-{index}"))
            grading_started = time.time()
            patch, touched = run_patch(run_dir, meta, task, record["commit"])
            record.update(grade(task, patch, run_dir / "grade" / f"stop-{index}"), test_files_changed=touched)
            deadline += time.time() - grading_started  # the time cap counts the agent's work, not the grading
            meta["stops"].append(record)
            if record["timed_out"]:
                outcome = "wall-time"
            elif record["passed"] >= ceiling:
                outcome = "complete"
            elif index >= args.nudges:
                outcome = "stopped"
            (run_dir / "meta.json").write_text(json.dumps(meta, indent=1))
    finally:
        stop.set()
        watcher.join()
        meta.update(ended=now(), final=snapshot(run_dir, "final"), outcome=outcome or "harness-error")
        teardown(run_dir, container)
        (run_dir / "agent" / "auth.json").unlink(missing_ok=True)  # no credential stays in the run's data
        (run_dir / "meta.json").write_text(json.dumps(meta, indent=1))
    print(f"{run_name} {meta['outcome']} stops={[stop_['passed'] for stop_ in meta['stops']]} of {ceiling}", flush=True)


def cmd_regrade(args):
    """Grade the stops of finished runs again, for runs whose grading patch was wrong during the run.

    The values from the run stay in each stop under `graded_during_run`, and the old grading files move aside.
    """
    for run_name in args.runs:
        run_dir = RUNS / args.model_tag / run_name
        meta = json.loads((run_dir / "meta.json").read_text())
        if "ended" not in meta:
            sys.exit(f"{run_name} has not ended.")
        task = load_task(meta["lib"])
        changed = 0
        for stop in meta["stops"]:
            out = run_dir / "grade" / f"stop-{stop['index']}"
            patch, touched = run_patch(run_dir, meta, task, stop["commit"])
            if "graded_during_run" in stop or (out / "patch.diff").read_text(errors=PATCH_ERRORS) == patch:
                continue
            out.rename(run_dir / "grade" / f"stop-{stop['index']}.during-run")
            fields = ("passed", "tests", "share", "xfail", "patch_bytes", "patch_applied", "suite_timed_out", "test_seconds", "test_files_changed")
            stop["graded_during_run"] = {key: stop[key] for key in fields if key in stop}
            stop.update(grade(task, patch, out), test_files_changed=touched)
            changed += 1
            (run_dir / "meta.json").write_text(json.dumps(meta, indent=1))
        if changed:
            meta["regraded"] = {"at": now(), "stops": changed, "why": args.why}
            (run_dir / "meta.json").write_text(json.dumps(meta, indent=1))
            (run_dir / "score.json").unlink(missing_ok=True)  # its final grade and snapshots came from the wrong patch
        print(f"{run_name} regraded stops={changed} now={[stop['passed'] for stop in meta['stops']]} "
              f"during the run={[stop.get('graded_during_run', {}).get('passed', stop['passed']) for stop in meta['stops']]}", flush=True)


def cmd_recover_stop(args):
    """Record and grade a stop the harness lost: Pi had ended its turn and the tree was saved, then the harness failed.

    The run keeps the outcome harness-error, because it ended there, short of its time limit and of the "Continue."
    messages it had left. The process exit code was not kept, so the stop has none.
    """
    run_dir = RUNS / args.model_tag / args.run_name
    meta = json.loads((run_dir / "meta.json").read_text())
    if meta.get("outcome") != "harness-error":
        sys.exit(f"{args.run_name} did not end with a harness error.")
    index = len(meta["stops"])
    saved = shadow(run_dir, "log", "--format=%H %s", f"--grep=^stop-{index} ", capture=True).stdout.split()
    if len(saved) != 3:
        sys.exit(f"{args.run_name} has no saved tree for stop {index}.")
    commit, _, ended = saved
    born = int(sh("stat", "-c", "%W", run_dir / f"stdout-{index}.txt", capture=True).stdout)
    record = {
        "index": index, "started": datetime.fromtimestamp(born, timezone.utc).isoformat(timespec="seconds"), "timed_out": False,
        "exit": None, "ended": ended, "commit": commit,
        "recovered": {"at": now(), "why": args.why, "started_from": f"creation time of stdout-{index}.txt", "ended_from": "the saved tree"},
    }
    task = load_task(meta["lib"])
    patch, touched = run_patch(run_dir, meta, task, commit)
    record.update(grade(task, patch, run_dir / "grade" / f"stop-{index}"), test_files_changed=touched)
    meta["stops"].append(record)
    (run_dir / "meta.json").write_text(json.dumps(meta, indent=1))
    (run_dir / "score.json").unlink(missing_ok=True)  # its final grade was taken from the stop before
    print(f"{args.run_name} recovered stop {index}: passed={record['passed']} of {record['tests']} at {ended}", flush=True)


PATCH_ERRORS = "surrogateescape"  # bytes that are not UTF-8 survive reading and writing a patch unchanged


def run_patch(run_dir, meta, task, commit):
    """The run's change to the skeleton at one snapshot, without anything under the test paths."""
    # The agent can write a text file that is not UTF-8 (sphinx-A-r0 of the sol run did; reading its patch as UTF-8 ended
    # that run at its third stop). Such bytes pass through unchanged: PATCH_ERRORS on reading here and on every patch.diff.
    patch = subprocess.run(
        ["git", "--git-dir", str(run_dir / "shadow.git"), "--work-tree", str(run_dir / "ws" / "repo"), *GIT_ID,
         "diff", "--binary", meta["baseline"], commit, "--", ".", *test_specs(task, exclude=True)],
        check=True, stdout=subprocess.PIPE, text=True, errors=PATCH_ERRORS,
    ).stdout
    touched = shadow(run_dir, "diff", "--name-only", meta["baseline"], commit, "--", *test_specs(task), capture=True).stdout.split()
    return patch, touched


def cmd_score(args):
    for meta_path in sorted((RUNS / args.model_tag).glob("*/meta.json")):
        run_dir = meta_path.parent
        meta = json.loads(meta_path.read_text())
        if args.runs and meta["run"] not in args.runs:
            continue
        if "final" not in meta:
            continue
        task = load_task(meta["lib"])
        score_path = run_dir / "score.json"
        score = json.loads(score_path.read_text()) if score_path.exists() else {"snapshots": {}}
        if "final" not in score:
            if meta.get("stops"):  # the run graded each stop itself; nothing changes between the last stop and the end
                score["final"] = {k: v for k, v in meta["stops"][-1].items() if k not in ("index", "started", "ended", "exit", "commit")}
            else:
                patch, touched = run_patch(run_dir, meta, task, meta["final"])
                score["final"] = {**grade(task, patch, run_dir / "grade" / "final"), "test_files_changed": touched}
            score_path.write_text(json.dumps(score, indent=1))
        if args.snapshots:
            previous = None
            for item in meta["snapshots"]:
                commit = item["commit"]
                if commit in score["snapshots"]:
                    previous = commit
                    continue
                tree = shadow(run_dir, "rev-parse", f"{commit}^{{tree}}", capture=True).stdout.strip()
                same = previous and shadow(run_dir, "rev-parse", f"{previous}^{{tree}}", capture=True).stdout.strip() == tree
                if same:
                    score["snapshots"][commit] = {**score["snapshots"][previous], "at": item["at"]}
                else:
                    patch, touched = run_patch(run_dir, meta, task, commit)
                    score["snapshots"][commit] = {**grade(task, patch, run_dir / "grade" / commit[:12], SNAPSHOT_TIMEOUT_SECONDS), "at": item["at"], "test_files_changed": touched}
                previous = commit
                score_path.write_text(json.dumps(score, indent=1))
        final = score["final"]
        print(f"{meta['run']} {final['passed']}/{final['tests']} share={final['share']} test_files_changed={len(final['test_files_changed'])} "
              f"applied={final['patch_applied']} snapshots_graded={len(score['snapshots'])}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for name, handler in (("prepare", cmd_prepare), ("check", cmd_check)):
        sub = commands.add_parser(name)
        sub.add_argument("libs", nargs="+")
        sub.set_defaults(run=handler)
    run = commands.add_parser("run")
    run.add_argument("lib")
    run.add_argument("arm")
    run.add_argument("rep", type=int)
    run.add_argument("model")
    run.add_argument("--window", type=int, default=DEFAULT_WINDOW)
    run.add_argument("--wall-hours", type=float, default=5)
    run.add_argument("--nudges", type=int, default=0)
    run.add_argument("--thinking", default=cc.THINKING)
    run.add_argument("--label")
    run.set_defaults(run=cmd_run)
    score = commands.add_parser("score")
    score.add_argument("model_tag")
    score.add_argument("runs", nargs="*")
    score.add_argument("--snapshots", action="store_true")
    score.set_defaults(run=cmd_score)
    regrade = commands.add_parser("regrade")
    regrade.add_argument("model_tag")
    regrade.add_argument("runs", nargs="+")
    regrade.add_argument("--why", required=True)
    regrade.set_defaults(run=cmd_regrade)
    recover = commands.add_parser("recover-stop")
    recover.add_argument("model_tag")
    recover.add_argument("run_name")
    recover.add_argument("--why", required=True)
    recover.set_defaults(run=cmd_recover_stop)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
