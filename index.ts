/**
 * Posthorse — fresh context, same journey.
 *
 * Pi owns persisted retain-none context boundaries. Posthorse owns reminder and
 * rollover policy, bounded recovery, durable notes, and history retrieval.
 */
import {
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerPosthorseMessages } from "./ui.ts";
import { policySnapshot } from "./src/budget.ts";
import type { CompactionPolicy, PolicyReader } from "./src/contracts.ts";
import { registerHistory } from "./src/history.ts";
import { safeJsonStringify } from "./src/message-text.ts";
import { registerNotes } from "./src/notes.ts";
import { PageReservations } from "./src/paging.ts";
import { registerRollover } from "./src/rollover.ts";

function activeToolTokens(pi: ExtensionAPI): number {
	const active = new Set(pi.getActiveTools());
	return pi
		.getAllTools()
		.filter((tool) => active.has(tool.name))
		.reduce(
			(total, tool) =>
				total +
				Math.ceil(
					safeJsonStringify({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					}).length / 4,
				),
			0,
		);
}
/** Use Pi's live effective settings by default; SDK hosts can inject a policy reader. */
export function createPosthorse(getPolicy?: PolicyReader): (pi: ExtensionAPI) => void {
	return (pi) => {
		const readPolicy: PolicyReader =
			getPolicy ??
			((ctx) => SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(ctx.model));
		const policy = (ctx: ExtensionContext, livePolicy?: CompactionPolicy) =>
			policySnapshot(ctx, readPolicy, livePolicy);
		const toolTokens = () => activeToolTokens(pi);
		const pages = new PageReservations(toolTokens);
		registerPosthorseMessages(pi);
		registerRollover(pi, policy, toolTokens, () => {
			pages.reset();
		});
		registerNotes(pi, policy, pages);
		registerHistory(pi, policy, pages);
	};
}
export default createPosthorse();
