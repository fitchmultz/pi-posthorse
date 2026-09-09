# Codex Posthorse prototype

An isolated proof of Posthorse-style context recovery using Codex's existing local context-reset path, a local tool server, and hooks. It does not replace Pi Posthorse, change the Pi package, or enable Codex's account-gated remote context-management service.

**Isolated testing only.** The companion local-recovery runtime patch passes the controlled recovery checks. Stock Codex does not meet all of them, and installed desktop behavior and real-model workloads have not been validated. Nothing here installs itself, changes your normal Codex configuration, or replaces the desktop runtime.

## What has been proved

Tests run the actual app-server, command tools, hooks, local MCP server, and matching code-mode host. Stock baselines include Codex `0.153.4` and upstream commit `4f2449b4b21988d5015ce6edf755fbd6a37a4908`. A local HTTP fixture supplies scripted model replies and usage counts. No real model inference or account credentials are involved.

| Requirement | Stock token-budget mode | Patched local recovery |
| --- | --- | --- |
| Original requests and unread output recover after automatic reset | Pass | Pass |
| Notes and original history survive restart | Pass | Pass, including retry after repairing a failed checkpoint write |
| Handled checkpoint-write error stops reset | Pass | Pass |
| Manual `/compact` keeps ordinary summarization | Fails: resets without a summary | Pass |
| Failed shell or MCP sibling cancels `new_context` | Fails: reset still commits | Pass, including both completion orders and the automatic threshold |
| Required hook must be available and successful | No required-hook policy; a process failure allows reset | Pass for missing, disabled, untrusted, unmatched, asynchronous, failed, timed-out, and malformed-output hooks |
| Invalid recovery hint cannot silently reset context | Fails | Pass: clear stop before reset; invalid initial hints are omitted with a warning |

The strict local suite has 22 passing scenarios. It also covers caught nested errors and malformed nested arguments through advertised code-mode tools, later successful reset after a handled failure, and oversized saved hints on initial context loading. Adapter tests cover Unicode byte limits and exact original-history recovery.

The fixture selects the `gpt-6-astra` model identifier. This proves runtime wiring, not Astra's behavior, a 500,000-token workload, or usability inside the desktop app. The tests use a 50,000-token configured window and synthetic usage crossing a 9,000-token threshold to make rollover reproducible.

## How recovery works

1. `SessionStart` and `SubagentStart` register the current task's original transcript path. A child uses its own `agent_id`; `session_id` remains the root task ID.
2. `PreCompact` saves a bounded recovery record before the runtime resets context. It prioritizes the first and latest original inputs, then trailing tool results, with record IDs for retrieving omitted material. It does not turn assistant progress claims into completed state.
3. The patched local mode reads and validates `notes.thread_hint` before changing windows, then uses that exact text in the fresh window. The hint restores task identity, recovery text, and instructions for reading durable notes and original history.
4. Notes and checkpoints remain on disk. History reads the original Codex JSONL transcript without rewriting or deleting it.

The recovery record is capped at 20,000 characters, with individual excerpts capped at 4,000 and the entire hint capped at 32,000 UTF-8 bytes. Unicode excerpts preserve complete characters. Full records remain available in pages. Older summaries are not copied into new recovery records. Child task prompts are labeled as delegated input, not promoted to direct user authorization.

Codex does not persist exact model acknowledgement of each tool result. The adapter infers unread results from the recorded tool batch and subsequent assistant output, and labels that inference explicitly. Recovery text is a record of inputs, not proof that work succeeded; the model must read notes and verify current state before continuing external actions.

## Tools and storage

- `notes`: `list`, `read`, `write`, `append`, `search`. Notes are task-local, not repository-shared like Pi Posthorse. Writes atomically replace a note; append writes one newline-terminated record. Parallel appends are tested.
- `history`: `list`, `search`, `read`, optionally filtered by native `windowId`. Reads return original JSONL, including metadata, in character-offset pages. Stored image blocks are returned with the first page.
- `thread_hint`: used by the native recovery bridge. It uses Codex's `_meta.threadId` when supplied, otherwise an explicit `threadId` argument.

`POSTHORSE_STATE_DIR` selects the state directory. Without it, the adapter uses `posthorse` under `CODEX_HOME`, or under `~/.codex` if `CODEX_HOME` is unset. It stores task manifests, immutable checkpoint files, and plaintext notes. Original transcripts stay where Codex created them. Removing the adapter does not remove this data.

The tool server does not make network requests. Returned notes and history become part of the active model's context; real use would therefore send retrieved content to that model's provider. History may include user text, assistant text, recorded reasoning summaries, tool arguments, results, and images. Encrypted reasoning cannot be recovered as plaintext.

## Run the isolated tests

Requirements: Node `>=22.19.0`, stock Codex `0.153.4` for the pinned comparison, or the companion patched CLI and matching code-mode host for local acceptance. From this directory:

```bash
npm ci --ignore-scripts
npm test
npm run test:runtime
npm run test:acceptance
```

Set `POSTHORSE_CODEX_BIN` to an explicit executable path to test a different runtime. `test:acceptance` still exits nonzero in stock mode because manual summarization and the two failed-sibling requirements are unmet. The separate stock hook-process-error check confirms existing behavior; it is not approval of that behavior.

For the patched local policy, place both binaries in the same directory and run:

```bash
POSTHORSE_CODEX_BIN=/absolute/path/to/codex npm run test:local
```

`test:local` enables `POSTHORSE_LOCAL_RECOVERY=1` and strict acceptance. The harness discovers the real `PreCompact` hook key and sets `features.token_budget.local_recovery_hook` only in each temporary home. No account-gated remote feature is enabled.

`test:runtime` characterizes stock behavior and prints `UNMET ACCEPTANCE` for its known gaps. Local acceptance enforces the stronger requirements without skips or TODOs. A passing controlled suite does not establish desktop compatibility or real-model quality.

CI keeps the stock comparison and builds a pinned companion runtime for a separate local-acceptance job. That job builds the matching code-mode host, runs native hook/feature tests, and exercises the full local runtime suite. The Codex reference fork's inherited GitHub Actions remain disabled; these consumer checks do not depend on its upstream-specific runners.

Each runtime case creates a separate `CODEX_HOME`, workspace, and state directory under `~/Library/Caches/pi-runs/posthorse-codex-*`, even on Linux. It never imports the normal Codex configuration or credentials. The harness trusts only its own test hooks, uses a loopback model endpoint, and terminates only processes it started. Transcripts, model requests, runtime events, errors, and `acceptance.json` results remain there for inspection; tests do not remove them. Unit and MCP test scratch data is retained under the same cache root.

## Integration limits

The plugin manifest and companion hook/MCP files are a scaffold, not a tested desktop installation path. The native bridge currently looks for a direct MCP server named `notes`; a plugin-namespaced server is not enough to assume it will connect. Runtime tests register that direct server explicitly in the isolated configuration and disable the remote history/notes extension.

Handled hook errors return `continue: false` while exiting successfully for stock compatibility. Stock Codex can proceed after a bare hook process failure; patched local mode requires the selected synchronous hook to finish successfully. `SubagentStart` still ignores stop requests, so a failed child registration cannot prevent the child from starting.

This prototype does not add Pi's proactive checkpoint reminder, context-aware page sizing, shared repository notes, or custom tool cards. Parent/child storage separation is tested at the store layer; a real multi-agent rollover and the installed desktop plugin path have not been tested.

The companion runtime patch supplies ordinary manual summarization, failed-batch cancellation, required-checkpoint enforcement, and validated hint loading. It remains an explicit local opt-in. The adapter does not install the patch or change which runtime the desktop app uses.
