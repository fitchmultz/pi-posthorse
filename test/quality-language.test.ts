import assert from "node:assert/strict";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import { sourcePolicies } from "../scripts/quality-source.ts";
import { expectFindings, fixture, repository, runCli } from "./quality-support.ts";

nodeTest("all maintained JavaScript receives syntactic and semantic Promise checks", async () => {
	await expectFindings(
		{
			files: {
				"test/native.test.mjs":
					"export const value = Promise.resolve(1);\nPromise.resolve(2);\n",
			},
		},
		[
			{ code: "typescript/no-floating-promises", file: "test/native.test.mjs", line: 2 },
			{ code: "promise/catch-or-return", file: "test/native.test.mjs", line: 2 },
		],
	);
});

nodeTest("semantic analysis covers TS, inherited checkJs and explicit ts-check", async () => {
	await expectFindings(
		{
			files: {
				"typed.ts": "Promise.resolve(1);\n",
				"checked/checked.js": "Promise.resolve(1);\n",
				"checked/tsconfig.json": JSON.stringify({
					extends: "../tsconfig.json",
					compilerOptions: { checkJs: true },
					include: ["*.js"],
				}),
				"directive.js": "// @ts-check\nPromise.resolve(1);\n",
			},
		},
		[
			...["typed.ts", "checked/checked.js"].flatMap((file) => [
				{ code: "typescript/no-floating-promises", file, line: 1 },
				{ code: "promise/catch-or-return", file, line: 1 },
			]),
			{ code: "typescript/no-floating-promises", file: "directive.js", line: 2 },
			{ code: "promise/catch-or-return", file: "directive.js", line: 2 },
		],
	);
});

nodeTest("canonical compiler errors remain a separate gate from semantic lint", async (t) => {
	for (const [literal, status] of [
		["1", 0],
		["'wrong'", 1],
	] as const) {
		await t.test(literal, async () => {
			const files = { "consumer.ts": `export const value: number = ${literal};\n` };
			const project = fixture({ files });
			try {
				const result = await runCli(
					join(repository, "node_modules/.bin/tsc"),
					["--noEmit"],
					project.root,
				);
				assert.equal(result.signal, null);
				assert.equal(result.status, status);
				assert.equal(result.stderr, "");
				if (status === 1) {
					assert.match(result.stdout, /consumer\.ts\(1,14\): error TS2322:/u);
				} else {
					assert.equal(result.stdout, "");
				}
				assert.deepEqual(
					sourcePolicies(project.root, ["consumer.ts"]).map(
						(source) => source.compilerProblems,
					),
					[[]],
				);
			} finally {
				project.dispose();
			}
			await expectFindings({ files }, []);
		});
	}
});

nodeTest("canonical compiler checks JavaScript alongside TypeScript", async () => {
	const files = {
		"checked.ts": "export const value = (1).missing;\n",
		"javascript.js": "export const value = (1).missing;\n",
		"test/native.test.mjs": "export const value = (1).missing;\n",
	};
	const project = fixture({ files });
	try {
		const result = await runCli(
			join(repository, "node_modules/.bin/tsc"),
			["--noEmit"],
			project.root,
		);
		assert.equal(result.signal, null);
		assert.equal(result.status, 1);
		assert.equal(result.stderr, "");
		for (const file of Object.keys(files)) {
			assert.ok(result.stdout.includes(`${file}(1,26): error TS2339:`), result.stdout);
		}
		assert.equal(result.stdout.match(/error TS2339:/gu)?.length, 3);
		assert.ok(
			sourcePolicies(project.root, Object.keys(files)).every((source) => source.checked),
		);
	} finally {
		project.dispose();
	}
});

nodeTest(
	"handwritten declarations receive real compiler checking and reject unused expected errors",
	async (t) => {
		const cases = [
			{
				file: "boundary.d.ts",
				text: "export declare const value: number;\n",
				status: 0,
				code: undefined,
			},
			{
				file: "boundary.d.ts",
				text: "export declare const value: MissingType;\n",
				status: 2,
				code: "TS2304",
			},
			{
				file: "contract.test-d.ts",
				text: "// @ts-expect-error: A string cannot satisfy this numeric contract.\nexport const value: number = 'wrong';\n",
				status: 0,
				code: undefined,
			},
			{
				file: "contract.test-d.ts",
				text: "// @ts-expect-error: A string cannot satisfy this numeric contract.\nexport const value: number = 1;\n",
				status: 1,
				code: "TS2578",
			},
		] as const;
		for (const example of cases) {
			await t.test(example.text, async () => {
				const project = fixture({
					files: { [example.file]: example.text },
					compiler: { skipLibCheck: false },
				});
				try {
					const result = await runCli(
						join(repository, "node_modules/.bin/tsc"),
						["--noEmit"],
						project.root,
					);
					assert.equal(result.signal, null);
					assert.equal(result.status, example.status, result.stdout);
					assert.equal(result.stderr, "");
					if (example.code === undefined) {
						assert.equal(result.stdout, "");
					} else {
						assert.ok(result.stdout.includes(`${example.file}(1,`), result.stdout);
						assert.ok(result.stdout.includes(`error ${example.code}:`), result.stdout);
						assert.equal(result.stdout.match(/error TS\d+:/gu)?.length, 1);
					}
				} finally {
					project.dispose();
				}
			});
		}
	},
);
