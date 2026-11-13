import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolCards, type PosthorseDisplay } from "../ui.ts";
import { budgetFor, freshPayloadChars, unsupportedMessage, type Budget } from "./budget.ts";
import { activeGuidanceTools } from "./guidance.ts";
import { EMPTY_HANDOFF, MAX_HANDOFF_CHARS, formatCount, type PolicyContext } from "./contracts.ts";
import { textResult, type TextResult } from "./ui/display.ts";

function rolloverStatus(budget: Budget | undefined): "disabled" | "enabled" | "unsupported" {
	return budget?.state ?? "disabled";
}
function contextReport(host: PolicyContext, newContextAvailable: boolean): TextResult {
	const usage = host.getContextUsage();
	if (usage === undefined || usage.tokens === null) {
		return textResult("Context usage is not known until the next model response.", [], {
			kind: "context",
		});
	}
	const budget = budgetFor(host, usage.contextWindow);
	const rollover = rolloverStatus(budget);
	const display: PosthorseDisplay = {
		kind: "context",
		usage,
		rollover,
		...(budget?.rolloverAt === undefined ? {} : { rolloverAt: budget.rolloverAt }),
	};
	const configured = `≈${formatCount(Math.max(0, usage.contextWindow - usage.tokens))} tokens until the configured context limit (${formatCount(usage.tokens)}/${formatCount(usage.contextWindow)} used, ${Math.round(usage.percent ?? 0)}%). Best available native estimate.`;
	if (budget === undefined || budget.state === "disabled") {
		return textResult(
			`Automatic rollover is disabled in the available settings (Pi compaction.enabled=false). ${configured}`,
			[],
			display,
		);
	}
	if (budget.state === "unsupported") {
		return textResult(
			`${unsupportedMessage(budget, newContextAvailable)} ${configured}`,
			[],
			display,
		);
	}
	return textResult(
		`≈${formatCount(Math.max(0, budget.rolloverAt - usage.tokens))} tokens until automatic rollover (line at ${formatCount(budget.rolloverAt)}); ${configured}`,
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
			"Optionally request a deliberate clean context reset once the current foreground tools succeed; retains no prior messages, unlike automatic rollover. Not required after a notes reminder. Background work continues. Earlier conversation stays recoverable through history. Put continuation state in handoff, or save fuller state in notes first.",
		promptSnippet: "optionally request a clean context reset with an optional handoff",
		parameters: Type.Object({
			handoff: Type.Optional(
				Type.String({
					description: "What the fresh window needs to continue, as readable prose",
					maxLength: MAX_HANDOFF_CHARS,
				}),
			),
		}),
		async execute(...[id, { handoff }, , , ctx]) {
			const trimmed = handoff?.trim();
			const limit = freshPayloadChars(policy(ctx), activeToolTokens());
			if (trimmed !== undefined && trimmed !== "" && trimmed.length > limit) {
				throw new Error(
					`Handoff is too large for the active model (${formatCount(trimmed.length)} characters; limit ${formatCount(limit)}). Save fuller state in notes, then retry with a shorter handoff or no handoff.`,
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
			"Estimate tokens left before Pi's automatic rollover and the configured context limit. Check before reporting remaining space or changing your work plan because of context limits. A notes-only reminder may arrive before rollover on a working turn; continue afterward and let rollover happen automatically. No routine checks are needed.",
		promptSnippet:
			"verify remaining context before reporting a token count or changing plans because of context limits",
		parameters: Type.Object({}),
		async execute(...[, , , , ctx]) {
			return contextReport(policy(ctx), activeGuidanceTools(pi).newContext);
		},
	});
}
