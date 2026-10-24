# Reserve investigation evidence

This is a source/cloud investigation for [pi-posthorse#98](https://github.com/fitchmultz/pi-posthorse/issues/98).
It changes documentation and regression tests only. No runtime speedup, provider cache hit, or billed
saving is measured. The [explanation](../../docs/rollover-cache-cost.md) separates those claims from
capacity arithmetic.

## Parent review correction

[The parent review](https://github.com/fitchmultz/pi-posthorse/pull/100#issuecomment-6385193130)
identified a new arithmetic-only test with no production or dependency call. That self-comparison
has been removed. No production seam replaces it. The current focused suite has three native
`budgetFor`/`shouldCompact` threshold cases and one actual `calculateCost` contract case, next to
three real-SDK rollover request/tail cases. The full current suite has 343 tests.

The original comparative runs, profiles, failed attempts, and `verify.log` below describe head
`ee9ce629c8f662887f6760e335b228dd4b76ce58` before that removal. Their recorded 344-test full suite,
eight-test focused runs, and timing ranges are historical evidence, not counts for the corrected
suite. They have not been rewritten. Removing the test does not change runtime/package bytes,
reserve behavior, the native fixtures, or the arithmetic reproduction and artifact.

## Identities and authority

- Admission `origin/main` resolved once to `b3d621451553eddfbdbdc1ad6ce76eda0e49a7a9`.
  The requested branch is `perf/issue-98-pi-posthorse`, in a separate cloud Linux Git worktree.
- Actual configured model was `openai/gpt-6.1-sol` with `xhigh` thinking, context window 300,000,
  fast mode unset, and connection ready. The coordinator verified the active chat through the
  supported owner-authenticated read-only chat GET at `2026-10-24T13:23:15.981463+00:00`.
  Canonical AgentDoc configuration version SHA-256 was
  `c52404be6ba45b2e0427d98acc645cf5eeba33d251e1acd2e798807cd4d3d5ea`.
  The coordinator retains `actual-model-evidence.json`. This is configuration evidence, not a model
  self-description. No account, chat configuration, or future default was changed.
- Pstack was read at `94f83d6fb0581e0602e467f7fafdfd9f87c4b402`, with its Pi adapter first.
  The parent owns the program. This assignment is one isolated code owner, not a nested program.
- [Environment and source hashes](environment.txt), [locked companion graph](locked-sdk.json), and
  [actual locked CLI output](locked-cli.txt) identify the cloud proof environment.
  Node was 24.22.1, npm 12.2.0, and official Pi 1.3.0. The committed dependency lock is unchanged.
- Latest official Pi was independently resolved to 1.4.0. Maintained fork main resolved to
  `c17adbc400319887c5ab34fce1ed2a59be746da4`. The repository's CI qualifies both actual SDK/CLI graphs
  and package consumers. The PR check artifacts, rather than the locked 1.3.0 graph, own that evidence.
  Reviewed 1.4.0 notes include the removal of reserve-based summary output caps and recovery fixes.
  Posthorse does not use the summary generator for automatic rollover. No dependency upgrade is bundled.

The historical issue samples were collected October 23, 2026, 22:36-23:45 PDT on old installed native
selector `403a2713/2005895e` and public `dist045a331e`. They do not span the runtime switch at
`2026-10-24T13:07:48Z`. The owner reports the newer installed native identity as
`c17adbc400319887c5ab34fce1ed2a59be746da4-0d1fed76471a6053-node24.22.1-darwin-arm64`, with public 0.50.0
`dist09b93d7fea1539a8e23003be654cc3bd02064d5f0e8487c2ec35f75f02c02b86` from subagents source
`4906e67e3a6701a753df3af112304dea2246aeb1`. None of those installed artifacts was accessed or activated.
This report does not claim measurements of that macOS installation.

## Decision trail

The declared data shape was a three-row table of reserve scenarios, integer thresholds, nominal
headroom, and labeled percentage denominators. The checkpoint was a rerunnable report plus native
SDK requests that preserve system/tools and the safe paired tail without a summary request.

- Model the Domain kept scenarios in one table rather than a new runtime settings abstraction.
- Explain the Number separated overlap, billing, capacity delay, and frequency denominators.
- Test Behavior, Not Implementation led to assertions on requests seen by the faux provider and
  persisted compaction. Deliberate broken-guidance and dropped-tail probes demonstrate sensitivity.
- Sequence Work into Verifiable Units kept failed fixtures, their corrections, and later proof separate.
- `how`, `architect`, `arena`, `swarm`, `interrogate`, and `no-comments` panels were not selected.
  No product architecture or contested implementation changed. Two real independent read-only
  delegates checked arithmetic/source contracts and then the documentation/test diff.
- Adapter standalone cleanup removes redundant narration or speculative helpers from changed hunks.
  No checker, assertion contract, timeout, support floor, optional peer, lock policy, or safety rule changes.

## Owner policy clarification after PR100

After [PR100](https://github.com/fitchmultz/pi-posthorse/pull/100) merged, Mitch supplied this rationale
in the task follow-up:

> reason for 64k is to make sure rollover happens before 272k tokens based on my custom ctx window size of 335k tokens for models i use. some providers cost more above 272k tokens.

At that window, the 64k reserve first crosses at 271,001, below 272,000. The 32k and 24k counterfactuals
cross at 303,001 and 311,001, above his policy boundary. They are not equivalent cheaper alternatives
for routes with that input-pricing tier. A trigger does not hard-cap requests or prevent overshoot.
This is first-party policy intent, not verification of provider tiers, prices, or invoices. The
[updated explanation](../../docs/rollover-cache-cost.md) preserves that distinction. No settings,
fixtures, arithmetic artifacts, or historical raw results change in this documentation follow-up.

## Arithmetic reproduction

[arithmetic.json](arithmetic.json) records formulas applied to public issue aggregates and synthetic
reserve scenarios. It is not telemetry or a forecast. From the repository root:

```sh
node --input-type=module <<'JS'
import { budgetFor } from './src/budget.ts';
const contextWindow = 335000;
const rows = [64000, 32000, 24000].map(reserveTokens => {
  const budget = budgetFor({ getCompactionSettings: () => ({enabled:true, reserveTokens}), getContextUsage: () => ({contextWindow, tokens:null, percent:null}), getSystemPrompt: () => '' });
  return {reserveTokens, rolloverAt:budget.rolloverAt, windowUsedPercent:100*budget.rolloverAt/contextWindow, nominalHeadroom:contextWindow-budget.rolloverAt, relativeLineIncreasePercent:100*(budget.rolloverAt-271001)/271001, additionalWindowPercentagePoints:100*(budget.rolloverAt-271001)/contextWindow, idealFrequencyReductionPercent:[0,30000].map(freshTokens => ({freshTokens, percent:100*(1-(271001-freshTokens)/(budget.rolloverAt-freshTokens))}))};
});
console.log(JSON.stringify({kind:'synthetic arithmetic, not observed billing or throughput', rows, reportedAggregateChecks:{overlapTokens:4737838, flaggedRequests:29, expectedTransitionRequests:5, rolloverCount:20, meanAllFlaggedTokens:4737838/29, mixedAggregateDividedByRollovers:4737838/20, estimatedDollars:42.5, totalDollars:261.2, sharePercent:100*42.5/261.2, impliedMarginalDollarsPerMillion:42.5/4737838*1e6, syntheticInputPremiumAt9PerMillion:4737838*9/1e6}},null,2));
JS
```

The native threshold and synthetic price checks run with:

```sh
node --import ./test/pi-loader.ts --test test/rollover-cost.test.ts
```

The price fixture deliberately uses synthetic $10/$1/$12.50 rates, not a purported tariff for either
reported route. Unknown historical invoice rates and the five transitions prevent billing attribution.

## Native boundary and measurement limits

`test/official.test.mjs` exercises each reserve through real `createAgentSession`, the loaded extension,
a local faux provider, and persisted JSONL compaction. Each case has three deliberate user prompts,
three faux requests, one automatic boundary, no summary request, an unchanged system prompt and tools,
and retained assistant/owner/paired receipt messages without duplicated recovery excerpts.
The payload contains 1,276,000 filler characters plus fixed labels. No real owner input is used.

Faux caching is disabled in the existing fixture to avoid its synthetic usage double count.
No API credentials, provider inference, cache warming, or network billing are involved.
System/tool equality at the SDK request boundary is not proof of provider wire serialization or cache hits.
The numerical threshold tests are small arithmetic checks next to that end-to-end SDK proof.
Neither is a latency benchmark or a substitute for actual provider billing evidence.

Raw commands, alternating baseline/candidate outcomes, failures, and a separate profile are retained
with this investigation. The baseline and candidate use the same new test harness and identical
runtime source and dependency bytes. Their comparison checks unchanged behavior, not a speedup.
Full synthetic Pi JSONL journals and raw CPU profiles remain retained in the task evidence archive.
Latest-host CI also copies the three new native journals into its qualification artifact.

## Historical alternating unchanged-runtime proof

[paired-results.json](paired-results.json) contains five alternating samples per side in the order
A1, B1, A2, B2, A3, B3, A4, B4, A5, B5. [Raw logs](runs/) retain every Node-runner result.
A is admission main with the candidate's test-only harness copied in. B is this candidate.
The production files, lockfile, Node process options, and installed SDK graph are identical.
Both original sides passed 40/40 tests with 15 native reserve cases, 45 faux requests, 15 automatic boundaries,
and zero errors, cancellations, or skipped tests. Every native case observes three deliberate requests
and one boundary before and after. No provider request is made outside the faux provider.

The recorded Node-runner durations have median 1,867.29 ms and range 1,767.49-1,988.85 ms for A,
and median 1,877.53 ms and range 1,837.73-1,992.48 ms for B. These include imports, fixture creation,
journal I/O, and test execution. They are test-process durations, not rollover or user latency.
The ranges overlap. No runtime performance difference is claimed, and no runtime code changed.
[The load snapshot](load.txt) was taken after the native compiler jobs completed.

The original loop used separate cloud worktrees and this command for each side, alternating five times.
Reproducing its eight-test counters requires the test files from the initial head above; the corrected
focused suite has seven tests because the arithmetic-only test is gone.

```sh
cd "$side_worktree"
git diff --quiet b3d621451553eddfbdbdc1ad6ce76eda0e49a7a9 -- src index.ts ui.ts package.json package-lock.json
env -i PATH="$PATH" HOME=/workspace/evidence/issue-98/alternating/home TMPDIR=/tmp/ph98a \
  PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 CI=true \
  PI_COMPAT_EVIDENCE_DIR="/workspace/evidence/issue-98/alternating/$sample" \
  node --import ./test/pi-loader.ts --test \
  --test-name-pattern='reserve investigation|reserve scenario|reserve frequency|synthetic prices' \
  test/host.test.mjs test/rollover-cost.test.ts
```

A separate, non-comparative profile used the same isolated settings:

```sh
node --cpu-prof --cpu-prof-dir=/workspace/evidence/issue-98/profile \
  --import ./test/pi-loader.ts --test --test-name-pattern='reserve investigation' test/host.test.mjs
```

[profile-summary.json](profile-summary.json) retains the top self-sample locations. Module compilation,
GC, and journal persistence contribute to this small test process. This is not an isolated rollover
microbenchmark. The CPU profile cannot identify a provider cache/billing limiter, since the fixture
has no provider network request. Actual billing attribution and installed-host latency remain
unavailable rather than inferred from a unit timing.

## Local preparation and failed attempts

- `npm ci --ignore-scripts --no-audit` with npm 12.2.0 exited 0.
- First `quality:prepare` exited 1 because Rust and Go were absent. Tools were installed under the
  task's cloud workspace, not into the owner's runtime or global configuration.
- Cold native preparation then failed because CMake was missing, and its Go build hit the existing
  600-second deadline. CMake was installed in the isolated cloud container. The Go build was rerun
  with its now-warm compiler cache and the same deadline. No timeout or checker was relaxed.
- The first native fixture exceeded the configured 335k window and correctly produced overflow,
  not threshold. The second observed the last full-window request, before the next user request.
  Corrected inputs remain below the window and above all reserve thresholds, then explicitly resume.
  The positive suite passes. Those failed logs and generated synthetic journals remain retained.
- An exact floating-point identity differed in the final binary digit. It was initially replaced
  by an integer identity. Parent review then identified that neither version exercised an owner
  contract, and the test was removed. Both failed attempts and the original passing runs are retained.
- Two deliberate regressions in a disposable baseline worktree each failed all three native cases.
  One added changing usage to the guidance. The other dropped the retained tail.
  The original production files were restored before comparative proof.

## Acceptance after parent review

The actual `npm run verify` exited 0 after the test removal. Its
[complete follow-up log](verify-parent-fix.log) records 343 passed tests, zero failures or skips,
and the required compiler, strict lint, policy, format, native SDK, renderer, and package gates.
The three real reserve scenarios and the four owner-contract cases remain in that suite.
Formatting and changed-hunk cleanup were checked again. No production file changed.

Only invalidated acceptance was rerun locally. The original A/B runs, CPU profile, and deliberate
mutation probes remain historical rather than being relabeled as measurements of the corrected
harness. Current-head CI and enabled review checks must complete again for the follow-up commit.

## Historical acceptance before parent review

The actual `npm run verify` exited 0 with the corrected native engines. Its [full log](verify.log)
records policy, strict lint, formatting, compiler checks, 344 passed tests, zero skipped tests,
and package dry-run. A separate `npm run check` also exited 0. Safe lint fixes and formatting were
inspected for changed-hunk noise and preserve all production files.

[Native engine receipts](oxlint-receipt.json) and the [type-aware engine receipt](tsgolint-receipt.json)
record the pinned patches and actual built backend hashes. In a disposable checkout, the same
`npm run verify` rejected syntax, floating-Promise, compiler-type, formatting, and local same-name
`test` allowance violations. [Probe logs](gate-probes/) include the actual rule IDs and locations,
not just nonzero exits. Original files were restored after each probe. The full passing workflow
also runs the repository's positive and negative declaration-origin matrix.

Actual `npm pack --json` outputs for [A](A.json) and [B](B.json) are retained. Both tarballs have SHA-256
`53e7607beecc615bf1c53eb224ca24218d666b84d4cbabf2e5b5f6ba08beb072` and are byte-identical.
The docs and tests are not in the package's runtime file list. Packing is not publication.

Latest official/fork qualification and external reviewer outcomes belong to the PR's current-head
checks and linked Actions artifacts. Local 1.3.0 verification is not substituted for those gates.

Provider billed savings, the private corpus, current installed macOS latency, and native Windows
behavior are NOT RUN. No publication, deployment, merge, auto-merge, live installation, session restart,
global provider/settings change, or owner-data deletion is part of this work.
