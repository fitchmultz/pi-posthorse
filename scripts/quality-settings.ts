import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord as objectValue } from "../src/contracts.ts";

type Configuration = Readonly<Record<string, unknown>>;

export { objectValue };

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

/** Appendix A owns the rules; only the Node plugin and test-support paths are mapped. */
function mappedLint(baseline: Configuration): Configuration {
	if (!objectValue(baseline.rules) || !Array.isArray(baseline.overrides)) {
		throw new Error("Appendix A needs rules and source profiles");
	}
	const profiles: readonly unknown[] = baseline.overrides;
	const [tests, ...otherProfiles] = profiles;
	if (
		!objectValue(tests) ||
		!Array.isArray(tests.files) ||
		!objectValue(tests.rules) ||
		!Array.isArray(baseline.plugins)
	) {
		throw new Error("Appendix A needs plugins and the test profile");
	}
	const plugins: readonly unknown[] = baseline.plugins;
	const testFiles = tests.files.filter((entry): entry is string => typeof entry === "string");
	if (testFiles.length !== tests.files.length) {
		throw new Error("Appendix A test profile files must be glob strings");
	}
	return {
		...baseline,
		plugins: [...plugins, "node"],
		overrides: [
			{
				...tests,
				files: [...testFiles, "test/*.ts"],
			},
			...otherProfiles,
		],
	};
}

export function testProfileFiles(root: string): readonly string[] {
	const standard = readFileSync(resolve(root, "docs/engineering-standard.md"), "utf8");
	const baseline = standardBlock(standard, "## Appendix A: Base Oxlint configuration");
	const mapped = mappedLint(baseline);
	const overrides: readonly unknown[] = Array.isArray(mapped.overrides) ? mapped.overrides : [];
	const [first] = overrides;
	if (!objectValue(first) || !Array.isArray(first.files)) {
		throw new Error("Mapped lint configuration needs the test profile globs");
	}
	return first.files.filter((entry): entry is string => typeof entry === "string");
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
	for (const id of ["QX-011"]) {
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
