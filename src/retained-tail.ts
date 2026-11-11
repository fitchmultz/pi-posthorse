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
 * that matches the journal's next retained message, in order. Opaque system presentations of
 * custom messages must preserve their journal timestamp and order. Other interleaved messages
 * are skipped. Returns undefined when the whole tail cannot be matched.
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
 * Presenters such as pi-change-working-dir replace a custom message's content and details with
 * system sections but preserve its timestamp. Timestamp/order correlation is their integration
 * contract, not a globally unique message ID. A system message without that timestamp is not
 * evidence that the expected custom message survived.
 */
function isOpaquePresentation(journal: MessageLike, event: MessageLike): boolean {
	return (
		event.role === "system" &&
		event.content === "" &&
		event.sections !== undefined &&
		journal.role === "custom" &&
		journal.timestamp !== undefined &&
		event.timestamp === journal.timestamp
	);
}

/**
 * Identity of a retained message as the provider context carries it: same payload and receipt
 * linkage, and a role an earlier handler may only present as `system`. Journal and
 * provider messages are clones of each other, so identity is structural, never object equality.
 */
export function sameRetainedMessage(journal: MessageLike, event: MessageLike): boolean {
	return (
		(event.role === "system" || journal.role === event.role) &&
		messageIdentity(journal) === messageIdentity(event)
	);
}

function messageIdentity(message: MessageLike): string {
	// Array serialization normalizes absent optional fields to null on both clones.
	return JSON.stringify([
		message.timestamp,
		message.customType,
		message.content,
		message.details,
		message.toolCallId,
		message.toolName,
		message.namespace,
		message.isError,
		message.summary,
		message.command,
		message.output,
		message.stopReason,
		message.errorMessage,
		message.nestedCalls,
		message.excludeFromContext,
	]);
}
