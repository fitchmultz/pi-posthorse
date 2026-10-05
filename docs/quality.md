# Code quality and acceptance

Oxlint owns code-quality checks; Oxfmt owns formatting. TypeScript, behavior tests, package packing
and code review remain independent gates. Correctness, maintainability and trustworthy enforcement
have equal weight.

## Commands

Use Node 24 and npm 12.2.0. Install the committed dependencies with `npm ci --ignore-scripts`, then
prepare the corrected native quality engine before linting or opening the editor. The engine's
pinned source, patch and reproducible build are documented separately.

| Command                  | Purpose                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `npm run quality:policy` | Comment-aware suppression governance and actual maintained-source/project inventory             |
| `npm run quality:probes` | Installed native CLI configuration, language scope, declaration isolation and regression probes |
| `npm run lint`           | Policy check and strict code-quality/type-aware/compiler diagnostics                            |
| `npm run lint:agent`     | Identical scope, structured agent diagnostics                                                   |
| `npm run lint:fix`       | Identical scope and reviewed safe fixes; no dangerous-fix mode                                  |
| `npm run format`         | Oxfmt writes maintained supported files                                                         |
| `npm run format:check`   | Non-modifying formatting check                                                                  |
| `npm run check`          | Canonical TypeScript compiler check, independently of Oxlint                                    |
| `npm run check:compat`   | Compiler, unit/rendering tests and real native-host tests                                       |
| `npm run build`          | npm package dry-run; this source-distributed extension has no emitted build                     |
| `npm run verify`         | All acceptance gates, preserving each child process's failure status                            |

CI runs acceptance independently of the existing latest-official/latest-fork qualification. The
release workflow calls that CI workflow, and `prepublishOnly` also requires acceptance.

## Coverage and limits

All handwritten TypeScript, JavaScript, test helpers, adapters and tooling are maintained. Root
`tsconfig.json` includes `index.ts`, `ui.ts`, `src/**/*.ts`, `scripts/**/*.ts`, `test/**/*.ts` and
`test/**/*.mjs`. Checked leaf projects require effective `strict` and `noImplicitReturns`.

The native integration suites `test/host.test.mjs`, `test/native.test.mjs` and
`test/official.test.mjs` remain intentionally unchecked JavaScript. Their exact overrides disable
only the installed metadata's `type_aware` rules and TypeScript-only explicit boundary annotations.
They retain syntactic correctness, suspicious, performance, Node, import, Promise, mutation,
sequencing and test structural checks, plus formatting and their existing real-host execution.
Imported JavaScript remains available to checked consumers through `allowJs` without acquiring
compiler diagnostics by accident. `@ts-check` or inherited `checkJs: true` opts JavaScript into
semantic lint/compiler checking; policy fails if an unchecked override masks that decision.

The inventory compares actual Oxlint traversal with all tracked and nonignored untracked source,
then uses the installed TypeScript compiler API to verify project settings and per-file directives.
A new unchecked JavaScript file needs an exact metadata override; a new checked file must have the
correct project assignment. Normal lint, fixes, agent diagnostics, CI and the editor share the root
policy. There are no handwritten-source lint exclusions. Negative probe files are created only in
disposable external projects and are removed in `finally` blocks, never silently ignored source.

Production limits are modified complexity 10, depth 3, parameters 4, statements 40, function lines
80 and file lines 500 (excluding blanks/comments). Tests and approved test-only helpers keep
complexity 15, depth 4 and parameters 6 while exempting only size/statement metrics. Hand-maintained
declarations retain API/type-safety policy while exempting structural metrics. Test assertions use
the Node runner and Node's strict assertion API; Vitest-specific rules are not applicable.

Oxfmt retains established tab indentation, double quotes, semicolons and LF. YAML and Markdown
retain two-space indentation. Import/package sorting and JSDoc rewriting are disabled. The npm
lockfile stays npm-owned; images/SVG are unchanged and unsupported by Oxfmt. External dependencies
and native-engine build caches are under ignored `node_modules`, not production lint scope.

## Narrow contracts and exceptions

- Native TypeScript inputs use declaration-qualified `from: lib` allowances. Native Pi/TUI handles
  and the compiler AST use package-qualified allowances, never a wildcard generic-container list.
  CLI probes pair approved declarations with local/foreign mutable same-named types.
- Framework-owned Node test registration is eligible only after the corrected declaration matcher
  passes the complete identity matrix. Native Promise/PromiseLike are not safe-Promise allowances.
  Ordinary work, local shadows, foreign packages/files, aliases and unawaited subtests remain checked.
- SDK `execute` requires five parameters at three exact tool-registration boundaries. The policy
  checker resolves the actual `ExtensionAPI.registerTool` declaration before permitting a directive;
  matching method/interface names and neighboring application helpers retain the ordinary limit.
- Sequential persistence, streams and cleanup keep explained single-site `no-await-in-loop`
  exceptions. Concurrency is chosen by actual dependencies, not by diagnostic counts.
