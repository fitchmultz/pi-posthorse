import { join } from "node:path";
import type { EntryLike, ProjectedEntry } from "./contracts.ts";
import { sessionNoteTouches, scopeRecoveryTouches, type NotesRecovery } from "./note-evidence.ts";
import { scopeDirectory } from "./note-scopes.ts";
import type { NoteTarget, NoteTouch } from "./recovery-note-touches.ts";

const MAX_WRITTEN_NOTES = 4;
const MAX_READ_NOTES = 3;

export type RetainedSpan = { readonly firstId: string; readonly lastId: string };
type ContentProof =
	| { readonly kind: "full"; readonly entryId: string; readonly updatedAt?: string }
	| { readonly kind: "partial"; readonly entryId: string }
	| { readonly kind: "compacted" }
	| { readonly kind: "effect-only" };
type TrackedNote = NoteTarget & {
	readonly entryId: string;
	readonly order: number;
} & (
		| { readonly kind: "read"; readonly inRetained: boolean }
		| { readonly kind: "written"; readonly proof: ContentProof }
	);
type WrittenNote = Extract<TrackedNote, { readonly kind: "written" }>;
type ReadNote = Extract<TrackedNote, { readonly kind: "read" }>;

function applyReadTouch(
	previous: TrackedNote | undefined,
	touch: NoteTouch,
	order: number,
): TrackedNote {
	const target: NoteTarget = {
		notePath: touch.notePath,
		absPath: touch.absPath ?? previous?.absPath,
		referenceScope: touch.referenceScope ?? previous?.referenceScope,
	};
	return previous?.kind === "written"
		? { ...previous, ...target }
		: { ...target, kind: "read", entryId: touch.entryId, inRetained: touch.inRetained, order };
}
function retainedEdit(previous: TrackedNote | undefined, entryId: string): ContentProof {
	return previous?.kind === "written" && previous.proof.kind === "full"
		? { ...previous.proof, updatedAt: entryId }
		: { kind: "partial", entryId };
}
function applyTouch(
	previous: TrackedNote | undefined,
	touch: NoteTouch,
	order: number,
): TrackedNote | undefined {
	let proof: ContentProof;
	switch (touch.kind) {
		case "clear":
			return;
		case "read":
			return applyReadTouch(previous, touch, order);
		case "full-write":
			proof = touch.inRetained
				? { kind: "full", entryId: touch.entryId }
				: { kind: "compacted" };
			break;
		case "partial-write":
			proof = touch.inRetained
				? retainedEdit(previous, touch.entryId)
				: { kind: "compacted" };
			break;
		case "observed-write":
			proof = { kind: "effect-only" };
			break;
	}
	return {
		notePath: touch.notePath,
		absPath: touch.absPath ?? previous?.absPath,
		referenceScope: touch.referenceScope,
		kind: "written",
		entryId: touch.entryId,
		proof,
		order,
	};
}
/** `notes read` resolves a bare name in this session's own notes, so a note elsewhere is named by its path. */
function pathElsewhere(note: TrackedNote, notesDirectory: string | undefined): string | undefined {
	if (note.referenceScope !== undefined) {
		return note.absPath ?? `${note.referenceScope}/${note.notePath}`;
	}
	return note.absPath !== undefined &&
		notesDirectory !== undefined &&
		note.absPath !== join(notesDirectory, note.notePath)
		? note.absPath
		: undefined;
}
function formatNoteLabel(note: TrackedNote, elsewhere: string | undefined): string {
	if (elsewhere !== undefined) {
		return note.referenceScope === undefined ? elsewhere : `${elsewhere} (another notes scope)`;
	}
	return note.absPath !== undefined && note.absPath !== note.notePath
		? `${note.notePath} (${note.absPath})`
		: note.notePath;
}
function formatWrittenNoteLine(
	note: WrittenNote,
	span: RetainedSpan | undefined,
	notesDirectory: string | undefined,
): string {
	const elsewhere = pathElsewhere(note, notesDirectory);
	const label = formatNoteLabel(note, elsewhere);
	const how = elsewhere === undefined ? "" : " on its path";
	const { proof } = note;
	if (proof.kind === "effect-only") {
		return `- Active note (written): ${label} [verified effect at entry ${note.entryId}; full content is not retained — read this note${how} now]`;
	}
	if (span === undefined) {
		return `- Active note (written): ${label} [compacted at entry ${note.entryId} — read this note${how} now]`;
	}
	switch (proof.kind) {
		case "full": {
			const updated =
				proof.updatedAt === undefined ? "" : `, updated at entry ${proof.updatedAt}`;
			return `- Active note (written): ${label} [latest full write is in the retained tail above at entry ${proof.entryId}${updated}]`;
		}
		case "partial":
			return `- Active note (written): ${label} [only partial edits are in the retained tail above at entry ${proof.entryId} — read full note${how} now]`;
		case "compacted":
			return `- Active note (written): ${label} [compacted before entry ${span.firstId} — read this note${how} now]`;
	}
}
function formatReadNoteLine(
	note: ReadNote,
	span: RetainedSpan | undefined,
	notesDirectory: string | undefined,
): string {
	const label = formatNoteLabel(note, pathElsewhere(note, notesDirectory));
	if (span !== undefined && note.inRetained) {
		return `- Referenced note (read): ${label} [read in the retained tail above at entry ${note.entryId}]`;
	}
	return span !== undefined
		? `- Referenced note (read): ${label} [compacted before entry ${span.firstId}]`
		: `- Referenced note (read): ${label} [compacted at entry ${note.entryId}]`;
}
function formatNotesAction(
	primaryWritten: WrittenNote | undefined,
	span: RetainedSpan | undefined,
	notesDirectory: string | undefined,
): string {
	if (primaryWritten === undefined) {
		return "Read the referenced note again if its context is still needed, and keep one current-state note for this task.";
	}
	const elsewhere = pathElsewhere(primaryWritten, notesDirectory);
	const target = elsewhere ?? primaryWritten.notePath;
	if (span !== undefined && primaryWritten.proof.kind === "full") {
		return `Your latest full write to ${target} is already visible above at entry ${primaryWritten.proof.entryId}; do not rewrite it unless new findings after entry ${span.lastId} require it.`;
	}
	const how = elsewhere === undefined ? "notes read or read on its path" : "read on its path";
	return `Read ${target} (${how}) before continuing to restore the saved goal, progress, decisions, and next steps, then keep that note current as work progresses.`;
}
function trackedNotes(
	touches: readonly NoteTouch[],
	defaultDir: string | undefined,
): TrackedNote[] {
	const tracked = new Map<string, TrackedNote>();
	for (const [order, rawTouch] of touches.entries()) {
		const touch =
			rawTouch.absPath === undefined && defaultDir !== undefined
				? { ...rawTouch, absPath: `${defaultDir}/${rawTouch.notePath}` }
				: rawTouch;
		const key = `${touch.referenceScope ?? touch.absPath ?? ""}\0${touch.notePath}`;
		const next = applyTouch(tracked.get(key), touch, order);
		if (next === undefined) {
			tracked.delete(key);
		} else {
			tracked.set(key, next);
		}
	}
	return [...tracked.values()].sort((a, b) => b.order - a.order);
}
type NoteSources = {
	readonly retained: ReadonlySet<string>;
	readonly notes?: NotesRecovery | undefined;
};
function sessionNotes(
	chainEntries: readonly EntryLike[],
	allEntries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	sources: NoteSources,
): { readonly all: readonly TrackedNote[]; readonly notesDirectory: string | undefined } {
	const collected = sessionNoteTouches({
		branch: chainEntries,
		allEntries: sources.notes?.entries ?? allEntries,
		projected,
		retained: sources.retained,
	});
	const touches = scopeRecoveryTouches(collected.touches, sources.notes);
	const { defaultDir } = collected;
	return {
		all: trackedNotes(touches, defaultDir),
		notesDirectory:
			sources.notes === undefined ? defaultDir : scopeDirectory(sources.notes.binding),
	};
}
/**
 * The file path of the note that the record names first, when this session wrote one. The path is
 * absolute whenever the notes directory is known, so the `read` tool opens it from any directory.
 */
