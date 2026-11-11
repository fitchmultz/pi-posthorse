#!/usr/bin/env python3
"""Tests passing over time, per side, from the graded 5-minute snapshots.

Usage: c0curve.py RUNS_DIR [--arms A,B] [--names stock,Posthorse] [--label LABEL] [--svg FILE] [--step 5] [--limit 120]
RUNS_DIR is c0runs/MODEL_TAG. Needs `c0.py score MODEL_TAG --snapshots` first (score.json in each run).

Time is the time the agent had: the Pi invocations only, without the grading between them. A run's line holds its
last graded value after the session ended (finished, or the agent quit and the 'Continue.' messages were used up).
A snapshot whose test suite did not finish in time keeps the last value that did finish; the count is reported.
JSON on stdout (per library and side, the mean over repetitions at each mark), a text table on stderr.
"""
import argparse
import json
import re
import sys
from pathlib import Path

from table import parse_time

COLORS = ["#b45309", "#1d4ed8", "#047857", "#7c3aed"]


def working_minutes(meta, stops, at):
    """Minutes of Pi invocations before the moment `at`; a run without recorded invocations (the first probes) uses the clock."""
    if not stops:
        return (at - parse_time(meta["started"])).total_seconds() / 60
    total = 0.0
    for stop in stops:
        start = parse_time(stop["started"])
        end = parse_time(stop["ended"]) if stop.get("ended") else at
        if at <= start:
            break
        total += (min(at, end) - start).total_seconds()
    return total / 60


def run_series(run_dir):
    meta = json.loads((run_dir / "meta.json").read_text())
    score = json.loads((run_dir / "score.json").read_text()) if (run_dir / "score.json").exists() else {}
    stops = [stop for stop in meta.get("stops", [])]
    points, unfinished_suites = [], 0
    for grade in list(score.get("snapshots", {}).values()) + [stop for stop in stops if stop.get("ended")]:
        at = parse_time(grade.get("at") or grade["ended"])
        if grade.get("timed_out") and "at" in grade or grade.get("suite_timed_out"):
            unfinished_suites += 1
            continue
        if grade.get("share") is None:
            continue
        points.append((working_minutes(meta, stops, at), grade["share"]))
    points.sort()
    worked = sum((parse_time(stop["ended"]) - parse_time(stop["started"])).total_seconds() for stop in stops if stop.get("ended")) / 60
    if not stops and points:
        worked = points[-1][0]
    return {"run": meta["run"], "lib": meta["lib"], "arm": meta["arm"], "rep": meta["rep"], "ended": "ended" in meta,
            "worked_minutes": round(worked, 1), "points": points, "unfinished_suites": unfinished_suites}


def value_at(series, minute):
    """Last graded share at or before `minute`; None before the first grade or past the work of a run that is still going."""
    if not series["ended"] and minute > series["worked_minutes"]:
        return None
    value = None
    for at, share in series["points"]:
        if at > minute + 1e-6:
            break
        value = share
    return value


def mean(values):
    values = [value for value in values if value is not None]
    return sum(values) / len(values) if values else None


