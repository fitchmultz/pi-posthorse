import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolCards, type PosthorseDisplay } from "../ui.ts";
import {
	budgetFor,
	freshPayloadChars,
	SNAPSHOT_NOTE,
	unsupportedMessage,
	type Budget,
} from "./budget.ts";
import {
	EMPTY_HANDOFF,
	MAX_HANDOFF_CHARS,
	textResult,
	type PolicyContext,
	type TextResult,
} from "./contracts.ts";

function rolloverStatus(budget: Budget | undefined): "disabled" | "enabled" | "unsupported" {
	if (budget?.enabled !== true) {
		return "disabled";
	}
	return budget.supported ? "enabled" : "unsupported";
}
function contextReport(host: PolicyContext): TextResult {
	const usage = host.getContextUsage();
	if (usage === undefined || usage.tokens === null) {
		return textResult("Context usage is not known until the next model response.", [], {
			kind: "context",
		});
	}
	const n = (value: number) => value.toLocaleString("en-US");
	const budget = budgetFor(host, usage.contextWindow);
	const rollover = rolloverStatus(budget);
	const display: PosthorseDisplay = {
		kind: "context",
		usage,
		rollover,
		rolloverAt: budget?.rolloverAt,
	};
	const configured = `≈${n(Math.max(0, usage.contextWindow - usage.tokens))} tokens until the configured context limit (${n(usage.tokens)}/${n(usage.contextWindow)} used, ${Math.round(usage.percent ?? 0)}%). Best available native estimate. ${SNAPSHOT_NOTE}`;
	if (budget?.enabled !== true) {
		return textResult(
			`Automatic rollover is disabled in the available settings (Pi compaction.enabled=false). ${configured}`,
			[],
			display,
		);
	}
	if (!budget.supported) {
		return textResult(`${unsupportedMessage(budget)} ${configured}`, [], display);
	}
	return textResult(
		`≈${n(Math.max(0, budget.rolloverAt - usage.tokens))} tokens until automatic rollover (line at ${n(budget.rolloverAt)}); ${configured}`,
		[],
		display,
	);
}
export function registerContextTools(
	pi: ExtensionAPI,
	policy: (ctx: ExtensionContext) => PolicyContext,
	activeToolTokens: () => number,
	requestReset: (id: string, handoff: string) => void,
): void {
	pi.registerTool({
		name: "new_context",
		label: "New Context",
		...toolCards("new_context"),
		description:
			"Start a fresh context window once the current foreground tools succeed; background work continues across the reset. Earlier conversation stays recoverable through history. Put continuation state in handoff, or save fuller state in notes first.",
		promptSnippet: "request a fresh context window with an optional handoff",
		parameters: Type.Object({
			handoff: Type.Optional(
				Type.String({
					description: "What the fresh window needs to continue, as readable prose",
					maxLength: MAX_HANDOFF_CHARS,
				}),
			),
		}),
		// Pi's fixed tool contract supplies id, params, signal, updates, and context.
		// oxlint-disable-next-line max-params
		async execute(id, { handoff }, _signal, _onUpdate, ctx) {
			const trimmed = handoff?.trim();
			const limit = freshPayloadChars(policy(ctx), activeToolTokens());
			if (trimmed !== undefined && trimmed !== "" && trimmed.length > limit) {
				throw new Error(
					`Handoff is too large for the active model (${trimmed.length.toLocaleString("en-US")} characters; limit ${limit.toLocaleString("en-US")}). Save fuller state in notes, then retry with a shorter handoff or no handoff.`,
				);
			}
			const result = textResult(
				"Requested a fresh Pi context after the current foreground tools succeed. Background work continues across the reset. Earlier conversation stays in session history.",
				[],
				{ kind: "new-context" },
			);
			requestReset(id, trimmed === undefined || trimmed === "" ? EMPTY_HANDOFF : trimmed);
			return result;
		},
	});
	pi.registerTool({
		name: "get_context_remaining",
		label: "Context Remaining",
		...toolCards("get_context_remaining"),
		description:
			"Estimate tokens left before Pi's automatic rollover and the configured context limit. Check before reporting remaining space or changing your work plan because of context limits. A checkpoint reminder already arrives before rollover; no routine checks are needed.",
		promptSnippet:
			"verify remaining context before reporting a token count or changing plans because of context limits",
		parameters: Type.Object({}),
		// Pi's fixed tool contract supplies id, params, signal, updates, and context.
		// oxlint-disable-next-line max-params
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return contextReport(policy(ctx));
		},
	});
}
