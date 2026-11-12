# Ownership and lifetimes

Posthorse owns recovery policy and note provenance. Pi owns the agent loop, tool execution,
session journal, context projection, and file-tool mutation queues. These boundaries apply to
official Pi and to the maintained fork.

The [ordering contracts](ordering.md) identify event, replay, publication, and lookup precedence
at those boundaries, with their implementation owners and behavioral coverage.

## Runtime and request state

Pi creates an extension instance for one session runtime. New, resumed, forked, and reloaded
sessions get new instances. Pi owns teardown and releases the old instance's notes store,
captured calls, reset requests, page reservations, caches, and prompt options with the runtime.
Posthorse does not clear them at `session_shutdown`: the maintained fork can dispatch that
event while an interrupted turn is still settling and saving its final tool receipts.
Captured calls remain available through `tool_execution_end`, including during shutdown.
Shutdown does not delete journal entries or notes.

| State               | Owner and validity                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reset requests      | The current foreground tool batch. A request from a background call that outlives the batch is rejected.                                                                                                                                         |
| Page reservations   | One model turn. They track output not yet reflected in Pi's usage, not a durable entitlement to future capacity. A late background result is admitted using the current usage and current turn's reservations.                                   |
| Prompt options      | One agent run, from `before_agent_start` through `agent_settled`. A run may include several model turns. Pi fires `turn_start` after `before_agent_start`; a turn boundary must not clear these options.                                         |
| Captured note calls | From `tool_call` through `tool_execution_end`, including their captured scope and working directory. If initialization failed before capture, later successful notes calls can record their own call ID but cannot reconstruct missing ancestry. |
| Session notes       | The binding, owned paths, parent snapshot, and known scopes belong to the whole session, not a selected branch. `/tree` does not undo filesystem writes.                                                                                         |
| Epoch cache         | One manager, session ID, journal path, and leaf entry object. Pi's `getEntry` returns stored entries; object identity certifies an unchanged leaf or append-only ancestry.                                                                       |
| Policy snapshot     | One synchronous evaluation. After filesystem or process awaits, callers take a fresh snapshot rather than reuse old settings or usage.                                                                                                           |
| Note digests        | A discovery instance. A digest is reused only while the file identity and session revision still match.                                                                                                                                          |
| Card expansion      | A saved message object, weakly held. Pi calls renderers with that message; replacing it starts fresh click state.                                                                                                                                |

The provider-summary capability is fixed by the loaded host package. It is probed at import,
not inferred from a version string. The package loader must resolve Posthorse's SDK imports
to the host SDK. In particular, sharing `withFileMutationQueue` requires sharing that module
instance, not installing a second copy with the same version.

The `context_with_system` handler edits a request's cloned message array and system sections.
It must never edit the session journal's message objects. Pi passes those edits to later handlers
and returns the resulting messages to the provider. Forced prompts are handled separately by
request-local guidance because the host applies forced text after that hook.

Paged output uses `PageAccess.deliver`: it reconciles usage, calls a synchronous page builder,
and reserves the returned text and images before returning. Callers finish their asynchronous
reads before entering this operation. Page sizing is private, so a caller cannot hold an
unreserved size across an await or forget to reserve the completed result.

## Journal ownership

Pi alone appends, reparents, and persists session entries. Posthorse appends custom entries through
the extension API; it never rewrites a journal file.

- A notes snapshot is published before its binding entry. Initialization recognizes the same
  manifest owner after a failure between those operations.
- Note-touch entries can precede their receipts. Recovery uses them only when the corresponding
  root receipt is visible; a touch without a visible receipt is not evidence delivered to the model.
- Note-touch paths are normalized before ownership is updated or journaled. Readers normalize
  accepted relative aliases from older journals too, so deleting a private `./task.md` does not
  restore an inherited `task.md`.
- Each tool call can record adoption and then its completed effects for several files. Recovery
  keeps the last effect per owner, receipt, call, and path, in final-effect order. Verified effects
  determine clear and delete state. Compatible receipt content can still prove a retained full
  write or partial edit; an inferred edit cannot override a verified clear.
- Evidence reconciliation and note-state replay share a lexical path key. Dot segments and
  separator spelling do not split a file's effects into different notes. This key does not resolve
  old journal paths against the current filesystem.
- Reminders belong to a window and budget. Old reminders remain in history but leave model input,
  except inside the unchanged prefix protected by a provider summary block.
- A cancelled compaction can leave an inert `posthorse-boundary` marker. Only the compaction entry
  establishes a boundary.
- Entry types, version markers, and receipt wording are storage formats. Changing their producers
  requires preserving readers for journals written by previous releases.

