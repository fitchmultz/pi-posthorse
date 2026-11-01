import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildGuidance } from "./budget.ts";
import type { SnapshotReader } from "./contracts.ts";

export function registerGuidance(pi: ExtensionAPI, policy: SnapshotReader): void {
	let promptOptions: { readonly forceSystemPrompt?: string } | undefined;
	pi.on("before_agent_start", (event) => {
		promptOptions = event.systemPromptOptions;
	});
	pi.on("agent_settled", () => {
		// Prompt options belong to one run, never to later idle context evaluation.
		promptOptions = undefined;
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
