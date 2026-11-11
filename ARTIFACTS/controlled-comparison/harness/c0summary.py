#!/usr/bin/env python3
"""Side-by-side summary of the long-task comparison.

Usage: c0table.py RUNS_DIR 2>/dev/null | c0summary.py [--json] [--arms A,B] [--names stock,Posthorse] [--once]
Reads the per-run rows of c0table.py on stdin. Uses only runs named LIB-ARM-rN (no label) that have ended.
Default sides: A = official Pi with its own compaction, B = the same Pi with Posthorse. Differences are second minus first.

Definitions
- finished: a stop where the suite had no failing test (see c0table.stop_kind).
- own stop: a stop that is not a provider error. The first own stop is where the agent first ended its turn.
- quit: an own stop with failing tests left, before the time limit.
- share: tests passing / tests the reference implementation passes; 1.0 when finished.
- Minutes, tokens and cost of a run count until it finished, or until it ended when it did not finish.
  Tokens and cost include the child agents a run started; replies and context boundaries are the session's own,
  those of child agents have their own lines.
- Every library counts the same: values are averaged over the repetitions of a library, then over libraries.
- --once: where a run has a grade with every test run once (c0once.py; networkx, whose Commit0 command runs
  every test twice in one process and keeps the second result), that grade replaces the official one.
"""
import json
import random
import re
import statistics
import sys

NAME = re.compile(r"^(?P<lib>.+)-(?P<arm>[A-Za-z0-9]+)-r(?P<rep>\d+)$")


def option(name, default):
    return sys.argv[sys.argv.index(name) + 1].split(",") if name in sys.argv else default


FIRST, SECOND = option("--arms", ["A", "B"])
FIRST_NAME, SECOND_NAME = option("--names", ["stock", "Posthorse"])
ONCE = "--once" in sys.argv


def share(passed, row, finished):
    if finished:
        return 1.0
    if passed is None:
        return None
    return min(1.0, passed / row["reference_passed"])


def enrich(row):
    kinds = row["stop_kinds"]
    once = row.get("passed_once_at_stops") or []
    row = {**row, "graded_once": ONCE and bool(once) and None not in once}
    if row["graded_once"]:
        own_at = next((i for i, kind in enumerate(kinds) if kind != "provider-error"), None)
        row.update(passed=once[-1], passed_at_first_own_stop=None if own_at is None else once[own_at])
    finished_first = row["first_own_stop_kind"] == "finished"
    finished = "finished" in kinds
    spent = row.get("spent_to_finish") or {}
    return {
        **row,
        "finished": finished,
        "finished_first": finished_first,
        "quit": row["agent_stops"] > 0,
        "share_first": share(row["passed_at_first_own_stop"], row, finished_first),
        "share_end": share(row["passed"], row, finished),
        "cost_to_finish": spent.get("cost"),
        "output_to_finish": spent.get("output_tokens"),
        # What the run used until it finished, or until it ended unfinished. The harness sends "Continue." to a
        # finished run when one expected failure keeps it below the reference count; that work is not counted.
        "minutes_used": row["minutes_to_finish"] if finished else row["working_minutes"],
        "cost_used": spent["cost"] if finished else row["cost"],
        "output_used": spent["output_tokens"] if finished else row["output_tokens"],
        "fresh_input_used": spent["uncached_input_tokens"] if finished else row["uncached_input_tokens"],
        "cached_input_used": spent["cache_read_tokens"] if finished else row["cache_read_tokens"],
    }


def mean(values):
    values = [v for v in values if v is not None]
    return None if not values else sum(values) / len(values)


def by_library(rows, arm, key):
    """Mean over libraries of the mean over a library's repetitions."""
    libs = sorted({r["lib"] for r in rows})
    per_lib = {lib: mean([r[key] for r in rows if r["lib"] == lib and r["arm"] == arm]) for lib in libs}
    return per_lib, mean(list(per_lib.values()))


def paired(rows, key):
    """(library, repetition) pairs that have the value on both sides."""
    index = {(r["lib"], r["rep"], r["arm"]): r for r in rows}
    out = []
    for (lib, rep, arm), row in sorted(index.items()):
        other = index.get((lib, rep, SECOND))
        if arm == FIRST and other is not None and row[key] is not None and other[key] is not None:
            out.append((lib, rep, row[key], other[key]))
    return out


