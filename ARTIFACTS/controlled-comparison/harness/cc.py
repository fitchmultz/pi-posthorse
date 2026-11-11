#!/usr/bin/env python3
"""Controlled comparison harness: one Pi session works through a queue of SWE-bench Verified issues.

Usage:
  cc.py fetch QUEUE...                       pull the issue images and cache each image's checkout
  cc.py drop QUEUE...                        remove the images and cached checkouts of these queues
  cc.py check QUEUE                          prove the test route with the reference patches (no model call)
  cc.py run QUEUE ARM REP MODEL [options]    ARM is A (stock Pi) or B (Pi with Posthorse); MODEL is provider/id
      --issues K            use only the first K issues of the queue (default: all)
      --window N            context window in tokens for both arms (default: 64000)
      --without-test-rule   leave the test-file rule out of the prompt (calibration run)
      --label TEXT          suffix for the run directory name
      --keep                keep the repository checkouts after the run
  cc.py predictions MODEL_TAG                write predictions/MODEL_TAG/<run>.jsonl from the saved patches

Layout (ROOT is the directory above this script's directory):
  ROOT/queues.json              from select_queues.py
  ROOT/pi-official/             npm install of the official Pi package
  ROOT/agents/A, ROOT/agents/B  Pi config directories from setup_arms.sh
  ROOT/cache/INSTANCE/          checkout copied out of the issue's image, and its baseline commit
  ROOT/runs/MODEL_TAG/RUN/      one directory per run
"""
import argparse
import json
import os
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATASET = "SWE-bench/SWE-bench_Verified"
PI_PACKAGE = ROOT / "pi-official" / "node_modules" / "@earendil-works" / "pi-coding-agent"
HOST_AUTH = Path.home() / ".pi" / "agent" / "auth.json"
UID, GID = os.getuid(), os.getgid()
CONTAINER_HOME = "/tmp/cchome"
START_MARK, END_MARK = ">>>>> Start Test Output", ">>>>> End Test Output"

# The only names the sandbox can resolve.
PROVIDER_HOSTS = {"openai-codex": ["chatgpt.com"], "cloudflare-ai-gateway": ["gateway.ai.cloudflare.com"]}
# Every harness container gets this much memory and no swap. A test of a half-built library can loop and
# allocate without end; the kernel then ends that process inside its own container only.
CONTAINER_MEMORY = "8g"
MEMORY_FLAGS = ["--memory", CONTAINER_MEMORY, "--memory-swap", CONTAINER_MEMORY]

THINKING = "medium"  # Pi's default startup thinking level
DEFAULT_WINDOW = 64_000
NUDGE = "Continue with the queue."
STALL_LIMIT = 3  # stop after this many Pi exits in a row that saved no new patch
RUN_WALL_SECONDS = 5 * 3600  # runaway guard for an unattended run; a run that hits it is reported
MIN_LOGIN_SECONDS = RUN_WALL_SECONDS + 3600  # the copied access token must outlive the run

PROMPT = """You are working through a queue of {count} GitHub issues in {repo}. Fix them in order, one at a time. I am away until the whole queue is done, so do not stop to ask questions or to report progress. Finish all {count}.

The current directory holds:
- issues/N.md: the text of issue N (N is 1 to {count}).
- repos/N/: {repo} checked out at the commit where issue N was reported. Fix issue N there, in the library source.
- bin/envrun N COMMAND: runs COMMAND in the prepared Python environment for issue N, with repos/N as its working directory. Use it for anything that needs the project's dependencies, such as running tests. Python on this machine does not have them.
- bin/save N: saves your change to repos/N as patches/N.diff.

Rules for the whole queue:
{rules}
"""

RULES = [
    "Run `bin/save N` before you start issue N+1, whether or not you fixed issue N.",
    "Do not create, change or delete any test file or anything under a tests directory in the repositories. Put scratch files in scratch/ instead.",
    "After saving issue N, append one line to LOG.md in this exact form: `N | fixed | one sentence` or `N | not fixed | one sentence`.",
]
TEST_RULE = 1  # index in RULES

