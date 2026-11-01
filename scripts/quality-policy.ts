import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { sourcePolicies } from "./quality-source.ts";
import { inspectSuppressions } from "./quality-directives.ts";
import { settingsProblems } from "./quality-settings.ts";
import { exceptionSites } from "./quality-sites.ts";

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

function isTest(file: string): boolean {
	return (
		/^test\/[^/]+\.ts$/u.test(file) ||
		/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) ||
		/(?:^|\/)__tests__\//u.test(file)
	);
}

export function checkPolicy(root: string): readonly string[] {
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
	const used = new Set<(typeof exceptionSites)[number]>();
	for (const source of sourcePolicies(root, maintained)) {
		const audit = inspectSuppressions(source);
		problems.push(
			...audit.problems,
			...source.compilerProblems.map((problem) => `${source.file}: ${problem}`),
		);
		for (const site of audit.used) {
			used.add(site);
		}
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
	for (const site of exceptionSites) {
		if (!used.has(site)) {
			problems.push(`Stale exception site: ${site.id} ${site.file} ${site.selector}`);
		}
	}
	return problems;
}

if (import.meta.main) {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		console.log(
			"Usage: node scripts/quality-policy.ts [repository]\nCheck standard settings, source coverage, canonical compiler membership and operation-bound directives.\nExample: npm run quality:policy",
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
