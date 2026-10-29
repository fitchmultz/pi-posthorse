# Performance

For current-source reserve arithmetic and cache-cost attribution limits, see
[Rollover frequency and cache cost](rollover-cache-cost.md). That investigation changes no runtime
policy and claims no measured speedup or billed saving.

## Active-history search, 2026-10-24

The registered history executor avoids a second text conversion of unrelated active entries.
On a generated 37.2 MB v3 session with 12,290 entries, five alternating process pairs on Linux x64,
Node 24.22.1 and official Pi 1.4.0 produced these tool-executor times:

| Search               | Before median [range], ms | After median [range], ms |
| -------------------- | ------------------------- | ------------------------ |
| No match             | 284.27 [267.56, 331.85]   | 158.57 [153.02, 159.58]  |
| First matching page  | 211.49 [202.93, 217.36]   | 126.12 [117.05, 150.28]  |
| Second matching page | 210.13 [191.87, 232.76]   | 116.77 [109.97, 120.85]  |

Every paired output agreed, including cursors and active-context exclusions. Separate work counts
showed 4,096 rather than 8,192 tool-argument serializations per call. The no-match median live-heap
increase at executor return was 90.6 MB before and 50.4 MB after. This is not total allocation,
peak heap, or retained JS heap inferred from RSS.

Pi still owns edits and compaction. Matching searches still build its native projection; all-session
searches also retain that projection before archive I/O to preserve invocation-time visibility.
Each candidate ID needs text conversion at most once per search. There is no persistent cache. The remaining branch
scan is linear. These synthetic Linux results do not predict performance on private journals,
installed macOS, or provider requests.