- `src/ui/text.ts` deliberately rejects terminal controls and Unicode interlinear annotations.
  Its exact validation expression and intentional `test/renderers.test.ts` control fixtures receive
  explained native directives.
- Necessary post-await lifecycle guards may use explained single-site condition exceptions, and
  plain generic callbacks may use the authorized readonly-result exception. Neither permits unsafe
  callback bodies, mutable attached properties or floating Promises.
- Exact test fixture scopes preserve explicit-undefined arrow contracts and positional native API
  arguments without disabling the rule's other checks.
- Native mock-provider `opts` mutations in `test/native.test.mjs` and `test/official.test.mjs`, and
  context-hook `event` mutation in `test/official.test.mjs`, preserve explicit platform contracts.
  Ordinary input mutation remains checked, including outside those exact files.
- The corrected checker recognizes actual native `ReadonlyMap`/`ReadonlySet` contracts while checking
  generic keys, values and attached application state. Mutable Map/Set APIs remain mutable even under
  a `Readonly` wrapper. Unsuppressed positive and negative reproducers are retained; there are no
  blanket Map/Record/Readonly allowances. Application APIs still expose only the read capabilities
  they need.

The policy checker uses Oxc's complete parsed comment stream, including comments inside empty
containers and punctuation gaps, not source-text grep or partial AST trivia. Strings, regexes,
template literals and JSX text are not directives; real JSX expression comments remain checked.
It rejects blanket, line-wide, unapproved or unexplained directives and legacy ESLint suppressions. `@ts-ignore` and
`@ts-nocheck` are forbidden. Described `@ts-expect-error` belongs only in dedicated `.test-d.ts`
negative type tests. Unused-disable diagnostics stay enabled. New configuration/ignore/CI/suppression
changes go through the repository's ordinary PR review, with positive and negative probes.

## Responsibility boundaries after cleanup

Before, the single `createPosthorse` factory owned rollover requests, reminder ancestry caching,
parallel page reservations, notes filesystem operations and history scan/cursor orchestration.
State from unrelated operations lived beside every tool registration:

```ts
const resetRequests = new Map<string, string>();
let pendingPageTokens = 0;
let previousPageUsage: number | null | undefined;
```

After, the entry point wires explicit owners and focused operations:

```ts
const pages = new PageReservations(toolTokens);
registerPosthorseMessages(pi);
registerRollover(pi, policy, toolTokens, () => {
  pages.reset();
});
registerNotes(pi, policy, pages);
registerHistory(pi, policy, pages);
```

`PageReservations` is the sole owner of sibling-page accounting. Rollover owns reset requests and
leaf-certified reminder state; Pi still owns persistence and scheduling. Notes owns note operations,
while `src/files.ts` owns target resolution, staging, permissions, abort checks, atomic rename and
cleanup without replacing the original caught failure. History separates normalization, ranking,
archive visibility, cursor progress and rendering; readonly operation interfaces expose only what
consumers need, rather than sharing an entire mutable owner. UI validates display facts/spans,
constructs truthful summaries and lays out cards separately, with click state owned locally.

The root default extension and `createPosthorse` contracts, and the existing `ui.ts` exports, are
preserved. Production helper exports are internal to the source-distributed package, not new root
APIs. Existing lifecycle/persistence and native rendering tests retain their intended assertions.
Formatting is presentation work; these responsibility/ownership changes are substantive
maintainability improvements, not claimed runtime bug fixes.

The former `toolCards.renderResult` also combined an unchecked display assertion, summary
selection, history slicing, terminal sanitation and collapsed/expanded layout. Before:

```ts
const display = result.details as PosthorseDisplay | undefined;
```

After, the SDK boundary validates unknown saved metadata:

```ts
display: displayOf(result.details);
```

`src/ui/display.ts` owns readonly display contracts, validation and history-span boundaries;
`src/ui/text.ts` owns safe terminal text; `src/ui/cards.ts` owns presentation and row budgets.
`ui.ts` retains the public exports and per-message click state. A summary change no longer requires
editing sanitation or message expansion, and malformed legacy metadata falls back to ordinary text.

## Verification and review

The probes check installed CLI rule IDs and source locations, not just exit status or schema
acceptance. Configuration/parser/dependency errors, unexpected diagnostics and child crashes fail
the probe. Language probes cover inherited settings, per-file directives and checked consumers of
unchecked JavaScript; compiler diagnostics are verified separately. Origin probes exercise actual
approved calls/types, local same names, foreign files/packages, shadows, aliases/re-exports,
wrong-qualifier controls, ordinary async work and unawaited subtests. Repeat after clean installation
or engine upgrades.

Before delivery, run `npm run verify` on the integrated revision and independently demonstrate that
this same workflow rejects syntactic, semantic, compiler, formatting and allowance-isolation
violations in a disposable checkout. Formatting must converge with safe lint fixes and be idempotent.
Review meaningful decomposition for explicit state ownership, readable phases, preserved failure
identity/cancellation and localized change boundaries; green metrics alone are not a design review.
