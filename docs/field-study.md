# Field study: Posthorse in daily use, November 2026

This study measures what agents did around 24,940 context boundaries in one person's Pi sessions.
It answers three questions. Do agents use the notes, the history tool, and the recovery record as
intended? What happens to the work after a rollover? What does a rollover cost compared with stock
Pi compaction?

The study is observational. It is not a controlled comparison on matched tasks, and it does not
measure whether the work after a rollover was correct. [Limits](#limits) lists what the numbers
cannot show. The [controlled comparison](controlled-comparison.md) runs matched tasks on both
designs.

## What the study covers

The data is the maintainer's own Pi session journals from five machines, from February 20 to
November 10, 2026. The scan read 82,491 journals (156.5 GB). 6,071 of them contain a context
boundary. A forked session copies its parent's entries, so each boundary is counted once, by
entry ID and timestamp.

The work is software engineering, operations, and research. Half of the Posthorse boundaries are
in subagent sessions.

Posthorse changed during this period, so the journals hold four designs:

| Design                                                                                | Versions    | Dates          | Boundaries |
| ------------------------------------------------------------------------------------- | ----------- | -------------- | ---------: |
| Stock Pi compaction: a model-written summary plus a recent tail                       | none        | Feb 20 – Nov 1 |      6,894 |
| Agent handoff: the reminder told the agent to save state and call `new_context`       | 0.1 – 0.9   | Sep 1 – Nov 9  |     11,016 |
| Automatic rollover with a retained tail; the record came first and did not name notes | 0.10.0 – .1 | Oct 21 – Nov 1 |      4,992 |
| Automatic rollover; the record follows the tail and says which note to read (current) | 0.10.2+     | Nov 1 – Nov 10 |      1,658 |

A further 380 automatic rollovers from the handoff period do not fit a row. In those, the agent
did not hand off before the limit, and Posthorse reset the context without a retained tail.

98.6% of the stock compactions happened before September. `new_context` is optional since 0.10.0,
and 21 of the 11,016 handoffs happened after October 21. The 1,658 current-design rollovers come
from 274 sessions.

Each design is identified from the text of its reminder and its recovery record, not from dates.

## Results

### A rollover does not block the session

Stock compaction waits for a model to write the summary. Posthorse writes its record from the
journal.

| Boundary                              |     n | Median wait | 90th percentile | Over 10 s |
| ------------------------------------- | ----: | ----------: | --------------: | --------: |
| Stock compaction during a tool loop   | 2,361 |      59.7 s |         160.0 s |     91.7% |
| Posthorse automatic rollover, 0.10.2+ | 1,658 |     < 0.1 s |           0.1 s |      0.2% |

The wait is the time between the last journal entry before the boundary and the boundary entry.
The stock row counts only compactions that landed while the agent was running tools, so idle time
before a manual `/compact` is excluded. The mean stock wait was 93 seconds, 61 hours in total. The
wait grew with context size: a median of 50 seconds at 150,000 to 250,000 tokens, and 91 seconds
above 300,000.

### Agents read the note when the record names it

Until 0.10.2 the recovery record came before the retained tail and did not mention task notes.
Since 0.10.2 the record follows the tail, lists each note the session touched, and says which one
to read. Both changes shipped in one release, so this data cannot separate their effects.

| Model              | Record did not name notes: read a note within 3 replies | Record says "read this note": read in the first reply | Within 3 replies |
| ------------------ | ------------------------------------------------------: | ----------------------------------------------------: | ---------------: |
| `gpt-6.1-sol`      |                                       66.5% (n = 2,322) |                                       97.7% (n = 660) |            99.4% |
| `gpt-6-astra`      |                                         81.6% (n = 282) |                                       94.7% (n = 418) |            96.4% |
| `claude-opus-5-5`  |                                          9.8% (n = 717) |                                       96.1% (n = 233) |            97.0% |
| `gpt-6.1-terra`    |                                       23.0% (n = 1,612) |                                        96.4% (n = 28) |           100.0% |
| `gemini-4-argon`   |                                                 no data |                                        95.9% (n = 49) |            98.0% |
| `claude-fable-5-2` |                                                 no data |                                        95.8% (n = 24) |            95.8% |
| Other models       |                                                 no data |                                        95.2% (n = 63) |            96.8% |
| All models         |                                       44.6% (n = 4,972) |                                     96.4% (n = 1,475) |            98.0% |

After 0.10.2 the gap between models closed.

Two smaller groups behave differently. When the record says that the latest full note write is
still visible in the retained tail, 44% of agents read the note again anyway (n = 126). When the
session has no note at all, there is nothing to read: 17% of those agents opened any note within
10 replies (n = 36).

One third of agents (32.7%) also used `history` within 10 replies of a rollover.

### Agents update the note when reminded, and the tail covers most of the rest

The reminder reached 99.3% of current-design windows before the rollover. After it:

- 58.8% of agents updated a note in the next reply.
- 75.1% updated a note within 3 replies.
- 84.4% updated a note before the rollover. The reminder asks for an update only if the note is
  stale.

The retained tail holds a median of 7 replies. The work at risk is the work after the last note
write and before the tail, because only `history` still holds it. That gap had a median of 0
replies and a 90th percentile of 6. It was longer than 10 replies in 4.8% of rollovers.

7.5% of windows had no note write. In 2.2% of rollovers the session had no note at all
([#151](https://github.com/fitchmultz/pi-posthorse/issues/151)).

### After a rollover, agents keep working

A rollover could make an agent wrap up early. The data does not show that. After a rollover during
a tool loop, 1.2% of agents ended their turn within 3 replies and 6.4% within 10 (n = 1,620). The
usual rate of turn-ending replies in the same sessions predicts 5.4% and 17.0%.

`gemini-4-argon` is an exception: 10 of 52 agents ended their turn within 3 replies. The sample is
small.

Owner messages are a second signal. The maintainer sent a message within 10 replies of 56 out of
985 rollovers in top-level sessions. All 56 were read for this study. None reported forgotten
context or repeated work. Four told an agent to continue after it had stopped.

### Repeated work stays near the baseline of the same session

This measure compares the tool calls in the 15 replies after a boundary with the calls in the 30
replies before it. The control is the same measure at a point 45 replies before the boundary, in
the same session, where no boundary occurred. Posthorse's own tools are excluded, because reading
the note again is intended.

| Design                   |     n | Identical calls: after | Control | File re-reads: after | Control |
| ------------------------ | ----: | ---------------------: | ------: | -------------------: | ------: |
| Automatic, 0.10.2+       |   836 |                   1.1% |    1.5% |                 9.0% |    6.8% |
| Automatic, 0.10.0 – .1   | 2,443 |                   1.0% |    1.6% |                 7.8% |    6.9% |
| Agent handoff, 0.8 – 0.9 | 3,694 |                   1.9% |    1.2% |                14.8% |    9.9% |
| Agent handoff, 0.1 – 0.7 | 2,588 |                   2.4% |    1.8% |                11.7% |    6.2% |
| Stock compaction         | 4,668 |                   3.0% |    5.0% |                15.4% |   21.1% |

An identical call has the same tool and the same arguments as a call in the 30 replies before.
File re-reads are the share of `read` calls whose path was read in the 30 replies before. The
current design adds about 2 points of re-reads. The handoff designs, which kept no tail, added 5
points.

A repeated state-changing call is the dangerous case: an identical commit, push, pull request
edit, or patch issued again after the boundary. That happened after 5 of 17,851 Posthorse
boundaries, none of them on 0.10.2 or later, and after 46 of 6,344 stock compactions.

### What a rollover costs

Notes cost output tokens. In current-design windows, replies that only update notes are 4.5% of
all replies, 9.1% of output tokens, and 7.0% of the cost that Pi estimates from token prices. The
median window cost $6.47 by that estimate, of which $0.22 went to those replies.

The first request after a current-design rollover carried a median of 55,000 tokens, against
82,000 after a stock compaction. The recovery record had a median length of 4,519 characters. The
stock summary had a median of 18,853.

A stock compaction makes one more model request, to write the summary. Pi has recorded the usage
of that request since July 2026, for 3,868 of the 6,894 stock compactions here. The request read a
median of 81,000 tokens and wrote a median of 5,800. By Pi's estimate it cost a median of $0.27
and a mean of $0.44.

The note cost and the summary cost come from different periods and models, so this study does not
subtract one from the other.

### Agents mostly use the tools as described

- `get_context_remaining`: the guidance says that routine checks are not needed. 3.4% of
  current-design windows contain a call.
- `new_context`: 15 calls in November. Automatic rollover has replaced the handoff.
- `history`: 25,819 searches over the whole period. 9% returned nothing. For 94% of those, every
  match was still in the active context, which search skips on purpose.
- Errors in November: 22 of 1,491 `history` calls (1.5%) and 82 of 2,649 `notes` calls (3.1%).

### The data exposed six defects

| Defect                                                                                                                                                 | Effect in the data                                                 | Status                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Near the rollover line, `notes` and `history` could return an error with empty text. Anthropic rejects a request that contains an empty error result.  | 36 empty errors. 4 rejected requests in 3 sessions. 2 ended there. | Fixed in 0.10.14                                                                 |
| When another extension rewrote a retained message, the recovery record could land between a tool call and its results. Anthropic rejects that request. | 5 rejected requests in 2 sessions. 1 session ended there.          | Fixed in 0.10.15                                                                 |
| `notes` failed in forked sessions when the source notes directory was missing.                                                                         | 80 errors in 4 sessions                                            | Fixed in 0.10.13                                                                 |
| The record names a note outside the session's notes directory by its bare name. `notes read` rejects that name.                                        | 12 failed reads in 2 sessions                                      | Fixed in 0.10.17 ([#149](https://github.com/fitchmultz/pi-posthorse/issues/149)) |
| `notes` treats an empty `scope` argument as a real selector.                                                                                           | 10 failed calls                                                    | Fixed in 0.10.17 ([#150](https://github.com/fitchmultz/pi-posthorse/issues/150)) |
| The reminder does not ask for a note when the session has none.                                                                                        | 36 rollovers with no note                                          | Fixed in 0.10.17 ([#151](https://github.com/fitchmultz/pi-posthorse/issues/151)) |

The first two defects are the only cases where a provider rejected a request because of a
rollover. From September to November the journals hold 1.9 million replies. Providers rejected 9
requests within 5 replies of a Posthorse boundary, and all 9 trace to those two defects.

## Limits

- **One user.** The agents run under the maintainer's own instructions, which ask for notes and
  verification. Agents under other instructions can behave differently.
- **The designs are not matched.** Each design ran in a different period, with different models,
  Pi versions, and tasks. The stock rows come mostly from February to August and from older models.
  Read them as context, not as a controlled baseline.
- **Behavior, not correctness.** The study counts what agents did. It does not judge whether a
  task finished correctly or whether a constraint survived the rollover.
- **Short look-back.** The repeated-work measure sees the 30 replies before a boundary. It does
  not count an agent that rebuilds context from earlier in the window.
- **Note detection.** A note is a file under a Posthorse notes directory, or a file that
  Posthorse recorded as a note. A session that keeps its state elsewhere counts as having no note.
- **Small samples.** Several models have fewer than 60 rollovers on the current design.
- **Private data.** The journals contain private work, so the raw data is not published.

## How the measures are defined

- A _boundary_ is a `compaction` entry or a legacy `context_window` entry in a session journal.
  A Posthorse boundary carries `details.posthorse`.
- A _reply_ is one assistant message. "Within 3 replies" counts the first 3 assistant messages
  after the boundary on the same branch.
- A _note read_ or _note write_ is a `notes` call, a file tool call on a notes path, or a
  Posthorse note record written for a nested call.
- A _window_ is the branch from the previous boundary to this one.
- _During a tool loop_ means that the last message before the boundary was a tool result or an
  assistant message that requested a tool.

## The controlled comparison

The [controlled comparison](controlled-comparison.md) runs the same tasks with stock compaction
and with Posthorse. It scores the tests passing, the stops with work left, the rules that
survive a boundary, repeated reads, time, and tokens.
