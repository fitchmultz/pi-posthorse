import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkPolicy } from "../scripts/quality-policy.ts";
import { inspectSuppressions } from "../scripts/quality-directives.ts";
import { sourcePolicies } from "../scripts/quality-source.ts";
import { expectFindings, fixture, repository, runCli } from "./quality-support.ts";

await test("suppression policy reads actual comments, not strings, regexes or documentation", () => {
	const project = fixture({
		files: {
			"examples.ts": [
				"export const quoted = '🙂 // oxlint-disable';",
				"export const template = `/* @ts-nocheck */ ${'// eslint-disable'}`;",
				"export const regex = /[/*]oxlint-disable-next-line no-floating-promises/u;",
				"/** Documentation mentions oxlint-disable-next-line and @ts-ignore without applying either. */",
				"// @ts-nocheck",
				"/* oxlint-disable */",
				"// oxlint-disable-next-line typescript/no-floating-promises",
				"export const number = 1;",
			].join("\n"),
		},
	});
	try {
		const source = sourcePolicies(project.root, ["examples.ts"])[0];
		assert.ok(source);
		assert.deepEqual(inspectSuppressions(source).problems, [
			"examples.ts:5: compiler suppression is forbidden",
			"examples.ts:6: lint suppressions are not permitted",
			"examples.ts:7: lint suppressions are not permitted",
		]);
	} finally {
		project.dispose();
	}
});

await test("suppression governance sees empty containers and punctuation gaps", async (t) => {
	for (const container of [
		"export const empty = { /* oxlint-disable eqeqeq */ };",
		"export const empty = [ /* oxlint-disable eqeqeq */ ];",
		"export function empty(): void { /* oxlint-disable eqeqeq */ }",
		"export const number = ( /* oxlint-disable eqeqeq */ 1 );",
		"export const first = 1; /* oxlint-disable eqeqeq */ export const second = 2;",
	]) {
		await t.test(container, async () => {
			const files = {
				"hidden.ts": `${container}\nexport function unsafe(n: number): boolean { return n == 1; }\n`,
			};
			await expectFindings({ files }, []);
			const project = fixture({ files });
			try {
				const source = sourcePolicies(project.root, ["hidden.ts"])[0];
				assert.ok(source);
				assert.deepEqual(inspectSuppressions(source).problems, [
					"hidden.ts:1: lint suppressions are not permitted",
				]);
			} finally {
				project.dispose();
			}
		});
	}
});

await test("JSX text is not a directive, but JSX expression comments are", () => {
	const project = fixture({
		files: {
			"example.tsx": [
				"export const template = `🙂 /* oxlint-disable */`;",
				"export const view = <div>// oxlint-disable",
				"@ts-nocheck",
				"{/* oxlint-disable eqeqeq */}</div>;",
			].join("\n"),
		},
		compiler: { jsx: "preserve" },
	});
	try {
		const source = sourcePolicies(project.root, ["example.tsx"])[0];
		assert.ok(source);
		assert.deepEqual(inspectSuppressions(source).problems, [
			"example.tsx:4: lint suppressions are not permitted",
		]);
	} finally {
		project.dispose();
	}
});

await test("used formatter suppressions cannot hide maintained source from acceptance", async (t) => {
	for (const directive of ["oxfmt-ignore", "prettier-ignore"]) {
		await t.test(directive, async () => {
			const project = fixture({
				files: { "hidden.ts": `// ${directive}\nexport const value={messy:1};\n` },
			});
			try {
				const source = sourcePolicies(project.root, ["hidden.ts"])[0];
				assert.ok(source);
				const ignored = await runCli(
					join(repository, "node_modules/.bin/oxfmt"),
					["--check", "hidden.ts"],
					project.root,
				);
				assert.equal(ignored.signal, null);
				assert.equal(ignored.status, 0, ignored.stdout + ignored.stderr);
				assert.deepEqual(inspectSuppressions(source).problems, [
					"hidden.ts:1: formatting suppressions require a recorded byte or readability contract",
				]);
				writeFileSync(join(project.root, "hidden.ts"), "export const value={messy:1};\n");
				const exposed = await runCli(
					join(repository, "node_modules/.bin/oxfmt"),
					["--check", "hidden.ts"],
					project.root,
				);
				assert.equal(exposed.signal, null);
				assert.equal(exposed.status, 1);
				assert.match(exposed.stdout + exposed.stderr, /hidden\.ts/u);
				writeFileSync(
					join(project.root, "hidden.ts"),
					`export const example = "// ${directive}";\nexport const value = { messy: 1 };\n`,
				);
				const valid = sourcePolicies(project.root, ["hidden.ts"])[0];
				assert.ok(valid);
				assert.deepEqual(inspectSuppressions(valid).problems, []);
				const formatted = await runCli(
					join(repository, "node_modules/.bin/oxfmt"),
					["--check", "hidden.ts"],
					project.root,
				);
				assert.equal(formatted.signal, null);
				assert.equal(formatted.status, 0, formatted.stdout + formatted.stderr);
			} finally {
				project.dispose();
			}
		});
	}
});

await test("used next-line directives cannot borrow an old exception in any file", async () => {
	const files = {
		"original.ts": [
			"export function original(value: number): boolean {",
			"// oxlint-disable-next-line eqeqeq -- QX-002: An old identifier grants no suppression.",
			"return value == 1;",
			"}",
		].join("\n"),
		"copied.ts": [
			"export function another(value: number): boolean {",
			"// oxlint-disable-next-line eqeqeq -- QX-002: An old identifier grants no suppression.",
			"return value == 2;",
			"}",
		].join("\n"),
	};
	await expectFindings({ files }, []);
	const project = fixture({ files });
	try {
		assert.deepEqual(
			sourcePolicies(project.root, Object.keys(files)).flatMap(
				(source) => inspectSuppressions(source).problems,
			),
			[
				"original.ts:2: lint suppressions are not permitted",
				"copied.ts:2: lint suppressions are not permitted",
			],
		);
	} finally {
		project.dispose();
	}
});

await test("only described dedicated negative type tests may use expect-error", () => {
	const files = {
		"production.ts":
			"// @ts-expect-error: A string violates this numeric contract.\nexport const value: number = 'wrong';\n",
		"types.test-d.ts":
			"// @ts-expect-error: A string violates this numeric contract.\nexport const value: number = 'wrong';\n",
		"short.test-d.ts": "// @ts-expect-error short\nexport const value: number = 'wrong';\n",
	};
	const project = fixture({ files });
	try {
		assert.deepEqual(
			sourcePolicies(project.root, Object.keys(files)).flatMap(
				(source) => inspectSuppressions(source).problems,
			),
			[
				"production.ts:1: expected compiler errors belong in described dedicated .test-d.ts tests",
				"short.test-d.ts:1: expected compiler errors belong in described dedicated .test-d.ts tests",
			],
		);
	} finally {
		project.dispose();
	}
});

await test("the real repository has complete source, project, profile and exception coverage", () => {
	assert.deepEqual(checkPolicy(repository), []);
});
