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
