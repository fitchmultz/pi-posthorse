import { test } from "node:test";
import { expectFindings } from "./quality-support.ts";

await test("Node registrations and test bodies require explicit Promise ownership", async () => {
	await expectFindings(
		{
			files: {
				"test/valid.ts": [
					"import { test, suite } from 'node:test';",
					"await test('top level', () => { /* Owned completion. */ });",
					"await suite('group', async () => { await test('suite child', () => { /* Node owns execution ordering. */ }); });",
					"await test('owned work', async (t) => { await t.test('subtest', () => { /* Awaited subtest. */ }); await Promise.resolve(1); });",
				].join("\n"),
				"test/registration.ts":
					"import { test } from 'node:test';\ntest('unowned', () => { /* Registration also needs an await. */ });",
				"test/subtest.ts": [
					"import { test } from 'node:test';",
					"await test('parent', async (t) => {",
					"t.test('unowned', () => { /* Context subtests need an await. */ });",
					"});",
				].join("\n"),
				"test/local.ts":
					"async function test(): Promise<void> { /* Ordinary local work. */ }\ntest();",
				"test/foreign.ts":
					"export async function test(): Promise<void> { /* Ordinary imported work. */ }",
				"test/foreign-call.ts": "import { test } from './foreign.js';\ntest();",
				"test/body.ts":
					"import { test } from 'node:test';\nawait test('body', () => { Promise.resolve(1); });",
				"test/unrelated.ts":
					"async function ordinary(): Promise<void> { /* Independent work. */ }\nordinary();",
			},
		},
		[
			{ code: "typescript/no-floating-promises", file: "test/registration.ts", line: 2 },
			{ code: "typescript/no-floating-promises", file: "test/subtest.ts", line: 3 },
			{ code: "typescript/no-floating-promises", file: "test/local.ts", line: 2 },
			{ code: "typescript/no-floating-promises", file: "test/foreign-call.ts", line: 2 },
			{ code: "typescript/no-floating-promises", file: "test/body.ts", line: 2 },
			{ code: "promise/catch-or-return", file: "test/body.ts", line: 2 },
			{ code: "typescript/no-floating-promises", file: "test/unrelated.ts", line: 2 },
		],
	);
});
