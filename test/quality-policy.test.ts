import assert from "node:assert/strict";
import test from "node:test";
import { checkPolicy, objectValue, suppressionProblems } from "../scripts/quality-policy.ts";
import { sourcePolicies } from "../scripts/quality-source.ts";
import { expectFindings, fixture, policy, repository } from "./quality-support.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";

await test("unchecked-JavaScript overrides disable installed type-aware metadata, not namespaces", () => {
	const result = spawnSync(
		join(repository, "node_modules/.bin/oxlint"),
		["--rules", "--format=json"],
		{ encoding: "utf8", timeout: 30_000 },
	);
	assert.equal(result.status, 0);
	const metadata: unknown = JSON.parse(result.stdout);
	assert.ok(Array.isArray(metadata));
	const entries: readonly unknown[] = metadata;
	const names = entries.flatMap((entry) => {
		assert.ok(objectValue(entry));
		if (entry.type_aware !== true) {
			return [];
		}
		assert.equal(typeof entry.scope, "string");
		assert.equal(typeof entry.value, "string");
		if (typeof entry.scope !== "string" || typeof entry.value !== "string") {
			throw new Error("Invalid installed rule metadata");
		}
		return [`${entry.scope}/${entry.value}`];
	});
	assert.ok(Array.isArray(policy.overrides));
	const overrides: readonly unknown[] = policy.overrides;
	const unchecked = overrides.find(
		(entry) =>
			objectValue(entry) &&
			objectValue(entry.rules) &&
			entry.rules["typescript/no-floating-promises"] === "off",
	);
	assert.ok(objectValue(unchecked) && objectValue(unchecked.rules));
	assert.deepEqual(
		Object.keys(unchecked.rules).toSorted(),
		[...names, "typescript/explicit-module-boundary-types"].toSorted(),
	);
	assert.ok(
		!Object.hasOwn(unchecked.rules, "typescript/no-explicit-any"),
		"syntactic TypeScript namespace rules must not all be waived",
	);
});

await test("suppression policy parses actual comments, never strings, regexes or template text", () => {
	const project = fixture({
		files: {
			"examples.ts": [
				"export const quoted = '// oxlint-disable';",
				"export const template = `/* @ts-nocheck */ ${'// eslint-disable'}`;",
				"export const regex = /oxlint-disable-next-line no-floating-promises/u;",
				"/** Documentation mentions oxlint-disable-next-line and @ts-ignore without applying either. */",
				"// @ts-nocheck",
				"/* oxlint-disable */",
				"// oxlint-disable-next-line typescript/no-floating-promises",
				"export const number = 1;",
			].join("\n"),
		},
	});
	try {
		const source = sourcePolicies(project.root, ["examples.ts"]).at(0);
		assert.ok(source);
		assert.deepEqual(suppressionProblems(source), [
			"examples.ts:5: compiler suppression is forbidden",
			"examples.ts:6: only one named rule on oxlint-disable-next-line is permitted",
			"examples.ts:7: directive needs an adjacent contract explanation",
		]);
	} finally {
		project.dispose();
	}
});

await test("explained native directives preserve only authorized sites and generic callback shape", () => {
	const project = fixture({
		files: {
			"src/ui/text.ts":
				"// Tool previews reject terminal control sequences rather than execute them.\n// oxlint-disable-next-line no-control-regex\nexport const forbidden = /[\\u0000]/u;\n",
			"wrong.ts":
				"// This broad rule would hide ordinary unsafe Promise ownership.\n// oxlint-disable-next-line typescript/no-floating-promises\nexport const x = 1;\n",
			"generic.ts":
				"export function invoke<T>(\n// This plain callable exposes no mutable properties; T describes its result.\n// oxlint-disable-next-line typescript/prefer-readonly-parameter-types\noperation: () => T,\n): T { return operation(); }\n",
			"wrong-generic.ts":
				"export function invoke(\n// Mutable attached application state is not a generic result false positive.\n// oxlint-disable-next-line typescript/prefer-readonly-parameter-types\noperation: (() => number) & { state: number },\n): number { return operation(); }\n",
		},
	});
	try {
		const output = sourcePolicies(project.root, [
			"src/ui/text.ts",
			"wrong.ts",
			"generic.ts",
			"wrong-generic.ts",
		]).flatMap(suppressionProblems);
		assert.deepEqual(output, [
			"wrong.ts:2: unapproved rule or scope: typescript/no-floating-promises",
			"wrong-generic.ts:3: unapproved rule or scope: typescript/prefer-readonly-parameter-types",
		]);
	} finally {
		project.dispose();
	}
});

await test("only described dedicated negative type tests may use expect-error", () => {
	const project = fixture({
		files: {
			"production.ts":
				"// @ts-expect-error: This cannot suppress an application compiler failure.\nexport const value: number = 'wrong';\n",
			"types.test-d.ts":
				"// @ts-expect-error: A string must not satisfy the numeric input contract.\nexport const value: number = 'wrong';\n",
			"short.test-d.ts": "// @ts-expect-error short\nexport const value: number = 'wrong';\n",
		},
	});
	try {
		const output = sourcePolicies(project.root, [
			"production.ts",
			"types.test-d.ts",
			"short.test-d.ts",
		]).flatMap(suppressionProblems);
		assert.equal(output.length, 2);
		assert.ok(output[0]?.startsWith("production.ts:1:"));
		assert.ok(output[1]?.startsWith("short.test-d.ts:1:"));
	} finally {
		project.dispose();
	}
});

await test("framework mutation allowances cannot exempt an ordinary input or another file", () => {
	const body =
		"export function stream(opts) { opts.cacheRetention = 'none'; }\nexport function ordinary(input) { input.value = 1; }\n";
	expectFindings(
		{
			files: { "test/native.test.mjs": body, "test/host.test.mjs": body },
			paths: ["test/native.test.mjs", "test/host.test.mjs"],
		},
		[
			{ code: "eslint/no-param-reassign", file: "test/native.test.mjs", line: 2 },
			{ code: "eslint/no-param-reassign", file: "test/host.test.mjs", line: 1 },
			{ code: "eslint/no-param-reassign", file: "test/host.test.mjs", line: 2 },
		],
	);
});

await test("contract-required undefined options retain checks outside the two exact fixture files", () => {
	const body =
		"export const nothing: () => undefined = () => undefined;\nexport function optional(value?: number): number | undefined { return value; }\nexport const value = optional(undefined);\n";
	expectFindings({ files: { "test/posthorse.test.ts": body, "test/unscoped.test.ts": body } }, [
		{ code: "unicorn/no-useless-undefined", file: "test/unscoped.test.ts", line: 1 },
		{ code: "unicorn/no-useless-undefined", file: "test/unscoped.test.ts", line: 3 },
	]);
});

await test("maintained source inventory and effective projects remain covered in normal lint", () => {
	assert.deepEqual(checkPolicy(repository), []);
});

await test("semantic scope fails closed when an unchecked JavaScript fixture opts into ts-check", () => {
	const project = fixture({
		files: {
			"test/host.test.mjs": "export const value = 1;\n",
			"test/native.test.mjs": "// @ts-check\nexport const value = 1;\n",
			"test/official.test.mjs": "export const value = 1;\n",
		},
	});
	try {
		execFileSync("git", ["init", "--quiet"], { cwd: project.root });
		assert.deepEqual(checkPolicy(project.root), [
			"Semantic lint scope disagrees with effective compiler/directive scope: test/native.test.mjs",
		]);
	} finally {
		project.dispose();
	}
});