ENVRUN = """#!/bin/bash
# Usage: bin/envrun N COMMAND
# Runs COMMAND in the prepared Python environment for issue N, with repos/N as the working directory.
# For shell syntax, pass COMMAND as one quoted string: bin/envrun 2 "cd tests && pytest -x test_a.py"
set -euo pipefail
if [ $# -lt 2 ]; then
  sed -n 2,4p "$0" >&2
  exit 2
fi
n="$1"
shift
case "$n" in
{cases}
  *)
    echo "envrun: N must be 1 to {count}" >&2
    exit 2
    ;;
esac
if [ $# -eq 1 ]; then command="$1"; else command="$(printf '%q ' "$@")"; fi
exec docker exec -i --user {uid}:{gid} --env HOME={home} --workdir /testbed "{prefix}-$n" \\
  bash -c 'exports="$1"; command="$2"; set --; source /opt/miniconda3/bin/activate && conda activate testbed && eval "$exports" && eval "$command"' envrun "$exports" "$command"
"""

SAVE = """#!/bin/bash
# Usage: bin/save N
# Saves the change in repos/N as patches/N.diff.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
case "${{1:-}}" in
{cases}
  *)
    echo "usage: bin/save N (N is 1 to {count})" >&2
    exit 2
    ;;
esac
mkdir -p "$here/patches" "$here/.harness"
git -C "$here/repos/$1" add -A
git -C "$here/repos/$1" diff --cached "$baseline" > "$here/patches/$1.diff"
printf '%s\\t%s\\t%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$(wc -c < "$here/patches/$1.diff")" >> "$here/.harness/saves.tsv"
echo "Saved patches/$1.diff ($(wc -l < "$here/patches/$1.diff") lines)."
"""


def sh(*args, capture=False, check=True, cwd=None, stdin=None):
    return subprocess.run(
        [str(a) for a in args], check=check, cwd=cwd, input=stdin, text=True,
        stdout=subprocess.PIPE if capture else None, stderr=subprocess.STDOUT if capture else None,
    )


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def dataset_rows():
    from datasets import load_dataset

    return {row["instance_id"]: row for row in load_dataset(DATASET, split="test")}


def load_queue(name, limit=None):
    queues = json.loads((ROOT / "queues.json").read_text())["queues"]
    queue = next((q for q in queues if q["queue"] == name), None)
    if queue is None:
        sys.exit(f"Unknown queue {name}. Known: {' '.join(q['queue'] for q in queues)}")
    ids = [issue["instance_id"] for issue in queue["issues"]]
    return queue, ids[:limit] if limit else ids


def script_parts(eval_script):
    """Split the official eval script into root setup lines, exports and the test command."""
    lines = eval_script.splitlines()
    start = next(i for i, line in enumerate(lines) if START_MARK in line)
    end = next(i for i, line in enumerate(lines) if END_MARK in line)
    patch_at = next((i for i, line in enumerate(lines) if line.startswith("git apply")), start)
    head = lines[:patch_at]
    return {
        "root": [line for line in head if "locale-gen" in line],
        "exports": [line for line in head if line.startswith("export ")],
        "test": lines[start + 1 : end],
    }


def git(repo, *args, capture=False):
    return sh("git", "-C", repo, *args, capture=capture)


def cache_dir(instance_id):
    return ROOT / "cache" / instance_id


def ensure_cache(row):
    """Pull the issue's image and copy its /testbed out once. Returns the baseline commit."""
    cache = cache_dir(row["instance_id"])
    marker = cache / "baseline"
    if marker.exists():
        return marker.read_text().strip()
    if cache.exists():
        shutil.rmtree(cache)
    cache.mkdir(parents=True)
    image = row["image"]
    sh("docker", "pull", "-q", image, capture=True)
    created = sh("docker", "create", image, capture=True).stdout.strip().splitlines()[-1]
    try:
        sh("docker", "cp", "-q", f"{created}:/testbed", cache / "testbed")
    finally:
        sh("docker", "rm", "-f", created, capture=True)
    repo = cache / "testbed"
    if git(repo, "status", "--porcelain", capture=True).stdout.strip():
        git(repo, "add", "-A")
        git(repo, "-c", "user.name=cc", "-c", "user.email=cc@localhost", "commit", "-q", "-m", "cc baseline")
    baseline = git(repo, "rev-parse", "HEAD", capture=True).stdout.strip()
    marker.write_text(baseline + "\n")
    return baseline


