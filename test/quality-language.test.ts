import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { expectFindings, fixture, lintFixture, repository } from "./quality-support.ts";
import { sourcePolicies } from "../scripts/quality-source.ts";

await test("unchecked JavaScript retains syntactic lint and Promise checks without semantic rules", () => {
	expectFindings(
		{
			files: {
				"test/native.test.mjs":
					"export function unhandled(value) { if (value == 1) { Promise.resolve(2); } }\n",
			},
		},
		[
			{ code: "eslint/eqeqeq", file: "test/native.test.mjs", line: 1 },
			{ code: "promise/catch-or-return", file: "test/native.test.mjs", line: 1 },
		],
	);
});

await test("TypeScript, inherited checkJs and per-file ts-check receive semantic lint", () => {
	const files = {
		"typed.ts":
			"export function unchecked(value: number): number { if (value) { return 1; } return 0; }\n",
		"checked/checked.js": "export function unchecked() { Promise.resolve(1); }\n",
		"checked/tsconfig.json": JSON.stringify({
			extends: "../tsconfig.json",
			compilerOptions: { checkJs: true },
			include: ["./*.js"],
		}),
		"directive.js": "// @ts-check\nexport function unchecked() { Promise.resolve(1); }\n",
	};
	expectFindings({ files }, [
		{ code: "typescript/strict-boolean-expressions", file: "typed.ts", line: 1 },
		{ code: "typescript/no-floating-promises", file: "checked/checked.js", line: 1 },
		{ code: "promise/catch-or-return", file: "checked/checked.js", line: 1 },
		{ code: "typescript/no-floating-promises", file: "directive.js", line: 2 },
		{ code: "promise/catch-or-return", file: "directive.js", line: 2 },
	]);
});

await test("compiler diagnostics remain separate from semantic lint scope", () => {
	const project = fixture({
		files: {
			"unchecked.js": "export const value = 1;\n",
			"consumer.ts":
				"import { value } from './unchecked.js';\nexport const text: string = value;\n",
		},
	});
	try {
		const compiler = spawnSync(join(repository, "node_modules/.bin/tsc"), ["--noEmit"], {
			cwd: project.root,
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(compiler.status, 1);
		assert.match(compiler.stdout, /consumer\.ts.*TS2322/u);
		assert.equal(compiler.stderr, "");
		const scopes = sourcePolicies(project.root, ["unchecked.js", "consumer.ts"]);
		assert.deepEqual(
			scopes.map(({ checked }) => checked),
			[false, true],
		);
		assert.ok(scopes.every(({ strict, noImplicitReturns }) => strict && noImplicitReturns));
	} finally {
		project.dispose();
	}
});

await test("compiler checking applies to inherited checkJs and ts-check, not unchecked JavaScript", () => {
	const output = lintFixture({
		files: {
			"test/native.test.mjs": "export const x = (1).missing;\n",
			"checked.ts": "export const x = (1).missing;\n",
			"directive.js": "// @ts-check\nexport const x = (1).missing;\n",
			"inherited/tsconfig.json": JSON.stringify({
				extends: "../tsconfig.json",
				compilerOptions: { checkJs: true },
				include: ["*.js"],
			}),
			"inherited/test.js": "export const x = (1).missing;\n",
		},
		paths: ["test/native.test.mjs", "checked.ts", "directive.js", "inherited/test.js"],
	});
	assert.equal(output.filter(({ code }) => code.startsWith("typescript/")).length, output.length);
	assert.deepEqual([...new Set(output.map(({ file }) => file))].toSorted(), [
		"checked.ts",
		"directive.js",
		"inherited/test.js",
	]);
	assert.ok(
		output.some(({ code }) => /2339/u.test(code)),
		"type-check mode must emit compiler diagnostics, not merely lint diagnostics",
	);
});
