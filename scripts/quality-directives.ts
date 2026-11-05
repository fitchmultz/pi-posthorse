import type { SourcePolicy } from "./quality-source.ts";

function compilerProblem(file: string, text: string): string | undefined {
	if (/^@ts-(?:ignore|nocheck)\b/u.test(text)) {
		return "compiler suppression is forbidden";
	}
	if (
		/^@ts-expect-error\b/u.test(text) &&
		(!/\.test-d\.[cm]?ts$/u.test(file) ||
			text.replace(/^@ts-expect-error\s*:?\s*/u, "").length < 10)
	) {
		return "expected compiler errors belong in described dedicated .test-d.ts tests";
	}
	return;
}

function directiveProblem(file: string, text: string): string | undefined {
	const compiler = compilerProblem(file, text);
	if (compiler !== undefined) {
		return compiler;
	}
	if (/^(?:oxfmt|prettier)-ignore\b/u.test(text)) {
		return "formatting suppressions require a recorded byte or readability contract";
	}
	if (/^(?:eslint|oxlint)-(?:disable|enable)\b/u.test(text)) {
		return "lint suppressions are not permitted";
	}
	return;
}

/** Inspect actual comments, including used suppressions that native unused checks cannot reject. */
export function inspectSuppressions(source: SourcePolicy): {
	readonly problems: readonly string[];
} {
	const problems: string[] = [];
	for (const comment of source.comments) {
		const text = comment.text.replace(/^[/*\s]+|\*\/$/gu, "").trim();
		const problem = directiveProblem(source.file, text);
		if (problem !== undefined) {
			problems.push(`${source.file}:${comment.line + 1}: ${problem}`);
		}
	}
	return { problems };
}
