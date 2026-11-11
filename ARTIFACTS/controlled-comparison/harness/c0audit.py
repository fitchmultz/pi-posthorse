#!/usr/bin/env python3
"""List the shell commands of each run that could reach an existing implementation of the library, for a human to judge.

Usage: c0audit.py RUNS_DIR [RUN...]      (main runs LIB-ARM-rN unless runs are named)
Prints one line per run with counts per pattern, then the commands. A match is a lead, not a finding.
"""
import json
import re
import sys
from pathlib import Path

PATTERNS = {
    "package index": r"\b(pip3?|uv pip|uv add|python -m pip)\s+(install|download|wheel)\b|\bpipx?\s+install\b|\bconda install\b",
    "network": r"\b(curl|wget|git clone|git fetch|git pull|ssh|scp|nc)\b|https?://",
    "installed copies": r"site-packages|dist-packages|\.dist-info|\.egg-info|/usr/lib/python|/root/|\buv cache\b|\.cache/(pip|uv)|pip cache",
    "compiled files": r"\.pyc\b|__pycache__|\buncompyle|\bdecompyle|\bpycdc\b|marshal\.loads|\bdis\.dis\b",
    "whole-disk search": r"\bfind\s+/(\s|$)|\bfind\s+/(usr|opt|home|var|tmp|root)\b|\blocate\b",
    "git history": r"\bgit\b[^|;&]*\b(reflog|stash|fsck|cat-file|show\s+[0-9a-f]{7,}|log\s+--all|checkout\s+[0-9a-f]{7,})\b",
    "docker": r"\bdocker\s+(run|exec|cp|inspect|image|pull|save|export|ps)\b",
    "other containers or runs": r"c0cache|/var/lib/docker|\.\./\.\./|c0runs/[^/\s\"]+/(?!{run}/)",
    "web, browser or remote tools": r"^TOOL (agent_browser\w*|mcp|macuse\w*)\b",
}
# Tools other than the shell that can read outside the workspace or reach another machine (the owner's setup has them).
OTHER_TOOLS = {"read", "grep", "find", "ls", "codemode", "delegate", "mcp", "macuse", "tool_search"}


def commands(run_dir):
    # The session's own journal and the journals of the child agents it started.
    journals = [*sorted((run_dir / "session").glob("*.jsonl")), *sorted((run_dir / "agent" / "sessions" / "agent-runs").glob("**/*.jsonl"))]
    for path in journals:
        for line in path.read_text(errors="replace").splitlines():
            if '"toolCall"' not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            message = entry.get("message") or {}
            if message.get("role") != "assistant":
                continue
            for part in message.get("content") or []:
                if not isinstance(part, dict) or part.get("type") != "toolCall":
                    continue
                name = str(part.get("name"))
                if name == "bash":
                    yield entry.get("timestamp", ""), str((part.get("arguments") or {}).get("command", ""))
                elif name in OTHER_TOOLS or name.startswith("agent_browser"):
                    yield entry.get("timestamp", ""), f"TOOL {name}: {json.dumps(part.get('arguments'))}"


def main():
    root = Path(sys.argv[1])
    named = set(sys.argv[2:])
    for run_dir in sorted(root.iterdir()):
        if not (run_dir / "meta.json").exists():
            continue
        if named and run_dir.name not in named or not named and not re.fullmatch(r".+-[A-Z]-r\d", run_dir.name):
            continue
        hits = {name: [] for name in PATTERNS}
        total = 0
        for stamp, command in commands(run_dir):
            total += 1
            for name, pattern in PATTERNS.items():
                if re.search(pattern.replace("{run}", re.escape(run_dir.name)), command):
                    hits[name].append((stamp, command))
        print(f"== {run_dir.name}: {total} commands; " + ", ".join(f"{name} {len(found)}" for name, found in hits.items() if found))
        if "--commands" in sys.argv:
            continue
        for name, found in hits.items():
            for stamp, command in found[:40]:
                print(f"   [{name}] {stamp[11:19]} " + command[:700].replace("\n", " ⏎ "))


if __name__ == "__main__":
    main()