def start_issue(prefix, n, row, repo_dir):
    """Copy the cached checkout to repo_dir, then run the issue's image with repo_dir mounted at /testbed."""
    baseline = ensure_cache(row)
    sh("cp", "-a", "--reflink=auto", cache_dir(row["instance_id"]) / "testbed", repo_dir)
    name = f"{prefix}-{n}"
    sh("docker", "run", "-d", "--name", name, "--network", "none", "-v", f"{repo_dir}:/testbed", "-w", "/testbed", row["image"], "sleep", "infinity", capture=True)
    parts = script_parts(row["eval_script"])
    setup = [
        f"echo 'cc:x:{UID}:{GID}::{CONTAINER_HOME}:/bin/bash' >> /etc/passwd",
        f"mkdir -p {CONTAINER_HOME} && chown {UID}:{GID} {CONTAINER_HOME}",
        "git config --system --add safe.directory '*'",
        *parts["root"],
    ]
    sh("docker", "exec", name, "bash", "-c", " && ".join(setup), capture=True)
    return {"n": n, "instance_id": row["instance_id"], "image": row["image"], "container": name, "baseline": baseline,
            "exports": parts["exports"], "test": parts["test"]}


def build_workspace(ws, prefix, ids, rows):
    for sub in ("issues", "repos", "bin", "scratch"):
        (ws / sub).mkdir(parents=True)
    issues = []
    for n, iid in enumerate(ids, start=1):
        (ws / "issues" / f"{n}.md").write_text(rows[iid]["problem_statement"].rstrip() + "\n")
        issues.append(start_issue(prefix, n, rows[iid], ws / "repos" / str(n)))
    envrun_cases = "\n".join(
        f"  {i['n']}) exports={shlex.quote('; '.join(i['exports']) or ':')} ;;" for i in issues
    )
    save_cases = "\n".join(f"  {i['n']}) baseline={i['baseline']} ;;" for i in issues)
    (ws / "bin" / "envrun").write_text(
        ENVRUN.format(cases=envrun_cases, count=len(issues), uid=UID, gid=GID, home=CONTAINER_HOME, prefix=prefix)
    )
    (ws / "bin" / "save").write_text(SAVE.format(cases=save_cases, count=len(issues)))
    for name in ("envrun", "save"):
        (ws / "bin" / name).chmod(0o755)
    return issues


