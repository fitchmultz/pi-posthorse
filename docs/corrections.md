# Correction safeguards

These safeguards address repeated mistakes, not speculative style preferences. Local acceptance
and CI both run `npm run verify`. No new suppression or policy exception is introduced.

## Source identity is not a history-read reference

Evidence:

- [Context-edit recovery, #38](https://github.com/fitchmultz/pi-posthorse/pull/38)
  (`532c9b8`) needed replacement-entry references so history reads recover edited content rather
  than the original message.
- [Retained edited receipts, #92](https://github.com/fitchmultz/pi-posthorse/pull/92)
  (`3bfdd37`) fixed the inverse mistake: comparing replacement IDs to retained source IDs copied
  an already-retained receipt into the recovery record again.

**Level: architecture, with a required typed decision.** `projectedToolEntries` resolves retention
while it still owns the native source entry, then supplies the effective history-read ID and a
required `retained` boolean. `recoverableToolResults` cannot compare the two identities because it
receives neither the source ID nor the retention set. It still sees every call/result before
selecting receipts, preserving call provenance and trailing-batch chronology.

The source and replacement identities cannot be collapsed into one ID: Pi retains the source,
whereas history must read the replacement. The architecture removes that choice from the receipt
selector instead of adding string brands, casts or a second identity registry.

The existing owner-boundary test
`retained edited async receipts are excluded by source identity while discarded edits keep history pointers`
checks both contracts. With `src/recovery.ts` and `src/recovery-results.ts` restored from
`3bfdd37^` in a disposable checkout, it fails because `APPROVED_RECEIPT` is repeated despite being
retained. It passes with the owner-boundary separation. Run it independently with:

```sh
node --import ./test/pi-loader.ts --test \
  --test-name-pattern='retained edited async receipts' test/posthorse.test.ts
```

## Partial updates leave coupled configuration inconsistent

Evidence:

- [Automation-reference repair, #72](https://github.com/fitchmultz/pi-posthorse/commit/3f15d89e80454311856be32afc2d5b4b58fc83e5)
  aligned CI's `a465b71` and release planning/publishing's `3b7a5f7` references to one revision.
  The earlier divergence is the mistake; this does not attribute the artifact-producer defect
  itself to unequal SHAs.
- [Support-floor review, #91](https://github.com/fitchmultz/pi-posthorse/pull/91#issuecomment-6317114839)
  found Renovate's `>=1.0.0` range left behind after the peers moved to `>=1.3.0`. Head
  `53083d4e8d63adfe358674fdddde2d0611cfb31a` contains the mismatch; `70550f6` repairs it.

**Level: parsed configuration check.** `scripts/config-policy.ts` treats CI's
`env.PI_AUTOMATION_REF` as the canonical immutable revision. Shared reusable-workflow references,
their `automation-ref` inputs, and the automation checkout must follow it. The coding-agent peer
range owns the support floor; the TUI peer and local Pi development-cohort policy must agree.
Diagnostics identify the file/property and the authority to use. Consistent future revision and
floor changes remain valid; the current values are not frozen in a test.

The local floor has one applicable npm/devDependencies/Pi-cohort rule. Extra applicability
selectors or competing broad, regex or Pi-specific range rules are rejected rather than partially
interpreted. Other range rules may target literal non-Pi package names or explicitly non-npm
managers. This is a narrow local authority contract, not a general Renovate evaluator.

One literal cannot replace all seven workflow values:
[GitHub forbids contexts and expressions in reusable-workflow `jobs.<job_id>.uses`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_iduses).
Generating whole workflows would add a second workflow format and synchronization step.
The parser checks the actual runnable files instead. Types alone cannot enforce relationships
between YAML and JSON files.

The inherited Renovate preset was disabled when this safeguard was added. Checking the local
range preserves declared policy; it does not claim active dependency-update automation.
The checker uses direct development dependency `yaml@2.9.1`, not a host's transitive parser.
Its release notes cover recursive merge-alias limiting and quoted-string unfolding; no Pi cohort,
TypeBox, native checker or runtime dependency was upgraded.

Historical CLI proof:

- Restoring both workflow files from `3f15d89^` makes the checker exit 1 with four release-ref
  mismatches. Restoring `3f15d89` makes the same command exit 0.
- With the actual package/renovate files from `53083d4`, it exits 1 for `allowedVersions`.
  Substituting the fixed `70550f6` Renovate file makes it exit 0.

Run the same checker locally and through normal acceptance:

```sh
node scripts/config-policy.ts /path/to/disposable-checkout
npm run quality:config
npm run verify
```

`test/quality-config.test.ts` exercises the real CLI, independent reference drift, a coherent
future update, environment shadowing, stale or overriding floor rules, duplicate YAML authority
keys and missing policy.
It uses disposable semantic fixtures, not snapshots or source-text matching.

## Declared tools are not necessarily the tools that ran

Evidence:

- [PR #105](https://github.com/fitchmultz/pi-posthorse/pull/105) records earlier npm 11.19.1
  attempts separately from its correctly pinned Node 24.22.1/npm 12.2.0 qualification. Those
  later valid receipts remain valid; this safeguard does not require repeating them.
- This correction task initially ran acceptance with globally selected npm 12.2.1 despite
  `packageManager: "npm@12.2.0"`. The workflow accepted the wrong tool. A first isolated attempt
  also showed shell startup could replace the intended PATH; its version assertion failed
  before acceptance ran. Final acceptance was rerun with the actual declared version.

**Level: verification-entrypoint check.** `scripts/toolchain-policy.ts` resolves the invoking
npm's own manifest from `npm_execpath`, compares its identity to `packageManager`, and checks
Node 24 before any acceptance child runs. Missing provenance fails rather than guessing from
PATH or trusting an advisory user-agent. The declared npm version remains the single authority.

The native `packageManager` field is advisory. Native `devEngines` checks also run before install
and ci; Pi installs dependencies inside Git-package checkouts. Applying the development npm pin
there would constrain otherwise-supported consumers, so the gate belongs only to verification.
It neither modifies global tools nor raises the extension's runtime floor.

The real global npm 12.2.1 now fails immediately with both required and actual versions in the
error. The declared npm 12.2.0 passes the same entrypoint. The regression test copies the actual
repository `verify` command into a disposable project with a deliberately incompatible pin:
before the gate, its lint sentinel executes; afterward, npm is rejected before lint. Another
negative control verifies that missing invoking-tool provenance cannot silently pass.
