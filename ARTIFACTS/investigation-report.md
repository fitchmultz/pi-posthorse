# Posthorse cached-token investigation

**Scope:** https://github.com/fitchmultz/pi-posthorse at `0ce2594` (`main`). Pi-native package only (`index.ts`, `ui.ts`). Codex adapter is out of the installed Pi package and is summarized separately.

**Symptom under investigation:** ~4.26 billion cached input tokens / day vs ~11.2 million output (~97% cache hit). Model GPT-5/6 Astra, 500k context, many agents. Core Pi and pi-subagents are being investigated separately.

**Method:** Full read of `index.ts` / `ui.ts` / tests / README / changelog; grep for inference, timers, cache, retry, history, and prompt injection; read the qualified fork (`fitchmultz/pi@38b2a5816e030a4ff57379b6db1b882fe8110022`) for `sendMessage` / `turn_end` / auto-compact / cache-warmer behavior; read pi-subagents README for fork / extension / intercom wake behavior. No live production traffic, no provider dashboard, no user’s session JSONL.

**Verdict:** No proven unbounded loop, poller, or usage-misreport bug in current Posthorse. Posthorse does not call a model. It **can still explain a large fraction of a multi-billion cached-input figure** by keeping nearly the full 500k window in every provider request (no summary compaction) on every session that loads it, including subagents. That is the product’s design, not a hidden infinite retry. Billions still require high request volume (many agents and/or long tool loops). Core Pi cache-warming and pi-subagents steer/fan-out multiply the same large prefixes.

**Fix:** None applied. No clear proven defect that would send unbounded requests by itself.

---

## 1. What Posthorse is

Posthorse is a Pi extension (not an agent runtime). It replaces Pi’s automatic **summarization compaction** with **no-summary context windows**: the JSONL transcript stays complete; the model-visible window is cut at a native `context_window` boundary with a bounded handoff.

Pi owns the persisted boundary. Posthorse owns policy:

| Surface | Role |
| --- | --- |
| Stable system-prompt section | Explains rollover / reminders / `new_context` |
| `turn_end` checkpoint reminder | At most one steered custom message per window+budget fingerprint |
| `session_before_auto_compact` | Claims Pi’s threshold/overflow trigger; returns `{ newContext: { handoff } }` instead of a summary LLM call |
| `registerContextWindowHook` | Bounds oversized retained tool receipts before the fresh window is dispatched |
| `context` filter | Drops stale / disabled-compaction reminders from **model input only** |
| Tools | `new_context`, `get_context_remaining`, `notes`, `history` |
| `ui.ts` | TUI cards/renderers only; does not change provider payloads |

Package entry: `package.json` `pi.extensions: ["./index.ts"]`. Official unpatched Pi is refused at `session_start` and tools are not registered.

The Codex tree under `adapters/codex-posthorse/` is an isolated prototype, **not** shipped in the Pi package (`files: ["index.ts", "ui.ts"]`). It cannot explain a Pi-install token bill unless separately wired into Codex.

---

## 2. Every path that can cause model inference or mutate session/history

Posthorse never imports a provider client, never calls `fetch`, and has no `setInterval` / `setTimeout` / poll / heartbeat in the Pi extension. The only timers in the repo are Codex test harness timeouts.

Inference happens only when **Pi’s agent loop** makes a provider request. Posthorse can cause or enlarge those requests only through the hooks below.

### 2.1 Paths that can start or continue a provider turn

#### A. Checkpoint reminder (`turn_end` → `pi.sendMessage(..., { deliverAs: "steer" })`)

```1025:1063:index.ts
	pi.on("turn_end", (event, ctx) => {
		const native = nativeContext(ctx);
		if (
			event.message.role === "assistant" &&
			(event.message.stopReason === "error" || event.message.stopReason === "aborted")
		)
			return;
		// ...
		if (usage.tokens < remindAt) return;

		const branch = ctx.sessionManager.getBranch() as EntryLike[];
		const fingerprint: ReminderFingerprint = {
			windowId: currentWindowId(branch),
			contextWindow: budget.contextWindow,
			reserveTokens: budget.reserveTokens,
		};
		if (hasReminder(branch, fingerprint)) return;
		pi.sendMessage(
			{
				customType: REMINDER_TYPE,
				content: `[posthorse] Checkpoint now: ... then call new_context now. ...`,
				display: true,
				details: fingerprint,
			},
			{ deliverAs: "steer" },
		);
	});
```

