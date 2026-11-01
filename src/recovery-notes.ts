import type { EntryLike, ProjectedEntry } from "./contracts.ts";
import { contextEdits } from "./history-entries.ts";
import {
	collectTouches,
	type ScannedNoteEntry,
	type NoteTarget,
	type NoteTouch,
} from "./recovery-note-touches.ts";

const MAX_WRITTEN_NOTES = 4;
const MAX_READ_NOTES = 3;

export type RetainedSpan = { readonly firstId: string; readonly lastId: string };
type TrackedNote = NoteTarget & {
	readonly written: boolean;
	readonly lastEntryId: string;
	readonly lastInRetained: boolean;
	readonly lastWriteEntryId?: string | undefined;
	readonly fullWriteRetainedEntryId?: string | undefined;
	readonly partialEditRetainedEntryId?: string | undefined;
	readonly order: number;
};
function applyReadTouch(
	previous: TrackedNote | undefined,
	touch: NoteTouch,
	order: number,
): TrackedNote {
	const wasWritten = previous?.written === true;
	return {
		notePath: touch.notePath,
		absPath: touch.absPath ?? previous?.absPath,
		written: wasWritten,
		lastEntryId: touch.entryId,
		lastInRetained: touch.inRetained,
		lastWriteEntryId: previous?.lastWriteEntryId,
		fullWriteRetainedEntryId: previous?.fullWriteRetainedEntryId,
		partialEditRetainedEntryId: previous?.partialEditRetainedEntryId,
		order: wasWritten ? previous.order : order,
	};
}

function applyWriteTouch(
	previous: TrackedNote | undefined,
	touch: NoteTouch,
	order: number,
): TrackedNote {
	return {
		notePath: touch.notePath,
		absPath: touch.absPath ?? previous?.absPath,
		written: true,
		lastEntryId: touch.entryId,
		lastInRetained: touch.inRetained,
		lastWriteEntryId: touch.entryId,
		fullWriteRetainedEntryId:
			touch.kind === "full-write" && touch.inRetained
				? touch.entryId
				: previous?.fullWriteRetainedEntryId,
		partialEditRetainedEntryId:
			touch.kind === "partial-write" && touch.inRetained
				? touch.entryId
				: previous?.partialEditRetainedEntryId,
		order,
	};
}

function formatNoteLabel(note: TrackedNote): string {
	return note.absPath !== undefined && note.absPath !== note.notePath
		? `${note.notePath} (${note.absPath})`
		: note.notePath;
}

function formatWrittenNoteLine(note: TrackedNote, span: RetainedSpan | undefined): string {
	const label = formatNoteLabel(note);
	const writeId = note.lastWriteEntryId ?? note.lastEntryId;
	if (span === undefined) {
		return `- Active note (written): ${label} [compacted at entry ${writeId} — read this note now]`;
	}
	if (note.fullWriteRetainedEntryId !== undefined) {
		const updated =
			note.partialEditRetainedEntryId !== undefined &&
			note.lastWriteEntryId === note.partialEditRetainedEntryId
				? `, updated at entry ${note.partialEditRetainedEntryId}`
				: "";
		return `- Active note (written): ${label} [latest full write is in the retained tail above at entry ${note.fullWriteRetainedEntryId}${updated}]`;
	}
	if (note.partialEditRetainedEntryId !== undefined) {
		return `- Active note (written): ${label} [only partial edits are in the retained tail above at entry ${note.partialEditRetainedEntryId} — read full note now]`;
	}
	return `- Active note (written): ${label} [compacted before entry ${span.firstId} — read this note now]`;
}

function formatReadNoteLine(note: TrackedNote, span: RetainedSpan | undefined): string {
	const label = formatNoteLabel(note);
	if (span !== undefined && note.lastInRetained) {
		return `- Referenced note (read): ${label} [read in the retained tail above at entry ${note.lastEntryId}]`;
	}
	return span !== undefined
		? `- Referenced note (read): ${label} [compacted before entry ${span.firstId}]`
		: `- Referenced note (read): ${label} [compacted at entry ${note.lastEntryId}]`;
}