def teardown(ws, issues, out_dir, keep):
    """Record the final state of each checkout, then remove the containers and checkouts."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for issue in issues:
        repo = ws / "repos" / str(issue["n"])
        sh("docker", "rm", "-f", issue["container"], capture=True, check=False)
        if repo.exists():
            git(repo, "add", "-A")
            diff = git(repo, "diff", "--cached", issue["baseline"], capture=True).stdout
            (out_dir / f"{issue['n']}.diff").write_text(diff)
            if not keep:
                shutil.rmtree(repo)


def cmd_fetch(args):
    rows = dataset_rows()
    for name in args.queues:
        _, ids = load_queue(name)
        for iid in ids:
            started = time.time()
            ensure_cache(rows[iid])
            print(f"{name} {iid} ready in {time.time() - started:.0f}s", flush=True)


def cmd_drop(args):
    rows = dataset_rows()
    for name in args.queues:
        _, ids = load_queue(name)
        for iid in ids:
            sh("docker", "rmi", rows[iid]["image"], capture=True, check=False)
            shutil.rmtree(cache_dir(iid), ignore_errors=True)
        print(f"{name} dropped", flush=True)


def cmd_check(args):
    """Apply the reference patch and tests, run the official test command through bin/envrun, grade officially."""
    from swebench.harness.grading import get_eval_report
    from swebench.harness.utils import make_test_spec

    rows = dataset_rows()
    _, ids = load_queue(args.queue)
    run_dir = ROOT / "runs" / "_check" / args.queue
    if run_dir.exists():
        shutil.rmtree(run_dir)
    ws = run_dir / "ws"
    issues = build_workspace(ws, f"cc-check-{args.queue}", ids, rows)
    failed = 0
    try:
        for issue in issues:
            row = rows[issue["instance_id"]]
            repo = ws / "repos" / str(issue["n"])
            for patch in (row["test_patch"], row["patch"]):
                sh("git", "-C", repo, "apply", "-", stdin=patch)
            started = time.time()
            result = sh(ws / "bin" / "envrun", issue["n"], "\n".join(issue["test"]), capture=True, check=False)
            log = run_dir / f"test-{issue['n']}.log"
            log.write_text(f"{START_MARK}\n{result.stdout}\n{END_MARK}\n")
            report = get_eval_report(
                make_test_spec(row),
                {"instance_id": row["instance_id"], "model_name_or_path": "check", "model_patch": row["patch"]},
                str(log), True,
            )[row["instance_id"]]
            status = report.get("tests_status", {})
            counts = " ".join(
                f"{kind}:{len(status.get(kind, {}).get('success', []))}/{len(status.get(kind, {}).get('success', [])) + len(status.get(kind, {}).get('failure', []))}"
                for kind in ("FAIL_TO_PASS", "PASS_TO_PASS")
            )
            failed += not report["resolved"]
            print(f"{args.queue} {issue['n']} {row['instance_id']} resolved={report['resolved']} {counts} exit={result.returncode} {time.time() - started:.0f}s", flush=True)
    finally:
        teardown(ws, issues, run_dir / "final", keep=False)
    sys.exit(1 if failed else 0)


def node_paths():
    node = Path(sh("node", "-p", "process.execPath", capture=True).stdout.strip())
    return node, node.parent.parent


def write_run_auth(agent_dir, provider, min_seconds=MIN_LOGIN_SECONDS):
    """Copy only the provider's access token. The refresh token stays on the host, so a run cannot rotate the login."""
    credential = dict(json.loads(HOST_AUTH.read_text())[provider])
    if credential.get("type") == "oauth":
        remaining = credential["expires"] / 1000 - time.time()
        if remaining < min_seconds:
            sys.exit(f"The {provider} login on this machine expires in {remaining / 3600:.1f} h. Refresh it with the host's Pi before starting a run.")
        credential["refresh"] = "not-copied"
    elif str(credential.get("key", "")).startswith("!"):
        # Pi runs a key that starts with "!" as a shell command. That command reads the host's home, which the
        # sandbox hides, so the harness runs it here and hands the run the value. c0.py deletes the file after the run.
        result = subprocess.run(["bash", "-c", credential["key"][1:]], capture_output=True, text=True, timeout=30)
        if result.returncode != 0 or not result.stdout.strip():
            sys.exit(f"The key command of the {provider} login failed on this machine.")
        credential["key"] = result.stdout.strip()
    path = agent_dir / "auth.json"
    path.write_text(json.dumps({provider: credential}))
    path.chmod(0o600)


def network_files(run_dir, provider):
    """Name lookup files that resolve only the model provider's hosts. They live outside the run directory."""
    out = ROOT / "net" / run_dir.parent.name / run_dir.name
    out.mkdir(parents=True, exist_ok=True)
    lines = ["127.0.0.1 localhost"]
    for host in PROVIDER_HOSTS[provider]:
        addresses = sorted({info[4][0] for info in socket.getaddrinfo(host, 443, socket.AF_INET, socket.SOCK_STREAM)})
        lines += [f"{address} {host}" for address in addresses]
    (out / "hosts").write_text("\n".join(lines) + "\n")
    nsswitch = Path("/etc/nsswitch.conf").read_text().splitlines()
    (out / "nsswitch.conf").write_text("\n".join("hosts: files" if line.startswith("hosts:") else line for line in nsswitch) + "\n")
    (out / "resolv.conf").write_text("")
    return out


