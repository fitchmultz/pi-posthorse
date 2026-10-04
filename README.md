# Posthorse

**Fresh context. Same journey.** (POST-horse)

No-summary context rollover for [Pi](https://github.com/earendil-works/pi), on official Pi and on the [`fitchmultz/pi`](https://github.com/fitchmultz/pi) fork. A post-horse was swapped in at relay stations so the courier and the message could continue on fresh legs. Posthorse does the same for a model: fresh context, same work, complete recoverable transcript.

![Posthorse flow](https://raw.githubusercontent.com/fitchmultz/pi-posthorse/main/diagram.png)

Pi owns the persisted boundary. Posthorse owns the policy: stable window guidance, one best-effort checkpoint reminder, `new_context`, `get_context_remaining`, durable `notes`, and window-aware `history`. A rollover removes the old window from active model context while the JSONL transcript stays append-only and complete.

## Requirements

- Node `>=24.12.0`.
- Pi `>=1.0.0`, official (`@earendil-works/pi-coding-agent`) or a maintained fork with the same public compaction contracts. No checkpoint, metadata iterator, or native context-window API is required.

Required qualification targets: latest stable official Pi and latest maintained fork `main`, resolved once per workflow run and retained with exact SDK/CLI identity evidence. Locked development dependencies are reproducible build snapshots, not validation targets. Historical official Pi `1.0.0` ([source `a13d35a`](https://github.com/earendil-works/pi/commit/a13d35a742c6ef8462812a28fbe1d8c8b7431c32)), TypeBox `1.3.27` and Node `24.21.0` evidence does not certify newer hosts. Qualification does not install, activate, or restart the live runtime.

## Install

Posthorse `0.8.0` requires Pi `>=1.0.0`. Update the host before installing this release; do not activate it on an older live fork.

```bash
pi install npm:pi-posthorse@0.8.0                        # from npm
pi install git:github.com/fitchmultz/pi-posthorse@v0.8.0 # from Git
pi -e npm:pi-posthorse@0.8.0                             # try it for one run without installing
```

Omit the version or tag to follow the latest release.

Update an unpinned install with `pi update npm:pi-posthorse` or `pi update --extensions`. Move a pinned install with `pi install npm:pi-posthorse@<new version>` or `pi install git:github.com/fitchmultz/pi-posthorse@<new tag>`. Uninstall with `pi remove` followed by the source you installed. Removing the package leaves `.pi/notes` and Pi's session history in place.

Restart Pi after installing or updating Posthorse to load the new extension code.

Keep exactly one copy loaded. `pi list` shows every package source; if a second source or a local checkout is listed, `pi remove` it, otherwise two copies register the same tools and compete for the same rollover hook.

## Official Pi and the fork

Both hosts get the same tools, guidance, reminders, notes, history, and recovery records. Rollover is a public compaction entry retaining no earlier conversation, with the handoff as its summary; no summary model is called. `new_context` commits at turn end only after Posthorse's own callback succeeds and every sibling tool succeeds. A foreign tool with the same name cannot authorize a rollover. Automatic rollover handles `session_before_compact`; manual `/compact` stays Pi's own summarization.

- **Native eligibility on both 1.0 targets:** Pi's compaction preparation must succeed before the automatic hook runs. Posthorse's custom compaction result bypasses the default summarizer and its credential lookup. With default `keepRecentTokens`, tiny overflow/truncated responses and a second large result without a new user turn can miss the hook. Lowering `keepRecentTokens` narrows, but does not eliminate, that gap. Oversized initial input can reach the provider before recovery.
- **Policy:** reminders and budget reports use persisted settings by default; automatic rollover uses the live settings in the event. SDK hosts can inject live policy with `createPosthorse(getPolicy)`. Handoffs appear as compaction-summary messages. Background work owned outside the foreground batch is not serialized or stopped by Posthorse.

Legacy fork `context_window` entries remain readable for history recovery. New boundaries do not use the retired native-window/async ABI. Opening legacy fork journals in official Pi can reintroduce earlier context because official Pi does not interpret those old markers; do not assume cross-host session migration.

## How it works

1. **Stable guidance.** Each request gets a native system-prompt section stating the best available native context capacity and, when automatic rollover is supported and enabled, its token threshold from the available Pi settings. Fresh windows get the same guidance, refreshed if the model or available settings change during a continuing turn. For virtual models, native limits can come from the routed physical model. These are capacity and policy limits, not remaining space. The guidance distinguishes context capacity from response-token limits and reasoning budgets, and requires a `get_context_remaining` check before reporting remaining tokens or changing plans because of context limits. Unknown usage stays unknown. There is no per-request meter or routine budget check. When an extension forces an opaque full prompt, Posthorse preserves it and supplies guidance as a request-local conversation message, because official Pi applies forced text after system-context hooks. Guidance is regenerated from current state rather than persisted in the transcript.
2. **One best-effort checkpoint.** While Pi compaction is enabled, one reminder may appear shortly before Pi's rollover line, asking the model to update its current-state note with available file-editing tools and call `new_context`. Already-current notes need no rewrite; `notes write` remains the fallback for creation, substantial restructuring, or unavailable editing tools. A large turn, overflow, restart, or smaller model can reach rollover without it. Reminders are fingerprinted by window, context size, and reserve, so switching to a different context size gets a fresh reminder. Stale reminders and reminders left after disabling compaction are filtered from model input while remaining in history.
3. **`get_context_remaining`.** Reports the best available native estimate of tokens until Pi's automatic rollover line and until the configured context limit. That configured limit is not a measured provider rejection boundary. Pi's value is an estimate until the active model reports usage. Check before claiming a remaining-token count or changing plans because of context limits. The checkpoint reminder marks the deadline, so routine budget checks are unnecessary.
4. **`new_context`.** Requests an atomic retain-none rollover once the current foreground tool batch succeeds. An optional handoff becomes the first state of the fresh window. Failed sibling writes, aborted turns, or a handoff that no longer fits after queued input prevent commitment. The request card is not proof that the boundary committed. Own successful callback IDs and admitted handoffs are consumed once at settlement; transcript names alone cannot request a reset.
5. **Automatic rollover without summaries.** When Pi reaches the public automatic hook with a supported budget, Posthorse builds a bounded recovery record and retains only an invisible boundary sentinel. Cancellation or recovery construction failure leaves active context intact rather than silently invoking a summarizer. Unsupported small-model budgets retain Pi's native fallback. Manual `/compact` is unchanged. Native eligibility limits are listed above.
6. **Bounded recovery record.** The automatic handoff quotes the window's first owner request, its latest owner input (a direct user input or `ask_question` outcome), and its latest input of any kind, including visible coordination messages. It adds tool result evidence: tool names and namespaces, call ids, requested and admitted execution arguments when available, result excerpts of up to 1,500 characters, and entry ids to recover the rest. Every other current-window input gets one index line with its label, time, and entry id; owner inputs keep a one-line preview there. Only a successful result positively linked to a projected unnamespaced `ask_question` call **and** an effective registered unnamespaced `ask_question` definition is an owner answer. Providers can omit call namespaces, so call metadata alone is insufficient. Namespaced, unregistered or unresolved-provenance results remain tool evidence, never owner approval. Legacy async results still visible in a projected journal remain eligible even across later complete assistant responses; this is history compatibility, not a new native-async execution path. A result Pi still projects is also eligible when its call was edited out or predates the window, without attributing it to another call. These results may already have been received or handled; they are not proof of current progress. Synchronous results with projected call provenance are kept only from the trailing batch without a later complete response. Pi context edits also apply to these inputs and results: omitted entries stay out, and replacements supersede their original content. A clearly labeled, possibly stale older checkpoint comes last. Older assistant prose is not treated as current state. Newly submitted input stays separate and is saved after the boundary, not copied into the handoff.
7. **`notes` and `history`.** Notes are shared across linked worktrees, at the main checkout for conventional Git layouts or inside the common Git directory when metadata is stored separately. History searches normalized transcript text, skips entries whose full text the model already sees in its active context (and says how many), and returns stored images for a requested entry. Edited-away originals and checkpoint reminders stay searchable. Tool calls and results retain names, namespaces, and call ids; admitted execution arguments are labeled separately from requested arguments when present. When a handoff carries edited content, its entry ID points to the replacement; `history read` of that ID returns the replacement text or images. Reading the original entry ID still returns the raw journal content.

Retain-none compaction removes prior tool receipts from active input; recovery records carry bounded excerpts and history IDs, while complete raw or edited receipts remain recoverable from the append-only journal. Posthorse no longer registers a native receipt-bounding hook. The host owns physical request sizing and output clamping; custom transports and raw payload replacements remain responsible for their request sizes.

Each synchronous safety evaluation lazily reads native usage and settings at most once, sharing them through guidance and page sizing. Requests, sibling tools, and final handoff admission each get a fresh snapshot; snapshots never survive an await. Official Pi still performs one uncached native usage acquisition when an evaluation needs it. Routed limits come only from that native reading, not a guessed virtual-model declaration.

Reminder lookup follows by-id ancestry to the latest Posthorse boundary and the entire native compaction kept range. It reuses certified append-only state, including negative results, and rebuilds on navigation, session changes, or changed entry identity. No history is capped or dropped. Below-band turns and reminder-free input skip that lookup; legacy window markers can identify the window directly. Automatic recovery reuses the branch supplied by Pi's compaction event. Complete history remains available through unchanged paged searches and reads.

Automatic recovery is an emergency input record, not proof of progress. The fresh model is told to restore notes and todo state, inspect history when needed, and verify live state before taking stateful or external action.

## Settings

Posthorse follows Pi's effective `compaction` settings, including Pi's decision about whether project settings are trusted. Disabling `compaction.enabled` disables reminders and automatic rollover; `new_context` stays available.

The model's context window minus `compaction.reserveTokens` must leave at least 10,000 usable tokens. Below that (for example an 8K or 16K model with the default 16,384 reserve) Posthorse reports an unsupported configuration in the guidance and in `get_context_remaining`, turns automatic behavior off for that model, and leaves Pi's own compaction in place. Lower the reserve or use a larger model. The checkpoint reminder band is the last 10% of usable context, capped at 32,000 tokens, so a large reserve cannot trigger a reminder immediately in a fresh window.

Explicit and automatic handoffs are capped at 20,000 characters and half the native context limit's fresh operational capacity after prompt/tool overhead and any pending input, whichever is smaller. Oversized explicit handoffs are rejected with an instruction to save fuller state in notes; automatic rollover cancels visibly when a supported configuration has no room for a safe recovery record. Notes and history pages are capped at 40,000 characters and shrink to the remaining budget; when usage is not known yet, they also leave half the fresh operational capacity free. Payload budgets reserve Posthorse's request-local guidance too, because native estimates can omit it.

Only one automatic compaction or rollover policy extension should be enabled at a time. Pi keeps the last non-cancel result from multiple handlers of the same hook, so load order would otherwise decide which policy wins.

## Tools

- `new_context({ handoff? })`
- `get_context_remaining()`
- `notes({ op, ... })`: `list`, `read`, and `search` are paged; continue with the returned character `offset`. `list` shows the absolute shared notes directory, then relative note names newest first with size and modification time (UTC), and takes an optional folder `path`; `read` of a folder returns its listing. File reads show the absolute file path before the content. Offsets refer to note content or listing rows, excluding path headers. `search` covers text notes, skipping binary files (a NUL byte in the first 8,000 bytes, as Git decides), and its excerpts center on the match. `write` replaces content (empty content clears); `append` adds one newline-terminated record.
- `history({ op, ... })`: `search` skips entries whose full text is already in the active context, continues with the returned `cursor` and the same `query` and `all` scope, and treats `limit` as the maximum results per page. `read` pages text and stored images; continue with the returned character `offset` and `imageOffset`. An image-only continuation can use an `offset` equal to the text length. If a page needs fresh context, retry with both offsets unchanged. Results keep native entry and window ids.

In the TUI, tools use Pi's native expandable cards. Collapsed cards show the operation and target, a short content preview, and counts or page ranges with the next offset when more remains. Expand with Pi's tool-output shortcut (`Ctrl+O` by default), or click the card's header or body in fullscreen mode. Expanded cards show the complete returned page and its metadata, not content the tool has not fetched yet. Writes and context requests also show the submitted content or handoff.

The `new_context` tool card describes a request, not a completed reset. Pi's native compaction card (`Compacted from … tokens`) shows the committed current boundary and expands to its handoff. Context-window cards are historical fork boundaries only; checkpoint reminders remain compact, expandable cards too.

Notes list/search and history search share the remaining context budget with read pages and returned images. Search/list headers, continuation text, no-match responses, and parallel sibling results count toward that budget; pages already counted by Pi are not counted twice. Before usage is known, pages reserve prompt/tool overhead and leave half the rest free. Unsafe pages are refused with the offset or cursor preserved in the call; call `new_context` and retry. Refusal text uses the same budget, so later failures omit repeated guidance once no more fits.

`history search` puts matching original content before recovery material: handoffs, compaction and branch summaries, checkpoint reminders, and `notes`, `new_context`, and `history` calls/results. Ordinary prose or another tool call in the same assistant entry keeps its priority when that content matches. Every entry remains searchable; `history read` returns the complete normalized entry, including any recovery content omitted from a search excerpt.

Within each group, current-branch matches are newest first. With `all: true`, Posthorse searches session files in the active Pi session directory whose saved working directory matches the current one, along with their nested subagent sessions and the selected current session file when it is in that directory. Files without a valid session header or an attributable working directory are excluded; the active branch remains available. Within that scope, sessions are ordered newest-modified first and entries newest first; this is not a global timestamp sort. All-session hits use a file-qualified ID (`native-id@file-key`, with a 10-character key); pass the complete ID to `history read`. Full-length keys printed by earlier releases still read. Hits from nested subagent runs are tagged `[subagent]`, because their user-role input came from a parent agent. A read that resolves a bare ID in another session file prints that entry's qualified ID, so continuations reopen the same file. When ripgrep is available (Pi's managed copy, then `PATH`), all-session search and bare-ID reads skip session files that cannot contain the query or ID. A query that could match text session files store escaped (quotes, backslashes) or label text that exists only in normalized entries (brackets, parentheses, braces, colons, `$`, leading or trailing spaces, or phrases such as "Call ID" and "No handoff") scans every file instead. Image summaries come only from entries with an image block, so image-count and comma queries also search every file that has one. Either way, results match a full scan. The per-page result limit applies after priority, so newer echoes cannot displace older original matches. Each included session file contributes its own matches, including fork copies, so unrelated entries sharing a native ID are never hidden. Search cursors advance past the previous entry, including partial headers or excerpts, so appending lookup calls and results does not keep pagination alive forever. Searches are live: external session edits or file reordering can change results; start a new search to include newer sources.

Notes live in `.pi/notes/` at the main checkout for conventional Git layouts, or the current directory outside Git. When Git metadata is stored separately, including in submodules, all checkouts use `.pi/notes/` inside Git's common directory instead; no configuration is needed. If that metadata is unavailable, notes stay local to the checkout. Reads, listings, and writes report the actual storage location. Add `.pi/notes/` to `.gitignore` when the project should not track it.

Keep one concise current-state note per task, preserving decisions and safety constraints and linking fuller evidence or history. For existing notes, edit changed sections with an available file-editing tool (`apply_patch`, `replace_text`, or Pi's `edit`) rather than resending the whole file. Use the absolute path returned by `notes read`, or join the directory from `notes list` with the relative note name: a worktree's local `.pi/notes/` may not be the shared location. The notes tool's own `path` argument remains relative to the shared notes directory. No Posthorse-specific editor is required, and failed sibling edits still prevent an explicit `new_context` reset.

`write` is a complete-file replacement in the note's directory: a failed write before publication leaves the previous note intact. It follows symlink targets and preserves ordinary permissions and ownership, or fails before publication. Hardlink aliases and already-open handles keep the previous file; ACLs, extended attributes, and power-loss durability are not guaranteed. Within one Pi process, writes and appends to the same note run in order; across processes, full replacements do not merge concurrent appends or other replacements. `append` retains one `O_APPEND` write per newline-terminated record.

## Data and privacy

- For cached-token cost diagnosis and a safe stock-compaction comparison, see the [cached-token investigation](https://github.com/fitchmultz/pi-posthorse/blob/main/ARTIFACTS/investigation-report.md). It does not establish the cause of a production bill or claim a measured cost improvement.
- Posthorse makes no network requests.
- Notes are plaintext files under `.pi/notes`. They survive package removal and may be committed unless ignored.
- `history` with `all: true` scans project-matching JSONL files and their nested subagent sessions in the active Pi session directory, not unrelated projects that share that directory. It runs ripgrep locally over that directory when available.
- History can return user text, assistant text and thinking, assistant failure status and error messages, tool arguments and results, handoffs, custom messages, and images. Direct shell entries Pi marked `excludeFromContext` come back as a placeholder only.
- Returned history content enters the currently selected model and provider context.
- Removing Posthorse does not remove notes or Pi session history.

For latest-host qualification, run `node /path/to/automation/scripts/qualify.mjs --repo pi-posthorse --source "$PWD" --host official --target latest --output /tmp/pi-posthorse-official`, then qualify the packed latest maintained fork with `--host fork --target /path/to/fork-package`. Plain `npm ci` checks only the locked development snapshot, not latest qualification.

## Automatic npm releases (maintainers)

Follow the [shared release procedure](https://github.com/fitchmultz/.github#automatic-npm-releases): merge a reviewed PR into `main` with an intentional `package.json` version bump and a matching versioned `CHANGELOG.md` section. Once configured and enabled, publication is unattended after the full existing CI workflow and candidate-tarball qualification pass. Complete any applicable package-specific release evidence before merging the bump. Automation never bumps versions, overwrites releases, or republishes an existing version; existing manual publisher instructions remain valid.

Failed/unpublished candidates can retry daily at 12:17 UTC or via manual dispatch of `npm release` on `main`, without another bump. Set repository variable `NPM_RELEASE_ENABLED` to anything other than `true` to stop new release plans; cancel pending runs separately when needed. Workflow validation is not evidence of a completed real OIDC publication.

## Develop

```bash
npm ci --ignore-scripts
npm run check:compat                   # typecheck, unit tests, and the real-SDK suite for the installed host
```

`npm run check` type-checks the extension, renderers, and tests against the official npm declarations. `npm test` covers reminder policy, notes/history behavior, failed note replacement, and real native card components, including width and expansion.

Development dependency policy: update TypeBox alongside the Pi cohort to match the host's version, not independently. Official 1.0 uses 1.3.27. The earlier 0.99.2 startup investigation is historical, not a current support target or a claim about 1.0 performance. Qualify later releases against their actual packaged SDK/CLI and companion graph; resolve companions relative to coding-agent because its shrinkwrap nests dependencies. Revisit the TypeBox pin when the host changes its dependency.

Native session suites own registration, question-outcome provenance, reminder delivery, and active-context history exclusions (both Posthorse rollover and native compaction). Unit tests retain distinct policy arithmetic, archive/storage edge cases, and performance bounds; renderer tests exercise actual native cards.

`test:native` runs public-API suites against the installed real SDK, covering native recovery eligibility and physical request boundaries, real loading, prompt composition, explicit/automatic rollover without a summary call, owner-provenance safety, failed siblings, cancellation, queued input, recovery records, notes and history. The 1.0 fork starts from official semantics; old fork checkpoint and early-compaction customizations are not current contracts. Legacy saved-window and async-result data remain recoverable; no retired runtime ABI or blanket skips are needed. `PI_COMPAT_HOST` labels the selected distribution; `PI_HOST_INDEX`, `PI_COMPAT_EXPECTED_PACKAGE_DIR` and `PI_COMPAT_EXPECTED_VERSION` validate the actual selected graph. Typechecking uses that graph too, never an optional fork method as a distribution heuristic.

For a focused read-only SDK diagnostic only, `PI_HOST_INDEX=/absolute/fork/dist/index.js node --test test/native.test.mjs` can inspect an immutable host; this does not qualify this checkout's types. The canonical real-SDK suites replace the obsolete source-copying fork harness; validation never needs to write into a host checkout. All native fixtures must use an isolated HOME/agent directory and short TMPDIR outside real-home ancestry, with no project markers in temporary-path ancestors, offline mode and no provider credentials. These checks do not claim native Windows support.
