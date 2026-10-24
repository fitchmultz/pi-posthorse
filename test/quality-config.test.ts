import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseDocument, stringify } from "yaml";
import { checkConfiguration } from "../scripts/config-policy.ts";
import { repository, runCli } from "./quality-support.ts";

const CI = ".github/workflows/ci.yml";
const RELEASE = ".github/workflows/npm-release.yml";
const NEXT_REF = "a".repeat(40);
const BASE_REF = "b".repeat(40);

function configurationFixture() {
	const root = mkdtempSync(join(tmpdir(), "posthorse-config-"));
	mkdirSync(join(root, ".github/workflows"), { recursive: true });
	const shared = (name: string) => ({
		uses: `fitchmultz/.github/.github/workflows/${name}@${BASE_REF}`,
		with: { "automation-ref": BASE_REF },
	});
	const files = {
		[CI]: {
			env: { PI_AUTOMATION_REF: BASE_REF },
			jobs: {
				resolve: shared("resolve-hosts.yml"),
				qualify: {
					steps: [
						{
							uses: "actions/checkout@fixture",
							with: {
								repository: "fitchmultz/.github",
								ref: "${{ env.PI_AUTOMATION_REF }}",
							},
						},
					],
				},
			},
		},
		[RELEASE]: {
			jobs: { plan: shared("npm-release-plan.yml"), publish: shared("npm-release.yml") },
		},
		"package.json": {
			peerDependencies: {
				"@earendil-works/pi-coding-agent": ">=1.3.0",
				"@earendil-works/pi-tui": ">=1.3.0",
			},
		},
		"renovate.json": {
			packageRules: [
				{
					matchManagers: ["npm"],
					matchPackageNames: ["@earendil-works/**"],
					matchDepTypes: ["devDependencies"],
					allowedVersions: ">=1.3.0",
				},
			],
		},
	};
	for (const [file, value] of Object.entries(files)) {
		writeFileSync(
			join(root, file),
			file.endsWith(".json") ? JSON.stringify(value) : stringify(value),
		);
	}
	return {
		root,
		dispose: () => rmSync(root, { recursive: true, force: true }),
	};
}
function change(
	root: string,
	file: string,
	path: readonly (string | number)[],
	value: unknown,
): void {
	const document = parseDocument(readFileSync(join(root, file), "utf8"));
	document.setIn(path, value);
	writeFileSync(
		join(root, file),
		file.endsWith(".json") ? JSON.stringify(document.toJS()) : document.toString(),
	);
}

test("configuration policy accepts a coherent future pin and support-floor update through its real CLI", async () => {
	const project = configurationFixture();
	try {
		assert.deepEqual(checkConfiguration(project.root), []);
		change(project.root, CI, ["env", "PI_AUTOMATION_REF"], NEXT_REF);
		change(
			project.root,
			CI,
			["jobs", "resolve", "uses"],
			`fitchmultz/.github/.github/workflows/resolve-hosts.yml@${NEXT_REF}`,
		);
		change(project.root, CI, ["jobs", "resolve", "with", "automation-ref"], NEXT_REF);
		for (const [job, workflow] of [
			["plan", "npm-release-plan.yml"],
			["publish", "npm-release.yml"],
		]) {
			change(
				project.root,
				RELEASE,
				["jobs", job, "uses"],
				`fitchmultz/.github/.github/workflows/${workflow}@${NEXT_REF}`,
			);
			change(project.root, RELEASE, ["jobs", job, "with", "automation-ref"], NEXT_REF);
		}
		for (const name of ["pi-coding-agent", "pi-tui"]) {
			change(
				project.root,
				"package.json",
				["peerDependencies", `@earendil-works/${name}`],
				">=2.0.0",
			);
		}
		change(project.root, "renovate.json", ["packageRules", 0, "allowedVersions"], ">=2.0.0");
		const result = await runCli(
			process.execPath,
			[join(repository, "scripts/config-policy.ts"), project.root],
			repository,
		);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.signal, null);
		assert.match(result.stdout, /shared automation refs and support floors agree/u);
	} finally {
		project.dispose();
	}
});

test("configuration policy rejects each independently drifted workflow reference with its owner path", async (t) => {
	const cases: readonly (readonly [
		file: string,
		path: readonly (string | number)[],
		value: string,
	])[] = [
		[CI, ["env", "PI_AUTOMATION_REF"], "main"],
		[
			CI,
			["jobs", "resolve", "uses"],
			`fitchmultz/.github/.github/workflows/resolve-hosts.yml@${NEXT_REF}`,
		],
		[CI, ["jobs", "resolve", "with", "automation-ref"], NEXT_REF],
		[
			RELEASE,
			["jobs", "plan", "uses"],
			`fitchmultz/.github/.github/workflows/npm-release-plan.yml@${NEXT_REF}`,
		],
		[RELEASE, ["jobs", "plan", "with", "automation-ref"], NEXT_REF],
		[
			RELEASE,
			["jobs", "publish", "uses"],
			`fitchmultz/.github/.github/workflows/npm-release.yml@${NEXT_REF}`,
		],
		[RELEASE, ["jobs", "publish", "with", "automation-ref"], NEXT_REF],
		[CI, ["jobs", "qualify", "steps", 0, "with", "ref"], NEXT_REF],
		[CI, ["jobs", "qualify", "env", "PI_AUTOMATION_REF"], NEXT_REF],
		[CI, ["jobs", "qualify", "steps", 0, "env", "PI_AUTOMATION_REF"], NEXT_REF],
	];
	await Promise.all(
		cases.map(async ([file, path, value]) => {
			await t.test(`${file} ${path.join(".")}`, () => {
				const project = configurationFixture();
				try {
					change(project.root, file, path, value);
					const problems = checkConfiguration(project.root);
					assert.equal(problems.length, 1, problems.join("\n"));
					assert.ok(
						problems.every((problem) => problem.startsWith(`${file}:`)),
						problems.join("\n"),
					);
					assert.ok(
						problems.some((problem) => problem.includes("PI_AUTOMATION_REF")),
						problems.join("\n"),
					);
				} finally {
					project.dispose();
				}
			});
		}),
	);
});