**Proven extra inference:** the native harness consumes **two** model responses for one user prompt once usage is in the reminder band: the original answer, then a turn that sees the reminder.

```638:644:test/native.test.mjs
test("native enabled-to-disabled policy removes the active reminder but keeps its journal entry", async (t) => {
	const h = await fixture(t);
	h.faux.setResponses([fauxAssistantMessage("First response in reminder band"), fauxAssistantMessage("Checkpoint reminder received")]);
	await h.session.prompt("p".repeat(305_000));
	const reminders = () => h.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "posthorse-reminder");
	assert.equal(reminders().length, 1);
```

**Why that second call happens (fork, not Posthorse):** `turn_end` runs inside `AgentSession.finishTurn` while the agent turn is still active. Extension `sendMessage` is `sendCustomMessage`. With `deliverAs: "steer"` and default `triggerTurn`, a still-streaming session queues `agent.steer(customMessage)`. After the turn, Pi continues if steer messages are queued. The reminder text is ~400 characters; the **rest of the request is the current window** (near rollover, that is hundreds of thousands of tokens, mostly cacheable prefix).

**Dedup:** `hasReminder` requires a matching window id + context size + reserve. Tests prove one reminder per fingerprint, including legacy `headroom-reminder`, and no reminder below the band, on error/abort, after successful `new_context`, or when usage has already crossed Pi’s rollover line.

**Not a tight loop in current code.** A historical “immediate checkpoint loop with a large reserve” was fixed by keying the band to **usable** tokens (`CHANGELOG` 0.4.0; test “a large reserve does not send checkpoint reminders in a fresh window”).

#### B. Agent follows the reminder / handoff (model-driven, not a Posthorse timer)

Guidance and the reminder tell the model to stop, save notes, and call `new_context`. Automatic handoffs tell the fresh model to restore notes/todos and inspect history. Each of those is an ordinary tool round-trip. After rollover the window is small; later in the new window it grows again.

#### C. Claiming auto-compact does **not** add a summarization call

```1089:1102:index.ts
	(pi as unknown as NativeExtensionAPI).on("session_before_auto_compact", (event, ctx) => {
		// ...
		if (budget && !budget.supported) return undefined;
		// ...
		if (!handoff || handoff.length > limit) {
			return event.retainedToolResultIds.length ? { newContext: {} } : undefined;
		}
		return { newContext: { handoff } };
	});
```

This runs **before** Pi resolves summarization credentials (`README`; fork `_runAutoCompaction`). Net effect vs stock Pi: **one fewer** LLM call (no summary model). Fork then continues the interrupted turn only if `willRetry` (overflow) or messages are already queued. Native tests assert rollover “must not add a provider request” beyond the continue that was already required.

Unsupported small windows explicitly **do not** claim the hook, because “An unsupported budget would roll over every turn” (`index.ts` 1093–1094). A 500k Astra window is supported (`MIN_USABLE_TOKENS` = 10,000).

### 2.2 Paths that mutate model-visible context (no new turn by themselves)

#### D. System-prompt section on every `before_agent_start`

```1016:1023:index.ts
	pi.on("before_agent_start", (event, ctx) => {
		const guidance = buildGuidance(nativeContext(ctx));
		if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
			return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
		}
		event.systemPromptOptions.sections.posthorse = guidance;
	});
```

`buildGuidance` is **stable** for a given model + compaction settings (percent deadline, not a live token meter). Changelog 0.2.0 removed the old per-request meter. Native tests require the Posthorse heading to appear **exactly once** across tool additions and rollover, including forced-prompt compatibility.

Size: on the order of ~400–600 tokens. Cache-friendly. Not a billions source.

#### E. `context` filter

Removes stale or disabled-compaction reminders from the provider message list. Can only shrink input. Skips branch lookup when no reminder custom types are present.

#### F. Fresh-window receipt bounding

`registerContextWindowHook` → `boundWindowReceipts`. Append-only `context_edit` replacements on oversized **tool results** carried into the new window. Throws visibly if even recovery headers cannot fit; README: later prompts retry **preparation** against the unchanged window (local work, not a Posthorse-issued model call). This path reduces, rather than duplicates, retained receipt text.

#### G. Tools writing the journal

| Tool | Mutates | Enters next model turn as |
| --- | --- | --- |
| `new_context` | Returns `newContext` for Pi to commit a window + optional handoff (≤ 20,000 chars, also half of estimated fresh capacity) | Handoff text in the new window |
| `get_context_remaining` | Nothing persistent | Short estimate string |
| `notes` | Files under `.pi/notes/` | Returned page only (capped) |
| `history` | Nothing (read-only scan of JSONL) | Returned page / images (capped) |

