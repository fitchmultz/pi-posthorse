import type { EntryLike, MessageLike } from "./contracts.ts";

/**
 * What a rollover retains: where Pi keeps the tail, which entries it holds, and how it must start.
 * A provider summary block stands for the request that produced the tail's first message, so that
 * message must be a reply the provider completed.
 */
export type RetainedTail = {
	readonly firstKeptEntryId: string | undefined;
	readonly ids: ReadonlySet<string>;
	readonly requiresAssistantStart: boolean;
};
export type RetainedSpan = { readonly firstId: string; readonly lastId: string };

/** The tail Pi retained for the latest boundary, read back from the journal. */
export function journalRetainedIds(branch: readonly EntryLike[]): ReadonlySet<string> | undefined {
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
/** The first and last journal entries a record describes, preferring entries that produce a message. */
export function retainedSpan(
	entries: readonly EntryLike[],
	retained: ReadonlySet<string>,
): RetainedSpan | undefined {
	if (retained.size === 0) {
		return undefined;
	}
	const kept = entries.filter(
		(e) =>
			e.id !== undefined &&
			e.id !== "" &&
			retained.has(e.id) &&
			(e.type === "message" || e.type === "custom_message" || e.type === "branch_summary"),
	);
	const list =
		kept.length > 0
			? kept
			: entries.filter((e) => e.id !== undefined && e.id !== "" && retained.has(e.id));
	const firstId = list[0]?.id?.slice(0, 120);
	const lastId = list.at(-1)?.id?.slice(0, 120);
	return firstId === undefined || lastId === undefined ? undefined : { firstId, lastId };
}

/**
 * Where the retained tail ends in a provider message list: the position after the last message
 * that is the journal's next retained message, in order — by identity, or as an opaque system
 * presentation of a retained custom message. A message another handler interleaves inside the
 * tail is skipped, so the record still lands after the whole retained tail. Returns undefined
 * when the whole tail cannot be certified, so callers fall back to counting positions.
 */
export function retainedTailEnd(
	messages: readonly MessageLike[],
	summaryIndex: number,
	retained: readonly MessageLike[],
): number | undefined {
	if (retained.length === 0) {
		return summaryIndex + 1;
	}
	let expected = 0;
	let end: number | undefined;
	for (
		let index = summaryIndex + 1;
		index < messages.length && expected < retained.length;
		index++
	) {
		const message = messages.at(index);
		const journal = retained.at(expected);
		if (message === undefined || journal === undefined) {
			break;
		}
		if (sameRetainedMessage(journal, message) || isOpaquePresentation(journal, message)) {
			expected += 1;
			end = index + 1;
		}
	}
	return expected === retained.length ? end : undefined;
}

/**
 * A presenter may replace a retained custom message with an opaque system patch that keeps none
 * of its identity — `pi-change-working-dir`'s directory snapshot carries only `sections`.
 * Presentations stay in journal order, so the next system message while a retained custom
 * message is expected is that presentation, consumed positionally.
 */
function isOpaquePresentation(journal: MessageLike, event: MessageLike): boolean {
	return event.role === "system" && journal.role === "custom";
}

/**
 * Identity of a retained message as the provider context carries it: same custom type, same
 * content and details, and a role an earlier handler may only present as `system`. Journal and
 * provider messages are clones of each other, so identity is structural, never object equality.
 */
export function sameRetainedMessage(journal: MessageLike, event: MessageLike): boolean {
	// Cloned structures compare by serialized content; null normalizes an absent field.
	const sameJson = (left: unknown, right: unknown): boolean =>
		JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
	return (
		(journal.customType ?? null) === (event.customType ?? null) &&
		(event.role === "system" || journal.role === event.role) &&
		sameJson(journal.content, event.content) &&
		sameJson(journal.details, event.details)
	);
}