def sandbox(run_dir, node, node_prefix, pi_args, provider, pi_build=None):
    """Pi inside bubblewrap: home hidden, file system read-only except the run directory, names resolve only for the provider.

    pi_build names another Pi build to run: {"cli": path of its cli.js, "root": directory to make visible}.
    With "agent_dir_at_home" the run's agent directory also appears at ~/.pi/agent, where a person's own
    instructions and skills expect it (the owner's instructions name files there by that path).
    """
    cli = PI_PACKAGE / "dist" / "cli.js" if pi_build is None else Path(pi_build["cli"])
    pi_root = ROOT / "pi-official" if pi_build is None else Path(pi_build["root"])
    home = str(Path.home())
    net = network_files(run_dir, provider)
    at_home = bool((pi_build or {}).get("agent_dir_at_home"))
    agent_dir = str(Path(home) / ".pi" / "agent") if at_home else str(run_dir / "agent")
    env = {
        "PATH": f"{node.parent}:/usr/local/bin:/usr/bin:/bin",
        "HOME": home,
        "LANG": "C.UTF-8",
        "TERM": "dumb",
        "PI_CODING_AGENT_DIR": agent_dir,
        "PI_SKIP_VERSION_CHECK": "1",
        "PI_OFFLINE": "1",
    }
    command = [
        "bwrap", "--die-with-parent", "--unshare-pid",
        "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--tmpfs", home,
        "--ro-bind", str(node_prefix), str(node_prefix),
        "--ro-bind", str(pi_root), str(pi_root),
        "--bind", str(run_dir), str(run_dir),
        *(["--bind", str(run_dir / "agent"), agent_dir] if at_home else []),
        "--ro-bind", str(net / "hosts"), "/etc/hosts",
        "--ro-bind", str(net / "nsswitch.conf"), "/etc/nsswitch.conf",
        "--ro-bind", str(net / "resolv.conf"), str(Path("/etc/resolv.conf").resolve()),
        "--chdir", str(run_dir / "ws"), "--clearenv",
    ]
    for packages in sorted(Path("/usr/lib").glob("python3*/site-packages")):
        command += ["--tmpfs", str(packages)]
    for key, value in env.items():
        command += ["--setenv", key, value]
    return command + [str(node), str(cli), *pi_args]


def saved_count(ws, total):
    return sum((ws / "patches" / f"{n}.diff").exists() for n in range(1, total + 1))


