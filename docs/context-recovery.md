# Context recovery: guarantees and limits

Posthorse is a no-summary rollover policy plus tools for recovering earlier work. It is useful when
exact evidence and explicit task notes matter more than an automatically written narrative of the
conversation. Recovery is available to the model, not guaranteed recall by the model.

This guide describes the current source checkout. Safe recent-tail retention on automatic rollover
and the notes-only reminder are listed under [Unreleased](../CHANGELOG.md#unreleased); they are not
released changes until included in a versioned release. Check your installed version against the
changelog rather than assuming the default-branch documentation describes it.

## What changes compared with stock Pi?

Stock Pi already preserves the session journal when it compacts. Its normal compaction combines a
model-generated summary with a recent-message tail, selected using `compaction.keepRecentTokens`.
Posthorse does not introduce transcript persistence, and stock compaction does not simply erase
all recent messages.

With Posthorse loaded:

| Path                               | What the next context receives                                                        | Summary-model call        |
| ---------------------------------- | ------------------------------------------------------------------------------------- | ------------------------- |
| Supported automatic rollover       | A bounded recovery record and a safe recent-message tail, reduced if necessary to fit | No                        |
| Explicit `new_context`             | Optional handoff, with no prior messages retained                                     | No                        |
| Manual `/compact`                  | Pi's normal summary and retained tail                                                 | Pi's normal summarization |
| Unsupported small automatic budget | Pi's native compaction fallback                                                       | May use Pi's summarizer   |

The practical additions are shared `notes`, model-callable `history` search/read, context guidance,
and a best-effort checkpoint nudge. The automatic record is assembled from selected inputs, tool
evidence and history pointers; it is **not an automatic narrative summary of completed work**.
The model still needs to read notes or history and check live state. There is no universal claim
that this policy is better than stock compaction for every task.

See the [reference](reference.md#how-it-works) for record selection, provenance and budget details,
and Pi's [compaction reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)
for the stock algorithm.

## Available evidence is not guaranteed recall

Automatic rollover keeps safely paired recent messages according to Pi's effective
`compaction.keepRecentTokens`. The budget is approximate: Posthorse can shrink the tail past whole
groups or retain none if no safe group fits. Setting it to zero explicitly keeps no messages.
The recovery record is also bounded, with selected inputs, short tool-result excerpts and entry
IDs rather than the full discarded conversation. Explicit `new_context` deliberately keeps no
recent tail.

Earlier material remains recoverable from the saved journal, subject to the tool's scope and
normalization. That does not mean all of it is in the next request, will be searched for, will match
the chosen query, or will be interpreted correctly. A carried owner request may already be handled;
a tool receipt or old note is evidence of a past event, not proof of current state. The model is
instructed to restore task state and verify it before taking stateful or external action, but those
instructions are not an enforcement mechanism for every downstream action.

### Search is literal and scoped

- `history search` and `notes search` use case-insensitive text matching, not semantic retrieval.
  Try exact paths, tool names, distinctive phrases or call IDs; synonyms alone may not match.
- History searches normalized entry text, not arbitrary files or the visual contents of images.
  Use `history read` to retrieve an entry's stored images and remaining text.
- By default, history searches the active branch and skips entries whose full text is already in
  active context. `all: true` adds eligible session files in the active Pi session directory whose
  saved working directory matches, plus their nested subagent sessions. It is not a search of every
  project, every worktree or every session directory on the machine.
- Follow the returned search cursor, text offset and image offset. A page or excerpt is not the
  complete result. Pages share the remaining context budget and may require a fresh context before
  they can be read safely. All-session hits have file-qualified IDs; keep the complete ID for reads.
- Notes search skips binary files and files larger than 1 MiB. Search results are live, not an
  immutable snapshot; external edits or session-file reordering can change later pages.

The [tool reference](reference.md#tools) covers ordering, pagination and exact archive scope.

## Checkpoints and lifecycle boundaries

The notes reminder is a best-effort nudge during a working run, not a successful note write or a
transactional checkpoint. It does not wake a finished agent or require a reset. A large turn,
overflow, restart or model change can reach rollover without the reminder; the model can also fail
to update the note. Save important decisions and constraints as you work, rather than waiting for
the nudge.

`new_context` is admitted only after its own successful callback and successful foreground sibling
tools; errors, aborted turns or a handoff that no longer fits can prevent commitment. Its request
card is not confirmation. Look for Pi's committed compaction card. Background work outside that
foreground batch is neither stopped nor serialized by rollover; inspect its actual status before
repeating an operation.

Cancellation is not a rollback guarantee. In official Pi 1.3.0, explicit resets and the eager
turn-end threshold fallback return boundary drafts before later handlers finish. The host commits
the final drafts without another abort check, so a late abort after Posthorse's checks need not
prevent that boundary from being saved. This is distinct from native automatic compaction, which
checks its compaction abort signal after `session_before_compact` handlers and before appending.
Do not assume `ctx.abort()` retracts persisted boundaries or other completed side effects.

Automatic rollover is not a guarantee that every provider request fits:

- Pi must successfully prepare compaction before the automatic hook runs. Posthorse additionally
  handles a supported threshold case at completed turn end in fresh windows without a subsequent
  projected turn-start input; it does not replace Pi's entire recovery scheduler.
- Overflow and truncated-response recovery remain host-owned. Some tiny responses can miss native
  recovery, and oversized initial input can reach the provider first. The configured context limit
  and `get_context_remaining` are capacity estimates, not measured provider acceptance boundaries.
- The native automatic hook cannot inspect not-yet-drained queued message bodies. Recovery headroom
  is not a strict bound on arbitrary later input. The host and custom transports own physical request
  sizing and output clamping.
- Keep one Posthorse copy and one automatic compaction policy loaded. Other projection-editing
  handlers can affect the eager turn-end fallback; handler ordering matters. See the
  [settings reference](reference.md#settings) before combining lifecycle extensions.

These boundaries depend on the exact host version. See [host compatibility](reference.md#official-pi-and-the-fork),
including the warning about opening legacy fork `context_window` journals in official Pi.

## Context edits are not deletion or a privacy boundary

Recovery construction respects Pi's projected context: omitted entries stay out and replacements
supersede their originals there. The underlying journal is still append-only. Edited-away originals
remain searchable; reading an original entry ID returns its raw journal content, while a replacement
ID returns the replacement. Removing text from active context therefore does not erase it from
storage or prevent later retrieval.

Posthorse makes no network requests, but notes and retrieved history become input to the selected
model and provider. History can include thinking, tool arguments, failures and images. Notes are
plaintext, shared across linked Git worktrees, and may be committed unless ignored. Uninstalling
Posthorse does not remove notes or Pi history. Use the actual paths reported by the tools and your
storage/provider policies for sensitive data; do not treat a rollover or context edit as redaction.
See [storage and privacy](reference.md#data-and-privacy).

## Shared notes and concurrent work

Use concise current-state notes recording constraints, decisions, exact evidence locations and next
steps. For concurrent agents, use separate per-agent/task files or an explicit single-writer handoff.
Prefer targeted file edits for small changes instead of repeatedly sending an entire note, but only
when that writer owns the note. Read the actual shared path from `notes list` or `notes read` rather
than assuming that a worktree-local `.pi/notes/` is the storage location.

The notes tool orders writes and appends to the same note within one Pi process. Across processes,
full-file replacements do not merge concurrent edits or appends; a later replacement can overwrite
another writer's work. Do not replace or edit a note while another process appends to it. External
file-editing tools can also perform read/modify/write operations that overwrite concurrent changes.
The notes tool's replacement uses atomic publication: readers see the old or new file, not a partly
written replacement. That is not a cross-process transaction or a promise of power-loss durability,
ACL or extended-attribute preservation. These guarantees do not extend automatically to external
editors.

## Cost and a practical recovery routine

Skipping the automatic summary call does not guarantee lower total cost. Large retained contexts,
repeated note/history reads, image retrieval, model-driven checkpoint work and multiple agents all
contribute to later requests. Cached input can still be billable. Posthorse neither launches agents
nor warms provider caches; the host and other extensions may have their own behavior.

Compare the same workload with Posthorse loaded and unloaded, with automatic compaction enabled in
both. Measure request counts, input/cache/output tokens, billed cost, latency and completion quality.
Disabling compaction is not a stock-compaction comparison. The [cost investigation](../ARTIFACTS/investigation-report.md)
provides a measurement plan, not a demonstrated saving or diagnosis of a production bill.

For everyday work:

1. Record important state while it is current, including what is uncertain or still running.
2. After rollover, read the task note and inspect the retained evidence; search for missing details
   with exact terms and follow pagination as needed.
3. Check the live files, job status or external receipts before repeating consequential work.
4. Keep the note concise and current. Use an explicit reset when a clean context is useful, not as
   a substitute for verifying that the handoff and state changes succeeded.
