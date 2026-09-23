# Posthorse

**Fresh context. Same journey.** (POST-horse)

Native, no-summary context windows for the [`fitchmultz/pi`](https://github.com/fitchmultz/pi) fork of [Pi](https://github.com/earendil-works/pi). A post-horse was swapped in at relay stations so the courier and the message could continue on fresh legs. Posthorse does the same for a model: fresh context, same work, complete recoverable transcript.

![Posthorse flow](https://raw.githubusercontent.com/fitchmultz/pi-posthorse/main/diagram.png)

Pi owns the persisted boundary. Posthorse owns the policy: stable window guidance, one best-effort checkpoint reminder, `new_context`, `get_context_remaining`, durable `notes`, and window-aware `history`. A rollover removes the old window from active model context while the JSONL transcript stays append-only and complete.

An isolated [Codex prototype](adapters/codex-posthorse/README.md) tests local notes and recovery with Codex's native context reset. It is not ready for everyday use and is not included in the Pi package.

## Requirements

- Node `>=22.19.0`.
- The `fitchmultz/pi` fork. The native qualification target is `8fb7886130ff1fedc415bdd6fea03aef8a8957d8` (fork package version `0.87.0`). Posthorse needs the fork's native `context_window` entries, its `session_before_auto_compact` hook, `ctx.getCompactionSettings()`, and the coding-agent SDK's `publishLocalFile` export.
- Official, unpatched Pi is unsupported. Posthorse reports a clear extension error at session start and cannot operate; Pi itself keeps running.

## Install

Build the fork:

```bash
git clone https://github.com/fitchmultz/pi.git
cd pi
git checkout 8fb7886130ff1fedc415bdd6fea03aef8a8957d8
npm install --ignore-scripts
npm run build
```

After updating the fork, run the install and build commands again, then restart Pi. `pi --version` reads the checkout's package metadata, so it does not prove that the updated source has been built.

Run it as `node packages/coding-agent/dist/bundle/cli.js`, or run `npm link` inside `packages/coding-agent` so that build becomes your `pi` command.

Then install Posthorse with that `pi`:

```bash
pi install git:github.com/fitchmultz/pi-posthorse        # from Git; add @<tag> to pin a release
pi install npm:pi-posthorse                             # from npm
pi -e git:github.com/fitchmultz/pi-posthorse              # try it for one run without installing
```

Update with `pi update npm:pi-posthorse` or `pi update --extensions`; move a pinned Git install with `pi install git:github.com/fitchmultz/pi-posthorse@<new tag>`. Uninstall with `pi remove npm:pi-posthorse` (or the Git source you installed). Removing the package leaves `.pi/notes` and Pi's session history in place.

Restart Pi after installing or updating Posthorse to load the new extension code.

Keep exactly one copy loaded. `pi list` shows every package source; if an older entry such as `git:github.com/fitchmultz/pi-headroom.git` or a local checkout is still listed, `pi remove` it before installing the npm package, otherwise two copies register the same tools and compete for the same rollover hook.

## How it works

1. **Stable guidance.** Window behavior lives in a native system-prompt section. There is no per-request meter. Posthorse preserves custom prompts and falls back to appending guidance when an earlier extension replaces the full prompt; that compatibility path can prevent Pi from preserving an additive prompt prefix.
2. **One best-effort checkpoint.** While Pi compaction is enabled, one reminder may appear shortly before Pi's rollover line. A large turn, overflow, restart, or smaller model can reach rollover without it. Reminders are fingerprinted by window, context size, and reserve, so switching to a different context size gets a fresh reminder. Stale reminders and reminders left after disabling compaction are filtered from model input while remaining in history.
3. **`get_context_remaining`.** Reports the best available native estimate of tokens until Pi's automatic rollover line and until the configured context limit. That configured limit is not a measured provider rejection boundary. Pi's value is an estimate until the active model reports usage.
4. **`new_context`.** Requests an atomic rollover after the complete tool batch succeeds. An optional handoff is persisted and becomes the first state of the fresh window. If a sibling tool in the same batch fails, Pi does not commit the boundary; the checkpoint reminder still applies.
5. **Automatic rollover without summaries.** With a supported context budget and room for a recovery record, Posthorse claims Pi's automatic threshold and overflow trigger through `session_before_auto_compact`, before Pi resolves summarization credentials or prepares a summary. Oversized first turns and tool results can then roll over even without summarization credentials. Otherwise Pi's own compaction remains in control. Manual `/compact` is unchanged.
6. **Bounded recovery record.** The automatic handoff keeps direct user inputs, `ask_question` outcomes, visible coordination messages, and the trailing tool batch without a later complete assistant response: call arguments, bounded result text, and entry ids to recover the rest. Failed or interrupted requests may already have received those results. A clearly labeled, possibly stale older checkpoint comes last. Older assistant prose and earlier tool batches are not treated as current state. Newly submitted input stays separate and is saved after the boundary, not copied into the handoff.
7. **`notes` and `history`.** Notes are shared across linked worktrees, at the main checkout for conventional Git layouts or inside the common Git directory when metadata is stored separately. History searches normalized transcript text and returns stored images for a requested entry.

At turn end, Posthorse checks whether usage is in the reminder band before explicitly looking up the full branch. Context filtering skips its branch lookup when model input contains neither `posthorse-reminder` nor legacy `headroom-reminder` messages. Complete history remains available through paged searches and reads.

Automatic recovery is an emergency input record, not proof of progress. The fresh model is told to restore notes and todo state, inspect history when needed, and verify live state before taking stateful or external action.

## Settings

Posthorse follows Pi's effective `compaction` settings, including Pi's decision about whether project settings are trusted. Disabling `compaction.enabled` disables reminders and automatic rollover; `new_context` stays available.

The model's context window minus `compaction.reserveTokens` must leave at least 10,000 usable tokens. Below that (for example an 8K or 16K model with the default 16,384 reserve) Posthorse reports an unsupported configuration in the guidance and in `get_context_remaining`, turns automatic behavior off for that model, and leaves Pi's own compaction in place. Lower the reserve or use a larger model. The checkpoint reminder band is the last 10% of usable context, capped at 32,000 tokens, so a large reserve cannot trigger a reminder immediately in a fresh window.

Explicit and automatic handoffs are capped at 20,000 characters and half the active model's fresh operational capacity after prompt/tool overhead and any pending input, whichever is smaller. Oversized explicit handoffs are rejected with an instruction to save fuller state in notes; automatic rollover stays with Pi when no safe recovery record fits. When usage is not known yet, notes and history pages use the same model-aware limit.

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

Within each group, current-branch matches are newest first. With `all: true`, Posthorse searches every session file in the active Pi session directory, newest-modified sessions first and newest entries within each session; this is not a global timestamp sort. All-session hits use a file-qualified ID (`native-id@file-key`); pass the complete ID to `history read`. The source file is shown beside each hit, while its fixed-size key keeps cursors usable for nested session paths. The per-page result limit applies after priority, so newer echoes cannot displace older original matches. Copies whose parent session is in the searched directory are reported once; unrelated entries sharing a native ID stay distinct. Search cursors advance past the previous entry, including partial headers or excerpts, so appending lookup calls and results does not keep pagination alive forever. Searches are live: external session edits or file reordering can change results; start a new search to include newer sources.

Notes live in `.pi/notes/` at the main checkout for conventional Git layouts, or the current directory outside Git. When Git metadata is stored separately, including in submodules, all checkouts use `.pi/notes/` inside Git's common directory instead; no configuration is needed. If that metadata is unavailable, notes stay local to the checkout. Old checkout-local notes are imported when that checkout is accessed, without overwriting shared files or deleting the originals. Writes report the actual storage path. Add `.pi/notes/` to `.gitignore` when the project should not track it.

`write` uses Pi's native complete-file replacement: a failed write before publication leaves the previous note intact. It follows symlink targets and preserves ordinary permissions and ownership, or fails before publication. Hardlink aliases and already-open handles keep the previous file; ACLs, extended attributes, and power-loss durability are not guaranteed. Full replacements do not merge concurrent appends or other replacements. `append` retains one `O_APPEND` write per newline-terminated record.

## Data and privacy

- Posthorse makes no network requests.
- Notes are plaintext files under `.pi/notes`. They survive package removal and may be committed unless ignored.
- `history` with `all: true` scans nested JSONL files in the active Pi session directory, including subagent sessions.
- History can return user text, assistant text and thinking, assistant failure status and error messages, tool arguments and results, handoffs, custom messages, and images. Direct shell entries Pi marked `excludeFromContext` come back as a placeholder only.
- Returned history content enters the currently selected model and provider context.
- Removing Posthorse does not remove notes or Pi session history.

## Compatibility

Reminders persisted by pi-headroom (`headroom-reminder`) are recognized alongside `posthorse-reminder` for deduplication, filtering, and recovery records. Notes, tool names, `.pi/notes`, and Pi's `context_window` entries are unchanged.

## Develop

```bash
npm ci --ignore-scripts
npm run check  # public npm declarations can check types, but cannot run Posthorse
# After the compatibility runner installs the selected fork SDK/types cohort:
PI_COMPAT_HOST=fork npm run check:compat
PI_FORK=../pi scripts/integration.sh   # additional full source-harness integration (disposable fork built)
```

`npm run check` type-checks the extension, renderers, and tests against the exact 0.87.0 npm declaration baseline. Runtime tests require the qualified fork SDK, including `publishLocalFile`, installed in this checkout's dependency graph. `npm test` covers reminder policy, notes/history behavior, failed note replacement, and real native card components, including width, expansion, and legacy results. Tests use the public SDK entry; official Pi is not an operating target.

`check:compat` adds `test:native`: real SDK loading, prompt composition, mixed recovery-output budgets, cursor progress, reminder filtering, interrupted-response recovery, oversized-result rollover without summary compaction, explicit `new_context`, and checkpoint restore without provider replay. It requires native fork capabilities; it never substitutes synthetic windows or silently skips on official. The runner must install the fork cohort in this checkout's `node_modules` so both `tsc` and SDK imports resolve that graph. `PI_HOST_INDEX` and `PI_COMPAT_EXPECTED_PACKAGE_DIR` are verified against it, and `PI_COMPAT_EXPECTED_VERSION` verifies the version. A same-version official graph is not a fork. Official qualification is a separate actual CLI startup/refusal probe, not `check:compat`.

For a focused read-only SDK diagnostic only, `PI_HOST_INDEX=/absolute/fork/dist/index.js node --test test/native.test.mjs` can inspect an immutable host; this does not qualify this checkout's types. The larger source integration suite remains available through `scripts/integration.sh`; use a disposable built fork checkout because it briefly copies a test into that host. All native fixtures must use an isolated HOME/agent directory with offline mode and no provider credentials. These checks do not claim native Windows support.
