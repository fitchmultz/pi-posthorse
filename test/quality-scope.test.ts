import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { scopeReleaseQualityControls } from "../scripts/release-quality-scope.ts";
import { repository } from "./quality-support.ts";

const SCOPE = join(repository, "scripts", "release-quality-scope.ts");

function fixtureRepository(): { root: string; dispose: () => void } {
	const root = mkdtempSync(join(tmpdir(), "posthorse-scope-"));
	execFileSync("git", ["init", "--initial-branch=main", root]);
	return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function commit(root: string, edits: Readonly<Record<string, string | null>>): string {
	for (const [file, text] of Object.entries(edits)) {
		const path = join(root, file);
		if (text === null) {
			rmSync(path);
		} else {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, text);
		}
	}
	execFileSync("git", ["-C", root, "add", "--all"]);
	execFileSync("git", [
		"-C",
		root,
		"-c",
		"user.name=quality scope",
		"-c",
		"user.email=quality-scope@example.invalid",
		"commit",
		"--allow-empty",
		"--message=fixture",
	]);
	return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

await test("a pull request on fast paths skips the disposable controls", () => {
	const project = fixtureRepository();
	try {
		const base = commit(project.root, { "src/anchor.ts": "export {};\n" });
		const head = commit(project.root, {
			"src/feature.ts": "export const feature = 1;\n",
			"test/feature.test.ts": 'import { test } from "node:test";\n',
			"docs/feature.md": "# Feature\n",
		});
		const plan = scopeReleaseQualityControls(
			{ event: "pull_request", base, head },
			project.root,
		);
		assert.equal(plan.controlsRequired, false);
		assert.deepEqual(
			[...plan.files],
			["docs/feature.md", "src/feature.ts", "test/feature.test.ts"],
		);
		assert.match(plan.reason, /product source and tests; documentation and policy/);
	} finally {
		project.dispose();
	}
});

await test("a pull request does not adopt main's paths advanced past the branch point", () => {
	const project = fixtureRepository();
	try {
		commit(project.root, { "src/anchor.ts": "export {};\n" });
		execFileSync("git", ["-C", project.root, "branch", "pr"]);
		const base = commit(project.root, { "scripts/verify.ts": "export {};\n" });
		execFileSync("git", ["-C", project.root, "checkout", "--quiet", "pr"]);
		const head = commit(project.root, { "src/feature.ts": "export const feature = 1;\n" });
		const plan = scopeReleaseQualityControls(
			{ event: "pull_request", base, head },
			project.root,
		);
		assert.equal(plan.controlsRequired, false);
		assert.deepEqual([...plan.files], ["src/feature.ts"]);
	} finally {
		project.dispose();
	}
});

await test("quality-machinery paths require the controls", async (t) => {
	for (const path of [
		"package.json",
		"package-lock.json",
		".oxlintrc.json",
		".oxfmtrc.json",
		"tsconfig.json",
		"scripts/verify.ts",
		".github/workflows/ci.yml",
	]) {
		await t.test(path, () => {
			const project = fixtureRepository();
			try {
				const base = commit(project.root, { "src/anchor.ts": "export {};\n" });
				const head = commit(project.root, { [path]: "{}\n" });
				const plan = scopeReleaseQualityControls(
					{ event: "pull_request", base, head },
					project.root,
				);
				assert.equal(plan.controlsRequired, true);
				assert.match(plan.reason, new RegExp(RegExp.escape(path)));
			} finally {
				project.dispose();
			}
		});
	}
});

await test("deleted machinery paths still require the controls", () => {
	const project = fixtureRepository();
	try {
		const base = commit(project.root, {
			"tsconfig.json": "{}\n",
			"src/anchor.ts": "export {};\n",
		});
		const head = commit(project.root, { "tsconfig.json": null });
		const plan = scopeReleaseQualityControls(
			{ event: "pull_request", base, head },
			project.root,
		);
		assert.equal(plan.controlsRequired, true);
		assert.deepEqual([...plan.files], ["tsconfig.json"]);
	} finally {
		project.dispose();
	}
});

await test("unclassified paths fail closed onto the controls", () => {
	const project = fixtureRepository();
	try {
		const base = commit(project.root, { "src/anchor.ts": "export {};\n" });
		const head = commit(project.root, { "unknown.cfg": "{}\n" });
		const plan = scopeReleaseQualityControls(
			{ event: "pull_request", base, head },
			project.root,
		);
		assert.equal(plan.controlsRequired, true);
		assert.match(plan.reason, /Default rule/);
		assert.match(plan.reason, /unknown\.cfg/);
	} finally {
		project.dispose();
	}
});

await test("every non-pull-request event runs the controls unconditionally", () => {
	for (const event of ["push", "schedule", "workflow_dispatch", "workflow_call"]) {
		const plan = scopeReleaseQualityControls({ event });
		assert.equal(plan.controlsRequired, true, event);
		assert.deepEqual([...plan.files], []);
		assert.match(plan.reason, /unconditionally/);
	}
});

await test("a pull request scope requires full commit SHAs", () => {
	assert.throws(() => scopeReleaseQualityControls({ event: "pull_request" }), /full commit SHAs/);
	assert.throws(
		() => scopeReleaseQualityControls({ event: "pull_request", base: "abc", head: "def" }),
		/full commit SHAs/,
	);
});

await test("unknown commits are rejected instead of silently skipping", () => {
	const project = fixtureRepository();
	try {
		const base = commit(project.root, { "src/anchor.ts": "export {};\n" });
		assert.throws(() =>
			scopeReleaseQualityControls(
				{ event: "pull_request", base, head: "f".repeat(40) },
				project.root,
			),
		);
	} finally {
		project.dispose();
	}
});

await test("an empty pull-request diff requires the controls", () => {
	const project = fixtureRepository();
	try {
		const base = commit(project.root, { "src/anchor.ts": "export {};\n" });
		const head = commit(project.root, {});
		const plan = scopeReleaseQualityControls(
			{ event: "pull_request", base, head },
			project.root,
		);
		assert.equal(plan.controlsRequired, true);
		assert.match(plan.reason, /No changed paths/);
	} finally {
		project.dispose();
	}
});

await test("the CLI records the decision in workflow outputs", () => {
	const output = mkdtempSync(join(tmpdir(), "posthorse-scope-output-"));
	try {
		const outputFile = join(output, "github-output.txt");
		const summaryFile = join(output, "github-summary.md");
		const result = spawnSync(process.execPath, [SCOPE, "--event", "push"], {
			encoding: "utf8",
			env: {
				...process.env,
				GITHUB_OUTPUT: outputFile,
				GITHUB_STEP_SUMMARY: summaryFile,
			},
		});
		assert.equal(result.status, 0, result.stderr);
		assert.equal(readFileSync(outputFile, "utf8"), "controls-required=true\n");
		assert.match(
			readFileSync(summaryFile, "utf8"),
			/Release quality controls required: \*\*true\*\*/,
		);
		assert.match(result.stdout, /"controlsRequired": true/);
	} finally {
		rmSync(output, { recursive: true, force: true });
	}
});

await test("the CLI explains its usage and rejects a missing event", () => {
	const help = spawnSync(process.execPath, [SCOPE, "--help"], { encoding: "utf8" });
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /Usage:/);
	const missing = spawnSync(process.execPath, [SCOPE], { encoding: "utf8" });
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /--event is required/);
});
