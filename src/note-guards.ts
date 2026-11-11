import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	addressOf,
	canonicalPath,
	sameScope,
	type NoteAddress,
	type NoteTouchRecord,
} from "./note-scopes.ts";
import { mapBatch } from "./note-snapshots.ts";
import { noteOperations, verifiedNoteOperations, type NoteOperation } from "./note-tool-effects.ts";
import type { NoteCall, NotesStore, SessionNotes } from "./note-store.ts";

/** Native core tools expand @/~ paths; pi-apply-edits deliberately treats them literally. */
function toolPath(tool: string, path: string, cwd: string): string {
	if (tool !== "read" && tool !== "write" && tool !== "edit") {
		if (process.platform === "win32") {
			return resolve(cwd, path);
		}
		return isAbsolute(path) ? path : `${cwd}/${path}`;
	}
	let normalized = path
		.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu, " ")
		.replace(/^@/u, "");
	if (normalized === "~" || normalized.startsWith("~/")) {
		normalized = join(homedir(), normalized.slice(1));
	}
	if (normalized.startsWith("file://")) {
		normalized = fileURLToPath(normalized);
	}
	return resolve(cwd, normalized);
}
type CapturedCall = {
	readonly session: SessionNotes;
	readonly call: NoteCall;
	readonly cwd: string;
	readonly tool: string;
};
async function noteAddress(path: string, session: SessionNotes): Promise<NoteAddress | undefined> {
	const known = addressOf(path, session.scopes);
	if (known !== undefined) {
		return known;
	}
	for (const { root } of session.scopes) {
		const parts = relative(root, canonicalPath(path)).split(sep);
		if (
			parts[0] !== ".forks" ||
			parts[1] === undefined ||
			parts[2] !== "notes" ||
			parts.length < 4
		) {
			continue;
		}
		const scope = await session.selectScope(join(root, ".forks", parts[1], "notes"));
		return addressOf(path, [scope]);
	}
	return;
}
function existingEdit(tool: string, operation: NoteOperation): boolean {
	return (
		operation.action === "edit" ||
		operation.action === "delete" ||
		(tool === "write_files" && (operation.action === "write" || operation.action === "clear"))
	);
}
/** An edit of an inherited note in this session's scope applies to its private copy. */
async function prepareOperation(operation: NoteOperation, captured: CapturedCall): Promise<void> {
	if (operation.action === "read") {
		return;
	}
	const { session, call, tool, cwd } = captured;
	const path = toolPath(tool, operation.path, cwd);
	const address = await noteAddress(path, session);
	if (address === undefined || !sameScope(address, session.binding)) {
		return;
	}
	if (existingEdit(tool, operation)) {
		const access = await session.access(address.path, { includeDirectories: false });
		if (access.kind === "inherited") {
			await withFileMutationQueue(path, () => session.adopt(address.path, call));
		}
	}
	await session.prepareWrite();
}
async function recordedFiles(
	operations: readonly NoteOperation[],
	captured: CapturedCall,
): Promise<NoteTouchRecord["files"]> {
	const files: NoteTouchRecord["files"][number][] = [];
	const addresses = await mapBatch(operations, (operation) =>
		noteAddress(toolPath(captured.tool, operation.path, captured.cwd), captured.session),
	);
	for (const [index, operation] of operations.entries()) {
		// Each result belongs to the scope captured before execution, even after /tree.
		const address = addresses[index];
		if (address === undefined) {
			continue;
		}
		let kind: NoteTouchRecord["files"][number]["kind"] = "write";
		switch (operation.action) {
			case "read":
			case "delete":
				kind = operation.action;
				break;
			case "clear":
			case "create-empty":
				kind = "clear";
				break;
			case "append":
			case "create":
			case "edit":
			case "write":
				break;
		}
		files.push({ ...address, kind });
	}
	return files;
}
export function registerNoteGuards(pi: ExtensionAPI, store: NotesStore): void {
	const calls = new Map<string, CapturedCall>();
	pi.on("tool_call", async (event, ctx) => {
		let session: SessionNotes;
		try {
			session = await store.get(ctx);
		} catch {
			// Failed notes initialization skips bookkeeping; the notes tool reports the error itself.
			return;
		}
		const call = session.startCall(event.toolCallId, event.parentToolCallId);
		const captured = { session, call, cwd: ctx.cwd, tool: event.toolName };
		calls.set(event.toolCallId, captured);
		if (event.toolName === "notes") {
			return;
		}
		for (const operation of noteOperations(event.toolName, event.input)) {
			await prepareOperation(operation, captured);
		}
	});
	pi.on("tool_result", async (event) => {
		const captured = calls.get(event.toolCallId);
		if (captured === undefined || event.toolName === "notes") {
			return;
		}
		const details: unknown = event.details;
		const operations = verifiedNoteOperations(event.toolName, event.input, {
			details,
			isError: event.isError,
		});
		captured.session.record(await recordedFiles(operations, captured), captured.call);
	});
	pi.on("tool_execution_end", (event) => {
		calls.get(event.toolCallId)?.session.finishCall(event.toolCallId);
		calls.delete(event.toolCallId);
	});
	pi.on("session_shutdown", () => {
		// A captured call belongs to its tool batch; a shutdown runtime runs no more of it.
		calls.clear();
	});
}
