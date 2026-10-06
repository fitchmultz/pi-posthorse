import { API } from "typescript/unstable/sync";
import {
	isCallExpression,
	isIdentifier,
	isMethodDeclaration,
	isObjectLiteralExpression,
	isPropertyAccessExpression,
	type Node,
} from "typescript/unstable/ast";
import { parseSync } from "oxc-parser";
import { realpathSync } from "node:fs";
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
	readonly sdkCallbackLines: readonly number[];
}

/** The parser's complete comment stream includes empty containers and punctuation gaps. */
function parsedComments(
	file: string,
	text: string,
	line: (position: number) => number,
): readonly SourceComment[] {
	const parsed = parseSync(file, text);
	if (parsed.errors.length > 0) {
		throw new Error(
			`Could not parse ${file}: ${parsed.errors.map((error) => error.message).join("; ")}`,
		);
	}
	return parsed.comments.map((comment) => ({
		text: text.slice(comment.start, comment.end),
		offset: comment.start,
		line: line(comment.start),
		endLine: line(comment.end),
	}));
}

/** Only five-argument execute methods inside actual SDK registrations have the arity contract. */
function sdkCallbackLines(
	source: Node,
	isRegistration: (node: Node) => boolean,
	line: (position: number) => number,
): readonly number[] {
	const lines: number[] = [];
	const visit = (node: Node): void => {
		if (isCallExpression(node) && isRegistration(node)) {
			const definition = node.arguments[0];
			for (const property of executeMethods(definition)) {
				lines.push(line(property.getStart()));
			}
		}
		node.forEachChild((child) => {
			visit(child);
		});
	};
	visit(source);
	return lines;
}

function executeMethods(definition: Node | undefined): readonly Node[] {
	if (definition === undefined || !isObjectLiteralExpression(definition)) {
		return [];
	}
	return definition.properties.filter(
		(property) =>
			isMethodDeclaration(property) &&
			isIdentifier(property.name) &&
			property.name.text === "execute" &&
			property.parameters.length === 5,
	);
}

/** Compiler projects supply effective language settings and declaration identity, not lint scope. */
export function sourcePolicies(root: string, files: readonly string[]): readonly SourcePolicy[] {
	const api = new API({ cwd: root });
	const sdkDeclaration = realpathSync(
		resolve(
			root,
			"node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts",
		),
	);
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
				const sdkPath = project.program.getSourceFile(sdkDeclaration)?.path;
				const line = (position: number) =>
					source.getLineAndCharacterOfPosition(position).line;
				const comments = parsedComments(file, source.text, line);
				const prologueEnd = source.statements.at(0)?.getStart(source) ?? source.text.length;
				const directives = comments.filter(
					(comment) =>
						comment.offset < prologueEnd &&
						/^[/*\s]*@ts-(?:check|nocheck)\b/u.test(comment.text),
				);
				const last = directives.at(-1);
				const callbacks = sdkCallbackLines(
					source,
					(node) => {
						if (
							!isCallExpression(node) ||
							!isPropertyAccessExpression(node.expression) ||
							node.expression.name.text !== "registerTool"
						) {
							return false;
						}
						const symbol = project.checker.getSymbolAtLocation(node.expression);
						return (
							symbol?.name === "registerTool" &&
							symbol.getParent()?.name === "ExtensionAPI" &&
							symbol.declarations.length > 0 &&
							symbol.declarations.every((declaration) => declaration.path === sdkPath)
						);
					},
					line,
				);
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
					sdkCallbackLines: callbacks,
				};
			});
		} finally {
			snapshot.dispose();
		}
	} finally {
		api.close();
	}
}
