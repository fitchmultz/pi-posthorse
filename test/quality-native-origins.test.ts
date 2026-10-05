import assert from "node:assert/strict";
import test from "node:test";
import { expectFindings, policy } from "./quality-support.ts";
import { objectValue } from "../scripts/quality-policy.ts";

function libraryNames(): readonly string[] {
	assert.ok(objectValue(policy.rules));
	const rule = policy.rules["typescript/prefer-readonly-parameter-types"];
	assert.ok(Array.isArray(rule) && objectValue(rule[1]) && Array.isArray(rule[1].allow));
	const entries: readonly unknown[] = rule[1].allow;
	const library = entries.find((entry) => objectValue(entry) && entry.from === "lib");
	assert.ok(objectValue(library) && Array.isArray(library.name));
	const names: readonly unknown[] = library.name;
	return names.map((name) => {
		assert.equal(typeof name, "string");
		if (typeof name !== "string") {
			throw new Error("Native names must be explicit strings");
		}
		return name;
	});
}

await test("every configured native-library input allowance excludes mutable application names", () => {
	const names = libraryNames();
	const generic = new Set([
		"Promise",
		"PromiseLike",
		"ReadableStreamDefaultReader",
		"WritableStreamDefaultWriter",
	]);
	const natives = names
		.map(
			(name) =>
				`export function accept${name}(value: ${name}${generic.has(name) ? "<unknown>" : ""}): unknown { return value; }`,
		)
		.join("\n");
	const impostors = names
		.map(
			(name) =>
				`type ${name} = { state: number };\nexport function reject${name}(value: ${name}): number { return value.state; }`,
		)
		.join("\n");
	expectFindings(
		{ files: { "natives.ts": natives, "impostors.ts": impostors } },
		names.map((_name, index) => ({
			code: "typescript/prefer-readonly-parameter-types",
			file: "impostors.ts",
			line: index * 2 + 2,
		})),
	);
});

await test("SDK allowances cannot transfer to matching types from another installed package", () => {
	const names = ["ExtensionAPI", "ExtensionContext", "Theme", "Component", "Node"];
	const declarations = names
		.map((name) => `export interface ${name} { state: number; }`)
		.join("\n");
	const inputs = names
		.map(
			(name) =>
				`export function reject${name}(value: ${name}): number { return value.state; }`,
		)
		.join("\n");
	expectFindings(
		{
			files: {
				"node_modules/@quality/impostor/package.json": JSON.stringify({
					name: "@quality/impostor",
					version: "1.0.0",
					types: "index.d.ts",
				}),
				"node_modules/@quality/impostor/index.d.ts": declarations,
				"foreign.ts": `import type { ${names.join(", ")} } from '@quality/impostor';\n${inputs}`,
			},
			paths: ["foreign.ts"],
		},
		names.map((_name, index) => ({
			code: "typescript/prefer-readonly-parameter-types",
			file: "foreign.ts",
			line: index + 2,
		})),
	);
});

await test("native handles cannot hide mutable attached or nested application-owned state", () => {
	expectFindings(
		{
			files: {
				"owned.ts": [
					"import type { Theme } from '@earendil-works/pi-coding-agent';",
					"export function native(value: Theme): Theme { return value; }",
					"export function owned(value: Readonly<{ handle: Theme; counter: number }>): number { return value.counter; }",
					"export function nested(value: Readonly<{ handle: Theme; nested: { count: number } }>): number { return value.nested.count; }",
					"export function attached(value: Theme & { counter: number }): number { return value.counter; }",
					"export function readonlyAttached(value: Theme & { readonly counter: number }): number { return value.counter; }",
				].join("\n"),
			},
		},
		[4, 5].map((line) => ({
			code: "typescript/prefer-readonly-parameter-types",
			file: "owned.ts",
			line,
		})),
	);
});
