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
			: `The rollover line is ${budget.rolloverAt.toLocaleString("en-US")} tokens used. `;
	return `Pi rolls context over automatically, so the context window is not a deadline. Do not reduce scope, skip steps or verification, or write a final summary because rollover is near, and do not wait for the user to say "continue". Finish when the requested work and its verification are complete, or report a genuine blocker.
${line}Rollover keeps a recent-message tail without summarizing. One task-note reminder may arrive at the end of a working turn near the line: update the note only if it is stale, or write one if the task has none, then continue with the next step in the same run. new_context is an optional clean reset.`;
}
export function buildGuidance(ctx: PolicyContext): string {
	const budget = budgetFor(ctx);
	const enabled = budget?.enabled ?? ctx.getCompactionSettings().enabled;
	const capacity =
		budget === undefined
			? "Configured context capacity is unknown."
			: `Configured context capacity: ${budget.contextWindow.toLocaleString("en-US")} tokens (not remaining space).`;
	return `## Automatic context management (Posthorse)
${automaticGuidance(budget, enabled)}
${capacity} Do not guess capacity or remaining space from response-token or reasoning limits. Before reporting a remaining-token count or changing your work plan because of context limits, call get_context_remaining. If usage is unknown, report it as unknown. No routine budget checks are needed.
After a rollover, earlier conversation stays in history. Restore notes and todos, then verify live state before stateful or external work; automatic handoffs record inputs, not progress.
Keep one concise current-state note per task: goal, progress, decisions, and next steps. Preserve decisions and safety constraints, link fuller evidence instead of copying it, and edit only changed sections.`;
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
