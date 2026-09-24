# Posthorse — official Pi beta

Posthorse starts a fresh model context while keeping the complete session transcript available through `history`. It also provides durable `notes`, a context-budget tool, and sparse checkpoint reminders.

The **`upstream` branch targets official Pi 0.87.1**. It is a public testing beta, not a production release or full replacement for the fork-specific Posthorse on `main`. Use fresh official Pi sessions; fork transcript migration is not supported.

**Automatic recovery still depends on Pi preparing a compaction operation.** Small overflow/truncated responses and consecutive assistant/tool-only spans after a reset can miss that boundary. Oversized input or tool output can therefore still reach the provider. Explicit `new_context` remains available; see [Beta limits](#beta-limits) before testing long tool runs.

## Install and try it

With official Pi 0.87.1 and Node 22.19 or newer:

```sh
pi --version
pi install git:github.com/fitchmultz/pi-posthorse@upstream
```

Restart Pi after installing, then start a **new session**. For the first trial, disable other extensions that manage compaction or context resets. Ask the agent to write a short note, call `new_context` with a handoff, then recover the note and an earlier instruction through `notes` and `history`.

Always include `@upstream`. The npm package and default Git branch are for the fork-specific version, not this official-Pi beta.

To update this beta:

```sh
pi update git:github.com/fitchmultz/pi-posthorse@upstream
```

Restart Pi after updating. To remove it:

```sh
pi remove git:github.com/fitchmultz/pi-posthorse@upstream
```

Restart Pi after removal as well. Use the same agent directory for installation, updates, removal, and running Pi.

### Existing fork users: isolate the trial

Pi identifies Git packages by repository URL **without the ref**. Installing `@upstream` in a profile that already uses this repository can replace the installed fork variant. Use a separate agent directory, session directory, and scratch project. Do not reuse or copy fork transcripts into official Pi.

The following commands assume `pi` already resolves to **official Pi 0.87.1**, not a fork launcher:

```sh
trial="$(mktemp -d)"
mkdir -p "$trial/project" "$trial/agent" "$trial/sessions"
export PI_CODING_AGENT_DIR="$trial/agent"
cd "$trial/project"
pi --version
pi install git:github.com/fitchmultz/pi-posthorse@upstream
pi --session-dir "$trial/sessions"
```

Keep the value of `trial` to return to this profile. Configure normal provider authentication there for real model use. The local test suite below does not require model credentials. The environment override applies to this shell; leave it or unset `PI_CODING_AGENT_DIR` before returning to your usual profile.

Notes are project-scoped: Git worktrees share their repository's notes. A separate scratch project prevents a trial from modifying your existing `.pi/notes`.

## How context resets work

Posthorse supplies a handoff directly; supported automatic resets and explicit `new_context` resets do **not** ask a model to summarize the conversation. Pi persists a native compaction boundary, retains the current system prompt and tool declarations, and excludes preceding conversation from the next model context. The original transcript remains available through `history`.

- **Automatic reset:** Posthorse intercepts Pi's native `session_before_compact` event for automatic operations. Pi owns threshold checks, pre-prompt compaction, context-overflow and truncated-response recovery, retry limits, and continuation timing. Posthorse uses the event's effective model-specific settings and the latest projected session content to build a bounded recovery record. It preserves selected owner inputs, visible coordination, tool evidence, and references to older checkpoints; it is not a progress summary. Cancellation is checked before creating the reset boundary.
- **Explicit reset:** `new_context` requests a reset after the complete tool batch succeeds. A failed sibling cancels the request; multiple successful requests use the first handoff. A late queued message can defer a handoff that no longer fits. Completed sibling file writes or external effects are not rolled back if another tool fails.
- **Manual `/compact`:** remains Pi's native model-generated compaction, with its normal provider and authentication requirements.

The standard UI calls these boundaries compactions, and provider messages use Pi's standard “compacted … summary” wrapper around the supplied handoff. This wording does not mean a summarizer was called. Automatic resets use the normal compaction lifecycle; explicit boundary drafts emit `entry_appended` rather than the normal compaction lifecycle events. Clients watching only compaction events should account for that difference.

Normal official SDK/CLI construction allows the automatic hook to run without valid summarization credentials. Pi still attempts and awaits authentication lookup; a custom SDK stream implementation can have different requirements. Ordinary model responses still need their usual authentication.

## Tools and recovery

| Tool | Purpose |
| --- | --- |
| `new_context({ handoff? })` | Request a fresh context after the complete successful tool batch. |
| `get_context_remaining()` | Return the native context estimate and estimated rollover budget. |
| `notes({ op, ... })` | Write, append, read, list, or search persistent notes. |
| `history({ op, ... })` | Search or read original session entries, including previous windows. |

Handoffs are limited to 20,000 characters and shrink for smaller models, system/tool overhead, and visible pending messages. Recovery pages share a turn budget so parallel reads do not each spend the whole remaining context. At most one checkpoint reminder is issued for a window/model/budget combination. Disabling Pi's live compaction setting disables automatic resets. Reminders follow the available policy snapshot, which is persisted CLI settings by default and can lag the host; explicit resets remain available.

Notes live in `.pi/notes`. In a Git worktree they share the main checkout's notes, or the common Git directory for separate Git-directory layouts. Writes publish through a same-directory temporary file and rename, preserving existing file permissions and symlinks. Writes and appends use Pi's per-file mutation queue; publication failures remain failed tool results.

History prioritizes original entries ahead of recovery echoes, includes stored images, and supports bounded pagination. `all: true` searches sessions from the same working directory and their nested subagents, using file-qualified entry IDs. Earlier raw entries are not deleted by a reset. After a reset, restore notes and inspect history before repeating any stateful or external action.

## Settings and context estimates

Automatic resets use the **live effective settings supplied by Pi's compaction event**. Proactive reminders, `get_context_remaining`, explicit handoff limits, and recovery paging cannot access that event outside compaction. Official `ExtensionContext` has no general live compaction-settings accessor, so the default extension reads persisted global and trusted project settings through:

```ts
SettingsManager.create(ctx.cwd, getAgentDir(), {
  projectTrusted: ctx.isProjectTrusted(),
}).getCompactionSettings(ctx.model)
```

This uses native defaults, model overrides, merging, validation, and project trust. It is an approximation of the running host's policy: it cannot observe SDK in-memory overrides or CLI writes that have not reached disk, and it can see external file edits before the host reloads them. Keep persisted settings and the running host aligned when testing proactive behavior. Malformed settings are reported rather than silently treated as defaults.

SDK hosts can supply their actual settings accessor:

```ts
import { createPosthorse } from "./index.ts";

const posthorse = createPosthorse((ctx) =>
  settingsManager.getCompactionSettings(ctx.model),
);
// Include posthorse in DefaultResourceLoader's extensionFactories.
// Pass that same settingsManager to createAgentSession.
```

No fork methods are fabricated or patched into official Pi. Context estimates are not provider tokenizers or guaranteed rejection boundaries. Native usage is unknown immediately after compaction until valid post-compaction usage arrives.

## Beta limits

- **First and late queued input:** a huge initial prompt or late queued input can still reach the provider. The automatic hook cannot see the full pending request, so a handoff that fits its visible budget may still leave the eventual request oversized. This beta does not transform or archive incoming prompts to bound them before dispatch. These are limits of this integration, not a claim that official Pi has no input hooks.
- **Native recovery eligibility:** Pi must prepare an eligible compaction span before the automatic hook runs. A very small overflow or truncated response can end without a reset, particularly with the default `compaction.keepRecentTokens` of 20,000. Even with a smaller setting, a second large tool result after a reset can reach the provider when no new user span is available to compact. A terminating tool batch does not force another request or reset; Pi's pre-prompt check can miss its oversized output until a later response. Posthorse does not guarantee every oversized request will be intercepted. For deliberate small-span recovery tests, set `compaction.keepRecentTokens` to `1` in the isolated profile; the extension does not change this setting.
- **Unsupported automatic budgets:** models with an unknown context window or fewer than 10,000 usable tokens below the automatic rollover line are left to native compaction, which may generate a summary with its normal authentication requirements. For supported models, failure to build a fitting recovery record cancels compaction and reports the error rather than silently invoking a summarizer.
- **Late explicit cancellation:** aborting while sibling tools are running prevents an explicit reset. A later `turn_end` handler can abort after Posthorse returns its reset draft, and official Pi may still commit that draft. The public API does not provide the fork's final precommit abort guarantee for explicit resets. Native automatic compaction has its own later cancellation check.
- **Fresh official sessions:** fork transcripts can silently reactivate excluded context or duplicate messages in official Pi. There is no migration or hard startup rejection. Separate directories do not prevent a user or extension from explicitly opening an incompatible transcript. Fork execution-state, detached-task, and checkpoint restoration are not recreated.
- **Bounded recovery and extension composition:** recovery records can omit or truncate evidence and refer back to history instead of nesting older records. Read original entries when exact instructions or receipts matter. Other extensions can replace context or boundary drafts; cooperating handlers must preserve the drafts they receive.
- **Validation scope:** automated checks use the real 0.87.1 SDK and local faux providers. They do not establish live remote-model behavior, interactive-terminal usability, production readiness, or full fork parity.

## Verify locally

From a checkout of this branch, using Node 22.19 or newer:

```sh
npm ci --ignore-scripts --no-audit --registry=https://registry.npmjs.org
PI_OFFLINE=1 PI_TELEMETRY=0 npm run check:compat
```

`check:compat` runs the TypeScript check, `test/official.test.mjs`, and `test/renderers.test.ts`. `npm run test:native` runs only the official real-SDK suite. SDK fixtures use fresh temporary working, agent, and session directories with empty credential stores. No remote model service is required.

The old `test/native.test.mjs`, `test/posthorse.test.ts`, and `scripts/integration.sh` remain fork-specific reference tests. They are not run or claimed to pass on this branch. CI validates official 0.87.1 on pull requests and pushes to `upstream`.