Paging: `MAX_HANDOFF_CHARS` = 20,000; `pageSize` refuses when remaining context is too small and tells the model to `new_context` then retry the **same** offset/cursor. Parallel sibling pages share a per-turn budget (`pendingPageTokens` reset on `turn_start` / `session_start`).

`history` `all: true` walks project-scoped session files **including nested subagent sessions and fork copies**. That is disk I/O. Tokens appear only when the model is given the page in the following provider request.

`history` flattening includes assistant **thinking** and full tool arguments (`textOf` / `flattenEntry`). That is on-demand recovery, not automatic re-injection of the whole transcript.

`ui.ts` states display details are “never a second copy of a note or history page.” Renderers do not affect provider tokens.

### 2.3 What Posthorse does **not** do

- No provider HTTP, no `recordUsage`, no cache-warming hook.
- No broadcast to other sessions.
- No subagent spawn.
- No `session_before_compact` handler (manual `/compact` stays Pi’s).
- No payload rewrite via `onPayload` / `before_provider_request`.

---

## 3. Can this explain ~4.26B cached input / day?

### 3.1 How cached input is counted (mechanism, not a Posthorse bug)

Provider prompt caches charge **cache-read tokens on every request** that reuses a prefix, not once. A 97% cache-hit rate means almost every request resends a huge, stable prefix and a small suffix.

Posthorse is built to produce exactly that shape:

1. Stable system prompt (no live meter).
2. Conversation grows **without summarization** until ~`contextWindow - reserveTokens`.
3. Default Pi compact instead keeps ~`keepRecentTokens` (20,000 in stock Pi docs) plus a summary, which both **shrinks** prompts and **breaks** the middle of the prefix.

For a 500,000-token model and default `reserveTokens` 16,384:

- Usable = 483,616; rollover line = 483,617.
- Reminder band = last `min(32,000, 10% usable)` = 32,000 → reminder at **~451,617** tokens.
- In-flight conversation can be ~**20–24×** stock compacted context (~20k recent + summary).

Each tool round-trip near the top of a window therefore reports on the order of **4e5 cache-read tokens**.

### 3.2 Arithmetic (labeled)

Uncached input implied by 97% hit on 4.26B cache-read:

- Total input ≈ 4.26e9 / 0.97 ≈ **4.39B tokens/day**
- Uncached ≈ **132M tokens/day**
- Output **11.2M** → about **390 cache-read tokens per output token**

That ratio matches large-prefix, short-completion traffic (tool calls, not long essays). It also matches core Pi **cache warming** (full prompt replay, `maxTokens: 1`) if that is enabled — see §5. It is a poor match for a hidden Posthorse `while (true) complete()` loop: those loops would still emit output or errors, and current code has no such loop.

Request-count identity (if average cache-read per request is \(C\)):

| Assumed avg cached tokens / request | Requests / day to reach 4.26B |
| --- | --- |
| 450,000 (near-full 500k window) | ≈ 9,500 |
| 300,000 (mid-to-late window) | ≈ 14,200 |
| 100,000 | ≈ 42,600 |

9,500–14,200 requests/day is **~7–10 provider calls per minute average over 24h**, or **~200–280 calls/day/agent × 50 agents**, or one agent tool-looping every few seconds. All are plausible for “many agents” on Astra. None require a Posthorse infinite loop.

**Amplifier vs stock compaction (same request count):** if those requests would otherwise have carried ~30k–50k input instead of ~300k–450k, Posthorse-sized windows multiply cached input by **~8–15×**. Example: 400M cached/day compacted → 3–6B with no-summary 500k windows. That is the same order as 4.26B **if request volume is already large**.

**Posthorse cannot print 4.26B from a quiet process.** There is no poller. Zero user/agent turns ⇒ zero Posthorse-driven provider calls.

### 3.3 Extra requests Posthorse can add (bounded)

Per **window** (not per turn):

1. One reminder steer turn (proven).
2. Model-chosen notes writes + `new_context` (typically a few round-trips).
3. After rollover, model-chosen notes/history recovery (paged; each page ≤ 20k chars). A past **unbounded history-search pagination** via lookup echoes was fixed (0.5.0; native test “search cursors finish despite appended lookup echoes”).

