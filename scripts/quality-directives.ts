import type { SourcePolicy, SourceComment } from "./quality-source.ts";
import { exceptionSites } from "./quality-sites.ts";

type ExceptionSite = (typeof exceptionSites)[number];
interface SuppressionAudit {
	readonly problems: readonly string[];
	readonly used: readonly ExceptionSite[];
}

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

function authorize(
	source: SourcePolicy,
	comment: SourceComment,
): ExceptionSite | string | undefined {
	const text = comment.text.replace(/^[/*\s]+|\*\/$/gu, "").trim();
	const compiler = compilerProblem(source.file, text);
	if (compiler !== undefined) {
		return compiler;
	}
	if (/^eslint-(?:disable|enable)\b/u.test(text)) {
		return "use native, recorded Oxlint directives";
	}
	if (!/^oxlint-(?:disable|enable)\b/u.test(text)) {
		return;
	}
	const match = /^oxlint-disable-next-line\s+([\w/-]+)\s+--\s+(QX-\d{3}):\s+(.+)$/u.exec(text);
	if (match === null) {
		return "only one named next-line rule with QX identifier and reason is permitted";
	}
	const site = exceptionSites.find(
		(candidate) =>
			candidate.file === source.file &&
			candidate.rule === match[1] &&
			candidate.id === match[2] &&
			source.operations.some(
				(operation) =>
					operation.line === comment.endLine + 1 &&
					operation.selector === candidate.selector,
			),
	);
	return site ?? "unapproved exception file, rule, origin, or operation";
}

/** Native unused-disable diagnostics supplement this operation-bound authorization check. */
export function inspectSuppressions(source: SourcePolicy): SuppressionAudit {
	const used = new Set<ExceptionSite>();
	const problems: string[] = [];
	for (const comment of source.comments) {
		const result = authorize(source, comment);
		if (result === undefined) {
			continue;
		}
		if (typeof result !== "string" && !used.has(result)) {
			used.add(result);
			continue;
		}
		const problem = typeof result === "string" ? result : "duplicate exception operation";
		problems.push(`${source.file}:${comment.line + 1}: ${problem}`);
	}
	return { problems, used: [...used] };
}
