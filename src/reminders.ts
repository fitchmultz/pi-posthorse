import type { ExtensionAPI, ExtensionContext, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { budgetFor, type Budget } from "./budget.ts";
import {
	LEGACY_WINDOW_TYPE,
	isRecord,
	isReminderType,
	type EntryLike,
	type PolicyContext,
	type ReminderFingerprint,
} from "./contracts.ts";
import { contextStart, isWindow } from "./boundary.ts";
import { createEpochCache, type EpochValue, type SessionContext } from "./epoch-cache.ts";
import { sessionEntry, sessionProjection, type SessionHost } from "./host.ts";
import { messagesHeldByProviderSummary } from "./provider-summary.ts";

export const SUPPRESSED_REMINDER_TYPE = "posthorse-suppressed-reminder";
const suppressedReminderSchema = Type.Object({
	version: Type.Literal(1),
	entryIds: Type.Array(Type.String()),
});
type SuppressedReminderRecord = Static<typeof suppressedReminderSchema>;

type ReminderFacts = {
	readonly windowId: string;
	readonly reminders: readonly EntryLike[];
	readonly suppressedIds: ReadonlySet<string>;
};
export type ReminderLookup = {
	readonly reset: () => void;
	readonly read: (ctx: SessionContext) => ReminderFacts;
	readonly recordSuppressed?: (
		ctx: SessionContext,
		entryIds: readonly string[],
		retainInMemory: boolean,
	) => void;
};
export type ContextMessage = {
	readonly role: string;
	readonly customType?: string | undefined;
	readonly content?: unknown;
	readonly details?: unknown;
};
export type StaleReminderPredicate = (message: ContextMessage) => boolean;

function reminderWindowMatches(details: unknown, windowId: string): boolean {
	return isRecord(details) && details.windowId === windowId;
}
function reminderMatches(details: unknown, fingerprint: ReminderFingerprint): boolean {
	if (!isRecord(details)) {
		return false;
	}
	return (
		details.windowId === fingerprint.windowId &&
		details.contextWindow === fingerprint.contextWindow &&
		details.reserveTokens === fingerprint.reserveTokens
	);
}
function hasReminder(entries: readonly EntryLike[], fingerprint: ReminderFingerprint): boolean {
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
function reminderContentKey(message: {
	readonly customType?: string | undefined;
	readonly content?: unknown;
	readonly details?: unknown;
}): string {
	// Live CustomMessage timestamps (Date.now) and persisted entry ISO timestamps can differ by 1ms,
	// so match reminders by type, payload, and fingerprint in chronological order.
	return JSON.stringify([message.customType, message.content, message.details]);
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
type JournalReminder = { readonly id: string; readonly key: string };
function activeJournalReminders(
	ctx: SessionContext,
	state: ReminderFacts,
): readonly JournalReminder[] {
	const projection = sessionProjection(ctx.sessionManager);
	if (projection !== undefined && projection.length > 0) {
		const projected: JournalReminder[] = [];
		for (const item of projection) {
			const id = item.sourceEntry.id;
			const first = item.messages[0];
			if (
				typeof id === "string" &&
				id !== "" &&
				item.sourceEntry.type === "custom_message" &&
				isReminderType(item.sourceEntry.customType) &&
				first !== undefined
			) {
				projected.push({ id, key: reminderContentKey(first) });
			}
		}
		return projected;
	}
	return state.reminders.flatMap((entry) =>
		typeof entry.id === "string" && entry.id !== ""
			? [{ id: entry.id, key: reminderContentKey(entry) }]
			: [],
	);
}
function matchReminderEntryIds(
	messages: readonly ContextMessage[],
	journal: readonly JournalReminder[],
): Map<number, string> {
	const matched = new Map<number, string>();
	if (journal.length === 0) {
		return matched;
	}
	let cursor = 0;
	for (let index = 0; index < messages.length && cursor < journal.length; index++) {
		const message = messages[index];
		if (message === undefined || !isReminderMessage(message)) {
			continue;
		}
		const key = reminderContentKey(message);
		const found = journal.findIndex((entry, at) => at >= cursor && entry.key === key);
		if (found >= 0) {
			const entry = journal[found];
			if (entry !== undefined) {
				matched.set(index, entry.id);
			}
			cursor = found + 1;
		}
	}
	return matched;
}
export type RemovableReminderPredicate = (message: ContextMessage, index: number) => boolean;
export type ReminderFilterResult = {
	readonly stale: StaleReminderPredicate;
	readonly removable: RemovableReminderPredicate;
	readonly newlySuppressedIds: readonly string[];
};
function collectNewlySuppressedIds(
	messages: readonly ContextMessage[],
	state: {
		readonly held: number;
		readonly lastAssistant: number;
		readonly windowId: string;
		readonly stale: StaleReminderPredicate;
		readonly suppressedIds: ReadonlySet<string>;
		readonly entryIds: ReadonlyMap<number, string>;
	},
): string[] {
	const newlySuppressed: string[] = [];
	const seen = new Set<string>();
	for (let index = state.held; index < messages.length; index++) {
		const message = messages[index];
		if (
			message === undefined ||
			index <= state.lastAssistant ||
			!state.stale(message) ||
			!reminderWindowMatches(message.details, state.windowId)
		) {
			continue;
		}
		const entryId = state.entryIds.get(index);
		if (entryId !== undefined && !state.suppressedIds.has(entryId) && !seen.has(entryId)) {
			seen.add(entryId);
			newlySuppressed.push(entryId);
		}
	}
	return newlySuppressed;
}
/**
 * Classifies reminders in `messages` for stale checks and monotone, prefix-safe removal.
 *
 * A reminder from an ended window was never sent in the new window (unless held under a provider
 * summary block), so filtering it keeps the new window's prefix consistent from its first request.
 * A current-window reminder that became stale after a model, reserve, or compaction-setting change
 * may only be removed from the trailing unsent tail after the last assistant reply; once omitted,
 * its journal entry id is marked suppressed so later assistant replies or setting reversals never
 * re-insert it mid-history.
 */
export function reminderFilter(
	messages: readonly ContextMessage[],
	ctx: SessionContext,
	host: PolicyContext,
	reminders: ReminderLookup,
): ReminderFilterResult {
	const never = () => false;
	if (!messages.some(isReminderMessage)) {
		return { stale: never, removable: never, newlySuppressedIds: [] };
	}
	const budget = budgetFor(host);
	const compactionDisabled =
		budget === undefined ? !host.getCompactionSettings().enabled : budget.state === "disabled";
	const fingerprint = reminderFingerprint(ctx, host, reminders, messages);
	if (fingerprint === undefined) {
		return { stale: never, removable: never, newlySuppressedIds: [] };
	}
	const stale: StaleReminderPredicate = (message) =>
		isReminderMessage(message) &&
		(compactionDisabled || !reminderMatches(message.details, fingerprint));
	const hasCurrentWindow = messages.some(
		(message) =>
			isReminderMessage(message) &&
			reminderWindowMatches(message.details, fingerprint.windowId),
	);
	const facts = hasCurrentWindow ? reminders.read(ctx) : undefined;
	const suppressedIds = facts?.suppressedIds ?? new Set<string>();
	const entryIds =
		facts === undefined
			? new Map<number, string>()
			: matchReminderEntryIds(messages, activeJournalReminders(ctx, facts));
	const held = messagesHeldByProviderSummary(messages);
	const lastAssistant = messages.findLastIndex((message) => message.role === "assistant");
	const removable: RemovableReminderPredicate = (message, index) => {
		if (index < held || !isReminderMessage(message)) {
			return false;
		}
		const entryId = entryIds.get(index);
		if (entryId !== undefined && suppressedIds.has(entryId)) {
			return true;
		}
		return (
			stale(message) &&
			(index > lastAssistant || !reminderWindowMatches(message.details, fingerprint.windowId))
		);
	};
	const newlySuppressedIds = collectNewlySuppressedIds(messages, {
		held,
		lastAssistant,
		windowId: fingerprint.windowId,
		stale,
		suppressedIds,
		entryIds,
	});
	return { stale, removable, newlySuppressedIds };
}
/** Persist filtered trailing current-window reminder IDs so subsequent turns never re-insert them. */
export function persistSuppressedReminders(
	pi: Pick<ExtensionAPI, "appendEntry">,
	ctx: SessionContext,
	reminders: ReminderLookup,
	entryIds: readonly string[],
): void {
	if (entryIds.length === 0) {
		return;
	}
	const leafBefore = ctx.sessionManager.getLeafId?.() ?? null;
	pi.appendEntry(SUPPRESSED_REMINDER_TYPE, {
		version: 1,
		entryIds: [...entryIds],
	} satisfies SuppressedReminderRecord);
	const leafAfter = ctx.sessionManager.getLeafId?.() ?? null;
	reminders.recordSuppressed?.(ctx, entryIds, leafBefore === leafAfter);
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
	return reminderFilter(messages, ctx, host, reminders).stale;
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
function collectSuppressedIds(
	entries: readonly EntryLike[],
	base?: ReadonlySet<string>,
): Set<string> {
	const suppressed = new Set<string>(base);
	for (const entry of entries) {
		if (
			entry.type === "custom" &&
			entry.customType === SUPPRESSED_REMINDER_TYPE &&
			Check(suppressedReminderSchema, entry.data)
		) {
			for (const id of entry.data.entryIds) {
				suppressed.add(id);
			}
		}
	}
	return suppressed;
}
function withMemorySuppressed(
	facts: ReminderFacts,
	memory: ReadonlySet<string> | undefined,
): ReminderFacts {
	if (memory === undefined || memory.size === 0) {
		return facts;
	}
	const merged = new Set(facts.suppressedIds);
	for (const id of memory) {
		merged.add(id);
	}
	return { ...facts, suppressedIds: merged };
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
	memory: ReadonlySet<string> | undefined,
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
			const tail = reversed.reverse();
			return withMemorySuppressed(
				{
					windowId: previous.value.windowId,
					reminders: [...previous.value.reminders, ...onlyReminders(tail)],
					suppressedIds: collectSuppressedIds(tail, previous.value.suppressedIds),
				},
				memory,
			);
		}
		reversed.push(entry);
		progress = advanceBoundary(entry, progress);
		// Native compaction may keep a tail before the Posthorse boundary. Negative lookups reach root once.
		if (progress.window !== undefined && progress.kept) {
			break;
		}
	}
	const entries = reversed.reverse();
	const active = entries.slice(contextStart(entries).start);
	return withMemorySuppressed(
		{
			windowId: progress.window?.id ?? "initial",
			reminders: onlyReminders(active),
			suppressedIds: collectSuppressedIds(active),
		},
		memory,
	);
}
export function createReminderLookup(): ReminderLookup {
	let memorySuppressed = new WeakMap<object, Set<string>>();
	const cache = createEpochCache<ReminderFacts>((ctx, identity, previous) =>
		scanAncestry(
			ctx.sessionManager,
			identity.leaf,
			previous,
			memorySuppressed.get(ctx.sessionManager),
		),
	);
	return {
		reset() {
			cache.reset();
			memorySuppressed = new WeakMap();
		},
		read: cache.read,
		recordSuppressed(ctx, entryIds, retainInMemory) {
			if (retainInMemory) {
				let ids = memorySuppressed.get(ctx.sessionManager);
				if (ids === undefined) {
					ids = new Set();
					memorySuppressed.set(ctx.sessionManager, ids);
				}
				for (const id of entryIds) {
					ids.add(id);
				}
			}
			cache.reset();
		},
	};
}
