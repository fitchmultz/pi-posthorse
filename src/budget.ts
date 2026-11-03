import { estimateTokens, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ESTIMATED_IMAGE_CHARS,
	MAX_HANDOFF_CHARS,
	MAX_PAGE_CHARS,
	PAGE_MARGIN_TOKENS,
	type CompactionPolicy,
	type ContextUsage,
	type MessageLike,
	type PolicyContext,
	type PolicyReader,
} from "./contracts.ts";
import { imagesOf, textOf } from "./message-text.ts";

const MIN_USABLE_TOKENS = Math.ceil(MAX_HANDOFF_CHARS / 4) * 2;
export const CHECKPOINT_GUIDANCE = `Keep working on the assigned task; Pi handles context rollover automatically.

The current context window is not a deadline for finishing your task. Do not reduce scope, skip prescribed steps or verification, or issue a final progress summary because rollover is approaching.

Update the task's current-state note if needed: goal, progress, decisions, and next steps. Use available file-editing tools at its absolute path; use notes write only for creation, substantial restructuring, or when editing tools are unavailable. Leave an already-current note unchanged. Then immediately execute the next prescribed task step in this run. No new_context call, waiting for rollover, or user "continue" is needed.

Finish when the requested work and required verification are complete, or report a genuine blocker. Approaching context rollover is not a blocker.`;
export type Budget = {
	readonly contextWindow: number;
	readonly reserveTokens: number;
	readonly enabled: boolean;
	readonly usable: number;
	readonly rolloverAt: number;
	readonly supported: boolean;
};
/** A synchronous evaluation owns one snapshot; never carry it across an await. */
export function policySnapshot(
	ctx: ExtensionContext,
	getPolicy: PolicyReader,
	livePolicy?: CompactionPolicy,
): PolicyContext {
	let usageRead = false;
	let usage: ContextUsage | undefined;
	let settings: CompactionPolicy | undefined;
	return {
		getCompactionSettings: () => {
			settings ??= { ...(livePolicy ?? getPolicy(ctx)) };
			return settings;
		},
		getContextUsage: () => {
			if (!usageRead) {
				usage = ctx.getContextUsage();
				usageRead = true;
			}
			return usage;
		},
		getSystemPrompt: () => ctx.getSystemPrompt(),
	};
}
export function budgetFor(
	ctx: PolicyContext,
	contextWindow = ctx.getContextUsage()?.contextWindow,
): Budget | undefined {
	if (contextWindow === undefined || contextWindow <= 0) {
		return undefined;
	}
	const { enabled, reserveTokens } = ctx.getCompactionSettings();
	const usable = contextWindow - reserveTokens;
	return {
		contextWindow,
		reserveTokens,
		enabled,
		usable,
		rolloverAt: usable + 1,
		supported: !enabled || usable >= MIN_USABLE_TOKENS,
	};
}
export function unsupportedMessage(budget: Budget): string {
	const n = (value: number) => value.toLocaleString("en-US");
	return `Posthorse: unsupported configuration. The model's context window (${n(budget.contextWindow)} tokens) minus Pi's compaction.reserveTokens (${n(budget.reserveTokens)}) leaves ${n(budget.usable)} usable tokens; Posthorse needs at least ${n(MIN_USABLE_TOKENS)}. Automatic Posthorse rollover and checkpoint reminders are off for this model, so Pi's own compaction applies. Lower compaction.reserveTokens in Pi settings or use a larger-context model. new_context remains available with a model-aware handoff limit.`;
}
function automaticGuidance(budget: Budget | undefined, enabled: boolean): string {
	if (!enabled) {
		return "Pi compaction is disabled in the available settings, so Posthorse sends no checkpoint reminder. new_context remains available.";
	}
	if (budget !== undefined && !budget.supported) {
		return unsupportedMessage(budget);
	}
	const line =
		budget === undefined
			? ""
			: ` The rollover line is ${budget.rolloverAt.toLocaleString("en-US")} tokens used under the available Pi settings.`;
	return `${CHECKPOINT_GUIDANCE}\nAutomatic rollover follows Pi's compaction setting and retains a safe recent-message tail using compaction.keepRecentTokens, without model summarization.${line} At most one routine task-note reminder may arrive at the end of a working turn, never on a turn that ends the run. new_context is an optional deliberate clean reset, not a checkpoint requirement.`;
}
export function buildGuidance(ctx: PolicyContext): string {
	const budget = budgetFor(ctx);
	const enabled = budget?.enabled ?? ctx.getCompactionSettings().enabled;
	const capacity =
		budget === undefined
			? "Configured context capacity is unknown."
			: `Configured context capacity: ${budget.contextWindow.toLocaleString("en-US")} tokens. This is Pi's best available native limit, not remaining space or a measured provider boundary. Fresh windows use the active configuration; system instructions, tools, the handoff, retained recent messages, and new messages consume part of it.`;
	return `## Automatic context management (Posthorse)
${automaticGuidance(budget, enabled)}
${capacity}
Do not guess context capacity or remaining space from response-token limits or reasoning budgets. Before reporting a remaining-token count or changing your work plan because of context limits, call get_context_remaining. If usage is unknown, report it as unknown. No routine budget checks are needed.
After a rollover, earlier conversation stays in history. Restore notes and todos, then verify live state before stateful or external work; automatic handoffs record inputs, not progress.
Keep one concise current-state note per task. Preserve decisions and safety constraints; link fuller evidence and history instead of copying them. Edit changed sections rather than resending unchanged content.
Write handoffs and notes as normal readable prose; notes and history search match literal text.`;
}
/** ponytail: native estimates omit request-local guidance; reserve it until post-transform usage is exposed. */
export function guidanceTokens(ctx: PolicyContext): number {
	return estimateTokens({
		role: "system",
		content: `<posthorse>\n${buildGuidance(ctx)}\n</posthorse>`,
		timestamp: 0,
	});
}
/** Half the fresh capacity after prompt/tool/input overhead remains for continued work. */
export function freshPayloadChars(
	ctx: PolicyContext,
	toolTokens: number,
	pendingMessages: readonly MessageLike[] = [],
	cap = MAX_HANDOFF_CHARS,
): number {
	const budget = budgetFor(ctx);
	if (budget === undefined) {
		return cap;
	}
	const line = budget.enabled && budget.supported ? budget.rolloverAt : budget.contextWindow;
	const promptTokens = Math.ceil(ctx.getSystemPrompt().length / 4) + guidanceTokens(ctx);
	const pendingTokens = pendingMessages.reduce(
		(total, message) =>
			total +
			Math.ceil(textOf(message).length / 4) +
			imagesOf(message.content).length * (ESTIMATED_IMAGE_CHARS / 4),
		0,
	);
	return Math.min(
		cap,
		Math.max(
			0,
			Math.floor((line - PAGE_MARGIN_TOKENS - promptTokens - toolTokens - pendingTokens) / 2),
		) * 4,
	);
}
export function pageCapacity(ctx: PolicyContext, toolTokens: () => number): number {
	const usage = ctx.getContextUsage();
	if (usage === undefined || usage.tokens === null) {
		return freshPayloadChars(ctx, toolTokens(), [], MAX_PAGE_CHARS) / 4 + PAGE_MARGIN_TOKENS;
	}
	const budget = budgetFor(ctx, usage.contextWindow);
	const line =
		budget?.enabled === true && budget.supported ? budget.rolloverAt : usage.contextWindow;
	return line - usage.tokens - guidanceTokens(ctx);
}
