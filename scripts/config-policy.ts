import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { objectValue, readObject } from "./quality-policy.ts";

type Configuration = Readonly<Record<string, unknown>>;
const CI = ".github/workflows/ci.yml";
const RELEASE = ".github/workflows/npm-release.yml";
const VERSION = ".github/workflows/npm-version.yml";
const SHARED_WORKFLOWS = "fitchmultz/.github/.github/workflows/";

function field(value: unknown, ...keys: readonly string[]): unknown {
	return keys.reduce<unknown>(
		(parent, key) => (objectValue(parent) ? parent[key] : undefined),
		value,
	);
}
function workflow(root: string, file: string): Configuration {
	const document = parseDocument(readFileSync(resolve(root, file), "utf8"));
	if (document.errors.length > 0) {
		throw new Error(`${file}: ${document.errors.map((error) => error.message).join("; ")}`);
	}
	const value: unknown = document.toJS();
	if (!objectValue(value)) {
		throw new Error(`${file}: expected a workflow mapping`);
	}
	return value;
}
function mismatch(path: string, actual: unknown, expected: string): string[] {
	return actual === expected
		? []
		: [
				`${path}: expected ${JSON.stringify(expected)}, got ${actual === undefined ? "missing" : JSON.stringify(actual)}`,
			];
}
function sharedJobs(config: Configuration, file: string, ref: string): string[] {
	const jobs = field(config, "jobs");
	if (!objectValue(jobs)) {
		return [
			`${file}: expected jobs using ${SHARED_WORKFLOWS} pinned to ${CI} env.PI_AUTOMATION_REF`,
		];
	}
	let shared = 0;
	const problems: string[] = [];
	for (const [name, job] of Object.entries(jobs)) {
		const uses = field(job, "uses");
		if (typeof uses !== "string" || !uses.startsWith(SHARED_WORKFLOWS)) {
			continue;
		}
		shared++;
		const path = `${file}:jobs.${name}`;
		const workflowName = uses.split("@")[0];
		problems.push(
			...mismatch(
				`${path}.uses (use ${CI} env.PI_AUTOMATION_REF)`,
				uses,
				`${workflowName}@${ref}`,
			),
			...mismatch(
				`${path}.with.automation-ref (use ${CI} env.PI_AUTOMATION_REF)`,
				field(job, "with", "automation-ref"),
				ref,
			),
		);
	}
	if (shared === 0) {
		problems.push(
			`${file}: no shared automation workflow found; use ${SHARED_WORKFLOWS} at ${CI} env.PI_AUTOMATION_REF`,
		);
	}
	return problems;
}
function automationCheckout(config: Configuration, file: string, ref: string): string[] {
	const jobs = field(config, "jobs");
	const problems: string[] = [];
	let checkouts = 0;
	for (const [name, job] of Object.entries(objectValue(jobs) ? jobs : {})) {
		if (field(job, "env", "PI_AUTOMATION_REF") !== undefined) {
			problems.push(
				`${file}:jobs.${name}.env.PI_AUTOMATION_REF: remove the override; use the workflow-level authority`,
			);
		}
		const steps = field(job, "steps");
		if (!Array.isArray(steps)) {
			continue;
		}
		const entries: readonly unknown[] = steps;
		for (const [index, step] of entries.entries()) {
			if (field(step, "env", "PI_AUTOMATION_REF") !== undefined) {
				problems.push(
					`${file}:jobs.${name}.steps[${index}].env.PI_AUTOMATION_REF: remove the override; use the workflow-level authority`,
				);
			}
			if (field(step, "with", "repository") === "fitchmultz/.github") {
				checkouts++;
				problems.push(
					...mismatch(
						`${file}:jobs.${name}.steps[${index}].with.ref (use ${CI} env.PI_AUTOMATION_REF)`,
						field(step, "with", "ref"),
						ref,
					),
				);
			}
		}
	}
	return checkouts === 0
		? [...problems, `${file}: shared automation checkout must use ${CI} env.PI_AUTOMATION_REF`]
		: problems;
}
function includes(value: unknown, item: string): boolean {
	return Array.isArray(value) && value.includes(item);
}
function cohortRuleProblems(rule: Configuration, range: string): string[] {
	const selectors = [
		["matchManagers", "npm"],
		["matchDepTypes", "devDependencies"],
		["matchPackageNames", "@earendil-works/**"],
	];
	const problems: string[] = [];
	for (const [key, expected] of selectors) {
		const values = field(rule, key);
		if (!Array.isArray(values) || values.length !== 1 || values[0] !== expected) {
			problems.push(
				`renovate.json:Pi development-cohort ${key} must contain only ${expected}; keep the support floor in one applicable npm rule`,
			);
		}
	}
	const allowed = new Set(["description", "allowedVersions", ...selectors.map(([key]) => key)]);
	for (const key of Object.keys(rule)) {
		if (!allowed.has(key)) {
			problems.push(
				`renovate.json:Pi development-cohort ${key} is unsupported; keep applicability in matchManagers/matchDepTypes/matchPackageNames`,
			);
		}
	}
	return [
		...problems,
		...mismatch(
			"renovate.json:Pi development-cohort allowedVersions (use package.json peerDependencies floor)",
			rule.allowedVersions,
			range,
		),
	];
}
/** Other local range rules must demonstrably not override the Pi npm floor. */
function independentRange(rule: unknown): boolean {
	if (field(rule, "allowedVersions") === undefined) {
		return true;
	}
	const managers = field(rule, "matchManagers");
	if (
		Array.isArray(managers) &&
		managers.length > 0 &&
		managers.every(
			(manager: unknown) =>
				typeof manager === "string" &&
				/^[a-z][a-z0-9-]*$/u.test(manager) &&
				manager !== "npm",
		)
	) {
		return true;
	}
	const names = field(rule, "matchPackageNames");
	if (!Array.isArray(names) || names.length === 0) {
		return false;
	}
	const packages: readonly unknown[] = names;
	return packages.every(
		(name) =>
			typeof name === "string" &&
			/^(?:@[\w.-]+\/)?[\w.-]+$/u.test(name) &&
			!name.toLowerCase().startsWith("@earendil-works/"),
	);
}
function floorProblems(manifest: Configuration, renovate: Configuration): string[] {
	const range = field(manifest, "peerDependencies", "@earendil-works/pi-coding-agent");
	if (typeof range !== "string" || !/^>=\d+\.\d+\.\d+$/u.test(range)) {
		return [
			"package.json:peerDependencies coding-agent must declare the supported >=x.y.z floor",
		];
	}
	const problems = mismatch(
		"package.json:peerDependencies.@earendil-works/pi-tui (use coding-agent's support floor)",
		field(manifest, "peerDependencies", "@earendil-works/pi-tui"),
		range,
	);
	const rules = field(renovate, "packageRules");
	const entries: readonly unknown[] = Array.isArray(rules) ? rules : [];
	const cohort = entries.filter(
		(rule): rule is Configuration =>
			objectValue(rule) &&
			includes(field(rule, "matchPackageNames"), "@earendil-works/**") &&
			includes(field(rule, "matchDepTypes"), "devDependencies"),
	);
	if (cohort.length !== 1) {
		return [
			...problems,
			"renovate.json: expected one Pi development-cohort rule matching package.json's support floor",
		];
	}
	return [
		...problems,
		...cohortRuleProblems(cohort[0], range),
		...entries.flatMap((rule, index) =>
			rule === cohort[0] || independentRange(rule)
				? []
				: [
						`renovate.json:packageRules[${index}].allowedVersions may override the Pi floor; use the single Pi cohort rule, literal non-Pi package names, or a non-npm manager`,
					],
		),
	];
}
/** GitHub requires literal reusable-workflow refs; validate their relationship, not their current SHA. */
export function checkConfiguration(root: string): readonly string[] {
	const ci = workflow(root, CI);
	const release = workflow(root, RELEASE);
	const version = workflow(root, VERSION);
	const ref = field(ci, "env", "PI_AUTOMATION_REF");
	const problems =
		typeof ref === "string" && /^[a-f0-9]{40}$/u.test(ref)
			? [
					...sharedJobs(ci, CI, ref),
					...sharedJobs(release, RELEASE, ref),
					...sharedJobs(version, VERSION, ref),
					...automationCheckout(release, RELEASE, ref),
				]
			: [`${CI}:env.PI_AUTOMATION_REF must be an immutable 40-character commit SHA`];
	return [
		...problems,
		...automationCheckout(ci, CI, "${{ env.PI_AUTOMATION_REF }}"),
		...floorProblems(
			readObject(resolve(root, "package.json")),
			readObject(resolve(root, "renovate.json")),
		),
	];
}

if (import.meta.main) {
	const problems = checkConfiguration(resolve(process.argv[2] ?? "."));
	if (problems.length > 0) {
		console.error(problems.join("\n"));
		process.exitCode = 1;
	} else {
		console.log("Configuration policy: shared automation refs and support floors agree.");
	}
}
