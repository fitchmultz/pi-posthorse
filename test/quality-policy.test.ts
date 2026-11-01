import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { checkPolicy } from "../scripts/quality-policy.ts";
import { inspectSuppressions } from "../scripts/quality-directives.ts";
import { sourcePolicies } from "../scripts/quality-source.ts";
import { expectFindings, fixture, repository } from "./quality-support.ts";

nodeTest("suppression policy reads actual comments, not strings, regexes or documentation", () => {
	const project = fixture({
		files: {
			"examples.ts": [
				"export const quoted = '🙂 // oxlint-disable';",
				"export const template = `/* @ts-nocheck */ ${'// eslint-disable'}`;",
				"export const regex = /[/*]oxlint-disable-next-line no-floating-promises/u;",
				"/** Documentation mentions oxlint-disable-next-line and @ts-ignore without applying either. */",
				"// @ts-nocheck",
				"/* oxlint-disable */",
				"// oxlint-disable-next-line typescript/no-floating-promises",
				"export const number = 1;",
			].join("\n"),
		},
	});
	try {
		const source = sourcePolicies(project.root, ["examples.ts"])[0];
		assert.ok(source);
		assert.deepEqual(inspectSuppressions(source).problems, [
			"examples.ts:5: compiler suppression is forbidden",
			"examples.ts:6: only one named next-line rule with QX identifier and reason is permitted",
			"examples.ts:7: only one named next-line rule with QX identifier and reason is permitted",
		]);
	} finally {
		project.dispose();
	}
});

nodeTest("suppression governance sees empty containers and punctuation gaps", async (t) => {
	for (const container of [
		"export const empty = { /* oxlint-disable eqeqeq */ };",
		"export const empty = [ /* oxlint-disable eqeqeq */ ];",
		"export function empty(): void { /* oxlint-disable eqeqeq */ }",
		"export const number = ( /* oxlint-disable eqeqeq */ 1 );",
		"export const first = 1; /* oxlint-disable eqeqeq */ export const second = 2;",
	]) {
		await t.test(container, async () => {
			const files = {
				"hidden.ts": `${container}\nexport function unsafe(n: number): boolean { return n == 1; }\n`,
			};
			await expectFindings({ files }, []);
			const project = fixture({ files });
			try {
				const source = sourcePolicies(project.root, ["hidden.ts"])[0];
				assert.ok(source);
				assert.deepEqual(inspectSuppressions(source).problems, [
					"hidden.ts:1: only one named next-line rule with QX identifier and reason is permitted",
				]);
			} finally {
				project.dispose();
			}
		});
	}
});

nodeTest("JSX text is not a directive, but JSX expression comments are", () => {
	const project = fixture({
		files: {
			"example.tsx": [
				"export const template = `🙂 /* oxlint-disable */`;",
				"export const view = <div>// oxlint-disable",
				"@ts-nocheck",
				"{/* oxlint-disable eqeqeq */}</div>;",
			].join("\n"),
		},
		compiler: { jsx: "preserve" },
	});
	try {
		const source = sourcePolicies(project.root, ["example.tsx"])[0];
		assert.ok(source);
		assert.deepEqual(inspectSuppressions(source).problems, [
			"example.tsx:4: only one named next-line rule with QX identifier and reason is permitted",
		]);
	} finally {
		project.dispose();
	}
});

function registration(
	name: string,
	directive = "max-params -- QX-002: Pi supplies five fixed positional tool arguments.",
): string {
	return [
		`pi.registerTool({ name: '${name}', label: 'Native', description: 'Native callback', parameters: Type.Object({}),`,
		`// oxlint-disable-next-line ${directive}`,
		"async execute(_id, _params, _signal, _onUpdate, _ctx) { return { content: [], details: {} }; },",
		"});",
	].join("\n");
}
function registrations(body: string, receiver = "NativeExtensionAPI"): string {
	return [
		"import type { ExtensionAPI as NativeExtensionAPI } from '@earendil-works/pi-coding-agent';",
		"import { Type } from 'typebox';",
		...(receiver === "LocalAPI"
			? ["interface LocalAPI { readonly registerTool: NativeExtensionAPI['registerTool']; }"]
			: []),
		`export function registerContextTools(pi: ${receiver}): void {`,
		body,
		"}",
	].join("\n");
}

nodeTest(
	"QX-002 binds the real declaration, file and operation, including replacement and duplication",
	async (t) => {
		const invalid = "unapproved exception file, rule, origin, or operation";
		const cases = [
			{
				name: "actual SDK operation",
				file: "src/context-tools.ts",
				body: registrations(registration("new_context")),
				expected: [],
			},
			{
				name: "structural same-signature receiver",
				file: "src/context-tools.ts",
				body: registrations(registration("new_context"), "LocalAPI"),
				expected: [`src/context-tools.ts:6: ${invalid}`],
			},
			{
				name: "copied file",
				file: "src/unrelated.ts",
				body: registrations(registration("new_context")),
				expected: [`src/unrelated.ts:5: ${invalid}`],
			},
			{
				name: "copied operation, unchanged count",
				file: "src/context-tools.ts",
				body: registrations(registration("other")),
				expected: [`src/context-tools.ts:5: ${invalid}`],
			},
			{
				name: "replacement rule, unchanged count",
				file: "src/context-tools.ts",
				body: registrations(
					registration(
						"new_context",
						"typescript/no-unsafe-assignment -- QX-002: A different rule cannot borrow the arity decision.",
					),
				),
				expected: [`src/context-tools.ts:5: ${invalid}`],
			},
			{
				name: "duplicate operation",
				file: "src/context-tools.ts",
				body: registrations(
					`${registration("new_context")}\n${registration("new_context")}`,
				),
				expected: ["src/context-tools.ts:9: duplicate exception operation"],
			},
		];
		for (const example of cases) {
			await t.test(example.name, () => {
				const project = fixture({ files: { [example.file]: example.body } });
				try {
					const source = sourcePolicies(project.root, [example.file])[0];
					assert.ok(source);
					assert.deepEqual(inspectSuppressions(source).problems, example.expected);
				} finally {
					project.dispose();
				}
			});
		}
	},
);

nodeTest("only described dedicated negative type tests may use expect-error", () => {
	const files = {
		"production.ts":
			"// @ts-expect-error: A string violates this numeric contract.\nexport const value: number = 'wrong';\n",
		"types.test-d.ts":
			"// @ts-expect-error: A string violates this numeric contract.\nexport const value: number = 'wrong';\n",
		"short.test-d.ts": "// @ts-expect-error short\nexport const value: number = 'wrong';\n",
	};
	const project = fixture({ files });
	try {
		assert.deepEqual(
			sourcePolicies(project.root, Object.keys(files)).flatMap(
				(source) => inspectSuppressions(source).problems,
			),
			[
				"production.ts:1: expected compiler errors belong in described dedicated .test-d.ts tests",
				"short.test-d.ts:1: expected compiler errors belong in described dedicated .test-d.ts tests",
			],
		);
	} finally {
		project.dispose();
	}
});

nodeTest("the real repository has complete source, project, profile and exception coverage", () => {
	assert.deepEqual(checkPolicy(repository), []);
});
