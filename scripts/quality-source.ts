import { API, type Project, type Snapshot, type CompilerOptions } from "typescript/unstable/sync";
import type { SourceFile } from "typescript/unstable/ast";
import { parseSync } from "oxc-parser";
import { relative, resolve } from "node:path";

export interface SourceComment {
	readonly text: string;
	readonly offset: number;
	readonly line: number;
}
export interface SourcePolicy {
	readonly file: string;
	readonly comments: readonly SourceComment[];
	readonly checked: boolean;
	readonly compilerProblems: readonly string[];
	readonly imports: readonly string[];
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
	}));
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

function oneSource(root: string, file: string, snapshot: Snapshot): SourcePolicy {
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
	};
}

/** The native compiler owns canonical project membership, including inferred projects. */
export function sourcePolicies(root: string, files: readonly string[]): readonly SourcePolicy[] {
	const api = new API({ cwd: root });
	try {
		const snapshot = api.updateSnapshot({
			openProjects: [resolve(root, "tsconfig.json")],
			openFiles: files.map((file) => resolve(root, file)),
		});
		try {
			return files.map((file) => oneSource(root, file, snapshot));
		} finally {
			snapshot.dispose();
		}
	} finally {
		api.close();
	}
}
