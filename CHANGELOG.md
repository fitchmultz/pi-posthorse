# Changelog

## Unreleased

- Support Pi 1.0.0 and later using the official public retain-none compaction path; checkpoint and legacy fork-window APIs are not required. Keep development TypeBox aligned with the exact host cohort.
- Reuse one lazy native usage/settings snapshot per synchronous safety evaluation, including page budgets and final handoff admission. Never guess routed context capacity from a virtual model declaration.
- Bound reminder lookups by the latest Posthorse boundary and complete kept range, reusing leaf-certified append-only and negative state without losing history. Reuse compaction event branch entries for recovery.
- State the active model's configured context capacity and available rollover threshold in every fresh window, and require a budget lookup before reporting remaining tokens or changing plans because of context limits.
- Prefer incremental edits of concise current-state notes at checkpoints, leaving already-current notes unchanged and retaining full writes as a fallback.
- Show absolute shared storage locations in notes reads and listings, with path headers included in page budgets but excluded from content offsets and compact previews.
- Upgrade the development Pi cohort to 1.0.0 and host TypeBox 1.3.27 without changing optional runtime peers or the Node floor.
- Use public retain-none compaction on both hosts; remove retired native-window, early-auto-compaction and receipt-bounding hooks. Preserve legacy journal history and current notes/recovery tools.
- Require positively identified projected `ask_question` calls and an effective registered unnamespaced definition for owner answers, including providers that omit call namespaces. Namespaced, unregistered or orphaned results stay tool evidence.
- Bind explicit rollover to Posthorse's own successful callback and admitted handoff, not a foreign same-name tool result. Consume requests once at settlement and preserve failed/aborted batches.
- Qualify native early/after-reset eligibility on the official 1.0 baseline for both targets; remove retired fork-checkpoint tests and distribution heuristics. Preserve legacy journal recovery, not unsupported runtime APIs.
- Remove the obsolete source-copying fork integration suite and script after migrating distinct protections to the current public real-SDK owners.
- Correct official automatic-hook credential ordering and identify the native compaction card as the current reset-success indicator; context-window cards are historical.

## 0.7.0

### Changed

