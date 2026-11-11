#!/usr/bin/env python3
"""Mark one ended run as not counting and move it aside, so that the run can be repeated under its name.

Usage: c0void.py MODEL_TAG RUN SUFFIX --why TEXT     (from the directory that holds c0runs/)
Renames c0runs/MODEL_TAG/RUN to RUN-SUFFIX and records {"why", "directory_renamed_from", "at"} as meta.void.
The tables leave void runs out and list them with the reason. Nothing is deleted.
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def main():
    tag, run, suffix = sys.argv[1:4]
    why = sys.argv[sys.argv.index("--why") + 1]
    source = Path("c0runs") / tag / run
    target = source.with_name(f"{run}-{suffix}")
    meta = json.loads((source / "meta.json").read_text())
    if "ended" not in meta:
        sys.exit(f"{run} has not ended")
    if target.exists():
        sys.exit(f"{target} exists")
    meta["void"] = {"why": why, "directory_renamed_from": run, "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ")}
    (source / "meta.json").write_text(json.dumps(meta, indent=1))
    source.rename(target)
    print(f"{run} -> {target.name}")


if __name__ == "__main__":
    main()
