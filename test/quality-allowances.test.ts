import assert from "node:assert/strict";
import test from "node:test";
import { expectFindings, lintFixture, policy } from "./quality-support.ts";
import { objectValue } from "../scripts/quality-policy.ts";

const registration = {
	"approved.ts": "export { test as approved } from 'node:test';\n",
	"unrelated.ts":
		"export async function test(): Promise<void> { /* Ordinary application task. */ }\n",
	"node_modules/@quality/unrelated/package.json": JSON.stringify({
		name: "@quality/unrelated",
		version: "1.0.0",
		types: "index.d.ts",
	}),
	"node_modules/@quality/unrelated/index.d.ts": "export function test(): Promise<void>;\n",
	"calls.ts": [
		"import native from 'node:test';",
		"import { test as foreign } from './unrelated.js';",
		"import { test as packaged } from '@quality/unrelated';",
		"import { approved } from './approved.js';",
		"native('registered', () => { /* node:test owns registration failures. */ });",
		"approved('reexported', () => { /* Same original registration declaration. */ });",
		"async function test(): Promise<void> { /* Local ordinary asynchronous work. */ }",
		"test();",
		"foreign();",
		"packaged();",
		"{ const native = foreign; native(); }",
		"async function ordinary(): Promise<void> { /* Independent work. */ }",
		"ordinary();",
		"native('subtests', async (context) => {",
		"context.test('unawaited', () => { /* Subtests must be awaited. */ });",
		"});",
	].join("\n"),
};

await test("node:test safe calls retain declaration identity, aliases and nearby Promise ownership", () => {
	const findings = lintFixture({ files: registration, paths: ["calls.ts"] });
	assert.deepEqual(findings, [
		{ code: "eslint/no-shadow", file: "calls.ts", line: 11 },
		...[8, 9, 10, 11, 13, 15].map((line) => ({
			code: "typescript/no-floating-promises",
			file: "calls.ts",
			line,
		})),
	]);
});

await test("wrong-package configuration removes the real registration allowance", () => {
	assert.ok(objectValue(policy.rules));
	const configured = policy.rules["typescript/no-floating-promises"];
	assert.ok(Array.isArray(configured) && objectValue(configured[1]));
	const options = configured[1];
	const findings = lintFixture({
		files: registration,
		paths: ["calls.ts"],
		rules: {
			"typescript/no-floating-promises": [
				"error",
				{
					...options,
					allowForKnownSafeCalls: [
						{ from: "package", package: "@quality/unrelated", name: ["test"] },
					],
				},
			],
		},
	});
	assert.deepEqual(findings, [
		{ code: "eslint/no-shadow", file: "calls.ts", line: 11 },
		...[5, 6, 8, 9, 11, 13, 14, 15].map((line) => ({
			code: "typescript/no-floating-promises",
			file: "calls.ts",
			line,
		})),
	]);
});

const codingAgent = [
	"ExtensionAPI",
	"ExtensionContext",
	"ExtensionFactory",
	"ExtensionRuntime",
	"Extension",
	"TurnEndEvent",
	"Theme",
];
const tui = ["Component", "TUI"];

await test("native Pi, TUI and compiler input allowances exclude local and unrelated package names", () => {
	const sdk = [...codingAgent, ...tui, "Node", "ReadonlySessionManager"];
	const imports = `import type { ${codingAgent.map((name) => `${name} as Native${name}`).join(", ")} } from '@earendil-works/pi-coding-agent';\nimport type { ${tui.map((name) => `${name} as Native${name}`).join(", ")} } from '@earendil-works/pi-tui';\nimport type { Node as NativeNode } from 'typescript/unstable/ast';\ntype NativeReadonlySessionManager = NativeExtensionContext['sessionManager'];\n`;
	const accepted = sdk
		.map(
			(name) =>
				`export function accept${name}(value: Native${name}): Native${name} { return value; }`,
		)
		.join("\n");
	const rejected = sdk
		.map(
			(name) =>
				`type ${name} = { value: number };\nexport function reject${name}(value: ${name}): number { return value.value; }`,
		)
		.join("\n");
	const files = { "origins.ts": imports + accepted + "\n" + rejected + "\n" };
	expectFindings(
		{ files },
		sdk.map((_name, index) => ({
			code: "typescript/prefer-readonly-parameter-types",
			file: "origins.ts",
			line: 4 + sdk.length + index * 2 + 2,
		})),
	);
});