def svg(path, libs, arms, names, marks, per_run, per_lib, overall, limit):
    width, height, left, top, columns = 250, 150, 44, 58, 3
    panels = libs + ["all libraries"]
    rows = -(-len(panels) // columns)
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {left + columns * (width + 64)} {top + rows * (height + 56)}" font-family="system-ui, sans-serif" font-size="11">',
           '<rect width="100%" height="100%" fill="#ffffff"/>',
           f'<text x="{left}" y="20" font-size="14" font-weight="600">Tests passing over the time the agent worked</text>']
    for index, name in enumerate(names):
        x = left + index * 150
        out.append(f'<line x1="{x}" y1="38" x2="{x + 26}" y2="38" stroke="{COLORS[index]}" stroke-width="3"/>')
        out.append(f'<text x="{x + 32}" y="42">{name}</text>')
    out.append(f'<text x="{left + len(names) * 150}" y="42" fill="#4b5563">thick line: mean of the repetitions; thin lines: single runs</text>')

    def xy(minute, share, ox, oy):
        return f"{ox + minute / limit * width:.1f},{oy + height - share * height:.1f}"

    for number, panel in enumerate(panels):
        ox = left + (number % columns) * (width + 64)
        oy = top + (number // columns) * (height + 56) + 16
        out.append(f'<text x="{ox}" y="{oy - 6}" font-weight="600">{panel}</text>')
        for share in (0, 0.25, 0.5, 0.75, 1):
            y = oy + height - share * height
            out.append(f'<line x1="{ox}" y1="{y:.1f}" x2="{ox + width}" y2="{y:.1f}" stroke="#e5e7eb"/>')
            out.append(f'<text x="{ox - 6}" y="{y + 4:.1f}" text-anchor="end" fill="#4b5563">{int(share * 100)}%</text>')
        for minute in range(0, limit + 1, 30):
            x = ox + minute / limit * width
            out.append(f'<text x="{x:.1f}" y="{oy + height + 14}" text-anchor="middle" fill="#4b5563">{minute}</text>')
        if number // columns == rows - 1 or number + columns >= len(panels):
            out.append(f'<text x="{ox + width / 2}" y="{oy + height + 28}" text-anchor="middle" fill="#4b5563">minutes</text>')
        for index, arm in enumerate(arms):
            if panel != "all libraries":
                for series in per_run:
                    if series["lib"] == panel and series["arm"] == arm:
                        line = [xy(mark, value_at(series, mark), ox, oy) for mark in marks if value_at(series, mark) is not None]
                        if len(line) > 1:
                            out.append(f'<polyline points="{" ".join(line)}" fill="none" stroke="{COLORS[index]}" stroke-width="1" opacity="0.35"/>')
                values = per_lib[panel][arm]
            else:
                values = overall[arm]
            line = [xy(mark, value, ox, oy) for mark, value in zip(marks, values) if value is not None]
            if len(line) > 1:
                out.append(f'<polyline points="{" ".join(line)}" fill="none" stroke="{COLORS[index]}" stroke-width="2.5"/>')
    out.append("</svg>")
    Path(path).write_text("\n".join(out) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("runs_dir")
    parser.add_argument("--arms", default="A,B")
    parser.add_argument("--names", default="stock,Posthorse")
    parser.add_argument("--label", default="")
    parser.add_argument("--svg")
    parser.add_argument("--step", type=int, default=5)
    parser.add_argument("--limit", type=int, default=120)
    args = parser.parse_args()
    arms, names = args.arms.split(","), args.names.split(",")
    suffix = f"-{args.label}" if args.label else ""
    pattern = re.compile(rf"^(?P<lib>.+)-(?P<arm>{'|'.join(map(re.escape, arms))})-r\d+{re.escape(suffix)}$")
    per_run = [run_series(path) for path in sorted(Path(args.runs_dir).iterdir())
               if pattern.match(path.name) and (path / "meta.json").exists() and (path / "score.json").exists()]
    # A run that is still going has an invocation the harness has not recorded yet, so its time axis is not known.
    running = [series["run"] for series in per_run if not series["ended"] and json.loads((Path(args.runs_dir) / series["run"] / "meta.json").read_text()).get("stops") is not None]
    per_run = [series for series in per_run if series["run"] not in running]
    marks = list(range(0, args.limit + 1, args.step))
    libs = sorted({series["lib"] for series in per_run})
    per_lib = {lib: {arm: [mean([value_at(series, mark) for series in per_run if series["lib"] == lib and series["arm"] == arm]) for mark in marks]
                     for arm in arms} for lib in libs}
    # Every library counts the same; a mark counts only libraries that have a value on every side.
    overall = {arm: [] for arm in arms}
    for position in range(len(marks)):
        complete = [lib for lib in libs if all(per_lib[lib][arm][position] is not None for arm in arms)]
        for arm in arms:
            overall[arm].append(mean([per_lib[lib][arm][position] for lib in complete]) if complete else None)
    print(json.dumps({"marks": marks, "arms": arms, "names": names, "per_library": per_lib, "all_libraries": overall,
                      "runs": [{key: series[key] for key in ("run", "ended", "worked_minutes", "unfinished_suites")} | {"grades": len(series["points"])} for series in per_run]}))
    shown = [mark for mark in marks if mark % 15 == 0 and mark > 0]
    print(f"{'library':<24}{'side':<11}" + "".join(f"{mark:>7}" for mark in shown), file=sys.stderr)
    for lib in libs + ["all libraries"]:
        for arm, name in zip(arms, names):
            values = overall[arm] if lib == "all libraries" else per_lib[lib][arm]
            cells = "".join(f"{'-' if values[marks.index(mark)] is None else format(values[marks.index(mark)] * 100, '.0f') + '%':>7}" for mark in shown)
            print(f"{lib:<24}{name:<11}{cells}", file=sys.stderr)
    print(f"runs {len(per_run)}; left out because still running: {len(running)}; snapshots whose suite did not finish: {sum(series['unfinished_suites'] for series in per_run)}", file=sys.stderr)
    if args.svg:
        svg(args.svg, libs, arms, names, marks, per_run, per_lib, overall, args.limit)


if __name__ == "__main__":
    main()
