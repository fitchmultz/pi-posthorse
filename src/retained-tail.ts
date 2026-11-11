import type { EntryLike } from "./contracts.ts";

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
