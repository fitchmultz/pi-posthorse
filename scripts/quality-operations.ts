import {
	isBinaryExpression,
	isArrowFunction,
	isFunctionExpression,
	isCallExpression,
	isExpressionStatement,
	isFunctionDeclaration,
	isIdentifier,
	isMethodDeclaration,
	isObjectBindingPattern,
	isObjectLiteralExpression,
	isPropertyAssignment,
	isStringLiteralLikeNode,
	isVariableDeclaration,
	isVariableDeclarationList,
	SyntaxKind,
	type CallExpression,
	type Node,
	type SourceFile,
} from "typescript/unstable/ast";

export interface SourceOperation {
	readonly line: number;
	readonly selector: string;
}

type SdkCall = (node: CallExpression, method: string) => boolean;

function registrationName(definition: Node | undefined): string | undefined {
	if (definition === undefined || !isObjectLiteralExpression(definition)) {
		return;
	}
	const name = definition.properties.find(
		(property) =>
			isPropertyAssignment(property) &&
			isIdentifier(property.name) &&
			property.name.text === "name",
	);
	return name !== undefined &&
		isPropertyAssignment(name) &&
		isStringLiteralLikeNode(name.initializer)
		? name.initializer.text
		: undefined;
}

function callScope(node: CallExpression, isSdkCall: SdkCall): string | undefined {
	const callee = node.expression.getText();
	const first = node.arguments[0];
	const tool = isSdkCall(node, "registerTool") ? registrationName(first) : undefined;
	if (tool !== undefined) {
		return `sdk:registerTool:${tool}`;
	}
	if (first !== undefined && isStringLiteralLikeNode(first)) {
		if (isSdkCall(node, "on")) {
			return `sdk:on:${first.text}`;
		}
		if (callee === "nodeTest") {
			return `test:${first.text}`;
		}
	}
	return ["setResponses", "steps.map"].includes(callee) ? `call:${callee}` : undefined;
}

function scopeLabel(node: Node, isSdkCall: SdkCall): string | undefined {
	if (isFunctionDeclaration(node) && node.name !== undefined) {
		return `function:${node.name.text}`;
	}
	if (isMethodDeclaration(node)) {
		return `method:${node.name.getText()}`;
	}
	if (isArrowFunction(node) || isFunctionExpression(node)) {
		return `callback:${node.parameters.map((parameter) => parameter.name.getText()).join(",")}`;
	}
	if (isCallExpression(node)) {
		return callScope(node, isSdkCall);
	}
	if (isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken) {
		return `assign:${node.left.getText()}`;
	}
	return;
}

function variableOperation(node: Node): string | undefined {
	if (
		!isVariableDeclaration(node) ||
		node.initializer === undefined ||
		!isVariableDeclarationList(node.parent) ||
		node.parent.declarations.length !== 1
	) {
		return;
	}
	if (isObjectBindingPattern(node.name)) {
		const names = node.name.elements
			.map((element) => element.name?.getText() ?? "<omitted>")
			.join(",");
		return `binding:${names}:${node.type?.getText() ?? ""}=${node.initializer.getText()}`;
	}
	return isIdentifier(node.name) && node.name.text === "ctx"
		? `variable:ctx=${node.initializer.getText()}`
		: undefined;
}

function operationLabel(node: Node): string | undefined {
	if (isMethodDeclaration(node) && isIdentifier(node.name) && node.name.text === "execute") {
		return `execute:${node.parameters.length}`;
	}
	if (isExpressionStatement(node) && isBinaryExpression(node.expression)) {
		const expression = node.expression;
		if (expression.operatorToken.kind === SyntaxKind.EqualsToken) {
			const right = isStringLiteralLikeNode(expression.right)
				? JSON.stringify(expression.right.text)
				: expression.right.getText();
			return `assignment:${expression.left.getText()}=${right}`;
		}
	}
	return variableOperation(node);
}

/** Select actual AST operations and enclosing owners, not line numbers or directive counts. */
export function sourceOperations(
	source: SourceFile,
	isSdkCall: SdkCall,
): readonly SourceOperation[] {
	const operations: SourceOperation[] = [];
	const visit = (node: Node, scope: readonly string[]): void => {
		const operation = operationLabel(node);
		if (operation !== undefined) {
			operations.push({
				line: source.getLineAndCharacterOfPosition(node.getStart()).line,
				selector: [...scope, operation].join("/"),
			});
		}
		const label = scopeLabel(node, isSdkCall);
		const nested = label === undefined ? scope : [...scope, label];
		node.forEachChild((child) => {
			visit(child, nested);
		});
	};
	visit(source, []);
	return operations;
}