If a window contains 80 tool round-trips, adding ~5–15 recovery/reminder calls is tens of percent, not 100×. **Window size dominates request count.**

### 3.4 97% hit rate as a diagnostic

Frequent rollover would **hurt** prefix cache (new window = new prefix). A 97% hit rate is evidence that **most requests occur deep in a long-lived large window**, which is what no-summary 500k filling produces. It is not evidence of a retry storm that keeps resetting context.

---

## 4. Proven issues (with citations)

### 4.1 In current `main` — behavioral, not unbounded bugs

| Issue | Proof | Token impact |
| --- | --- | --- |
| Reminder steer causes an extra full-window provider call | `index.ts` 1055–1063; `test/native.test.mjs` reminder test (two faux responses, one `posthorse-reminder` entry) | One ~window-sized cache-read per window that enters the last 32k usable tokens. Capped by `hasReminder`. |
| No-summary windows keep ~full context in every later request | `session_before_auto_compact` returns `newContext` instead of a summary (`index.ts` 1089–1102); README “Automatic rollover without summaries” | Dominant amplifier. Design. |
| Recovery tools can put old thinking/images back into the **new** window | `textOf` includes `thinking` (`index.ts` 185–201); `history` read returns stored images (`index.ts` 1396–1411) | Bounded per page (20k chars / paged images). Agent-driven. |
| Duplicate package installs register two copies | README “Keep exactly one copy loaded… two copies register the same tools and compete for the same rollover hook” | Duplicate tool schemas; two `turn_end` handlers can race `sendMessage` (extension `sendMessage` is fire-and-forget async in the fork). Still not a daily-billion loop. |
| `sendMessage` does not set `triggerTurn: true` | `index.ts` 1055–1063 vs fork `sendCustomMessage` | Extra turn relies on steer-while-streaming. If `turn_end` ever ran fully idle, the reminder would append **without** waking the model (weaker, not stronger). |
| Fingerprint uses `getContextUsage().contextWindow` on send, `model.contextWindow` on filter | `index.ts` 1041–1053 vs 1075–1081 | If those two numbers ever differed, the reminder could be filtered as stale while still counting for `hasReminder` (agent might not see it). **Not observed in tests.** Would hide reminders, not spam them. |

### 4.2 Historical defects already fixed (would have inflated tokens if still present)

| Defect | Fix | Why it mattered |
| --- | --- | --- |
| Reminder band used full window, so a large reserve could remind immediately in a fresh window | 0.4.0; test “a large reserve does not send checkpoint reminders in a fresh window” | Checkpoint **loop**: remind → `new_context` → still in band → remind. |
| History search pagination never finished because each lookup echoed the query | 0.5.0; native cursor tests | Agent paging `history` could issue unbounded full-window round-trips. |
| Claiming compact on unsupported tiny usable budgets | Explicit `if (budget && !budget.supported) return undefined` (`index.ts` 1093–1094) | Comment in code: would roll over **every turn**. |
| Per-request context meter in the prompt | Removed 0.2.0 | Would **reduce** cache hits (changing prefix). Current stable guidance **increases** cache-hit %. |

### 4.3 Not a usage-accounting bug in Posthorse

Posthorse does not call `recordUsage` and does not talk to the provider. Cached/uncached splits come from the provider (and, in the fork, from Pi’s cache-warmer usage entries). `get_context_remaining` only prints `ctx.getContextUsage()`.

---

## 5. Interaction risks (core Pi and pi-subagents)

These are not Posthorse source bugs. They are why a correct Posthorse install can still dominate a token dashboard.

### 5.1 Core Pi — prompt cache warmer

Qualified fork `packages/coding-agent/src/core/cache-warmer.ts`:

- Replays the last real request with `maxTokens: 1` at 90% of the prompt-cache TTL.
- Default mode **`streaming`** (settings-manager: unset → `"streaming"`). Idle mode can continue up to 30 minutes; streaming safety window is one hour.
- Decision: warm when expected savings ≥ $0.05. A ~500k prompt vs cache miss clears that bar easily.
- Each refresh is logged as usage kind `cache_warm` and is almost pure **cache-read + 1 output token**.

Posthorse does not enable this and does not hook `cache_warming_decision`. It **feeds** it: larger, more stable prefixes make warming look “cheap” and make each refresh cost ~full-window cache-read.

If the user’s 4.26B includes these replays, core Pi — not Posthorse — is emitting the extra calls. **Assumption (marked):** whether the user’s agent dir has `cacheWarming: "idle"` vs default `"streaming"` was not inspected.

