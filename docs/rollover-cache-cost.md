# Rollover frequency and cache cost

A smaller reserve delays automatic rollover, but the extra working space is not a measured saving.
This investigation of [#98](https://github.com/fitchmultz/pi-posthorse/issues/98) keeps current behavior,
settings, and prompt contracts unchanged. No reserve reduction is recommended from these data.

## What the reported session establishes

The issue reports 20 automatic rollovers, 4,737,838 estimated overlapping tokens across 29 requests,
and about $42.5 of a $261.2 session total. Five flagged requests were expected model or provider
transitions. These are historical owner observations, not measurements from this investigation.
The private journal and request payloads were not inspected.

The samples came from the old installed runtime on October 23, 2026, before the October 24 runtime
switch. They do not establish current-source behavior or latency on the newer installed runtime.
[The evidence notes](../ARTIFACTS/rollover-reserve/README.md) record the exact provenance and fresh
synthetic cloud checks.

The aggregate arithmetic needs several distinctions.

- $42.5 / $261.2 is 16.27%. This checks the reported proportion, not its causal attribution.
- 4,737,838 / 20 is 236,891.9 tokens. That is not a verified mean loss per rollover. The numerator
  includes 29 flagged requests and five transitions, whose individual token and dollar amounts
  are unavailable. Excluding five requests leaves 24 candidates, not 20 boundary measurements.
  Applying a 24/29 discount would assume equal request sizes and prices.
- The mean over all 29 flagged requests is 163,373.7 tokens. A flagged request can reflect multiple
  causes. It is not necessarily one rollover or one discarded prefix.
- A token-weighted cache-hit ratio can mean `sum(cacheRead) / sum(input + cacheRead + cacheWrite)`.
  Under that definition, the reported 96.7% excludes output and says nothing about the distribution
  of requests near a rollover. A dashboard with a different denominator needs a different calculation.

The current maintained fork's [overlap estimator](https://github.com/fitchmultz/pi/blob/c17adbc400319887c5ab34fce1ed2a59be746da4/packages/coding-agent/src/core/cache-stats.ts#L49-L92)
uses `min(previousPromptTokens, currentPromptTokens) - currentCacheRead`, subject to a 1,024-token
noise floor. It compares token counts, not prefix bytes or cache keys. Its estimated premium uses
the current blended paid-input/write rate minus a read rate from usage, ancestry, or the catalog.
Unknown pricing yields an unpriced estimate, not proof that the operation was free.

That fork's [scanner clears its comparison at compaction and branch summaries](https://github.com/fitchmultz/pi/blob/c17adbc400319887c5ab34fce1ed2a59be746da4/packages/coding-agent/src/core/cache-stats.ts#L131-L166).
It cannot directly attribute the first post-compaction request against the pre-compaction request.
The historical estimator or stress-test definition is needed to reconstruct the issue's figure.
The current scanner is not evidence that the historical report was wrong.

## Pricing an overlap is not measuring billed loss

Pi normalizes ordinary input, cache reads, and cache writes as separate token categories.
`cacheWrite1h` is a subset of `cacheWrite`. Reasoning is a subset of output. Adding either subset
again double-counts tokens. With rates in dollars per million tokens, Pi's cost calculation is:

```text
cost = (input * inputRate + output * outputRate + cacheRead * readRate
        + (cacheWrite - cacheWrite1h) * writeRate
        + cacheWrite1h * 2 * inputRate) / 1,000,000
```

This describes the inspected Pi 1.3.0 accounting contract, including its one-hour Anthropic write
pricing. Applicable long-context pricing tiers depend on total prompt input. Actual historical
rates, provider routing, service tiers, discounts, and subscription billing still need verification.
Route names alone do not identify the price charged.

For example, synthetic input/read/write rates of $10/$1/$12.50 give incremental prices of $9 per
million for input instead of a read, $11.50 for a short write, and $19 for a one-hour write.
Multiplying all 4,737,838 reported tokens by $9 per million gives $42.64, close to the reported
estimate. That numerical agreement does not verify those rates, the token classification, or the bill.
The implied blended premium from the reported figures is $8.97 per million tokens.
[Regression tests](../test/rollover-cost.test.ts) check the synthetic examples through Pi's actual
`calculateCost`, not a replacement billing implementation.

Deleting old context does not charge again for the deleted tokens. Potential extra work includes
rebuilding retained content behind the changed prefix. Discarded context size, estimated overlap,
actual cache writes, and incremental billed cost are different quantities. A smaller context may
also reduce future cache-read volume. A proper cost comparison includes all requests and any
recovery, retries, output, and changes in completion quality.

## The 64k, 32k, and 24k reserve scenarios

Here `k` means 1,000 tokens. The 64,000-token reserve is the issue's setting, not Posthorse's default.
Posthorse uses Pi's effective compaction policy. The inspected Pi default is 16,384 tokens.

For context window `W` and reserve `R`, native Pi triggers at `used > W - R`.
Posthorse reports the first integer crossing as `T = W - R + 1`.
At a 335,000-token configured window:

| Reserve | First integer rollover line | Window used | Nominal space at line | Line increase versus 64k |
| ------: | --------------------------: | ----------: | --------------------: | -----------------------: |
|  64,000 |                     271,001 |    80.8958% |                63,999 |                 Baseline |
|  32,000 |                     303,001 |    90.4481% |                31,999 |                 11.8081% |
|  24,000 |                     311,001 |    92.8361% |                23,999 |                 14.7601% |

The additional 32,000 or 40,000 tokens occupy 9.5522 or 11.9403 percentage points of the full window.
Those percentages are not the relative delay from the old rollover line. The issue's "9-13% later"
combines quantities with different denominators.

For constant fresh-window occupancy `F`, the idealized growth per cycle is `T - F`.
With continuous equal token growth, the boundary-frequency reduction is
`1 - (T_old - F) / (T_new - F)`, for `F < T_old`.
At `F = 0`, this gives 10.5610% fewer boundaries for 32k and 12.8617% fewer for 24k.
At a synthetic `F = 30,000`, it gives 11.7216% and 14.2348%.
Fresh occupancy includes system instructions, tools, recovery, the retained tail, and new input.
It is not generally constant. Discrete turns and a finite session change the boundary count too.

These are capacity scenarios, not projected savings for the reported 20 rollovers.
Fewer boundaries can carry larger individual rewrites and leave large contexts in more requests.
Provider cache lifetimes, long-context price tiers, large tool batches, recovery calls, and retries
can change both cost and latency. The synthetic results do not predict either direction.

## Why the smaller reserve is not a readiness guarantee

The nominal margin at the first crossing is `R - 1`. An overshoot of `d` tokens leaves `R - 1 - d`
before accounting for pending additions, desired output, or estimation error. Several tool results
and queued inputs share that margin. The configured window is not a measured physical provider limit.

Current protections remain unchanged.

- Posthorse requires at least 10,000 usable tokens after the reserve for automatic behavior.
  This is a minimum working budget, not a minimum safe reserve for every tool or response.
- Recovery and the paired recent tail share half the fresh operational capacity after system,
  guidance, tool, visible pending-input overhead, and a 1,000-token margin. Recovery records remain
  capped at 20,000 characters. The native automatic hook cannot inspect queued bodies that Pi has
  not drained yet. Arbitrarily large input is not bounded by this policy.
- Pi must prepare an eligible compaction span before the native automatic hook runs.
  Posthorse's narrow fresh-window threshold fallback does not replace all native eligibility checks.
  Large initial input and some small overflow or truncated-response cases can reach the provider
  without successful recovery. Unsupported budgets leave Pi's own compaction in place.
- The inspected Pi AI output clamp leaves an additional estimated 4,096-token allowance.
  At exact line occupancy, simple subtraction gives 59,903, 27,903, or 19,903 tokens before further
  input and model limits. This is adapter arithmetic, not a guaranteed response allowance.
- Native overflow recovery permits one compact-and-retry attempt. It is not guaranteed to succeed.
  Posthorse cancels when it cannot build a safe automatic recovery record and preserves failed,
  aborted, and sibling-tool safety rules. It does not clamp arbitrary physical request payloads.

A future reserve recommendation needs matched large-result, queued-input, truncation, retry,
and completion-quality measurements, as well as billed usage and latency. None is bypassed here.
See [current recovery limits](reference.md#settings) for the full contract.

## What can remain cache-eligible

With unchanged policy and model, the synthetic real-SDK cases confirm unchanged system prompt text
and tool declarations across automatic rollover. They also confirm the retained paired tail,
bounded recovery, and absence of a summarization request. The tests use a local faux provider.
They do not prove a provider cache hit or byte-identical provider wire serialization.

Pi projects the new compaction record before the retained recent messages. The retained messages
therefore follow a changed conversation prefix. Retention preserves information, not a guarantee of
cache reuse. Provider behavior, routing, account identity, cache lifetime, and serialized system/tool
inputs can affect eligibility even when Posthorse's text is stable.

No additional immutable conversation prefix is established by the current summary-plus-tail contract.
Keeping one would require a semantic and capacity change, not a documentation correction.
Moving conversation content into the system prompt would also change trust and prompt behavior.
Neither change is justified by this aggregate report. Changing the reserve itself changes Posthorse's
policy guidance, so its configuration-change warm-up must be separated from steady-state rollovers.

A public-safe future comparison can group synthetic requests into rollover-only, transition-only,
both, and neither, then compare complete matched workloads with the same model, cache lifetime,
starting state, and tools. Billing attribution needs per-request usage and price provenance or
invoice evidence. The private corpus remains local.
