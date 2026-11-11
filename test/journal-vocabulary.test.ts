import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AUTO_HANDOFF_PREFIX,
	BOUNDARY_TYPE,
	LEGACY_WINDOW_TYPE,
	NOTE_RECEIPT,
	REMINDER_TYPE,
	RESET_DEFERRED_TYPE,
	RETAINED_MARKER_PREFIX,
	RETAINED_TAIL_TYPE,
	noteAppendReceipt,
	noteReadHeader,
	noteWriteReceipt,
	notesDirectoryHeader,
	posthorseDetails,
} from "../src/contracts.ts";
import { classifyBoundary } from "../src/boundary.ts";
import { extractNotesResultTarget, notesDirectoryOf } from "../src/recovery-note-touches.ts";
import { journalRetainedIds } from "../src/retained-tail.ts";

const paths = [
	"/workspace/.pi/notes/state.md",
	"/workspace/notes with spaces/task one.md",
	"/workspace/.pi/notes/ü–ićh.md",
	"subdir/state.md",
];

await test("receipt lines the notes tool emits parse back to the same path and kind", () => {
	for (const path of paths) {
		assert.deepEqual(extractNotesResultTarget(noteWriteReceipt(path)), {
			kind: "full-write",
			rawPath: path,
		});
		assert.deepEqual(extractNotesResultTarget(noteAppendReceipt(path)), {
			kind: "partial-write",
			rawPath: path,
		});
	}
	assert.deepEqual(extractNotesResultTarget(noteReadHeader("/workspace/.pi/notes/a.md")), {
		kind: "read",
		rawPath: "/workspace/.pi/notes/a.md",
	});
});

await test("receipt lines parse inside multi-line tool results, not only alone", () => {
	const text = [
		"Leading line.",
		noteWriteReceipt("/workspace/.pi/notes/state.md"),
		"Trailing line.",
	].join("\n");
	assert.deepEqual(extractNotesResultTarget(text), {
		kind: "full-write",
		rawPath: "/workspace/.pi/notes/state.md",
	});
});

await test("the notes directory header parses back to the directory", () => {
	for (const dir of ["/workspace/.pi/notes", "/w/notes with spaces"]) {
		assert.equal(notesDirectoryOf(notesDirectoryHeader(dir)), dir);
	}
	assert.equal(notesDirectoryOf(`No notes yet.`), undefined);
});

await test("journal vocabulary matches the values old journals and hosts carry", () => {
	assert.equal(NOTE_RECEIPT.wrote, "Wrote ");
	assert.equal(NOTE_RECEIPT.appended, "Appended to ");
	assert.equal(NOTE_RECEIPT.file, "File: ");
	assert.equal(NOTE_RECEIPT.directory, "Notes directory: ");
	assert.equal(BOUNDARY_TYPE, "posthorse-boundary");
	assert.equal(RESET_DEFERRED_TYPE, "posthorse-reset-deferred");
	assert.equal(RETAINED_TAIL_TYPE, "posthorse-retained-tail");
	assert.equal(RETAINED_MARKER_PREFIX, "Context rolled over after entry ");
	assert.equal(LEGACY_WINDOW_TYPE, "context-window");
	assert.equal(REMINDER_TYPE, "posthorse-reminder");
	assert.equal(AUTO_HANDOFF_PREFIX, "Automatic context rollover recovery record.");
});

await test("compaction details mark every Posthorse draft and classify by reason", () => {
	assert.deepEqual(posthorseDetails("threshold"), { posthorse: 1, reason: "threshold" });
	assert.equal(
		classifyBoundary({
			type: "compaction",
			id: "c1",
			summary: "Handoff",
			details: posthorseDetails("threshold"),
		})?.kind,
		"automatic",
	);
	assert.equal(
		classifyBoundary({
			type: "compaction",
			id: "c2",
			summary: "Handoff",
			details: { posthorse: 2, reason: "threshold" },
		})?.kind,
		"native",
	);
});

await test("an inert boundary marker is not a boundary and never names a retained tail", () => {
	const sentinel = {
		type: "custom",
		id: "b1",
		customType: BOUNDARY_TYPE,
		data: {},
	};
	assert.equal(classifyBoundary(sentinel), undefined);
	assert.equal(journalRetainedIds([{ type: "message", id: "m1" }, sentinel]), undefined);
	const withCompaction = [
		{ type: "message", id: "m1" },
		sentinel,
		{ type: "compaction", id: "c1", firstKeptEntryId: "m1" },
		{ type: "message", id: "m2" },
	];
	assert.deepEqual(journalRetainedIds(withCompaction), new Set(["m1", "b1"]));
});