Native Posthorse tests set `opts.cacheRetention = "none"` specifically to avoid the faux provider’s cache-write double count — they know cache accounting is easy to misread.

### 5.2 Core Pi — compaction vs Posthorse policy

Stock auto-compact: `contextTokens > contextWindow - reserveTokens`, then summarize, keep ~20k recent. Posthorse **claims that trigger** and cuts a window instead. Last handler wins if multiple policy extensions load (README). Manual `/compact` still summarizes.

Overflow/retry: if receipt bounding throws, the window is not published; Pi may keep retrying a still-huge prompt. That is a stuck expensive state, not a Posthorse `for(;;)` loop. Native tests cover successful oversized-result rollover without summarization auth.

Background command monitor in the fork (`sendCustomMessage` with `triggerTurn: !backgroundWakeSuppressed`, `deliverAs: "steer"`) can wake sessions independently of Posthorse. Combined with a large Posthorse window, each wake is expensive.

### 5.3 pi-subagents (from that project’s README, not this repo’s tests)

Proven statements from https://github.com/fitchmultz/pi-subagents README:

- A subagent is a **child Pi session**.
- Default bundled agents omit `extensions` allowlists → **“the child keeps … tools from loaded extensions.”** Posthorse therefore loads in children unless an allowlist excludes it. Each child gets its own 500k no-summary window, reminder, and tools.
- Default context is **fresh** (task text, not the parent transcript). `oracle` defaults to **fork**; `--fork` / `context: "fork"` copies the parent **leaf**. A forked child of a 400k Posthorse parent starts already huge.
- Intercom `send` **defaults to steer** and “wakes idle recipients.” `nudge` is a non-blocking steer. Each wake is a full child-context provider call.
- Nested fan-out is blocked unless `maxSubagentDepth` and `allowSubagents` allow it; parallel/chain launches still create **many first-level** children.
- Subagents README: full-prompt override fallback “changes the prompt prefix; neither that fallback nor filtered fork context guarantees cache-prefix reuse.” Complementary to Posthorse’s own `forceSystemPrompt` append path.

Posthorse `history` `all: true` is documented to search “sessions from this working directory and their nested subagents, including fork copies” (`index.ts` 1282; README). That does not spawn children; it can dump their transcripts into a parent window **if the model pages through them**.

Automatic recovery treats `display: true` custom messages (not reminders) as coordination inputs (`recoveryRecord`, `index.ts` 521–525). Tests use `intercom_message`. Visible intercom lines therefore survive into handoffs (bounded).

Posthorse PR #30 explicitly ran “Complete subagents + Intercom + Ponytail + session-name + Posthorse” and stated **“No provider cache-speed or cost improvement is claimed.”**

### 5.4 Fan-out math (inferred, high confidence, not a single-process proof)

Let \(A\) concurrent Pi sessions load Posthorse, each averaging \(R\) provider requests/day at \(C\) cached tokens:

\[
A \times R \times C \approx 4.26 \times 10^9
\]

Example: 40 sessions × 250 requests × 426k cached ≈ 4.26B.

Forked oracles from a late-window parent, or intercom steers to many idle children sitting on large windows, multiply \(A\) and/or \(R\) without Posthorse spawning anyone itself.

---

## 6. Ruled-out hypotheses

| Hypothesis | Status | Why |
| --- | --- | --- |
| Posthorse calls the LLM in a loop | **Ruled out** | No provider usage in `index.ts` / `ui.ts`. |
| Hidden `setInterval` / poll / heartbeat in the Pi package | **Ruled out** | Grep; only Codex test timers. |
| Automatic re-injection of full history every turn | **Ruled out** | History is a tool; pages are capped; context filter only removes reminders. |
| Duplicate tool results stuffed into the system prompt | **Ruled out** | Tools return once; receipt hook excerpts rather than duplicates. |
| Token usage fabricated by Posthorse | **Ruled out** | No `recordUsage`; no provider client. |
| Unsupported-budget every-turn rollover on 500k Astra | **Ruled out** | 500k − 16,384 ≫ 10,000 usable; unsupported path is for 8k/16k-class models. |
| Reminder storm every turn in current policy | **Ruled out** for a single install | Tests: one fingerprint per window; below-band turns do not even read the branch. Duplicate installs remain a residual risk. |
| Infinite history-search pagination (current code) | **Ruled out** | Cursor + priority + native tests. Was a real risk before 0.5.0. |
| Codex adapter causing the Pi dashboard number | **Ruled out** unless separately installed | Not in the npm/Pi `files` list. |
| `ui.ts` doubling note/history content into the model | **Ruled out** | Display-only; comment and implementation. |
| Posthorse alone, with few requests, reaching 4.26B | **Ruled out** | No request generator. |

