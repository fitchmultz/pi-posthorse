import { join } from "node:path";
import { isRecord, optionalString, type EntryLike, type ProjectedEntry } from "./contracts.ts";
import { contextEdits } from "./history-entries.ts";
import { collectTouches, type NoteTouch, type ScannedNoteEntry } from "./recovery-note-touches.ts";
import {
	addressOf,
	bindingsOf,
	notePath,
	ownedPaths,
	sameOwner,
	sameScope,
	scopeDirectory,
	touchRecords,
	type NoteBinding,
} from "./note-scopes.ts";

export type NotesRecovery = {
	readonly binding: NoteBinding;
	readonly entries: readonly EntryLike[];
};

export type NoteEvidence = {
	readonly branch: readonly EntryLike[];
	readonly allEntries: readonly EntryLike[];
	readonly projected: readonly ProjectedEntry[];
	readonly retained: ReadonlySet<string>;
	readonly directories?: ReadonlySet<string>;
};
/** Compaction removes context, not provenance. Only active-branch edits suppress old receipts. */
function projectedNotes(evidence: NoteEvidence): ScannedNoteEntry[] {
	const edits = contextEdits(evidence.branch);
	const omitted = new Set(
		evidence.projected
			.filter(({ messages }) => messages.length === 0)
			.map(({ sourceEntry }) => sourceEntry.id),
	);
	return evidence.branch.flatMap((entry) => {
		const id = entry.id ?? "";
		const edit = edits.get(id);
		if (omitted.has(id) || edit?.replacement === null) {
			return [];
		}
		const effective =
			edit?.replacement !== undefined && entry.type === "message"
				? { ...entry, message: { ...entry.message, content: edit.replacement.content } }
				: entry;
		return [
			{ entry: effective, entryId: edit?.id ?? id, inRetained: evidence.retained.has(id) },
		];
	});
}
function receiptKey(entry: EntryLike): string | undefined {
	if (entry.type === "message" && entry.message?.role === "toolResult") {
		return entry.message.toolCallId;
	}
	return entry.type === "custom_message" && isRecord(entry.details)
		? optionalString(entry.details.runId)
		: undefined;
}
function effectReceipts(branch: readonly EntryLike[]): ReadonlyMap<string, EntryLike> {
	const receipts = new Map<string, EntryLike>();
	for (const entry of branch) {
		const key = receiptKey(entry);
		if (key !== undefined) {
			// A delivered completion wins over the launch, including when an edit omits it.
			receipts.set(key, entry);
		}
	}
	return receipts;
}
function recordedTouches(
	evidence: NoteEvidence,
	visible: readonly ScannedNoteEntry[],
): NoteTouch[] {
	const receipts = effectReceipts(evidence.branch);
	const shown = new Map(visible.map((item) => [item.entry.id, item]));
	const seen = new Set<string>();
	return touchRecords(evidence.allEntries).flatMap((record) => {
		const receipt = receipts.get(record.rootToolCallId);
		const item = shown.get(receipt?.id);
		const key = `${record.owner.id}\0${record.owner.timestamp}\0${record.toolCallId}`;
		if (item === undefined || seen.has(key)) {
			return [];
		}
		seen.add(key);
		return record.files.map((file): NoteTouch => {
			let kind: NoteTouch["kind"] = "observed-write";
			if (file.kind === "read") {
				kind = "read";
			} else if (file.kind === "delete" || file.kind === "clear") {
				kind = "clear";
			}
			return {
				notePath: file.path,
				absPath: join(scopeDirectory(file), file.path),
				kind,
				entryId: item.entryId,
				receiptId: item.entry.id ?? item.entryId,
				inRetained: false,
				owner: record.owner,
			};
		});
	});
}
function touchKey(touch: NoteTouch): string {
	return JSON.stringify([touch.receiptId ?? touch.entryId, touch.absPath ?? touch.notePath]);
}
export function sessionNoteTouches(evidence: NoteEvidence): {
	readonly touches: readonly NoteTouch[];
	readonly defaultDir: string | undefined;
	readonly visibleIds: ReadonlySet<string>;
} {
	const visible = projectedNotes(evidence);
	const directories = new Set([
		...bindingsOf(evidence.allEntries).map(scopeDirectory),
		...(evidence.directories ?? []),
	]);
	const legacy = collectTouches(visible, directories);
	const recorded = recordedTouches(evidence, visible);
	const recordedByReceipt = new Map(recorded.map((touch) => [touchKey(touch), touch]));
	const covered = new Set<string>();
	const identified = legacy.touches.map((touch) => {
		const key = touchKey(touch);
		covered.add(key);
		return { ...touch, owner: recordedByReceipt.get(key)?.owner };
	});
	const touches = [...identified, ...recorded.filter((touch) => !covered.has(touchKey(touch)))];
	const order = new Map(visible.map((entry, index) => [entry.entry.id ?? entry.entryId, index]));
	touches.sort(
		(a, b) =>
			(order.get(a.receiptId ?? a.entryId) ?? 0) - (order.get(b.receiptId ?? b.entryId) ?? 0),
	);
	return {
		touches,
		defaultDir: legacy.defaultDir,
		visibleIds: new Set(visible.map((item) => item.entry.id ?? "")),
	};
}

/** Inherited history describes source bytes, not necessarily the bytes snapshotted at fork time. */
export function scopeRecoveryTouches(
	touches: readonly NoteTouch[],
	recovery: NotesRecovery | undefined,
): readonly NoteTouch[] {
	if (recovery === undefined || recovery.binding.kind === "project") {
		return touches;
	}
	const owned = ownedPaths(recovery.binding, recovery.entries);
	const scopes = [
		recovery.binding,
		...bindingsOf(recovery.entries),
		...(recovery.binding.source === null ? [] : [recovery.binding.source]),
	];
	return touches.map((touch): NoteTouch => {
		const address = touch.absPath === undefined ? undefined : addressOf(touch.absPath, scopes);
		if (address !== undefined && sameScope(address, recovery.binding)) {
			return touch;
		}
		const currentOwner =
			touch.owner !== undefined && sameOwner(touch.owner, recovery.binding.owner);
		if (owned.has(touch.notePath) && !currentOwner) {
			return {
				...touch,
				absPath: notePath(recovery.binding, touch.notePath),
				kind:
					touch.kind === "read" || touch.kind === "clear" ? touch.kind : "observed-write",
				inRetained: false,
			};
		}
		return address === undefined
			? touch
			: {
					...touch,
					kind: "read",
					referenceScope: scopeDirectory(address),
					inRetained: false,
				};
	});
}
