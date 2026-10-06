import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { objectValue } from "../scripts/quality-policy.ts";
import { ruleCases } from "./quality-rule-cases.ts";
import { optionCases } from "./quality-rule-options.ts";
import { expectFindings, fixture, repository, type Finding } from "./quality-support.ts";

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

test("readonly application contracts expose only the read capabilities they need", () => {
	expectFindings(
		{
			files: {
				"pass.ts":
					"export function value(input: { readonly get: (key: string) => number | undefined }): number { return input.get('key') ?? 0; }",
			},
		},
		[],
	);
});

test("native readonly collections check keys, values, mapped mutators and attached application state", () => {
	const accepted = [
		"ReadonlyMap<string, number>",
		"ReadonlySet<number>",
		"ReadonlyMap<string, () => void>",
		"ReadonlyMap<{ readonly key: number }, { readonly count: number }>",
		"ReadonlySet<{ readonly count: number }>",
		"Readonly<ReadonlyMap<string, number>>",
		"Readonly<ReadonlySet<number>>",
		"ReadonlyMap<string, number> & { readonly counter: number }",
		"Readonly<Pick<Map<string, number>, 'get' | 'size'>>",
		"Readonly<Pick<Set<number>, 'has' | 'size'>>",
		"Pick<ReadonlyMap<string, number>, 'values' | 'size'>",
		"Pick<ReadonlyMap<string, { readonly count: number }>, 'entries' | 'forEach' | 'size'>",
		"Pick<ReadonlySet<{ readonly count: number }>, 'values' | 'size'>",
		"Pick<ReadonlyMap<string, { count: number }>, 'size'>",
		"Pick<ReadonlySet<{ count: number }>, 'size'>",
		"Pick<ReadonlySet<{ readonly count: number }>, 'union' | 'intersection' | 'difference' | 'symmetricDifference' | 'size'>",
		"Partial<ReadonlyMap<string, number>>",
		"Partial<ReadonlySet<string>>",
		"Partial<Pick<ReadonlyMap<string, { readonly count: number }>, 'values' | 'size'>>",
		"Readonly<Partial<Pick<Map<string, number>, 'get' | 'has' | 'size'>>>",
		"Readonly<Partial<Pick<Set<number>, 'has' | 'size'>>>",
		"Pick<ReadonlySet<{ readonly count: number }>, 'isSubsetOf' | 'isDisjointFrom' | 'size'>",
		"Pick<ReadonlySet<{ count: number }>, 'isSupersetOf' | 'size'>",
	];
	const rejected = [
		"Map<string, number>",
		"Set<number>",
		"Readonly<Map<string, number>>",
		"Readonly<Set<number>>",
		"ReadonlyMap<string, { count: number }>",
		"ReadonlyMap<{ key: number }, number>",
		"ReadonlySet<{ count: number }>",
		"Readonly<ReadonlyMap<string, { count: number }>>",
		"Readonly<ReadonlySet<{ count: number }>>",
		"ReadonlyMap<string, (() => void) & { counter: number }>",
		"ReadonlyMap<string, number> & { counter: number }",
		"ReadonlySet<number> & { counter: number }",
		"Readonly<Pick<Map<string, number>, 'get' | 'set' | 'size'>>",
		"Readonly<Pick<Map<string, { count: number }>, 'get' | 'size'>>",
		"Pick<ReadonlyMap<string, { count: number }>, 'values' | 'size'>",
		"Pick<ReadonlySet<{ count: number }>, 'values' | 'size'>",
		"Pick<ReadonlyMap<string, { count: number }>, 'forEach' | 'size'>",
		"Omit<ReadonlyMap<string, { count: number }>, 'get'>",
		"Pick<ReadonlyMap<{ key: number }, number>, 'entries' | 'size'>",
		"Pick<ReadonlyMap<{ key: number }, number>, 'keys' | 'size'>",
		"Pick<ReadonlyMap<{ key: number }, number>, 'forEach' | 'size'>",
		"Pick<ReadonlyMap<string, { count: number }>, typeof Symbol.iterator | 'size'>",
		"Pick<ReadonlySet<{ count: number }>, typeof Symbol.iterator | 'size'>",
		"Pick<ReadonlyMap<string, [number, number]>, 'values' | 'size'>",
		"Pick<ReadonlyMap<string, readonly [number, { count: number }]>, 'values' | 'size'>",
		"Pick<ReadonlySet<{ count: number }>, 'union' | 'size'>",
		"Pick<ReadonlySet<{ count: number }>, 'intersection' | 'size'>",
		"Pick<ReadonlySet<{ count: number }>, 'difference' | 'size'>",
		"Pick<ReadonlySet<{ count: number }>, 'symmetricDifference' | 'size'>",
		"Partial<ReadonlyMap<string, { count: number }>>",
		"Partial<ReadonlySet<{ count: number }>>",
		"Partial<Pick<ReadonlyMap<string, { count: number }>, 'values' | 'size'>>",
		"Readonly<Partial<Pick<Map<string, { count: number }>, 'get' | 'has' | 'size'>>>",
		"Pick<ReadonlySet<{ count: number }>, 'isSubsetOf' | 'size'>",
		"Pick<ReadonlySet<{ count: number }>, 'isDisjointFrom' | 'size'>",
		"Pick<Map<string, number>, 'get' | 'size'>",
		"Partial<Pick<Map<string, number>, 'get' | 'size'>>",
		"Pick<Set<number>, 'has' | 'size'>",
		"Partial<Pick<Set<number>, 'has' | 'size'>>",
		"Readonly<Partial<Map<string, number>>>",
		"Readonly<Partial<Set<number>>>",
	];
	const source = (types: readonly string[]) =>
		types
			.map(
				(type, index) =>
					`export function lookup${index}(input: ${type}): number { return input.size${type.includes("Partial<") ? " ?? 0" : ""}; }`,
			)
			.join("\n");
	const arrayTypes = [
		{ type: "readonly number[]", mutable: false },
		{ type: "readonly { readonly count: number }[]", mutable: false },
		{ type: "Pick<readonly number[], 'map' | 'length'>", mutable: false },
		{ type: "Partial<Pick<readonly number[], 'map'>>", mutable: false },
		{ type: "readonly { count: number }[]", mutable: true },
		{ type: "Pick<readonly { count: number }[], 'map' | 'length'>", mutable: true },
		{ type: "Partial<Pick<readonly { count: number }[], 'map'>>", mutable: true },
	];
	expectFindings(
		{
			files: {
				"pass.ts": source(accepted),
				"fail.ts": source(rejected),
				"mixed.ts":
					"interface Mixed extends Pick<ReadonlyMap<string, number>, 'get'>, Pick<ReadonlyMap<string, { count: number }>, 'values' | 'size'> {} export function value(input: Mixed): number { return input.size; }",
				"node_modules/@quality/methods/package.json": JSON.stringify({
					name: "@quality/methods",
					type: "module",
					exports: "./index.d.ts",
				}),
				"node_modules/@quality/methods/index.d.ts":
					"export interface Mutable { get(): number; }",
				"methods.ts": [
					"import type { Mutable } from '@quality/methods';",
					"export function replace(input: Partial<Pick<Mutable, 'get'>>): void { const view = input; view.get = () => 123; }",
					"export function read(input: Readonly<Partial<Pick<Mutable, 'get'>>>): number { return input.get?.() ?? 0; }",
				].join("\n"),
				"array-views.ts": arrayTypes
					.map(
						({ type }, index) =>
							`export function view${index}(input: ${type}): unknown { return input; }`,
					)
					.join("\n"),
				"flatmap.ts": [
					"export function read(input: readonly number[]): readonly number[] { return input.flatMap((value) => [value]); }",
					"export function mutate(input: readonly number[]): readonly number[] { return input.flatMap((value, _index, array) => { const original = array; original.push(value); return [value]; }); }",
					"export const mutable = [1, 2].flatMap((value, _index, array) => { const original = array; original.push(value); return [value]; });",
				].join("\n"),
			},
		},
		[
			...rejected.map((_type, index) => ({
				code: "typescript/prefer-readonly-parameter-types",
				file: "fail.ts",
				line: index + 1,
			})),
			{ code: "typescript/prefer-readonly-parameter-types", file: "mixed.ts", line: 1 },
			{ code: "typescript/prefer-readonly-parameter-types", file: "methods.ts", line: 2 },
			...arrayTypes.flatMap(({ mutable }, index) =>
				mutable
					? [
							{
								code: "typescript/prefer-readonly-parameter-types",
								file: "array-views.ts",
								line: index + 1,
							},
						]
					: [],
			),
			{ code: "typescript/TS2339", file: "flatmap.ts", line: 2 },
			{ code: "typescript/no-unsafe-call", file: "flatmap.ts", line: 2 },
		],
	);
});

