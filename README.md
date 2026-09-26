# Posthorse

**Fresh context. Same journey.** (POST-horse)

No-summary context rollover for [Pi](https://github.com/earendil-works/pi), on official Pi and on the [`fitchmultz/pi`](https://github.com/fitchmultz/pi) fork. A post-horse was swapped in at relay stations so the courier and the message could continue on fresh legs. Posthorse does the same for a model: fresh context, same work, complete recoverable transcript.

![Posthorse flow](https://raw.githubusercontent.com/fitchmultz/pi-posthorse/main/diagram.png)

Pi owns the persisted boundary. Posthorse owns the policy: stable window guidance, one best-effort checkpoint reminder, `new_context`, `get_context_remaining`, durable `notes`, and window-aware `history`. A rollover removes the old window from active model context while the JSONL transcript stays append-only and complete.

An isolated [Codex prototype](adapters/codex-posthorse/README.md) tests local notes and recovery with Codex's native context reset. It is not ready for everyday use and is not included in the Pi package.

## Requirements

- Node `>=24.12.0`.
- Official Pi (`@earendil-works/pi-coding-agent`) or the `fitchmultz/pi` fork. Posthorse detects the host when it loads; no configuration is needed.

Qualified against official Pi `0.87.1` and fork commit [`b1b4ac34d807b577d66f5879119a9ed4833c8ed7`](https://github.com/fitchmultz/pi/commit/b1b4ac34d807b577d66f5879119a9ed4833c8ed7). CI uses these exact versions.

## Install

```bash
pi install npm:pi-posthorse                             # from npm
pi install git:github.com/fitchmultz/pi-posthorse        # from Git; add @<tag> to pin a release
pi -e npm:pi-posthorse                                  # try it for one run without installing
```

Update with `pi update npm:pi-posthorse` or `pi update --extensions`; move a pinned Git install with `pi install git:github.com/fitchmultz/pi-posthorse@<new tag>`. Uninstall with `pi remove npm:pi-posthorse` (or the Git source you installed). Removing the package leaves `.pi/notes` and Pi's session history in place.

Restart Pi after installing or updating Posthorse to load the new extension code.

Keep exactly one copy loaded. `pi list` shows every package source; if a second source or a local checkout is listed, `pi remove` it, otherwise two copies register the same tools and compete for the same rollover hook.

## Official Pi and the fork

Both hosts get the same tools, guidance, reminders, notes, history, and recovery records. The rollover itself differs:

- **Fork.** Rollover is a native `context_window` entry: the old window leaves model context and only a short boundary message plus the handoff remains. Posthorse claims automatic rollover through `session_before_auto_compact`, before Pi prepares a summary or resolves summarization credentials, bounds retained tool receipts before the fresh window is published, reads Pi's live compaction settings, and lets native background tool calls continue across the reset.
- **Official Pi.** Rollover is a compaction entry that keeps no earlier conversation and whose summary is the handoff; no summary model is called. `new_context` commits at turn end after every tool in the batch succeeds. Automatic rollover answers Pi's `session_before_compact` for threshold and overflow triggers; manual `/compact` stays Pi's own summary.

Official Pi limits that the fork removes:

- The handoff appears as Pi's compaction-summary message.
- Automatic rollover runs only when Pi's compaction preparation finds something to compact and summarization credentials resolve. With the default `keepRecentTokens`, a small overflow or truncated response, or a second large tool result without a new user turn, can skip it; lowering `keepRecentTokens` narrows that gap.
- Reminders and `get_context_remaining` read persisted settings (a CLI snapshot), because extensions cannot read Pi's live settings. Automatic rollover itself uses the live settings Pi passes to the hook. SDK hosts can pass their live settings with `createPosthorse(getPolicy)`.
- Retained tool receipts are not shortened before the fresh window.
- Sessions are not migrated between hosts. Official Pi ignores fork `context_window` entries, so a fork session opened in official Pi can bring earlier history back into context.

## How it works

1. **Stable guidance.** Window behavior lives in a native system-prompt section. There is no per-request meter. Posthorse preserves custom prompts and falls back to appending guidance when an earlier extension replaces the full prompt; that compatibility path can prevent Pi from preserving an additive prompt prefix.
2. **One best-effort checkpoint.** While Pi compaction is enabled, one reminder may appear shortly before Pi's rollover line. A large turn, overflow, restart, or smaller model can reach rollover without it. Reminders are fingerprinted by window, context size, and reserve, so switching to a different context size gets a fresh reminder. Stale reminders and reminders left after disabling compaction are filtered from model input while remaining in history.
3. **`get_context_remaining`.** Reports the best available native estimate of tokens until Pi's automatic rollover line and until the configured context limit. That configured limit is not a measured provider rejection boundary. Pi's value is an estimate until the active model reports usage.
4. **`new_context`.** Requests an atomic rollover after the current foreground (synchronous) tools succeed. Items 4–6 and the receipt bounding below describe the fork; official Pi differences are listed above. An optional handoff is persisted and becomes the first state of the fresh window. A failed synchronous checkpoint save or other foreground sibling prevents Pi from committing the boundary; the checkpoint reminder still applies. Native asynchronous background calls continue across the reset without delaying it. Pi preserves their call provenance and delivers their results in the fresh context.
5. **Automatic rollover without summaries.** With a supported context budget and room for a recovery record, Posthorse claims Pi's automatic threshold and overflow trigger through `session_before_auto_compact`, before Pi resolves summarization credentials or prepares a summary. Oversized first turns and tool results can then roll over even without summarization credentials. Native asynchronous background calls can remain in progress across automatic rollover too. When a recovery record cannot fit but Pi will retain native receipts in the next window, Posthorse claims a window without a handoff so Pi can prepare and bound those receipts or refuse the window. Already-consumed receipts do not trigger an empty rollover. Otherwise Pi's own compaction remains in control. Manual `/compact` is unchanged.
6. **Bounded recovery record.** The automatic handoff keeps direct user inputs, `ask_question` outcomes, visible coordination messages, and tool result evidence: tool names and namespaces, call ids, requested and admitted execution arguments when available, bounded result text, and entry ids to recover the rest. Native async results from the current projected window remain eligible even across later complete assistant responses, since a result can arrive during a response that never received it. A result Pi still projects is also eligible when its call was edited out or predates the window, without attributing it to another call. These results may already have been received or handled; they are not proof of current progress. Synchronous results with projected call provenance are kept only from the trailing batch without a later complete response. Pi context edits also apply to these inputs and results: omitted entries stay out, and replacements supersede their original content. A clearly labeled, possibly stale older checkpoint comes last. Older assistant prose is not treated as current state. Newly submitted input stays separate and is saved after the boundary, not copied into the handoff.
7. **`notes` and `history`.** Notes are shared across linked worktrees, at the main checkout for conventional Git layouts or inside the common Git directory when metadata is stored separately. History searches normalized transcript text and returns stored images for a requested entry. Tool calls and results retain names, namespaces, and call ids; admitted execution arguments are labeled separately from requested arguments when present. When a handoff carries edited content, its entry ID points to the replacement; `history read` of that ID returns the replacement text or images. Reading the original entry ID still returns the raw journal content.

Before each fresh window becomes active, Posthorse bounds oversized retained native receipts through append-only context edits. It shares the available capacity across all receipts after accounting for the prompt, tools, pending input, handoff, carried calls, Pi's configured reserve when automatic rollover is enabled and supported, and a safety margin. Pi separately clamps each provider request's output limit to its remaining context capacity. When receipts need shortening, excerpts use half the remaining capacity so the next response has working room. Excerpts retain the native call/result identity and error state, with `history read` references for complete recovery, including images. Existing replacements remain the recovery source across later windows; raw pre-edit content is never used for a new excerpt. Already-fitting receipts stay unchanged. If fixed input and recovery references cannot fit, rollover fails visibly without publishing a window marker or any proposed edits. Later prompts retry preparation against the unchanged window; correcting the configuration allows ordinary rollover to proceed. Pi independently refuses estimated native transcript input that exceeds physical context capacity, including when compaction is disabled. Its output clamp still permits fitting requests with reduced output, even above the compaction reserve line. Raw wire replacements through `onPayload` / `before_provider_request` and custom transport implementations retain responsibility for their own request sizing.

At turn end, Posthorse checks whether usage is in the reminder band before explicitly looking up the full branch. Context filtering skips its branch lookup when model input contains no `posthorse-reminder` messages. Complete history remains available through paged searches and reads.

Automatic recovery is an emergency input record, not proof of progress. The fresh model is told to restore notes and todo state, inspect history when needed, and verify live state before taking stateful or external action.

## Settings

Posthorse follows Pi's effective `compaction` settings, including Pi's decision about whether project settings are trusted. Disabling `compaction.enabled` disables reminders and automatic rollover; `new_context` stays available.

The model's context window minus `compaction.reserveTokens` must leave at least 10,000 usable tokens. Below that (for example an 8K or 16K model with the default 16,384 reserve) Posthorse reports an unsupported configuration in the guidance and in `get_context_remaining`, turns automatic behavior off for that model, and leaves Pi's own compaction in place. Lower the reserve or use a larger model. The checkpoint reminder band is the last 10% of usable context, capped at 32,000 tokens, so a large reserve cannot trigger a reminder immediately in a fresh window.

Explicit and automatic handoffs are capped at 20,000 characters and half the active model's fresh operational capacity after prompt/tool overhead and any pending input, whichever is smaller. Oversized explicit handoffs are rejected with an instruction to save fuller state in notes; automatic rollover stays with Pi when no safe recovery record fits and no native receipts require fresh-window preparation. When usage is not known yet, notes and history pages use the same model-aware limit.

Only one automatic compaction or rollover policy extension should be enabled at a time. Pi keeps the last non-cancel result from multiple handlers of the same hook, so load order would otherwise decide which policy wins.

## Tools

- `new_context({ handoff? })`
- `get_context_remaining()`
- `notes({ op, ... })`: `list`, `read`, and `search` are paged; continue with the returned character `offset`. Search excerpts center on the match. `write` replaces content (empty content clears); `append` adds one newline-terminated record.
- `history({ op, ... })`: `search` continues with the returned `cursor` and the same `query` and `all` scope; `limit` is the maximum results per page. `read` pages text and stored images; continue with the returned character `offset` and `imageOffset`. An image-only continuation can use an `offset` equal to the text length. If a page needs fresh context, retry with both offsets unchanged. Results keep native entry and window ids.

In the TUI, tools use Pi's native expandable cards. Collapsed cards show the operation and target, a short content preview, and counts or page ranges with the next offset when more remains. Expand with Pi's tool-output shortcut (`Ctrl+O` by default), or click the card's header or body in fullscreen mode. Expanded cards show the complete returned page and its metadata, not content the tool has not fetched yet. Writes and context requests also show the submitted content or handoff.

Committed context-window messages and checkpoint reminders are compact, expandable cards too. The `new_context` tool card describes a request; only the committed context-window message says a fresh window has started.

Notes list/search and history search share the remaining context budget with read pages and returned images. Search/list headers, continuation text, no-match responses, and parallel sibling results count toward that budget; pages already counted by Pi are not counted twice. Before usage is known, pages reserve prompt/tool overhead and leave half the rest free. Unsafe pages are refused with the offset or cursor preserved in the call; call `new_context` and retry. Refusal text uses the same budget, so later failures omit repeated guidance once no more fits.

`history search` puts matching original content before recovery material: handoffs, compaction and branch summaries, checkpoint reminders, and `notes`, `new_context`, and `history` calls/results. Ordinary prose or another tool call in the same assistant entry keeps its priority when that content matches. Every entry remains searchable; `history read` returns the complete normalized entry, including any recovery content omitted from a search excerpt.

Within each group, current-branch matches are newest first. With `all: true`, Posthorse searches session files in the active Pi session directory whose saved working directory matches the current one, along with their nested subagent sessions and the selected current session file when it is in that directory. Files without a valid session header or an attributable working directory are excluded; the active branch remains available. Within that scope, sessions are ordered newest-modified first and entries newest first; this is not a global timestamp sort. All-session hits use a file-qualified ID (`native-id@file-key`); pass the complete ID to `history read`. The source file is shown beside each hit, while its fixed-size key keeps cursors usable for nested session paths. The per-page result limit applies after priority, so newer echoes cannot displace older original matches. Each included session file contributes its own matches, including fork copies, so unrelated entries sharing a native ID are never hidden. Search cursors advance past the previous entry, including partial headers or excerpts, so appending lookup calls and results does not keep pagination alive forever. Searches are live: external session edits or file reordering can change results; start a new search to include newer sources.

Notes live in `.pi/notes/` at the main checkout for conventional Git layouts, or the current directory outside Git. When Git metadata is stored separately, including in submodules, all checkouts use `.pi/notes/` inside Git's common directory instead; no configuration is needed. If that metadata is unavailable, notes stay local to the checkout. Writes report the actual storage path. Add `.pi/notes/` to `.gitignore` when the project should not track it.

`write` is a complete-file replacement in the note's directory: a failed write before publication leaves the previous note intact. It follows symlink targets and preserves ordinary permissions and ownership, or fails before publication. Hardlink aliases and already-open handles keep the previous file; ACLs, extended attributes, and power-loss durability are not guaranteed. Within one Pi process, writes and appends to the same note run in order; across processes, full replacements do not merge concurrent appends or other replacements. `append` retains one `O_APPEND` write per newline-terminated record.

## Data and privacy

- Posthorse makes no network requests.
- Notes are plaintext files under `.pi/notes`. They survive package removal and may be committed unless ignored.
- `history` with `all: true` scans project-matching JSONL files and their nested subagent sessions in the active Pi session directory, not unrelated projects that share that directory.
- History can return user text, assistant text and thinking, assistant failure status and error messages, tool arguments and results, handoffs, custom messages, and images. Direct shell entries Pi marked `excludeFromContext` come back as a placeholder only.
- Returned history content enters the currently selected model and provider context.
- Removing Posthorse does not remove notes or Pi session history.

## Develop

```bash
npm ci --ignore-scripts
npm run check:compat                   # typecheck, unit tests, and the real-SDK suite for the installed host
PI_FORK=../pi scripts/integration.sh   # additional full source-harness integration (disposable fork built)
```

`npm run check` type-checks the extension, renderers, and tests against the official npm declarations. `npm test` covers reminder policy, notes/history behavior, failed note replacement, and real native card components, including width and expansion.

`test:native` runs the real-SDK suite for whichever host is installed: `test/official.test.mjs` for official Pi, `test/native.test.mjs` when the fork SDK is installed. Both cover real SDK loading, prompt composition, explicit and automatic rollover without a summary request, recovery records, notes, and history; the fork suite adds receipt bounding, native async calls, and checkpoint restore. When `PI_COMPAT_HOST` is `fork` or `official`, a mismatch with the installed SDK fails instead of running the other suite. The shared compatibility runner installs each host's SDK cohort in this checkout's `node_modules` so both `tsc` and SDK imports resolve that graph; `PI_HOST_INDEX` and `PI_COMPAT_EXPECTED_PACKAGE_DIR` are verified against it, and `PI_COMPAT_EXPECTED_VERSION` verifies the version.

For a focused read-only SDK diagnostic only, `PI_HOST_INDEX=/absolute/fork/dist/index.js node --test test/native.test.mjs` can inspect an immutable host; this does not qualify this checkout's types. The larger source integration suite remains available through `scripts/integration.sh`; use a disposable built fork checkout because it briefly copies a test into that host. All native fixtures must use an isolated HOME/agent directory with offline mode and no provider credentials. These checks do not claim native Windows support.
