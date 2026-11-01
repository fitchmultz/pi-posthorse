import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { expectFindings, lintFixture, policy } from "./quality-support.ts";
import { objectValue } from "../scripts/quality-settings.ts";

const registrations = {
	"test/valid.ts": [
		"import { test as nodeTest, suite } from 'node:test';",
		"nodeTest('top level', () => { /* Node owns registration completion. */ });",
		"await suite('group', () => { nodeTest('suite child', () => { /* Same registration binding. */ }); });",
		"nodeTest('owned work', async (t) => { await t.test('subtest', () => { /* Awaited subtest. */ }); await Promise.resolve(1); });",
	].join("\n"),
	"test/subtest.ts": [
		"import { test as nodeTest } from 'node:test';",
		"nodeTest('parent', async (t) => {",
		"t.test('unowned', () => { /* Context subtests are not registrations. */ });",
		"});",
	].join("\n"),
	"test/local.ts":
		"async function nodeTest(): Promise<void> { /* Ordinary local work. */ }\nnodeTest();",
	"test/foreign.ts":
		"export async function nodeTest(): Promise<void> { /* Ordinary imported work. */ }",
	"test/foreign-call.ts": "import { nodeTest } from './foreign.js';\nnodeTest();",
	"test/body.ts":
		"import { test as nodeTest } from 'node:test';\nnodeTest('body', () => { Promise.resolve(1); });",
	"test/unrelated.ts":
		"async function ordinary(): Promise<void> { /* Independent work. */ }\nordinary();",
};

await nodeTest(
	"Node registrations preserve all six ownership and declaration-origin boundaries",
	async () => {
		await expectFindings({ files: registrations }, [
			{ code: "typescript/no-floating-promises", file: "test/subtest.ts", line: 3 },
			{ code: "typescript/no-floating-promises", file: "test/local.ts", line: 2 },
			{ code: "typescript/no-floating-promises", file: "test/foreign-call.ts", line: 2 },
			{ code: "typescript/no-floating-promises", file: "test/body.ts", line: 2 },
			{ code: "promise/catch-or-return", file: "test/body.ts", line: 2 },
			{ code: "typescript/no-floating-promises", file: "test/unrelated.ts", line: 2 },
		]);
	},
);

await nodeTest("a wrong-package qualifier cannot approve real Node registrations", async () => {
	assert.ok(objectValue(policy.rules));
	const rule = policy.rules["typescript/no-floating-promises"];
	assert.ok(Array.isArray(rule) && objectValue(rule[1]));
	const findings = await lintFixture({
		files: { "unscoped.ts": registrations["test/valid.ts"] },
		rules: {
			"typescript/no-floating-promises": [
				"error",
				{
					...rule[1],
					allowForKnownSafeCalls: [
						{ from: "package", package: "@quality/not-node", name: ["nodeTest"] },
					],
				},
			],
		},
	});
	assert.deepEqual(
		findings.map(({ code, file, line }) => ({ code, file, line })),
		[
			{ code: "typescript/no-floating-promises", file: "unscoped.ts", line: 2 },
			{ code: "typescript/no-floating-promises", file: "unscoped.ts", line: 3 },
			{ code: "typescript/no-floating-promises", file: "unscoped.ts", line: 4 },
		],
	);
});
