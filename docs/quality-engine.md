# Corrected type-aware checker

The lockfile pins `oxlint` 1.87.0 and `oxlint-tsgolint` 7.0.2003. The published backend has two
safe-call false negatives: file-qualified allowances can match by spelling without checking the
file, and a top-level `node:test` allowance also exempts unawaited `TestContext.test()` subtests.
These are checker defects, not permission to change Promise ownership or registration ordering.

`patches/tsgolint-safe-call.patch` corrects the native checker. It resolves the actual callee symbol,
follows import/re-export aliases, and checks its original declaration name and source. Instance
methods and property/accessor symbols cannot inherit registration ownership. An unrelated value
with the same callable type is not an approved declaration. File matching canonicalizes symlinks
and respects the host filesystem's case sensitivity. Safe-Promise exemptions remain empty.

The narrow correction and upstream build recipe were independently verified in `pi-subagents`
(commit `32c2ad92d7ffdfc38920fe1894d362b6149e5d90`) and are retained here with repository-specific
acceptance probes. That evidence does not replace this repository's probes or certify other rules.

`patches/tsgolint-readonly.patch` adds independently tested readonly corrections. It recognizes
collection methods only from their actual default-library interfaces, checks instantiated Map keys
and values / Set contents recursively, and never treats a readonly method property as removal of a
Map/Set mutator. Every intersection constituent is checked before a native allowance can apply, so
an approved SDK handle cannot launder mutable attached application state. Qualified value matching
uses the same original-declaration identity instead of accepting a qualified entry by spelling.
Allowances accept the native declaration's API, not consumer-owned merged fields or index signatures;
added data must independently satisfy deep readonly contracts. Ambient module labels alone cannot
confer package ownership. The unsuppressed collection, same-name, SDK attachment, augmentation and
alias probes exercise the installed CLI.
The shared correction was verified in `pi-apply-edits` at
`caac7d779a389801358c3b184bc0bddead63a1fe`; this repository retains its own native acceptance matrix.

Readonly views of mutable collections are recognized for `get`/`has`/`size` capabilities only.
Iterator/callback views require additional ownership analysis before extending that conservative
ceiling. Full native `ReadonlyMap`/`ReadonlySet` inputs retain their explicit nonmutating contracts.

## Reproducible preparation

Install Git and Go 1.26 or newer, then use the locked npm installation:

```sh
npm ci --ignore-scripts
npm run quality:prepare
npm run verify
```

`node scripts/setup-quality-engine.ts --help` documents the standalone preparation command;
`--force` builds from fresh sources. Normal lint, fixes, agent output, acceptance, and CI prepare the
same checker. Preparation atomically installs the corrected executable into the project's
lockfile-resolved platform package, so raw Oxlint and the editor's native backend lookup also use
the correction. No global or live Pi runtime is modified.

The editor uses the same project-local installed backend without a separate binary-path override.
Its workspace settings explicitly enable semantic linting and deny unused disable directives, using
the [supported editor and LSP options](https://oxc.rs/docs/guide/usage/linter/lsp-config-reference.html).

A clean install must be prepared before editor linting. The first build needs GitHub and the Go
module proxy. A verified cached build needs neither Go nor network. Build failure preserves the
previous executable and causes the invoking acceptance command to fail.

Pinned inputs:

- tsgolint 7.0.2003 source: `eb9339115edde6811ca94c3433adf69ea9852880`.
- TypeScript Go submodule: `2bd066d87f5bafd315be9f40889d0a60b9e58e0b`.
- Ordered upstream `patches/*.patch` and collection preparation from that source revision's
  canonical initialization recipe.
- Ordered repository corrections: `patches/tsgolint-safe-call.patch`, then
  `patches/tsgolint-readonly.patch`.
- Upstream Go manifests/checksums, with `-mod=readonly`, `-trimpath`, `-buildvcs=false`, and
  `CGO_ENABLED=0`.

The project-local cache under `node_modules/.cache/pi-quality-engine` records source/submodule
revisions, each patch SHA-256, platform/architecture, Go version, and executable SHA-256. Changed inputs
or executable contents force a rebuild; a pristine installed package can be repatched from the
verified cache. Build artifacts are neither maintained source nor part of the published extension.

## Enforcement and removal

Run the native CLI origin-isolation matrix after clean installation and every dependency or patch
change. It checks the actual approved registration alongside local same names, foreign files and
packages, shadows, aliases, re-exports, wrong qualifiers, ordinary asynchronous work, and unawaited
subtests. Diagnostic rule IDs and locations must match; parser/configuration failures and extra
findings cannot stand in for the expected negative result.

Remove the patch/build path only after a compatible upstream release passes the entire matrix.
Schema acceptance or a version bump is insufficient. The shared file-path correction also affects
other qualified rules; each allowance still needs its own independent origin probes.
