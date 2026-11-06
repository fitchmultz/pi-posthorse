import { relative, resolve } from "node:path";
import type { LineMatcher } from "./session-lines.ts";
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
	needleLines,
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
	readonly currentFile?: string | undefined;
	readonly branch: () => readonly EntryLike[];
	readonly projection: () => readonly ProjectedEntry[];
};
export type HistoryCursor = readonly [id: string, priority: 0 | 1, offset: number, key: string];
export type HistoryMatches = {
	readonly hits: readonly HistoryHit[];
	readonly skipped: number;
	readonly cursor?: HistoryCursor | undefined;
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
function contextVisibility(project: HistorySource["projection"]): (entry: EntryLike) => boolean {
	let visible: Map<string, ProjectedEntry["messages"] | string> | undefined;
	return (entry) => {
		if (entry.type === "custom_message" && isReminderType(entry.customType)) {
			return false;
		}
		// Pi owns edits and compaction; only matching candidates need their projected text.
		visible ??= new Map(
			project().flatMap(({ sourceEntry, messages }) =>
				sourceEntry.id !== undefined && sourceEntry.id !== "" && messages.length > 0
					? [[sourceEntry.id, messages]]
					: [],
			),
		);
		const id = (entry.type === "context_edit" ? entry.targetId : entry.id) ?? "";
		let text = visible.get(id);
		if (text === undefined) {
			return false;
		}
		if (typeof text !== "string") {
			text = text.map(seenText).join("\n");
			visible.set(id, text);
		}
		return text.includes(seenText(entryMessage(entry)));
	};
}
type SearchProgress = {
	readonly cursor?: HistoryCursor | undefined;
	readonly limit: number;
	readonly add: (hit: HistoryHit) => void;
	readonly seeking: (priority: 0 | 1) => boolean;
	readonly enough: () => boolean;
};
type CursorProgress =
	| { readonly kind: "seeking"; readonly cursor: HistoryCursor }
	| { readonly kind: "collecting"; readonly cursor?: HistoryCursor };
/** Owns ranking, lookahead and one cursor's progress; never holds the whole archive. */
class SearchAccumulator {
	readonly groups: [HistoryHit[], HistoryHit[]] = [[], []];
	readonly limit: number;
	private progress: CursorProgress;
	private readonly fail: (message: string) => never;
	constructor(
		limit: number,
		cursor: HistoryCursor | undefined,
		fail: (message: string) => never,
	) {
		this.limit = limit;
		this.progress = cursor === undefined ? { kind: "collecting" } : { kind: "seeking", cursor };
		this.fail = fail;
	}
	get cursor(): HistoryCursor | undefined {
		return this.progress.cursor;
	}
	add(hit: HistoryHit): void {
		const progress = this.progress;
		const cursor = progress.cursor;
		if (cursor !== undefined && hit.priority < cursor[1]) {
			return;
		}
		if (progress.kind === "seeking" && hit.priority === progress.cursor[1]) {
			if (hit.id !== progress.cursor[0]) {
				return;
			}
			if (progress.cursor[2] > hit.text.length) {
				this.fail("History cursor is past the entry; restart the search without it.");
			}
			this.progress = { kind: "collecting", cursor: progress.cursor };
			if (progress.cursor[2] === hit.text.length) {
				return;
			}
		}
		if (this.groups[hit.priority].length <= this.limit) {
			this.groups[hit.priority].push(hit);
		}
	}
	seeking(priority: 0 | 1): boolean {
		return this.progress.kind === "seeking" && priority === this.progress.cursor[1];
	}
	enough(): boolean {
		return this.groups[0].length > this.limit;
	}
	results(): HistoryHit[] {
		if (this.progress.kind === "seeking") {
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
		readonly signal?: AbortSignal | undefined;
		readonly wanted?: LineMatcher | undefined;
		readonly inContext: (entry: EntryLike) => boolean;
	},
	accumulator: SearchProgress,
): Promise<{ readonly groups: readonly (readonly HistoryHit[])[]; readonly skipped: number }> {
	const collector = archiveCollector(accumulator);
	let skipped = 0;
	for await (const item of sessionWindowEntries(
		file,
		options.signal,
		undefined,
		options.wanted,
	)) {
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
		readonly signal?: AbortSignal | undefined;
		readonly inContext: (entry: EntryLike) => boolean;
	},
	accumulator: SearchProgress,
): Promise<number> {
	const needles = prefilterNeedles(search.query);
	const wanted = needles === undefined ? undefined : needleLines(needles);
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
		needles,
	})) {
		const inCurrent = resolve(file) === current;
		const recent = await scanArchive(
			file,
			{
				source: relative(source.dir, file),
				query: search.query,
				signal: search.signal,
				wanted,
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
	// Archive scans await I/O; keep their visibility snapshot at invocation time.
	const projected = params.all === true ? source.projection() : undefined;
	const inContext = contextVisibility(() => projected ?? source.projection());
	const skipped =
		params.all === true
			? await archivedMatches(source, { query, signal, inContext }, accumulator)
			: branchMatches(source, query, inContext, accumulator);
	return { hits: accumulator.results(), skipped, cursor, key, limit };
}
