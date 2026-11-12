import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
	ALL_GUIDANCE_TOOLS,
	budgetGuidanceKey,
	buildGuidance,
	type GuidanceTools,
} from "./budget.ts";
import type { EntryLike, PolicyContext, SnapshotReader } from "./contracts.ts";
import { startsFreshGuidanceEpoch } from "./boundary.ts";
import { createEpochCache, type EpochValue, type SessionContext } from "./epoch-cache.ts";
import {
	sessionEntry,
	toolFacts,
	type SessionHost,
	type SessionIdentity,
	type ToolRegistry,
} from "./host.ts";

export const WINDOW_GUIDANCE_TYPE = "posthorse-window-guidance";
const guidanceRecordSchema = Type.Object({
	version: Type.Literal(1),
	budgetKey: Type.String(),
	text: Type.String(),
	tools: Type.Object({
		newContext: Type.Boolean(),
		getContextRemaining: Type.Boolean(),
	}),
});
type WindowGuidanceRecord = Static<typeof guidanceRecordSchema>;
type MemoryEpoch = {
	readonly byBudget: Map<string, string>;
	tools: GuidanceTools | undefined;
};
type GuidanceEpoch = {
	readonly anchorKey: string;
	readonly byBudget: ReadonlyMap<string, string>;
	readonly tools: GuidanceTools | undefined;
};
export type WindowGuidance = {
	/** Only the session manager is read; the same context the epoch cache accepts. */
	readonly resolve: (ctx: SessionContext, host: PolicyContext) => string;
	readonly deliver: (ctx: SessionContext, host: PolicyContext) => string;
	readonly reset: () => void;
};

export function activeGuidanceTools(pi: ToolRegistry): GuidanceTools {
	const { activeUnnamespaced } = toolFacts(pi);
	return {
		newContext: activeUnnamespaced.has("new_context"),
		getContextRemaining: activeUnnamespaced.has("get_context_remaining"),
	};
}
function collectGuidanceEntries(
	entries: readonly EntryLike[],
	baseByBudget?: ReadonlyMap<string, string>,
	baseTools?: GuidanceTools,
): { readonly byBudget: Map<string, string>; readonly tools: GuidanceTools | undefined } {
	const byBudget = new Map<string, string>(baseByBudget);
	let tools = baseTools;
	for (const entry of entries) {
		if (
			entry.type === "custom" &&
			entry.customType === WINDOW_GUIDANCE_TYPE &&
			Check(guidanceRecordSchema, entry.data)
		) {
			byBudget.set(entry.data.budgetKey, entry.data.text);
			tools ??= entry.data.tools;
		}
	}
	return { byBudget, tools };
}
function withMemoryEpoch(
	collected: {
		readonly byBudget: Map<string, string>;
		readonly tools: GuidanceTools | undefined;
	},
	memory: MemoryEpoch | undefined,
): { readonly byBudget: ReadonlyMap<string, string>; readonly tools: GuidanceTools | undefined } {
	if (memory === undefined) {
		return collected;
	}
	const merged = new Map(collected.byBudget);
	for (const [key, text] of memory.byBudget) {
		if (!merged.has(key)) {
			merged.set(key, text);
		}
	}
	return { byBudget: merged, tools: collected.tools ?? memory.tools };
}
function scanGuidanceEpoch(
	manager: SessionHost,
	identity: SessionIdentity,
	previous: EpochValue<GuidanceEpoch> | undefined,
	memoryByEpoch: ReadonlyMap<string, MemoryEpoch> | undefined,
): GuidanceEpoch {
	const reversed: EntryLike[] = [];
	let anchor: EntryLike | undefined;
	for (
		let entry = identity.leaf;
		entry !== undefined;
		entry = sessionEntry(manager, entry.parentId)
	) {
		if (previous !== undefined && previous.identity.leaf === entry) {
			const collected = collectGuidanceEntries(
				reversed.reverse(),
				previous.value.byBudget,
				previous.value.tools,
			);
			return {
				anchorKey: previous.value.anchorKey,
				...withMemoryEpoch(collected, memoryByEpoch?.get(previous.value.anchorKey)),
			};
		}
		if (startsFreshGuidanceEpoch(entry)) {
			anchor = entry;
			break;
		}
		reversed.push(entry);
	}
	const anchorKey =
		anchor === undefined
			? `${identity.sessionId}:root`
			: `${identity.sessionId}:${anchor.id ?? "boundary"}`;
	const collected = collectGuidanceEntries(reversed.reverse());
	return {
		anchorKey,
		...withMemoryEpoch(collected, memoryByEpoch?.get(anchorKey)),
	};
}
/** The journal and tool-registry members guidance borrows; the host's full API satisfies these. */
export type GuidanceRegistry = ToolRegistry & Pick<ExtensionAPI, "appendEntry">;

