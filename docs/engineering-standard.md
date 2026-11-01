# Strict Oxlint and Oxfmt Engineering Standard

**Version 5.1.2 · 1 November 2026**

This standard defines linting, formatting, typechecking, and verification requirements for JavaScript and TypeScript projects. It applies to engineers, reviewers, and coding agents.

**Apply strict checks by default. Relax an applicable rule only when evidence demonstrates that the best reasonable compliant implementation would produce worse code.**

The objective is software that is correct, maintainable, readable, consistent, appropriately reusable, and efficient. Automated checks support that objective; passing them is necessary for acceptance but does not by itself establish engineering quality.

This file is the complete implementation standard. Each adopting repository supplies its configurations, source mappings, verification, and local exception records. Previous releases and external conversations are not required to interpret it.

## Contents

1. [Quality and authority](#1-quality-and-authority)
2. [Quality exceptions](#2-quality-exceptions)
3. [Code design and behavioral contracts](#3-code-design-and-behavioral-contracts)
4. [Source coverage and compiler requirements](#4-source-coverage-and-compiler-requirements)
5. [Toolchain and lint requirements](#5-toolchain-and-lint-requirements)
6. [Frameworks and test runners](#6-frameworks-and-test-runners)
7. [Formatting and generated artifacts](#7-formatting-and-generated-artifacts)
8. [Verification and enforcement integrity](#8-verification-and-enforcement-integrity)
9. [Adoption and change review](#9-adoption-and-change-review)
10. [Acceptance and maintenance](#10-acceptance-and-maintenance)

- [Appendix A: Base Oxlint configuration](#appendix-a-base-oxlint-configuration)
- [Appendix B: Repository records](#appendix-b-repository-records)
- [References](#references)

## 1. Quality and authority

### 1.1 Quality criteria

Evaluate the resulting code against all of these criteria:

| Criterion       | Required outcome                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| Correctness     | Supported behavior, public contracts, security boundaries, and failure semantics remain sound.         |
| Maintainability | Responsibilities and state ownership are clear; changes have understandable, bounded effects.          |
| Readability     | Names, control flow, and interfaces support local reasoning without unnecessary indirection.           |
| Consistency     | Equivalent operations follow established project conventions and use the same authoritative contracts. |
| Reuse           | Shared domain knowledge, types, schemas, validation, and utilities have appropriate common ownership.  |
| Efficiency      | Resource use, execution order, concurrency, and runtime cost fit the actual workload and contracts.    |

A reduction in lines or diagnostic count is not sufficient evidence of improvement. A gain in one criterion cannot justify incorrect behavior or unsafe data flow. Prefer native capabilities and established project abstractions when they accurately meet the requirement.

### 1.2 Requirements and discretion

**Must** identifies a requirement. **Should** identifies a recommendation whose applicability depends on the stated context. **May** identifies a permitted choice. Configuration blocks and limits are normative where their stated profile applies.

Implementers must apply the baseline and defined profiles. An **implementation mapping** selects their actual files, runtimes, framework settings, or commands without reducing their requirements. Applying the defined test profile to genuine test code is a mapping.

A **relaxation** disables an applicable rule, weakens an option, raises a limit, broadens an allowance, or reduces the source operations a required check examines. It remains a relaxation whether expressed through an override, directive, nested config, CLI flag, plugin list, wrapper, or custom rule. Every repository-specific relaxation beyond the defined profiles requires a quality exception under Section 2. Calling a change a mapping does not authorize weaker enforcement.

An instruction to adopt this standard authorizes implementation work and evidence-backed quality exceptions. Engineers and agents may make qualifying decisions without requesting a new policy release or another approval for each exception. Existing review requirements, branch protections, ownership constraints, and the authorization granted for the work remain in force. Adoption alone does not grant permission to merge, deploy, alter product contracts, or overwrite unrelated work.

Additional architectural requirements must come from an applicable repository instruction or a demonstrated engineering need. This standard does not impose universal bans on barrels, mutable resource types, single-consumer helpers, or checked JavaScript. Label discretionary design recommendations accordingly.

## 2. Quality exceptions

### 2.1 Eligibility

A quality exception is permitted only when a documented comparison demonstrates that the best reasonable compliant implementation would materially worsen the code under Section 1.1. It can address a checker false positive or an otherwise accurate lint finding whose prescribed change is inappropriate for the actual contract.

Valid grounds can include correctness, public or runtime compatibility, accurate typing, ownership, lifecycle, accessibility, demonstrated performance, or material readability and maintainability. Exceptions can apply to lint rules, structural thresholds, and formatting requirements.

Migration size, time pressure, a green-check deadline, personal preference, or the existence of old code does not establish eligibility. Compare against a sound, straightforward compliant alternative, not an artificially cumbersome rewrite. Investigate enough to resolve the actual decision; an exhaustive search of hypothetical designs is not required.

### 2.2 Decision process

Each exception must establish:

1. **The finding.** Identify the installed tool version, rule and options, affected operation, and a reproducible diagnostic. Check project membership, declarations, and configuration before attributing the problem to the rule.
2. **The contract.** Explain the behavior, type relationship, ownership, or design responsibility that must remain correct. Cite the relevant code, consumers, or API contract.
3. **The comparison.** Present the best reasonable compliant alternative and its concrete quality cost. Use code comparisons for readability claims and focused tests or probes for runtime/type-contract claims.
4. **The adjustment.** Select the narrowest useful option, declaration-qualified allowance, operation-bound directive, or file/profile override. A global change requires evidence of a systematic mismatch across the rule's relevant uses.
5. **The remaining protection.** Verify the intended case passes and meaningful neighboring violations still fail. State what detection is lost and what other checks protect the affected contract.
6. **The review record.** Record the decision using Appendix B and include the implementation, configuration, and relevant checks in the same reviewable change. Use independent review when available; otherwise perform and identify a separate critical review pass.

The evidence, rather than the presence of an exception identifier, establishes justification. If the comparison does not establish a quality loss, retain the rule and improve the implementation. If correctness remains unresolved, leave the finding visible and continue independent work.

### 2.3 Structural and unsafe-type evidence

For a structural exception, show the actual proposed implementation and the compliant alternative, including any helpers or interface changes it introduces. Record the relevant metric before and after. Explain the concrete effect on responsibilities, contracts, or readability. The exception record and PR must include or link the comparison. A rejected alternative can be a review excerpt or patch; it need not remain in production code. An unsupported assertion that extraction adds indirection is insufficient.

For `no-explicit-any` or a `no-unsafe-*` exception, brevity or stylistic preference is insufficient. Identify the exact value/type flow and establish why the operation is sound despite the diagnostic. Show how unchecked information is validated or otherwise constrained before trusted use. Supply relevant compiler, runtime, or declaration-contract evidence and a meaningful invalid control. Record remaining assumptions; assumptions essential to safety must be established before accepting the exception. Eligibility depends on evidence, not whether the code originated inside or outside the repository.

### 2.4 Scope and directives

Use native configuration when it expresses the intended scope clearly. When a site directive is more precise, use a next-line directive for one rule with a stable exception identifier and concise reason:

```ts
// oxlint-disable-next-line unicorn/prefer-add-event-listener -- QX-001: SDK exposes only this callback property.
```

The example demonstrates syntax; a real site requires its own documented decision. Blanket, file-wide, and range lint disables, ESLint disable directives, and undocumented inline configuration are not permitted. If an operation needs several exceptions, identify each separately and verify the installed tool's attachment behavior.

Bind site-based decisions to an explicit inventory of **file, rule, and authorized operation**. Use a stable selector such as an enclosing function plus the relevant call or assignment. Anonymous callbacks need an equally bounded selector. Verify the directive's actual attachment, not just its identifier. A per-file or per-selector count may provide an additional duplication check; counts and line numbers cannot establish operation identity by themselves.

Verify that a directive copied to another file or operation is rejected. Include replacement of the authorized directive with an unauthorized one while keeping the total count unchanged, and a duplication control when count bounds are used. One decision may cover a repeated pattern through enumerated sites or a bounded, mechanically checked eligibility selector. New sites require an explicit scope update and relevant evidence under the same decision authority.

Declaration-origin allowances must use the actual installed declaration. Qualify them with accepted and wrong-origin controls. Compiler-checked SDK receiver types can provide useful origin evidence; account for structural typing and private members rather than assuming every annotation establishes identity. Use ordinary compiler facilities and focused checks instead of constructing a new type analyzer.

Remove unused directives and stale records. Reassess exceptions when their dependency, rule behavior, contract, or available implementation changes. No arbitrary exception quota, expiration date, or external tracking service is required.

### 2.5 Non-negotiable boundaries

An exception must not:

- Conceal diagnostics through filtering, a finding-count budget, a skipped check, or swallowed failure status.
- Remove maintained source from required lint/compiler coverage or leave it without formatting ownership and verification. Scoped exceptions must retain all unaffected checks.
- Disable compiler strictness, checked-JavaScript coverage, or required declaration checking.
- Replace sound types or validation with unjustified `any`, predicates, declarations, assertion chains, or misleading generics.
- Hide the same operation through aliases, reflection, wrappers, proxies, or annotation removal while claiming the original check still protects it.
- Reclassify production code as tests, data, generated output, or diagnostic fixtures to obtain an exemption.
- Weaken test assertions or alter supported behavior without identifying and verifying the behavioral change.

Automation can verify scope and detect drift. Engineering review must assess the quality argument; a repository-editable manifest cannot prove its own justification.

## 3. Code design and behavioral contracts

### 3.1 Shared contracts and reuse

Before adding a type, schema, validator, decoder, or utility, locate the repository's existing authoritative definition and consumers. Reuse it when the semantic contract, ownership, dependency direction, and distribution requirements match. Equivalent domain concepts must not acquire competing definitions merely to satisfy local lint or type errors.

When a runtime schema owns a contract, derive its static types through the schema library's supported facilities where appropriate. When an external API or independently owned type is authoritative, use explicit adapters or checked mappings. Avoid maintaining parallel declarations that can drift without a compatibility check.

Consolidate genuinely shared knowledge at the appropriate boundary. Similar field shapes alone do not make two domain concepts identical. Preserve intentional distinctions among domain models, transport formats, persistence records, and independently versioned APIs. Reuse must respect layering and standalone distribution; a package or starter cannot depend on private helpers that are not shipped with it.

Prefer a small, cohesive shared abstraction over repeated implementations of the same contract. Keep local code local when abstraction would obscure its purpose or anticipate requirements that do not exist. A single-consumer helper can be useful when it expresses a meaningful responsibility.

### 3.2 Types, validation, and ownership

Use accurate types, `unknown` at untrusted boundaries, validation, and narrowing. Validate external data where it enters the trusted model. Preserve existing schemas and fallback behavior unless separately changing their contract. Avoid repeated guards for values already established by a trustworthy boundary.

`const value: unknown = JSON.parse(text)` is a valid boundary before validation and preserves native parse-error behavior. Use schema codecs when their contract fits. Replacing a parser with a schema decoder is a behavioral decision when error identity, messages, fallback behavior, or accepted inputs change.

Use readonly views for borrowed data when they accurately express the API. Preserve mutable state at its owner and accurate lifecycle/resource types. Readonly views do not imply frozen objects or pure methods. A focused recursive type utility must preserve the features its consumers rely on, including callable signatures, overloads, generics, private brands, and collection behavior; verify those contracts with type tests.

Direct parameter-mutation lint does not detect every mutation through aliases or methods. Review ownership explicitly. When an imposed API legitimately requires mutation, use the exception process instead of adding a lint-only alias, copy, or forwarding layer.

### 3.3 Behavioral preservation

Typing, formatting, and decomposition must preserve supported behavior. Identify intentional improvements as behavioral work and verify them separately from mechanical edits.

| Area            | Contracts to preserve or explicitly change                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Errors          | Identity, subclass, code, cause, redaction, messages, thrown versus returned failures, and operator-visible output                |
| Data            | Accepted inputs, defaults, validation location, serialization, absent versus explicit undefined, ordering, and reference identity |
| Objects         | Object versus collection APIs, property access, getters, prototypes, and consumer expectations                                    |
| Async execution | Ordering, concurrency, registration and hook timing, cancellation, retries, cleanup, and rejection ownership                      |
| Resources       | Public signatures, receiver identity, lifecycle ownership, framework-required exports, and generated bindings                     |
| Distribution    | Package entrypoints, standalone execution, template installation, emitted artifacts, and deployment contracts                     |

A stricter failure path is still a behavioral change. Validate before irreversible effects when required by the contract, and test both accepted and rejected inputs. Preserve existing unknown failures when forwarding them; adding an error wrapper can change identity, diagnostics, and redaction.

Own asynchronous work through the appropriate await, return, or real lifecycle/error handler. Preserve required sequential loops and resource limits. Ordinary synchronous callback results may be intentionally ignored when the callback contract permits it. Use explanatory comments for intentional no-ops; do not introduce meaningless state, dummy returns, or empty error handlers for lint compliance.

### 3.4 Decomposition

Extract meaningful responsibilities and interfaces. Keep control flow and assertions easy to follow. Evaluate the result, not the number of files or helpers.

Avoid numbered-stage functions, compressed statements, dummy closures, or movement into exempt profiles solely to meet a metric. Use options objects when they express a coherent API, not as a compulsory replacement for every multi-parameter signature. SDK callbacks, constructors, and public APIs retain their supported contracts. If reasonable decomposition would worsen the design, evaluate a bounded structural exception.

## 4. Source coverage and compiler requirements

### 4.1 Source profiles

All maintained handwritten JavaScript and TypeScript implementation, tests, scripts, tooling, and executable templates receive the applicable checks. Include `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, and `.cts` where used.

Classify by contents and consumers:

| Profile                                                      | Required treatment                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Production, libraries, adapters, build/admin/quality tooling | Applicable lint, compiler, and formatter checks; production structural limits                                   |
| Tests and exclusively test-used support                      | Full applicable safety checks, assertion checks, and test structural limits                                     |
| Handwritten declarations and augmentations                   | Applicable lint, real declaration checking, and relevant public-consumer checks; no implementation-size metrics |
| Static literal data                                          | Parsing, formatting, applicable typing/schema checks; no implementation-size metrics                            |
| Dedicated negative type tests                                | Compiler-verified expected errors and passing counterparts; test structural limits                              |
| Deliberately invalid diagnostic fixtures                     | Harness verifies expected diagnostics; excluded from ordinary success gates and runtime dependencies            |
| Generated or vendored output                                 | Identifiable generator/source, freshness or provenance, build and compatibility verification as applicable      |

Mixed production/test helpers are production. A data module with executable factories, calls, or orchestration is implementation. Maintained generators and template behavior retain their implementation obligations. Verify independently distributed starters and standalone tools in their actual distribution context.

Maintain a compact coverage check against the actual repository inventory and resolved compiler membership. Every maintained source must have its applicable lint, compiler, and formatter owner. Generated, vendor, and diagnostic classifications require evidence. New maintained files must enter coverage automatically or fail the coverage check.

Account for ignore files, nested configs, CLI selections, project references, generated declarations, and same-basename declarations that can shadow implementations. Production dependencies on test-only support require production reclassification; production dependencies on invalid diagnostic fixtures are prohibited. Use existing architectural and compiler facilities where available.

### 4.2 Compiler settings

Apply these options effectively to every maintained implementation project, including tests and scripts. Preserve appropriate runtime targets, module resolution, JSX mode, libraries, references, and asset handling.

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedSideEffectImports": true,
    "forceConsistentCasingInFileNames": true,
    "noCheck": false
  }
}
```

Projects containing maintained JavaScript also require:

```json
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true
  }
}
```

Each declared maintained project must actually run through the canonical compiler or framework checker. Individual strict-family options must not be disabled. `@ts-check` on selected files does not substitute for complete JavaScript coverage. Ordinary implementation must not use `@ts-ignore`, `@ts-nocheck`, or `@ts-expect-error` to conceal errors.

Handwritten declarations and augmentations must receive an actual check with `skipLibCheck: false`. An application may retain `skipLibCheck` if a focused project checks its handwritten declarations and necessary dependency closure. Do not replace that closure with permissive stubs. Declarations cannot substitute for checking the implementation they describe. Asset declarations require a real build or existence check.

Changes to public generics, overloads, exports, optional properties, or supported signatures require relevant consumer type checks. Dedicated negative type tests may use `@ts-expect-error` with a description of at least ten characters identifying the expected contract failure. The compiler must reject unused directives. When a diagnostic's identity is the assertion, use a fixture harness that checks that identity and location.

### 4.3 JavaScript and TypeScript

Checked JavaScript and TypeScript are both supported. Choose the form that produces the clearest maintainable implementation within the project's runtime and distribution constraints. Conversions must update entrypoints, package scripts, workflows, references, and deployed artifacts.

Native runtime type stripping is not typechecking and does not implement arbitrary compiler transformations. Verify the actual execution path. JS and TS receive the native checks their syntax supports; do not use language changes, JSDoc assertions, or inference gaps to evade safety checks. A custom JSDoc typechecker is not required.

## 5. Toolchain and lint requirements

### 5.1 Published tools and compatibility

Use the latest stable published releases of Oxlint, `oxlint-tsgolint`, Oxfmt, and any additional quality-tooling packages introduced by this standard. Resolve current releases when adopting or upgrading the toolchain. This standard prescribes no package version numbers or upgrade waiting period. Keep the canonical compiler/framework checker as a separate required gate.

Keep dependencies current through the repository's update workflow. Commit the updated dependency declarations and lockfile with each upgrade so local development, agents, CI, and supported editor integrations use the same resolved dependency tree. The lockfile records the current installation for reproducibility; it does not restrict how frequently dependencies may be updated. Automated and frequent upgrades are permitted.

Verify rule/options support, meaningful valid and invalid cases, project membership, and canonical compiler compatibility before activating an upgrade. If the latest release fails required checks, report the upgrade as blocked and retain the currently qualified toolchain while resolving the problem. Do not conceal failures or weaken checks merely to complete an upgrade.

When releases rename rules/options or change configuration syntax, use documented equivalents and verify that the required protection is preserved. Any relaxation still requires Section 2 evidence. Routine package upgrades and equivalent configuration updates do not require a new release of this standard.

Do not maintain a custom semantic/Rust linter fork or hand-edited installation to implement this standard. Handle demonstrated limitations through sound implementation, a qualified published upgrade, or a quality exception. Existing repository-specific rules may remain when they enforce useful compatible contracts. Verify those contracts before replacing or removing custom checks.

Classify resource handling and launcher behavior separately from semantic patches when changing tooling. Preserve independently necessary safeguards. Investigate inconsistent diagnostics or exit statuses with stable inputs and isolated runs. Crashes, empty selections, timeouts, and unexplained false passes are verification failures.

### 5.2 Base configuration and composition

Use the complete [Appendix A configuration](#appendix-a-base-oxlint-configuration). Adapt schema paths and source-profile globs without changing their meaning. Add the applicable framework mappings in Section 6. Keep local quality exceptions distinguishable from the baseline.

The active categories include rules beyond the explicit rule list. Preserve their effective coverage for the qualified version. Applicable required and retained checks run at `error`; `off` is limited to a defined setting/profile or documented quality exception. Warning severities are not an accepted debt mechanism. Retain `denyWarnings: true` and the CLI backstop.

Keep semantic lint enabled with `typeAware: true`. Keep Oxlint `typeCheck: false`; canonical compiler diagnostics come from Section 4. Maintained JavaScript must receive semantic analysis and compiler checking without a legacy exemption.

An explicit root `plugins` list replaces the default plugin set. Preserve the six base entries (`eslint`, `typescript`, `unicorn`, `oxc`, `import`, `promise`) when adding framework plugins. A complete root plugin list with applicable rule/profile overrides is a straightforward starting arrangement.

For `extends`, scoped plugin lists, nested configs, and overlapping overrides, verify actual composition. Do not infer effective coverage from array contents alone. Test inherited explicit rules, category-enabled rules, and newly enabled framework rules inside the affected scopes. Confirm framework checks do not apply to unrelated code. Selecting an explicit config path can change nested-config discovery; verify the invocation the repository actually uses.

### 5.3 Structural profiles

| Metric                                        | Production | Tests and test-only support |
| --------------------------------------------- | ---------: | --------------------------: |
| Modified cyclomatic complexity                |         10 |                          15 |
| Nesting depth                                 |          3 |                           4 |
| Parameters                                    |          4 |                           6 |
| Statements per function                       |         40 |                         Off |
| Effective lines per function, including IIFEs |         80 |                         Off |
| Effective lines per file                      |        500 |                         Off |

Effective line limits exclude blank lines and comments. Handwritten declarations and static literal data do not have implementation-size metrics. Other applicable checks remain active. Map test-only support by actual role rather than relying solely on naming conventions.

### 5.4 Deliberate baseline choices

| Setting                                                                                       | Engineering rationale and remaining protection                                                                                                                                                           |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prefer-readonly-parameter-types: off`                                                        | Accurate data/resource types take priority over universal deep-readonly classification. Useful readonly contracts, direct parameter-mutation checks, and eligible readonly private-member checks remain. |
| `strict-void-return: off`                                                                     | Ordinary synchronous callback results may be intentionally ignored. Floating Promises and async-callback misuse remain checked.                                                                          |
| `no-base-to-string` with `checkUnknown: false`                                                | Unknown diagnostic values may legitimately be rendered. Known base-object stringification and unsafe propagation remain checked.                                                                         |
| Promise rejection accepts `unknown`, but rejects `any`, known non-Errors, and empty rejection | Existing failures can retain identity and representation. Newly created failures still require sound error contracts.                                                                                    |
| `no-await-in-loop: off`                                                                       | Sequencing can be required for pagination, rate limits, and resource lifetimes.                                                                                                                          |
| `no-control-regex: off`                                                                       | Control-character validation is legitimate. Use legible escapes and relevant tests.                                                                                                                      |
| Test statement/function/file-size limits off                                                  | Explicit test scenarios and assertions may be clearer than fragmentation. Branching, depth, and parameter limits remain.                                                                                 |

Other explicit exclusions in Appendix A are also part of the baseline. Additional protections require an actual project benefit and must meet the same quality standard. Native lint and readonly types supply specific guarantees; neither review nor a lint pass establishes universal runtime immutability or type soundness.

## 6. Frameworks and test runners

Enable native framework plugins in their applicable scope and retain base protections. Preserve runtime globals, JSX settings, framework compiler checks, and compatible architecture/accessibility checks. Qualify the real file conventions, imports, and helper names; a recognized plugin is not proof that it recognizes every test or component.

### 6.1 React and DOM accessibility

For React code, add `react` and these explicit rules while retaining category coverage:

```json
{
  "react/rules-of-hooks": "error",
  "react/exhaustive-deps": "error",
  "react/jsx-key": "error",
  "react/jsx-no-duplicate-props": "error",
  "react/jsx-no-undef": "error"
}
```

For JSX representing DOM interfaces, add `jsx-a11y`, retain category coverage, and explicitly enable:

```json
{
  "jsx-a11y/no-noninteractive-element-interactions": "error",
  "jsx-a11y/no-noninteractive-tabindex": "error",
  "jsx-a11y/prefer-tag-over-role": "error"
}
```

Use native elements where they meet the contract. Changes to interactive controls require appropriate keyboard, focus, accessible-name/role, and behavior verification. Native lint is not a complete usability assessment. A demonstrated widget false positive can qualify for a bounded exception; it does not justify disabling unrelated accessibility checks. Non-DOM renderers require their applicable accessibility treatment.

### 6.2 Vitest

Add `vitest` for its test scope and these rules:

```json
{
  "vitest/no-focused-tests": "error",
  "vitest/valid-expect": [
    "error",
    {
      "minArgs": 1,
      "maxArgs": 2
    }
  ],
  "vitest/expect-expect": [
    "error",
    {
      "assertFunctionNames": ["expect", "expectTypeOf", "assert", "assertType"]
    }
  ],
  "vitest/no-conditional-expect": "error"
}
```

### 6.3 Jest

Add `jest` for its test scope and these rules:

```json
{
  "jest/no-focused-tests": "error",
  "jest/valid-expect": "error",
  "jest/valid-expect-in-promise": "error",
  "jest/expect-expect": [
    "error",
    {
      "assertFunctionNames": ["expect"]
    }
  ],
  "jest/no-conditional-expect": "error"
}
```

Use exact assertion-helper identities with evidence that they assert. Broad wildcard recognition must not make assertion-free tests pass. Preserve assertions, meaningful failure checks, snapshots, and test selection. Broader matching or partial assertions are behavioral changes when they weaken the contract.

For other runners, preserve appropriate existing checks and verify a real failed assertion reaches acceptance. State the capabilities of the configured checks accurately; a generic replacement test analyzer is not required.

### 6.4 Node test registrations

Preserve Node's registration and subtest execution model. Awaiting a registration can alter module evaluation and hook timing. Do not mass-convert registrations into awaited calls, async suites, or Promise collections solely to clear lint. Work created inside a test must still be owned, and context subtests require the appropriate await/return.

A safe-call allowance requires a quality exception. Restrict it to genuine test registrations and the actual `node:test` declaration origin. Retain all other floating-Promise options, including `ignoreVoid: false`. Safe Promise-type allowances require their own evidence.

Example entry for `allowForKnownSafeCalls`, using distinct local import names:

```json
{
  "from": "package",
  "package": "node:test",
  "name": ["nodeTest", "nodeIt", "nodeSuite", "nodeDescribe", "skip", "todo", "only"]
}
```

Use only forms the repository needs, such as `import { test as nodeTest } from "node:test"`. Declaration-name matching can also allow context subtests, so qualify the installed declarations, import forms, shorthands, and effective configuration before enabling an entry. All six controls are required:

1. Intended unawaited top-level and suite-body registrations pass for each form used.
2. An unawaited context subtest such as `t.test()` fails.
3. An unawaited same-named local Promise-returning function fails.
4. An unawaited same-named function imported from another module fails.
5. A floating Promise inside a test body fails.
6. An unawaited unrelated Promise-returning call fails.

Require the intended `no-floating-promises` diagnostic in failing controls. A mapping that permits the context-subtest control is too broad. When native identity matching cannot preserve these boundaries, use justified operation-bound directives rather than a broad test-wide disable or a scheduling change.

Declaration matching does not establish runtime calling context. An imported registration invoked inside a running test can create a subtest while matching a safe-call allowance. Use context methods there and document this detection limit. Advanced alias/shadow behavior must be qualified where relevant, not assumed safe.

## 7. Formatting and generated artifacts

### 7.1 Formatter ownership

Oxfmt owns supported maintained files. Preserve intentional established repository conventions. Otherwise use:

```json
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "printWidth": 100,
  "tabWidth": 2,
  "useTabs": false,
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "endOfLine": "lf",
  "insertFinalNewline": true,
  "sortImports": false,
  "sortPackageJson": false,
  "sortTailwindcss": false,
  "jsdoc": false
}
```

Keep sorting and transformations disabled unless the project deliberately owns and verifies them. Import reordering can affect side effects. Assign each file an appropriate formatter and avoid overlapping ownership. Unsupported formats retain their established formatter.

Generated, vendored, and byte-sensitive fixtures may have an explicit generator or other formatting owner. Handwritten source remains covered. A local formatting exception requires a real meaning, byte-contract, or readability justification under Section 2. Identify the exact option, region, or file and its formatting owner or byte-contract verification. Retain all unaffected lint, compiler, and formatter coverage.

Format the repository's adopted copy of this standard before recording an optional digest. A digest identifies bytes, not effective enforcement. Verify formatter idempotence and the normal lint-fix/format sequence at adoption and relevant upgrades.

### 7.2 Generated freshness

Use each generator's supported non-writing freshness check. Otherwise generate in an isolated temporary location and compare without overwriting unrelated work. Include freshness in actual acceptance and verify that a relevant input change is detected.

Use the actual configuration, flags, compatibility settings, and runtime inputs. For Workers projects, use the installed Wrangler's supported `types --check` path where available. A successful generation run alone does not establish that committed output is current. Credential or network requirements depend on the actual generation mode and must be qualified.

## 8. Verification and enforcement integrity

### 8.1 Focused integrity checks

Use supported native facilities and small repository checks. The controlled requirements are the baseline, defined profiles, compiler minimums, and recorded quality exceptions. A machine-readable representation may support verification without becoming an independent source of authority.

Integrity checks must detect:

- Unrecorded rule/category disablement, option relaxation, threshold increases, broader allowances, or warning severity, including category-enabled rules absent from the explicit list.
- Loss of semantic analysis, strict compiler settings, JavaScript/declaration/project coverage, or maintained formatting coverage.
- Unauthorized or stale directives, unexplained changes to source classifications, and violations of declared production/test/generated/data boundaries.
- Missing required gates, reduced command scope, and swallowed failure status.
- Exception use beyond its recorded rule, origin, operation, or profile.

Directive verification must distinguish actual comments from strings, documentation examples, and classified diagnostic fixtures. Native unused-disable detection is required but cannot establish authorization for a used directive. Use existing parsers and compiler membership facilities where possible. Review source classifications against actual behavior and consumers; automation verifies declared mappings and observable boundary violations, while engineering review establishes semantic role.

When a stable resolved-config API is unavailable, constrain composition and combine straightforward validation with native probes of the real invocation. Preserve useful existing checks. The standard requires neither a replacement typechecker nor a generic configuration, workflow, or dependency-analysis platform. The verification mechanism must remain proportionate to the repository.

### 8.2 Qualification controls

Each control must exercise the intended protection with a valid counterpart. Assert the relevant diagnostic identity, file/location, and exit status. When a native finding has no code, assert its specific message and location. Parsing failures, missing dependencies, unrelated diagnostics, and empty selections do not demonstrate the intended enforcement.

| Protection                     | Required evidence at adoption                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Base and composition           | Valid source passes; explicit, category-only, and applicable framework violations fail in their actual composed scopes.                       |
| Semantic and compiler coverage | Type-dependent violations and compiler errors fail in every relevant TS/checked-JS project context.                                           |
| Declarations and public types  | Handwritten declaration errors fail their actual gate; changed public contracts retain valid consumers and reject invalid ones.               |
| Type safety                    | Representative unsafe propagation/assertions fail; valid narrowing and boundary handling pass.                                                |
| Async safety                   | Floating work, async-callback misuse, and known invalid rejections fail; owned work and legitimate unknown-failure forwarding pass.           |
| Structural profiles            | Each of the six production metrics has a boundary control. A long test passes; excessive test complexity, depth, and parameters fail.         |
| Framework behavior             | Configured assertion/accessibility rules catch meaningful violations; valid cases pass; a real failed assertion fails the test command.       |
| Node registration allowance    | All six controls in Section 6.4 pass with the actual installed declarations and imports.                                                      |
| Exceptions and directives      | Accepted cases pass; wrong-origin, wrong-site, copied, unused, and unauthorized cases fail as applicable; literal examples remain unaffected. |
| Formatting and freshness       | Misformatted maintained source and stale generated output fail their real gates; repeated formatting is stable.                               |
| Integrity and coverage         | A representative policy downgrade and omitted maintained source fail their verification.                                                      |
| Acceptance wiring              | Lint, semantic, compiler, formatter, test, and policy failures independently produce a failing aggregate result.                              |

Use isolated disposable mutations for acceptance-wiring checks and restore them before final verification. Reuse meaningful existing tests. Generate oversized structural fixtures temporarily instead of maintaining large synthetic source files. Keep regression tests for nontrivial enforcement behavior and exception boundaries in normal acceptance; disposable acceptance-wiring mutations may be removed after qualification.

Enforcement and toolchain changes require the affected qualification and integration controls. Ordinary source changes require existing gates, relevant behavioral tests, and review; they do not require recreating every disposable policy fault. Expand verification to resolve a concrete risk, not merely to increase test counts.

### 8.3 Evidence quality

Record the exact revision, tool versions, commands, exit statuses, and selection scope. Compare disputed behavior under matched baselines, runtimes, and environments. A matched failure supports a limited conclusion about the observed case, not universal equivalence. Investigate flakes rather than rerunning until a single pass replaces the evidence.

Report checks as passed, failed, blocked, or unrun. Selected suites are not full suites. A script appearing in configuration does not prove it ran. Local verification does not prove hosted CI ran.

## 9. Adoption and change review

### 9.1 Establish the starting state

Record the starting revision and unrelated uncommitted changes. Inventory runtimes, package managers, compiler projects, test runners, generators, standalone scripts, templates, existing quality checks, and CI commands. Establish current failures before attributing them to the migration.

Read applicable repository instructions and reconcile conflicting quality settings explicitly. Classify existing overrides and suppressions as defined profiles, currently justified quality exceptions, or unexplained relaxations requiring repair. Neither silent grandfathering nor blanket removal is acceptable.

### 9.2 Implement in reviewable units

Qualify tools and representative configurations before bulk editing. Group recurring findings by underlying contract. Test a transformation on meaningful examples and inspect its broader consequences before applying it widely.

Use coherent source and enforcement changes. Large migrations may separate toolchain/formatting, source repairs, behavioral improvements, and final enforcement into preparatory PRs. Small projects can use a simpler sequence. Preserve useful types, validation, and abstractions; remove machinery only after establishing that it has no required responsibility.

Review behavioral changes separately from formatting and typing. Explain repeated cross-cutting decisions once, identify affected boundaries, and verify their consequences. A useful improvement must not be presented as behavior-neutral merely because lint prompted it.

An existing migration baseline may remain temporarily under the project's current gates while source work is unfinished. Do not introduce a new baseline or increase counts to absorb regressions. Report current-gate and target-standard status separately. Final adoption removes finding budgets, baseline filtering, and incomplete-source exemptions.

Phased enforcement is permitted. Fully migrated packages or directories may gain required strict checks in preparatory PRs as soon as the checks pass for their complete declared scope. Preserve existing checks for the rest of the repository and keep already migrated scope under strict enforcement; later relaxations of its rules or allowances still require Section 2 evidence. Record the enforced scope and remaining migration work explicitly. Introduce repository-wide strict enforcement once all required source is ready. Repository-wide adoption remains incomplete until Section 10.2 is satisfied.

### 9.3 Integrate and verify

Verify the exact combined tree after integrating parallel work. Branch-local successes do not establish integrated acceptance. Dirty-tree evidence requires a reproducible patch or tree snapshot and base. If the base changes, reverify or identify the older revision to which the evidence applies.

Review exception evidence and effective-policy changes explicitly. Preserve required human reviews and branch protection. Normal repository authorization governs commits, pushes, merges, and deployments.

## 10. Acceptance and maintenance

### 10.1 Required commands and CI

The following command names are examples. Preserve established repository names and the package manager where appropriate:

```json
{
  "scripts": {
    "lint": "oxlint --deny-warnings .",
    "lint:agent": "oxlint --deny-warnings --format=agent .",
    "lint:fix": "oxlint --fix .",
    "format": "oxfmt --write .",
    "format:check": "oxfmt --check ."
  }
}
```

The canonical acceptance workflow must require:

- Formatting checks and full native lint under the effective policy.
- Every applicable compiler/framework and declaration project.
- Policy, coverage, generated-freshness, and relevant build/contract checks.
- The actual tests required by the repository and affected behavior.

Run independent checks so one failure does not hide the rest. Execute each compiler project and aggregate failures, or use independent required CI jobs. Run tests when an independent compiler check fails. Respect real build dependencies and report dependent checks as blocked when their prerequisites cannot be produced.

The aggregate result must fail if any required gate fails. Verify shell pipelines, wrappers, job conditions, and status propagation. Writing/fixing commands are conveniences; acceptance uses check commands. Diagnostic filtering, forced success, skipped required jobs, and `continue-on-error` cannot establish completion.

### 10.2 Completion criteria

Adoption is complete when:

1. Every maintained source has its required coverage and actual project membership.
2. Effective settings match the baseline, defined profiles, and justified recorded exceptions.
3. Migration finding budgets, diagnostic filtering, and incomplete-source exemptions are removed.
4. Required checks pass on the exact integrated revision.
5. Intentional behavioral changes and quality exceptions have evidence and the required review.
6. Required hosted CI has passed at the relevant revision.

For a repository without hosted CI, record that fact and its actual acceptance process. Where hosted CI is required but has not run, report local verification complete and hosted acceptance pending.

The final implementation report must identify the base/head or dirty-tree snapshot; committed, pushed, and local state; mechanical, type/design, behavior, and enforcement changes; exception records and lost/retained detection; exact command results and scopes; and remaining work or known tool limits. Avoid double-counting overlapping findings. State plainly whether adoption is complete, locally verified only, or incomplete.

### 10.3 Ongoing maintenance

Keep the adopted version, coverage mappings, toolchain, and exception records current. Requalify affected protections after enforcement or dependency changes. Reassess repeated exceptions for a more coherent shared design or a systematically inappropriate rule; neither their count nor a preference for zero exceptions decides the result.

Repository agent instructions should point to this file, identify the normal acceptance command, and reinforce its evidence-based exception requirement. Keep those pointers short so the standard has one authoritative statement of its requirements.

## Appendix A: Base Oxlint configuration

This is the normative starting `.oxlintrc.json`. Adapt paths and profile mappings as described in Sections 4 and 5. Framework additions follow Section 6. Every further weakening of an applicable requirement follows Section 2.

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["eslint", "typescript", "unicorn", "oxc", "import", "promise"],
  "categories": {
    "correctness": "error",
    "suspicious": "error",
    "perf": "error",
    "pedantic": "off",
    "style": "off",
    "restriction": "off",
    "nursery": "off"
  },
  "options": {
    "typeAware": true,
    "typeCheck": false,
    "denyWarnings": true,
    "reportUnusedDisableDirectives": "error",
    "respectEslintDisableDirectives": false
  },
  "rules": {
    "typescript/no-explicit-any": [
      "error",
      {
        "fixToUnknown": false,
        "ignoreRestArgs": false
      }
    ],
    "typescript/no-non-null-assertion": "error",
    "typescript/no-unsafe-type-assertion": "error",
    "typescript/no-unnecessary-type-assertion": [
      "error",
      {
        "checkLiteralConstAssertions": true
      }
    ],
    "typescript/consistent-type-assertions": [
      "error",
      {
        "assertionStyle": "as",
        "objectLiteralTypeAssertions": "never",
        "arrayLiteralTypeAssertions": "never"
      }
    ],
    "typescript/no-unsafe-argument": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/no-unsafe-call": "error",
    "typescript/no-unsafe-member-access": "error",
    "typescript/no-unsafe-return": "error",
    "typescript/no-empty-object-type": "error",
    "typescript/no-unsafe-function-type": "error",
    "typescript/no-wrapper-object-types": "error",
    "typescript/no-invalid-void-type": [
      "error",
      {
        "allowAsThisParameter": true,
        "allowInGenericTypeArguments": true
      }
    ],
    "typescript/no-unnecessary-type-parameters": "error",
    "typescript/no-deprecated": "error",
    "typescript/no-duplicate-type-constituents": "error",
    "typescript/no-redundant-type-constituents": "error",
    "typescript/unbound-method": "error",
    "typescript/no-misused-spread": "error",
    "typescript/no-for-in-array": "error",
    "typescript/require-array-sort-compare": "error",
    "typescript/ban-ts-comment": [
      "error",
      {
        "ts-check": false,
        "ts-expect-error": true,
        "ts-ignore": true,
        "ts-nocheck": true
      }
    ],
    "typescript/strict-boolean-expressions": [
      "error",
      {
        "allowAny": false,
        "allowNullableBoolean": false,
        "allowNullableEnum": false,
        "allowNullableNumber": false,
        "allowNullableObject": true,
        "allowNullableString": false,
        "allowNumber": false,
        "allowString": false
      }
    ],
    "typescript/no-unnecessary-condition": [
      "error",
      {
        "checkTypePredicates": false,
        "allowConstantLoopConditions": "only-allowed-literals"
      }
    ],
    "typescript/switch-exhaustiveness-check": [
      "error",
      {
        "considerDefaultExhaustiveForUnions": false
      }
    ],
    "eqeqeq": ["error", "always"],
    "no-implicit-coercion": "error",
    "typescript/restrict-plus-operands": [
      "error",
      {
        "allowAny": false,
        "allowBoolean": false,
        "allowNullish": false,
        "allowNumberAndString": false,
        "allowRegExp": false,
        "skipCompoundAssignments": false
      }
    ],
    "typescript/restrict-template-expressions": [
      "error",
      {
        "allowAny": false,
        "allowArray": false,
        "allowBoolean": true,
        "allowNever": false,
        "allowNullish": false,
        "allowNumber": true,
        "allowRegExp": false
      }
    ],
    "typescript/no-base-to-string": [
      "error",
      {
        "checkUnknown": false
      }
    ],
    "typescript/no-floating-promises": [
      "error",
      {
        "checkThenables": true,
        "ignoreIIFE": false,
        "ignoreVoid": false,
        "allowForKnownSafeCalls": [],
        "allowForKnownSafePromises": []
      }
    ],
    "typescript/no-misused-promises": "error",
    "typescript/await-thenable": "error",
    "typescript/return-await": ["error", "error-handling-correctness-only"],
    "typescript/strict-void-return": "off",
    "typescript/no-confusing-void-expression": [
      "error",
      {
        "ignoreArrowShorthand": true,
        "ignoreVoidOperator": false,
        "ignoreVoidReturningFunctions": false
      }
    ],
    "typescript/no-meaningless-void-operator": "error",
    "promise/always-return": [
      "error",
      {
        "ignoreLastCallback": true,
        "ignoreAssignmentVariable": []
      }
    ],
    "promise/catch-or-return": "error",
    "no-async-promise-executor": "error",
    "no-promise-executor-return": "error",
    "typescript/only-throw-error": [
      "error",
      {
        "allowThrowingAny": false,
        "allowThrowingUnknown": false,
        "allowRethrowing": true
      }
    ],
    "typescript/use-unknown-in-catch-callback-variable": "error",
    "typescript/prefer-promise-reject-errors": [
      "error",
      {
        "allowEmptyReject": false,
        "allowThrowingAny": false,
        "allowThrowingUnknown": true
      }
    ],
    "no-useless-catch": "error",
    "no-param-reassign": [
      "error",
      {
        "props": true,
        "ignorePropertyModificationsFor": [],
        "ignorePropertyModificationsForRegex": []
      }
    ],
    "typescript/prefer-readonly": "error",
    "typescript/explicit-module-boundary-types": "error",
    "typescript/method-signature-style": ["error", "property"],
    "typescript/consistent-type-imports": [
      "error",
      {
        "prefer": "type-imports",
        "fixStyle": "inline-type-imports",
        "disallowTypeAnnotations": true
      }
    ],
    "typescript/consistent-type-exports": "error",
    "typescript/no-import-type-side-effects": "error",
    "import/no-cycle": [
      "error",
      {
        "ignoreTypes": false,
        "ignoreExternal": false,
        "allowUnsafeDynamicCyclicDependency": false
      }
    ],
    "import/no-self-import": "error",
    "import/no-duplicates": [
      "error",
      {
        "preferInline": true
      }
    ],
    "import/no-mutable-exports": "error",
    "complexity": [
      "error",
      {
        "max": 10,
        "variant": "modified"
      }
    ],
    "max-depth": [
      "error",
      {
        "max": 3
      }
    ],
    "max-params": [
      "error",
      {
        "max": 4
      }
    ],
    "max-statements": [
      "error",
      {
        "max": 40
      }
    ],
    "max-lines-per-function": [
      "error",
      {
        "max": 80,
        "skipBlankLines": true,
        "skipComments": true,
        "IIFEs": true
      }
    ],
    "max-lines": [
      "error",
      {
        "max": 500,
        "skipBlankLines": true,
        "skipComments": true
      }
    ],
    "curly": ["error", "all"],
    "no-var": "error",
    "prefer-const": "error",
    "no-nested-ternary": "error",
    "no-return-assign": ["error", "always"],
    "no-sequences": "error",
    "no-multi-assign": "error",
    "no-else-return": "error",
    "no-eval": "error",
    "no-implied-eval": "error",
    "no-new-func": "error",
    "no-with": "error",
    "no-debugger": "error",
    "no-control-regex": "off",
    "no-empty": [
      "error",
      {
        "allowEmptyCatch": false
      }
    ],
    "no-empty-function": "error",
    "unicorn/no-useless-undefined": [
      "error",
      {
        "checkArguments": true,
        "checkArrowFunctionBody": true
      }
    ],
    "unicorn/no-abusive-eslint-disable": "error",
    "typescript/prefer-readonly-parameter-types": "off",
    "no-await-in-loop": "off",
    "require-await": "off",
    "typescript/require-await": "off",
    "typescript/consistent-return": "off",
    "no-underscore-dangle": "off",
    "unicorn/consistent-function-scoping": "off",
    "unicorn/no-array-sort": "off",
    "unicorn/no-array-reverse": "off"
  },
  "overrides": [
    {
      "files": [
        "**/*.test.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
        "**/*.spec.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
        "**/__tests__/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}"
      ],
      "rules": {
        "complexity": [
          "error",
          {
            "max": 15,
            "variant": "modified"
          }
        ],
        "max-depth": [
          "error",
          {
            "max": 4
          }
        ],
        "max-params": [
          "error",
          {
            "max": 6
          }
        ],
        "max-statements": "off",
        "max-lines-per-function": "off",
        "max-lines": "off"
      }
    },
    {
      "files": ["**/*.d.ts", "**/*.d.mts", "**/*.d.cts"],
      "rules": {
        "complexity": "off",
        "max-depth": "off",
        "max-params": "off",
        "max-statements": "off",
        "max-lines-per-function": "off",
        "max-lines": "off"
      }
    },
    {
      "files": ["**/*.test-d.{ts,mts,cts}"],
      "rules": {
        "typescript/ban-ts-comment": [
          "error",
          {
            "ts-check": false,
            "ts-expect-error": "allow-with-description",
            "ts-ignore": true,
            "ts-nocheck": true,
            "minimumDescriptionLength": 10
          }
        ],
        "complexity": [
          "error",
          {
            "max": 15,
            "variant": "modified"
          }
        ],
        "max-depth": [
          "error",
          {
            "max": 4
          }
        ],
        "max-params": [
          "error",
          {
            "max": 6
          }
        ],
        "max-statements": "off",
        "max-lines-per-function": "off",
        "max-lines": "off"
      }
    }
  ]
}
```

## Appendix B: Repository records

Maintain these records in the repository's adopted copy. Supporting tests and review artifacts may live in their normal locations, but the record must explain the decision without relying on an external conversation.

### Adoption record

Record the repository and adopted version; supported runtimes and package manager; installed tool versions; config and acceptance paths; compiler projects and source profiles; formatter and generator ownership; migration status; and the exact integrated verification revision and result.

### Quality-exception record

Use stable identifiers such as `QX-001`. One rationale may cover a bounded repeated case. Record actual evidence rather than repeating the eligibility criteria as assertions.

```text
ID and title:
Rule, option, or threshold; installed tool versions:
Scope: files, authorized operations, origins, or bounded pattern:
Directive selectors/inventory and optional duplication bounds:
Diagnostic and required contract:
Actual compliant alternative and demonstrated quality cost:
Chosen adjustment and why its scope is appropriate:
Structural comparison or unsafe-type evidence, where applicable:
Verification commands, relevant tests, and results:
Retained protection, lost detection, and established assumptions:
Review and revisit trigger:
```

### Posthorse adoption

Repository: `fitchmultz/pi-posthorse`. Adopted version: 5.1.2. Adoption starts from
`a25d5d5`. Node 24 and the npm version declared in `package.json` own acceptance.
The extension retains its Node >=24.12.0 and Pi >=1.3.0 support floors. The locked
Pi 1.3.0 cohort exercises that floor; separate CI lanes qualify the latest stable
official release and latest maintained fork commit with their actual SDK graphs.

The qualified published tools are Oxlint 1.90.0, oxlint-tsgolint 7.0.2005,
Oxfmt 0.75.0, oxc-parser 0.156.0, and TypeScript 7.0.2. `package-lock.json`
records their full installation. There is no custom semantic engine.

`.oxlintrc.json` implements Appendix A with the Node plugin and the test-only
`test/*.ts` support mapping. The Node registration adjustment is QX-001.
All other code retains the production profile. Source inventory includes
handwritten files even when Git ignores them. Compiler-resolved production
imports cannot depend on test-only support. Diagnostic programs exist only in
disposable probe projects.

`tsconfig.json` is the canonical implementation project. It checks the extension,
UI, tests, the remaining JavaScript host entry point, and TypeScript scripts.
Effective membership and every Section 4.2 setting are checked through the
installed native compiler API. A new source enters coverage or fails policy.
There are no handwritten declarations. The application's dependency
`skipLibCheck: true` does not authorize skipping a new handwritten declaration;
policy requires an actual `skipLibCheck: false` compiler owner.

Oxfmt retains established tabs with width four, and two spaces for Markdown and
YAML. Other Section 7.1 options remain unchanged. npm owns `package-lock.json`.
The existing illustration assets retain their byte ownership. No executable
generated source or new generator is introduced.

`npm run verify` first verifies the invoking npm, then runs policy, configuration
coherence, native lint, formatting, the compiler, all tests, and package packing.
Independent failures do not suppress later gates. The normal lint variants also
aggregate policy, configuration, and native lint independently. Closed root
configuration composition is intentional: a nested config, ignore change, new
project, or command change requires an explicit mapping update and qualification,
rather than a second implementation of native configuration merging.

Exact integrated revisions and results are recorded by the required CI runs,
their candidate-source check, and the release-control `source.txt` receipt.
[Quality acceptance](quality.md) identifies the commands and evidence artifacts.
Adoption requires the current candidate's checks and independent reviews,
including both latest-host lanes, before merge. A local pass is not hosted
acceptance.

### QX-001: Declaration-qualified Node registrations

Rule: `typescript/no-floating-promises`, Oxlint 1.90.0 with tsgolint 7.0.2005.
Scope: genuine test registrations through
`import { test as nodeTest } from "node:test"` in the defined test profile.
The only safe-call entry is package `node:test`, name `nodeTest`.
All other floating-Promise options, including `ignoreVoid: false`, stay at baseline.

The finding is an unowned registration Promise. Node owns registration completion;
awaiting each existing registration changes module evaluation and hook timing.
Replacing every registration with `await nodeTest(...)` is therefore not a
behavior-neutral alternative. The alias keeps the registration declaration
distinct from `TestContext.test` without changing execution.

`test/quality-allowances.test.ts` exercises top-level and suite-body registrations,
an unawaited context subtest, local and foreign same-named functions, floating
work in a body, and an unrelated async call. It requires the intended native
diagnostic in every rejected case, and rejects a wrong-package qualifier.
Run `npm run quality:probes`.

Detection lost: calling the imported registration inside a running test can
create a subtest while matching its declaration. Running-test code uses context
methods and owns their Promises. Revisit when Node declarations, aliases, or
the native matcher change. This decision and its controls receive the adoption PR review.

### QX-002: Five positional SDK tool arguments

Rule: `max-params`, production maximum four, Oxlint 1.90.0.
Scope: the four `execute` methods in `registerContextTools` for
`new_context` and `get_context_remaining`, `registerNotes` for `notes`,
and `registerHistory` for `history`. `scripts/quality-sites.ts` is the
file/rule/operation inventory, with one directive per selector.

Pi's `ToolDefinition.execute` requires five positional arguments, ending in the
tool context. The qualified floor declaration is
`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:514`.
The direct signature keeps the framework contract visible:

```ts
async execute(id, params, signal, onUpdate, ctx) {
  // The tool uses its native context and applicable arguments.
}
```

A compliant metric-only alternative collects the same contract into a rest array:

```ts
async execute(...args) {
  const [id, params, signal, onUpdate, ctx] = args;
  // The tool still depends on five positions.
}
```

That changes the displayed arity from five to one without simplifying the API,
adds a forwarding declaration, and obscures native contextual parameters.
Dropping the fifth position loses the context. The adjustment is an
operation-bound native directive, not a higher application-wide threshold.
The selected methods remain five-parameter methods; ordinary production
functions retain four.

The policy resolves the actual `ExtensionAPI.registerTool` declaration and
the named registration. The QX-002 test accepts the SDK operation and rejects
a structural same-signature local receiver, another file, another operation,
a replacement rule with unchanged count, and a duplicated operation.
Native unused-disable detection remains active. Run `npm run quality:probes`
and `npm run lint`. Revisit when the SDK signature or these registrations change.

### QX-003: Faux provider's request-owned options

Rule: `no-param-reassign` with property checks, Oxlint 1.90.0.
Scope: the two `opts.cacheRetention = "none"` assignments in the native and
official `fixture` response factories. The inventory includes the enclosing
function, assignment, map, and anonymous callback parameter boundaries.

The faux provider awaits the response factory and then estimates usage from
the same options object. See the qualified Pi AI 1.3.0
`dist/providers/faux.js:349-352` and cache accounting at `:133-153`.
The fixture disables faux's synthetic cache double count so capacity tests
exercise actual request admission.

The direct operation is `opts.cacheRetention = "none"`. Passing
`{ ...opts, cacheRetention: "none" }` to the next factory would leave the
provider's original options unchanged. Post-processing response usage would
replace the provider's accounting in the assertion. Neither preserves the
fixture's contract. The two request-owned mutations therefore use next-line
directives instead of parameter-name or file-wide waivers.

Ordinary property mutation and inferred callback inputs remain checked by
`test/quality-rule-cases.ts` and `test/quality-rules.test.ts`. The real host
suites exercise the resulting capacity and rollover boundaries. Native unused
directives and exact operation authorization remain required.
Run `npm run quality:probes` and `npm run test:native`.
Revisit if faux exposes a supported earlier cache-setting hook or changes option ownership.

### QX-005: Required absent signal argument

Rule: `unicorn/no-useless-undefined`, Oxlint 1.90.0.
Scope: `loadedHistory.call` in `test/native-host.ts`, specifically
`runner.createToolContext("history-regression", undefined)`.

The declaration at coding-agent `dist/core/extensions/runner.d.ts:177`
requires a second argument of `AbortSignal | undefined`; it is not optional.
This fixture models a direct history call without a caller cancellation signal.
Omitting the slot fails the compiler's required-argument contract. Supplying a
new controller instead introduces a signal and changes the absence case that
the fixture exercises. Reflection or a forwarding alias would only conceal
the same operation.

One next-line directive preserves that explicit native argument. Ordinary
undefined arguments and arrow results keep baseline checking; unused broad
fixture overrides are absent. The real native history tests exercise this call,
and native unused-disable detection proves the directive still has a finding.
Run `npm run lint`, `npm run check`, and `npm run test:native`.
Revisit when the native signal argument becomes optional or the fixture gains
a real cancellation owner.

### QX-010: Computed native module bindings

Rule: `typescript/no-unsafe-assignment`, Oxlint 1.90.0 with tsgolint 7.0.2005.
Scope: the two top-level destructuring bindings in `test/native-host.ts`.
The inventory fixes the imported members, `typeof NativeSdk` or
`typeof NativeAi` annotation, and complete computed import initializer.

TypeScript represents a computed import as `any`. These values come from the
selected installed Pi SDK and its own provider package, not session or model
data. `test/pi-loader.ts` checks the real SDK path, expected package directory,
and version before the canonical suite. The compiler uses that installed graph.
The companion resolves relative to the selected SDK manifest, including nested
dependency layouts. Each binding has the actual module's static type, and the
real host tests use its constructors and provider behavior.

A static import is the straightforward compliant alternative, but removes the
existing explicit alternate-host diagnostic and its companion-graph selection.
Checking only that each export is a function does not prove constructor
identity or the SDK's complete generic contract. A type assertion makes the
same assumption less visible. The two bounded assignment directives preserve
the graph-selected bindings without allowing unsafe propagation elsewhere.

The canonical invalid control is a mismatched `PI_HOST_INDEX`: the loader
rejects it before tests instead of borrowing another host's declarations.
Direct alternate-host diagnostics without the canonical loader remain
unqualified diagnostics, not acceptance evidence. Remaining assumptions are
the installed package's public exports and the loader's identity checks.
Run `npm run check:compat` and both exact-host qualification lanes.
Revisit if native import typing or host-selection APIs remove this computed boundary.

### QX-011: Published import-cycle detection limits

Protection: `import/no-cycle`, Oxlint 1.90.0. The baseline settings remain
`ignoreTypes: false`, `ignoreExternal: false`, and
`allowUnsafeDynamicCyclicDependency: false`. There is no rule disable,
source exclusion, or custom engine.

The installed published importer reports the static and type-only cycle controls.
The existing probes for a cycle through an external package and an awaited dynamic
import emit no cycle diagnostic. The native configuration options alone are not
evidence of those missing protections. The published
[`no_cycle.rs:268-274`](https://github.com/oxc-project/oxc/blob/oxlint_v1.90.0/crates/oxc_linter/src/rules/import/no_cycle.rs#L268-L274)
stops traversal at `node_modules` despite the `ignoreExternal: false` setting.
`test/quality-rules.test.ts` records both exact limitations alongside retained controls.

The comparison is the published tool against the prior repository-specific
semantic patch, which also inspected dynamic and wrapped import expressions.
Keeping that patch conflicts with Section 5.1. Adding another dependency
analyzer solely to replicate those synthetic cases would duplicate graph and
resolver ownership; no cyclic production dependency has been demonstrated.
The selected adjustment is the published native implementation, with the
lost external and dynamic/wrapped-cycle detection disclosed rather than claimed.

Static, type-only, self-import, and duplicate-import checks remain,
as do the compiler, exact source coverage, and code review. External and dynamic
module boundaries require review; this record does not establish their cycle safety. Run `npm run quality:probes`.
A published importer change, a new runtime import boundary, or an actual cycle
report requires requalification and reconsideration in the normal PR review.

## References

The following primary references describe tool behavior. This standard defines the implementation requirements and exception authority.

- [Oxlint configuration](https://oxc.rs/docs/guide/usage/linter/config), [configuration reference](https://oxc.rs/docs/guide/usage/linter/config-file-reference.html), and [type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware).
- [Oxlint ignore comments](https://oxc.rs/docs/guide/usage/linter/ignore-comments.html).
- [Floating-Promise checks](https://oxc.rs/docs/guide/usage/linter/rules/typescript/no-floating-promises), [readonly parameter types](https://oxc.rs/docs/guide/usage/linter/rules/typescript/prefer-readonly-parameter-types), and [strict void returns](https://oxc.rs/docs/guide/usage/linter/rules/typescript/strict-void-return).
- [Promise rejection options](https://oxc.rs/docs/guide/usage/linter/rules/typescript/prefer-promise-reject-errors).
- [Node test runner](https://nodejs.org/api/test.html).
- [Oxfmt configuration](https://oxc.rs/docs/guide/usage/formatter/config-file-reference.html), [CLI](https://oxc.rs/docs/guide/usage/formatter/cli.html), and [language support](https://oxc.rs/docs/guide/usage/formatter/language-support).
