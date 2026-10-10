# Posthorse cached-token investigation

## Conclusion and limits

The reported incident was approximately **4.26 billion cache-read input tokens/day**, **11.2 million output tokens/day**, and a **97% input cache-hit ratio**, using a 500,000-token model with multiple agents. These figures are unverified: no production journals, provider invoices, actual settings or matched workload baseline were inspected.

Posthorse does not directly call a provider, warm caches, spawn agents or run an inference timer. Its **no-summary policy can amplify cached-input volume** by allowing large contexts to remain in subsequent requests until rollover. A checkpoint reminder can also cause a bounded extra provider response. Neither mechanism establishes the cause of this incident or proves that the deployment has no request loop elsewhere.

**No runtime fix or measured performance improvement is claimed.** The useful next action is the controlled measurement below, not changing the product's no-summary contract.

## Source baseline

This report describes [Posthorse at `ea25232`](https://github.com/fitchmultz/pi-posthorse/tree/ea25232a21bb24af0cacafd952ef534b51dac2ee), superseding the original investigation at `0ce2594`. See the current [README](../README.md) for supported hosts, settings and limitations.

Changes since the original investigation:

- [#55](https://github.com/fitchmultz/pi-posthorse/pull/55) removed the unpackaged Codex prototype.
- [#56](https://github.com/fitchmultz/pi-posthorse/pull/56) fixed dropped checkpoint reminders, reduced redundant history/recovery traffic, and raised the maximum notes/history text page to 40,000 characters when budgets permit.
- [#28](https://github.com/fitchmultz/pi-posthorse/pull/28) moved both hosts to public retain-none compaction, removing the retired native-window, early-auto-compaction and receipt-bounding hooks.
- [#59](https://github.com/fitchmultz/pi-posthorse/pull/59) refreshed request-local guidance using current native capacity and available settings, including during continuation and rollover.

The original report's claims that official Pi is refused, that Posthorse bounds native retained receipts, and that send/filter capacity differs are not current defects.

## What can affect request volume and size

| Mechanism              | Current behavior                                                                                                                                                                                                                                                                                                                                                                                                                         | Evidence                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Automatic rollover     | `session_before_compact` supplies a bounded recovery record and retains no prior conversation. It does not call a summary model. Manual `/compact` stays Pi's summarization.                                                                                                                                                                                                                                                             | [`index.ts`, automatic hook](https://github.com/fitchmultz/pi-posthorse/blob/ea25232a21bb24af0cacafd952ef534b51dac2ee/index.ts#L1110-L1139); real-SDK explicit/automatic reset suites                  |
| Checkpoint reminder    | `turn_end` steers a best-effort reminder when no matching window/context-capacity/reserve fingerprint remains in active context. A changed fingerprint or native compaction summarizing away a reminder may allow another. Error/aborted turns, disabled compaction, unsupported budgets and usage already beyond the rollover line do not send one. A reminder can cause another provider response carrying the existing large context. | [`index.ts`, reminder](https://github.com/fitchmultz/pi-posthorse/blob/ea25232a21bb24af0cacafd952ef534b51dac2ee/index.ts#L1037-L1084); `test/native.test.mjs` reminder scenarios                       |
| Guidance               | Request-local guidance contains capacity and rollover policy, not a changing usage meter. Forced prompts preserve the host's text and receive a request-local conversation message instead.                                                                                                                                                                                                                                              | [`index.ts`, prompt hook](https://github.com/fitchmultz/pi-posthorse/blob/ea25232a21bb24af0cacafd952ef534b51dac2ee/index.ts#L1017-L1034); `test/official.test.mjs` continuation/model-switch scenarios |
| Notes/history recovery | Agent-requested pages enter later provider requests. Text pages are at most 40,000 characters, shrinking with available capacity; stored images are separately budgeted and paged. Parallel sibling results share a budget. History can include thinking, tool arguments and nested subagent sessions in the project scope.                                                                                                              | README Tools/Data and privacy; notes/history and paging tests                                                                                                                                          |
| Explicit rollover      | `new_context` commits after its own callback and successful sibling tools. Handoffs are at most 20,000 characters and are additionally constrained by fresh capacity. Background work is not stopped.                                                                                                                                                                                                                                    | README How it works; real-SDK failed-sibling and admission tests                                                                                                                                       |

The extension contains no direct provider client, network request, cache warmer or subagent launcher. This source observation does **not** rule out model-driven repeated recovery calls, duplicate extension installations, host retry behavior or loops in other loaded extensions. Keep one Posthorse copy and one automatic compaction policy loaded.

### Host boundaries matter

Both hosts use the public compaction hook with the same native eligibility: Pi must first prepare a summarizable span. Tiny overflow/truncated responses or a second large result without a new user turn can miss the hook; oversized initial input can reach the provider before recovery. Posthorse does not own physical payload clamping. See README **Official Pi and the fork** for the exact limits rather than treating a rollover policy as a provider-request-size guarantee.

## Arithmetic: plausible amplification, not attribution

For a 500,000-token model with a 16,384-token reserve, usable context is 483,616 tokens, the rollover line is 483,617, and the checkpoint band starts at 451,617. A late-window request can therefore carry hundreds of thousands of cacheable tokens.

Assuming the reported 97% is `cacheRead / total input`, it implies approximately 4.39B total input and 132M uncached input tokens/day. Cache-read/output is approximately **380:1**. If the dashboard defines the percentage differently, this calculation does not apply.

| Assumed mean cache-read tokens/request | Requests/day needed for 4.26B |
| -------------------------------------- | ----------------------------: |
| 450,000                                |                         9,467 |
| 300,000                                |                        14,200 |
| 100,000                                |                        42,600 |

For example, **40 sessions × 250 requests/day × 426,000 cached tokens/request = 4.26B**. These are hypothetical workloads, not observed traffic.

Stock summarization also lets contexts grow between compactions. Comparing a near-full Posthorse window only with a just-compacted stock window does not establish an average cost multiplier. A token-weighted 97% cache-hit ratio likewise does not establish that most requests occur near the context ceiling. Measure the distribution of request sizes and the entire workload, not just one late-window request or cache-hit percentage.

## Safe controlled comparison

1. **Record identities and effective policy.** Capture Posthorse revision, exact official/fork host revision, model and routed physical capacity, reserve/keep-recent settings, cache-warming policy, loaded extension sources and subagent profiles. Use `pi list` to check for duplicate copies. Do not publish raw journals or credentials.
2. **Separate request sources.** Count actual provider requests and input/cache-read/cache-write/output tokens. Where the host records separate `cache_warm` usage, distinguish those requests from ordinary assistant requests. Check provider invoice semantics before equating a cache ratio with spend.
3. **Hold the workload constant.** Use the same task set, starting state, tools, model, host, compaction settings, warming policy, child-session count and fresh/fork policy. Account for cold/warm cache state. Run repeated trials and compare completion quality as well as latency, request count, cumulative tokens and billed cost.
4. **Compare Posthorse loaded against Posthorse unloaded, with automatic compaction enabled in both.** Restart isolated sessions after changing extension loading. Removing Posthorse restores the host's stock automatic summarization path; do not load a competing policy extension. Keep the production configuration unchanged during the experiment.
5. **Do not use `compaction.enabled:false` as the stock-compaction baseline.** It disables automatic compaction and Posthorse reminders/automatic rollover; it does not unload Posthorse, restore automatic summaries, or remove `new_context`. This can leave a growing request without automatic recovery. Existing `test/official.test.mjs` disabled-policy scenarios verify retained tools and no automatic boundary.
6. **Inspect fan-out and wake-ups separately.** Extension inheritance, forked parent contexts, intercom steering, background completions and cache warming are host/profile-dependent. They can multiply requests or prefix sizes, but this investigation has not measured their contribution to the incident. Check the exact installed implementations and settings rather than assuming external defaults.

Changing the effective model capacity or reserve can lower Posthorse's window ceiling, but it also changes rollover frequency and available working space. Keep at least 10,000 usable tokens; unsupported small budgets intentionally leave the host's own compaction behavior in place. Do not use that fallback as an implicit cost-control feature.

## Disposition

This investigation remains relevant as a cost-diagnostic guide, **not a reproduced runtime bug**. The documentation correction removes the unsafe A/B recommendation and superseded implementation claims. Resolving the reported production usage requires the measurements above; neither this report nor green compatibility tests establishes the incident's cause or financial resolution.
