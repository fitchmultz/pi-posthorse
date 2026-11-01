import assert from "node:assert/strict";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test as nodeTest } from "node:test";
import { checkPolicy } from "../scripts/quality-policy.ts";
import { sourcePolicies } from "../scripts/quality-source.ts";
import { changeConfiguration, fixture, repository } from "./quality-support.ts";

function completeFixture() {
	const root = mkdtempSync(join(tmpdir(), "posthorse-integrity-"));
	try {
		cpSync(repository, root, {
			recursive: true,
			filter: (path) => ![".git", "node_modules"].includes(basename(path)),
		});
		symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), "dir");
		return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

nodeTest(
	"the real policy rejects configuration, composition and acceptance downgrades",
	async (t) => {
		const project = completeFixture();
		const cases = [
			{
				file: ".oxlintrc.json",
				path: ["rules", "no-unreachable"],
				value: "off",
				problem: ".oxlintrc.json:rules differs",
			},
			{
				file: ".oxlintrc.json",
				path: ["categories", "suspicious"],
				value: "off",
				problem: ".oxlintrc.json:categories differs",
			},
			{
				file: ".oxlintrc.json",
				path: ["rules", "eqeqeq"],
				value: "warn",
				problem: ".oxlintrc.json:rules differs",
			},
			{
				file: ".oxlintrc.json",
				path: ["options", "typeAware"],
				value: false,
				problem: ".oxlintrc.json:options differs",
			},
			{
				file: ".oxlintrc.json",
				path: ["rules", "complexity", 1, "max"],
				value: 11,
				problem: ".oxlintrc.json:rules differs",
			},
			{
				file: ".oxlintrc.json",
				path: ["overrides", 0, "files", 4],
				value: "src/**",
				problem: ".oxlintrc.json:overrides differs",
			},
			{
				file: ".oxlintrc.json",
				path: [
					"overrides",
					0,
					"rules",
					"typescript/no-floating-promises",
					1,
					"allowForKnownSafeCalls",
					0,
					"name",
				],
				value: ["nodeTest", "test"],
				problem: ".oxlintrc.json:overrides differs",
			},
			{
				file: ".oxfmtrc.json",
				path: ["ignorePatterns", 1],
				value: "src/**",
				problem: ".oxfmtrc.json:ignorePatterns differs",
			},
			{
				file: "package.json",
				path: ["scripts", "verify"],
				value: "npm run lint",
				problem: "package.json:scripts.verify must retain",
			},
		] as const;
		try {
			assert.deepEqual(checkPolicy(project.root), []);
			for (const example of cases) {
				await t.test(`${example.file}:${example.path.join(".")}`, () => {
					const original = readFileSync(join(project.root, example.file), "utf8");
					try {
						changeConfiguration(
							project.root,
							example.file,
							example.path,
							example.value,
						);
						const problems = checkPolicy(project.root);
						assert.equal(problems.length, 1, problems.join("\n"));
						assert.ok(
							problems[0]?.startsWith(example.problem) === true,
							problems.join("\n"),
						);
					} finally {
						writeFileSync(join(project.root, example.file), original);
					}
				});
			}
			for (const file of ["src/.oxlintrc.json", ".prettierignore"]) {
				await t.test(file, () => {
					try {
						writeFileSync(
							join(project.root, file),
							file.endsWith("json") ? "{}\n" : "src/**\n",
						);
						assert.deepEqual(checkPolicy(project.root), [
							`Unqualified lint/format composition: ${file}`,
						]);
					} finally {
						rmSync(join(project.root, file));
					}
				});
			}
			assert.deepEqual(checkPolicy(project.root), []);
		} finally {
			project.dispose();
		}
	},
);

