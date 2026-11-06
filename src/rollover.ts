import type {
	BoundaryResult,
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { budgetFor, CHECKPOINT_GUIDANCE, freshPayloadChars } from "./budget.ts";
import {
	isRecord,
	isReminderType,
	REMINDER_TYPE,
	type PolicyContext,
	type ProjectedEntry,
	type ReminderFingerprint,
	type SnapshotReader,
} from "./contracts.ts";
import { registerContextTools } from "./context-tools.ts";
import { registerGuidance } from "./guidance.ts";
import { safeJsonStringify } from "./message-text.ts";
import { hasRetainedRolloverMarker } from "./recovery.ts";
import { automaticRecovery } from "./retention.ts";
import { ResetRequests } from "./reset-requests.ts";
import type { NotesRecovery } from "./note-evidence.ts";
type RolloverResources = {
	readonly resetPages: () => void;
	readonly notes: (ctx: ExtensionContext) => NotesRecovery | undefined;
};
import {
	countRetainedMessages,
	createReminderLookup,
	reminderDecision,
	reminderMatches,
	type ReminderLookup,
	type StaleReminderPredicate,
} from "./reminders.ts";

function explicitReset(
	event: TurnEndEvent,
	ctx: ExtensionContext,
	summary: string,
	limit: () => number,
): BoundaryResult | undefined {
	if (event.outcome === "aborted" || ctx.signal?.aborted === true) {
		return undefined;
	}
	if (summary.length > limit()) {
		return {
			entries: [
				...event.entries,
				{
					type: "custom_message",
					customType: "posthorse-reset-deferred",
					display: true,
					content:
						"Posthorse reset deferred: queued messages leave too little room for the requested handoff. The current context is unchanged; process those messages, then request a shorter handoff.",
				},
			],
		};
	}
	return {
		entries: [
			...event.entries,
			{
				type: "compaction",
				summary,
				firstKeptEntryId: null,
				details: { posthorse: 1, reason: "explicit" },
			},
		],
		continue: true,
	};
}
const NO_STALE_REMINDER: StaleReminderPredicate = () => false;
function staleReminderPredicate(
	messages: readonly {
		readonly role: string;
		readonly customType?: string | undefined;
		readonly details?: unknown;
	}[],
	ctx: ExtensionContext,
	policy: SnapshotReader,
	reminders: ReminderLookup,
): StaleReminderPredicate {
	if (
		!messages.some((message) => message.role === "custom" && isReminderType(message.customType))
	) {
		return NO_STALE_REMINDER;
	}
	const marker = messages.find(
		(message) => message.role === "custom" && message.customType === "context-window",
	);
	let windowId: unknown;
	if (marker?.role === "custom") {
		windowId = isRecord(marker.details) ? marker.details.windowId : undefined;
	} else {
		windowId = reminders.read(ctx).windowId;
	}
	if (typeof windowId !== "string") {
		return NO_STALE_REMINDER;
	}
	const host = policy(ctx);
	const budget = budgetFor(host);
	const fingerprint: ReminderFingerprint = {
		windowId,
		contextWindow: budget?.contextWindow,
		reserveTokens: budget?.reserveTokens,
	};
	const enabled = host.getCompactionSettings().enabled;
	return (message) =>
		message.role === "custom" &&
		isReminderType(message.customType) &&
		(!enabled || !reminderMatches(message.details, fingerprint));
}
function chronologicalRetainedTail(
	messages: ContextEvent["messages"],
	ctx: ExtensionContext,
	stale: StaleReminderPredicate,
): ContextEvent["messages"] {
	const first = messages[0];
	if (
		messages.length >= 2 &&
		first?.role === "compactionSummary" &&
		hasRetainedRolloverMarker(first.summary)
	) {
		const count = countRetainedMessages(ctx, stale);
		if (count > 0 && 1 + count <= messages.length) {
			const retainedSlice = messages.slice(1, 1 + count);
			const afterSlice = messages.slice(1 + count);
			if (retainedSlice[0]?.role !== "assistant") {
				return [...retainedSlice, first, ...afterSlice];
			}
			return [
				{
					role: "custom",
					customType: "posthorse-retained-tail",
					content: "[Retained pre-rollover tail]",
					display: false,
					timestamp: first.timestamp,
				},
				...retainedSlice,
				first,
				...afterSlice,
			];
		}
	}
	return messages;
}
function registerReminderFilter(
	pi: ExtensionAPI,
	policy: SnapshotReader,
	reminders: ReminderLookup,
): void {
	pi.on("context", (event, ctx) => {
		const stale = staleReminderPredicate(event.messages, ctx, policy, reminders);
		const filtered = event.messages.some(stale)
			? event.messages.filter((message) => !stale(message))
			: event.messages;
		const ordered = chronologicalRetainedTail(filtered, ctx, stale);
		if (ordered !== event.messages) {
			return { messages: ordered };
		}
		return;
	});
}
function automaticDraft(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	recovery: {
		readonly handoff: string;
		readonly tokensBefore: number;
		readonly reason: string;
		readonly firstKeptEntryId?: string | undefined;
	},
) {
	let firstKeptEntryId = recovery.firstKeptEntryId;
	if (firstKeptEntryId === undefined) {
		// Public compaction requires an entry id even when no prior conversation safely fits.
		pi.appendEntry("posthorse-boundary", {});
		firstKeptEntryId = ctx.sessionManager.getLeafId() ?? undefined;
	}
	if (firstKeptEntryId === undefined || firstKeptEntryId === "") {
		throw new Error("Pi did not persist the context boundary.");
	}
	return {
		compaction: {
			summary: recovery.handoff,
			firstKeptEntryId,
			tokensBefore: recovery.tokensBefore,
			details: { posthorse: 1, reason: recovery.reason },
		},
	};
}
function reportAutomaticFailure(ctx: ExtensionContext, error: unknown): void {
	const detail = error instanceof Error ? error.message : safeJsonStringify(error);
	const message = `Posthorse automatic rollover cancelled: ${detail}`;
	if (ctx.hasUI) {
		ctx.ui.notify(message, "error");
	} else {
		console.error(message);
	}
}
function freshWindowWithoutInput(projected: readonly ProjectedEntry[]): boolean {
	const boundary = projected.findIndex(
		(entry) => entry.sourceEntry.type === "compaction" && entry.messages.length > 0,
	);
	if (boundary < 0) {
		return false;
	}
	const turnStarts = new Set([
		"user",
		"custom",
		"bashExecution",
		"branchSummary",
		"compactionSummary",
	]);
	return !projected
		.slice(boundary + 1)
		.some(
			(entry) =>
				entry.sourceEntry.type !== "compaction" &&
				entry.messages.some((message) => turnStarts.has(message.role ?? "")),
		);
}
function reachedThreshold(host: PolicyContext): boolean {
	const usage = host.getContextUsage();
	const budget = budgetFor(host);
	return (
		budget?.supported === true &&
		budget.enabled &&
		usage !== undefined &&
		usage.tokens !== null &&
		usage.tokens >= budget.rolloverAt
	);
}
function fallbackTurnEligible(event: TurnEndEvent, ctx: ExtensionContext): boolean {
	return (
		event.outcome === "completed" &&
		!(event.message.role === "assistant" && event.message.stopReason === "length") &&
		ctx.signal?.aborted !== true &&
		!event.entries.some((entry) => entry.type === "compaction" || entry.type === "context_edit")
	);
}
type Preparation<Draft> =
	| { readonly kind: "delegate" }
	| { readonly kind: "draft"; readonly value: Draft };
function thresholdFallback(
	pi: ExtensionAPI,
	event: TurnEndEvent,
	ctx: ExtensionContext,
	capacity: {
		readonly host: PolicyContext;
		readonly toolTokens: () => number;
		readonly notes: RolloverResources["notes"];
	},
): Preparation<BoundaryResult> {
	if (!fallbackTurnEligible(event, ctx)) {
		return { kind: "delegate" };
	}
	const { host, toolTokens } = capacity;
	if (!reachedThreshold(host)) {
		return { kind: "delegate" };
	}
	if (!freshWindowWithoutInput(event.context.contextEntries)) {
		return { kind: "delegate" };
	}
	const projected = event.context.contextEntries;
	const ownerQuestionRegistered = pi
		.getAllTools()
		.some((tool) => tool.name === "ask_question" && tool.namespace === undefined);
	const recovery = automaticRecovery(
		ctx.sessionManager.getBranch(),
		projected,
		{
			host,
			toolTokens: toolTokens(),
			pendingMessages: event.context.pendingMessages,
			notes: capacity.notes(ctx),
		},
		ownerQuestionRegistered,
	);
	if (recovery === undefined) {
		return { kind: "delegate" };
	}
	// ponytail: turn_end drafts are eager. Later projection editors must replace/remove this draft;
	// upgrade to a host post-boundary hook if recovery must include later handler edits.
	return {
		kind: "draft",
		value: {
			entries: [
				...event.entries,
				{
					type: "compaction",
					summary: recovery.handoff,
					firstKeptEntryId: recovery.firstKeptEntryId ?? null,
					details: { posthorse: 1, reason: "threshold" },
				},
			],
			continue: event.continue,
		},
	};
}
type AutomaticPreparation =
	| Preparation<Parameters<typeof automaticDraft>[2]>
	| { readonly kind: "cancel" };
function compactionCancelled(event: SessionBeforeCompactEvent, ctx: ExtensionContext): boolean {
	return event.signal.aborted || ctx.signal?.aborted === true;
}
function prepareAutomatic(
	pi: ExtensionAPI,
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext,
	capacity: {
		readonly policy: SnapshotReader;
		readonly toolTokens: () => number;
		readonly notes: RolloverResources["notes"];
	},
): AutomaticPreparation {
	if (event.reason === "manual") {
		return { kind: "delegate" };
	}
	if (compactionCancelled(event, ctx)) {
		return { kind: "cancel" };
	}
	const host = capacity.policy(ctx, event.preparation.settings);
	if (budgetFor(host)?.supported !== true) {
		return { kind: "delegate" };
	}
	const ownerQuestionRegistered = pi
		.getAllTools()
		.some((tool) => tool.name === "ask_question" && tool.namespace === undefined);
	const recovery = automaticRecovery(
		event.branchEntries,
		ctx.sessionManager.buildSessionProjection().entries,
		{
			host,
			toolTokens: capacity.toolTokens(),
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			notes: capacity.notes(ctx),
		},
		ownerQuestionRegistered,
	);
	if (recovery === undefined) {
		throw new Error("Too little fresh context capacity for an automatic recovery record.");
	}
	if (compactionCancelled(event, ctx)) {
		return { kind: "cancel" };
	}
	return {
		kind: "draft",
		value: {
			...recovery,
			tokensBefore: event.preparation.tokensBefore,
			reason: event.reason,
		},
	};
}
function registerAutomaticRollover(
	pi: ExtensionAPI,
	policy: SnapshotReader,
	activeToolTokens: () => number,
	notes: RolloverResources["notes"],
): void {
	pi.on("session_before_compact", (event, ctx) => {
		try {
			const preparation = prepareAutomatic(pi, event, ctx, {
				policy,
				toolTokens: activeToolTokens,
				notes,
			});
			switch (preparation.kind) {
				case "delegate":
					return;
				case "cancel":
					return { cancel: true };
				case "draft":
					return automaticDraft(pi, ctx, preparation.value);
				default: {
					const exhaustive: never = preparation;
					return exhaustive;
				}
			}
		} catch (error) {
			// Hook errors are swallowed by Pi, which would run its summarizer; cancel instead.
			if (!compactionCancelled(event, ctx)) {
				reportAutomaticFailure(ctx, error);
			}
			return { cancel: true };
		}
	});
}
/** Owns per-turn reset requests and leaf-certified reminder state. Pi owns persistence and scheduling. */
export function registerRollover(
	pi: ExtensionAPI,
	policy: SnapshotReader,
	activeToolTokens: () => number,
	resources: RolloverResources,
): void {
	const resetRequests = new ResetRequests(pi);
	const reminders = createReminderLookup();
	const resetTurn = () => {
		resetRequests.clear();
		resources.resetPages();
	};
	pi.on("turn_start", resetTurn);
	pi.on("session_start", () => {
		resetTurn();
		reminders.reset();
	});
	pi.on("session_tree", () => {
		reminders.reset();
	});
	registerGuidance(pi, policy);
	registerReminderFilter(pi, policy, reminders);
	registerAutomaticRollover(pi, policy, activeToolTokens, resources.notes);
	pi.on("turn_end", (event, ctx) => {
		const summary = resetRequests.take(event.toolResults);
		const host = policy(ctx);
		if (
			event.message.role === "assistant" &&
			(event.message.stopReason === "error" || event.message.stopReason === "aborted")
		) {
			return;
		}
		if (summary !== undefined) {
			return explicitReset(event, ctx, summary, () =>
				freshPayloadChars(host, activeToolTokens(), event.context.pendingMessages),
			);
		}
		const fallback = thresholdFallback(pi, event, ctx, {
			host,
			toolTokens: activeToolTokens,
			notes: resources.notes,
		});
		if (fallback.kind === "draft") {
			return fallback.value;
		}
		const reminder = reminderDecision(event, ctx, host, reminders);
		if (reminder.kind === "send") {
			pi.sendMessage(
				{
					customType: REMINDER_TYPE,
					content: `[posthorse] Routine task-note update.\n${CHECKPOINT_GUIDANCE}`,
					display: true,
					details: reminder.fingerprint,
				},
				{ deliverAs: "steer" },
			);
		}
		return;
	});
	registerContextTools(pi, policy, activeToolTokens, (id, handoff) => {
		resetRequests.request(id, handoff);
	});
}
