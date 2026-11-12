import type { ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { budgetFor, type Budget } from "./budget.ts";
import {
	LEGACY_WINDOW_TYPE,
	isRecord,
	isReminderType,
	type EntryLike,
	type PolicyContext,
	type ProjectedEntry,
	type ReminderFingerprint,
} from "./contracts.ts";
import { contextStart, isWindow } from "./boundary.ts";
import { contextEdits } from "./history-entries.ts";
import { createEpochCache, type EpochValue, type SessionContext } from "./epoch-cache.ts";
import { sessionBranch, sessionEntry, sessionProjection, type SessionHost } from "./host.ts";
import { journalRetainedIds } from "./retained-tail.ts";

type ReminderFacts = {
	readonly windowId: string;
	readonly reminders: readonly EntryLike[];
};
export type ReminderLookup = {
	readonly reset: () => void;
	readonly read: (ctx: SessionContext) => ReminderFacts;
};
export type ContextMessage = {
	readonly role: string;
	readonly customType?: string | undefined;
	readonly details?: unknown;
};
export type StaleReminderPredicate = (message: ContextMessage) => boolean;

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
function isReminderMessage(message: ContextMessage): boolean {
	return message.role === "custom" && isReminderType(message.customType);
}
/** A host may project a legacy fork's display marker; its window id outranks the journal scan. */
function contextMarker(messages: readonly ContextMessage[]): {
	readonly present: boolean;
	readonly windowId: unknown;
} {
	const marker = messages.find((message) => message.customType === LEGACY_WINDOW_TYPE);
	if (marker === undefined) {
		return { present: false, windowId: undefined };
	}
	const details = isRecord(marker.details) ? marker.details : undefined;
	return { present: true, windowId: details?.windowId };
}
function fingerprintOf(windowId: string, host: PolicyContext): ReminderFingerprint {
	const budget = budgetFor(host);
	return {
		windowId,
		contextWindow: budget?.contextWindow,
		reserveTokens: budget?.reserveTokens,
	};
}
/** A reminder belongs to one window and budget; undefined when no window id names it. */
export function reminderFingerprint(
	ctx: SessionContext,
	host: PolicyContext,
	reminders: ReminderLookup,
	messages: readonly ContextMessage[] = [],
): ReminderFingerprint | undefined {
	const marker = contextMarker(messages);
	const windowId = marker.present ? marker.windowId : reminders.read(ctx).windowId;
	return typeof windowId === "string" ? fingerprintOf(windowId, host) : undefined;
}
/**
 * Reminders that no longer describe this window or budget leave the context. When Pi compaction is
 * off, no reminder can fire again, so every reminder is stale.
 */
export function staleReminderPredicate(
	messages: readonly ContextMessage[],
	ctx: SessionContext,
	host: PolicyContext,
	reminders: ReminderLookup,
): StaleReminderPredicate {
	if (!messages.some(isReminderMessage)) {
		return () => false;
	}
	const budget = budgetFor(host);
	const compactionDisabled =
		budget === undefined ? !host.getCompactionSettings().enabled : budget.state === "disabled";
	const fingerprint = reminderFingerprint(ctx, host, reminders, messages);
	if (fingerprint === undefined) {
		return () => false;
	}
	return (message) =>
		isReminderMessage(message) &&
		(compactionDisabled || !reminderMatches(message.details, fingerprint));
}
const REMINDER_BUFFER_TOKENS = 32_000;
type ReminderDecision =
	| {
			readonly kind: "skip";
			readonly reason: "run-ended" | "unknown-usage" | "unavailable-budget" | "outside-band";
	  }
	| { readonly kind: "already-present" }
	| { readonly kind: "send"; readonly fingerprint: ReminderFingerprint };
function reminderBudget(
	host: PolicyContext,
):
	| Extract<ReminderDecision, { readonly kind: "skip" }>
	| { readonly kind: "available"; readonly budget: Budget } {
	const usage = host.getContextUsage();
	if (usage === undefined || usage.tokens === null || usage.contextWindow <= 0) {
		return { kind: "skip", reason: "unknown-usage" };
	}
	const budget = budgetFor(host, usage.contextWindow);
	if (budget === undefined || budget.state !== "enabled") {
		return { kind: "skip", reason: "unavailable-budget" };
	}
	const buffer = Math.min(REMINDER_BUFFER_TOKENS, Math.floor(budget.usable * 0.1));
	if (usage.tokens < budget.rolloverAt - buffer || usage.tokens >= budget.rolloverAt) {
		return { kind: "skip", reason: "outside-band" };
	}
	return { kind: "available", budget };
}
function endsRun(
	event: TurnEndEvent,
	ctx: { readonly hasPendingMessages?: () => boolean },
): boolean {
	return (
		event.message.role === "assistant" &&
		!event.message.content.some((part) => part.type === "toolCall") &&
		!event.continue &&
		event.context.pendingMessages.length === 0 &&
		ctx.hasPendingMessages?.() !== true
	);
}
export function reminderDecision(
	event: TurnEndEvent,
	ctx: ExtensionContext,
	host: PolicyContext,
	reminders: ReminderLookup,
): ReminderDecision {
	if (endsRun(event, ctx)) {
		return { kind: "skip", reason: "run-ended" };
	}
	const available = reminderBudget(host);
	if (available.kind === "skip") {
		return available;
	}
	const state = reminders.read(ctx);
	const fingerprint = fingerprintOf(state.windowId, host);
	if (
		hasReminder(state.reminders, fingerprint) ||
		event.context.pendingMessages.some(
			(message) =>
				message.role === "custom" &&
				isReminderType(message.customType) &&
				reminderMatches(message.details, fingerprint),
		)
	) {
		return { kind: "already-present" };
	}
	return { kind: "send", fingerprint };
}
function onlyReminders(entries: readonly EntryLike[]): EntryLike[] {
	return entries.filter(
		(entry) => entry.type === "custom_message" && isReminderType(entry.customType),
	);
}
type ScanProgress = {
	readonly boundary?: EntryLike | undefined;
	readonly window?: EntryLike | undefined;
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
function scanAncestry(
	manager: SessionHost,
	leaf: EntryLike | undefined,
	previous: EpochValue<ReminderFacts> | undefined,
): ReminderFacts {
	const reversed: EntryLike[] = [];
	let progress: ScanProgress = { kept: false };
	for (let entry = leaf; entry !== undefined; entry = sessionEntry(manager, entry.parentId)) {
		// Entry identity, not a reusable id, certifies an append-only extension of this leaf.
		if (
			progress.boundary === undefined &&
			previous !== undefined &&
			previous.identity.leaf === entry
		) {
			return {
				windowId: previous.value.windowId,
				reminders: [...previous.value.reminders, ...onlyReminders(reversed.reverse())],
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
export function createReminderLookup(): ReminderLookup {
	const cache = createEpochCache<ReminderFacts>((ctx, identity, previous) =>
		scanAncestry(ctx.sessionManager, identity.leaf, previous),
	);
	return { reset: cache.reset, read: cache.read };
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
			if (
				!stale({ role: msg.role ?? "", customType: msg.customType, details: msg.details })
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
	const branch = sessionBranch(ctx.sessionManager) ?? [];
	const retainedIds = journalRetainedIds(branch);
	if (retainedIds === undefined || retainedIds.size === 0) {
		return 0;
	}
	const projection = sessionProjection(ctx.sessionManager);
	if (projection !== undefined) {
		return countRetainedFromProjected(projection, retainedIds, stale);
	}
	const edits = contextEdits(branch);
	return branch.filter(
		(entry) =>
			retainedIds.has(entry.id ?? "") && entryProducesRetainedMessage(entry, edits, stale),
	).length;
}
