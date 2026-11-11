# Controlled comparison: Posthorse and stock Pi compaction on long tasks, November 2026

This comparison counts 144 unattended coding sessions on two models. Each session implemented one
Python library for up to two hours in a 128,000-token window. A session used stock Pi compaction,
Posthorse, or stock Pi with one paragraph of the Posthorse guidance.

- **The agent kept working more often on Posthorse.** On `gpt-6.1-sol` the agent ended its turn
  with failing tests in 10 of 24 stock sessions and in 4 of 24 Posthorse sessions. On
  `gpt-6.1-terra` all 24 stock sessions used up their three `Continue.` messages and ended
  unfinished. Six of 24 Posthorse sessions did.
- **Tests passing at the end.** On sol, 78.0% for stock and 85.3% for Posthorse. Most of that gap
  comes from how Commit0 grades one library. With that library graded in one pass, the numbers
  are 83.0% and 85.6%. On terra, 23.2% and 58.2%. The terra gap is work time: a stock session
  ended after 31 minutes on average and a Posthorse session after 87.
- **Wait and cost.** Stock compaction blocked each sol session for 3.3 minutes. A sol session cost
  about the same on both sides, 5.77 and 5.46 USD at list price. On terra a Posthorse session cost
  3.5 times as much, because it worked 2.8 times as long.
- **The agent followed what the summaries said.** In three sol sessions the summaries dropped the
  rule against copying the library, and only in those three did the agent try to get a finished
  copy. In 11 sol sessions the first summary weakened the end condition. In 6 of them the agent
  then ended its turn with only a list of the failures, 17 times in all. A Posthorse record
  carries the first message word for word.
- **The paragraph alone did not produce the difference.** With it, stock Pi sessions on terra
  ended as they did without it. On sol it changed what the agent said when it stopped: 8 of 24
  sessions still ended a turn unfinished, against 10 without the paragraph and 4 on Posthorse.
- **No difference** in the planted duty to commit after every whole-suite run, and in files read
  again after a boundary.

