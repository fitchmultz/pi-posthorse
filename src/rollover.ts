import type {
	BoundaryResult,
	ExtensionAPI,
	ExtensionContext,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
	budgetFor,
	buildGuidance,
	CHECKPOINT_STEPS,
	freshPayloadChars,
	type Budget,
} from "./budget.ts";
import {
	isRecord,
	isReminderType,
	MIN_PAGE_CHARS,
	REMINDER_TYPE,
	type CompactionPolicy,
	type PolicyContext,
	type ReminderFingerprint,
} from "./contracts.ts";
import { registerContextTools } from "./context-tools.ts";
import { safeJsonStringify } from "./message-text.ts";
import { buildAutoHandoff } from "./recovery.ts";
import {
	createReminderLookup,
	hasReminder,
	reminderMatches,
	type ReminderLookup,
} from "./reminders.ts";

export type SnapshotReader = (
	ctx: ExtensionContext,
	livePolicy?: CompactionPolicy,
) => PolicyContext;
const REMINDER_BUFFER_TOKENS = 32_000;
function registerGuidance(pi: ExtensionAPI, policy: SnapshotReader): void {
	let promptOptions: { readonly forceSystemPrompt?: string } | undefined;
	pi.on("before_agent_start", (event) => {
		promptOptions = event.systemPromptOptions;
	});
	pi.on("context_with_system", (event, ctx) => {
		const guidance = buildGuidance(policy(ctx));
		const system =
			event.messages.findLast(
				(message) =>
					message.role === "system" && typeof message.sections?.posthorse === "string",
			) ?? event.messages.find((message) => message.role === "system");
		if (system === undefined || system.role !== "system") {
			return;
		}
		if (promptOptions?.forceSystemPrompt !== undefined) {
			// ponytail: Pi applies forced prompts after this hook; keep request-local guidance
			// until the host projects forced text before context_with_system.
			event.messages.splice(1, 0, {
				role: "custom",
				customType: "posthorse-guidance",
				content: guidance,
				display: false,
				timestamp: 0,
			});
		} else {
			system.sections = {
				...system.sections,
				posthorse: `<posthorse>\n${guidance}\n</posthorse>`,
			};
		}
	});
}
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
function reminderBudget(
	host: PolicyContext,
): { readonly budget: Budget; readonly tokens: number } | undefined {
	const usage = host.getContextUsage();
	if (usage === undefined || usage.tokens === null || usage.contextWindow <= 0) {
		return undefined;
	}
	const budget = budgetFor(host, usage.contextWindow);
	if (
		budget === undefined ||
		!budget.enabled ||
		!budget.supported ||
		usage.tokens >= budget.rolloverAt
	) {
		return undefined;
	}
	const buffer = Math.min(REMINDER_BUFFER_TOKENS, Math.floor(budget.usable * 0.1));
	return usage.tokens < budget.rolloverAt - buffer ? undefined : { budget, tokens: usage.tokens };
}
function sendReminder(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	available: { readonly budget: Budget; readonly tokens: number },
	reminders: ReminderLookup,
): void {
	const { budget, tokens } = available;
	const state = reminders.read(ctx);
	const fingerprint: ReminderFingerprint = {
		windowId: state.windowId,
		contextWindow: budget.contextWindow,
		reserveTokens: budget.reserveTokens,
	};
	if (hasReminder(state.reminders, fingerprint)) {
		return;
	}
	pi.sendMessage(
		{
			customType: REMINDER_TYPE,
			content: `[posthorse] Checkpoint now: ${(budget.rolloverAt - tokens).toLocaleString("en-US")} tokens remain before Pi's automatic rollover line. Stop normal work, ${CHECKPOINT_STEPS}.`,
			display: true,
			details: fingerprint,
		},
		{ deliverAs: "steer" },
	);
}
function registerReminderFilter(
	pi: ExtensionAPI,
	policy: SnapshotReader,
	reminders: ReminderLookup,
): void {
	pi.on("context", (event, ctx) => {
		if (
			!event.messages.some(
				(message) => message.role === "custom" && isReminderType(message.customType),
			)
		) {
			return;
		}
		const marker = event.messages.find(
			(message) => message.role === "custom" && message.customType === "context-window",
		);
		let windowId: unknown;
		if (marker?.role === "custom") {
			windowId = isRecord(marker.details) ? marker.details.windowId : undefined;
		} else {
			windowId = reminders.read(ctx).windowId;
		}
		if (typeof windowId !== "string") {
			return;
		}
		const host = policy(ctx);
		const budget = budgetFor(host);
		const fingerprint: ReminderFingerprint = {
			windowId,
			contextWindow: budget?.contextWindow,
			reserveTokens: budget?.reserveTokens,
		};
		const enabled = host.getCompactionSettings().enabled;
		const stale = (message: {
			readonly role: string;
			readonly customType?: string;
			readonly details?: unknown;
		}) =>
			message.role === "custom" &&
			isReminderType(message.customType) &&
			(!enabled || !reminderMatches(message.details, fingerprint));
		if (event.messages.some(stale)) {
			return { messages: event.messages.filter((message) => !stale(message)) };
		}
		return;
	});
}
function automaticDraft(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	recovery: { readonly handoff: string; readonly tokensBefore: number; readonly reason: string },
) {
	// Public compaction requires an entry id. An invisible sentinel keeps no prior conversation.
	pi.appendEntry("posthorse-boundary", {});
	const firstKeptEntryId = ctx.sessionManager.getLeafId();
	if (firstKeptEntryId === null || firstKeptEntryId === "") {
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
function registerAutomaticRollover(
	pi: ExtensionAPI,
	policy: SnapshotReader,
	activeToolTokens: () => number,
): void {
	pi.on("session_before_compact", (event, ctx) => {
		if (event.reason === "manual") {
			return;
		}
		const cancelled = () => event.signal.aborted || ctx.signal?.aborted === true;
		if (cancelled()) {
			return { cancel: true };
		}
		try {
			const host = policy(ctx, event.preparation.settings);
			if (budgetFor(host)?.supported !== true) {
				return;
			}
			const limit = freshPayloadChars(host, activeToolTokens());
			const ownerQuestionRegistered = pi
				.getAllTools()
				.some((tool) => tool.name === "ask_question" && tool.namespace === undefined);
			const handoff = buildAutoHandoff(
				event.branchEntries,
				ctx.sessionManager.buildSessionProjection().entries,
				limit,
				ownerQuestionRegistered,
			);
			if (limit < MIN_PAGE_CHARS || handoff.length > limit) {
				throw new Error(
					"Too little fresh context capacity for an automatic recovery record.",
				);
			}
			if (cancelled()) {
				return { cancel: true };
			}
			return automaticDraft(pi, ctx, {
				handoff,
				tokensBefore: event.preparation.tokensBefore,
				reason: event.reason,
			});
		} catch (error) {
			// Hook errors are swallowed by Pi, which would run its summarizer; cancel instead.
			if (!cancelled()) {
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
	resetPages: () => void,
): void {
	const resetRequests = new Map<string, string>();
	const reminders = createReminderLookup();
	const resetTurn = () => {
		resetRequests.clear();
		resetPages();
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
	registerAutomaticRollover(pi, policy, activeToolTokens);
	pi.on("turn_end", (event, ctx) => {
		const requested = event.toolResults.find(
			(result) => result.toolName === "new_context" && resetRequests.has(result.toolCallId),
		);
		const summary =
			requested === undefined ? undefined : resetRequests.get(requested.toolCallId);
		resetRequests.clear();
		const host = policy(ctx);
		if (
			event.message.role === "assistant" &&
			(event.message.stopReason === "error" || event.message.stopReason === "aborted")
		) {
			return;
		}
		if (summary !== undefined && !event.toolResults.some((result) => result.isError)) {
			return explicitReset(event, ctx, summary, () =>
				freshPayloadChars(host, activeToolTokens(), event.context.pendingMessages),
			);
		}
		const available = reminderBudget(host);
		if (available !== undefined) {
			sendReminder(pi, ctx, available, reminders);
		}
		return;
	});
	registerContextTools(pi, policy, activeToolTokens, (id, handoff) => {
		resetRequests.set(id, handoff);
	});
}