export function primaryNotePath(
	chainEntries: readonly EntryLike[],
	allEntries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	sources: NoteSources,
): string | undefined {
	const { all, notesDirectory } = sessionNotes(chainEntries, allEntries, projected, sources);
	const primary = all.find((note) => note.kind === "written");
	return primary === undefined
		? undefined
		: (pathElsewhere(primary, notesDirectory) ?? primary.absPath ?? primary.notePath);
}
export function renderSessionNotes(
	chainEntries: readonly EntryLike[],
	allEntries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	options: NoteSources & {
		readonly span: RetainedSpan | undefined;
		readonly maxChars: number;
	},
): string | undefined {
	const { span, maxChars } = options;
	const { all, notesDirectory } = sessionNotes(chainEntries, allEntries, projected, options);
	if (all.length === 0) {
		return;
	}
	const written = all.filter((note) => note.kind === "written").slice(0, MAX_WRITTEN_NOTES);
	const readOnly = all.filter((note) => note.kind === "read").slice(0, MAX_READ_NOTES);
	const lines = [
		...written.map((note) => formatWrittenNoteLine(note, span, notesDirectory)),
		...readOnly.map((note) => formatReadNoteLine(note, span, notesDirectory)),
	];
	const header = "Task notes in this session:";
	const action = formatNotesAction(written[0], span, notesDirectory);
	const selected: string[] = [];
	for (const line of lines) {
		if ([header, ...selected, line, action].join("\n").length <= maxChars) {
			selected.push(line);
		}
	}
	return selected.length === 0 ? undefined : [header, ...selected, action].join("\n");
}
