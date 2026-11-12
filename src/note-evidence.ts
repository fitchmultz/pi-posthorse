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
	/** Active branch in native journal order; later edits and receipts supersede earlier ones. */
	readonly branch: readonly EntryLike[];
	/** Keep each source journal's effect order when combining durable provenance. */
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
	const touches = touchRecords(evidence.allEntries).flatMap((record) => {
		const receipt = receipts.get(record.rootToolCallId);
		const item = shown.get(receipt?.id);
		if (item === undefined) {
			return [];
		}
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
				toolCallId: record.toolCallId,
				inRetained: false,
				owner: record.owner,
			};
		});
	});
	const latest = new Map<string, NoteTouch>();
	for (const touch of touches) {
		const key = JSON.stringify([touch.owner?.id, touch.owner?.timestamp, touchKey(touch)]);
		// Adoption and completion can record the same file in one call. Keep its final effect
		// at its final position without discarding other files adopted by that call.
		latest.delete(key);
		latest.set(key, touch);
	}
	return [...latest.values()];
}
function touchKey(touch: NoteTouch): string {
	return JSON.stringify([
		touch.receiptId ?? touch.entryId,
		touch.toolCallId,
		touch.absPath ?? touch.notePath,
	]);
}
function reconcileTouch(recorded: NoteTouch, inferred: NoteTouch | undefined): NoteTouch {
	if (
		inferred !== undefined &&
		((recorded.kind === "read" && inferred.kind === "read") ||
			(recorded.kind === "observed-write" &&
				(inferred.kind === "full-write" || inferred.kind === "partial-write")))
	) {
		return { ...inferred, owner: recorded.owner };
	}
	return recorded;
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
	const inferredByCall = new Map(legacy.touches.map((touch) => [touchKey(touch), touch]));
	const covered = new Set(recorded.map(touchKey));
	const touches = [
		...legacy.touches.filter((touch) => !covered.has(touchKey(touch))),
		...recorded.map((touch) => reconcileTouch(touch, inferredByCall.get(touchKey(touch)))),
	];
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
		// This session's own file-tool effects keep their recorded address and kind in any scope.
		if (touch.owner !== undefined && sameOwner(touch.owner, recovery.binding.owner)) {
			return touch;
		}
		if (owned.has(touch.notePath)) {
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
