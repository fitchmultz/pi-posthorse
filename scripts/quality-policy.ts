import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { sourcePolicies, type SourcePolicy, type SourceComment } from "./quality-source.ts";

export function objectValue(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function readObject(path: string): Readonly<Record<string, unknown>> {
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!objectValue(value)) {
		throw new Error(`Expected an object in ${path}`);
	}
	return value;
}

function compilerDirectiveProblem(file: string, text: string): string | undefined {
	if (/^@ts-(?:ignore|nocheck)\b/u.test(text)) {
		return "compiler suppression is forbidden";
	}
	if (
		/^@ts-expect-error\b/u.test(text) &&
		(!file.endsWith(".test-d.ts") || text.replace(/^@ts-expect-error\s*:?\s*/u, "").length < 10)
	) {
		return "expected compiler errors belong in described dedicated .test-d.ts tests";
	}
	return;
}

const authorizedRules = new Map([
	["no-await-in-loop", (_file: string, next: string) => /\bawait\b/u.test(next)],
	[
		"no-control-regex",
		(file: string) => ["src/ui/text.ts", "test/renderers.test.ts"].includes(file),
	],
	[
		"typescript/no-unnecessary-condition",
		(_file: string, next: string) => /\.(?:aborted|deleted)\b/u.test(next),
	],
	[
		"typescript/prefer-readonly-parameter-types",
		(_file: string, next: string) => /^\s*\w+\s*:\s*\(\s*\)\s*=>\s*[A-Z]\w*,?\s*$/u.test(next),
	],
	[
		"max-params",
		(file: string, next: string) =>
			["src/context-tools.ts", "src/notes.ts", "src/history.ts"].includes(file) &&
			/^\s*(?:async\s+)?execute\(/u.test(next),
	],
]);

function hasExplanation(source: SourcePolicy, comment: SourceComment): boolean {
	const previous = source.comments.find((candidate) => candidate.endLine === comment.line - 1);
	if (previous === undefined) {
		return false;
	}
	const text = previous.text.replace(/^[/*\s]+|\*\/$/gu, "").trim();
	return text.length >= 20 && !/^(?:oxlint-|eslint-|@ts-)/u.test(text);
}

function ruleScopeProblem(
	source: SourcePolicy,
	comment: SourceComment,
	rule: string,
): string | undefined {
	const next = source.lines[comment.endLine + 1] ?? "";
	if (rule === "max-params" && !source.sdkCallbackLines.includes(comment.endLine + 1)) {
		return "arity allowance requires an actual five-argument SDK tool registration";
	}
	if (authorizedRules.get(rule)?.(source.file, next) === true) {
		return;
	}
	return `unapproved rule or scope: ${rule}`;
}

function directiveProblem(source: SourcePolicy, comment: SourceComment): string | undefined {
	const text = comment.text.replace(/^[/*\s]+|\*\/$/gu, "").trim();
	const compiler = compilerDirectiveProblem(source.file, text);
	if (compiler !== undefined) {
		return compiler;
	}
	if (/^eslint-(?:disable|enable)\b/u.test(text)) {
		return "use native, explained Oxlint directives";
	}
	if (!/^oxlint-(?:disable|enable)\b/u.test(text)) {
		return;
	}
	const match = /^oxlint-disable-next-line\s+([\w/-]+)\s*$/u.exec(text);
	if (match === null) {
		return "only one named rule on oxlint-disable-next-line is permitted";
	}
	if (!hasExplanation(source, comment)) {
		return "directive needs an adjacent contract explanation";
	}
	return ruleScopeProblem(source, comment, match[1]);
}

export function suppressionProblems(source: SourcePolicy): readonly string[] {
	return source.comments.flatMap((comment) => {
		const problem = directiveProblem(source, comment);
		return problem === undefined ? [] : [`${source.file}:${comment.line + 1}: ${problem}`];
	});
}

function uncheckedFiles(config: Readonly<Record<string, unknown>>): readonly string[] {
	if (!Array.isArray(config.overrides)) {
		throw new Error("Oxlint overrides must explicitly scope unchecked JavaScript");
	}
	return config.overrides.flatMap((override: unknown) => {
		if (
			!objectValue(override) ||
			!objectValue(override.rules) ||
			override.rules["typescript/no-floating-promises"] !== "off"
		) {
			return [];
		}
		if (!Array.isArray(override.files)) {
			throw new Error("Unchecked JavaScript scopes must be exact maintained file paths");
		}
		const files: readonly unknown[] = override.files;
		return files.map((file) => {
			if (typeof file !== "string" || /[*{}]/u.test(file)) {
				throw new Error("Unchecked JavaScript scopes must be exact maintained file paths");
			}
			return file;
		});
	});
}

export function checkPolicy(root: string): readonly string[] {
	const tracked = execFileSync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard"],
		{ cwd: root, encoding: "utf8" },
	).split("\n");
	const maintained = [
		...new Set(tracked.filter((file) => /\.[cm]?[jt]sx?$/u.test(file))),
	].toSorted();
	const linted = new Set(
		execFileSync(resolve(root, "node_modules/.bin/oxlint"), ["--debug", "files", "."], {
			cwd: root,
			encoding: "utf8",
		})
			.trim()
			.split("\n")
			.map((file) => relative(root, resolve(root, file))),
	);
	const problems: string[] = [];
	for (const file of maintained) {
		if (!linted.has(file)) {
			problems.push(`Maintained source is not linted: ${file}`);
		}
	}
	const config = readObject(resolve(root, ".oxlintrc.json"));
	const unchecked = uncheckedFiles(config);
	for (const source of sourcePolicies(root, maintained)) {
		problems.push(...suppressionProblems(source));
		if (source.checked === unchecked.includes(source.file)) {
			problems.push(
				`Semantic lint scope disagrees with effective compiler/directive scope: ${source.file}`,
			);
		}
		if (source.checked && (!source.strict || !source.noImplicitReturns)) {
			problems.push(
				`Checked source lacks strict/noImplicitReturns project assignment: ${source.file}`,
			);
		}
	}
	for (const file of unchecked) {
		if (!maintained.includes(file)) {
			problems.push(`Stale unchecked-JavaScript scope: ${file}`);
		}
	}
	return problems;
}

if (import.meta.main) {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		console.log(
			"Usage: node scripts/quality-policy.ts [repository]\nCheck maintained-code lint scope, typed-project membership and explained native suppressions.\nExample: npm run quality:policy",
		);
	} else {
		const problems = checkPolicy(resolve(process.argv[2] ?? "."));
		if (problems.length > 0) {
			console.error(problems.join("\n"));
			process.exitCode = 1;
		} else {
			console.log("Quality policy: maintained-code scope and suppression contracts passed.");
		}
	}
}
