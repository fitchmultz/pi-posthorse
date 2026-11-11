"""One Pi invocation that stays open (`pi --mode rpc`), for a setup whose agent ends a turn to wait for work it started.

Print mode exits when the agent's turn ends. A setup with background jobs and child agents ends a
turn on purpose and is woken by the completion notice, so in print mode that exit kills the work
the turn was waiting for. Here the process stays up, as a terminal session does, and the
invocation ends when nothing can wake the session without new input: the session has settled and,
for QUIET_SECONDS, none of its background jobs and none of its child agents is unfinished.

Nobody is at the keyboard: a dialog an extension opens is answered as dismissed.
"""
import json
import os
import signal
import subprocess
import threading
import time

from cc import now

QUIET_SECONDS = 5  # a finished job or child reaches the session within about a second; this is the margin
SHUTDOWN_SECONDS = 60
DIALOGS = {"select", "confirm", "input", "editor"}
UNFINISHED_JOB = {"starting", "running"}


def alive(pattern):
    return subprocess.run(["pgrep", "-f", pattern], capture_output=True).returncode == 0


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def unfinished_work(run_dir):
    """Work that messages the session when it ends: its `background_command` jobs and its child agents.

    Both keep their state in files. A job is unfinished while its state says so and its worker process
    lives (the job directory is the worker's last argument). A child run is unfinished while it has no
    result and the process of its conversation lives (the conversation's first run id is an argument of
    the runner; a continued conversation gets a new run directory but keeps that id).
    """
    waiting = []
    for job in (run_dir / "session").glob("background-commands/*/*"):
        state = read_json(job / "state.json") or {"status": "starting"}
        if state.get("status") in UNFINISHED_JOB and alive(f"{job}$"):
            waiting.append(f"job {job.name[:8]}")
    for launch_path in (run_dir / "agent" / "sessions" / "agent-runs").glob("*/*/launch.json"):
        if (launch_path.parent / "result.json").exists():
            continue
        launch = read_json(launch_path)
        if launch and alive(f" {launch['rootId']} "):
            waiting.append(f"child {launch_path.parent.name[:8]}")
    return waiting


def invocation(command, message, deadline, run_dir, out, err):
    """Send one message, keep Pi open until the session can no longer wake by itself, then close it.

    `out` receives a short line per session event (not the token stream; the journal has the content).
    Returns the fields of a stop record: exit (1 when the last reply ended in a provider error, as print
    mode exits), timed_out, turns_ended (times the agent ended a turn), waited_seconds (idle time spent
    waiting for background work), dialogs_dismissed.
    """
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, start_new_session=True)
    writing = threading.Lock()
    seen = {"active": False, "settled": 0, "stop_reason": None, "refused": None, "dialogs": 0}

    def send(record):
        with writing:
            try:
                process.stdin.write(json.dumps(record).encode() + b"\n")
                process.stdin.flush()
            except (OSError, ValueError):
                pass  # Pi has gone; the main loop sees the exit

    def note(record):
        out.write(json.dumps({"at": now(), **record}) + "\n")
        out.flush()

    def read():
        for line in process.stdout:  # bytes: split on LF only, as the protocol requires
            try:
                event = json.loads(line)
            except ValueError:
                continue
            kind = event.get("type")
            if kind == "agent_start":
                seen["active"] = True
                note({"type": kind})
            elif kind == "agent_settled":
                seen["active"] = False
                seen["settled"] += 1
                note({"type": kind, "aborted": event.get("aborted")})
            elif kind == "message_end" and event.get("message", {}).get("role") == "assistant":
                seen["stop_reason"] = event["message"].get("stopReason")
            elif kind == "response":
                note(event)
                if event.get("command") == "prompt" and (not event.get("success") or event.get("data", {}).get("disposition") == "handled"):
                    seen["refused"] = event
            elif kind == "extension_ui_request" and event.get("method") in DIALOGS:
                seen["dialogs"] += 1
                note(event)
                send({"type": "extension_ui_response", "id": event["id"], "cancelled": True})
            elif kind in ("extension_error", "auto_retry_start", "auto_retry_end"):
                note(event)

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    send({"id": "message", "type": "prompt", "message": message})
    timed_out = False
    quiet_since = None
    waited = 0.0
    waiting_on = []
    while process.poll() is None:
        if time.time() >= deadline:
            timed_out = True
            break
        if seen["refused"]:
            break
        idle = seen["settled"] > 0 and not seen["active"]
        work = unfinished_work(run_dir) if idle else []
        if idle and work != waiting_on:
            note({"type": "harness_waits", "for": work})
        waiting_on = work if idle else []
        if idle and not work:
            quiet_since = quiet_since or time.time()
            if time.time() - quiet_since >= QUIET_SECONDS:
                break
        else:
            quiet_since = None
            waited += 1 if idle else 0
        time.sleep(1)
    if timed_out:
        os.killpg(process.pid, signal.SIGKILL)
    else:
        with writing:
            try:
                process.stdin.close()  # asks Pi for an orderly shutdown
            except OSError:
                pass
        try:
            process.wait(timeout=SHUTDOWN_SECONDS)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
    code = process.wait()
    reader.join(timeout=10)
    failed = bool(seen["refused"]) or seen["stop_reason"] in ("error", "aborted") or seen["settled"] == 0
    return {
        "exit": code if timed_out else (1 if failed else 0), "timed_out": timed_out, "pi_exit": code,
        "turns_ended": seen["settled"], "waited_seconds": round(waited), "dialogs_dismissed": seen["dialogs"],
    }
