import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import {
	formatSize,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolCards } from "../ui.ts";
import {
	MAX_PAGE_CHARS,
	requireValue,
	textResult,
	type PolicyContext,
	type TextResult,
} from "./contracts.ts";
import { isBinaryFile, notesRoot, publishFile, readText } from "./files.ts";
import { excerpt, excerptAround } from "./message-text.ts";
import type { PageAccess } from "./paging.ts";

export type NotesParams = {
	readonly op: "list" | "read" | "write" | "append" | "search";
	readonly path?: string;
	readonly content?: string;
	readonly query?: string;
	readonly offset?: number;
};
type NoteFile = { readonly path: string; readonly size: number; readonly mtimeMs: number };
type NoteHits = { readonly rows: string[]; readonly more: boolean; readonly skipped: number };
/** Larger files are logs or evidence rather than notes; reading them would dominate a search. */
const SEARCH_FILE_BYTES = 1024 * 1024;
/** Overlapping reads cut a full search of a 212,000-file notes tree from 39 s to 14 s. */
const SEARCH_BATCH = 16;
/** Search rescans up to the requested offset, so this also caps the matches one call keeps. */
const SEARCH_OFFSET_LIMIT = 1_000_000;
function safeJoin(dir: string, path: string): string {
	const relative = normalize(path.replace(/^[/\\]+/, ""));
	if (relative === ".." || relative.startsWith(`..${sep}`) || isAbsolute(relative)) {
		throw new Error(`Invalid path "${path}": must stay inside .pi/notes/.`);
	}
	return join(dir, relative);
}
function walk(directory: string, ancestors: readonly string[] = []): NoteFile[] {
	const root = realpathSync(directory);
	if (ancestors.includes(root)) {
		return [];
	}
	const next = [...ancestors, root];
	return readdirSync(directory).flatMap((file) => {
		const path = join(directory, file);
		const info = statSync(path, { throwIfNoEntry: false });
		if (info === undefined) {
			return [];
		}
		return info.isDirectory()
			? walk(path, next)
			: [{ path, size: info.size, mtimeMs: info.mtimeMs }];
	});
}
function notesUnder(target: string): NoteFile[] {
	const info = statSync(target, { throwIfNoEntry: false });
	if (info === undefined) {
		return [];
	}
	const files = info.isDirectory()
		? walk(target)
		: [{ path: target, size: info.size, mtimeMs: info.mtimeMs }];
	return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
function listNotes(
	dir: string,
	params: NotesParams,
	host: PolicyContext,
	pages: PageAccess,
): TextResult {
	const folder = params.path;
	const target = folder === undefined || folder === "" ? dir : safeJoin(dir, folder);
	const rows = notesUnder(target).map(
		(file) =>
			`${file.path.slice(dir.length + 1)}  ${formatSize(file.size)}  ${new Date(file.mtimeMs).toISOString().slice(0, 16)}Z`,
	);
	return pages.notes(host, {
		rows,
		offset: params.offset ?? 0,
		kind: "notes-list",
		empty: folder === undefined || folder === "" ? "(no notes yet)" : `(no notes in ${folder})`,
		header: `Notes directory: ${dir}\n`,
	});
}
async function readNote(
	dir: string,
	params: NotesParams,
	getHost: () => PolicyContext,
	pages: PageAccess,
): Promise<TextResult> {
	const relative = requireValue(params.path, "path", params.op);
	const path = safeJoin(dir, relative);
	const info = statSync(path, { throwIfNoEntry: false });
	if (info === undefined) {
		throw new Error(`No note at ${relative}. Use op "list" to see available notes.`);
	}
	if (info.isDirectory()) {
		return listNotes(dir, params, getHost(), pages);
	}
	if (await isBinaryFile(path)) {
		throw new Error(
			`${relative} is a binary file (${formatSize(info.size)}); notes read returns text only.`,
		);
	}
	const text = readFileSync(path, "utf8");
	const offset = params.offset ?? 0;
	if (offset > 0 && offset >= text.length) {
		throw new Error(`Offset ${offset} is past the end of ${relative} (${text.length} chars).`);
	}
	const header = `File: ${path}\n`;
	const host = getHost();
	const chars = pages.size(host, { offset }) - header.length;
	if (chars <= 0) {
		pages.error(
			host,
			`Too little context remains to include the note path. Call new_context first, then retry with offset ${offset}.`,
		);
	}
	const end = Math.min(text.length, offset + chars);
	const more =
		end < text.length
			? `\n[chars ${offset}-${end} of ${text.length}; continue with offset ${end}]`
			: "";
	return pages.result(`${header}${text.slice(offset, end)}${more}`, [], {
		kind: "note-read",
		headerLength: header.length,
		offset,
		end,
		total: text.length,
	});
}
async function writeNote(
	dir: string,
	params: NotesParams,
	signal?: AbortSignal,
): Promise<TextResult> {
	const relative = requireValue(params.path, "path", params.op);
	const content = params.content;
	if (content === undefined) {
		throw new Error('"content" is required for op "write" (use "" to clear a note).');
	}
	const path = safeJoin(dir, relative);
	mkdirSync(dirname(path), { recursive: true });
	await withFileMutationQueue(path, () => publishFile(path, content, signal));
	return textResult(`Wrote ${path}`, [], { kind: "note-write" });
}
async function appendNote(
	dir: string,
	params: NotesParams,
	signal?: AbortSignal,
): Promise<TextResult> {
	const relative = requireValue(params.path, "path", params.op);
	const content = requireValue(params.content, "content", params.op);
	const path = safeJoin(dir, relative);
	mkdirSync(dirname(path), { recursive: true });
	await withFileMutationQueue(path, async () => {
		signal?.throwIfAborted();
		const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
		const separator = existing !== "" && !existing.endsWith("\n") ? "\n" : "";
		// One O_APPEND write keeps records separate across processes. A racing
		// unterminated write can at worst introduce an extra blank separator.
		appendFileSync(path, `${separator}${content.replace(/\n?$/, "\n")}`);
	});
	return textResult(`Appended to ${path}`, [], { kind: "note-append" });
}
/** One note's matching lines as `path:line: excerpt` rows. */
function matchingLines(name: string, text: string, query: string): string[] {
	if (!text.toLowerCase().includes(query)) {
		return [];
	}
	return text.split("\n").flatMap((line, index) => {
		const trimmed = line.trim();
		const match = trimmed.toLowerCase().indexOf(query);
		return match === -1
			? []
			: [`${name}:${index + 1}: ${excerptAround(trimmed, match, 50, 200)}`];
	});
}
/** Matches in newest-first note order, stopping once they pass `limit` characters. */
async function noteHits(
	dir: string,
	query: string,
	limit: number,
	signal?: AbortSignal,
): Promise<NoteHits> {
	const notes = notesUnder(dir);
	const rows: string[] = [];
	let length = -1;
	let skipped = 0;
	for (let start = 0; start < notes.length; start += SEARCH_BATCH) {
		// Batches keep note order, so a search stops within one batch of the page limit.
		// oxlint-disable-next-line no-await-in-loop
		const batch = await Promise.all(
			notes
				.slice(start, start + SEARCH_BATCH)
				.map(async ({ path, size }) =>
					size > SEARCH_FILE_BYTES
						? undefined
						: matchingLines(
								path.slice(dir.length + 1),
								(await readText(path, signal)) ?? "",
								query,
							),
				),
		);
		skipped += batch.filter((found) => found === undefined).length;
		for (const row of batch.flatMap((found) => found ?? [])) {
			rows.push(row);
			length += row.length + 1;
			if (length > limit) {
				return { rows, more: true, skipped };
			}
		}
	}
	return { rows, more: false, skipped };
}
async function searchNotes(
	dir: string,
	params: NotesParams,
	access: { readonly host: PolicyContext; readonly pages: PageAccess },
	signal?: AbortSignal,
): Promise<TextResult> {
	const { host, pages } = access;
	const query = requireValue(params.query, "query", params.op);
	const offset = params.offset ?? 0;
	if (offset >= SEARCH_OFFSET_LIMIT) {
		pages.error(
			host,
			`Notes search pages end before offset ${SEARCH_OFFSET_LIMIT}; search for something more specific.`,
		);
	}
	const hits = await noteHits(dir, query.toLowerCase(), offset + MAX_PAGE_CHARS, signal);
	const skipped = hits.skipped === 1 ? "1 note" : `${hits.skipped} notes`;
	return pages.notes(host, {
		rows: hits.rows,
		more: hits.more,
		offset,
		kind: "notes-search",
		empty: `No notes match "${excerpt(query, 200)}".`,
		header: hits.skipped > 0 ? `[Not searched: ${skipped} over 1 MiB.]\n` : "",
	});
}
export function registerNotes(
	pi: ExtensionAPI,
	policy: (ctx: ExtensionContext) => PolicyContext,
	pages: PageAccess,
): void {
	pi.registerTool({
		name: "notes",
		label: "Notes",
		...toolCards("notes"),
		description:
			"Durable notes shared across Git worktrees and context resets. Ops: list (newest first, size/date; optional folder), read, search (case-insensitive text), write (replace; empty clears), append (one newline-terminated record). list/read/search are paged; continue with the returned offset. list shows the absolute notes directory; read shows the absolute file path. Prefer available file-editing tools for changed sections of one concise current-state note; write for creation or substantial restructuring. Link fuller evidence instead of copying them.",
		promptSnippet: "save and recall durable state that survives context resets",
		parameters: Type.Object({
			op: Type.Union(
				[
					Type.Literal("list"),
					Type.Literal("read"),
					Type.Literal("write"),
					Type.Literal("append"),
					Type.Literal("search"),
				],
				{ description: "Operation to perform" },
			),
			path: Type.Optional(
				Type.String({ description: "Note or folder path relative to .pi/notes/" }),
			),
			content: Type.Optional(
				Type.String({ description: "Full file content (write) or text to add (append)" }),
			),
			query: Type.Optional(
				Type.String({ description: "Substring to find in notes (search)" }),
			),
			offset: Type.Optional(
				Type.Integer({
					description: "Character offset for list/read/search (default 0)",
					minimum: 0,
				}),
			),
		}),
		// Pi's fixed tool contract supplies id, params, signal, updates, and context.
		// oxlint-disable-next-line max-params
		async execute(_id, params, signal, _onUpdate, ctx) {
			const dir = join(notesRoot(ctx.cwd), ".pi", "notes");
			switch (params.op) {
				case "list":
					return listNotes(dir, params, policy(ctx), pages);
				case "read":
					return readNote(dir, params, () => policy(ctx), pages);
				case "write":
					return writeNote(dir, params, signal);
				case "append":
					return appendNote(dir, params, signal);
				case "search":
					return searchNotes(dir, params, { host: policy(ctx), pages }, signal);
			}
		},
	});
}
