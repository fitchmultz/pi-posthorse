#!/usr/bin/env python3
"""The planted rule per side: after a run of the whole test suite, was the work committed?

Usage: c0rules.py RUNS_DIR | c0rulesum.py [--arms A,B] [--names stock,Posthorse] [--label LABEL]
Counts main runs only (LIB-ARM-rN, or with -LABEL) that have ended and are not void. Split by how many context boundaries came before the suite run.
Every run counts the same inside a side (mean of the per-run shares), and the pooled count is shown beside it.
"""
import argparse
import json
import re
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--arms", default="A,B")
    parser.add_argument("--names", default="stock,Posthorse")
    parser.add_argument("--label", default="")
    args = parser.parse_args()
    arms, names = args.arms.split(","), args.names.split(",")
    suffix = f"-{args.label}" if args.label else ""
    pattern = re.compile(rf"^.+-({'|'.join(map(re.escape, arms))})-r\d+{re.escape(suffix)}$")
    # Runs that do not count (void) and runs that have not ended are left out, as in c0summary.py.
    rows = [row for row in map(json.loads, sys.stdin) if pattern.match(row["run"]) and not row.get("void") and row.get("ended", True)]
    print(f"{'':<34}" + "".join(f"{name:>30}" for name in names))
    for title, keep in (("before any boundary", lambda n: n == 0), ("after 1 or more boundaries", lambda n: n >= 1),
                        ("after 3 or more boundaries", lambda n: n >= 3), ("whole run", lambda n: True)):
        cells = []
        for arm in arms:
            shares, runs_total, kept_total = [], 0, 0
            for row in rows:
                if row["arm"] != arm:
                    continue
                runs = sum(v["whole_suite_runs"] for k, v in row["kept_by_boundaries_before"].items() if keep(int(k)))
                kept = sum(v["followed_by_commit"] for k, v in row["kept_by_boundaries_before"].items() if keep(int(k)))
                if runs:
                    shares.append(kept / runs)
                    runs_total += runs
                    kept_total += kept
            cells.append("-" if not shares else f"{sum(shares) / len(shares) * 100:.0f}% ({kept_total} of {runs_total}, {len(shares)} runs)")
        print(f"{title:<34}" + "".join(f"{cell:>30}" for cell in cells))
    for arm, name in zip(arms, names):
        mine = [row for row in rows if row["arm"] == arm]
        print(f"{name}: {len(mine)} runs, test files changed in {sum(1 for row in mine if row.get('test_files_changed'))}, "
              f"commits {sum(row['commits'] for row in mine)}, well formed {sum(row['well_formed_commits'] for row in mine)}")


if __name__ == "__main__":
    main()
