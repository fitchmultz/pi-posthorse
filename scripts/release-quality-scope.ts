import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { posix } from "node:path";
import { parseArgs } from "node:util";

const help = `Usage:
  node scripts/release-quality-scope.ts --event EVENT [--base SHA --head SHA]

Decides whether a CI run executes scripts/release-quality-controls.sh. Only pull requests are
scoped: base and head must then name immutable commits, and the controls run only when every
path in the merge-base diff is on a fast path below. Every other event, including pushes to main,
schedules, manual dispatches, and release qualification, runs the controls unconditionally.
Unknown paths, empty diffs, and invalid input fail closed: the controls run.

Fast paths (the controls are skipped when every changed path matches one):
  product source and tests: src/**, test/**, index.ts, ui.ts
  documentation and policy: docs/**, ARTIFACTS/**, .github/readme/**, README.md, CHANGELOG.md,
    AGENTS.md, LICENSE, renovate.json, diagram.svg, diagram.png

Writes controls-required=true|false to GITHUB_OUTPUT when set and a decision summary to
GITHUB_STEP_SUMMARY when set.

Examples:
  node scripts/release-quality-scope.ts --event pull_request --base "$(git rev-parse origin/main)" --head "$(git rev-parse HEAD)"
  node scripts/release-quality-scope.ts --event push

Exit codes: 0 = decision recorded; 1 = invalid input or Git failure.
  -h, --help  Show this help`;

const git = (root: string, ...args: readonly string[]) =>
	execFileSync("git", args, {
		encoding: "utf8",
		cwd: root,
		timeout: 30_000,
		maxBuffer: 64 * 1024 * 1024,
	});

const matchesAny =
	(patterns: readonly string[]) =>
	(path: string): boolean =>
		patterns.some((pattern) => posix.matchesGlob(path, pattern));

// Exact paths the disposable negative controls do not prove; a path missing here keeps the controls required.
const fastPaths: ReadonlyArray<readonly [string, (path: string) => boolean]> = [
	["product source and tests", matchesAny(["src/**", "test/**", "index.ts", "ui.ts"])],
	[
		"documentation and policy",
		matchesAny([
			"docs/**",
			"ARTIFACTS/**",
			".github/readme/**",
			"README.md",
			"CHANGELOG.md",
			"AGENTS.md",
			"LICENSE",
			"renovate.json",
			"diagram.svg",
			"diagram.png",
		]),
	],
];

export interface ScopeValues {
	readonly event: string;
	readonly base?: string | undefined;
	readonly head?: string | undefined;
}

export interface ScopePlan {
	readonly controlsRequired: boolean;
	readonly reason: string;
	readonly files: readonly string[];
}

export function scopeReleaseQualityControls(
	values: ScopeValues,
	root: string = process.cwd(),
): ScopePlan {
	if (values.event !== "pull_request") {
		return {
			controlsRequired: true,
			reason: "Only pull requests scope the controls; this event runs them unconditionally.",
			files: [],
		};
	}
	const { base, head } = values;
	if (
		typeof base !== "string" ||
		!/^[a-f0-9]{40}$/u.test(base) ||
		typeof head !== "string" ||
		!/^[a-f0-9]{40}$/u.test(head)
	) {
		throw new Error("base and head must be full commit SHAs for a pull request scope");
	}
	git(root, "rev-parse", "--verify", `${base}^{commit}`);
	git(root, "rev-parse", "--verify", `${head}^{commit}`);
	const before = git(root, "merge-base", base, head).trim();
	// NUL preserves unusual filenames; disabling rename detection retains deleted paths.
	const files = git(root, "diff", "--name-only", "-z", "--no-renames", before, head, "--")
		.split("\0")
		.filter(Boolean);
	if (files.length === 0) {
		return {
			controlsRequired: true,
			reason: "No changed paths to prove a fast-path scope.",
			files,
		};
	}
	const unclassified = files.filter((path) => !fastPaths.some(([, matches]) => matches(path)));
	if (unclassified.length > 0) {
		const paths = unclassified.map((path) => JSON.stringify(path)).join(", ");
		return {
			controlsRequired: true,
			reason: `Default rule: these changed paths are on no fast path, so the controls are required: ${paths}.`,
			files,
		};
	}
	const applied = fastPaths.filter(([, matches]) => files.some(matches)).map(([name]) => name);
	return {
		controlsRequired: false,
		reason: `Every changed path is on a fast path: ${applied.join("; ")}.`,
		files,
	};
}

function writeWorkflowOutputs(plan: ScopePlan): void {
	const output = process.env.GITHUB_OUTPUT;
	if (output !== undefined && output !== "") {
		appendFileSync(output, `controls-required=${plan.controlsRequired}\n`);
	}
	const summary = process.env.GITHUB_STEP_SUMMARY;
	if (summary !== undefined && summary !== "") {
		appendFileSync(
			summary,
			`Release quality controls required: **${plan.controlsRequired}**. ${plan.reason}\n`,
		);
	}
}

if (import.meta.main) {
	try {
		const { values } = parseArgs({
			options: {
				event: { type: "string" },
				base: { type: "string" },
				head: { type: "string" },
				help: { type: "boolean", short: "h" },
			},
		});
		if (values.help === true) {
			console.log(help);
		} else if (typeof values.event !== "string" || values.event.length === 0) {
			throw new Error("--event is required");
		} else {
			const plan = scopeReleaseQualityControls({
				event: values.event,
				base: values.base,
				head: values.head,
			});
			writeWorkflowOutputs(plan);
			console.log(JSON.stringify(plan, null, 2));
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
}
