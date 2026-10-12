# Developing Posthorse

Maintainer commands, host qualification, and release procedures live here.
For everyday use, see the [README](../README.md).

## Develop

```bash
npm ci --ignore-scripts
npm run verify                        # strict policy, lint, formatting, typecheck, tests, package build
npm run check:compat                   # typecheck, unit tests, and the real-SDK suite for the installed host
```

Oxlint owns code quality; Oxfmt owns formatting. See [Code quality](quality.md) for coverage,
exception governance, editor setup, and the enforced acceptance workflow.

`npm run check` type-checks the extension, renderers, and tests against the official npm declarations. `npm test` covers reminder policy, notes/history behavior, failed note replacement, real native card components (including width and expansion), the native lint probes, and the `test:native` suites, running files and independent lint probes in parallel.

Development dependency policy: update TypeBox alongside the Pi cohort to match the host's version, not independently. Official 1.0 uses 1.3.27. The earlier 0.99.2 startup investigation is historical, not a current support target or a claim about 1.0 performance. Qualify later releases against their actual packaged SDK/CLI and companion graph; resolve companions relative to coding-agent because its shrinkwrap nests dependencies. Revisit the TypeBox pin when the host changes its dependency.

Native session suites own registration, question-outcome provenance, reminder delivery, and active-context history exclusions (both Posthorse rollover and native compaction). Unit tests retain distinct policy arithmetic, archive/storage edge cases, and performance bounds; renderer tests exercise actual native cards.

`test:native` runs public-API suites against the installed real SDK, covering native recovery eligibility and physical request boundaries, real loading, prompt composition, explicit/automatic rollover without a summary call, owner-provenance safety, failed siblings, cancellation, queued input, recovery records, notes and history. The 1.0 fork starts from official semantics; old fork checkpoint and early-compaction customizations are not current contracts. Legacy saved-window and async-result data remain recoverable; no retired runtime ABI or blanket skips are needed. `PI_COMPAT_HOST` labels the selected distribution; `PI_HOST_INDEX`, `PI_COMPAT_EXPECTED_PACKAGE_DIR` and `PI_COMPAT_EXPECTED_VERSION` validate the actual selected graph. Typechecking uses that graph too, never an optional fork method as a distribution heuristic.

For a focused read-only SDK diagnostic only, `PI_HOST_INDEX=/absolute/fork/dist/index.js node --test test/native.test.mjs` can inspect an immutable host; this does not qualify this checkout's types. The canonical real-SDK suites replace the obsolete source-copying fork harness; validation never needs to write into a host checkout. All native fixtures must use an isolated HOME/agent directory and short TMPDIR outside real-home ancestry, with no project markers in temporary-path ancestors, offline mode and no provider credentials. These checks do not claim native Windows support.

## Requirements

- Node `>=24.12.0`.
- Pi `>=1.0.0`, official (`@earendil-works/pi-coding-agent`) or a maintained fork with the same public compaction contracts. No checkpoint, metadata iterator, or native context-window API is required.

Required qualification targets: latest stable official Pi and latest maintained fork `main`, resolved once per workflow run and retained with exact SDK/CLI identity evidence. Locked development dependencies are reproducible build snapshots, not validation targets. Historical official Pi `1.0.0` ([source `a13d35a`](https://github.com/earendil-works/pi/commit/a13d35a742c6ef8462812a28fbe1d8c8b7431c32)), TypeBox `1.3.27` and Node `24.21.0` evidence does not certify newer hosts. Qualification does not install, activate, or restart the live runtime.

For latest-host qualification, run `node /path/to/automation/scripts/qualify.mjs --repo pi-posthorse --source "$PWD" --host official --target latest --output /tmp/pi-posthorse-official`, then qualify the packed latest maintained fork with `--host fork --target /path/to/fork-package`. Plain `npm ci` checks only the locked development snapshot, not latest qualification.

## Automatic npm releases (maintainers)

Follow the [shared release procedure](https://github.com/fitchmultz/.github#automatic-npm-releases): merge a reviewed PR into `main` with an intentional `package.json` version bump and a matching versioned `CHANGELOG.md` section. Once configured and enabled, publication is unattended after the full existing CI workflow and candidate-tarball qualification pass. Complete any applicable package-specific release evidence before merging the bump. Automation never bumps versions, overwrites releases, or republishes an existing version; existing manual publisher instructions remain valid.

Failed/unpublished candidates can retry daily at 12:17 UTC or via manual dispatch of `npm release` on `main`, without another bump. Set repository variable `NPM_RELEASE_ENABLED` to anything other than `true` to stop new release plans; cancel pending runs separately when needed. Workflow validation is not evidence of a completed real OIDC publication.
