import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EntryLike, MessageLike, ProjectedEntry } from "./contracts.ts";
import { contextEdits } from "./history-entries.ts";
import { sessionBranch, sessionProjection } from "./host.ts";
import type { StaleReminderPredicate } from "./reminders.ts";

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

function retainedProjectedMessages(
	projected: readonly ProjectedEntry[],
	retainedIds: ReadonlySet<string>,
	stale: StaleReminderPredicate,
): MessageLike[] {
	const retained: MessageLike[] = [];
	for (const item of projected) {
		if (!retainedIds.has(item.sourceEntry.id ?? "")) {
			continue;
		}
		for (const msg of item.messages) {
			if (
				!stale({ role: msg.role ?? "", customType: msg.customType, details: msg.details })
			) {
				retained.push(msg);
			}
		}
	}
	return retained;
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

/**
 * Match the projected journal tail in `messages`, falling back to entry counts only when the host
 * exposes no session projection. An unmatched projection never falls back to a positional count.
 */
export function findRetainedTailEnd(
	messages: readonly MessageLike[],
	summaryIndex: number,
	ctx: ExtensionContext,
	stale: StaleReminderPredicate,
): number | undefined {
	const branch = sessionBranch(ctx.sessionManager) ?? [];
	const retainedIds = journalRetainedIds(branch);
	if (retainedIds === undefined || retainedIds.size === 0) {
		return undefined;
	}
	const projection = sessionProjection(ctx.sessionManager);
	if (projection !== undefined) {
		const retained = retainedProjectedMessages(projection, retainedIds, stale);
		return retained.length === 0
			? undefined
			: retainedTailEnd(messages, summaryIndex, retained);
	}
	const edits = contextEdits(branch);
	const count = branch.filter(
		(entry) =>
			retainedIds.has(entry.id ?? "") && entryProducesRetainedMessage(entry, edits, stale),
	).length;
	return count > 0 && summaryIndex + 1 + count <= messages.length
		? summaryIndex + 1 + count
		: undefined;
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
