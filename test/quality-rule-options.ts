import type { RuleCase } from "./quality-rule-cases.ts";

export const optionCases: readonly RuleCase[] = [
	{
		name: "any truthiness cannot bypass boolean intent",
		pass: "export function value(input: unknown): boolean { return input === true; }",
		fail: "export function value(input: any): boolean { if (input) { return true; } return false; }",
		rules: [
			"typescript/no-explicit-any",
			"typescript/strict-boolean-expressions",
			"typescript/explicit-module-boundary-types",
		],
	},
	{
		name: "nullable enum truthiness cannot conflate zero and absence",
		pass: "export enum Value { Empty, Full } export function value(input: Value | undefined): boolean { return input !== undefined; }",
		fail: "export enum Value { Empty, Full } export function value(input: Value | undefined): boolean { if (input) { return true; } return false; }",
		rules: ["typescript/strict-boolean-expressions"],
	},
	{
		name: "method declarations do not imply readonly properties",
		pass: "export function value(input: { readonly read: () => number }): number { return input.read(); }",
		fail: "export function value(input: { read(): number }): number { return input.read(); }",
		rules: ["typescript/method-signature-style"],
	},
	{
		name: "mixed plus compound assignment remains checked",
		pass: "export function value(input: number): string { let text = ''; text += String(input); return text; }",
		fail: "export function value(input: number): string { let text = ''; text += input; return text; }",
		rules: ["typescript/restrict-plus-operands"],
	},
	{
		name: "boolean plus remains unsafe",
		pass: "export function value(input: boolean): string { return String(input) + ' value'; }",
		fail: "export function value(input: boolean): string { return input + ' value'; }",
		rules: ["typescript/restrict-plus-operands"],
	},
	{
		name: "nullish template interpolation remains checked",
		pass: "export function value(input: string | undefined): string { return `value: ${input ?? 'none'}`; }",
		fail: "export function value(input: string | undefined): string { return `value: ${input}`; }",
		rules: ["typescript/restrict-template-expressions"],
	},
	{
		name: "RegExp template interpolation remains checked",
		pass: "export const pattern = /x/u; export const value = `pattern: ${pattern.source}`;",
		fail: "export const pattern = /x/u; export const value = `pattern: ${pattern}`;",
		rules: ["typescript/restrict-template-expressions"],
	},
	{
		name: "unknown new throws differ from caught rethrows",
		pass: "export function value(input: unknown): never { throw new Error(typeof input === 'string' ? input : 'failed'); }",
		fail: "export function value(input: unknown): never { throw input; }",
		rules: ["typescript/only-throw-error"],
	},
	{
		name: "IIFE does not waive Promise ownership",
		pass: "export async function value(): Promise<void> { await (async (): Promise<number> => 1)(); }",
		fail: "export function value(): void { (async (): Promise<number> => 1)(); }",
		rules: ["typescript/no-floating-promises"],
	},
];
