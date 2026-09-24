# Posthorse — official Pi experiment

This branch is an isolated prototype for **official Pi 0.87.1**. It does not replace, install over, or qualify the installed `fitchmultz/pi` version. Do not publish this branch as a production Posthorse release.

Posthorse starts a fresh model context while keeping the complete session transcript available through `history`. It also provides durable `notes`, a context-budget tool, and sparse checkpoint reminders.

## How this prototype resets context

Official Pi's actionable `turn_end` boundary can append a native compaction entry with `firstKeptEntryId: null`. Pi persists the current system prompt and tool declarations, retains no preceding conversation in model input, and leaves the original transcript intact. Posthorse supplies a handoff directly; it does **not** ask a model to summarize anything.

The provider still sees Pi's standard “compacted … summary” wrapper around that handoff. The UI and session format call the boundary a compaction. These are official compaction entries marked with `details.posthorse: 1`, rather than the fork's `context_window` entries.

- **Explicit reset:** `new_context` records the requested handoff in its tool-result details. At `turn_end`, Posthorse commits it only if every result in that batch succeeded. A failed sibling cancels the request. A late queued message can defer a handoff that no longer fits; the transcript explains the deferral.
- **Automatic reset:** successful turns crossing `contextWindow - reserveTokens` receive a bounded recovery record at `turn_end`. Oversized tool output can therefore leave active context before the next provider request. The record preserves selected owner inputs, visible coordination, tool evidence, and references to older checkpoints; it is not a progress summary.
- **Overflow retry:** a recognized provider context-overflow error gets one fresh-context retry. Official Pi ignores a `turn_end` continuation on an error, so Posthorse consumes a persisted retry marker at `agent_before_settle`. If that retry overflows again without new owner input or a successful response, Posthorse omits the second failure from future model input and stops retrying. Both failures remain in raw history.
- **Other errors and cancellation:** ordinary API errors and aborted turns do not trigger a Posthorse reset.
- **Manual `/compact`:** remains Pi's native model-generated compaction, with its normal provider and authentication requirements.

Boundary drafts preserve entries and continuation requested by preceding extension handlers. Later handlers must likewise preserve the drafts they receive; official Pi allows extensions to replace them.

## Tools and recovery

| Tool | Purpose |
| --- | --- |
| `new_context({ handoff? })` | Request a fresh context after the complete successful tool batch. |
| `get_context_remaining()` | Return the native context estimate and the configured rollover line. |
| `notes({ op, ... })` | Write, append, read, list, or search persistent notes. |
| `history({ op, ... })` | Search or read original session entries, including previous windows. |

Handoffs are limited to 20,000 characters and shrink for smaller models, system/tool overhead, and queued messages. Recovery pages share a turn budget so parallel reads do not each spend the whole remaining context. At most one checkpoint reminder is issued for a window/model/budget combination. Disabled compaction disables automatic resets and reminders; explicit resets remain available.

Notes live in `.pi/notes`. In a Git worktree they share the main checkout's notes (or the common Git directory for separate Git-directory layouts). This is intentional existing behavior: **use a separate scratch working directory for isolated trials**, not the installed extension checkout. Writes publish through a same-directory temporary file and rename, preserving existing file permissions and symlinks. Writes and appends use Pi's per-file mutation queue; publication failures remain failed tool results.

History prioritizes original entries ahead of recovery echoes, includes stored images, and supports bounded pagination. Recovery records for same-boundary edits and visible custom messages use searchable target/content keys until Pi assigns their persisted IDs; search then returns the real IDs for reading full text and images. `all: true` searches sessions from the same working directory and their nested subagents, using file-qualified entry IDs. Earlier raw entries are not deleted by a reset. After a reset, restore notes and inspect history before repeating any stateful or external action.

## Settings contract

Official `ExtensionContext` has no live compaction-settings accessor. The default file extension reads **persisted** global and trusted project settings through:

```ts
SettingsManager.create(ctx.cwd, getAgentDir(), {
  projectTrusted: ctx.isProjectTrusted(),
}).getCompactionSettings(ctx.model)
```

