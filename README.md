# Posthorse

Posthorse gives long [Pi](https://github.com/earendil-works/pi) coding sessions a fresh context window while keeping earlier conversation recoverable. Use it to continue larger tasks with handoffs, durable notes, and searchable history, without a model-generated summary at each rollover.

![A Pi conversation rolls into a fresh context window, while task notes and the complete session transcript remain recoverable.](.github/readme/context-rollover.png)

_Fresh context, same journey: handoffs carry the next step; notes and history keep the rest within reach._

## Install and start

Requires **Node 24.12.0 or later** and **Pi 1.0.0 or later**, on official Pi or the [maintained fork](https://github.com/fitchmultz/pi). Update an older host before installing.

```bash
pi install npm:pi-posthorse
pi
```

Restart an already-running Pi session after installing. For a single run without adding the package to your settings:

```bash
pi -e npm:pi-posthorse
```

Start your task normally. Posthorse gives the model context guidance and adds four tools for managing longer sessions. See [how rollover works](#how-it-works) or the [tool examples](#tools) below.

## How it works

1. **Work in your current window.** The model gets guidance about Pi's context capacity and rollover settings.
2. **Save the next step.** With compaction enabled, one best-effort checkpoint reminder may ask the model to update its task note and request a fresh window. Large turns can reach rollover before that reminder.
3. **Continue in fresh context.** An explicit request carries your handoff. Automatic rollover builds a bounded recovery record from session inputs and tool evidence. Earlier conversation leaves active model context and remains in Pi's complete session history.

Automatic recovery records preserve inputs and evidence. The fresh model still needs to restore task notes and verify live state before continuing. A reminder never wakes a finished agent or replaces its final answer.

[Detailed rollover and recovery behavior →](docs/reference.md#how-it-works)

## Tools

These are model-callable tools. You can ask Pi to use them in plain language, for example:

> Save where we are in a task note, then start a fresh context window with the next steps.

| Tool                        | What it does                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `new_context({ handoff? })` | Requests a fresh window after the current foreground tool batch succeeds.                                                                              |
| `get_context_remaining()`   | Estimates tokens left until rollover and the configured context limit. Usage may be unknown before a model response.                                   |
| `notes({ op, ... })`        | Lists, reads, searches, writes, or appends plaintext task notes shared across linked Git worktrees.                                                    |
| `history({ op, ... })`      | Searches earlier conversation and reads entries, including stored images. `all: true` includes this project's other sessions and nested subagent runs. |

For example, the model can create a note and search earlier decisions:

```js
notes({
  op: "write",
  path: "task.md",
  content: "Goal: fix sign-in. Next: run the regression test.",
});
history({ op: "search", query: "sign-in", all: true });
```

Read a history hit using the exact entry ID returned by search. Notes and history are paged; follow the returned continuation fields to retrieve more.

Tool cards expand with **Ctrl+O** by default, or by clicking in fullscreen mode. A `new_context` card shows a request; Pi's **Compacted from … tokens** card confirms a committed rollover.

[Full tool and paging reference →](docs/reference.md#tools)

## Settings

Posthorse follows Pi's effective `compaction` settings, including per-model overrides and project trust. You do not need separate Posthorse settings.

- Disable `compaction.enabled` to turn off checkpoint reminders and automatic rollover. `new_context` remains available.
- Automatic Posthorse rollover needs at least **10,000 usable tokens** after `compaction.reserveTokens`. Smaller budgets use Pi's own compaction; lower the reserve or choose a larger-context model.
- Keep one Posthorse copy loaded and only one automatic compaction-policy extension enabled. Use `pi list` to check installed sources.

Handoffs and returned pages have model-aware size limits. Save fuller state in notes when a handoff is too large.

[Settings, limits, and extension ordering →](docs/reference.md#settings)

## Official Pi and the fork

Both hosts get the same tools, guidance, reminders, and recovery records. Posthorse uses public compaction APIs and does not call a summary model for its rollover. Manual **`/compact`** keeps Pi's normal summarization.

Failed sibling tools or an aborted turn prevent an explicit reset. Background work owned outside the foreground batch continues across it. Automatic recovery depends on Pi reaching its compaction hook; oversized initial input and some overflow or truncated responses can reach the provider before recovery.

Legacy fork window markers remain readable in history, but opening those old sessions on official Pi can reintroduce earlier context. Check the [host and legacy-session details](docs/reference.md#official-pi-and-the-fork) before migrating sessions.

## Update or remove

```bash
pi update npm:pi-posthorse
pi remove npm:pi-posthorse
```

Restart Pi after an update. Removing Posthorse leaves your notes and Pi session history in place. For Git installs, pinned versions, and duplicate-source cleanup, see [installation reference](docs/reference.md#install).

## Data and privacy

- Posthorse makes no network requests itself.
- Notes are plaintext under `.pi/notes/` and survive package removal. In conventional Git layouts they live at the main checkout; linked worktrees share them. Add `.pi/notes/` to `.gitignore` if they should stay private.
- History can return user messages, assistant text and thinking, tool arguments and results, handoffs, errors, and images. Returned content enters the context of your currently selected model and provider.
- `history` with `all: true` searches project-matching session files and their nested subagent sessions in the active Pi session directory. Unrelated projects are excluded. Direct shell entries Pi marked `excludeFromContext` return a placeholder.

For cached-token cost diagnosis and a safe comparison with stock compaction, see the [cached-token investigation](ARTIFACTS/investigation-report.md). It does not establish the cause of a production bill or a measured cost improvement.

[Storage locations and write guarantees →](docs/reference.md#tools)

## Develop

See [development and host qualification](docs/development.md) for setup, tests, and release procedures, and [code quality](docs/quality.md) for the enforced checks.

## License

[MIT](LICENSE).
