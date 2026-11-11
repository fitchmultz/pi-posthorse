# Controlled comparison: harness, tables, and stop labels

This directory holds the data behind [the controlled comparison](../../docs/controlled-comparison.md)
and the harness that produced it.

## Contents

| Path                                                 | Content                                                                                                                                               |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness/`                                           | The scripts that ran, graded, and tabulated the sessions.                                                                                             |
| `arms/G/`                                            | Settings of the "stock + paragraph" side, and the paragraph that it appends to the system prompt. `harness/setup_arms.sh` writes the two other sides. |
| `lists-main.txt`, `lists-g.txt`                      | The sessions of each batch, one per line: library, side, repetition, limits. Both models ran the same lists.                                          |
| `results/MODEL/runs.jsonl`                           | One row per session: stops, tests passing at each stop, time, tokens, cost, boundaries.                                                               |
| `results/MODEL/summary-*.txt`                        | The side-by-side tables. `-once` uses the one-pass grade for networkx.                                                                                |
| `results/MODEL/summary-*.jsonl`                      | The per-session rows behind each table.                                                                                                               |
| `results/MODEL/rule3-*.txt`                          | Rule 3: runs of the whole suite that a commit followed.                                                                                               |
| `results/MODEL/boundaries-*.txt`                     | Wait, context size, summary cost, and repeated file reads at boundaries.                                                                              |
| `results/MODEL/rules-carried.txt`, `rule2-lines.txt` | The rules that each summary or recovery record states.                                                                                                |
| `results/MODEL/end-condition.txt`                    | How each stock summary states the end condition of the first message.                                                                                 |
| `results/MODEL/quit-rate-*.txt`                      | Times the agent ended its turn unfinished, per hour of work, before and after the first boundary.                                                     |
| `results/MODEL/crossed-*.txt`                        | Sessions with and without a boundary, and the first unfinished stop after a boundary.                                                                 |
| `results/MODEL/stops.jsonl`, `stops.txt`             | The agent's last message at every stop.                                                                                                               |
| `results/MODEL/stop-labels.tsv`                      | The label of every stop where the agent ended its turn with failing tests.                                                                            |
| `results/MODEL/audit.txt`                            | Commands that a reader should check for a broken rule: network, package index, disk searches, Docker.                                                 |
| `labels/`                                            | The labelling rounds: the rules for the labellers, the messages without side or session, both labellers' output, and the key.                         |

Sides in file names and rows: `A` is stock, `B` is Posthorse, `G` is stock + paragraph.

The session journals, the tree snapshots, and the graded test reports are not in this repository.
They hold about 8 GB. Open an issue to ask for them.

The copy leaves out the rows and files of a separate test that ran on the same machine, and it
replaces the name of the machine's user in paths.

## Run the comparison again

You need a Linux machine with Docker, `bwrap`, Node.js, Python 3.12, and a Pi login for the
model provider. The runs used Docker 29.9, bubblewrap 0.13.1, and a 32-core machine with 32 GB of
memory. A session can use up to 4 GB of memory for its tests.

1. Create a working directory, and copy `harness/`, `arms/`, `lists-main.txt`, and `lists-g.txt`
   into it. The harness treats the directory above `harness/` as its root, and a batch reads its
   list file from there.
2. Create a Python 3.12 environment at `commit0/.venv`, and install `commit0` 0.1.8 in it. The
   harness uses Commit0's task list, image names, test script, and test lists.
3. Install official Pi and the test-timeout plugin that the grading uses:

   ```sh
   npm install --prefix pi-official @earendil-works/pi-coding-agent@1.5.2
   mkdir wheels && pip download pytest-timeout==2.4.0 --no-deps -d wheels
   ```

4. Create the sides: `bash harness/setup_arms.sh 0.10.17`, then `cp -r arms/G agents/G`.
5. Copy each library out of its Commit0 image, and prove the grading with the finished library.
   `prepare` pulls the image.

   ```sh
   commit0/.venv/bin/python harness/c0.py prepare jinja
   commit0/.venv/bin/python harness/c0.py check jinja
   ```

   `check` must report that the finished library passes every test, and that no copy of the
   finished library is readable from the workspace.

6. Start the memory limit for test containers: `nohup setsid bash harness/memguard.sh &` and
   `nohup setsid bash harness/memlimit.sh &`.
7. Run a batch of sessions, 12 at a time:

   ```sh
   MODEL=openai-codex/gpt-6.1-sol nohup setsid bash harness/c0batch.sh lists-main.txt 12 >/dev/null 2>&1 &
   ```

   A session writes `c0runs/MODEL/LIBRARY-SIDE-rN/`. `logs/c0batch.log` shows the progress.

8. Run the third side the same way with `lists-g.txt`.
9. Write the tables: `bash harness/report.sh gpt-6.1-sol A,G,B`. They go to `results/gpt-6.1-sol/`.

## Label the stops

`harness/stoplabels.py blind` writes the last message of every stop where the agent ended its
turn with failing tests, in random order and without side or session. Give `items.jsonl` and
`RUBRIC-v2.txt` to two labellers, and write the agreed labels to `labels.tsv` in the same
directory:

```sh
python3 harness/c0stops.py c0runs/gpt-6.1-sol --json | python3 harness/stoplabels.py blind labels/sol-1 a
```

`harness/report.sh` then attaches the labels of every settled round to the sessions and writes
`results/MODEL/stop-labels.tsv`. A label belongs to the text of a message, so a later round holds
only the messages that no earlier round has:

```sh
python3 harness/c0stops.py c0runs/gpt-6.1-sol --json | python3 harness/stoplabels.py blind labels/sol-2 b labels/sol-1
```