test("configuration CLI rejects the historical stale support floor rather than a parse or process error", async () => {
	const project = configurationFixture();
	try {
		// #91 head 53083d4 left this range after both peers moved to >=1.3.0.
		change(project.root, "renovate.json", ["packageRules", 0, "allowedVersions"], ">=1.0.0");
		const result = await runCli(
			process.execPath,
			[join(repository, "scripts/config-policy.ts"), project.root],
			repository,
		);
		assert.equal(result.signal, null);
		assert.equal(result.status, 1);
		assert.equal(result.stdout, "");
		assert.match(
			result.stderr,
			/^renovate\.json:Pi development-cohort allowedVersions .*package\.json peerDependencies floor/u,
		);
		assert.doesNotMatch(result.stderr, /SyntaxError|TypeError|ERR_MODULE_NOT_FOUND/u);
	} finally {
		project.dispose();
	}
});

test("the TUI peer cannot silently declare a different support floor", () => {
	const project = configurationFixture();
	try {
		change(
			project.root,
			"package.json",
			["peerDependencies", "@earendil-works/pi-tui"],
			">=2.0.0",
		);
		const problems = checkConfiguration(project.root);
		assert.equal(problems.length, 1);
		assert.match(
			problems[0] ?? "",
			/^package\.json:peerDependencies\.@earendil-works\/pi-tui .*coding-agent's support floor/u,
		);
	} finally {
		project.dispose();
	}
});

test("local Renovate rules cannot hide or override the single applicable Pi floor", async (t) => {
	const overrides = [
		{
			matchPackageNames: ["@earendil-works/pi-coding-agent"],
			matchDepTypes: ["devDependencies"],
			allowedVersions: ">=1.0.0",
		},
		{ matchPackageNames: ["@Earendil-Works/pi-coding-agent"], allowedVersions: ">=1.0.0" },
		{ matchPackageNames: ["/pi/"], allowedVersions: ">=1.0.0" },
		{ allowedVersions: ">=1.0.0" },
		{ matchManagers: ["NPM"], allowedVersions: ">=1.0.0" },
	];
	const cases: readonly (readonly [
		path: readonly (string | number)[],
		value: unknown,
		diagnostic: string,
	])[] = [
		[["packageRules", 0, "matchManagers"], ["dockerfile"], "matchManagers"],
		[["packageRules", 0, "matchFileNames"], ["elsewhere/**"], "matchFileNames"],
		...overrides.map(
			(value) => [["packageRules", 1], value, "packageRules[1].allowedVersions"] as const,
		),
	];
	await Promise.all(
		cases.map(async ([path, value, diagnostic]) => {
			await t.test(`${diagnostic}: ${JSON.stringify(value)}`, () => {
				const project = configurationFixture();
				try {
					change(project.root, "renovate.json", path, value);
					const problems = checkConfiguration(project.root);
					assert.equal(problems.length, 1, problems.join("\n"));
					assert.ok(problems[0]?.includes(diagnostic), problems.join("\n"));
				} finally {
					project.dispose();
				}
			});
		}),
	);
});

test("unrelated literal-package and non-npm ranges retain independent owners", () => {
	const project = configurationFixture();
	try {
		change(project.root, "renovate.json", ["packageRules", 1], {
			matchPackageNames: ["typescript", "@types/node"],
			allowedVersions: "<9",
		});
		change(project.root, "renovate.json", ["packageRules", 2], {
			matchManagers: ["dockerfile"],
			allowedVersions: "<30",
		});
		assert.deepEqual(checkConfiguration(project.root), []);
	} finally {
		project.dispose();
	}
});

test("configuration parsing rejects duplicate YAML authority keys and missing support policy", () => {
	const project = configurationFixture();
	try {
		const ci = readFileSync(join(project.root, CI), "utf8");
		writeFileSync(join(project.root, CI), `${ci}\nenv: { PI_AUTOMATION_REF: ${NEXT_REF} }\n`);
		assert.throws(() => checkConfiguration(project.root), /ci\.yml:.*unique/u);
		writeFileSync(join(project.root, CI), ci);
		change(project.root, "renovate.json", ["packageRules"], []);
		assert.deepEqual(checkConfiguration(project.root), [
			"renovate.json: expected one Pi development-cohort rule matching package.json's support floor",
		]);
	} finally {
		project.dispose();
	}
});
