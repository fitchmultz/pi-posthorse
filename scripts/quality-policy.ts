import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { posix, relative, resolve } from "node:path";
import { sourcePolicies } from "./quality-source.ts";
import { inspectSuppressions } from "./quality-directives.ts";
import { settingsProblems, testProfileFiles } from "./quality-settings.ts";

/** Only Git internals and npm dependencies are outside this handwritten repository inventory. */
function inventory(root: string, dir = ""): string[] {
	return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === ".git" || entry.name === "node_modules") {
			return [];
		}
		const file = dir === "" ? entry.name : `${dir}/${entry.name}`;
		return entry.isDirectory() ? inventory(root, file) : [file];
	});
}

export function checkPolicy(root: string): readonly string[] {
	const testGlobs = testProfileFiles(root);
	const isTest = (file: string): boolean =>
		testGlobs.some((pattern) => posix.matchesGlob(file, pattern));
	const files = inventory(root).toSorted();
	const maintained = files.filter((file) => /\.[cm]?[jt]sx?$/u.test(file));
	const problems = [...settingsProblems(root, files)];
	const linted = new Set(
		execFileSync(resolve(root, "node_modules/.bin/oxlint"), ["--debug", "files", "."], {
			cwd: root,
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.map((file) => relative(root, resolve(root, file))),
	);
	for (const file of maintained) {
		if (!linted.has(file)) {
			problems.push(`Maintained source is not linted: ${file}`);
		}
	}
	for (const source of sourcePolicies(root, maintained)) {
		const audit = inspectSuppressions(source);
		problems.push(
			...audit.problems,
			...source.compilerProblems.map((problem) => `${source.file}: ${problem}`),
		);
		if (!source.checked) {
			problems.push(`Maintained source lacks compiler/semantic checking: ${source.file}`);
		}
		if (!isTest(source.file)) {
			for (const imported of source.imports.filter(isTest)) {
				problems.push(
					`Production source imports test-only support: ${source.file} -> ${imported}`,
				);
			}
		}
	}
	return problems;
}

if (import.meta.main) {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		console.log(
			"Usage: node scripts/quality-policy.ts [repository]\nCheck standard settings, source coverage, canonical compiler membership and suppression comments.\nExample: npm run quality:policy",
		);
	} else {
		const problems = checkPolicy(resolve(process.argv[2] ?? "."));
		if (problems.length > 0) {
			console.error(problems.join("\n"));
			process.exitCode = 1;
		} else {
			console.log(
				"Quality policy: standard settings, source coverage and exception contracts passed.",
			);
		}
	}
}
