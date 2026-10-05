import assert from "node:assert/strict";
import test from "node:test";
import { expectFindings, policy } from "./quality-support.ts";
import { objectValue } from "../scripts/quality-policy.ts";

const files = {
	"approved.ts":
		"export async function register(): Promise<void> { /* Framework-owned registration. */ }\n",
	"foreign.ts":
		"export async function register(): Promise<void> { /* Unrelated application task. */ }\n",
	"exports.ts": "export { register as renamed } from './approved.js';\n",
	"node_modules/@quality/foreign/package.json": JSON.stringify({
		name: "@quality/foreign",
		version: "1.0.0",
		types: "index.d.ts",
	}),
	"node_modules/@quality/foreign/index.d.ts": "export function register(): Promise<void>;\n",
	"calls.ts": [
		"import { register as approved } from './approved.js';",
		"import { register as foreign } from './foreign.js';",
		"import { register as packaged } from '@quality/foreign';",
		"import { renamed } from './exports.js';",
		"approved();",
		"renamed();",
		"async function register(): Promise<void> { /* Unrelated same-scope function. */ }",
		"register();",
		"foreign();",
		"packaged();",
		"{ const approved = foreign; approved(); }",
		"const laundered: typeof approved = foreign;",
		"laundered();",
		"const object = { register: approved };",
		"object.register();",
	].join("\n"),
};

function fileRule(path: string): Readonly<Record<string, unknown>> {
	assert.ok(objectValue(policy.rules));
	const rule = policy.rules["typescript/no-floating-promises"];
	assert.ok(Array.isArray(rule) && objectValue(rule[1]));
	return {
		"typescript/no-floating-promises": [
			"error",
			{ ...rule[1], allowForKnownSafeCalls: [{ from: "file", path, name: ["register"] }] },
		],
	};
}

await test("file-qualified safe calls use real declarations, not spelling or callable-type laundering", () => {
	expectFindings({ files, paths: ["calls.ts"], rules: fileRule("./approved.ts") }, [
		{ code: "eslint/no-shadow", file: "calls.ts", line: 11 },
		...[8, 9, 10, 11, 13, 15].map((line) => ({
			code: "typescript/no-floating-promises",
			file: "calls.ts",
			line,
		})),
	]);
});

await test("changing to another existing declaration file removes the original exemption", () => {
	expectFindings({ files, paths: ["calls.ts"], rules: fileRule("./foreign.ts") }, [
		{ code: "eslint/no-shadow", file: "calls.ts", line: 11 },
		...[5, 6, 8, 10, 11, 13, 15].map((line) => ({
			code: "typescript/no-floating-promises",
			file: "calls.ts",
			line,
		})),
	]);
});
