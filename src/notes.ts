import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { setImmediate } from "node:timers/promises";
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
	isRecord,
	requireValue,
	textResult,
	type PolicyContext,
	type TextResult,
} from "./contracts.ts";
import { isBinaryFile, notesDir, publishFile, readText } from "./files.ts";
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
/** Paged operations take a fresh policy snapshot after their filesystem awaits. */
type NotesAccess = {
	readonly host: () => PolicyContext;
	readonly pages: PageAccess;
	readonly signal: AbortSignal | undefined;
};
/** Larger files are logs or evidence rather than notes; reading them would dominate a search. */
const SEARCH_FILE_BYTES = 1024 * 1024;
/** Overlapping reads cut a full search of a 212,000-file notes tree from 39 s to 14 s. */
const SEARCH_BATCH = 16;
/**
 * Maximum explicit `stat` calls overlapped per batch. On a 212,751-note tree, 16, 64 and 256 took
 * equal time within host noise. The walk enters one folder at a time, so this bounds our pending
 * `stat` calls at any depth. On filesystems that report unknown entry types, Node 24's
 * `readdir({ withFileTypes: true })` also issues its own `lstat` for every entry at once.
 */
const WALK_BATCH = 64;
/** Formatting all 212,751 rows of one listing at once stalled Pi for 156-163 ms. */
const FORMAT_BATCH = 10_000;
/** Search rescans up to the requested offset, so this also caps the matches one call keeps. */
const SEARCH_OFFSET_LIMIT = 1_000_000;
function safeJoin(dir: string, path: string): string {
	const relative = normalize(path.replace(/^[/\\]+/, ""));
	if (relative === ".." || relative.startsWith(`..${sep}`) || isAbsolute(relative)) {
		throw new Error(`Invalid path "${path}": must stay inside the notes directory.`);
	}
	return join(dir, relative);
}
/** Like `statSync(path, { throwIfNoEntry: false })`: an entry deleted mid-walk is skipped. */
async function statIfPresent(path: string) {
	try {
		return await stat(path);
	} catch (error) {
		if (isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
			return;
		}
		throw error;
	}
}
/** A folder's present entries in listing order. */
async function* folderEntries(directory: string, signal: AbortSignal | undefined) {
	const entries = await readdir(directory, { withFileTypes: true });
	let start = 0;
	while (start < entries.length) {
		signal?.throwIfAborted();
		const batch = entries.slice(start, start + WALK_BATCH);
		const firstFolder = batch.findIndex(
			(entry) => entry.isDirectory() || entry.isSymbolicLink(),
		);
		const paths = batch
			.slice(0, firstFolder === -1 ? batch.length : firstFolder + 1)
			.map((entry) => join(directory, entry.name));
		// Stats overlap only up to the next entry that may be a folder.
		// oxlint-disable-next-line no-await-in-loop
		const infos = await Promise.all(paths.map(statIfPresent));
		for (const [index, path] of paths.entries()) {
			start += 1;
			const info = infos[index];
			if (info !== undefined) {
				yield { path, info };
			}
			if (info?.isDirectory() === true) {
				// Stat later entries only after this folder's subtree is walked, discarding any
				// already taken, so entries removed meanwhile are skipped.
				break;
			}
		}
	}
}
/** Files depth-first in directory-listing order, yielding between filesystem calls. */
async function walk(
	directory: string,
	signal: AbortSignal | undefined,
	ancestors: readonly string[] = [],
): Promise<NoteFile[]> {
	signal?.throwIfAborted();
	const root = await realpath(directory);
	if (ancestors.includes(root)) {
		return [];
	}
	const next = [...ancestors, root];
	const files: NoteFile[] = [];
	for await (const { path, info } of folderEntries(directory, signal)) {
		if (info.isDirectory()) {
			for (const file of await walk(path, signal, next)) {
				files.push(file);
			}
		} else {
			files.push({ path, size: info.size, mtimeMs: info.mtimeMs });
		}
	}
	return files;
}
async function notesUnder(target: string, signal: AbortSignal | undefined): Promise<NoteFile[]> {
	const info = await statIfPresent(target);
	signal?.throwIfAborted();
	if (info === undefined) {
		return [];
	}
	const files = info.isDirectory()
		? await walk(target, signal)
		: [{ path: target, size: info.size, mtimeMs: info.mtimeMs }];
	signal?.throwIfAborted();
	return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
async function listNotes(
	dir: string,
	params: NotesParams,
	access: NotesAccess,
): Promise<TextResult> {
	const { host, pages, signal } = access;
	const folder = params.path;
	const target = folder === undefined || folder === "" ? dir : safeJoin(dir, folder);
	const files = await notesUnder(target, signal);
	const rows: string[] = [];
	for (let start = 0; start < files.length; start += FORMAT_BATCH) {
		// Pi gets an event-loop turn before each batch of rows.
		// oxlint-disable-next-line no-await-in-loop
		await setImmediate();
		signal?.throwIfAborted();
		for (const file of files.slice(start, start + FORMAT_BATCH)) {
			rows.push(
				`${file.path.slice(dir.length + 1)}  ${formatSize(file.size)}  ${new Date(file.mtimeMs).toISOString().slice(0, 16)}Z`,
			);
		}
	}
	return pages.notes(host(), {
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
	access: NotesAccess,
): Promise<TextResult> {
	const { pages } = access;
	const relative = requireValue(params.path, "path", params.op);
	const path = safeJoin(dir, relative);
	const info = statSync(path, { throwIfNoEntry: false });
	if (info === undefined) {
		throw new Error(`No note at ${relative}. Use op "list" to see available notes.`);
	}
	if (info.isDirectory()) {
		return listNotes(dir, params, access);
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
	const host = access.host();
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
	const notes = await notesUnder(dir, signal);
	const rows: string[] = [];
	let length = -1;
	let skipped = 0;
	for (let start = 0; start < notes.length; start += SEARCH_BATCH) {
		// A batch of notes over 1 MiB reads nothing that would notice cancellation.
		signal?.throwIfAborted();
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
	access: NotesAccess,
): Promise<TextResult> {
	const { host, pages } = access;
	const query = requireValue(params.query, "query", params.op);
	const offset = params.offset ?? 0;
	if (offset >= SEARCH_OFFSET_LIMIT) {
		pages.error(
			host(),
			`Notes search pages end before offset ${SEARCH_OFFSET_LIMIT}; search for something more specific.`,
		);
	}
	const hits = await noteHits(dir, query.toLowerCase(), offset + MAX_PAGE_CHARS, access.signal);
	const skipped = hits.skipped === 1 ? "1 note" : `${hits.skipped} notes`;
	return pages.notes(host(), {
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
				Type.String({ description: "Note or folder path relative to the notes directory" }),
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
			const dir = notesDir(ctx.cwd);
			const access: NotesAccess = { host: () => policy(ctx), pages, signal };
			switch (params.op) {
				case "list":
					return listNotes(dir, params, access);
				case "read":
					return readNote(dir, params, access);
				case "write":
					return writeNote(dir, params, signal);
				case "append":
					return appendNote(dir, params, signal);
				case "search":
					return searchNotes(dir, params, access);
			}
		},
	});
}
