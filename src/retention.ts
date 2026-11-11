import {
	DEFAULT_COMPACTION_SETTINGS,
	estimateTokens,
	findCutPoint,
	type ProjectedSessionEntry,
	type SessionEntry,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { activeBoundaryIndex } from "./boundary.ts";
import { freshPayloadChars } from "./budget.ts";
import {
	MAX_HANDOFF_CHARS,
	MIN_PAGE_CHARS,
	type EntryLike,
	type MessageLike,
	type PolicyContext,
} from "./contracts.ts";
import type { NotesRecovery } from "./note-evidence.ts";
import {
	PROVIDER_SUMMARY_TOKENS,
	providerSummaryInstructions,
	type ProviderSummaryRequest,
} from "./provider-summary.ts";
import { buildAutoHandoff, recoveryNotePath } from "./recovery.ts";
import type { RetainedTail } from "./retained-tail.ts";

type RecoveryCapacity = {
	readonly host: PolicyContext;
	readonly toolTokens: number;
	readonly pendingMessages?: readonly MessageLike[];
	readonly firstKeptEntryId?: string | undefined;
	readonly notes?: NotesRecovery | undefined;
	/** The host will ask the provider for a summary block, which needs an assistant message first in the tail. */
	readonly providerSummary?: boolean | undefined;
};
type Immutable<T> = T extends string | number | boolean | null | undefined
	? T
	: T extends readonly (infer Item)[]
		? readonly Immutable<Item>[]
		: T extends object
			? { readonly [Key in keyof T]: Immutable<T[Key]> }
			: T;
type ProjectionEntry = Immutable<ProjectedSessionEntry>;
const CUT_ROLES = new Set([
	"user",
	"assistant",
	"bashExecution",
	"custom",
	"branchSummary",
	"compactionSummary",
]);
function visibleMessages(entry: ProjectionEntry) {
	return entry.messages.filter((message) => message.role !== "system");
}
function safeStart(entry: ProjectionEntry): boolean {
	return (
		entry.sourceEntry.type !== "compaction" &&
		visibleMessages(entry).some((message) => CUT_ROLES.has(message.role))
	);
}
/**
 * A provider summary block stands for the request that produced the tail's first message, so
 * that message must be a reply the provider completed.
 */
function assistantStart(entry: ProjectionEntry): boolean {
	const [first] = visibleMessages(entry);
	return (
		entry.sourceEntry.type !== "compaction" &&
		first?.role === "assistant" &&
		first.stopReason !== "error" &&
		first.stopReason !== "aborted"
	);
}
function nativeMessage(
	message: ProjectionEntry["messages"][number],
): SessionMessageEntry["message"] {
	switch (message.role) {
		case "assistant":
			return {
				role: "assistant",
				api: message.api,
				provider: message.provider,
				model: message.model,
				stopReason: message.stopReason,
				usage: message.usage,
				timestamp: message.timestamp,
				content: [...message.content],
			};
		case "toolResult":
			return {
				role: "toolResult",
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				isError: message.isError,
				timestamp: message.timestamp,
				content: [...message.content],
			};
		case "user":
		case "custom":
			return {
				...message,
				content:
					typeof message.content === "string" ? message.content : [...message.content],
			};
		case "system":
			// Compaction checkpoints replace earlier system declarations.
			return { role: "user", content: "", timestamp: message.timestamp };
		case "bashExecution":
		case "branchSummary":
		case "compactionSummary":
			return { ...message };
	}
}
/** The exported native cut finder reads raw entries; materialize only projected contributions. */
function projectedCut(entries: readonly ProjectionEntry[], keep: number): number {
	const materialized = entries.flatMap<SessionEntry>(({ sourceEntry, messages }) =>
		messages.length === 0 || sourceEntry.type === "compaction"
			? [{ ...sourceEntry, type: "custom", customType: "posthorse-projection", data: {} }]
			: messages.map((message) => ({
					id: sourceEntry.id,
					parentId: sourceEntry.parentId,
					timestamp: sourceEntry.timestamp,
					type: "message",
					message: nativeMessage(message),
				})),
	);
	const cut = findCutPoint(materialized, 0, materialized.length, keep);
	const id = materialized[cut.firstKeptEntryIndex]?.id;
	return entries.findIndex((entry) => entry.sourceEntry.id === id);
}
function pairedTail(entries: readonly ProjectionEntry[]): boolean {
	const calls = new Set<string>();
	for (const message of entries.flatMap(visibleMessages)) {
		if (message.role === "assistant") {
			for (const part of message.content.filter((block) => block.type === "toolCall")) {
				calls.add(part.id);
			}
		} else if (message.role === "toolResult") {
			if (!calls.delete(message.toolCallId)) {
				return false;
			}
		}
	}
	return calls.size === 0;
}
function boundedTail(
	entries: readonly ProjectionEntry[],
	start: number,
	maxTokens: number,
	requiresAssistantStart: boolean,
): RetainedTail {
	const startsTail = requiresAssistantStart ? assistantStart : safeStart;
	const costs = entries.slice(start).map((entry) => ({
		entry,
		cost:
			entry.sourceEntry.type === "compaction"
				? 0
				: visibleMessages(entry).reduce(
						(sum, message) => sum + estimateTokens(nativeMessage(message)),
						0,
					),
	}));
	let tokens = costs.reduce((sum, { cost }) => sum + cost, 0);
	for (const [offset, { entry, cost }] of costs.entries()) {
		const index = start + offset;
		if (tokens > 0 && tokens <= maxTokens && startsTail(entry)) {
			const tail = entries.slice(index);
			if (pairedTail(tail)) {
				return {
					firstKeptEntryId: entry.sourceEntry.id,
					ids: new Set(tail.map((retained) => retained.sourceEntry.id)),
					requiresAssistantStart,
				};
			}
		}
		tokens -= cost;
	}
	return { firstKeptEntryId: undefined, ids: new Set(), requiresAssistantStart };
}
function retainedTail(
	projected: readonly ProjectionEntry[],
	capacity: RecoveryCapacity,
	maxTokens: number,
): RetainedTail {
	const requiresAssistantStart = capacity.providerSummary === true;
	const empty: RetainedTail = {
		firstKeptEntryId: undefined,
		ids: new Set(),
		requiresAssistantStart,
	};
	const keep =
		capacity.host.getCompactionSettings().keepRecentTokens ??
		DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
	if (!Number.isFinite(keep) || keep <= 0 || maxTokens <= 0) {
		return empty;
	}
	const boundary = activeBoundaryIndex(projected);
	const entries = projected.slice(boundary + 1);
	if (entries.length === 0) {
		return empty;
	}
	const prepared = entries.findIndex(
		(entry) => entry.sourceEntry.id === capacity.firstKeptEntryId,
	);
	const start = prepared >= 0 ? prepared : projectedCut(entries, keep);
	return start < 0 ? empty : boundedTail(entries, start, maxTokens, requiresAssistantStart);
}
/** Recent messages and recovery share half the fresh operational budget, leaving work headroom. */
export function automaticRecovery(
	entries: readonly EntryLike[],
	projected: readonly ProjectionEntry[],
	capacity: RecoveryCapacity,
	ownerQuestionRegistered: boolean,
):
	| {
			readonly handoff: string;
			readonly firstKeptEntryId?: string | undefined;
			readonly providerSummary?: ProviderSummaryRequest | undefined;
	  }
	| undefined {
	const payload = freshPayloadChars(capacity.host, capacity.toolTokens, {
		pendingMessages: capacity.pendingMessages,
		cap: Number.MAX_SAFE_INTEGER,
		guidance: "effective",
	});
	const limit = Math.min(MAX_HANDOFF_CHARS, payload);
	if (limit < MIN_PAGE_CHARS) {
		return undefined;
	}
	// A summary block is counted against the tail budget before any tail is chosen.
	const asksProvider = capacity.providerSummary === true;
	const retained = retainedTail(
		projected,
		capacity,
		Math.floor((payload - limit) / 4) - (asksProvider ? PROVIDER_SUMMARY_TOKENS : 0),
	);
	const handoff = buildAutoHandoff(entries, projected, limit, {
		ownerQuestionRegistered,
		retainedEntryIds: retained.ids,
		notes: capacity.notes,
	});
	if (handoff.length > limit) {
		return undefined;
	}
	return {
		handoff,
		firstKeptEntryId: retained.firstKeptEntryId,
		// Without a tail there is no reasoning to keep, so the host is not asked for a block.
		providerSummary:
			!asksProvider || retained.firstKeptEntryId === undefined
				? undefined
				: {
						instructions: providerSummaryInstructions(
							recoveryNotePath(entries, projected, {
								retainedEntryIds: retained.ids,
								notes: capacity.notes,
							}),
						),
					},
	};
}
