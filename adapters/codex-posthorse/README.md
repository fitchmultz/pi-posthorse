# Codex Posthorse prototype

An isolated proof of Posthorse-style context recovery using Codex's existing local context-reset path, a local tool server, and hooks. It does not replace Pi Posthorse, change the Pi package, or enable Codex's account-gated remote context-management service.

**Not ready for everyday tasks.** Automatic recovery and restart work in controlled real-runtime tests, but stock Codex does not meet all Posthorse requirements. Nothing here installs itself, changes your normal Codex configuration, or replaces the desktop runtime.

## What has been proved

Tests run the actual Codex `0.153.4` app-server, actual command tools, actual hooks, and the actual local MCP server. A local HTTP fixture supplies scripted model replies and usage counts. No real model inference or account credentials are involved.

| Requirement | Observed result with Codex 0.153.4 |
| --- | --- |
| Automatic reset keeps original requests and unread tool output recoverable | Pass: the next model request contains recovery text from the local notes bridge after the native window changes. |
| Notes and original history survive restart | Pass: real tool calls read the saved note and original tool output after restarting the runtime. |
| A handled checkpoint-write failure stops reset | Pass: an actual filesystem error stops the turn before any context boundary is committed. |
| Manual `/compact` keeps ordinary summarization | Fail: local token-budget mode resets without a summary request; ordinary mode makes one. |
| A failed command beside `new_context` cancels reset | Fail: a command exits 7, but the window still changes. Its error remains recoverable. |
| A failed MCP tool beside `new_context` cancels reset | Fail: Codex reports the tool as failed, but the window still changes. |

The fixture selects the `gpt-6-astra` model identifier. This proves runtime wiring, not Astra's behavior, a 500,000-token workload, or usability inside the desktop app. The tests use a 50,000-token configured window and synthetic usage crossing a 9,000-token threshold to make rollover reproducible.

## How recovery works

1. `SessionStart` and `SubagentStart` register the current task's original transcript path. A child uses its own `agent_id`; `session_id` remains the root task ID.
2. `PreCompact` saves a bounded recovery record before the runtime resets context. It prioritizes the first and latest original inputs, then trailing tool results, with record IDs for retrieving omitted material. It does not turn assistant progress claims into completed state.
3. Codex starts a new native context window and calls `notes.thread_hint`. The hint restores task identity, recovery text, and instructions for reading durable notes and original history.
4. Notes and checkpoints remain on disk. History reads the original Codex JSONL transcript without rewriting or deleting it.

The recovery record is capped at 20,000 characters, with individual excerpts capped at 4,000. Full records remain available in pages. Older summaries are not copied into new recovery records. Child task prompts are labeled as delegated input, not promoted to direct user authorization.

Codex does not persist exact model acknowledgement of each tool result. The adapter infers unread results from the recorded tool batch and subsequent assistant output, and labels that inference explicitly. Recovery text is a record of inputs, not proof that work succeeded; the model must read notes and verify current state before continuing external actions.

## Tools and storage

- `notes`: `list`, `read`, `write`, `append`, `search`. Notes are task-local, not repository-shared like Pi Posthorse. Writes atomically replace a note; append writes one newline-terminated record. Parallel appends are tested.
- `history`: `list`, `search`, `read`, optionally filtered by native `windowId`. Reads return original JSONL, including metadata, in character-offset pages. Stored image blocks are returned with the first page.
- `thread_hint`: used by the native recovery bridge. It uses Codex's `_meta.threadId` when supplied, otherwise an explicit `threadId` argument.

`POSTHORSE_STATE_DIR` selects the state directory. Without it, the adapter uses `posthorse` under `CODEX_HOME`, or under `~/.codex` if `CODEX_HOME` is unset. It stores task manifests, immutable checkpoint files, and plaintext notes. Original transcripts stay where Codex created them. Removing the adapter does not remove this data.

The tool server does not make network requests. Returned notes and history become part of the active model's context; real use would therefore send retrieved content to that model's provider. History may include user text, assistant text, recorded reasoning summaries, tool arguments, results, and images. Encrypted reasoning cannot be recovered as plaintext.

## Run the isolated tests

Requirements: Node `>=22.19.0`, and Codex `0.153.4` for runtime tests. From this directory:

```bash
npm ci --ignore-scripts
npm test
npm run test:runtime
npm run test:acceptance
```

Set `POSTHORSE_CODEX_BIN` to an explicit executable path to test a different runtime. The last command currently exits nonzero on stock `0.153.4`: two runtime scenarios pass and three fail the required acceptance checks. This is intentional and must not be read as approval to enable the prototype.

`test:runtime` checks wiring and records the observed native behavior, printing `UNMET ACCEPTANCE` for known gaps. CI runs that characterization suite so platform changes and broken wiring are visible. **Green CI does not mean full Posthorse behavior is supported.** `test:acceptance` enforces the stronger requirements and is the readiness check.

Each runtime case creates a separate `CODEX_HOME`, workspace, and state directory under `~/Library/Caches/pi-runs/posthorse-codex-*`, even on Linux. It never imports the normal Codex configuration or credentials. The harness trusts only its own test hooks, uses a loopback model endpoint, and terminates only processes it started. Transcripts, model requests, runtime events, errors, and `acceptance.json` results remain there for inspection; tests do not remove them. Unit and MCP test scratch data is retained under the same cache root.

## Integration limits

The plugin manifest and companion hook/MCP files are a scaffold, not a tested desktop installation path. The native bridge currently looks for a direct MCP server named `notes`; a plugin-namespaced server is not enough to assume it will connect. Runtime tests register that direct server explicitly in the isolated configuration and disable the remote history/notes extension.

Handled hook errors return `continue: false` while exiting successfully, because stock Codex can proceed after a bare hook process failure. A crash, import failure, or timeout can still allow reset without a fresh checkpoint. `SubagentStart` also ignores stop requests, so a failed child registration cannot prevent the child from starting. These are runtime limitations, not fixed by the adapter.

This prototype does not add Pi's proactive checkpoint reminder, context-aware page sizing, shared repository notes, or custom tool cards. Parent/child storage separation is tested at the store layer; a real multi-agent rollover and the installed desktop plugin path have not been tested.

Full Posthorse behavior needs changes in the Codex runtime: retain ordinary manual summarization, cancel a pending explicit reset when its tool batch fails, and stop safely when required checkpoint hooks cannot run. The prototype uses the stock runtime and does not include or install those changes.
