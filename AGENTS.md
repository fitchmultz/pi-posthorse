# Agent instructions

## Code quality, maintainability, and verification

Use npm, the committed lockfile, Node 24, the existing workspace and TypeScript configuration.
Run `npm ci --ignore-scripts`, prepare the corrected quality engine, then use `npm run verify`.
See [docs/quality.md](docs/quality.md) for coverage, exceptions and tooling contracts.

Preserve compatible verified work. Complete the policy integration and resulting source cleanup.
Treat correctness, long-term maintainability, and trustworthy enforcement as equal objectives.

Keep the configured production complexity, size, readonly, and safety requirements. A finding need
not identify an existing runtime bug to justify a maintainability improvement.

Use authorized semantic exceptions only when their conditions are demonstrated. Additional
relaxations require concrete evidence and explicit approval.

Apply type-aware checks to TypeScript and checked JavaScript. Keep other maintained JavaScript
covered by applicable lint, formatting, and tests. Do not use compiler suppressions to reduce scope.

Verify declaration-qualified allowances with positive and negative origin-isolation probes.
Keep floating-Promise protection strict, including ordinary async work and unawaited subtests.

Preserve accurate API contracts and runtime behavior. Resolve unsafe types with validation,
narrowing, and sound type relationships. Use contextual inference where useful. Keep explicit
public contracts and application-owned readonly data intentional.

Refactor large production functions along real responsibilities. Make state ownership, async
phases, failure behavior, and cleanup clear. Keep internal APIs private where possible.

A single-use helper is useful when it creates a meaningful boundary. Avoid forwarding layers,
arbitrary file splits, giant shared context objects, and speculative frameworks.

Preserve ordering, cancellation, deletion guards, error identity, retries, and lifecycle cleanup.

Keep cohesive lifecycle tests together. Tests retain branching and parameter limits but are exempt
from size and statement limits. Correct invalid fixtures while preserving assertions that express
the intended behavior. Verify both isolated and suite execution.

Review autofixes and the maintainability of the resulting structure. Use `npm run lint:fix` and
`npm run format` during development, `npm run lint:agent` for structured diagnostics, and run the
actual `npm run verify` acceptance workflow on the integrated revision. Compiler checking, tests,
packing, and code review remain independent gates.

Report configuration changes, formatting, maintainability improvements, checker fixes, fixture
repairs, and runtime bugs separately. Report commands, results, coverage, exceptions, and
verification limits accurately.

## Dependency maintenance

- Frequently and proactively check releases and make appropriate upgrades across maintained packages and all runtime, development, build, test, and tool dependencies, prioritizing the latest stable official Pi and the intended maintained Pi fork. Routine in-scope maintenance needs no repeated approval; delivery remains subject to existing authority and gates. Keep the complete official-Pi path and distinguish any fork-enhanced capabilities.
- Review crossed release notes, changelogs, migration guidance, and security advisories before upgrading. Verify real APIs and contracts across supported hosts and platforms using each target's exact SDK/CLI and compatible, consistently locked dependency cohort, including host-supplied companions. Preserve lockfile policies, peer contracts, and support floors; a matching version string or locked snapshot alone is not latest-host qualification.
- Adopt beneficial current conventions, patterns, APIs, and functionality instead of extending deprecated or obsolete approaches. Preserve supported behavior and independent use; align affected callers, documentation, generated surfaces, and fixtures through their canonical owners.
- Follow [development and host-qualification rules](docs/development.md) and [quality/checker contracts](docs/quality.md). Run all applicable required lint, format, type, test, build, package, native, CI, and review gates; report exact targets, commands, results, skips, and unverified limits honestly. Documentation checks alone do not qualify runtime behavior. Never weaken safety, checkers, fixture contracts, or supported-target requirements to make an update pass.
- Roll out updates controllably with a rollback path through existing review, approval, and release gates; honor every explicit hold. This authorization is not blanket permission to publish, install into or restart an active runtime, disclose private data, or change global model or authentication settings.
