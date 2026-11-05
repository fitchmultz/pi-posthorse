import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
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
	requireValue,
	textResult,
	type PolicyContext,
	type TextResult,
} from "./contracts.ts";
import { isBinaryFile, notesDir, publishFile, readText } from "./files.ts";
import { notePath, scopeDirectory } from "./note-scopes.ts";
import type { NoteCall, NotesStore, SessionNotes } from "./note-store.ts";
import { NoteDiscovery, noteLabel } from "./note-discovery.ts";
import { excerpt, excerptAround } from "./message-text.ts";
import type { PageAccess } from "./paging.ts";

export type NotesParams = {
	readonly op: "list" | "read" | "write" | "append" | "search";
	readonly path?: string;
	readonly content?: string;
	readonly query?: string;
	readonly offset?: number;
	readonly scope?: string;
};
type NoteHits = { readonly rows: string[]; readonly more: boolean; readonly skipped: number };
/** Paged operations take a fresh policy snapshot after their filesystem awaits. */
type NotesAccess = {
	readonly host: () => PolicyContext;
	readonly pages: PageAccess;
	readonly signal: AbortSignal | undefined;
	readonly call: NoteCall;
	readonly discovery: NoteDiscovery;
};
/** Larger files are logs or evidence rather than notes; reading them would dominate a search. */
const SEARCH_FILE_BYTES = 1024 * 1024;
/** Overlapping reads cut a full search of a 212,000-file notes tree from 39 s to 14 s. */
const SEARCH_BATCH = 16;
/** Formatting all 212,751 rows of one listing at once stalled Pi for 156-163 ms. */
const FORMAT_BATCH = 10_000;
/** Search rescans up to the requested offset, so this also caps the matches one call keeps. */
const SEARCH_OFFSET_LIMIT = 1_000_000;
async function listNotes(
	session: SessionNotes,
	params: NotesParams,
	access: NotesAccess,
): Promise<TextResult> {
	const { host, pages, signal } = access;
	const folder = params.path;
	const [inventory, selectedScope] = await Promise.all([
		access.discovery.list(session, {
			path: folder,
			scope: params.scope,
			signal,
		}),
		(async () =>
			params.scope === undefined ? undefined : session.selectScope(params.scope))(),
	]);
	const { files } = inventory;
	const dir = selectedScope === undefined ? session.directory : scopeDirectory(selectedScope);
	const rows: string[] = [];
	for (let start = 0; start < files.length; start += FORMAT_BATCH) {
		// Pi gets an event-loop turn before each batch of rows.
		await setImmediate();
		signal?.throwIfAborted();
		for (const file of files.slice(start, start + FORMAT_BATCH)) {
			rows.push(
				`${noteLabel(file, session, inventory.labeled)}  ${formatSize(file.size)}  ${new Date(file.mtimeMs).toISOString().slice(0, 16)}Z`,
			);
		}
	}
	rows.push(...inventory.notices);
	return pages.notes(host(), {
		rows,
		offset: params.offset ?? 0,
		kind: "notes-list",
		empty: folder === undefined || folder === "" ? "(no notes yet)" : `(no notes in ${folder})`,
		header: `Notes directory: ${dir}\n`,
	});
}
async function readNote(
	session: SessionNotes,
	params: NotesParams,
	access: NotesAccess,
): Promise<TextResult> {
	const { pages } = access;
	const relative = requireValue(params.path, "path", params.op);
	const target = await session.read(relative, { scope: params.scope, signal: access.signal });
	const path = target.path;
	const info = statSync(path, { throwIfNoEntry: false });
	if (info === undefined) {
		throw new Error(`No note at ${relative}. Use op "list" to see available notes.`);
	}
	if (info.isDirectory()) {
		return listNotes(session, { ...params, scope: scopeDirectory(target.address) }, access);
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
	const header = target.writable
		? `File: ${path}\n`
		: `Read-only live reference: notes read ${JSON.stringify({ scope: scopeDirectory(target.address), path: target.address.path })}\n`;
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
	session.record([{ ...target.address, kind: "read" }], access.call);
	return pages.result(`${header}${text.slice(offset, end)}${more}`, [], {
		kind: "note-read",
		headerLength: header.length,
		offset,
		end,
		total: text.length,
	});
}
async function writeNote(
	session: SessionNotes,
	params: NotesParams,
	access: NotesAccess,
): Promise<TextResult> {
	const relative = requireValue(params.path, "path", params.op);
	const content = params.content;
	if (content === undefined) {
		throw new Error('"content" is required for op "write" (use "" to clear a note).');
	}
	const path = notePath(session.binding, relative);
	await withFileMutationQueue(path, async () => {
		await session.prepareWrite();
		mkdirSync(dirname(path), { recursive: true });
		await publishFile(path, content, access.signal);
		session.record(
			[
				{
					root: session.binding.root,
					scope: session.binding.scope,
					path: relative,
					kind: content === "" ? "clear" : "write",
				},
			],
			access.call,
		);
	});
	return textResult(`Wrote ${path}`, [], { kind: "note-write" });
}
async function appendNote(
	session: SessionNotes,
	params: NotesParams,
	access: NotesAccess,
): Promise<TextResult> {
	const relative = requireValue(params.path, "path", params.op);
	const content = requireValue(params.content, "content", params.op);
	const path = notePath(session.binding, relative);
	await withFileMutationQueue(path, async () => {
		access.signal?.throwIfAborted();
		await session.adopt(relative, access.call);
		access.signal?.throwIfAborted();
		await session.prepareWrite();
		mkdirSync(dirname(path), { recursive: true });
		const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
		const separator = existing !== "" && !existing.endsWith("\n") ? "\n" : "";
		// One O_APPEND write keeps records separate across processes. A racing
		// unterminated write can at worst introduce an extra blank separator.
		appendFileSync(path, `${separator}${content.replace(/\n?$/, "\n")}`);
		session.record(
			[
				{
					root: session.binding.root,
					scope: session.binding.scope,
					path: relative,
					kind: "write",
				},
			],
			access.call,
		);
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
	session: SessionNotes,
	query: string,
	options: { readonly limit: number; readonly scope: string | undefined },
	access: NotesAccess,
): Promise<NoteHits> {
	const { signal } = access;
	const inventory = await access.discovery.list(session, { scope: options.scope, signal });
	const notes = inventory.files;
	const rows: string[] = [];
	let length = -1;
	let skipped = 0;
	for (let start = 0; start < notes.length; start += SEARCH_BATCH) {
		// A batch of notes over 1 MiB reads nothing that would notice cancellation.
		signal?.throwIfAborted();
		// Batches keep note order, so a search stops within one batch of the page limit.
		const batch = await Promise.all(
			notes
				.slice(start, start + SEARCH_BATCH)
				.map(async (note) =>
					note.size > SEARCH_FILE_BYTES
						? undefined
						: matchingLines(
								noteLabel(note, session, inventory.labeled),
								(await readText(note.path, signal)) ?? "",
								query,
							),
				),
		);
		skipped += batch.filter((found) => found === undefined).length;
		for (const row of batch.flatMap((found) => found ?? [])) {
			rows.push(row);
			length += row.length + 1;
			if (length > options.limit) {
				return { rows, more: true, skipped };
			}
		}
	}
	return { rows: [...rows, ...inventory.notices], more: false, skipped };
}
async function searchNotes(
	session: SessionNotes,
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
	const hits = await noteHits(
		session,
		query.toLowerCase(),
		{ limit: offset + MAX_PAGE_CHARS, scope: params.scope },
		access,
	);
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
	store: NotesStore,
): void {
	const discovery = new NoteDiscovery();
	pi.registerTool({
		name: "notes",
		label: "Notes",
		...toolCards("notes"),
		description:
			"Durable notes across Git worktrees and context resets. Forks own private copies of selected-branch notes. Ops: list (newest first, size/date; optional folder), read, search (case-insensitive text), write (replace; empty clears), append (one newline-terminated record). list/search discover project-wide notes with scope selectors; use scope for read-only comparisons or a single-scope view. Omit scope for current notes and live references. list/read/search are paged; continue with the returned offset. list shows the current writable directory; current-file reads show an editable path, foreign reads a read-only reference. Edit the returned current path for small changes. A blocked foreign edit may have created a private copy: read that copy before retrying. Append adopts unowned references without losing their text. Keep one concise current-state note and link fuller evidence.",
		promptSnippet: "save and recall durable state with private notes for forks",
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
			scope: Type.Optional(
				Type.String({
					description:
						"Absolute scope selector from list/search; only for read/list/search. Omit for current notes and project-wide discovery.",
				}),
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
		async execute(...[_id, params, signal, , ctx]) {
			// Migrate newly returned legacy package notes without changing this session’s binding.
			notesDir(ctx.cwd);
			const session = await store.get(ctx);
			if (params.scope !== undefined && (params.op === "write" || params.op === "append")) {
				throw new Error(
					"scope is only valid for read/list/search; writes use this session’s notes scope.",
				);
			}
			const access: NotesAccess = {
				host: () => policy(ctx),
				pages,
				signal,
				call: session.call(_id),
				discovery,
			};
			switch (params.op) {
				case "list":
					return listNotes(session, params, access);
				case "read":
					return params.path === "."
						? listNotes(session, params, access)
						: readNote(session, params, access);
				case "write":
					return writeNote(session, params, access);
				case "append":
					return appendNote(session, params, access);
				case "search":
					return searchNotes(session, params, access);
			}
		},
	});
}
