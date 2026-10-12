# Performance

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