The [limits](#limits) are one benchmark family, two models of one provider, a forced window, and
three sessions per library and side.

## What the comparison covers

### The task is one library per session

Each session implements one Python library from [Commit0](https://github.com/commit-0/commit0).
Commit0 takes a real library, replaces the body of every function and method with `pass`, and
keeps the tests. The agent writes the bodies again until the tests pass. Nobody answers the agent
during a session.

The comparison uses eight libraries. In the harness, the finished library passes every listed
test without network access.

| Library        | Bodies to write | Tests |
| -------------- | --------------: | ----: |
| jinja          |             327 |   851 |
| tornado        |             433 | 1,150 |
| pydantic       |             543 | 5,091 |
| sphinx         |             552 | 2,187 |
| dulwich        |             650 | 1,522 |
| prompt-toolkit |             825 |   151 |
| pylint         |             887 | 1,868 |
| networkx       |           1,361 | 5,436 |

Smaller tasks do not separate the two designs. Two trials showed it before the runs:

- **SWE-bench Verified.** One session fixed 40 Django issues in a row. Stock compaction resolved
  38 and Posthorse resolved 39. An issue adds about 1,400 tokens of context, so the issue in
  progress always sits in the recent messages that both designs keep.
- **Small Commit0 libraries.** Both sides finished libraries of up to about 330 bodies with at
  most one boundary.

### The sides differ in one thing

| Side              | Context handling                  | Added to the system prompt              |
| ----------------- | --------------------------------- | --------------------------------------- |
| stock             | Pi's compaction, default settings | nothing                                 |
| Posthorse         | `pi-posthorse` 0.10.17            | the Posthorse guidance section          |
| stock + paragraph | Pi's compaction, default settings | one paragraph of the Posthorse guidance |

All sides run official Pi 1.5.2 from npm with the same model, thinking level, context window,
first message, and limits. The stock side and the Posthorse side were planned and are the
comparison that [issue #140](https://github.com/fitchmultz/pi-posthorse/issues/140) asked for.
The method was [posted on the issue](https://github.com/fitchmultz/pi-posthorse/issues/140#issuecomment-6778052716)
before the runs.

The third side was added after the first results. On the stock side the agent ended its turn with
work left more often, and one paragraph of the Posthorse guidance could explain that without any
other part of Posthorse. The third side gives stock Pi that paragraph and nothing else:

```text
Pi compacts context automatically, so the context window is not a deadline. Do not reduce scope,
skip steps or verification, or write a final summary because compaction is near, and do not wait
for the user to say "continue". Finish when the requested work and its verification are complete,
or report a genuine blocker.
```

The Posthorse text is the same except that it says "rolls context over" and "rollover". The
results of the third side are under
[The paragraph alone changed what the stops say](#the-paragraph-alone-changed-what-the-stops-say-not-how-many-sessions-stopped)
for `gpt-6.1-sol` and under
[The paragraph alone did not keep terra working](#the-paragraph-alone-did-not-keep-terra-working)
for `gpt-6.1-terra`.

### Settings

- **Model.** `gpt-6.1-sol` first, then `gpt-6.1-terra`, both at Pi's default thinking level
  (medium), through a ChatGPT subscription login.
- **Context window.** 128,000 tokens on every side. The real window of both models is 500,000
  tokens. At 128,000 a large library crosses several boundaries in two hours. Stock Pi compacts
  and Posthorse rolls over at the same point, 111,616 tokens.
- **Size.** Three sessions per library and side: 24 sessions per side and model.
- **Limits.** A session ends after 2 hours of agent time. When the agent ends its turn, the
  harness runs the tests. If a test still fails, the harness sends `Continue.`, at most 3 times.
- **Isolation.** Pi runs in a sandbox that reaches only the model provider. The tests run in a
  container without network access. The agent's copy of the library has no upstream git history
  and no compiled files.

### The first message states the rules once

Every session starts with the same message. Only the library name and the paths change.

```text
The directory repo/ holds the Python library jinja with the bodies of its functions and methods
removed (each is now `pass`). Implement the library so that its test suite passes. I am away until
you are done, so do not stop to ask questions or to report progress.

The current directory holds:
- repo/: the library. The code to implement is under repo/src/jinja2. The tests are under repo/tests.
- bin/envrun COMMAND: runs COMMAND in the library's prepared Python environment, with repo/ as its
  working directory. Use it to run the tests, for example `bin/envrun pytest tests/`. Python on this
  machine does not have the dependencies, and there is no network access.

Rules:
1. Do not create, change or delete any test file. Put scratch files in scratch/ instead.
2. Write the implementation yourself. Do not install the library or copy its code from anywhere.
3. After every run of the whole test suite, commit your work in repo/ with git. The commit message
   must be the result in this exact form: `tests: N passed` (N is the number of passing tests).

You are done when the whole test suite passes, or when you can state for each remaining failure
why it cannot be fixed.
```

Rule 3 is a planted duty. It recurs through the whole session, and git and the journal show
whether the agent kept it.

### Grading uses Commit0's own test script

The harness copies the agent's tree every 5 minutes and at every stop. It grades a copy in a
fresh container with Commit0's test script, always against the original tests. The score is the
number of passing tests out of the tests that the finished library passes.

Grading adds two limits that Commit0 does not have. A test that runs longer than 120 seconds
fails, and a suite that runs longer than 15 minutes counts as zero tests passing. A half-built
library can loop forever, and without the limits one such test would hold a session for 30 minutes
at every stop.

## Results for gpt-6.1-sol

The stock side and the Posthorse side have 24 sessions each. The third side also has 24 and has
its own section. A _stop_ is the end of one Pi invocation: the agent ended its turn, or the time
limit ended the session.

### After two hours the two sides pass a similar share of tests

| Tests passing                        | stock | Posthorse | Difference (95% interval)    |
| ------------------------------------ | ----: | --------: | ---------------------------- |
| At the first stop                    | 67.9% |     84.3% | +16.4 points (+5.3 to +28.1) |
| At the first stop, networkx one pass | 72.9% |     84.6% | +11.8 points (+2.6 to +22.0) |
| At the end                           | 78.0% |     85.3% | +7.3 points (+0.6 to +17.5)  |
| At the end, networkx one pass        | 83.0% |     85.6% | +2.6 points (+0.3 to +5.5)   |

Posthorse sessions passed more tests at the end in 12 pairs, fewer in 3, and the same number in 9.
The end result differs by a few points. The larger difference is at the first stop, and the next
section explains it.

Ten of the 24 Posthorse sessions and 9 of the 24 stock sessions finished within two hours.

The networkx rows need the second grade. Commit0's test command for networkx names the package
twice, so every test runs twice in one process and the report keeps the second result. In two
stock sessions a failing test left state behind in the first pass, and most tests then failed in
the second pass. The same trees pass 4,709 and 4,905 of 5,436 tests when each test runs once, not
1,737 and 1,765. All three stock agents had switched their own test runs to one pass before their
first compaction, so they never saw the second-pass failures. The gap in the official grade says
nothing about context handling. Both grades are reported. The official one is the grade of record.

| Library            | Finished, of 3 | First stop     | End            |
| ------------------ | -------------- | -------------- | -------------- |
| jinja              | 3 \| 3         | 99.8% \| 100%  | 100% \| 100%   |
| tornado            | 3 \| 3         | 100% \| 100%   | 100% \| 100%   |
| prompt-toolkit     | 3 \| 2         | 100% \| 99.3%  | 100% \| 99.3%  |
| pydantic           | 0 \| 2         | 95.4% \| 99.9% | 97.9% \| 99.9% |
| networkx           | 0 \| 0         | 47.3% \| 87.1% | 47.3% \| 87.1% |
| networkx, one pass |                | 87.1% \| 89.8% | 87.1% \| 89.8% |
| dulwich            | 0 \| 0         | 42.6% \| 79.8% | 72.5% \| 79.8% |
| pylint             | 0 \| 0         | 40.4% \| 61.3% | 61.8% \| 61.3% |
| sphinx             | 0 \| 0         | 17.7% \| 47.1% | 44.5% \| 54.7% |

Each cell is stock, then Posthorse, as the mean of three sessions.

### Stock sessions ended their turn with work left more often

The first message says when the work is done: when the whole suite passes, or when the agent can
state for each remaining failure why it cannot be fixed. The agent ended its turn with failing
tests in 10 of the 24 stock sessions, 26 times in all. In the Posthorse sessions the agent did so
in 4 of 24 sessions, 13 times in all. After each of these stops the harness sent `Continue.`.

Two labellers read the last message of each of these stops, on all three sides, without knowing
the side or the session. They agreed on 66 of 67 messages.

| What the last message says                         | stock                  | Posthorse             |
| -------------------------------------------------- | ---------------------- | --------------------- |
| Work is left                                       | 14 stops in 8 sessions | 1 stop in 1 session   |
| Each remaining failure is documented, without more | 7 stops in 3 sessions  | 3 stops in 2 sessions |
| The remaining failures cannot be fixed             | 5 stops in 2 sessions  | 9 stops in 3 sessions |

Every stop in the last row is a dulwich session, and so is every Posthorse stop in the second row.
A rule of the first message is ambiguous for dulwich, as [Limits](#limits) explains. In the other
seven libraries the stock agent ended its turn with failing tests 16 times in 7 of 21 sessions.
The Posthorse agent did so once, in 1 of 21 sessions.

A typical stock message of the first kind, 21 minutes into a sphinx session with 256 of 2,187 tests
passing: "Remaining failures still require implementation; I cannot honestly classify them as
unfixable." That stop is the only one on either side that came before the session's first
boundary.

| Times the agent ended its turn unfinished | stock                  | Posthorse              |
| ----------------------------------------- | ---------------------- | ---------------------- |
| Before the first boundary                 | 1 in 7.3 hours of work | 0 in 7.5 hours of work |
| After the first boundary                  | 25 in 28.3 hours       | 13 in 28.5 hours       |

Twelve of the 13 Posthorse stops are dulwich. The later hours of a session also hold its harder
tests, so the table does not show that a boundary causes a stop. The stops do not cluster after
a boundary: the stock stops came between 0.2 and 23 minutes after the last one.

### A summary that weakened the end condition was followed by stops that met the weaker one

Seven stock stops say only that every remaining failure is documented. They are in three
sessions. In each of the three, the first summary had rewritten the end condition of the first
message.

| How the first summary states the end condition    | Stock sessions | With a "documented" stop |
| ------------------------------------------------- | -------------: | ------------------------ |
| In full: the remaining failures must be unfixable |             16 | 0                        |
| Weaker: each remaining failure has an explanation |              5 | 3 sessions, 7 stops      |
| Only: until the tests pass                        |              3 | 0                        |

The first message says "state for each remaining failure why it cannot be fixed". The weaker
summaries say, for example, "until all tests pass or each remaining failure has an explanation".
A list of the failures meets that wording. The third summary of one sphinx session says so: "The
latter stopping condition has now been reached." That session passed 455 of 2,187 tests at its
next stop and 792 at its end.

Three sessions are a small base. The other two sessions with a weaker summary did not stop this
way.

### The paragraph alone changed what the stops say, not how many sessions stopped

The third side is stock Pi with the one paragraph in its system prompt.

|                                                         | stock    | stock + paragraph | Posthorse |
| ------------------------------------------------------- | -------- | ----------------- | --------- |
| Sessions where the agent ended its turn unfinished      | 10 of 24 | 8 of 24           | 4 of 24   |
| The same, without dulwich                               | 7 of 21  | 5 of 21           | 1 of 21   |
| Stops that say work is left                             | 14       | 1                 | 1         |
| Stops that say each failure is documented, without more | 7        | 12                | 3         |
| Stops that say the failures cannot be fixed             | 5        | 7                 | 9         |
| Sessions that finished                                  | 9        | 8                 | 10        |
| Tests passing at the first stop                         | 67.9%    | 71.7%             | 84.3%     |
| The same, networkx one pass                             | 72.9%    | 75.3%             | 84.6%     |
| Tests passing at the end                                | 78.0%    | 76.2%             | 85.3%     |
| The same, networkx one pass                             | 83.0%    | 79.8%             | 85.6%     |
| Seconds blocked at boundaries per session               | 196.3    | 196.8             | 0.1       |

With the paragraph the agent said once that work was left, against 14 times on the stock side.
It said 12 times that every failure was documented. The number of sessions with an unfinished
stop changed little. Six of the 7 stops in the "cannot be fixed" row are dulwich. The seventh is
a sphinx session with 357 of 2,187 tests passing: "most are blocked by missing application/build
infrastructure". That session later reached 928.

Ten of those 12 stops are in three sessions whose first summary had weakened the end condition,
as on the stock side.

| How the first summary states the end condition    | Third-side sessions | With a "documented" stop      |
| ------------------------------------------------- | ------------------: | ----------------------------- |
| In full: the remaining failures must be unfixable |                  17 | 2 sessions, 2 stops (dulwich) |
| Weaker: each remaining failure has an explanation |                   6 | 3 sessions, 10 stops          |
| Only: until the tests pass                        |                   1 | 0                             |

One of the three is a pylint session. Its first summary says "until all tests pass or every
remaining failure has an explanation". 12.8 minutes after that compaction, with 478 of 1,868 tests
passing, the agent ended its turn: "Every remaining failure/error is documented in
`scratch/remaining-failures.md`." It did the same after each `Continue.` and ended at 780 tests.

In the official grade the third side passed 3.8 points more tests than the stock side at the
first stop (95% interval -7.4 to +14.1) and 1.8 points fewer at the end (-9.4 to +4.6). The
Posthorse side passed 12.6 points more than the third side at the first stop (+4.5 to +21.5) and
9.1 points more at the end (+1.8 to +17.9).

Two things that are not context handling widen the gap between the third side and Posthorse:

- **The networkx grade.** One third-side networkx session counts zero in the official grade,
  because the doubled suite ran past the 15-minute limit. In one pass that tree passes 4,354 of
  5,436 tests. With networkx graded in one pass, the Posthorse side is 9.3 points above the third
  side at the first stop (+2.7 to +17.7) and 5.8 points above it at the end (+1.2 to +12.5).
- **One session cut in the middle of an edit.** The two-hour limit ended one third-side pydantic
  session while 14 files had uncommitted changes. That tree passed 1,242 of 5,091 tests. The
  agent's last commit, nine minutes earlier, reported 5,041. The session never ended a turn.
  Measured against that count, it lowers the third side by 3.1 points at the first stop and at
  the end.

With both taken into account, the three sides end within about 3 points of each other.

On sol the paragraph changed the wording of the stops and little else that this comparison can
measure. On both sides with stock compaction the stops follow what the summaries say. A Posthorse
record carries the first message word for word, so every window holds the end condition as it was
written.

### Where both sides finished, Posthorse finished sooner

Eight pairs finished on both sides: three jinja pairs, three tornado pairs, and two
prompt-toolkit pairs.

|                   | stock, mean | Posthorse, mean | Posthorse lower in |
| ----------------- | ----------: | --------------: | ------------------ |
| Minutes to finish |        43.6 |            35.6 | 7 of 8 pairs       |
| List-price cost   |    2.90 USD |        2.34 USD | 7 of 8 pairs       |
| Output tokens     |      71,017 |          57,284 | 7 of 8 pairs       |

Over all 24 pairs the time per session is the same, 87.1 minutes for stock and 88.4 for Posthorse.
Most sessions on the five large libraries ran into the two-hour limit on both sides.

### Stock compaction blocked each session for 3.3 minutes, and cost was the same

| Per session                                |    stock | Posthorse |
| ------------------------------------------ | -------: | --------: |
| Context boundaries                         |      3.9 |       4.1 |
| Seconds blocked at boundaries              |    196.3 |       0.1 |
| Replies                                    |      496 |       513 |
| Output tokens                              |  121,472 |   120,954 |
| Input tokens that were not read from cache |  542,334 |   535,521 |
| Input tokens that were read from cache     |    30.5M |     31.7M |
| List-price cost                            | 5.77 USD |  5.46 USD |
| Cost of the summary requests               | 0.51 USD |  0.00 USD |
| Replies that only update the task note     |      0.0 |       9.3 |

A stock compaction blocked the session for a median of 52 seconds. The wait grows through a
session: the first compaction took 27 seconds on average and the sixth took 70. The summary
request read 53,499 tokens and wrote 2,374 on average.

The note-only replies are 4.2% of the cost of a Posthorse session. They cost about as much as
the summary requests that the stock side makes.

After a boundary the context holds 25,977 tokens on the stock side and 23,717 on the Posthorse
side, at the median.

### Where the summaries dropped a rule, the agent tried to break it

Rule 2 says: "Write the implementation yourself. Do not install the library or copy its code from
anywhere."

The stock side wrote 93 summaries in the 24 sessions that count. 88 of them state rule 2. The
five that do not are all from one sphinx session, where no summary states it. One more stock
session, a pylint session, also had no summary that states it.

Those two sessions are the only two of the 48 planned sessions in which the agent tried to get
a finished copy of the library. The third side added a third case of the same kind:

- The pylint agent searched the disk 68 seconds after its first compaction. It found a finished
  pylint in a build directory that the Commit0 image had left in the workspace, and copied 177
  files. That session does not count, and its repeat ran without the build directory.
- The sphinx agent tried three times to download Sphinx from the package index, starting 2.6
  minutes after its second compaction, and then searched the container for a copy. The sandbox
  has no network access and the container held no copy, so the session counts.
- On the third side, 87 of 93 summaries state rule 2. The six that do not are all the summaries
  of one sphinx session. That agent searched the container for a copy of Sphinx 32 seconds after
  its first compaction, and searched again for a Sphinx package file eight minutes later. It
  found none, so the session counts. No other session of the third side tried.

No Posthorse session tried. A Posthorse recovery record carries the first message word for word.
Five of the 99 records lacked it because of the defect described under
[What went wrong during the runs](#what-went-wrong-during-the-runs), and the agent's own note held
the rules in those sessions.

Three sessions are a small base. In all three the summaries had lost the rule. In the other 70
sol sessions that count, the agent did not try. The result fits what a summary is: a rewrite of
the first message by a model, which can lose a line.

### The planted duty shows no difference

Rule 3 asks for a commit after every run of the whole test suite.

| Whole-suite runs followed by a commit | stock            | Posthorse        |
| ------------------------------------- | ---------------- | ---------------- |
| Before the first boundary             | 68% (58 of 116)  | 59% (53 of 167)  |
| After one or more boundaries          | 91% (146 of 161) | 88% (140 of 166) |
| After three or more boundaries        | 93% (63 of 67)   | 87% (74 of 87)   |

Each percentage is the mean of the per-session shares, and the counts are totals over all
sessions. Both sides kept the duty better after a boundary than before it, and neither side lost
it. The third side kept it after 88% of the runs that followed a boundary (129 of 140). Every
commit message has the required form. No session changed a test file.

### Both sides read files again after a boundary

In the 10 replies after a boundary, the stock agent read 2.88 files that the session had already
read or written, and the Posthorse agent read 2.64. In the 10 replies before a boundary the
numbers are 2.25 and 1.62. A boundary costs both sides about one extra read of a known file.

## Results for gpt-6.1-terra

`gpt-6.1-terra` is the smaller model. It ended its turn within minutes on both sides: after 4.3
minutes on the stock side and after 6.3 minutes on the Posthorse side, with 1% and 2% of the tests
passing. Every one of the 48 sessions needed a `Continue.`. Both labellers read all 155 messages
of these stops as "work is left".

### After a boundary, stock sessions stopped and Posthorse sessions worked on

|                                                             | stock    | Posthorse |
| ----------------------------------------------------------- | -------- | --------- |
| Sessions that ended after the third `Continue.`, unfinished | 24 of 24 | 6 of 24   |
| Sessions that worked to the two-hour limit                  | 0        | 13        |
| Sessions that finished                                      | 0        | 5         |
| Minutes of work per session                                 | 31.1     | 86.5      |
| Tests passing at the end                                    | 23.2%    | 58.2%     |

The difference in tests passing at the end is 35.0 points (95% interval +22.3 to +50.5). The
Posthorse session passed more tests in 23 of the 24 pairs.

Before the first boundary, the agent ended its turn often on both sides: 7.2 times per hour of
work on the stock side and 3.8 times on the Posthorse side. After the first boundary the rates are
11.8 and 0.15.

| Times the agent ended its turn unfinished | stock                    | Posthorse                |
| ----------------------------------------- | ------------------------ | ------------------------ |
| Before the first boundary                 | 81 in 11.2 hours of work | 56 in 14.7 hours of work |
| After the first boundary                  | 15 in 1.3 hours          | 3 in 20.0 hours          |

Ten stock sessions reached a compaction. In nine of them the agent ended its turn 0.5 to 5.4
minutes after its first compaction. In the tenth it ended its turn 1.1 minutes after its second.
One dulwich agent wrote, 1.3 minutes and 6 replies after its compaction, with 270 of 1,522 tests
passing: "The implementation remains incomplete; the remaining failures have not been
individually assessed for fixability."

Nineteen Posthorse sessions reached a rollover. In 17 of them the agent did not end its turn
unfinished again: 12 worked to the time limit and 5 finished.

The 5 Posthorse sessions that never reached a rollover ended as the stock sessions did. They
stopped four times in 27 minutes and passed 10% of the tests. The 14 stock sessions that never
reached a compaction stopped four times in 24 minutes and also passed 10%.

### The paragraph alone did not keep terra working

The third side is stock Pi with the one paragraph in its system prompt. Its sessions ended as the
stock sessions did.

|                                                             | stock           | stock + paragraph | Posthorse       |
| ----------------------------------------------------------- | --------------- | ----------------- | --------------- |
| Sessions that ended after the third `Continue.`, unfinished | 24 of 24        | 22 of 24          | 6 of 24         |
| Sessions that finished                                      | 0               | 2                 | 5               |
| Times the agent ended its turn unfinished                   | 96              | 92                | 59              |
| The same, after the first boundary                          | 15 in 1.3 hours | 12 in 2.7 hours   | 3 in 20.0 hours |
| Minutes of work per session                                 | 31.1            | 23.5              | 86.5            |
| Tests passing at the end                                    | 23.2%           | 32.4%             | 58.2%           |

Eleven sessions of the third side reached a compaction. In 10 of them the agent ended its turn
unfinished 0.5 to 7.4 minutes after a compaction, and one of the 10 finished later. The eleventh
finished without another stop. The paragraph also did not delay the first stop: it came after 2.7
minutes. Both labellers read all 92 stop messages of this side as "work is left".

The third side passed 9.2 points more tests than the stock side (95% interval -0.9 to +25.3), most
of it in jinja. The Posthorse side passed 25.8 points more than the third side (+16.6 to +37.9).
On terra the difference between stock and Posthorse does not come from the paragraph. It comes
from the rest of Posthorse: the rollover, the task note, and the recovery record. This comparison
cannot say which of the three.

### The difference in tests is a difference in work time

A session ends when the agent has ended its turn unfinished four times. The stock sessions
reached that point after 31 minutes on average. More `Continue.` messages would have let them
pass more tests. The table shows how far each side gets with at most three nudges. It does not
show that one side writes better code per hour.

| Library        | Finished, of 3 | End            | Minutes of work |
| -------------- | -------------- | -------------- | --------------- |
| jinja          | 0 \| 3         | 24.2% \| 100%  | 37.4 \| 75.4    |
| tornado        | 0 \| 0         | 34.0% \| 97.2% | 27.9 \| 120.0   |
| prompt-toolkit | 0 \| 2         | 73.3% \| 95.6% | 50.8 \| 73.9    |
| dulwich        | 0 \| 0         | 17.3% \| 48.9% | 29.9 \| 98.0    |
| pydantic       | 0 \| 0         | 11.0% \| 35.7% | 20.9 \| 54.9    |
| pylint         | 0 \| 0         | 9.1% \| 35.0%  | 32.8 \| 85.2    |
| networkx       | 0 \| 0         | 11.0% \| 33.6% | 17.5 \| 88.6    |
| sphinx         | 0 \| 0         | 5.5% \| 19.7%  | 31.8 \| 96.1    |

Each cell is stock, then Posthorse, as the mean of three sessions. With each networkx test run
once, the networkx row is 13.1% and 42.3%, and the difference over all libraries is 35.8 points
(+23.4 to +51.0).

A Posthorse session cost 2.32 USD at list price and a stock session 0.66 USD. Per hour of work
that is 1.61 USD and 1.27 USD.

### The other measures on terra

- **Wait.** The 11 stock compactions blocked their sessions for a median of 31 seconds each.
- **Rule 2.** All 11 stock summaries and all 17 third-side summaries state it. 64 of the 70
  Posthorse records carry the first message. The other 6 lack it because of the defect in 0.10.17.
  No terra session tried to get a finished copy of the library.
- **Rule 3.** After a boundary a commit followed 85% of the runs of the whole suite on the stock
  side (16 of 20) and 79% on the Posthorse side (127 of 159). The stock base is small.
- **End condition.** All 21 first summaries, 10 on the stock side and 11 on the third side, state
  the full end condition. No terra stop claims that the failures are documented. On terra the
  summaries kept the rules, and the agent still ended its turn soon after a compaction.

## What went wrong during the runs

Every item is in the per-run data. No rerun hides one.

- **Two stock sessions do not count and were repeated.** One sphinx session ended 18 minutes
  early when the harness failed to read a file the agent had written. One pylint session copied
  a finished pylint from a build directory that the Commit0 image had left in the workspace. The
  copy broke rule 2, so that session is reported under
  [Where the summaries dropped a rule](#where-the-summaries-dropped-a-rule-the-agent-tried-to-break-it).
  Both repeats ran under the same settings, after the build directory was removed. The repeats
  ran three hours after the other sol sessions.
- **The harness graded networkx as zero during the sol sessions.** The networkx tests live inside
  the package, and the harness left the whole package out of the tree that it graded. The agents'
  own test runs were not affected. No networkx session ended its turn before the time limit, so
  the wrong grade changed no `Continue.`. The saved trees were graded again.
- **A second finished copy was readable and unused.** The jinja, pydantic, and pylint containers
  held the finished library in an installer cache. A check of every tool call found no session
  that read it. Later sessions run without the cache, and the harness now refuses to start when a
  copy of the library is readable.
- **Test containers got a memory limit during the runs.** A half-built prompt-toolkit ran one test
  up to 34 GB in a stock session that had already ended its turn. That process was ended by hand,
  and the same command ended one small test run of a Posthorse session, which ran it again. From
  then on every test container was limited to 8 GB on all sides. In the sol sessions the limit
  ended one test process in each of two stock sessions and one third-side session.
- **Memory ran short again at the start of the terra sessions.** In all nine terra jinja sessions
  a test process of the half-built library grew to the memory limit. Sixteen minutes into the
  stock and Posthorse sessions the limit went down to 4 GB for every container. The kernel ended
  the test process in six jinja sessions. In the other three, one stock and two Posthorse, the
  whole test container stopped, and each agent started it again. The limit also ended one test
  process in a Posthorse tornado session. The 4 GB limit stayed for every later session, which
  includes the third side on both models.
- **One Posthorse session waited 100 minutes for one test command.** A prompt-toolkit agent
  started a test file with a timeout of 200,000 seconds, and the half-built library never
  returned. The session ended at the time limit with 148 of 151 tests. It is the reason for the
  prompt-toolkit row of the Posthorse side.
- **The agent's shell can reach Docker.** `bin/envrun` runs the tests through Docker, so the agent
  can call Docker too. Eleven sessions did: 4 stock, 1 on the third side, and 6 Posthorse. They
  listed containers or test processes, ended a test process, copied a file in or out, or started
  the stopped container again in the three jinja sessions above. One Posthorse tornado agent,
  after its session had finished, checked as root in its container whether a kernel setting was
  writable. It was not, and the agent changed nothing. No session created a container or acted on
  the container of another session.
- **The harness sent `Continue.` to sessions that had finished.** The harness compared the number
  of passing tests with the number of tests. One tornado test skips itself in the sandbox, and one
  prompt-toolkit test is an expected failure. Sixteen finished sessions on the three sides
  therefore got up to three `Continue.` messages. Time, tokens, and cost count up to the finished
  stop.
- **The time limit can cut a session in the middle of an edit.** The tree at that moment can pass
  fewer tests than the agent's last commit reported. In three sessions the difference is more
  than 5% of the tests: a third-side pydantic session on sol (1,242 graded, 5,041 reported), a
  Posthorse pylint session on sol (937 and 1,150), and a Posthorse pydantic session on terra
  (4,135 and 4,523). The check leaves out networkx, where the agents' own counts hold every test
  twice. The graded tree is the result of record in every case.
- **The 5-minute grades are not reported.** The posted method lists tests passing every 5 minutes.
  The harness saved the tree every 5 minutes, 1,879 trees in the 144 sessions. Grading them
  stopped when the testing ended: 196 trees are graded, all on the sol stock and Posthorse sides.
  This report uses the grades at the stops, which are complete. The trees are kept.
- **The number of sessions running at once changed.** The sol sessions started 12 at a time and
  ended 36 at a time. Each wave held both sides, so the load was the same for a library's stock
  and Posthorse sessions that started together.
- **Posthorse 0.10.17 had a defect that these runs exposed.** After a short follow-up message such
  as `Continue.`, later recovery records no longer held the first message. Five of the 99 records
  in two sessions lacked it. Release 0.10.19 fixes the defect. The runs were not repeated.
- **The provider was overloaded during the terra sessions.** 146 requests failed with "Our servers
  are currently overloaded". Pi retried them, and 5 turns still ended on such an error. In 3
  sessions the error used up one of the three `Continue.` messages and the session ended one turn
  early. Those 3 sessions, two stock and one Posthorse, do not count and were repeated. Two
  Posthorse sessions lost a `Continue.` to an error and still ran to the time limit or finished.
  They count.

## Limits

- **One benchmark family.** All tasks are Commit0 libraries. They are popular libraries that the
  models have seen in training, and the work is one kind: write code until tests pass.
- **A forced window.** The window was set to 128,000 tokens so that boundaries occur. The models'
  real window is 500,000 tokens. Sessions on the real window cross fewer boundaries per hour.
- **Print mode.** Each session is `pi -p` with no person present. The `Continue.` messages are
  fixed and say nothing about the work.
- **Three sessions per library and side.** The intervals are wide. A difference of a few points
  in tests passing is inside the noise.
- **Two models from one provider.** Both are OpenAI models at one thinking level. The
  [field study](field-study.md) found that models differ in how they use the notes.
- **Stock Pi at its defaults.** The stock side uses Pi's default compaction settings and summary
  prompt. Other settings or a custom summary prompt can behave differently.
- **An ambiguous rule for dulwich.** Dulwich keeps two helper modules for its tests inside the
  package, `dulwich/tests/utils.py` and `dulwich/tests/test_object_store.py`, and Commit0 removes
  their bodies too. Rule 1 forbids changes to test files. Three sessions, one stock and two
  Posthorse, left the helpers empty, stopped near 1,100 of 1,522 tests, and stated that the rest
  cannot be fixed under the rules. Two sessions, one on each side, implemented the helpers and
  reached 1,450 and 1,437 tests. The sixth, a stock session, stopped four times with work left
  and ended at 757. In dulwich the stops show how the agent read rule 1, not how it handled
  context.
- **The third side was added after the first results.** It ran later than the other two sides,
  partly beside sessions of a separate test that this report does not cover. Compare its stops
  and tests, not its minutes.

## How the measures are defined

- A _stop_ is the end of one Pi invocation: the agent ended its turn, the provider returned an
  error that Pi's retries did not clear, or the session reached its time limit.
- A stop is _finished_ when no test that the finished library passes fails, errors, or is missing
  in the graded tree. Skipped tests and expected failures do not count against it. Two libraries
  need this rule: one prompt-toolkit test is an expected failure that passes in the finished
  library, and one tornado test skips itself in the sandbox.
- The agent _quit unfinished_ at a stop when it ended its turn, the stop is not finished, and the
  provider returned no error.
- _Tests passing_ is the share of the tests that the finished library passes. Each library
  counts the same in an average, so networkx with 5,436 tests weighs as much as prompt-toolkit
  with 151.
- _Time_ is agent time: the Pi invocations of a session, without the grading between them. For a
  session that finished, time, tokens, and cost count up to the finished stop.
- _Cost_ is the list price that Pi records for every request, including the stock summary
  requests. The sessions ran on a subscription login, so no session was billed at that price.
- A _boundary_ is a `compaction` entry in the session journal. A Posthorse boundary carries
  `details.posthorse`.
- _Seconds blocked_ at a boundary is the time between the journal entry before the boundary and
  the boundary entry. The stock summary request runs in that time.
- A pair is the stock session and the Posthorse session of the same library and repetition. The
  third side is paired with each of the two in the same way. Intervals are 95% bootstrap
  intervals over libraries.
