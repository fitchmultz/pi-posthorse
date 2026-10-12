# Posthorse

Posthorse starts fresh context windows for long [Pi](https://github.com/earendil-works/pi) tasks and keeps earlier conversation recoverable. Each rollover uses a handoff or recovery record without a model-generated summary.

![A Pi conversation rolls into a fresh context window. Task notes and the complete session transcript remain available.](.github/readme/context-rollover.png)

## Install and start

Use Node 24.12.0 or later and Pi 1.0.0 or later. Posthorse supports official Pi and [fitchmultz/pi](https://github.com/fitchmultz/pi).

Update an older Pi installation before you install Posthorse. Run these commands:

```bash
pi install npm:pi-posthorse
pi
```

Restart Pi after installation or an update. To try Posthorse for one session, run `pi -e npm:pi-posthorse`.

Give Pi your task. For example:

> Save task state in a note. Start a fresh context window with the next steps.

## How rollover works

Posthorse can remind the model to save task state before rollover. Large turns can reach rollover before this reminder. The reminder does not wake an agent after its final answer.

Automatic rollover creates a recovery record from session inputs and tool results. The model must restore notes and check live state before it continues. Manual `/compact` uses Pi's normal summarization.

See [rollover and recovery details](docs/reference.md#how-it-works).

## Tools

These tools are available to the model:

| Tool                        | Use                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `new_context({ handoff? })` | Request a fresh window after every foreground tool succeeds. Aborted turns and failed tools prevent the reset.                               |
| `get_context_remaining()`   | Estimate tokens left until rollover and the configured context limit. Usage can be unknown before a model response.                          |
| `notes({ op, ... })`        | List, read, search, write, or append task notes.                                                                                             |
| `history({ op, ... })`      | Search earlier conversation and read entries, including images. `all: true` includes this project's other sessions and nested subagent runs. |

Expand a tool card with Ctrl+O. In fullscreen mode, click a tool card to expand it. A `new_context` card shows a request. Pi's `Compacted from … tokens` card confirms the rollover.

See [tool examples and paging details](docs/reference.md#tools).

## Settings and limits

Posthorse uses Pi's effective `compaction` settings. It has no separate settings.

| Pi setting                 | Effect                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `compaction.enabled`       | Set to `false` to disable reminders and automatic rollover. `new_context` remains available.                                                                       |
| `compaction.reserveTokens` | Automatic Posthorse rollover needs at least 10,000 tokens after this reserve. Smaller budgets use Pi's own compaction. Lower the reserve or choose a larger model. |

Two Posthorse copies can register the same tools and compete for rollover. Keep one copy loaded. Check installed sources with `pi list`.

Multiple compaction-policy extensions can make rollover depend on load order. Enable only one.

Oversized input and some overflow or truncated responses can reach the provider before automatic recovery. Save task state in notes. Background work outside the foreground tool batch continues across rollover.

See [size limits and extension order](docs/reference.md#settings).
Check the [legacy-session details](docs/reference.md#official-pi-and-the-fork) before you move old fork sessions to official Pi.

## Update or remove

```bash
pi update npm:pi-posthorse
pi remove npm:pi-posthorse
```

Removal leaves notes and Pi session history in place. See the [installation reference](docs/reference.md#install) for Git sources.

## Data and privacy

Posthorse makes no network requests. Notes are plaintext files under `.pi/notes/`; linked Git worktrees share them. Notes for the Git packages Pi installs in `~/.pi/agent/git/` live under `~/.pi/agent/notes/` instead, because `pi update` deletes untracked files in those checkouts. Add `.pi/notes/` to `.gitignore` if the notes must stay private.

History can include user messages, assistant thinking, tool arguments, errors, and images. Content you retrieve enters the context of your selected model and provider.

See [storage and privacy details](docs/reference.md#data-and-privacy).
For cost diagnosis, see the [cached-token investigation](ARTIFACTS/investigation-report.md).
It does not establish the cause of a production bill or a measured cost improvement.

## Development

See [development and host qualification](docs/development.md) for setup, tests, and releases.
See [code quality](docs/quality.md) for the required checks.

## License

[MIT](LICENSE).
