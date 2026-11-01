import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { exceptionSites } from "./quality-sites.ts";

type Configuration = Readonly<Record<string, unknown>>;

const requiredScripts = {
	check: "tsc --noEmit",
	"quality:policy": "node scripts/quality-policy.ts",
	"quality:config": "node scripts/config-policy.ts",
	"quality:probes": "node --test test/quality*.test.ts",
	lint: "node scripts/verify.ts quality:policy quality:config lint:oxlint",
	"lint:agent": "node scripts/verify.ts quality:policy quality:config lint:agent:oxlint",
	"lint:fix": "node scripts/verify.ts quality:policy quality:config lint:fix:oxlint",
	"lint:oxlint": "oxlint --deny-warnings .",
	"lint:agent:oxlint": "oxlint --deny-warnings --format=agent .",
	"lint:fix:oxlint": "oxlint --fix .",
	format: "oxfmt --write .",
	"format:check": "oxfmt --check .",
	build: "npm pack --dry-run",
	verify: "node scripts/toolchain-policy.ts && node scripts/verify.ts quality:policy quality:config lint:oxlint format:check check test build",
	"check:compat": "node scripts/verify.ts check test",
	"test:native": "node --import ./test/pi-loader.ts --test test/host.test.mjs",
	test: "node --import ./test/pi-loader.ts --test test/*.test.ts test/host.test.mjs",
	prepublishOnly: "npm run verify",
};

export function objectValue(value: unknown): value is Configuration {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readObject(path: string): Configuration {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!objectValue(value)) {
		throw new Error(`Expected an object in ${path}`);
	}
	return value;
}

function standardBlock(standard: string, heading: string): Configuration {
	const section = standard.split(`${heading}\n`)[1];
	const block = section?.match(/```json\n([\s\S]*?)\n```/u)?.[1];
	if (block === undefined) {
		throw new Error(`Missing normative JSON in ${heading}`);
	}
	const value: unknown = JSON.parse(block);
	if (!objectValue(value)) {
		throw new Error(`Expected normative object in ${heading}`);
	}
	return value;
}

/** Appendix A owns the baseline; these are the enumerated repository mappings and QX-001. */
function mappedLint(baseline: Configuration): Configuration {
	if (!objectValue(baseline.rules) || !Array.isArray(baseline.overrides)) {
		throw new Error("Appendix A needs rules and source profiles");
	}
	const floating = baseline.rules["typescript/no-floating-promises"];
	const profiles: readonly unknown[] = baseline.overrides;
	const [tests, ...otherProfiles] = profiles;
	if (
		!Array.isArray(floating) ||
		!objectValue(floating[1]) ||
		!objectValue(tests) ||
		!Array.isArray(tests.files) ||
		!objectValue(tests.rules) ||
		!Array.isArray(baseline.plugins)
	) {
		throw new Error("Appendix A needs the Node ownership options and test profile");
	}
	const plugins: readonly unknown[] = baseline.plugins;
	const testFiles: readonly unknown[] = tests.files;
	return {
		...baseline,
		plugins: [...plugins, "node"],
		overrides: [
			{
				...tests,
				files: [...testFiles, "test/*.ts"],
				rules: {
					...tests.rules,
					"typescript/no-floating-promises": [
						"error",
						{
							...floating[1],
							allowForKnownSafeCalls: [
								{ from: "package", package: "node:test", name: ["nodeTest"] },
							],
						},
					],
				},
			},
			...otherProfiles,
		],
	};
}

function differences(file: string, actual: Configuration, expected: Configuration): string[] {
	return [...new Set([...Object.keys(actual), ...Object.keys(expected)])].flatMap((key) =>
		isDeepStrictEqual(actual[key], expected[key])
			? []
			: [
					`${file}:${key} differs from the qualified standard mapping; update the record and controls`,
				],
	);
}

function commandProblems(root: string): readonly string[] {
	const scripts = readObject(resolve(root, "package.json")).scripts;
	if (!objectValue(scripts)) {
		return ["package.json:scripts must retain the required acceptance commands"];
	}
	return Object.entries(requiredScripts).flatMap(([name, command]) =>
		scripts[name] === command
			? []
			: [`package.json:scripts.${name} must retain ${JSON.stringify(command)}`],
	);
}

/** Keep composition explicit instead of reproducing Oxlint/Oxfmt's config and ignore mergers. */
export function settingsProblems(root: string, inventory: readonly string[]): readonly string[] {
	const standard = readFileSync(resolve(root, "docs/engineering-standard.md"), "utf8");
	const baseline = standardBlock(standard, "## Appendix A: Base Oxlint configuration");
	const formatter = standardBlock(standard, "### 7.1 Formatter ownership");
	const problems = [
		...commandProblems(root),
		...differences(
			".oxlintrc.json",
			readObject(resolve(root, ".oxlintrc.json")),
			mappedLint(baseline),
		),
		...differences(".oxfmtrc.json", readObject(resolve(root, ".oxfmtrc.json")), {
			...formatter,
			tabWidth: 4,
			useTabs: true,
			ignorePatterns: ["package-lock.json"],
			overrides: [
				{
					files: ["**/*.md", "**/*.yml", "**/*.yaml"],
					options: { useTabs: false, tabWidth: 2 },
				},
			],
		}),
	];
	for (const id of new Set(["QX-001", "QX-011", ...exceptionSites.map((site) => site.id)])) {
		if (!standard.includes(`### ${id}:`)) {
			problems.push(`Missing quality-exception record: ${id}`);
		}
	}
	for (const file of inventory) {
		if (
			/(?:^|\/)(?:\.oxlintrc(?:\.[\w]+)?|oxlint\.config\.[\w]+|\.oxfmtrc(?:\.[\w]+)?|oxfmt\.config\.[\w]+|\.eslintignore|\.prettierignore)$/u.test(
				file,
			) &&
			file !== ".oxlintrc.json" &&
			file !== ".oxfmtrc.json"
		) {
			problems.push(`Unqualified lint/format composition: ${file}`);
		}
	}
	if (readFileSync(resolve(root, ".gitignore"), "utf8") !== "node_modules/\n") {
		problems.push(".gitignore: qualify changed formatter/linter ignore coverage");
	}
	return problems;
}
