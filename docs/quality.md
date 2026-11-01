# Code quality and acceptance

[Engineering standard 5.1.2](engineering-standard.md) owns the requirements, source profiles,
and evidence-based exception process. Its Appendix B records Posthorse's mappings and decisions.

## Commands

Acceptance uses Node 24, the npm version in `package.json`, and the committed lockfile.
`npm ci --ignore-scripts` installs the published quality tools. The invoking npm's real manifest
is checked before acceptance starts. [Development](development.md) describes isolated npm selection.

| Command                  | Purpose                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `npm run quality:policy` | Standard settings, full source inventory, canonical compiler membership, profile boundaries, and directive authorization |
| `npm run quality:config` | Shared workflow references and supported Pi dependency-floor coherence                                                   |
| `npm run quality:probes` | Installed native tools, compiler scope, source coverage, and exception controls                                          |
| `npm run lint`           | Independent policy, configuration, and complete native lint checks                                                       |
| `npm run lint:agent`     | The same gates with native agent-format lint output                                                                      |
| `npm run lint:fix`       | The same scope with reviewed safe native fixes                                                                           |
| `npm run format`         | Oxfmt writes supported maintained files                                                                                  |
| `npm run format:check`   | Non-writing formatting check                                                                                             |
| `npm run check`          | Canonical TypeScript compiler, separate from semantic lint                                                               |
| `npm run check:compat`   | Independent compiler and complete test commands                                                                          |
| `npm run test:native`    | Real installed-SDK lifecycle and provider suites                                                                         |
| `npm test`               | Unit, renderer, archive, enforcement, and real-host suites                                                               |
| `npm run build`          | npm package dry-run for this source-distributed extension                                                                |
| `npm run verify`         | Provenance first, then every independent required gate                                                                   |

`scripts/verify.ts` invokes each child through the same npm and inherits its complete output.
It continues after a failed independent gate and returns failure if any gate fails. The internal
`lint:oxlint`, `lint:agent:oxlint`, and `lint:fix:oxlint` scripts contain the native invocations.
The public lint commands include policy and configuration checks too.

CI's strict quality job runs `npm run verify` against the locked minimum-version SDK graph.
The official and fork lanes separately qualify the exact latest host identities. Release
qualification runs the same acceptance command and disposable negative controls against the
candidate source. `prepublishOnly` also requires acceptance.

## Coverage

The inventory reads the filesystem, excluding only Git internals and npm dependencies. It compares
all maintained JavaScript and TypeScript with native Oxlint traversal. Ignored or newly added
handwritten source therefore cannot disappear from coverage. Temporary invalid probe programs
live outside the repository and their harness checks the intended diagnostics and statuses.

`tsconfig.json` is the canonical compiler project. The native TypeScript API verifies actual program
membership, effective compiler minimums, checked JavaScript, and declaration ownership. A new project
requires a corresponding compiler gate and explicit qualification. The application's dependency
`skipLibCheck` setting does not cover handwritten declarations. Adding one requires a real
`skipLibCheck: false` compiler owner. Compiler-resolved production imports cannot depend on the
test-only profile.

Appendix A supplies the root policy. The Node plugin and `test/*.ts` support mapping preserve its
base plugins, categories, options, and all unaffected rules. Configuration checks compare the
qualified composition directly. Introducing nested lint or format configuration, changing ignore
ownership, broadening an override, or changing required commands needs a matching record and controls.
The checker constrains the repository's actual composition instead of implementing a second config
merger or type analyzer.

Oxfmt retains tabs with width four, double quotes, semicolons, and LF. Markdown and YAML use two
spaces. Sorting and JSDoc transformations remain disabled. npm owns the lockfile; illustration
assets retain their existing byte ownership. The source package has no emitted build step.

## Editor

`.vscode/extensions.json` recommends `oxc.oxc-vscode`. The workspace settings select its formatter,
explicit save-time fixes, semantic analysis, and unused-directive diagnostics. Editor feedback is
not acceptance evidence; the required npm commands and CI check the committed dependency graph.

## Exceptions and detection limits

Appendix B contains the comparisons and remaining protections for each decision. The executable
site inventory is `scripts/quality-sites.ts`. Native next-line directives identify one rule,
a QX identifier, and a reason. Authorization checks the real comment, target AST operation,
enclosing named and anonymous owners, actual SDK declaration where applicable, and duplication.
Native unused-disable reporting remains required.

QX-001 permits only the needed `node:test` registration alias in genuine test scopes. Context
subtests, local and foreign same-named functions, ordinary async calls, and work inside a test
remain checked. QX-002 preserves the SDK's fixed five-argument execute methods. QX-003 permits
only the two request-owned faux option writes. QX-005 preserves one required absent signal slot.
QX-010 preserves two graph-selected native module bindings under the canonical loader's identity
checks. Ordinary application mutation, unsafe propagation, and explicit-undefined checks remain.

QX-011 records published import-analysis limits: the qualified native importer detects the
retained static and type-only cycle controls, but not cycles through external packages or the
awaited-dynamic-cycle control. External and dynamic module boundaries still need review. These
limitations are not a claim that such cycles are safe or completely checked.

## Verification evidence

`test/quality-*.test.ts` and the two rule-case modules own normal enforcement regression coverage.
Controls assert native rule identifiers, files, lines, statuses, and valid counterparts. The real
Node runner and strict assertions supply runtime failure propagation.

`scripts/release-quality-controls.sh` uses a clean candidate and disposable worktree. Independent
native-lint, semantic, compiler, formatter, test, and policy faults must fail the real aggregate without
hiding later gates. Safe lint fixes and formatting run twice and their diffs must converge.

Required CI retains `strict-quality-fixtures` and `host-qualification-official` or
`host-qualification-fork` artifacts. Release controls record the exact source commit and tree in
`release-controls/source.txt`; the workflow also checks its requested candidate commit before
running acceptance. Local results, hosted results, review findings, and publication are separate
claims. [Section 10.2](engineering-standard.md#102-completion-criteria) defines completed adoption.