export function createWindowGuidance(pi: GuidanceRegistry): WindowGuidance {
	let memoryByManager = new WeakMap<object, Map<string, MemoryEpoch>>();
	const epochs = createEpochCache<GuidanceEpoch>((ctx, identity, previous) =>
		scanGuidanceEpoch(
			ctx.sessionManager,
			identity,
			previous,
			memoryByManager.get(ctx.sessionManager),
		),
	);
	/**
	 * A fresh anchor retires every earlier one on this branch: nothing reads an old epoch again
	 * without /tree, which resets all memory. Keep only the current anchor's delivered text.
	 */
	const pruneRetiredEpochs = (manager: object, anchorKey: string): void => {
		const byEpoch = memoryByManager.get(manager);
		if (byEpoch === undefined) {
			return;
		}
		for (const key of byEpoch.keys()) {
			if (key !== anchorKey) {
				byEpoch.delete(key);
			}
		}
	};
	return {
		resolve(ctx, host) {
			const epoch = epochs.read(ctx);
			const key = budgetGuidanceKey(host);
			return (
				epoch.byBudget.get(key) ?? buildGuidance(host, epoch.tools ?? ALL_GUIDANCE_TOOLS)
			);
		},
		/**
		 * Delivering guidance from inside the request hook must persist before the request: a
		 * restart after a rollover with a provider summary block has to reuse these exact bytes —
		 * the leading system message is sent unchanged, and in-memory delivery state does not
		 * survive. On the fork, the provider-summary request runs this hook mid-compaction. That
		 * is safe twice over: the request that reached the rollover threshold already delivered
		 * this budget's text, so the summary request reuses it and writes nothing; and a
		 * compaction with a summary block keeps the previous guidance anchor, so even a budget
		 * change mid-compaction appends inside the epoch the next window still reads.
		 */
		deliver(ctx, host) {
			const epoch = epochs.read(ctx);
			pruneRetiredEpochs(ctx.sessionManager, epoch.anchorKey);
			const key = budgetGuidanceKey(host);
			const existing = epoch.byBudget.get(key);
			if (existing !== undefined) {
				return existing;
			}
			const tools = epoch.tools ?? activeGuidanceTools(pi);
			const text = buildGuidance(host, tools);
			let byEpoch = memoryByManager.get(ctx.sessionManager);
			if (byEpoch === undefined) {
				byEpoch = new Map();
				memoryByManager.set(ctx.sessionManager, byEpoch);
			}
			let memory = byEpoch.get(epoch.anchorKey);
			if (memory === undefined) {
				memory = { byBudget: new Map(), tools };
				byEpoch.set(epoch.anchorKey, memory);
			}
			memory.byBudget.set(key, text);
			memory.tools ??= tools;
			epochs.reset();
			pi.appendEntry(WINDOW_GUIDANCE_TYPE, {
				version: 1,
				budgetKey: key,
				text,
				tools,
			} satisfies WindowGuidanceRecord);
			return text;
		},
		reset() {
			epochs.reset();
			memoryByManager = new WeakMap();
		},
	};
}
export function registerGuidance(
	pi: Pick<ExtensionAPI, "on">,
	policy: SnapshotReader,
	windowGuidance: WindowGuidance,
): void {
	let promptOptions: { readonly forceSystemPrompt?: string } | undefined;
	pi.on("before_agent_start", (event) => {
		promptOptions = event.systemPromptOptions;
	});

	pi.on("agent_settled", () => {
		// Prompt options belong to one run, never to later idle context evaluation.
		promptOptions = undefined;
	});
	pi.on("context_with_system", (event, ctx) => {
		const guidance = windowGuidance.deliver(ctx, policy(ctx));
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
			// After a compaction a second system message (the tool update) can follow the first.
			const conversation = event.messages.findIndex((message) => message.role !== "system");
			event.messages.splice(conversation === -1 ? event.messages.length : conversation, 0, {
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
