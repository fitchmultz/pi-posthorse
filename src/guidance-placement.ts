import type { ContextWithSystemEvent } from "@earendil-works/pi-coding-agent";
import type { MessageLike, ProjectedEntry } from "./contracts.ts";
import type { SessionContext } from "./epoch-cache.ts";
import { sessionProjection } from "./host.ts";
import { messagesHeldByProviderSummary } from "./provider-summary.ts";
import { matchesProjectedMessage } from "./retained-tail.ts";

export type GuidanceUpdate = {
	readonly entryId: string | undefined;
	readonly text: string;
};
export type GuidancePlan = {
	readonly anchorId: string | undefined;
	readonly firstPostAnchorId: string | undefined;
	readonly leading: string;
	readonly current: string;
	readonly updates: readonly GuidanceUpdate[];
};
export type GuidanceInsertion = {
	readonly at: number;
	readonly text: string;
};
export type GuidancePlacement = {
	readonly leading: string;
	readonly insertions: readonly GuidanceInsertion[];
};

type ContextMessage = MessageLike & { readonly role: string };

export function wrapGuidanceSection(text: string): string {
	return `<posthorse>\n${text}\n</posthorse>`;
}
export function guidanceUpdateMessage(text: string): {
	readonly role: "system";
	readonly content: string;
	readonly sections: Record<string, string>;
	readonly timestamp: number;
} {
	return {
		role: "system",
		content: "",
		sections: { posthorse: wrapGuidanceSection(text) },
		timestamp: 0,
	};
}
function findProjectedMessage(
	messages: readonly ContextMessage[],
	from: number,
	journal: MessageLike,
): number {
	for (let index = from; index < messages.length; index++) {
		const candidate = messages[index];
		if (candidate === undefined) {
			continue;
		}
		if (
			journal.role === "system"
				? candidate.role === "system" && candidate.timestamp === journal.timestamp
				: matchesProjectedMessage(journal, candidate)
		) {
			return index;
		}
	}
	return -1;
}
function advanceCursor(
	messages: readonly ContextMessage[],
	cursor: number,
	projectedMessages: readonly MessageLike[],
): number {
	let next = cursor;
	for (const msg of projectedMessages) {
		const found = findProjectedMessage(messages, next, msg);
		if (found >= 0) {
			next = found + 1;
		}
	}
	return next;
}
function buildUpdateMap(updates: readonly GuidanceUpdate[]): Map<string, string> {
	const byId = new Map<string, string>();
	for (const update of updates) {
		if (update.entryId !== undefined) {
			byId.set(update.entryId, update.text);
		}
	}
	return byId;
}
function isCompactionSummaryEntry(item: ProjectedEntry): boolean {
	return (
		item.sourceEntry.type === "compaction" &&
		item.messages.some((message) => message.role === "compactionSummary")
	);
}
function carriedSummarizedGuidance(
	projection: readonly ProjectedEntry[],
	plan: GuidancePlan,
	updateById: ReadonlyMap<string, string>,
	summaryEntryIndex: number,
): string | undefined {
	const projectedIds = new Set(
		projection.flatMap((item) =>
			typeof item.sourceEntry.id === "string" && item.sourceEntry.id !== ""
				? [item.sourceEntry.id]
				: [],
		),
	);
	let carried: string | undefined;
	for (const update of plan.updates) {
		if (update.entryId !== undefined && projectedIds.has(update.entryId)) {
			break;
		}
		carried = update.text;
	}
	if (carried === undefined || carried === plan.leading) {
		return undefined;
	}
	if (summaryEntryIndex >= 0) {
		const supersededInTail = projection
			.slice(0, summaryEntryIndex)
			.some(
				(item) => item.sourceEntry.id !== undefined && updateById.has(item.sourceEntry.id),
			);
		if (supersededInTail) {
			return undefined;
		}
	}
	return carried;
}
function projectionWindowStart(
	messages: readonly ContextMessage[],
	projection: readonly ProjectedEntry[],
	plan: GuidancePlan,
): { readonly entryIndex: number; readonly cursor: number } {
	if (
		plan.anchorId === undefined ||
		projection[0]?.sourceEntry.id !== plan.anchorId ||
		messagesHeldByProviderSummary(messages) > 0
	) {
		return { entryIndex: 0, cursor: 0 };
	}
	const summaryIndex = messages.findLastIndex((message) => message.role === "compactionSummary");
	const entryIndex =
		plan.firstPostAnchorId === undefined
			? projection.length
			: projection.findIndex((item) => item.sourceEntry.id === plan.firstPostAnchorId);
	if (summaryIndex < 0 || entryIndex < 0) {
		return { entryIndex: 0, cursor: 0 };
	}
	return { entryIndex, cursor: summaryIndex + 1 };
}
function collectUpdateInsertions(
	messages: readonly ContextMessage[],
	projection: readonly ProjectedEntry[],
	plan: GuidancePlan,
): GuidanceInsertion[] {
	const updateById = buildUpdateMap(plan.updates);
	const summaryEntryIndex = projection.findLastIndex(isCompactionSummaryEntry);
	const carried =
		messagesHeldByProviderSummary(messages) > 0
			? carriedSummarizedGuidance(projection, plan, updateById, summaryEntryIndex)
			: undefined;
	const start = projectionWindowStart(messages, projection, plan);
	const insertions: GuidanceInsertion[] = [];
	let cursor = start.cursor;
	for (let index = start.entryIndex; index < projection.length; index++) {
		const item = projection[index];
		if (item === undefined) {
			continue;
		}
		cursor = advanceCursor(messages, cursor, item.messages);
		if (carried !== undefined && index === summaryEntryIndex) {
			insertions.push({ at: cursor, text: carried });
			continue;
		}
		const updateText =
			item.sourceEntry.id === undefined ? undefined : updateById.get(item.sourceEntry.id);
		if (updateText !== undefined) {
			insertions.push({ at: cursor, text: updateText });
		}
	}
	return insertions;
}
/**
 * Computes the immutable leading guidance text and anchored mid-conversation section updates.
 * Hosts with a session projection anchor each update directly after the message that preceded its
 * journal entry; hosts without one fall back to appending once an assistant reply locks the prefix.
 */
export function resolveGuidancePlacement(
	messages: ContextWithSystemEvent["messages"],
	ctx: SessionContext,
	plan: GuidancePlan,
): GuidancePlacement {
	if (plan.updates.length === 0 && plan.leading === plan.current) {
		return { leading: plan.leading, insertions: [] };
	}
	const projection = sessionProjection(ctx.sessionManager);
	if (projection !== undefined && projection.length > 0) {
		const insertions = collectUpdateInsertions(messages, projection, plan);
		if (insertions.length > 0) {
			return { leading: plan.leading, insertions };
		}
	}
	if (plan.current === plan.leading) {
		return { leading: plan.leading, insertions: [] };
	}
	if (messages.some((message) => message.role === "assistant")) {
		return {
			leading: plan.leading,
			insertions: [{ at: messages.length, text: plan.current }],
		};
	}
	return { leading: plan.current, insertions: [] };
}
