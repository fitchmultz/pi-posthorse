# Corrected native checkers

The locked npm CLI and editor use two native backends. `quality:prepare` builds the pinned Oxlint
NAPI correction first, then the corrected type-aware Go checker. Each standalone preparation
command fails on incompatible dependencies, source/patch/build errors or failed checksum checks.

## Native import cycles

`patches/oxlint-import-cycles.patch` applies to Oxlint 1.87.0, Oxc source revision
[`2bd08ebe8f36fcf1954a675ffdeb4c6d0129f609`](https://github.com/oxc-project/oxc/tree/2bd08ebe8f36fcf1954a675ffdeb4c6d0129f609).
The published rule ignored literal dynamic imports and physical `node_modules` edges despite
accepting `allowUnsafeDynamicCyclicDependency: false` and `ignoreExternal: false`.

The correction collects decoded strings and expression-free template imports, including transparent
parentheses and TypeScript wrappers, separately from static import/export records. It resolves
them with the existing native resolver and traverses
eligible occurrences with their actual source spans. It implements both options while preserving
type-only handling, self-imports/reexports, bounded depth and static-only barrel-file analysis.
Runtime-computed specifiers, unresolved modules and CommonJS/AMD cycles remain outside this
static ESM graph; no claim is made to detect those edges.

`node scripts/setup-oxlint-engine.ts --help` documents standalone preparation and `--force`.
The build uses the upstream release NAPI library, not a separate Rust CLI executable:

```sh
cargo build --locked --release -p oxlint --lib --features allocator
```

The Cargo lockfile is checked before and after the build. Compiler/profile overrides are cleared;
Rust's physical toolchain avoids inheriting an unrelated rustup override from fetched sources.
The cache key includes the pinned revision, patch and preparation-script SHA-256,
and native platform/architecture/libc binding. Its manifest records Rust/Cargo, native linker,
Cargo lockfile and addon hashes. Cached addons are checksum-verified without requiring build tools.
A checksum mismatch fails closed; use `--force` to rebuild.

Preparation verifies and atomically replaces the actual `@oxlint/binding-*` NAPI addon. Raw npm
Oxlint and its native LSP load that same addon without flags or environment overrides. Restart an
already running language server after preparation. Native LSP qualification uses physical workspace
and file URIs; the upstream graph can miss edges when aliased root paths differ from resolved paths.

The shared correction is preserved from `pi-apply-edits` source commit
`475cfb748dd7a847f414c8e65e1427cb8c863d3d`, with this repository's own unsuppressed static,
dynamic, type-only and physical-external installed-CLI probes.

## Type-aware declaration and readonly integrity

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
collection methods only from their actual default-library interfaces and checks each instantiated
data-exposure signature independently: getters, membership inputs, iteration, callbacks and Set
algebra. Erasing `get`/`has` cannot hide mutable values or keys, and a different read method cannot
launder another channel. Fresh entry-pair wrappers are distinct from mutable stored tuple contents.
Optional channels retain the same content checks after removing absent-member nullability.
Set subset/disjoint predicates also expose receiver elements to another set's `has` callback;
their instantiated receiver contents are checked even though their return type is Boolean.
Superset predicates do not have that exposure. The necessary pinned checker shims are generated
from `shim/checker/extra-shim.json`, not hand-maintained field layouts.
A readonly method property never removes a Map/Set mutator.
Every intersection constituent is checked before a native allowance can apply, so
an approved SDK handle cannot launder mutable attached application state. Qualified value matching
uses the same original-declaration identity instead of accepting a qualified entry by spelling.
Allowances accept the native declaration's API, not consumer-owned merged fields or index signatures;
added data must independently satisfy deep readonly contracts. Ambient module labels alone cannot
confer package ownership. The unsuppressed collection, same-name, SDK attachment, augmentation and
alias probes exercise the installed CLI.
The shared correction was verified in `pi-apply-edits` at
`caac7d779a389801358c3b184bc0bddead63a1fe`; this repository retains its own native acceptance matrix.
The per-channel partial-view correction is preserved from source commit
`d5ee4438392142613a4c0bf2d14073657a9f325d`, with unsuppressed positive and negative CLI fixtures.
The final mapped-method, array and qualified-alias ownership correction is preserved from
`10ad716a075ce3147a72317f92d31b049541afc4`; the canonical Go patch SHA-256 is
`e9560fcd3eaacebee9b39d8a51de476cd06a4a49d21163161fecfc12d136fc64`.

Readonly views of mutable collections are recognized for `get`/`has`/`size` capabilities only.
Read-method properties must actually be readonly; a plain or `Partial` mapped method is not an
immutable property. The same compiler-owned readonly check protects foreign application methods.
Iterator/callback views require additional ownership analysis before extending that conservative
ceiling. Full native `ReadonlyMap`/`ReadonlySet` inputs retain their explicit nonmutating contracts.
Their partial views retain per-channel content checking; unknown future native data channels are
rejected until their instantiated exposure contracts are implemented and probed.

Native readonly arrays and their derived/partial views check actual element exposure and
consumer-owned augmentation data. Native array methods do not grant blanket permission to
application methods or mutable nested elements. Qualified alias names and declaration sources
come from the same compiler-resolved alias; anonymous mapped carriers cannot assume that identity.

`patches/tsgolint-readonly-flatmap.patch` corrects one bundled TypeScript Go declaration:
`ReadonlyArray.flatMap` passes its original receiver as the callback's third argument, so that
argument is `readonly T[]`, not `T[]`. The mutable `Array.flatMap` declaration is unchanged.
The patch applies to the pinned submodule's actual build input,
`internal/bundled/libs/lib.es2019.array.d.ts`, preserving its Apache-2.0 license.
The bundled declaration is embedded directly; normal builds do not regenerate it.
The upstream generator's external TypeScript source is pinned at
`4d4f005c8541e0255a9d8791205fdce326e462bc`. If regenerating that dependency bundle, correct
`src/lib/es2019.array.d.ts` first or reapply this patch before building.
The patch SHA-256 is `97fd4ffec6951e6ecb14586a1ea0e2257b50bd5c6c06b8fe216a5937327c41e5`.
Installed native compiler probes reject an aliased callback-array `push`, while ordinary
readonly flatMap calls and mutable Array callback mutation remain valid. This correction is
limited to the native checker; the independent npm TypeScript compiler and its library files
are unchanged and are not claimed to reject that callback mutation.

## Reproducible preparation

Install Git, Go 1.26 or newer, Rust 1.97 or newer (qualified with 1.99.0), and a native linker
(`cc` on Unix; Visual Studio build tools for MSVC), then use the locked npm installation:

```sh
npm ci --ignore-scripts
npm run quality:prepare
npm run verify
```

`node scripts/setup-quality-engine.ts --help` documents the standalone preparation command;
`--force` builds from fresh sources. Normal lint, fixes, agent output, acceptance, and CI prepare the
same checkers. Preparation atomically installs the corrected backends into the project's
lockfile-resolved platform packages, so raw Oxlint and the editor's native lookup also use the
corrections. No global or live Pi runtime is modified.

The editor uses the same project-local installed backend without a separate binary-path override.
Its workspace settings explicitly enable semantic linting and deny unused disable directives, using
the [supported editor and LSP options](https://oxc.rs/docs/guide/usage/linter/lsp-config-reference.html).

A clean install must be prepared before editor linting. The first builds need GitHub, the Go
module proxy and the Cargo registry. Verified cached builds need neither compilers nor network.
Build failure preserves the previously installed backend and fails the invoking acceptance command.
Qualification creates a private HOME. Its caller prepends `$(rustc --print sysroot)/bin` to PATH
before that isolation, so the selected physical Rust toolchain remains available without rustup
settings from the original HOME. Posthorse's Linux qualification command reserves 20 minutes for
cold native compilation; individual test timeouts, assertions and production deadlines are unchanged.

Linux qualification creates its private tree under `/var/tmp/pc-*` to avoid
[Ubuntu 26.04's quota-enabled `/tmp` tmpfs](https://documentation.ubuntu.com/release-notes/26.04/summary-for-lts-users/).
Darwin keeps `/tmp/pc-*` for its tighter Unix socket pathname limit; Windows uses its native
temporary directory. HOME, caches and temporary build files remain inside that isolated tree,
and qualification removes the complete tree afterward.

Pinned inputs:

- tsgolint 7.0.2003 source: `eb9339115edde6811ca94c3433adf69ea9852880`.
- TypeScript Go submodule: `2bd066d87f5bafd315be9f40889d0a60b9e58e0b`.
- Ordered upstream `patches/*.patch` and collection preparation from that source revision's
  canonical initialization recipe.
- After upstream submodule patches, apply `patches/tsgolint-readonly-flatmap.patch` to the bundled
  declaration before preparing collections and building the checker.
- Ordered repository corrections: `patches/tsgolint-safe-call.patch`, then
  `patches/tsgolint-readonly.patch`.
- Upstream Go manifests/checksums, with `-mod=readonly`, `-trimpath`, `-buildvcs=false`, and
  `CGO_ENABLED=0`. `-modcacherw` keeps newly downloaded module-cache directories removable in
  disposable qualification environments; it does not permit manifest or checksum changes.

The Go cache key includes source/submodule revisions, each patch SHA-256, the preparation-script
SHA-256 and platform/architecture. Its receipt records those inputs, Go version and executable
SHA-256. Changed inputs require a new build; a checksum mismatch fails closed and requires `--force`.
A pristine installed package can be repatched from the verified cache.

Both output caches live under `pi-quality-engine` in `npm_config_cache` when npm supplies a cache
directory, otherwise under the project's `node_modules/.cache`. Only compiled outputs and receipts
are shared, never source trees, installed dependencies or Cargo/Go build directories. CI's strict
quality job compiles and probes the corrections once, then uploads a tar archive preserving binary
permissions. Both isolated host qualifications download those same-run outputs and independently
verify their input identities and checksums before copying them into fresh platform dependencies.
All compiler, checker, behavior, native-host and installed-consumer assertions still run for each
host. Build artifacts are neither maintained source nor part of the published extension.

## Enforcement and removal

Run the native CLI origin-isolation matrix after clean installation and every dependency or patch
change. It checks the actual approved registration alongside local same names, foreign files and
packages, shadows, aliases, re-exports, wrong qualifiers, ordinary asynchronous work, and unawaited
subtests. Diagnostic rule IDs and locations must match; parser/configuration failures and extra
findings cannot stand in for the expected negative result.

Remove the patch/build path only after a compatible upstream release passes the entire matrix.
Schema acceptance or a version bump is insufficient. The shared file-path correction also affects
other qualified rules; each allowance still needs its own independent origin probes.
