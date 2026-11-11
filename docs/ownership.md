# Ownership and lifetimes

Posthorse owns recovery policy and note provenance. Pi owns the agent loop, tool execution,
session journal, context projection, and file-tool mutation queues. These boundaries apply to
official Pi and to the maintained fork.

## Runtime and request state

Pi creates an extension instance for one session runtime. New, resumed, forked, and reloaded
sessions get new instances. `session_shutdown` ends the old instance; its handlers clear the
notes store, captured tool calls, reset requests, page reservations, reminder cache, guidance
cache, and request prompt options. Shutdown does not delete journal entries or notes.

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

## Journal ownership

Pi alone appends, reparents, and persists session entries. Posthorse appends custom entries through
the extension API; it never rewrites a journal file.

- A notes snapshot is published before its binding entry. Initialization recognizes the same
  manifest owner after a failure between those operations.
- Note-touch entries can precede their receipts. Recovery uses them only when the corresponding
  root receipt is visible; a touch without a visible receipt is not evidence delivered to the model.
- Reminders belong to a window and budget. Old reminders remain in history but leave model input,
  except inside the unchanged prefix protected by a provider summary block.
- A cancelled compaction can leave an inert `posthorse-boundary` marker. Only the compaction entry
  establishes a boundary.
- Entry types, version markers, and receipt wording are storage formats. Changing their producers
  requires preserving readers for journals written by previous releases.

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

Adoption is performed while holding the destination file's native mutation queue. It does not
acquire that queue recursively. Manifest updates acquire a different queue after the note queue;
no path acquires those locks in reverse order.

`notesDir()` can migrate package-checkout notes and create a compatibility link. It is not a pure
path lookup. Migration preserves existing destination data rather than replacing it.

Journal-line readers own their open handle until the async iteration finishes. `line.text()` uses
positioned reads, so advancing the iterator does not invalidate it; exhausting or returning from
the iterator closes the handle. Consume callbacks while that iterator remains open. File handles
and streams close when their owning operation exits. Archive search subprocesses receive the tool's abort
signal; cancellation and completion remain owned by the native process API.

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