test("application types named like native readonly containers retain mutation checks", () => {
	expectFindings(
		{
			files: {
				"fail.ts":
					"export interface ReadonlyMap<K, V> { values: [K, V][] } export function value(input: ReadonlyMap<string, number>): number { return input.values.length; }",
			},
		},
		[{ code: "typescript/prefer-readonly-parameter-types", file: "fail.ts", line: 1 }],
	);
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
	expectFindings(
		{
			files: {
				"a.ts": "export async function a(): Promise<number> { const { b } = await import('./b.ts'); return b(); }",
				"b.ts": "import { a } from './a.ts'; export async function b(): Promise<number> { return a(); }",
			},
		},
		[
			{ code: "import/no-cycle", file: "a.ts", line: 1 },
			{ code: "import/no-cycle", file: "b.ts", line: 1 },
		],
	);
	const wrappedImports = [
		{ source: "('./b.ts')", additionalRules: [] },
		{ source: "(`./b.ts`)", additionalRules: [] },
		{ source: "('./b.ts' as const)", additionalRules: [] },
		{
			source: "(<string>'./b.ts')",
			additionalRules: [
				"typescript/consistent-type-assertions",
				"typescript/no-unnecessary-type-assertion",
			],
		},
		{
			source: "('./b.ts'!)",
			additionalRules: [
				"typescript/no-non-null-assertion",
				"typescript/no-unnecessary-type-assertion",
			],
		},
	];
	for (const example of wrappedImports) {
		expectFindings(
			{
				files: {
					"a.ts": `export async function a(): Promise<void> { await import(${example.source}); }`,
					"b.ts": "import { a } from './a.ts'; export async function b(): Promise<void> { return a(); }",
				},
			},
			[
				{ code: "import/no-cycle", file: "a.ts", line: 1 },
				{ code: "import/no-cycle", file: "b.ts", line: 1 },
				...example.additionalRules.map((code) => ({ code, file: "a.ts", line: 1 })),
			],
		);
	}
	expectFindings(
		{
			files: {
				"external.ts":
					"import { foreign } from '@quality/cycle'; export function external(): number { return foreign(); }",
				"node_modules/@quality/cycle/package.json": JSON.stringify({
					name: "@quality/cycle",
					version: "1.0.0",
					type: "module",
					exports: "./index.ts",
				}),
				"node_modules/@quality/cycle/index.ts":
					"import { external } from '../../../external.ts'; export function foreign(): number { return external(); }",
			},
			paths: ["external.ts"],
		},
		[{ code: "import/no-cycle", file: "external.ts", line: 1 }],
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

test("normal lint fixes cannot manufacture unknown contracts from explicit any", () => {
	const text = "export type Value = any;";
	const project = fixture({ files: { "fail.ts": text } });
	try {
		const result = spawnSync(
			join(repository, "node_modules/.bin/oxlint"),
			["--fix", "--format=json", "fail.ts"],
			{ cwd: project.root, encoding: "utf8", timeout: 30_000 },
		);
		assert.equal(result.error, undefined);
		assert.equal(result.signal, null);
		assert.equal(result.stderr, "");
		assert.equal(result.status, 1);
		const output: unknown = JSON.parse(result.stdout);
		assert.ok(objectValue(output) && Array.isArray(output.diagnostics));
		const locations = output.diagnostics.map((value: unknown) => {
			assert.ok(objectValue(value) && Array.isArray(value.labels));
			const label: unknown = value.labels[0];
			assert.ok(objectValue(label) && objectValue(label.span));
			return { code: value.code, file: value.filename, line: label.span.line };
		});
		assert.deepEqual(locations, [
			{ code: "typescript(no-explicit-any)", file: "fail.ts", line: 1 },
		]);
		assert.equal(readFileSync(join(project.root, "fail.ts"), "utf8"), text);
	} finally {
		project.dispose();
	}
});
