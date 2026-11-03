# Reminder timing

The task-note reminder gives the model a chance to save current task state while it continues
working. It is not a deadline to finish the task or a request to reset context.

## The trigger follows the effective rollover policy

Posthorse reads Pi's live, model-resolved compaction settings. Define:

```text
usable = contextWindow - reserveTokens
rolloverAt = usable + 1
reminderBand = min(32,000, floor(usable × 0.1))
remindAt = rolloverAt - reminderBand
```

The first completed working turn with known usage at or above `remindAt`, but below `rolloverAt`,
can deliver the reminder. Posthorse sends at most one reminder per window, context size, and reserve.
A turn that finishes the run receives no reminder.

Pi's native threshold is strictly greater than `contextWindow - reserveTokens`, not greater than
or equal to it. Posthorse uses that same first integer rollover line.

The 10% band scales with usable context rather than the reserve. The 32,000-token cap prevents
large windows from requesting a note update hundreds of thousands of tokens before rollover.
These are Posthorse policy choices, not provider limits or a guarantee that every turn fits.

## Reserve and retention have different jobs

Official Pi 1.5.0 and the maintained fork default to automatic compaction enabled,
`reserveTokens: 16384`, and `keepRecentTokens: 20000`.

- `reserveTokens` determines the rollover threshold and therefore moves the reminder band.
- `keepRecentTokens` controls the approximate recent-message tail retained after rollover.
  It does not move the threshold or the reminder.

Each token setting resolves independently through the exact `provider/modelId` override, the
ordinary compaction setting, and the built-in default. Posthorse uses Pi's resolved values rather
than reading settings files independently.

These examples use Pi's defaults and the maintainer's configured 335k and 262,144-token windows.
They are policy boundaries, not estimates of a running session's remaining space.

| Context window | Reserve | Retained tail | Reminder eligible at | Rollover line | Reminder band |
| -------------: | ------: | ------------: | -------------------: | ------------: | ------------: |
|        335,000 |  16,384 |        20,000 |              286,756 |       318,617 |        31,861 |
|        335,000 |  64,000 |        30,000 |              243,901 |       271,001 |        27,100 |
|        262,144 |  64,000 |        30,000 |              178,331 |       198,145 |        19,814 |
|        262,144 |  16,384 |        30,000 |              221,185 |       245,761 |        24,576 |
|      1,048,576 |  16,384 |        20,000 |            1,000,193 |     1,032,193 |        32,000 |

There is no requirement for the saved note's tool receipt to survive in the retained tail.
The note remains on disk. Automatic recovery carries active task-note references and distinguishes
visible full writes from notes whose full contents must be read again.
Tying the reminder to retention would make a retention-only change alter note-save timing,
including when `keepRecentTokens` is zero.

## Delivery is best effort

Eligibility is checked at completed-turn boundaries, not continuously. A large assistant response
or tool batch can cross the entire reminder band. Unknown usage, overflow, or a restart can also
prevent delivery. An eligible turn can arrive well inside the band rather than at its first token.

The band leaves room for a note update without making note maintenance depend on one particular
model's output length or the maintainer's reserve. It is not a measured optimum for every workload.
Keep task notes current during work rather than relying on the reminder as the only save point.

Budget diagnostics remain available through `get_context_remaining`. The reminder itself contains
no token countdown.

## Sources and executable coverage

- Pi 1.5.0 [default settings](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/settings-defaults.ts)
  and [compaction settings](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/docs/compaction.md#settings).
- Posthorse's [effective-policy adapter](../index.ts), [budget](../src/budget.ts), and
  [reminder delivery](../src/rollover.ts).
- The budget-policy cases in [the unit suite](../test/posthorse.test.ts) check the first eligible
  token, strict rollover boundary, once-per-window behavior, and the capped band.
- The [real-SDK suite](../test/native-host.ts) checks working-turn delivery and preserves final
  answers and native settlement. These tests verify policy and delivered instructions, not model compliance.