[Raw commands, samples, profiles, generated journals, and host API evidence](https://github.com/fitchmultz/pi-posthorse/blob/32230f506403a6b17732e5f9d78fb661523ea17b/.evidence/issue-102-final-measurements.tar.gz)
are retained in PR #104's final evidence commit `32230f5`, separately from the distributed package.
The [original evidence](https://github.com/fitchmultz/pi-posthorse/blob/1ac82580b08b91cbee16113dda44cede9b76687b/.evidence/issue-102-measurements.tar.gz)
remains in PR #104's evidence commit `1ac8258`.

## Notes listing responsiveness, 2026-10-29

Notes `list`, folder reads and `search` used to walk the notes tree with synchronous filesystem
calls, then format every listing row in one step. Pi could not draw or take input until the walk
finished, and cancelling did not stop a listing. The walk now uses Node's asynchronous filesystem
calls, and listings format rows in batches between event-loop turns. Within a folder, up to 64
entries are stat'd together, and a batch ends at the next entry that may be a folder. Entries after
a folder are listed from stats taken after its subtree has been walked, as in the synchronous walk,
so a note or folder removed meanwhile, for example by another session, is skipped instead of
failing the call or appearing as a stale row.

Workload: a generated tree with 212,751 notes, the count of a real notes tree measured earlier.
It has about 100 short notes per folder. Host: Apple M5 Pro (18 cores), macOS 27.0.1 on APFS,
Node 24.22.1, official Pi 1.3.0 SDK, real registered `notes` tool. The host was shared, with load
averages of 27-30 during these runs, so ranges are wide. "Longest pause" is the longest gap
between 1 ms timer ticks during the call; a fully synchronous call is one pause as long as the
call. "CPU" is the process's user plus system time, including Node's filesystem worker threads.

| Call (3 alternating runs each) | Before: total, ms           | Before: CPU, ms             | Before: longest pause | After: total, ms            | After: CPU, ms              | After: longest pause |
| ------------------------------ | --------------------------- | --------------------------- | --------------------- | --------------------------- | --------------------------- | -------------------- |
| `list`, 212,751 notes          | 4,326 median [3,229, 6,126] | 3,145 median [3,029, 3,785] | the whole call        | 2,913 median [2,899, 3,071] | 7,288 median [7,104, 7,335] | 16-18 ms             |
| Folder read, 10,000 notes      | 170 median [137, 193]       | 188 median [159, 209]       | the whole call        | 140 median [85, 145]        | 375 median [199, 380]       | 8-9 ms               |

The gain is responsiveness, and it costs CPU time: in these runs the asynchronous walk used about
twice the CPU of the synchronous walk, 7.1-7.3 s against 3.0-3.8 s for `list`. CPU time also
varied across runs: four `list` runs of the final walk with stat batches of 16, 64 and 256
used 3.5-7.8 s, including 3.6 s and 7.8 s for the two runs with 16. `list` totals were lower after
in all three runs and folder-read totals overlapped, but three runs on a loaded host do not
establish a speedup.

`search` was not re-measured on the final walk. On an earlier revision of this change, with the
same read phase, one unpaired no-match search of this tree took 40,026 ms before and 37,979 ms
after, and its longest pause fell from 3,724 ms to 14 ms. One run each cannot compare search
totals. These searches read tiny notes that never match. The real 212,751-file tree holds 44 GB,
and its recorded failure was a broad search with many matches (commit `9077fe5`), so these timings
do not predict searches there.

Formatting all 212,751 rows in one step paused Pi for 156-163 ms, which is why rows are batched.
Stat batches of 16, 64 and 256 took equal time within noise, in an earlier sweep and in one round
on the final walk.

Output is unchanged: every page of `list`, a folder read and `search` hashed identically before and
after on a 5,000-note tree with timestamp ties, an alias folder, a symlink cycle and a dangling
link. Sampled first, middle and last pages of the 212,751-note listing also matched. Missing
folders still list as empty. A single permission or symlink-loop error is reported as before. When
several entries stat'd in the same batch fail at once, the call may report a different one of those
errors than the synchronous walk, which reported the first in listing order. Cancelling now stops
`list`, folder reads and `search` mid-walk, and stops searches whose notes are all over 1 MiB and
so are never read.

Limits: the tree is synthetic, with small notes and uniform folders, and the new walk was not
measured on a real tree. A separate read-only replay of the old synchronous walk and sort over a
real notes tree, currently 29,210 files, took 1,269 and 1,344 ms; this shows the blocking on real
data but does not measure search. Sorting all entries newest-first remains one synchronous step; a
separate measurement with shuffled timestamps put it at 35-40 ms for 212,751 entries. Folder
candidates come from the entry types that the directory read reports. On a filesystem that reports
unknown entry types, Node's `readdir({ withFileTypes: true })` issues its own `lstat` for every
entry of the folder at once, outside the 64-stat limit, and an entry removed between the directory
read and that `lstat` fails the call with `ENOENT` instead of being skipped (Node 24.22.1
`lib/internal/fs/promises.js:137,1658-1681` and `lib/internal/fs/utils.js:245-277`). The APFS volume
measured here reported a type for every entry.

## Historical optimization pass

Baselines and results from the 0.9.2 optimization pass. Measured on an Apple M5 Pro (18 cores)
with Node 24.21.0 and Pi 1.1.0, against real session archives. Times are medians.

## Unchanged hot paths

These were measured and left alone, because Posthorse's share is already small.

| Path                               | Cost                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------ |
| Turn and context hooks             | 25–50 µs from Posthorse; Pi's own context-usage read is 2.3 ms at 112 MB |
| Extension load                     | 15–19 ms, against 3 ms for Pi without it                                 |
| Automatic handoff, compaction hook | 0.5 ms, 5.4 ms on a 112 MB session                                       |
| Current-branch `history` search    | 6–9 ms; 43–46 ms when a query matches nothing in a 112 MB session        |
| Current-branch `history read`      | 0.6–1.1 ms                                                               |
| `notes` operations                 | 0.2–0.8 ms; across 500 notes (14 MB), list 2 ms and search 3–16 ms       |

## All-session history search

| Archive               | Query                  | Before   | After    |
| --------------------- | ---------------------- | -------- | -------- |
| 1.7 GB, 917 files     | `posthorse`            | 188 ms   | 92 ms    |
|                       | `the`                  | 174 ms   | 86 ms    |
|                       | `context`              | 131 ms   | 74 ms    |
|                       | `createAgentSession(`  | 460 ms   | 176 ms   |
|                       | `zzqx: no such text`   | 5,777 ms | 128 ms   |
|                       | missing bare ID (read) | 225 ms   | 176 ms   |
| 18.5 GB, 12,214 files | `posthorse`            | 3,900 ms | 794 ms   |
|                       | `kitty`                | 9,454 ms | 3,462 ms |
|                       | `deploy`               | 1,799 ms | 629 ms   |
|                       | `status: done`         | 20.6 s   | 14.3 s   |
|                       | `zzqx-no-such-text`    | 1,839 ms | 1,108 ms |
|                       | missing bare ID (read) | 2,405 ms | 2,010 ms |

The first pages of these and other queries, including label, image, quote and punctuation
queries, returned the same text before and after. The exception is `İ`: the old ripgrep
prefilter skipped files containing it, and the new results match an unfiltered scan.

Searches that stop early in a small archive now pay one ripgrep start: common queries in a
153 MB archive take 25–38 ms instead of 21–42 ms.

## Card rendering

Collapsed cards wrap only the rows they show. Per card:

| Card                      | Event        | Before  | After   |
| ------------------------- | ------------ | ------- | ------- |
| `history read`, 40K chars | resize       | 0.79 ms | 0.13 ms |
|                           | theme change | 0.91 ms | 0.20 ms |
| `notes read`, 60K chars   | resize       | 2.20 ms | 0.13 ms |
|                           | theme change | 2.36 ms | 0.18 ms |

Ordinary frames reuse cached rows and stay near 0.01 ms.

## Development and CI

| Check                   | Before    | After                                   |
| ----------------------- | --------- | --------------------------------------- |
| `npm run verify`, local | 32.8 s    | 12.9 s                                  |
| `npm test`, local       | 25.3 s    | 8.7 s                                   |
| Pull-request CI         | 17–19 min | 2 min with cached checkers; 11 min cold |

Lint probes and test files now run concurrently. CI caches the patched native checkers by their
exact inputs and qualifies official Pi and the fork in parallel. A run whose checker patches or
toolchains changed rebuilds them once.
