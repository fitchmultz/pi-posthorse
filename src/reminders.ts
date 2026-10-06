import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord, isReminderType, type EntryLike, type ReminderFingerprint } from "./contracts.ts";
import { contextStart, isWindow } from "./history-entries.ts";

type ReminderState = {
	readonly manager: ExtensionContext["sessionManager"];
	readonly sessionId: string;
	readonly file: string | undefined;
	readonly leaf: EntryLike | undefined;
	readonly windowId: string;
	readonly reminders: readonly EntryLike[];
};
export type ReminderLookup = {
	readonly reset: () => void;
	readonly read: (ctx: ExtensionContext) => ReminderState;
};
export function reminderMatches(details: unknown, fingerprint: ReminderFingerprint): boolean {
	if (!isRecord(details)) {
		return false;
	}
	return (
		details.windowId === fingerprint.windowId &&
		details.contextWindow === fingerprint.contextWindow &&
		details.reserveTokens === fingerprint.reserveTokens
	);
}
export function hasReminder(
	entries: readonly EntryLike[],
	fingerprint: ReminderFingerprint,
): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom_message" &&
			isReminderType(entry.customType) &&
			reminderMatches(entry.details, fingerprint),
	);
}
function onlyReminders(entries: readonly EntryLike[]): EntryLike[] {
	return entries.filter(
		(entry) => entry.type === "custom_message" && isReminderType(entry.customType),
	);
}
type ScanProgress = {
	readonly boundary?: EntryLike;
	readonly window?: EntryLike;
	readonly kept: boolean;
};
function advanceBoundary(entry: EntryLike, progress: ScanProgress): ScanProgress {
	const boundary =
		progress.boundary ??
		(entry.type === "compaction" || entry.type === "context_window" ? entry : undefined);
	const window = progress.window ?? (isWindow(entry) ? entry : undefined);
	const kept =
		progress.kept ||
		(boundary !== undefined &&
			(boundary.type === "context_window" || entry.id === boundary.firstKeptEntryId));
	return { boundary, window, kept };
}
function parentEntry(
	manager: ExtensionContext["sessionManager"],
	id: string | null | undefined,
): EntryLike | undefined {
	return id === undefined || id === null || id === "" ? undefined : manager.getEntry(id);
}
function scanAncestry(
	manager: ExtensionContext["sessionManager"],
	leaf: EntryLike | undefined,
	previous: ReminderState | undefined,
): { readonly windowId: string; readonly reminders: readonly EntryLike[] } {
	const reversed: EntryLike[] = [];
	let progress: ScanProgress = { kept: false };
	for (let entry = leaf; entry !== undefined; entry = parentEntry(manager, entry.parentId)) {
		// Entry identity, not a reusable id, certifies an append-only extension of this leaf.
		if (progress.boundary === undefined && previous !== undefined && previous.leaf === entry) {
			return {
				windowId: previous.windowId,
				reminders: [...previous.reminders, ...onlyReminders(reversed.reverse())],
			};
		}
		reversed.push(entry);
		progress = advanceBoundary(entry, progress);
		// Native compaction may keep a tail before the Posthorse boundary. Negative lookups reach root once.
		if (progress.window !== undefined && progress.kept) {
			break;
		}
	}
	const entries = reversed.reverse();
	return {
		windowId: progress.window?.id ?? "initial",
		reminders: onlyReminders(entries.slice(contextStart(entries).start)),
	};
}
/** This cache owns only leaf-certified branch facts; session/tree changes invalidate them. */
export function createReminderLookup(): ReminderLookup {
	let state: ReminderState | undefined;
	return {
		reset: () => {
			state = undefined;
		},
		read: (ctx) => {
			const manager = ctx.sessionManager;
			const sessionId = manager.getSessionId();
			const file = manager.getSessionFile();
			const leaf = manager.getEntry(manager.getLeafId() ?? "");
			const previous =
				state?.manager === manager && state.sessionId === sessionId && state.file === file
					? state
					: undefined;
			if (previous !== undefined && previous.leaf === leaf) {
				return previous;
			}
			state = { manager, sessionId, file, leaf, ...scanAncestry(manager, leaf, previous) };
			return state;
		},
	};
}
