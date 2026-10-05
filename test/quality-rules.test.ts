import assert from "node:assert/strict";
import test from "node:test";
import { ruleCases } from "./quality-rule-cases.ts";
import { optionCases } from "./quality-rule-options.ts";
import { expectFindings, lintFixture, type Finding } from "./quality-support.ts";

for (const example of [...ruleCases, ...optionCases]) {
	test(`configured rule boundary: ${example.name}`, () => {
		expectFindings({ compiler: { types: ["node"] }, files: { "pass.ts": example.pass } }, []);
		const expected = example.rules.map((code) => ({
			code,
			file: "fail.ts",
			line: example.name === "deprecated declarations" ? 3 : 1,
		}));
		expectFindings(
			{ compiler: { types: ["node"] }, files: { "fail.ts": example.fail } },
			expected,
		);
	});
}

function branches(count: number): string {
	return `export function choose(input: number): number {\n${Array.from({ length: count }, (_, index) => `if (input > ${index}) { return ${index}; }`).join("\n")}\nreturn -1;\n}`;
}

function parameters(count: number): string {
	const names = Array.from({ length: count }, (_, index) => `p${index}`);
	return `export function sum(${names.map((name) => `${name}: number`).join(",")}): number { return ${names.join("+")}; }`;
}

function nesting(count: number): string {
	return `export function choose(input: number): number {\n${Array.from({ length: count }, (_, index) => `if (input > ${index}) {`).join("\n")}\nreturn 1;\n${"}\n".repeat(count)}return 0;\n}`;
}

function statements(count: number): string {
	return `export function count(): number {\nlet value = 0;\n${"value += 1;\n".repeat(count - 2)}return value;\n}`;
}

function functionLines(count: number): string {
	return `export function values(): readonly number[] {\nreturn [\n${"1,\n".repeat(count - 4)}];\n}`;
}

function fileLines(count: number): string {
	return Array.from(
		{ length: count },
		(_, index) => `export const value${index} = ${index};`,
	).join("\n");
}

const structuralCases = [
	{
		name: "modified production complexity",
		code: "eslint/complexity",
		pass: branches(9),
		fail: branches(10),
	},
	{ name: "production nesting", code: "eslint/max-depth", pass: nesting(3), fail: nesting(4) },
	{
		name: "production parameter count",
		code: "eslint/max-params",
		pass: parameters(4),
		fail: parameters(5),
	},
	{
		name: "production statements",
		code: "eslint/max-statements",
		pass: statements(40),
		fail: statements(41),
	},
	{
		name: "production function lines",
		code: "eslint/max-lines-per-function",
		pass: functionLines(80),
		fail: functionLines(81),
	},
	{
		name: "production file lines",
		code: "eslint/max-lines",
		pass: fileLines(500),
		fail: fileLines(501),
	},
];

for (const example of structuralCases) {
	test(`configured structural boundary: ${example.name}`, () => {
		expectFindings({ compiler: { types: ["node"] }, files: { "pass.ts": example.pass } }, []);
		const specialLocations: Readonly<Record<string, number>> = {
			"eslint/max-depth": 5,
			"eslint/max-lines": 501,
		};
		const expectedLine = specialLocations[example.code] ?? 1;
		expectFindings({ compiler: { types: ["node"] }, files: { "fail.ts": example.fail } }, [
			{ code: example.code, file: "fail.ts", line: expectedLine },
		]);
	});
}

test("test role retains branching and parameter limits while exempting size", () => {
	expectFindings({ files: { "pass.test.ts": branches(14) } }, []);
	expectFindings({ files: { "fail.test.ts": branches(15) } }, [
		{ code: "eslint/complexity", file: "fail.test.ts", line: 1 },
	]);
	expectFindings({ files: { "pass.test.ts": nesting(4) } }, []);
	expectFindings({ files: { "fail.test.ts": nesting(5) } }, [
		{ code: "eslint/max-depth", file: "fail.test.ts", line: 6 },
	]);
	expectFindings({ files: { "pass.test.ts": parameters(6) } }, []);
	expectFindings({ files: { "fail.test.ts": parameters(7) } }, [
		{ code: "eslint/max-params", file: "fail.test.ts", line: 1 },
	]);
	expectFindings(
		{
			files: {
				"large.test.ts": `${statements(100)}\n${fileLines(501)}\n${functionLines(100).replace("values", "manyValues")}`,
			},
		},
		[],
	);
});

test("modified complexity counts one switch rather than every case", () => {
	const cases = Array.from({ length: 20 }, (_, index) => `case ${index}: return ${index};`).join(
		"\n",
	);
	expectFindings(
		{
			files: {
				"switch.ts": `export function choose(input: number): number { switch (input) {\n${cases}\ndefault: return -1;\n} }`,
			},
		},
		[],
	);
});

test("declaration files retain API safety without structural metrics", () => {
	expectFindings(
		{
			files: {
				"boundary.d.ts":
					"export declare function call(a: number, b: number, c: number, d: number, e: number, f: number, g: number): number;",
			},
		},
		[],
	);
	expectFindings({ files: { "boundary.d.ts": "export interface Boundary { call(): void; }" } }, [
		{ code: "typescript/method-signature-style", file: "boundary.d.ts", line: 1 },
	]);
});

test("readonly application contracts do not allow mutable maps or nested values", () => {
	expectFindings(
		{
			files: {
				"pass.ts":
					"export function value(input: { readonly get: (key: string) => number | undefined }): number { return input.get('key') ?? 0; }",
			},
		},
		[],
	);
	expectFindings(
		{
			files: {
				"fail.ts":
					"export function value(input: Map<string, number>): number { return input.size; }",
			},
		},
		[{ code: "typescript/prefer-readonly-parameter-types", file: "fail.ts", line: 1 }],
	);
	expectFindings(
		{
			files: {
				"fail.ts":
					"export function value(input: ReadonlyMap<string, { count: number }>): number { return input.size; }",
			},
		},
		[{ code: "typescript/prefer-readonly-parameter-types", file: "fail.ts", line: 1 }],
	);
});

test("readonly map checker reproducers remain unsuppressed for upgrade review", () => {
	// The installed checker misclassifies even primitive ReadonlyMap values. Keep the
	// unsuppressed reproductions; a fixed upgrade must update this evidence, not allow Map.
	const findings = lintFixture({
		files: {
			"primitive-repro.ts":
				"export function lookup(input: ReadonlyMap<string, number>): number { return input.size; }",
			"callback-repro.ts":
				"export function lookup(input: ReadonlyMap<string, () => void>): number { return input.size; }",
		},
	});
	assert.deepEqual(findings.map(({ code, file, line }) => `${file}:${line}:${code}`).toSorted(), [
		"callback-repro.ts:1:typescript/prefer-readonly-parameter-types",
		"primitive-repro.ts:1:typescript/prefer-readonly-parameter-types",
	]);
});

test("nullable object presence checks and genuine void shorthand remain permitted", () => {
	expectFindings(
		{
			files: {
				"presence.ts":
					"export function value(input: { readonly count: number } | undefined): number { if (input) { return input.count; } return 0; }",
				"void.ts": "export const value: () => void = () => console.log('done');",
			},
		},
		[],
	);
});

test("async interfaces may complete immediately and caught failures retain identity", () => {
	expectFindings(
		{
			files: {
				"pass.ts":
					"export async function value(): Promise<number> { return 1; } export function propagate(): void { try { console.log('done'); } catch (error) { console.log('failed'); throw error; } }",
			},
		},
		[],
	);
});

test("sequencing is forbidden without a documented exception", () => {
	expectFindings(
		{
			files: {
				"fail.ts":
					"export async function value(input: readonly number[]): Promise<void> {\nfor (const item of input) {\nawait Promise.resolve(item);\n}\n}",
			},
		},
		[{ code: "eslint/no-await-in-loop", file: "fail.ts", line: 3 }],
	);
	expectFindings(
		{
			files: {
				"pass.ts":
					"export async function value(input: readonly number[]): Promise<void> {\nfor (const item of input) {\n// Each commit must finish before the next journal record.\n// oxlint-disable-next-line no-await-in-loop\nawait Promise.resolve(item);\n}\n}",
			},
		},
		[],
	);
});

test("terminal Promise callbacks may be void but interior callbacks must return", () => {
	expectFindings(
		{
			compiler: { types: ["node"] },
			files: {
				"pass.ts":
					"export async function value(): Promise<void> { await Promise.resolve(1).then((input) => { console.log(input); }); }",
			},
		},
		[],
	);
	expectFindings(
		{
			compiler: { types: ["node"] },
			files: {
				"fail.ts":
					"export async function value(): Promise<void> { await Promise.resolve(1).then((input) => { console.log(input); }).then(() => 1); }",
			},
		},
		[{ code: "promise/always-return", file: "fail.ts", line: 1 }],
	);
});

test("redundant catch rethrows remain detectable", () => {
	expectFindings(
		{
			files: {
				"fail.ts":
					"export function value(): number { try { return Number('1'); } catch (error) { throw error; } }",
			},
		},
		[{ code: "eslint/no-useless-catch", file: "fail.ts", line: 1 }],
	);
});

test("local sort and reverse stay allowed while void generic contracts stay real", () => {
	expectFindings(
		{
			files: {
				"pass.ts":
					"export const sorted = [2, 1].sort((a, b) => a - b); export const reversed = [1, 2].reverse(); export const pending: PromiseWithResolvers<void> = Promise.withResolvers();",
			},
		},
		[],
	);
});

test("dynamic execution constructs remain forbidden", () => {
	expectFindings(
		{
			files: {
				"fail.ts": "export function value(input: string): unknown { return eval(input); }",
			},
		},
		[{ code: "eslint/no-eval", file: "fail.ts", line: 1 }],
	);
	expectFindings({ files: { "fail.ts": "export const value = new Function('return 1');" } }, [
		{ code: "eslint/no-new-func", file: "fail.ts", line: 1 },
		{ code: "typescript/no-implied-eval", file: "fail.ts", line: 1 },
	]);
});

test("type imports and exports preserve runtime module contracts", () => {
	expectFindings(
		{
			compiler: { types: ["node"] },
			files: {
				"pass.ts": "import type { Stats } from 'node:fs'; export type Value = Stats;",
				"fail.ts": "import { Stats } from 'node:fs'; export type Value = Stats;",
			},
		},
		[{ code: "typescript/consistent-type-imports", file: "fail.ts", line: 1 }],
	);
	expectFindings(
		{
			compiler: { types: ["node"] },
			files: {
				"pass.ts": "interface Value { readonly count: number } export type { Value };",
				"fail.ts": "interface Value { readonly count: number } export { Value };",
			},
		},
		[{ code: "typescript/consistent-type-exports", file: "fail.ts", line: 1 }],
	);
});

test("duplicate and self imports remain detectable", () => {
	expectFindings(
		{
			compiler: { types: ["node"] },
			files: {
				"fail.ts":
					"import { basename } from 'node:path'; import { dirname } from 'node:path'; export const value = basename('path') + dirname('path');",
			},
		},
		[{ code: "import/no-duplicates", file: "fail.ts", line: 1 }],
	);
	expectFindings({ files: { "fail.ts": "import './fail.ts'; export const value = 1;" } }, [
		{ code: "import/no-self-import", file: "fail.ts", line: 1 },
		{ code: "import/no-cycle", file: "fail.ts", line: 1 },
		{ code: "import/no-unassigned-import", file: "fail.ts", line: 1 },
	]);
});

test("runtime dependency cycles remain detectable in both modules", () => {
	expectFindings(
		{
			files: {
				"a.ts": "import { b } from './b.ts'; export function a(): string { return b(); }",
				"b.ts": "import { a } from './a.ts'; export function b(): string { return a(); }",
			},
		},
		[
			{ code: "import/no-cycle", file: "a.ts", line: 1 },
			{ code: "import/no-cycle", file: "b.ts", line: 1 },
		],
	);
});

test("type-only cycles are not exempt from import boundaries", () => {
	expectFindings(
		{
			files: {
				"a.ts": "import type { B } from './b.ts'; export interface A { readonly b: B }",
				"b.ts": "import type { A } from './a.ts'; export interface B { readonly a: A }",
			},
		},
		[
			{ code: "import/no-cycle", file: "a.ts", line: 1 },
			{ code: "import/no-cycle", file: "b.ts", line: 1 },
		],
	);
});

test("string timer callbacks are implied evaluation", () => {
	expectFindings(
		{
			compiler: { types: ["node"] },
			files: { "pass.ts": "export const timer = setTimeout(() => { console.log(1); }, 1);" },
		},
		[],
	);
	expectFindings(
		{
			compiler: { types: ["node"] },
			files: { "fail.ts": "export const timer = setTimeout('console.log(1)', 1);" },
		},
		[{ code: "typescript/no-implied-eval", file: "fail.ts", line: 1 }],
	);
});

test("allowed scalar interpolation and contextual void contracts stay valid", () => {
	expectFindings(
		{
			files: {
				"pass.ts":
					"export function value(input: boolean, count: number): string { return `value: ${input}, count: ${count}`; } export function noContext(this: void): void { console.log('done'); }",
			},
		},
		[],
	);
});

test("generic callback results retain their actual contract without artificial readonly wrappers", () => {
	expectFindings(
		{
			files: {
				"pass.ts":
					"export function invoke<T>(operation: () => T): T { return operation(); }",
				"fail.ts":
					"export function invoke<T>(operation: () => T): T { console.log(JSON.parse('null').name); return operation(); }",
			},
		},
		[{ code: "typescript/no-unsafe-member-access", file: "fail.ts", line: 1 }],
	);
});

test("inferred callback inputs do not waive parameter-property mutation protection", () => {
	expectFindings(
		{
			files: {
				"pass.ts": "export const values = [{ count: 1 }].map((item) => item.count);",
				"fail.ts":
					"export const values = [{ count: 1 }].map((item) => { item.count += 1; return item.count; });",
			},
		},
		[{ code: "eslint/no-param-reassign", file: "fail.ts", line: 1 }],
	);
});

test("native Promise executors deliberately discard timer handles using block bodies", () => {
	expectFindings(
		{
			compiler: { types: ["node"] },
			files: {
				"pass.ts":
					"export const work = new Promise<void>((resolve) => { setTimeout(resolve, 1); });",
				"fail.ts":
					"export const work = new Promise<void>((resolve) => setTimeout(resolve, 1));",
			},
		},
		[{ code: "typescript/strict-void-return", file: "fail.ts", line: 1 }],
	);
});

test("PromiseLike values have readonly permission but no floating-Promise exemption", () => {
	expectFindings(
		{
			files: {
				"pass.ts":
					"export declare const work: PromiseLike<number>; export async function value(): Promise<number> { return await work; }",
				"fail.ts":
					"export declare const work: PromiseLike<number>; export function value(): void { work; }",
			},
		},
		[
			{ code: "typescript/no-floating-promises", file: "fail.ts", line: 1 },
			{ code: "eslint/no-unused-expressions", file: "fail.ts", line: 1 },
		],
	);
});

test("argument-presence and undefined-return exceptions stay in exact boundary files", () => {
	const argumentsCase = "export const value = JSON.stringify(1, undefined);";
	const arrowCase = "export const value: () => undefined = () => undefined;";
	const expected: readonly Finding[] = [
		{ code: "unicorn/no-useless-undefined", file: "ordinary.test.ts", line: 1 },
	];
	expectFindings({ files: { "ordinary.test.ts": argumentsCase } }, expected);
	expectFindings({ files: { "ordinary.test.ts": arrowCase } }, expected);
	expectFindings(
		{ files: { "test/posthorse.test.ts": argumentsCase, "test/renderers.test.ts": arrowCase } },
		[],
	);
});
