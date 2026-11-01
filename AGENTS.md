# Agent instructions

## Code quality and acceptance

Follow [Engineering standard 5.1.2](docs/engineering-standard.md). Its Appendix B owns the
repository mappings and evidence-based quality exceptions. Preserve accurate contracts,
assertions, lifecycle ownership, and source coverage while improving the implementation.

Use Node 24, the npm version declared in `package.json`, and the committed lockfile.
Run `npm ci --ignore-scripts`, then `npm run verify`. The workflow requires independent
policy, configuration, native lint, formatting, compiler, test, and package gates.
[Quality acceptance](docs/quality.md) lists focused commands and verification evidence.

## Repeated-correction safeguards

| Rule                                                                                          | Enforcement                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolve receipt retention against its source before substituting an edited history reference. | `projectedToolEntries` owns the decision; `recoverableToolResults` receives a required boolean, never the retention set or source ID. The retained/discarded edited-receipt regression runs in `npm run verify`. |
| Keep shared qualification/release refs and declared support-floor policy coherent.            | `scripts/config-policy.ts` parses the YAML/JSON authority fields in `npm run quality:config`, including normal lint and `npm run verify` in CI. It names the mismatched path and canonical source.               |
| Run acceptance with Node 24 and the npm version declared by `package.json`.                   | `npm run verify` first runs `scripts/toolchain-policy.ts`, which checks the invoking npm's actual manifest through `npm_execpath`, not a PATH guess or advisory user-agent.                                      |

Evidence and historical failure reproduction: [Correction safeguards](docs/corrections.md).
Keep this table paired with executable enforcement when a correction repeats. Remove obsolete
rules rather than preserving instructions for paths the architecture has eliminated.

## Dependency maintenance

- Frequently and proactively check releases and make appropriate upgrades across maintained packages and all runtime, development, build, test, and tool dependencies, prioritizing the latest stable official Pi and the intended maintained Pi fork. Routine in-scope maintenance needs no repeated approval; delivery remains subject to existing authority and gates. Keep the complete official-Pi path and distinguish any fork-enhanced capabilities.
- Review crossed release notes, changelogs, migration guidance, and security advisories before upgrading. Verify real APIs and contracts across supported hosts and platforms using each target's exact SDK/CLI and compatible, consistently locked dependency cohort, including host-supplied companions. Preserve lockfile policies, peer contracts, and support floors; a matching version string or locked snapshot alone is not latest-host qualification.
- Adopt beneficial current conventions, patterns, APIs, and functionality instead of extending deprecated or obsolete approaches. Preserve supported behavior and independent use; align affected callers, documentation, generated surfaces, and fixtures through their canonical owners.
- Follow [development and host-qualification rules](docs/development.md) and [quality acceptance](docs/quality.md). Run all applicable required lint, format, type, test, build, package, native, CI, and review gates; report exact targets, commands, results, skips, and unverified limits honestly. Documentation checks alone do not qualify runtime behavior. Never weaken safety, checkers, fixture contracts, or supported-target requirements to make an update pass.
- Roll out updates controllably with a rollback path through existing review, approval, and release gates; honor every explicit hold. This authorization is not blanket permission to publish, install into or restart an active runtime, disclose private data, or change global model or authentication settings.