def cmd_run(args):
    queue, ids = load_queue(args.queue, args.issues)
    provider, _, model_id = args.model.partition("/")
    run_name = f"{args.queue}-{args.arm}-r{args.rep}" + (f"-{args.label}" if args.label else "")
    run_dir = ROOT / "runs" / model_id / run_name
    if run_dir.exists():
        sys.exit(f"{run_dir} exists. Remove it to rerun.")
    arm_dir = ROOT / "agents" / args.arm
    if not arm_dir.is_dir():
        sys.exit(f"{arm_dir} is missing. Run setup_arms.sh first.")
    node, node_prefix = node_paths()
    rows = dataset_rows()

    ws = run_dir / "ws"
    run_dir.mkdir(parents=True)
    shutil.copytree(arm_dir, run_dir / "agent", symlinks=True)
    write_run_auth(run_dir / "agent", provider)
    (run_dir / "agent" / "models.json").write_text(
        json.dumps({"providers": {provider: {"modelOverrides": {model_id: {"contextWindow": args.window}}}}})
    )
    (run_dir / "session").mkdir()
    prefix = f"cc-{model_id.replace('.', '-')}-{run_name}"
    issues = build_workspace(ws, prefix, ids, rows)
    rules = [rule for index, rule in enumerate(RULES) if not (args.without_test_rule and index == TEST_RULE)]
    prompt = PROMPT.format(
        count=len(ids), repo=queue["repo"], rules="\n".join(f"{i}. {rule}" for i, rule in enumerate(rules, start=1))
    )
    (run_dir / "PROMPT.md").write_text(prompt)
    posthorse = arm_dir / "npm" / "node_modules" / "pi-posthorse" / "package.json"
    meta = {
        "run": run_name, "queue": args.queue, "arm": args.arm, "rep": args.rep, "model": args.model, "thinking": THINKING,
        "test_rule": not args.without_test_rule,
        "window": args.window, "repo": queue["repo"], "issues": issues,
        "pi_version": json.loads((PI_PACKAGE / "package.json").read_text())["version"],
        "posthorse_version": json.loads(posthorse.read_text())["version"] if posthorse.exists() else None,
        "arm_settings": json.loads((arm_dir / "settings.json").read_text()),
        "started": now(), "invocations": [],
    }
    base = ["-p", "--model", args.model, "--thinking", THINKING, "--session-dir", str(run_dir / "session"), "--no-context-files"]
    deadline = time.time() + RUN_WALL_SECONDS
    stalls, saved, outcome = 0, 0, None
    try:
        while outcome is None:
            index = len(meta["invocations"])
            pi_args = base + (["--", prompt] if index == 0 else ["--continue", "--", NUDGE])
            record = {"index": index, "started": now(), "timed_out": False}
            with open(run_dir / f"stdout-{index}.txt", "w") as out, open(run_dir / f"stderr-{index}.txt", "w") as err:
                process = subprocess.Popen(
                    sandbox(run_dir, node, node_prefix, pi_args, provider), stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                    start_new_session=True,
                )
                try:
                    record["exit"] = process.wait(timeout=max(1, deadline - time.time()))
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    record["exit"] = process.wait()
                    record["timed_out"] = True
            after = saved_count(ws, len(ids))
            record.update(ended=now(), saved_after=after)
            meta["invocations"].append(record)
            stalls = 0 if after > saved else stalls + 1
            saved = after
            if saved == len(ids):
                outcome = "complete"
            elif record["timed_out"]:
                outcome = "wall-time"
            elif stalls >= STALL_LIMIT:
                outcome = "stalled"
            (run_dir / "meta.json").write_text(json.dumps(meta, indent=1))
    finally:
        teardown(ws, issues, run_dir / "final", args.keep)
        meta.update(ended=now(), outcome=outcome or "harness-error", saved=saved)
        (run_dir / "meta.json").write_text(json.dumps(meta, indent=1))
    print(f"{run_name} {meta['outcome']} saved={saved}/{len(ids)} invocations={len(meta['invocations'])}", flush=True)


def cmd_predictions(args):
    out_dir = ROOT / "predictions" / args.model_tag
    out_dir.mkdir(parents=True, exist_ok=True)
    by_file = {}
    for meta_path in sorted((ROOT / "runs" / args.model_tag).glob("*/meta.json")):
        meta = json.loads(meta_path.read_text())
        name = meta["run"]
        for issue in meta["issues"]:
            patch = meta_path.parent / "ws" / "patches" / f"{issue['n']}.diff"
            by_file.setdefault(name, []).append({
                "instance_id": issue["instance_id"],
                "model_name_or_path": f"{args.model_tag}-{name}",
                "model_patch": patch.read_text() if patch.exists() else "",
            })
    for name, predictions in by_file.items():
        path = out_dir / f"{name}.jsonl"
        path.write_text("".join(json.dumps(p) + "\n" for p in predictions))
        print(path, len(predictions), "predictions,", sum(1 for p in predictions if p["model_patch"]), "with a patch")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for name, handler in (("fetch", cmd_fetch), ("drop", cmd_drop)):
        sub = commands.add_parser(name)
        sub.add_argument("queues", nargs="+")
        sub.set_defaults(run=handler)
    check = commands.add_parser("check")
    check.add_argument("queue")
    check.set_defaults(run=cmd_check)
    run = commands.add_parser("run")
    run.add_argument("queue")
    run.add_argument("arm", choices=["A", "B"])
    run.add_argument("rep", type=int)
    run.add_argument("model")
    run.add_argument("--issues", type=int)
    run.add_argument("--window", type=int, default=DEFAULT_WINDOW)
    run.add_argument("--without-test-rule", action="store_true")
    run.add_argument("--label")
    run.add_argument("--keep", action="store_true")
    run.set_defaults(run=cmd_run)
    predictions = commands.add_parser("predictions")
    predictions.add_argument("model_tag")
    predictions.set_defaults(run=cmd_predictions)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