- `history search` skips entries whose full text the model already sees in its active context and reports how many it skipped, instead of repeating what the model can already see. Edited-away originals and checkpoint reminders stay searchable.
- All-session history hits carry a 10-character file key instead of the session file path and a 43-character hash, and hits from nested subagent runs are tagged `[subagent]`. Full-length keys from earlier releases still read. Reads that resolve a bare ID in another session file print its qualified ID.
- All-session search and bare-ID history reads use ripgrep (Pi's managed copy, then `PATH`) to skip session files that cannot match. Without ripgrep, and for queries that could match escaped or label-only text (quotes, backslashes, brackets, parentheses, braces, colons, `$`, edge spaces, or phrases such as "Call ID" and "No handoff"), every file is scanned as before; image-count and comma queries also search every file with an image block. Results always match a full scan.
- `notes list` shows notes newest first with size and modification time, and takes an optional folder `path`. `notes read` of a folder returns its listing.
- Notes and history pages hold up to 40,000 characters, up from 20,000, when the window has room. Handoffs stay capped at 20,000.
- Automatic recovery records cap each tool-result excerpt at 1,500 characters and index the remaining current-window inputs by entry ID, with a one-line preview for owner inputs, instead of quoting them until the record fills.
- Shorter guidance, reminder, and tool descriptions. The reminder asks for rewriting one current-state note in place, the guidance asks for readable prose in handoffs and notes, and `get_context_remaining` is no longer promoted for routine checks.

### Fixed

- On the fork, a checkpoint reminder sent after Pi compacted inside a Posthorse window was removed from model input, leaving the model an extra request with nothing new and no checkpoint prompt.
- `notes search` skips binary files and streams text notes asynchronously; before, one search could block Pi for seconds and load hundreds of megabytes of databases or archives as text. `notes read` of a binary file now says so instead of returning decoded bytes.
- `history read` errors explain what a valid entry ID looks like and point to `history search`.

### Removed

- The experimental Codex prototype (`adapters/codex-posthorse`) and its CI workflow. It was never part of the Pi package.

## 0.6.0

### Breaking Changes

- Requires Node `>=24.12.0`.
- Removes pi-headroom compatibility: `headroom-reminder` entries are no longer recognized, and checkout-local notes are no longer imported into the shared notes directory.

### Added

- Runs on official Pi. Rollover there is a compaction entry that keeps no earlier conversation and carries the handoff as its summary, with no summary model call. `new_context` commits at turn end once every tool in the batch succeeds; automatic threshold and overflow rollover answers `session_before_compact`. The fork keeps native context windows. The host is detected when Posthorse loads.
- `createPosthorse(getPolicy)` lets SDK hosts on official Pi supply their live compaction settings.

### Changed

- Note writes use Posthorse's own same-directory replacement instead of the fork-only `publishLocalFile`, and writes and appends to one note run in order within a Pi process.
- Development baseline: Pi 0.87.1, TypeScript 7, typebox 1.3.34, npm 12. The Codex prototype uses MCP SDK v2 and is tested against Codex 0.157.1.

### Fixed

- Active tool size estimates count tools on official Pi, which reports tool names but not fork tool ids.
- After Pi's own `/compact`, automatic recovery records start at the compaction's kept tail and carry its summary as the prior checkpoint instead of re-listing summarized inputs, and a reminder the compaction summarized away no longer suppresses the next one.
- On the fork, bound oversized retained native receipts before fresh-window dispatch, including results completed during rollover preparation, through the synchronous `registerContextWindowHook`; excerpts share model capacity and preserve complete history or replacement recovery references.
- Align rollover guidance and request cards with native background work continuing across context resets, while foreground tools must succeed before an explicit rollover commits.
- Retain native async receipts across later complete responses during rollover, labeled as evidence that may already have been received or handled.
- Skip circular directory links and missing targets during note listing and search while preserving ordinary linked notes.
- Preserve completed asynchronous tool results during rollover when the response that started them fails or is interrupted.
- Keep namespaced `ask_question` results as ordinary tool evidence instead of treating them as owner answers during rollover.
- Read large history records without repeatedly copying and scanning their unfinished lines.
- Honor Pi context edits and native projection in automatic recovery handoffs, including assistant checkpoints and omitted asynchronous results. Still-visible results remain in the handoff even when their call was edited out or predates the window, without borrowing another call's identity or arguments. Edited handoff references recover replacement text and images through `history read`.
- Keep `history` searches and reads within the current project's session files and their nested subagents, even when distinct projects share a session directory.
- Qualify all-session history IDs by source file so search, pagination, and read distinguish entries that reuse a native ID. Fork copies now appear once per file rather than hiding unrelated matches.
- Count active namespaced tools when sizing handoffs and recovery pages.
- Paginate stored images in history reads so large image messages remain recoverable after a context reset. Continuations carry both text and image offsets.

## 0.5.0

- Requires a fork build exposing native `publishLocalFile`. Note replacements now preserve the previous content when publication fails; note locations and append behavior are unchanged.
- Shares the remaining context budget across notes list/search, history search, and read pages, including continuation metadata and no-match responses. Notes use character offsets; history search uses a query-bound cursor that progresses despite newly appended lookup echoes.
- Uses native system-prompt sections while preserving custom prompts and earlier full-prompt overrides.
- Removes checkpoint reminders from active input when compaction is disabled, while retaining their history entries.
- Labels carried tool results as a trailing batch without a later complete response; interrupted requests may already have received them.
- Describes the configured context limit accurately instead of claiming it is a measured provider hard limit.

## 0.4.6

- Preserves Unicode line and paragraph separators in archived Pi history and Codex prototype checkpoints instead of treating them as JSONL record boundaries.
- Shares the remaining context budget across parallel note and history reads, including returned images, paging metadata, and refusal text, without double-counting results already accounted for by Pi.
- Shares notes automatically when Git metadata is stored separately, including symlinked `.git` directories. Those repositories use the common Git directory; conventional repositories keep their existing location. Old local notes are imported without overwriting shared files or deleting originals.
- Preserves assistant failure status and provider error messages in searchable history.

## 0.4.5

- Adds native expandable cards for context budgets, notes, history, and context requests, with compact previews, result counts, and visible page ranges and continuation offsets.
- Keeps committed context-window handoffs and checkpoint reminders compact until expanded. Model-visible tool text, prompts, context policy, and stored note/history content are unchanged.
- Corrects update instructions to require restarting Pi to load new extension code.

## 0.4.4

- Skips full-branch lookups outside the checkpoint reminder band and when model input contains no checkpoint reminders.

## 0.4.3

Documentation correction; runtime behavior is unchanged.

- Clarifies npm installation and the reload step after package updates.
- Qualifies automatic rollover's compaction fallback and makes the README diagram link absolute.

## 0.4.2

- Shows current-window inputs and unconsumed tool results before the older checkpoint in automatic recovery records.
- Prioritizes original history matches over recovery notes, handoffs, and previous lookups without removing searchable entries or changing full reads.
- Reads each session file's modification time once when sorting, instead of repeatedly during comparisons.

## 0.4.1

Compatibility update for Pi 0.85.0; runtime behavior is unchanged.

- Updates the Pi development dependency and integration CI to the tested 0.85.0 fork.
- Clarifies that linked Pi installations must be rebuilt after updating their source.

## 0.4.0

Renamed to Posthorse (`pi-posthorse`). Requires the `fitchmultz/pi` fork at the revision pinned in the README.

- Claims Pi's automatic threshold and overflow trigger through the fork's new `session_before_auto_compact` hook, before summarization credentials or a summary region are required. A single oversized first turn, an oversized tool result, and a missing summarization login now all roll over.
- Carries the trailing tool batch that no model has consumed yet in the automatic handoff: call arguments, bounded result text, and the entry ids needed to recover the rest. Consumed batches and older assistant prose are still left out. Newly submitted input survives preflight rollover separately instead of being copied into the handoff.
- Returns stored images from `history read`, summarizes images as `[N images: type]` in search results and handoffs, and never embeds base64 in handoff text.
- Reports context as a best available native estimate; `get_context_remaining` shows tokens until Pi's rollover line and until the hard limit, or only the hard limit when compaction is disabled.
- Detects unsupported small-context configurations (fewer than 10,000 usable tokens) with an actionable message instead of rolling over every turn; explicit and automatic handoffs plus unknown-usage read pages leave half the fresh capacity after prompt/tool overhead and pending input free, while known-usage pages budget returned images, shrink to the remaining space, and preserve the offset when refused.
- Reads Pi's effective compaction settings through `ctx.getCompactionSettings()`, so untrusted project settings are ignored exactly as Pi ignores them.
- Fingerprints reminders by window, context size, and reserve; switching to a different context size gets a fresh reminder and stale ones are filtered. Legacy `headroom-reminder` entries remain recognized. The reminder band uses usable context rather than the full model window, avoiding immediate checkpoint loops with a large reserve.
- Notes resolve the repository root from nested directories and linked worktrees (absolute or relative `gitdir`), page long reads with `offset`, allow an empty write to clear a note, append one atomic newline-terminated record per call, and center search excerpts on the match.
- History flattens `bashExecution` entries (placeholder only when Pi marked them `excludeFromContext`), reports fork-copied entries once, and documents all-session ordering as newest-modified sessions first.
- Adds CI (Node 22.19 and 24), `prepublishOnly`, and `scripts/integration.sh`, which loads the real extension into the fork's test harness without API keys.

## 0.3.1

- Resolves `notes` to the main checkout when Pi runs inside a linked git worktree, so every worktree of a repository shares one notebook and notes outlive the worktree.

## 0.3.0

- Rebuilds automatic handoffs as bounded recovery records that retain direct user inputs, `ask_question` outcomes, visible coordination, and a clearly stale older checkpoint without inferring state from assistant prose.
- Lets Pi's enabled automatic compaction lifecycle own threshold, overflow, and restart rollovers; disabling compaction now disables automatic headroom behavior while leaving `new_context` available.
- Makes the checkpoint reminder imperative and best-effort, aligns its cutoff with Pi's first actual trigger token, and filters wrong-window reminders from model input.
- Searches nested session files and returns newest history matches first while keeping reads streaming and bounded.

## 0.2.2

- Keeps active work running across automatic rollovers without starting another response after completed work.
- Carries the current window's user requests and constraints into automatic handoffs.

## 0.2.1

- Streams archived history and stops at the requested entry or result limit, preventing heap exhaustion in large session directories and parallel reads.

## 0.2.0

- Replaces extension-only context slicing with Pi's native, persisted `context_window` boundary.
- Makes `new_context` atomic after the full tool batch and adds an optional persisted handoff.
- Replaces the per-request meter with stable guidance, one checkpoint reminder, and `get_context_remaining`.
- Converts automatic summary compaction into a no-summary rollover.
- Makes history search normalized and window-aware, with paginated reads for complete recovery.

## 0.1.3

- Follows the pi package contract: `typebox` and `@earendil-works/pi-coding-agent` are optional peer dependencies (pi provides them at runtime); the pinned copies moved to `devDependencies` for local validation only.
- Adds MIT license and package-gallery metadata.

## 0.1.2

- Declares `pi.extensions` in `package.json` so `pi install` actually discovers and loads the extension.

## 0.1.1

- `new_context` cuts persist across process restarts via a `headroom-cut` session entry (`firstKeptEntryId`); resume slices from the same point instead of reloading the full transcript.
- Guidance reads the user's real compaction settings and states the actual auto-compaction threshold; warns when compaction is disabled.

## 0.1.0

Initial release: live `[headroom]` context meter, `new_context` hard cutover tool, persistent notes in `.pi/notes/`, transcript history search.
