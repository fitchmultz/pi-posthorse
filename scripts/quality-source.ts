import { API } from "typescript/unstable/sync";
import {
	getLeadingCommentRanges,
	getTrailingCommentRanges,
	type Node,
} from "typescript/unstable/ast";
import { resolve } from "node:path";

export interface SourceComment {
	readonly text: string;
	readonly offset: number;
	readonly line: number;
	readonly endLine: number;
}
export interface SourcePolicy {
	readonly file: string;
	readonly comments: readonly SourceComment[];
	readonly lines: readonly string[];
	readonly checked: boolean;
	readonly strict: boolean;
	readonly noImplicitReturns: boolean;
	readonly project: string;
}

/** The installed compiler parses strings, regexes, templates and JSX before we inspect trivia. */
export function sourcePolicies(root: string, files: readonly string[]): readonly SourcePolicy[] {
	const api = new API({ cwd: root });
	try {
		const snapshot = api.updateSnapshot({
			openFiles: files.map((file) => resolve(root, file)),
		});
		try {
			return files.map((file) => {
				const absolute = resolve(root, file);
				const project = snapshot.getDefaultProjectForFile(absolute);
				const source = project?.program.getSourceFile(absolute);
				if (source === undefined || project === undefined) {
					throw new Error(`Compiler could not assign maintained source ${file}`);
				}
				const ranges = new Map<number, SourceComment>();
				const visit = (node: Node): void => {
					const comments = [
						...(getLeadingCommentRanges(source.text, node.pos) ?? []),
						...(getTrailingCommentRanges(source.text, node.end) ?? []),
					];
					for (const comment of comments) {
						ranges.set(comment.pos, {
							text: source.text.slice(comment.pos, comment.end),
							offset: comment.pos,
							line: source.getLineAndCharacterOfPosition(comment.pos).line,
							endLine: source.getLineAndCharacterOfPosition(comment.end).line,
						});
					}
					node.forEachChild((child) => {
						visit(child);
					});
				};
				visit(source);
				const comments = [...ranges.values()].toSorted((a, b) => a.line - b.line);
				const prologueEnd = source.statements.at(0)?.getStart(source) ?? source.text.length;
				const directives = comments.filter(
					(comment) =>
						comment.offset < prologueEnd &&
						/^[/*\s]*@ts-(?:check|nocheck)\b/u.test(comment.text),
				);
				const last = directives.at(-1);
				return {
					file,
					comments,
					lines: source.text.split("\n"),
					checked:
						/\.[cm]?tsx?$/u.test(file) ||
						(last === undefined
							? project.compilerOptions.checkJs === true
							: /@ts-check\b/u.test(last.text)),
					strict: project.compilerOptions.strict === true,
					noImplicitReturns: project.compilerOptions.noImplicitReturns === true,
					project: project.configFileName,
				};
			});
		} finally {
			snapshot.dispose();
		}
	} finally {
		api.close();
	}
}
