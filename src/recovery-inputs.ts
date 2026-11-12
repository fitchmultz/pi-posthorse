import type { EntryLike, ProjectedEntry } from "./contracts.ts";
import { chainsAncestry, contextStart } from "./boundary.ts";
import { contextEdits } from "./history-entries.ts";
import { toolCalls } from "./message-text.ts";
import {
	formatRecord,
	MAX_RECOVERY_RECORD_CHARS,
	recoveryRecord,
	type RecoveryRecord,
} from "./recovery-records.ts";

/** One input's room as a share of the whole record: 4,000 of the 20,000 characters a record may have. */
const RECORD_SHARE = 5;

function projectedCurrent(
	entries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	current: readonly EntryLike[] = entries.slice(contextStart(entries).start),
	retained: ReadonlySet<string> = new Set(),
): EntryLike[] {
	const edits = contextEdits(entries);
	const omittedIds = new Set(
		projected
			.filter(({ messages }) => messages.length === 0)
			.map(({ sourceEntry }) => sourceEntry.id),
	);
	return current.flatMap((entry) => {
		const id = entry.id ?? "";
		if (retained.has(id) || omittedIds.has(id)) {
			return [];
		}
		const edit = edits.get(id);
		if (edit?.replacement === null) {
			return [];
		}
		if (edit?.replacement === undefined) {
			return [entry];
		}
		if (entry.type === "message") {
			return [
				{
					...entry,
					id: edit.id,
					message: { ...entry.message, content: edit.replacement.content },
				},
			];
		}
		if (entry.type === "custom_message") {
			return [{ ...entry, id: edit.id, content: edit.replacement.content }];
		}
		return [entry];
	});
}
function ownerRecords(
	entries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	ownerQuestionRegistered: boolean,
): RecoveryRecord[] {
	const calls = new Map(
		projected.flatMap(({ messages }) =>
			messages.flatMap((message) =>
				message.role === "assistant"
					? toolCalls(message.content).map((call) => [call.id, call] as const)
					: [],
			),
		),
	);
	return entries.flatMap((entry) => {
		const call = calls.get(entry.message?.toolCallId);
		const record = recoveryRecord(
			entry,
			ownerQuestionRegistered &&
				call?.name === "ask_question" &&
				call.namespace === undefined,
		);
		return record === undefined ? [] : [record];
	});
}
function anchors(records: readonly RecoveryRecord[]): {
	fixed: RecoveryRecord[];
	others: RecoveryRecord[];
} {
	const firstOwner = records.find((record) => record.label === "owner input") ?? records[0];
	const latestOwner = [...records].reverse().find((record) => record.kind === "owner");
	const latestOverall = records.at(-1);
	const selected = new Set([firstOwner, latestOwner, latestOverall]);
	return {
		fixed: records.filter((record) => selected.has(record)),
		others: records.filter((record) => !selected.has(record)),
	};
}
export function automaticChainStart(entries: readonly EntryLike[]): number {
	let prefix = entries;
	let window = contextStart(prefix);
	while (chainsAncestry(window.boundary) && window.boundary !== undefined) {
		prefix = prefix.slice(0, prefix.indexOf(window.boundary));
		window = contextStart(prefix);
	}
	return window.start;
}
function windowOwners(
	entries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	window: readonly EntryLike[],
	ownerQuestionRegistered: boolean,
): RecoveryRecord[] {
	const restored = projectedCurrent(entries, projected, window);
	const historical = restored.map((sourceEntry) => ({
		sourceEntry,
		messages: sourceEntry.message === undefined ? [] : [sourceEntry.message],
	}));
	return ownerRecords(restored, historical, ownerQuestionRegistered).filter(
		(record) => record.kind === "owner",
	);
}
/** The windows before the current one, newest first, as far back as automatic boundaries reach. */
function* earlierWindows(entries: readonly EntryLike[]): Generator<{
	readonly closedBy: EntryLike;
	readonly entries: readonly EntryLike[];
	readonly openedBy: EntryLike | undefined;
}> {
	let prefix = entries;
	let boundary = contextStart(prefix).boundary;
	while (boundary !== undefined && chainsAncestry(boundary)) {
		prefix = prefix.slice(0, prefix.indexOf(boundary));
		const window = contextStart(prefix);
		yield {
			closedBy: boundary,
			entries: prefix.slice(window.start),
			openedBy: window.boundary,
		};
		boundary = window.boundary;
	}
}
/** A window's owner inputs that still fit the room, taken newest first and returned oldest first. */
function newestThatFit(
	owners: readonly RecoveryRecord[],
	room: number,
	seen: Set<string>,
): { readonly records: readonly RecoveryRecord[]; readonly used: number } {
	const records: RecoveryRecord[] = [];
	let used = 0;
	for (const owner of owners.toReversed()) {
		if (used >= room) {
			break;
		}
		if (seen.has(owner.id)) {
			continue;
		}
		const record = {
			...owner,
			label: `${owner.label}; carried from an earlier window, possibly already handled; not current progress`,
		};
		seen.add(owner.id);
		records.unshift(record);
		used += formatRecord(record, Number.MAX_SAFE_INTEGER).length;
	}
	return { records, used };
}
/**
 * Earlier windows give a record the owner's most recent inputs, newest first, until they fill the
 * room of one input. Owner text the current window already holds counts against that room, so a
 * short follow-up keeps the task before it and a long new request stands alone.
 */
