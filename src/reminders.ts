import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	isRecord,
	isReminderType,
	type EntryLike,
	type ProjectedEntry,
	type ReminderFingerprint,
} from "./contracts.ts";
import { contextEdits, contextStart, isWindow } from "./history-entries.ts";

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
export type StaleReminderPredicate = (message: {
	readonly role: string;
	readonly customType?: string;
	readonly details?: unknown;
}) => boolean;

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

function retainedEntryIdSet(branch: readonly EntryLike[]): ReadonlySet<string> | undefined {
	const compactionIdx = branch.findLastIndex((entry) => entry.type === "compaction");
	const firstKeptId = compactionIdx > 0 ? branch[compactionIdx]?.firstKeptEntryId : undefined;
	if (typeof firstKeptId !== "string" || firstKeptId === "") {
		return undefined;
	}
	const firstKeptIdx = branch.findIndex((entry) => entry.id === firstKeptId);
	if (firstKeptIdx < 0 || firstKeptIdx >= compactionIdx) {
		return undefined;
	}
	return new Set(
		branch
			.slice(firstKeptIdx, compactionIdx)
			.flatMap((entry) =>
				typeof entry.id === "string" && entry.id !== "" ? [entry.id] : [],
			),
	);
}

function countRetainedFromProjected(
	projected: readonly ProjectedEntry[],
	retainedIds: ReadonlySet<string>,
	stale: StaleReminderPredicate,
): number {
	let count = 0;
	for (const item of projected) {
		if (!retainedIds.has(item.sourceEntry.id ?? "")) {
			continue;
		}
		for (const msg of item.messages) {
			const role = msg.role ?? "";
			if (
				role !== "system" &&
				!stale({ role, customType: msg.customType, details: msg.details })
			) {
				count += 1;
			}
		}
	}
	return count;
}

function entryProducesRetainedMessage(
	entry: EntryLike,
	edits: ReadonlyMap<string, EntryLike>,
	stale: StaleReminderPredicate,
): boolean {
	if (edits.get(entry.id ?? "")?.replacement === null) {
		return false;
	}
	if (entry.type === "message") {
		return entry.message?.role !== "system" && entry.message?.excludeFromContext !== true;
	}
	if (entry.type === "custom_message") {
		return !stale({ role: "custom", customType: entry.customType, details: entry.details });
	}
	return entry.type === "branch_summary";
}

export function countRetainedMessages(
	ctx: ExtensionContext,
	stale: StaleReminderPredicate,
): number {
	const manager: unknown = ctx.sessionManager;
	const branch: readonly EntryLike[] =
		isRecord(manager) && typeof manager.getBranch === "function"
			? ctx.sessionManager.getBranch()
			: [];
	const retainedIds = retainedEntryIdSet(branch);
	if (retainedIds === undefined || retainedIds.size === 0) {
		return 0;
	}
	if (isRecord(manager) && typeof manager.buildSessionProjection === "function") {
		return countRetainedFromProjected(
			ctx.sessionManager.buildSessionProjection().entries,
			retainedIds,
			stale,
		);
	}
	const edits = contextEdits(branch);
	return branch.filter(
		(entry) =>
			retainedIds.has(entry.id ?? "") && entryProducesRetainedMessage(entry, edits, stale),
	).length;
}
