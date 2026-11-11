#!/usr/bin/env python3
"""Label what the agent said when it stopped by itself, without the labeller knowing the side.

  c0stops.py RUNS_DIR --json | stoplabels.py blind OUT_DIR PREFIX [EARLIER_DIR...]
      Writes OUT_DIR/items.jsonl (id, text: the agent's last message at each stop of kind "agent", in random order)
      and OUT_DIR/key.jsonl (id, run, arm, lib, stop, minute, passed, ...). The labeller gets items.jsonl only.
      Ids start with PREFIX. Messages that an EARLIER_DIR already holds are left out.
  c0stops.py RUNS_DIR --json | stoplabels.py join OUT_DIR...
      Reads labels.tsv (id TAB label TAB quote) of every OUT_DIR. Prints one line per stop of kind "agent" as the runs
      are now, with the label of its message, and counts per side. A label belongs to the message text.

Labels (RUBRIC below is the text given to the labeller). The first version had four labels (remains, cannot, done,
empty). In the first pass 7 of 44 messages said only that each failure was "documented" or a "blocker"; the two
labellers split on 3 of them, so `documented` became its own label and both labelled every item again.
"""
import json
import random
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

RUBRIC = """Each item is the last message an AI coding agent wrote before it ended its turn. Its task was to implement a
Python library until the test suite passes; it was told: "You are done when the whole test suite passes, or when you can
state for each remaining failure why it cannot be fixed." The harness found tests still failing at every one of these stops.
Give each item exactly one label, judging only what the message itself says:
  remains     the message says, or plainly implies, that work is left that could still be done (for example "incomplete",
              "remaining failures are not established as unfixable", "still require implementation", a list of what is
              missing, a plan for next steps). A bare count of failing tests with no claim about them also gets this label.
  documented  the message says that each remaining failure is documented, explained or a "blocker", but it does not say
              that the failures cannot be fixed, gives no reason why they cannot, and does not say that work could still be done
  cannot      the message claims that the remaining failures cannot be fixed, or gives a cause outside the agent's reach
              (the rules of the task, the environment, defects in the tests), and names no failure as still fixable
  done        the message claims the task is complete or that all tests pass, and mentions no remaining failure
  empty       there is no text, or the text says nothing about the state of the work
If a message fits remains and another label, the label is remains.
Also copy the shortest phrase from the message that decided the label (at most 20 words; leave empty for label empty)."""


def labelled_texts(folders):
    """The message texts that earlier rounds hold. A label belongs to the text, not to the run: a run that is voided later
    and its repeat share a name and stop numbers, and the same message never needs a second label."""
    return {json.loads(line)["text"] for folder in folders for line in open(Path(folder) / "items.jsonl")}


def blind(out_dir, prefix, earlier):
    stops = [json.loads(line) for line in sys.stdin if line.strip()]
    done = labelled_texts(earlier)
    own = []
    for stop in stops:
        if stop["kind"] == "agent" and stop["text"] not in done:
            done.add(stop["text"])
            own.append(stop)
    random.Random(prefix).shuffle(own)
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(out_dir / "items.jsonl", "w") as items, open(out_dir / "key.jsonl", "w") as key:
        for number, stop in enumerate(own, 1):
            name = f"{prefix}{number:03d}"
            items.write(json.dumps({"id": name, "text": stop["text"]}) + "\n")
            key.write(json.dumps({"id": name, **{k: v for k, v in stop.items() if k != "text"}}) + "\n")
    (out_dir / "RUBRIC.txt").write_text(RUBRIC + "\n")
    print(f"{len(own)} messages without a label (of {sum(s['kind'] == 'agent' for s in stops)} stops of kind agent) -> {out_dir}/items.jsonl")


def join(out_dirs):
    """Labels for the stops as they are now (stdin: c0stops.py --json), looked up by the text of the message."""
    by_text = {}
    for out_dir in out_dirs:
        texts = {row["id"]: row["text"] for row in map(json.loads, open(out_dir / "items.jsonl"))}
        for line in open(out_dir / "labels.tsv"):
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 2 and parts[0] in texts:
                by_text[texts[parts[0]]] = (parts[1].strip(), parts[2].strip() if len(parts) > 2 else "")
    per_arm = defaultdict(Counter)
    runs = defaultdict(lambda: defaultdict(set))
    every = defaultdict(set)
    unlabelled = defaultdict(list)
    stops = [row for row in (json.loads(line) for line in sys.stdin if line.strip()) if row["kind"] == "agent"]
    for row in sorted(stops, key=lambda row: (row["run"], row["void"], row["stop"])):
        if row["text"] not in by_text:
            unlabelled[row["arm"]].append(f"{row['run']}{' VOID' if row['void'] else ''} stop {row['stop']}")
            continue
        label, quote = by_text[row["text"]]
        counted = not row["void"] and re.fullmatch(r".+-[A-Z]-r\d+", row["run"])  # main runs; a labelled run (a trial) is listed only
        if counted:
            per_arm[row["arm"]][label] += 1
            runs[row["arm"]][label].add(row["run"])
            every[row["arm"]].add(row["run"])
        print(f"{row['run']}{' VOID' if row['void'] else ''}{'' if counted or row['void'] else ' (not a main run)'}\t{row['stop']}\t{label}\tmin {row['minute']:.0f}\t"
              f"{row['passed']} of {row['reference_passed']}\tboundaries before {row['boundaries_before']}\t{quote}")
    for arm in sorted(per_arm):
        print(f"# arm {arm}: {sum(per_arm[arm].values())} own stops in {len(every[arm])} runs: "
              + ", ".join(f"{label} {count} stops in {len(runs[arm][label])} runs" for label, count in sorted(per_arm[arm].items())), file=sys.stderr)
    for arm in sorted(unlabelled):
        print(f"# arm {arm}: {len(unlabelled[arm])} stops have no label yet: {', '.join(unlabelled[arm])}", file=sys.stderr)


if __name__ == "__main__":
    if sys.argv[1] == "blind":
        blind(Path(sys.argv[2]), sys.argv[3], sys.argv[4:])
    else:
        join([Path(name) for name in sys.argv[2:]])