def bootstrap_difference(pairs, draws=10000, seed=140):
    """95% interval of the mean B minus A difference, resampling whole libraries (each library counts once)."""
    by_lib = {}
    for lib, _rep, a, b in pairs:
        by_lib.setdefault(lib, []).append(b - a)
    lib_means = [sum(v) / len(v) for v in by_lib.values()]
    if len(lib_means) < 2:
        return None
    rng = random.Random(seed)
    samples = sorted(sum(rng.choices(lib_means, k=len(lib_means))) / len(lib_means) for _ in range(draws))
    return sum(lib_means) / len(lib_means), samples[int(0.025 * draws)], samples[int(0.975 * draws) - 1], len(lib_means)


def fmt(value, digits=1, unit=""):
    return "-" if value is None else f"{value:.{digits}f}{unit}"


def pct(value):
    return "-" if value is None else f"{100 * value:.1f}%"


def main():
    rows = []
    running = 0
    void = []
    for line in sys.stdin:
        row = json.loads(line)
        name = NAME.match(row["run"])
        if not name or name["arm"] not in (FIRST, SECOND):
            continue
        if row.get("void"):  # a run that does not count (a harness fault, a broken rule); its repeat has the same name
            void.append(row)
            continue
        if row["outcome"] == "running":
            running += 1
            continue
        rows.append(enrich(row))
    if "--json" in sys.argv:
        for row in rows:
            print(json.dumps(row))
        return
    libs = sorted({r["lib"] for r in rows})
    print(f"Runs ended: {len(rows)} ({FIRST_NAME} {sum(r['arm'] == FIRST for r in rows)}, {SECOND_NAME} {sum(r['arm'] == SECOND for r in rows)}); still running: {running}")
    for row in void:
        print(f"Not counted: {row['run']} ({FIRST_NAME if row['arm'] == FIRST else SECOND_NAME}): {row['void']}")
    if ONCE:
        graded_once = [r for r in rows if r["graded_once"]]
        print(f"Graded with every test run once: {len(graded_once)} runs ({', '.join(sorted({r['lib'] for r in graded_once})) or 'none'}); the other runs have the official grade, which runs each test once")
    print()
    print("## Per side (every library counts the same)")
    lines = [
        ("Finished within the limit", lambda arm: f"{sum(r['finished'] for r in rows if r['arm'] == arm)} of {sum(r['arm'] == arm for r in rows)}"),
        ("Finished without a 'Continue.'", lambda arm: f"{sum(r['finished_first'] for r in rows if r['arm'] == arm)} of {sum(r['arm'] == arm for r in rows)}"),
        ("Runs where the agent quit unfinished", lambda arm: f"{sum(r['quit'] for r in rows if r['arm'] == arm)} of {sum(r['arm'] == arm for r in rows)}"),
        ("Times the agent quit unfinished", lambda arm: str(sum(r["agent_stops"] for r in rows if r["arm"] == arm))),
        ("Turns ended by a provider error", lambda arm: str(sum(r["provider_error_stops"] for r in rows if r["arm"] == arm))),
        ("Tests passing when the agent first stopped", lambda arm: pct(by_library(rows, arm, "share_first")[1])),
        ("Minutes until the agent first stopped", lambda arm: fmt(by_library(rows, arm, "minutes_to_first_own_stop")[1])),
        ("Tests passing at the end", lambda arm: pct(by_library(rows, arm, "share_end")[1])),
        ("Minutes per run, to finish or to the end", lambda arm: fmt(by_library(rows, arm, "minutes_used")[1])),
        ("Replies per run", lambda arm: fmt(by_library(rows, arm, "replies")[1], 0)),
        *([("Child agents started per run", lambda arm: fmt(by_library(rows, arm, "child_agents")[1])),
           ("Replies of child agents per run", lambda arm: fmt(by_library(rows, arm, "child_replies")[1], 0)),
           ("Context boundaries in child agents per run", lambda arm: fmt(by_library(rows, arm, "child_boundaries")[1]))]
          if any(r.get("child_agents") for r in rows) else []),
        ("Context boundaries per run", lambda arm: fmt(by_library(rows, arm, "boundaries")[1])),
        ("Seconds blocked at boundaries per run", lambda arm: fmt(by_library(rows, arm, "boundary_wait_s")[1])),
        ("Output tokens per run", lambda arm: fmt(by_library(rows, arm, "output_used")[1], 0)),
        ("Fresh input tokens per run", lambda arm: fmt(by_library(rows, arm, "fresh_input_used")[1], 0)),
        ("Cached input tokens per run", lambda arm: fmt(by_library(rows, arm, "cached_input_used")[1], 0)),
        ("List-price cost per run", lambda arm: fmt(by_library(rows, arm, "cost_used")[1], 2, " USD")),
        ("  of which summary requests", lambda arm: fmt(by_library(rows, arm, "summary_cost")[1], 2, " USD")),
        ("List-price cost billed, all runs", lambda arm: fmt(sum(r["cost"] for r in rows if r["arm"] == arm), 2, " USD")),
    ]
    print(f"{'':44}{FIRST_NAME:>24}{SECOND_NAME:>24}")
    for label, value in lines:
        print(f"{label:44}{value(FIRST):>24}{value(SECOND):>24}")
    print()
    print("## Runs that finished on both sides of a pair (same library, same repetition)")
    for key, label, digits, unit in (("minutes_to_finish", "Minutes to finish", 1, ""), ("cost_to_finish", "List-price cost to finish", 2, " USD"),
                                     ("output_to_finish", "Output tokens to finish", 0, "")):
        pairs = paired([r for r in rows if r["finished"]], key)
        if not pairs:
            print(f"{label}: no pair finished on both sides")
            continue
        a, b = [p[2] for p in pairs], [p[3] for p in pairs]
        faster = sum(y < x for x, y in zip(a, b))
        print(f"{label}: {len(pairs)} pairs. {FIRST_NAME} mean {fmt(mean(a), digits, unit)}, median {fmt(statistics.median(a), digits, unit)}; "
              f"{SECOND_NAME} mean {fmt(mean(b), digits, unit)}, median {fmt(statistics.median(b), digits, unit)}; {SECOND_NAME} lower in {faster} of {len(pairs)}")
    print()
    print(f"## Difference, {SECOND_NAME} minus {FIRST_NAME}, over pairs")
    for key, label, scale, unit in (("share_first", "Tests passing when the agent first stopped", 100, " points"),
                                    ("share_end", "Tests passing at the end", 100, " points"),
                                    ("minutes_used", "Minutes, to finish or to the end", 1, " min"), ("cost_used", "List-price cost", 1, " USD")):
        pairs = paired(rows, key)
        result = bootstrap_difference(pairs)
        higher = sum(b > a for _l, _r, a, b in pairs)
        lower = sum(b < a for _l, _r, a, b in pairs)
        if result is None:
            print(f"{label}: {len(pairs)} pairs, too few libraries for an interval")
            continue
        centre, low, high, count = result
        print(f"{label}: {scale * centre:+.1f}{unit} (95% interval {scale * low:+.1f} to {scale * high:+.1f}; {count} libraries, {len(pairs)} pairs; "
              f"{SECOND_NAME} higher in {higher}, lower in {lower}, equal in {len(pairs) - higher - lower})")
    print()
    print(f"## Per library (mean of the repetitions that ended): {FIRST_NAME} | {SECOND_NAME}")
    print(f"{'library':24}{'runs':>8}{'finished':>10}{'quit':>8}{'first stop':>18}{'at min':>14}{'end':>18}{'min':>14}{'USD':>14}{'bound.':>10}{'wait s':>12}")
    for lib in libs:
        cells = []
        for key, f in (("finished", None), ("quit", None)):
            cells.append("|".join(str(sum(r[key] for r in rows if r["lib"] == lib and r["arm"] == arm)) for arm in (FIRST, SECOND)))
        def both(key, show):
            return "|".join(show(mean([r[key] for r in rows if r["lib"] == lib and r["arm"] == arm])) for arm in (FIRST, SECOND))
        count = "|".join(str(sum(r["lib"] == lib and r["arm"] == arm for r in rows)) for arm in (FIRST, SECOND))
        print(f"{lib:24}{count:>8}{cells[0]:>10}{cells[1]:>8}{both('share_first', pct):>18}{both('minutes_to_first_own_stop', fmt):>14}"
              f"{both('share_end', pct):>18}{both('minutes_used', fmt):>14}{both('cost_used', lambda v: fmt(v, 2)):>14}{both('boundaries', fmt):>10}{both('boundary_wait_s', lambda v: fmt(v, 0)):>12}")


if __name__ == "__main__":
    main()
