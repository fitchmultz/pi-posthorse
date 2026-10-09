import { relative, resolve } from "node:path";
import {
	isReminderType,
	requireValue,
	unknownArray,
	type EntryLike,
	type HistoryHit,
	type ProjectedEntry,
} from "./contracts.ts";
import { historyHit, seenText, reverseWindowEntries } from "./history-entries.ts";
import { shortKey } from "./message-text.ts";
import {
	filesContaining,
	prefilterNeedles,
	scopedSessionFiles,
	sessionWindowEntries,
} from "./session-files.ts";

export type HistoryParams = {
	readonly op: "search" | "read";
	readonly query?: string;
	readonly id?: string;
	readonly all?: boolean;
	readonly limit?: number;
	readonly cursor?: string;
	readonly offset?: number;
	readonly imageOffset?: number;
};
export type HistorySource = {
	readonly dir: string;
	readonly cwd: string;
	readonly currentFile?: string;
	readonly branch: () => readonly EntryLike[];
	readonly projection: () => readonly ProjectedEntry[];
};
export type HistoryCursor = readonly [id: string, priority: 0 | 1, offset: number, key: string];
export type HistoryMatches = {
	readonly hits: readonly HistoryHit[];
	readonly skipped: number;
	readonly cursor?: HistoryCursor;
	readonly key: string;
	readonly limit: number;
};
function cursorOffset(value: unknown, storedKey: unknown, key: string): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		storedKey !== key
	) {
		throw new Error("Invalid cursor offset or scope.");
	}
	return value;
}
function decodeCursor(encoded: string | undefined, key: string): HistoryCursor | undefined {
	if (encoded === undefined || encoded === "") {
		return undefined;
	}
	const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString());
	const parts = unknownArray(value);
	if (parts === undefined || parts.length !== 4) {
		throw new Error("Invalid cursor tuple.");
	}
	const [id, priority, offset, storedKey] = parts;
	if (typeof id !== "string" || id === "" || (priority !== 0 && priority !== 1)) {
		throw new Error("Invalid cursor anchor.");
	}
	return [id, priority, cursorOffset(offset, storedKey, key), key];
}
function entryMessage(entry: EntryLike) {
	switch (entry.type) {
		case "message":
			return entry.message ?? {};
		case "context_edit":
			return { content: entry.replacement?.content };
		case "context_window":
			return { content: entry.handoff };
		case undefined:
			return { content: entry.content, summary: entry.summary };
		default:
			return { content: entry.content, summary: entry.summary };
	}
}
function contextVisibility(projected: readonly ProjectedEntry[]): (entry: EntryLike) => boolean {
	const visible = new Map(
		projected.flatMap(({ sourceEntry, messages }) =>
			sourceEntry.id !== undefined && sourceEntry.id !== "" && messages.length > 0
				? [[sourceEntry.id, messages.map(seenText).join("\n")]]
				: [],
		),
	);
	return (entry) => {
		if (entry.type === "custom_message" && isReminderType(entry.customType)) {
			return false;
		}
		const own = entryMessage(entry);
		const id = entry.type === "context_edit" ? entry.targetId : entry.id;
		return visible.get(id ?? "")?.includes(seenText(own)) === true;
	};
}
type SearchProgress = {
	readonly cursor?: HistoryCursor;
	readonly limit: number;
	readonly add: (hit: HistoryHit) => void;
	readonly seeking: (priority: 0 | 1) => boolean;
	readonly enough: () => boolean;
};
/** Owns ranking, lookahead and one cursor's progress; never holds the whole archive. */
class SearchAccumulator {
	readonly groups: [HistoryHit[], HistoryHit[]] = [[], []];
	readonly cursor: HistoryCursor | undefined;
	readonly limit: number;
	private found: boolean;
	private readonly fail: (message: string) => never;
	constructor(
		limit: number,
		cursor: HistoryCursor | undefined,
		fail: (message: string) => never,
	) {
		this.limit = limit;
		this.cursor = cursor;
		this.found = cursor === undefined;
		this.fail = fail;
	}
	add(hit: HistoryHit): void {
		const cursor = this.cursor;
		if (cursor !== undefined && hit.priority < cursor[1]) {
			return;
		}
		if (cursor !== undefined && hit.priority === cursor[1] && !this.found) {
			if (hit.id !== cursor[0]) {
				return;
			}
			this.found = true;
			if (cursor[2] > hit.text.length) {
				this.fail("History cursor is past the entry; restart the search without it.");
			}
			if (cursor[2] === hit.text.length) {
				return;
			}
		}
		if (this.groups[hit.priority].length <= this.limit) {
			this.groups[hit.priority].push(hit);
		}
	}
	seeking(priority: 0 | 1): boolean {
		return this.cursor !== undefined && !this.found && priority === this.cursor[1];
	}
	enough(): boolean {
		return this.groups[0].length > this.limit;
	}
	results(): HistoryHit[] {
		if (!this.found) {
			this.fail("History cursor entry no longer matches; restart the search without it.");
		}
		return this.groups.flat();
	}
}
function archiveCollector(accumulator: SearchProgress): {
	readonly add: (hit: HistoryHit) => void;
	readonly finish: () => readonly (readonly HistoryHit[])[];
} {
	const recent: [HistoryHit[], HistoryHit[]] = [[], []];
	let anchorHere = false;
	return {
		add: (hit) => {
			const seeking = accumulator.seeking(hit.priority);
			if (seeking && anchorHere) {
				return;
			}
			if (seeking && hit.id === accumulator.cursor?.[0]) {
				anchorHere = true;
			}
			const group = recent[hit.priority];
			group.push(hit);
			if (group.length > accumulator.limit + 2) {
				group.shift();
			}
		},
		finish: () => {
			const cursor = accumulator.cursor;
			if (cursor !== undefined && accumulator.seeking(cursor[1]) && !anchorHere) {
				recent[cursor[1]] = [];
			}
			return recent;
		},
	};
}
async function scanArchive(
	file: string,
	options: {
		readonly source: string;
		readonly query: string;
		readonly signal?: AbortSignal;
		readonly inContext: (entry: EntryLike) => boolean;
	},
	accumulator: SearchProgress,
): Promise<{ readonly groups: readonly (readonly HistoryHit[])[]; readonly skipped: number }> {
	const collector = archiveCollector(accumulator);
	let skipped = 0;
	for await (const item of sessionWindowEntries(file, options.signal)) {
		const hit = historyHit(item, options.query, options.source);
		if (hit === undefined) {
			continue;
		}
		if (options.inContext(item.entry)) {
			skipped++;
		} else {
			collector.add(hit);
		}
	}
	return { groups: collector.finish(), skipped };
}
async function archivedMatches(
	source: HistorySource,
	search: {
		readonly query: string;
		readonly signal?: AbortSignal;
		readonly inContext: (entry: EntryLike) => boolean;
	},
	accumulator: SearchProgress,
): Promise<number> {
	const needles = prefilterNeedles(search.query);
	const candidates =
		needles === undefined
			? undefined
			: await filesContaining(source.dir, needles, search.signal);
	const current =
		source.currentFile === undefined || source.currentFile === ""
			? undefined
			: resolve(source.currentFile);
	let skipped = 0;
	for await (const file of scopedSessionFiles({
		dir: source.dir,
		cwd: source.cwd,
		currentFile: source.currentFile,
		signal: search.signal,
		candidates: candidates === undefined ? undefined : (candidate) => candidates.has(candidate),
	})) {
		const inCurrent = resolve(file) === current;
		const recent = await scanArchive(
			file,
			{
				source: relative(source.dir, file),
				query: search.query,
				signal: search.signal,
				inContext: (entry) => inCurrent && search.inContext(entry),
			},
			accumulator,
		);
		skipped += recent.skipped;
		for (const group of recent.groups) {
			for (const hit of [...group].reverse()) {
				accumulator.add(hit);
			}
		}
		if (accumulator.enough()) {
			break;
		}
	}
	return skipped;
}
function branchMatches(
	source: HistorySource,
	query: string,
	inContext: (entry: EntryLike) => boolean,
	accumulator: SearchProgress,
): number {
	let skipped = 0;
	for (const item of reverseWindowEntries(source.branch())) {
		const hit = historyHit(item, query);
		if (hit === undefined) {
			continue;
		}
		if (inContext(item.entry)) {
			skipped++;
			continue;
		}
		accumulator.add(hit);
		if (accumulator.enough()) {
			break;
		}
	}
	return skipped;
}
export async function historyMatches(
	source: HistorySource,
	params: HistoryParams,
	signal: AbortSignal | undefined,
	fail: (message: string) => never,
): Promise<HistoryMatches> {
	const query = requireValue(params.query, "query", params.op).toLowerCase();
	const limit = params.limit ?? 10;
	const key = shortKey(JSON.stringify([query, params.all === true]));
	let cursor: HistoryCursor | undefined;
	try {
		cursor = decodeCursor(params.cursor, key);
	} catch {
		fail("Invalid history cursor or changed query/scope; restart the search without it.");
	}
	const accumulator = new SearchAccumulator(limit, cursor, fail);
	const inContext = contextVisibility(source.projection());
	const skipped =
		params.all === true
			? await archivedMatches(source, { query, signal, inContext }, accumulator)
			: branchMatches(source, query, inContext, accumulator);
	return { hits: accumulator.results(), skipped, cursor, key, limit };
}