Guidance delivered by the request hook is journaled before that request is sent. On the fork,
the provider-summary request can run the hook during compaction; its entries remain in the
journal. A summary block keeps the previous guidance anchor and its exact delivered bytes.
Without that retained anchor, a new epoch retires the old in-memory delivery state. Tree
navigation resets the cache and reconstructs the selected branch from the journal.

Retained-tail matching compares the projected journal payload, including tool-call linkage and
outcome, in journal order. An opaque custom-message presentation as an empty system-section
patch must preserve its timestamp and order. Timestamps are correlation values, not globally
unique IDs; presenters must not replace one retained message with another message's patch.
If a projected tail cannot be matched, Posthorse leaves its order unchanged. A host without
session projection retains the positional contract: preceding handlers must preserve the
retained message count and order. Provider-summary-held prefixes are never reordered.

Turn-end boundary drafts see the preview available when their handler runs. Later editors must
replace or remove a draft if they change its evidence. The native compaction hook runs after
turn-end handlers; the eager threshold fallback does not.

## Notes and filesystem resources

Project notes are shared across sessions and processes. The host file mutation queue serializes
same-file operations inside one process. It is not a cross-process lock or a multi-file transaction.
Replacement publishes atomically; append uses one `O_APPEND` write. Neither promises global
ordering among different processes.

A fork owns its published private scope. An inherited file is borrowed live from its source until
copy-on-first-edit through supported file tools. Shell commands and edits to the parent's own
path do not become private-copy operations. Bookkeeping cannot infer effects of arbitrary tools.
Notes remain user data when a session ends or its journal is removed. Journal absence alone is
not proof that a private scope can be deleted: other sessions and descendants may still reference
it, and its journal may live on another device.

The manifest records adopted files; the journal records later writes and deletions. Preserving
both preserves provenance. Removing a parent's journal can lose deletion evidence even when
its manifest survives.

The notes binding stores an absolute root for the session. Changing the working directory,
including entering another repository, does not rebind it. Moving a project does not relocate
an existing binding automatically: preserve the bound location when resuming that session.
Do not infer a relocation mapping from the current working directory or rewrite ancestry roots
that may belong to other projects.

Snapshot creation owns its `.staging-*` folder until publication and cleans it on a handled
failure. Discovery ignores staging folders, including crash leftovers. Atomic note publication
reserves filenames `.posthorse-<lowercase UUID v4>.tmp`. Notes list and search omit these
temporary names, including a directly selected temporary file. They are not deleted by
inventory, session shutdown, journal removal, or an age-based sweep. Explicit reads remain
available for inspecting a leftover file. Other `.tmp` filenames remain ordinary notes.

Adoption is performed while holding the destination file's native mutation queue. It does not
acquire that queue recursively. Manifest updates acquire a different queue after the note queue;
no path acquires those locks in reverse order.

`notesDir()` can migrate package-checkout notes and create a compatibility link. It is not a pure
path lookup. Migration preserves existing destination data rather than replacing it.

Notes read, list, and search offsets refer to live content, not a frozen snapshot. Each call
reads current data; edits between pages can shift content or ordering. Start again at offset
zero after a change when a consistent traversal matters. Independent callers do not share a
path-keyed paging lease.

Journal-line readers own their open handle until the async iteration finishes. `line.text()` uses
positioned reads, so advancing the iterator does not invalidate it; exhausting or returning from
the iterator closes the handle. Consume callbacks while that iterator remains open. File handles
and streams close when their owning operation exits. Archive search subprocesses receive the tool's abort
signal; cancellation and completion remain owned by the native process API. Archive prefilter
groups launch concurrently, with a 64 MiB output bound per subprocess rather than a global
process or memory cap. If filtering fails without cancellation, the full candidate set remains
eligible for the regular history reader.

## Borrowed tool contracts

Tool names are not a sandbox or proof of authorship. Extensions execute with host trust.
Posthorse owns `notes`, `history`, `new_context`, and `get_context_remaining`; integrations must
respect the host's effective registrations and namespace rules. The legacy `context-window`
renderer is a compatibility format, not a second rollover policy.

Owner-answer recovery requires a successful result linked to a projected unnamespaced
`ask_question` call and an effective unnamespaced registration. A registration is a host trust
decision, not cryptographic proof that a particular extension produced the answer.

Note tracking adapts the host's file-tool path and receipt contracts. Native `read`, `write`, and
`edit` path expansion differs from literal paths in the editing extension. Changes to either
owner's receipt schema or path semantics require updating and qualifying that adapter together
with its consumers. Unknown results cannot be treated as successful writes.

Optional SDK members are tested by capability presence. Missing fork enhancements must leave a
complete official-Pi path; version equality is not proof of capability or runtime qualification.