This uses native defaults, model overrides, merging, validation, and project trust. It cannot observe an SDK host's in-memory overrides or a CLI change that has not reached disk. A file change can also be visible to this reader before the running host reloads it. Keep persisted settings and the host's effective settings aligned during CLI experiments. Malformed settings are reported rather than silently treated as defaults by Posthorse.

SDK hosts should supply the actual settings accessor:

```ts
import { createPosthorse } from "./index.ts";

const posthorse = createPosthorse((ctx) =>
  settingsManager.getCompactionSettings(ctx.model),
);
// Include posthorse in DefaultResourceLoader's extensionFactories.
// Pass that same settingsManager to createAgentSession.
```

No fork methods are fabricated or patched into official Pi.

## Known limits

This is not full fork parity:

1. **Before the first boundary:** a huge new prompt can reach the provider before Posthorse has a `turn_end` to act on. A provider overflow response can then be recovered, but the initial oversized request is unavoidable here. Resumed or externally enlarged context can also enter Pi's pre-prompt compaction before Posthorse's turn hook; that path may invoke native summarization and require its normal credentials.
2. **No room for recovery:** if the prompt, tools, or pending messages leave too little room for a useful handoff, automatic Posthorse rollover does not take over. Native Pi compaction may run. Models with less than 10,000 usable tokens below the automatic line are unsupported for automatic rollover.
3. **Native behavior remains:** native truncated-response recovery, manual compaction, pre-prompt checks, and other extensions can still compact. This prototype does not replace those core paths. Settings discrepancies can cause their thresholds to differ from Posthorse's.
4. **Fresh official sessions required:** do not open fork transcripts containing `context_window` entries with official Pi. Official Pi does not implement their context semantics; earlier excluded conversation could reappear. There is no transcript migration or hard startup rejection in this experiment. Use separate agent and session directories.
5. **Recovery is bounded:** automatic records can omit or truncate older evidence. They carry history references instead of recursively nesting prior recovery records. Read the original transcript when exact instructions or receipts matter.
6. **Validation scope:** tests use the real 0.87.1 SDK and its local faux provider, not a live remote model. Existing tool-card rendering checks run against official Pi; no interactive terminal dogfood or complete fork compatibility claim is made. Fork checkpoint/restart APIs are not recreated.

## Verify locally

From this worktree, using Node 22.19 or newer:

```sh
npm ci --ignore-scripts --no-audit --registry=https://registry.npmjs.org
PI_OFFLINE=1 PI_TELEMETRY=0 npm run check:compat
```

`check:compat` runs the TypeScript check, `test/official.test.mjs`, and `test/renderers.test.ts`. `npm run test:native` runs only the official real-SDK suite. Every SDK fixture uses a new temporary working directory, agent directory, empty credential store, and session directory; its path is printed for inspection. No model credentials or network calls are needed.

The native tests cover fresh provider input, retained system/tools/transcript, notes/history after reset, disk reload, sibling failure cancellation, automatic oversized output, repeated rollover, bounded overflow retry, settings disable, reminder deduplication, pending messages, cooperating extensions, atomic note publication, incoming-prompt limitations, and native manual compaction.

The old `test/native.test.mjs`, `test/posthorse.test.ts`, and `scripts/integration.sh` remain fork-specific reference tests. They are **not** run or claimed to pass for this prototype. This branch's CI validates official 0.87.1 rather than the production branch's fork-plus-official-refusal matrix.

## Isolated CLI trial

These commands invoke the worktree's official SDK directly and use a fresh scratch project. They do not run `pi install`, modify your launcher, or reuse installed Pi settings or sessions:

```sh
prototype="$PWD"
trial="$(mktemp -d)"
mkdir -p "$trial/project" "$trial/agent" "$trial/sessions"
cd "$trial/project"
PI_CODING_AGENT_DIR="$trial/agent" PI_OFFLINE=1 PI_TELEMETRY=0 \
  node "$prototype/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" \
  --session-dir "$trial/sessions" --no-approve \
  --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files \
  --extension "$prototype/index.ts"
```

A real provider still needs ordinary model authentication in the isolated profile. The automated faux-provider tests above are the credential-free trial. Do not copy or resume installed-fork sessions into this profile.