nodeTest("all effective compiler minimums remain enforced", async (t) => {
	const project = fixture({ files: { "checked.ts": "export const value = 1;\n" } });
	const original = readFileSync(join(project.root, "tsconfig.json"), "utf8");
	try {
		assert.deepEqual(sourcePolicies(project.root, ["checked.ts"])[0]?.compilerProblems, []);
		for (const option of [
			"strict",
			"noImplicitReturns",
			"noFallthroughCasesInSwitch",
			"noImplicitOverride",
			"noUncheckedIndexedAccess",
			"exactOptionalPropertyTypes",
			"noUncheckedSideEffectImports",
			"forceConsistentCasingInFileNames",
			"checkJs",
		]) {
			await t.test(option, () => {
				try {
					changeConfiguration(
						project.root,
						"tsconfig.json",
						["compilerOptions", option],
						false,
					);
					assert.deepEqual(
						sourcePolicies(project.root, ["checked.ts"])[0]?.compilerProblems,
						[`${option} must be true`],
					);
				} finally {
					writeFileSync(join(project.root, "tsconfig.json"), original);
				}
			});
		}
		for (const [option, value, problem] of [
			["strictNullChecks", false, "strictNullChecks must not disable the strict family"],
			["noCheck", true, "noCheck must be false"],
		] as const) {
			try {
				changeConfiguration(
					project.root,
					"tsconfig.json",
					["compilerOptions", option],
					value,
				);
				assert.deepEqual(
					sourcePolicies(project.root, ["checked.ts"])[0]?.compilerProblems,
					[problem],
				);
			} finally {
				writeFileSync(join(project.root, "tsconfig.json"), original);
			}
		}
	} finally {
		project.dispose();
	}
});

nodeTest(
	"omitted sources and unrun leaf projects cannot borrow a successful root compiler gate",
	() => {
		const project = fixture({
			files: {
				"entry.ts": "export const value = 1;\n",
				"omitted.ts": "export const value = 1;\n",
				"leaf/checked.ts": "export const value = 1;\n",
				"leaf/tsconfig.json": JSON.stringify({
					extends: "../tsconfig.json",
					include: ["*.ts"],
				}),
			},
		});
		try {
			changeConfiguration(project.root, "tsconfig.json", ["include"], ["entry.ts"]);
			assert.deepEqual(
				sourcePolicies(project.root, ["entry.ts", "omitted.ts", "leaf/checked.ts"]).map(
					(source) => source.compilerProblems,
				),
				[
					[],
					["source is not assigned to the canonical tsconfig.json compiler gate"],
					["source is not assigned to the canonical tsconfig.json compiler gate"],
				],
			);
		} finally {
			project.dispose();
		}
	},
);

nodeTest("handwritten declarations cannot inherit the application's dependency skip", () => {
	const project = fixture({
		files: { "boundary.d.ts": "export declare const value: number;\n" },
	});
	try {
		assert.deepEqual(sourcePolicies(project.root, ["boundary.d.ts"])[0]?.compilerProblems, [
			"handwritten declarations need a canonical skipLibCheck:false project",
		]);
		changeConfiguration(
			project.root,
			"tsconfig.json",
			["compilerOptions", "skipLibCheck"],
			false,
		);
		assert.deepEqual(sourcePolicies(project.root, ["boundary.d.ts"])[0]?.compilerProblems, []);
	} finally {
		project.dispose();
	}
});

nodeTest("filesystem inventory and compiler-resolved imports preserve profile boundaries", () => {
	const project = completeFixture();
	try {
		writeFileSync(join(project.root, "test/policy-control.ts"), "export const value = 1;\n");
		writeFileSync(join(project.root, "src/policy-control.ts"), "export const value = 1;\n");
		assert.deepEqual(checkPolicy(project.root), []);
		writeFileSync(
			join(project.root, "src/policy-control.ts"),
			"import { value } from '../test/policy-control.ts';\nexport const result = value;\n",
		);
		assert.deepEqual(checkPolicy(project.root), [
			"Production source imports test-only support: src/policy-control.ts -> test/policy-control.ts",
		]);
		writeFileSync(join(project.root, "src/policy-control.ts"), "export const value = 1;\n");
		mkdirSync(join(project.root, "omitted"));
		writeFileSync(join(project.root, "omitted/handwritten.ts"), "export const value = 1;\n");
		const problems = checkPolicy(project.root);
		assert.deepEqual(problems, [
			"omitted/handwritten.ts: source is not assigned to the canonical tsconfig.json compiler gate",
		]);
	} finally {
		project.dispose();
	}
});
