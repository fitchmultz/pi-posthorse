import { API, type Project, type Snapshot, type CompilerOptions } from "typescript/unstable/sync";
import {
	isPropertyAccessExpression,
	type CallExpression,
	type SourceFile,
} from "typescript/unstable/ast";
import { parseSync } from "oxc-parser";
import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { sourceOperations, type SourceOperation } from "./quality-operations.ts";

export interface SourceComment {
	readonly text: string;
	readonly offset: number;
	readonly line: number;
	readonly endLine: number;
}
export interface SourcePolicy {
	readonly file: string;
	readonly comments: readonly SourceComment[];
	readonly checked: boolean;
	readonly compilerProblems: readonly string[];
	readonly imports: readonly string[];
	readonly operations: readonly SourceOperation[];
}

// Section 4.2; strict-family flags inherit true from strict unless explicitly disabled.
const required = [
	"strict",
	"noImplicitReturns",
	"noFallthroughCasesInSwitch",
	"noImplicitOverride",
	"noUncheckedIndexedAccess",
	"exactOptionalPropertyTypes",
	"noUncheckedSideEffectImports",
	"forceConsistentCasingInFileNames",
	"allowJs",
	"checkJs",
] as const satisfies readonly (keyof CompilerOptions)[];
const strictFamily = [
	"noImplicitAny",
	"noImplicitThis",
	"strictNullChecks",
	"strictFunctionTypes",
	"strictBindCallApply",
	"strictPropertyInitialization",
	"strictBuiltinIteratorReturn",
	"useUnknownInCatchVariables",
] as const satisfies readonly (keyof CompilerOptions)[];

function compilerProblems(project: Project, source: SourceFile): readonly string[] {
	const options = project.compilerOptions;
	const problems = required.flatMap((name) =>
		options[name] === true ? [] : [`${name} must be true`],
	);
	for (const name of strictFamily) {
		if (options[name] === false) {
			problems.push(`${name} must not disable the strict family`);
		}
	}
	if (options.noCheck === true) {
		problems.push("noCheck must be false");
	}
	if (source.isDeclarationFile && options.skipLibCheck === true) {
		problems.push("handwritten declarations need a canonical skipLibCheck:false project");
	}
	return problems;
}

/** Oxc's complete comment stream includes empty containers and punctuation gaps. */
function parsedComments(file: string, source: SourceFile): readonly SourceComment[] {
	const parsed = parseSync(file, source.text);
	if (parsed.errors.length > 0) {
		throw new Error(
			`Could not parse ${file}: ${parsed.errors.map((error) => error.message).join("; ")}`,
		);
	}
	return parsed.comments.map((comment) => ({
		text: source.text.slice(comment.start, comment.end),
		offset: comment.start,
		line: source.getLineAndCharacterOfPosition(comment.start).line,
		endLine: source.getLineAndCharacterOfPosition(comment.end).line,
	}));
}

function sdkCall(
	project: Project,
	sdkPath: SourceFile["path"] | undefined,
	node: CallExpression,
	method: string,
): boolean {
	if (!isPropertyAccessExpression(node.expression) || node.expression.name.text !== method) {
		return false;
	}
	const symbol = project.checker.getSymbolAtLocation(node.expression);
	return (
		symbol?.name === method &&
		symbol.getParent()?.name === "ExtensionAPI" &&
		symbol.declarations.length > 0 &&
		symbol.declarations.every((declaration) => declaration.path === sdkPath)
	);
}

function checked(
	file: string,
	project: Project,
	source: SourceFile,
	comments: readonly SourceComment[],
): boolean {
	const prologueEnd = source.statements.at(0)?.getStart(source) ?? source.text.length;
	const directive = comments.findLast(
		(comment) =>
			comment.offset < prologueEnd && /^[/*\s]*@ts-(?:check|nocheck)\b/u.test(comment.text),
	);
	return (
		/\.[cm]?tsx?$/u.test(file) ||
		(directive === undefined
			? project.compilerOptions.checkJs === true
			: /@ts-check\b/u.test(directive.text))
	);
}

function oneSource(
	root: string,
	file: string,
	snapshot: Snapshot,
	sdkDeclaration: string,
): SourcePolicy {
	const absolute = resolve(root, file);
	const project = snapshot.getDefaultProjectForFile(absolute);
	const source = project?.program.getSourceFile(absolute);
	if (source === undefined || project === undefined) {
		throw new Error(`Compiler could not assign maintained source ${file}`);
	}
	const canonical = snapshot.getProject(resolve(root, "tsconfig.json"));
	const membership =
		relative(root, project.configFileName) === "tsconfig.json" &&
		canonical?.program.getSourceFile(absolute)?.path === source.path;
	const comments = parsedComments(file, source);
	const sdkPath = project.program.getSourceFile(sdkDeclaration)?.path;
	const imports = source.imports.flatMap(
		(node) =>
			project.checker.getSymbolAtLocation(node)?.declarations.flatMap((declaration) => {
				// Handles use canonical paths; source filenames retain filesystem spelling.
				const imported = declaration.resolve()?.getSourceFile();
				return imported === undefined ? [] : [relative(root, imported.fileName)];
			}) ?? [],
	);
	return {
		file,
		comments,
		checked: checked(file, project, source, comments),
		compilerProblems: membership
			? compilerProblems(project, source)
			: ["source is not assigned to the canonical tsconfig.json compiler gate"],
		imports,
		operations: sourceOperations(source, (node, method) =>
			sdkCall(project, sdkPath, node, method),
		),
	};
}

/** The native compiler owns project membership and declaration identity, including inferred projects. */
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
			openProjects: [resolve(root, "tsconfig.json")],
			openFiles: files.map((file) => resolve(root, file)),
		});
		try {
			return files.map((file) => oneSource(root, file, snapshot, sdkDeclaration));
		} finally {
			snapshot.dispose();
		}
	} finally {
		api.close();
	}
}
