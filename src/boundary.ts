import {
	AUTO_HANDOFF_PREFIX,
	POSTHORSE_COMPACTION,
	isRecord,
	presentText,
	type EntryLike,
	type ProjectedEntry,
} from "./contracts.ts";

export type BoundaryKind = "fork" | "native" | "automatic" | "explicit" | "posthorse";
/** Everything the app derives from one persisted context boundary, decided in one place. */
export type Boundary = {
	readonly kind: BoundaryKind;
	/** Counts as a Posthorse window: labels, reminder windows, and note provenance. */
	readonly window: boolean;
	/** An automatic recovery record that walks through earlier windows continue past. */
	readonly chainsAncestry: boolean;
	/** Starts a new guidance epoch; a provider summary block keeps the previous one. */
	readonly freshGuidance: boolean;
};

export function windowHandoff(entry: EntryLike | undefined): string | undefined {
	return entry?.type === "compaction" ? entry.summary : entry?.handoff;
}
/** An automatic recovery record opens with this prefix; an earlier window's walk may continue past it. */
function automaticHandoff(entry: EntryLike): boolean {
	return windowHandoff(entry)?.trim().startsWith(AUTO_HANDOFF_PREFIX) === true;
}
/**
 * A compaction with a provider summary block carries forward the previous window's leading system
 * message unchanged, so its guidance section must stay locked to that earlier epoch too.
 */
function providerSummaryBlock(entry: EntryLike): boolean {
	return (
		entry.type === "compaction" &&
		isRecord(entry.providerSummary) &&
		isRecord(entry.providerSummary.block)
	);
}
function compactionKind(details: Readonly<Record<string, unknown>>): BoundaryKind {
	if (details.reason === "threshold" || details.reason === "overflow") {
		return "automatic";
	}
	return details.reason === "explicit" ? "explicit" : "posthorse";
}
export function classifyBoundary(entry?: EntryLike): Boundary | undefined {
	if (entry?.type === "context_window") {
		return {
			kind: "fork",
			window: true,
			chainsAncestry: automaticHandoff(entry),
			freshGuidance: true,
		};
	}
	if (entry?.type !== "compaction") {
		return undefined;
	}
	const details = isRecord(entry.details) ? entry.details : undefined;
	const freshGuidance = !providerSummaryBlock(entry);
	if (details?.posthorse !== POSTHORSE_COMPACTION) {
		return { kind: "native", window: false, chainsAncestry: false, freshGuidance };
	}
	const kind = compactionKind(details);
	return {
		kind,
		window: true,
		chainsAncestry: kind === "automatic" && automaticHandoff(entry),
		freshGuidance,
	};
}
export function isWindow(entry: EntryLike): boolean {
	return classifyBoundary(entry)?.window === true;
}
export function startsFreshGuidanceEpoch(entry: EntryLike): boolean {
	return classifyBoundary(entry)?.freshGuidance === true;
}
export function chainsAncestry(entry?: EntryLike): boolean {
	return classifyBoundary(entry)?.chainsAncestry === true;
}
/** The boundary already applied to a projection: a compaction with a visible tail. -1 when none. */
export function activeBoundaryIndex(projected: readonly ProjectedEntry[]): number {
	return projected.findIndex(
		(entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
	);
}
/** First active branch entry, including tails retained by Pi's own /compact. */
export function contextStart(entries: readonly EntryLike[]): {
	start: number;
	boundary?: EntryLike;
} {
	const index = entries.findLastIndex((entry) => classifyBoundary(entry) !== undefined);
	const boundary = entries[index];
	if (boundary === undefined) {
		return { start: 0 };
	}
	const firstKeptId =
		boundary.type === "compaction" ? presentText(boundary.firstKeptEntryId) : undefined;
	const kept =
		firstKeptId === undefined
			? -1
			: entries.findIndex((candidate) => candidate.id === firstKeptId);
	return { start: kept >= 0 ? kept : index + 1, boundary };
}