function formatNotesAction(
	primaryWritten: TrackedNote | undefined,
	span: RetainedSpan | undefined,
): string {
	if (primaryWritten === undefined) {
		return "Read the referenced note again if its context is still needed, and keep one current-state note for this task.";
	}
	if (span !== undefined && primaryWritten.fullWriteRetainedEntryId !== undefined) {
		return `Your latest full write to ${primaryWritten.notePath} is already visible above at entry ${primaryWritten.fullWriteRetainedEntryId}; do not rewrite it unless new findings after entry ${span.lastId} require it.`;
	}
	return `Read ${primaryWritten.notePath} (notes read or read on its path) before continuing to restore the saved goal, progress, decisions, and next steps, then keep that note current as work progresses.`;
}

function projectNoteEntries(
	chainEntries: readonly EntryLike[],
	allEntries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	retained: ReadonlySet<string>,
): ScannedNoteEntry[] {
	const edits = contextEdits(allEntries);
	const omittedIds = new Set(
		projected
			.filter(({ messages }) => messages.length === 0)
			.map(({ sourceEntry }) => sourceEntry.id),
	);
	return chainEntries.flatMap((entry) => {
		const rawId = entry.id ?? "";
		const edit = edits.get(rawId);
		if (omittedIds.has(rawId) || edit?.replacement === null) {
			return [];
		}
		const effective =
			edit?.replacement !== undefined && entry.type === "message"
				? {
						...entry,
						id: edit.id,
						message: { ...entry.message, content: edit.replacement.content },
					}
				: entry;
		const resolvedId = (effective.id ?? rawId).slice(0, 120);
		return [
			{
				entry: effective,
				entryId: resolvedId === "" ? "unknown" : resolvedId,
				inRetained: retained.has(rawId),
			},
		];
	});
}

export function renderSessionNotes(
	chainEntries: readonly EntryLike[],
	allEntries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	options: {
		readonly retained: ReadonlySet<string>;
		readonly span: RetainedSpan | undefined;
		readonly maxChars: number;
	},
): string | undefined {
	const { retained, span, maxChars } = options;
	const entries = projectNoteEntries(chainEntries, allEntries, projected, retained);
	const { touches, defaultDir } = collectTouches(entries);
	const tracked = new Map<string, TrackedNote>();
	let order = 0;
	for (const rawTouch of touches) {
		order += 1;
		const touch =
			rawTouch.absPath === undefined && defaultDir !== undefined
				? { ...rawTouch, absPath: `${defaultDir}/${rawTouch.notePath}` }
				: rawTouch;
		if (touch.kind === "clear") {
			tracked.delete(touch.notePath);
		} else if (touch.kind === "read") {
			tracked.set(touch.notePath, applyReadTouch(tracked.get(touch.notePath), touch, order));
		} else {
			tracked.set(touch.notePath, applyWriteTouch(tracked.get(touch.notePath), touch, order));
		}
	}
	if (tracked.size === 0) {
		return undefined;
	}
	const all = [...tracked.values()].sort((a, b) => b.order - a.order);
	const written = all.filter((note) => note.written).slice(0, MAX_WRITTEN_NOTES);
	const readOnly = all.filter((note) => !note.written).slice(0, MAX_READ_NOTES);
	const lines = [
		...written.map((note) => formatWrittenNoteLine(note, span)),
		...readOnly.map((note) => formatReadNoteLine(note, span)),
	];
	const header = "Task notes in this session:";
	const action = formatNotesAction(written[0], span);
	const selected: string[] = [];
	for (const line of lines) {
		if ([header, ...selected, line, action].join("\n").length <= maxChars) {
			selected.push(line);
		}
	}
	return selected.length === 0 ? undefined : [header, ...selected, action].join("\n");
}