function recoveryAncestry(
	entries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	ownerQuestionRegistered: boolean,
	options: { readonly current: readonly RecoveryRecord[]; readonly maxChars: number },
): {
	readonly checkpoint?: EntryLike | undefined;
	readonly carried: readonly RecoveryRecord[];
	readonly skipped: readonly string[];
} {
	const held = options.current
		.filter((record) => record.kind === "owner")
		.reduce((chars, record) => chars + record.text.length, 0);
	let room =
		Math.min(MAX_RECOVERY_RECORD_CHARS, Math.floor(options.maxChars / RECORD_SHARE)) - held;
	const seen = new Set(options.current.map((record) => record.id));
	const carried: RecoveryRecord[] = [];
	const skipped: EntryLike[] = [];
	let ownerWindowFound = false;
	let reached = contextStart(entries).boundary;
	for (const window of earlierWindows(entries)) {
		if (ownerWindowFound && room <= 0) {
			break;
		}
		if (!ownerWindowFound) {
			skipped.push(window.closedBy);
		}
		const owners = windowOwners(entries, projected, window.entries, ownerQuestionRegistered);
		ownerWindowFound ||= owners.length > 0;
		const fit = newestThatFit(owners, room, seen);
		carried.unshift(...fit.records);
		room -= fit.used;
		reached = window.openedBy;
	}
	return {
		checkpoint: chainsAncestry(reached) ? undefined : reached,
		carried,
		skipped: skipped.map((boundary) => boundary.id?.slice(0, 120) ?? "unknown"),
	};
}
/**
 * Entries use native branch order. First/latest owner anchors depend on that order, not timestamps.
 * Returns the inputs quoted in full (oldest first), those only listed, and where ancestry ended.
 */
export function recoveryInputs(
	entries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	options: {
		readonly ownerQuestionRegistered: boolean;
		readonly retained: ReadonlySet<string>;
		readonly maxChars: number;
	},
): {
	readonly fixed: readonly RecoveryRecord[];
	readonly others: readonly RecoveryRecord[];
	readonly checkpoint?: EntryLike | undefined;
	readonly skipped: readonly string[];
} {
	const { ownerQuestionRegistered, retained, maxChars } = options;
	const { carried, checkpoint, skipped } = recoveryAncestry(
		entries,
		projected,
		ownerQuestionRegistered,
		{
			current: ownerRecords(
				projectedCurrent(entries, projected),
				projected,
				ownerQuestionRegistered,
			),
			maxChars,
		},
	);
	const { fixed, others } = anchors(
		ownerRecords(
			projectedCurrent(entries, projected, undefined, retained),
			projected,
			ownerQuestionRegistered,
		),
	);
	return { fixed: [...carried, ...fixed], others, checkpoint, skipped };
}
