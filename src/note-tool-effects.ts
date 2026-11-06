import { isRecord, optionalString, unknownArray } from "./contracts.ts";

export type NoteAction =
	| "read"
	| "write"
	| "clear"
	| "append"
	| "edit"
	| "create"
	| "create-empty"
	| "delete";
export type NoteOperation = {
	readonly path: string;
	readonly action: NoteAction;
	readonly scope?: string | undefined;
};
export function bareToolName(name: string | undefined): string {
	const cut = Math.max(name?.lastIndexOf(":") ?? -1, name?.lastIndexOf("/") ?? -1);
	return name?.slice(cut + 1) ?? "";
}
function patchOperations(input: unknown): NoteOperation[] {
	if (typeof input !== "string") {
		return [];
	}
	const operations: NoteOperation[] = [];
	let update: { readonly path: string; readonly end: number } | undefined;
	for (const match of input.matchAll(
		/^\*\*\* (Update File|Add File|Delete File|Move to): ([^\r\n]+)$/gmu,
	)) {
		const path = match[2];
		if (path === undefined) {
			continue;
		}
		if (match[1] === "Move to") {
			if (
				update !== undefined &&
				/^(?:\r\n|\r|\n)$/u.test(input.slice(update.end, match.index))
			) {
				operations[operations.length - 1] = { path: update.path, action: "delete" };
				operations.push({ path, action: "create" });
			}
			update = undefined;
			continue;
		}
		let action: NoteAction = "create";
		if (match[1] === "Update File") {
			action = "edit";
		} else if (match[1] === "Delete File") {
			action = "delete";
		}
		operations.push({ path, action });
		update = action === "edit" ? { path, end: match.index + match[0].length } : undefined;
	}
	return operations;
}
function batchOperations(tool: string, files: unknown): NoteOperation[] {
	return (unknownArray(files) ?? []).flatMap<NoteOperation>((file) => {
		if (!isRecord(file) || typeof file.path !== "string") {
			return [];
		}
		if (tool === "replace_text") {
			return [{ path: file.path, action: "edit" }];
		}
		if (file.mode === "create") {
			return [{ path: file.path, action: file.content === "" ? "create-empty" : "create" }];
		}
		return [{ path: file.path, action: file.content === "" ? "clear" : "write" }];
	});
}
function notesAction(args: Readonly<Record<string, unknown>>): NoteAction | undefined {
	switch (args.op) {
		case "write":
			return args.content === "" ? "clear" : "write";
		case "append":
		case "read":
			return args.op;
		default:
			return;
	}
}
function singleOperation(tool: string, args: Readonly<Record<string, unknown>>): NoteOperation[] {
	const path = optionalString(args.path);
	if (path === undefined) {
		return [];
	}
	switch (tool) {
		case "notes": {
			const action = notesAction(args);
			return action === undefined
				? []
				: [{ path, action, scope: optionalString(args.scope) }];
		}
		case "read":
		case "edit":
			return [{ path, action: tool }];
		case "write":
			return [{ path, action: args.content === "" ? "clear" : "write" }];
		default:
			return [];
	}
}
export function noteOperations(tool: string, input: unknown): NoteOperation[] {
	const args = isRecord(input) ? input : {};
	if (args.preview === true || tool === "preview_patch") {
		return [];
	}
	switch (tool) {
		case "apply_patch":
			return patchOperations(typeof input === "string" ? input : args.input);
		case "write_files":
		case "replace_text":
			return batchOperations(tool, args.files);
		default:
			return singleOperation(tool, args);
	}
}
export function noteOperationKind(
	action: NoteAction,
): "read" | "full-write" | "partial-write" | "clear" {
	switch (action) {
		case "read":
			return "read";
		case "write":
		case "create":
			return "full-write";
		case "edit":
		case "append":
			return "partial-write";
		case "clear":
		case "create-empty":
		case "delete":
			return "clear";
	}
}
function committedAction(
	file: unknown,
	operation: NoteOperation | undefined,
	path: string,
): NoteAction {
	if (!isRecord(file)) {
		return operation?.action ?? "edit";
	}
	// modifiedFiles is path-qualified; a partly committed move can still have status "failed".
	if (file.operation === "delete" || (file.operation === "move" && file.path === path)) {
		return "delete";
	}
	if (file.bytesAfter === 0) {
		return "clear";
	}
	return operation?.action ?? "edit";
}
function committedOperations(
	details: Readonly<Record<string, unknown>>,
	operations: readonly NoteOperation[],
): NoteOperation[] | undefined {
	const modified = unknownArray(details.modifiedFiles);
	if (modified === undefined) {
		return;
	}
	const files = unknownArray(details.files) ?? [];
	return modified.flatMap((path) => {
		if (typeof path !== "string") {
			return [];
		}
		const file = files.find(
			(value) => isRecord(value) && (value.path === path || value.moveTo === path),
		);
		const action = committedAction(
			file,
			operations.find((operation) => operation.path === path),
			path,
		);
		return [{ path, action }];
	});
}
/** pi-apply-edits reports committed paths even when a later publication failed. */
export function verifiedNoteOperations(
	tool: string,
	input: unknown,
	result: {
		readonly isError: boolean;
		readonly details: unknown;
	},
): NoteOperation[] {
	const operations = noteOperations(tool, input);
	const details = isRecord(result.details) ? result.details : undefined;
	if (details?.preview === true) {
		return [];
	}
	if (details !== undefined && ["replace_text", "write_files", "apply_patch"].includes(tool)) {
		const committed = committedOperations(details, operations);
		if (committed !== undefined) {
			return committed;
		}
	}
	return result.isError ? [] : operations;
}