---

## 7. Fix / mitigation recommendations (not implemented)

No Posthorse code change is justified by a proven unbounded bug.

**If the goal is to cut cached-input volume (conflicts with “fresh full window”):**

1. **Measure first (core Pi):** in session JSONL, separate assistant `usage.cacheRead` from `appendUsage("cache_warm", …)` entries. If warms are a large share, set `cacheWarming` to `"off"` (or keep default `"streaming"` and avoid `"idle"`) **in Pi**, then re-read the dashboard.
2. **Measure fan-out (pi-subagents):** count concurrent child sessions, `context: fork` vs `fresh`, and intercom/nudge steers per day. Exclude Posthorse from children via `extensions` allowlist if children should not run 500k no-summary policy.
3. **Do not fork from a late Posthorse window** unless that copy is required; forked leaf ≈ parent’s huge prefix.
4. **Confirm a single Posthorse source** (`pi list`); remove leftover `pi-headroom` / duplicate git+npm installs.
5. **Smaller model `contextWindow` or higher compaction reserve** shrinks the no-summary ceiling (and trips Posthorse’s unsupported path if usable < 10k, which **re-enables Pi summaries**).
6. **Disable Posthorse** (or `compaction.enabled: false`) as an A/B: with Posthorse uninstalled and compaction on, expect smaller prompts and usually a **lower** cache-hit %; with Posthorse installed, expect the opposite. That A/B is the empirical test of this report.
7. Do not add a live token meter back into the system prompt; that would trade cache-read dollars for cache-miss dollars.

**If a future Posthorse change is desired (optional, not a bugfix):**

- Send reminders with `deliverAs: "nextTurn"` or `triggerTurn: false` so they never steal a full-window turn; or inject them only into the next **user** turn. That saves **one** ~window-sized call per window — material locally, not 4.26B/day by itself.
- Offer a setting to skip loading tools/hooks in subagent children.
- Hook `cache_warming_decision` to `stop` when prompt tokens exceed a threshold (that logic belongs in core Pi or a tiny dedicated extension).

---

## 8. Confidence

| Claim | Confidence | Basis |
| --- | --- | --- |
| Posthorse does not itself infer | **High** | Full source + grep |
| No poll/heartbeat/retry loop in current Pi package | **High** | Full source + tests for the old loops |
| No-summary 500k windows massively increase per-request cache-read vs stock compact | **High** | Policy code + Pi compaction docs + arithmetic |
| One extra reminder provider call per window | **High** | Native test + fork `sendCustomMessage`/`finishTurn` |
| 4.26B **can** be reached with Posthorse-sized windows × many agents / tool loops | **High** | Arithmetic; matches 97% hit |
| Posthorse is a **sufficient sole** cause without high \(A\times R\) | **Ruled out** | No request generator |
| Cache warmer is part of the user’s 4.26B | **Medium** | Fork default is on for streaming; user settings not seen |
| Subagent children load Posthorse and run the same policy | **High** if they use default omitted `extensions` | pi-subagents README |
| Forked children inherit huge prefixes | **High** when `context: fork` / oracle / `--fork` | pi-subagents README; not the default for most bundled roles |
| A remaining undetected Posthorse tight loop | **Low** | Would contradict tests and the absence of timers/provider calls |

**Not inspected:** the user’s `~/.pi` settings, live JSONL, provider invoice line items, Astra cache TTL, concurrent session count, or whether compaction is enabled.

---

## 9. Code map (Pi extension)

```
index.ts
  notesRoot / importLegacyNotes     disk only
  flattenEntry / historyHit         history tool text
  buildAutoHandoff                  compact recovery string (≤ 20k)
  boundWindowReceipts               context_edit drafts on rollover
  buildGuidance                     stable system section
  export default function (pi)
    registerContextWindowHook       F
    before_agent_start              D
    turn_end                        A
    context                         E
    session_before_auto_compact     C
    tools new_context, get_context_remaining, notes, history   G
ui.ts                               renderers only
```

Qualified host: `fitchmultz/pi` commit `38b2a5816e030a4ff57379b6db1b882fe8110022` (README).
