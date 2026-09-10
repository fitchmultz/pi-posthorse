# Ordinary compaction with stock recovery hooks

This opt-in path keeps the official Codex runtime and ordinary summarization. A `PreCompact` hook saves recovery notes before summarization. `scripts/stock-session-start.mjs` rebuilds those notes from the original transcript after compaction and on resume, then supplies them as additional developer context. It does not trust an older checkpoint merely because one exists.

Reconstruction uses the records immediately before the latest saved compaction boundary. Normal assistant-message and plan completion events identify consumed tool batches; raw summarizer messages do not. This distinction matters because ordinary Codex records its summary as assistant text before saving the boundary. Several summary messages, missing token-usage metadata, and older line-based transcripts are covered by tests. The existing bounded excerpts, original record IDs, notes, and history tools are reused; original transcripts and older checkpoints are not changed.

## Isolated configuration

Keep `features.token_budget.enabled` and `features.context_management` false. In a separate test home, configure the existing `scripts/precompact.mjs` as `PreCompact` and the new `scripts/stock-session-start.mjs` as `SessionStart` without a matcher, so startup, resume, and compact events are covered. Use absolute script paths and set `additionalContextLimit = 10000` on the SessionStart command hook. Trust those exact hooks through Codex's normal hook-trust controls.

Set `POSTHORSE_STATE_DIR` explicitly for the hook process and the existing direct `notes` MCP server. The stock hook requires it; it will not silently write into the everyday home. Keep the ordinary `scripts/session-start.mjs` for the native-fork mode and child registration. Do not enable `local_recovery_hook` or replace the signed executable for this path.

No installer or plugin activation is included. The existing plugin scaffold still selects the native-fork hooks. Read the [official hook documentation](https://learn.chatgpt.com/docs/hooks#sessionstart) for event timing and configuration. Transcript JSONL is not a stable hook interface, so compatibility must be rechecked after runtime updates.

## Failure behavior

A missing, disabled, crashed, timed-out, or malformed-output PreCompact hook does not necessarily stop stock Codex from summarizing. The restoration hook repairs a missed checkpoint from retained originals before the next model request, including when an older valid checkpoint exists. Recovery does not require the user to rerun the completed tool.

A handled checkpoint-write failure still returns `continue: false` before summarization. If reconstruction itself cannot read valid original records, find a required compaction boundary, or save its result, it returns `continue: false` instead of supplying stale notes. Repair the underlying file or permission problem and resume the same task; the original transcript and previous checkpoints are retained.

Stock Codex does not enforce a required restoration hook: if that process itself crashes, is disabled, or never starts, these scripts cannot guarantee that continuation stops. This is not the fork's stronger pre-reset checkpoint contract. Tool-result consumption remains an explicitly labeled inference, not exact model acknowledgement.

## Verification

Run `POSTHORSE_CODEX_BIN=/absolute/path/to/codex npm run test:stock` from this directory. Use the matching official code-mode host beside the CLI. The suite uses the real runtime with scripted loopback responses and no account credentials.

Coverage includes ordinary automatic and manual summaries, immediate recovery, repeated compaction after a checkpoint crash, runtime restart, code mode, durable notes, exact original-history retrieval, and the newer V2 compaction client path. Store tests cover normal and legacy completion events and rejection of malformed originals without replacing a prior valid checkpoint.

An earlier signed-stock desktop trial proved native task-listing calls before and after compaction and after a real app restart. The repaired hook has separate runtime regression coverage; that earlier UI trial is not a fresh desktop test of this revision. Real Astra responses, a 500,000-token workload, every native desktop feature, and real subagent rollover remain unverified. Everyday installation is a separate step.
