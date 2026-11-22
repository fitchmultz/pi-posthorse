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
	guidanceUpdateMessage,
	resolveGuidancePlacement,
	wrapGuidanceSection,
	type GuidancePlan,
	type GuidanceUpdate,
} from "./guidance-placement.ts";
import {
	sessionEntry,
	toolFacts,
	type SessionHost,
	type SessionIdentity,
	type ToolRegistry,
} from "./host.ts";

export type { GuidancePlan, GuidanceUpdate } from "./guidance-placement.ts";

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
type GuidanceTimeline = {
	readonly byBudget: ReadonlyMap<string, string>;
	readonly tools: GuidanceTools | undefined;
	readonly leadingText: string | undefined;
	readonly activeText: string | undefined;
	readonly sawAssistant: boolean;
	readonly hasMessageSinceLastUpdate: boolean;
	readonly updates: readonly GuidanceUpdate[];
};
type MemoryEpoch = {
	readonly byBudget: Map<string, string>;
	tools: GuidanceTools | undefined;
	leadingText: string | undefined;
	activeText: string | undefined;
};
type GuidanceEpoch = GuidanceTimeline & {
	readonly anchorKey: string;
	readonly anchorId: string | undefined;
	readonly firstPostAnchorId: string | undefined;
};
export type WindowGuidance = {
	/** Only the session manager is read; the same context the epoch cache accepts. */
	readonly resolve: (ctx: SessionContext, host: PolicyContext) => string;
	readonly deliver: (ctx: SessionContext, host: PolicyContext) => string;
	readonly plan: (ctx: SessionContext, host: PolicyContext) => GuidancePlan;
	readonly reset: () => void;
};

export function activeGuidanceTools(pi: ToolRegistry): GuidanceTools {
	const { activeUnnamespaced } = toolFacts(pi);
	return {
		newContext: activeUnnamespaced.has("new_context"),
		getContextRemaining: activeUnnamespaced.has("get_context_remaining"),
	};
}
function isCompletedAssistantEntry(entry: EntryLike): boolean {
	return (
		entry.type === "message" &&
		entry.message?.role === "assistant" &&
		entry.message.stopReason !== "error" &&
		entry.message.stopReason !== "aborted"
	);
}
function isMessageProducingEntry(entry: EntryLike): boolean {
	if (entry.type === "message") {
		return entry.message?.role !== "system" && entry.message?.excludeFromContext !== true;
	}
	return (
		entry.type === "custom_message" ||
		entry.type === "branch_summary" ||
		entry.type === "compaction"
	);
}
function nextUpdates(
	state: GuidanceTimeline,
	entryId: string | undefined,
	text: string,
): readonly GuidanceUpdate[] {
	if (!state.hasMessageSinceLastUpdate && state.updates.length > 0) {
		const priorText = state.updates.at(-2)?.text ?? state.leadingText;
		if (text === priorText) {
			return state.updates.slice(0, -1);
		}
		return [...state.updates.slice(0, -1), { entryId, text }];
	}
	return [...state.updates, { entryId, text }];
}
function applyGuidanceRecord(
	state: GuidanceTimeline,
	entryId: string | undefined,
	record: WindowGuidanceRecord,
): GuidanceTimeline {
	const byBudget = new Map(state.byBudget);
	byBudget.set(record.budgetKey, record.text);
	const tools = state.tools ?? record.tools;
	if (state.leadingText === undefined || !state.sawAssistant) {
		return {
			...state,
			byBudget,
			tools,
			leadingText: record.text,
			activeText: record.text,
		};
	}
	if (record.text === state.activeText) {
		return { ...state, byBudget, tools };
	}
	return {
		...state,
		byBudget,
		tools,
		activeText: record.text,
		hasMessageSinceLastUpdate: false,
		updates: nextUpdates(state, entryId, record.text),
	};
}
function stepNonGuidanceEntry(state: GuidanceTimeline, entry: EntryLike): GuidanceTimeline {
	const sawAssistant =
		state.sawAssistant || (state.leadingText !== undefined && isCompletedAssistantEntry(entry));
	const hasMessageSinceLastUpdate =
		state.hasMessageSinceLastUpdate || isMessageProducingEntry(entry);
	if (
		sawAssistant === state.sawAssistant &&
		hasMessageSinceLastUpdate === state.hasMessageSinceLastUpdate
	) {
		return state;
	}
	return { ...state, sawAssistant, hasMessageSinceLastUpdate };
}
function emptyTimeline(): GuidanceTimeline {
	return {
		byBudget: new Map<string, string>(),
		tools: undefined,
		leadingText: undefined,
		activeText: undefined,
		sawAssistant: false,
		hasMessageSinceLastUpdate: false,
		updates: [],
	};
}
/**
 * Replay oldest first: the last text per budget wins, the first record fixes epoch tools, and once
 * a completed assistant reply follows the initial delivery, later text changes become mid-window
 * updates anchored to their journal entries so the leading system message stays immutable.
 */
function collectGuidanceEntries(
	entries: readonly EntryLike[],
	base?: GuidanceTimeline,
): GuidanceTimeline {
	let state = base ?? emptyTimeline();
	for (const entry of entries) {
		if (
			entry.type === "custom" &&
			entry.customType === WINDOW_GUIDANCE_TYPE &&
			Check(guidanceRecordSchema, entry.data)
		) {
			state = applyGuidanceRecord(state, entry.id, entry.data);
		} else {
			state = stepNonGuidanceEntry(state, entry);
		}
	}
	return state;
}
function withMemoryEpoch(
	collected: GuidanceTimeline,
	memory: MemoryEpoch | undefined,
): GuidanceTimeline {
	if (memory === undefined) {
		return collected;
	}
	const merged = new Map(collected.byBudget);
	for (const [key, text] of memory.byBudget) {
		if (!merged.has(key)) {
			merged.set(key, text);
		}
	}
	return {
		...collected,
		byBudget: merged,
		tools: collected.tools ?? memory.tools,
		leadingText: collected.leadingText ?? memory.leadingText,
		activeText: collected.activeText ?? memory.activeText,
	};
}
function extendPreviousEpoch(
	previous: GuidanceEpoch,
	tail: readonly EntryLike[],
	memoryByEpoch: ReadonlyMap<string, MemoryEpoch> | undefined,
): GuidanceEpoch {
	const collected = collectGuidanceEntries(tail, previous);
	return {
		anchorKey: previous.anchorKey,
		anchorId: previous.anchorId,
		firstPostAnchorId: previous.firstPostAnchorId ?? tail[0]?.id,
		...withMemoryEpoch(collected, memoryByEpoch?.get(previous.anchorKey)),
	};
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
			return extendPreviousEpoch(previous.value, reversed.reverse(), memoryByEpoch);
		}
		if (startsFreshGuidanceEpoch(entry)) {
			anchor = entry;
			break;
		}
		reversed.push(entry);
	}
	const ordered = reversed.reverse();
	const anchorKey =
		anchor === undefined
			? `${identity.sessionId}:root`
			: `${identity.sessionId}:${anchor.id ?? "boundary"}`;
	const collected = collectGuidanceEntries(ordered);
	return {
		anchorKey,
		anchorId: anchor?.id,
		firstPostAnchorId: ordered[0]?.id,
		...withMemoryEpoch(collected, memoryByEpoch?.get(anchorKey)),
	};
}
/**
 * A fresh anchor retires every earlier one on this branch: nothing reads an old epoch again
 * without /tree, which resets all memory. Keep only the current anchor's delivered text.
 */
function pruneRetiredEpochs(
	memoryByManager: WeakMap<object, Map<string, MemoryEpoch>>,
	manager: object,
	anchorKey: string,
): void {
	const byEpoch = memoryByManager.get(manager);
	if (byEpoch === undefined) {
		return;
	}
	for (const key of byEpoch.keys()) {
		if (key !== anchorKey) {
			byEpoch.delete(key);
		}
	}
}
function recordMemoryEpoch(
	memoryByManager: WeakMap<object, Map<string, MemoryEpoch>>,
	manager: object,
	anchorKey: string,
	entry: { readonly key: string; readonly text: string; readonly tools: GuidanceTools },
): void {
	let byEpoch = memoryByManager.get(manager);
	if (byEpoch === undefined) {
		byEpoch = new Map();
		memoryByManager.set(manager, byEpoch);
	}
	let memory = byEpoch.get(anchorKey);
	if (memory === undefined) {
		memory = {
			byBudget: new Map(),
			tools: entry.tools,
			leadingText: entry.text,
			activeText: entry.text,
		};
		byEpoch.set(anchorKey, memory);
	}
	memory.byBudget.set(entry.key, entry.text);
	memory.tools ??= entry.tools;
	memory.leadingText ??= entry.text;
	memory.activeText = entry.text;
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
	 * Delivering guidance from inside the request hook must persist before the request: a
	 * restart after a rollover with a provider summary block has to reuse these exact bytes —
	 * the leading system message is sent unchanged, and in-memory delivery state does not
	 * survive. On the fork, the provider-summary request runs this hook mid-compaction. That
	 * is safe twice over: the request that reached the rollover threshold already delivered
	 * this budget's text, so the summary request reuses it and writes nothing; and a
	 * compaction with a summary block keeps the previous guidance anchor, so even a budget
	 * change mid-compaction appends inside the epoch the next window still reads.
	 */
	const plan = (ctx: SessionContext, host: PolicyContext): GuidancePlan => {
		let epoch = epochs.read(ctx);
		pruneRetiredEpochs(memoryByManager, ctx.sessionManager, epoch.anchorKey);
		const key = budgetGuidanceKey(host);
		const desired =
			epoch.byBudget.get(key) ?? buildGuidance(host, epoch.tools ?? activeGuidanceTools(pi));
		if (epoch.activeText !== desired) {
			const tools = epoch.tools ?? activeGuidanceTools(pi);
			recordMemoryEpoch(memoryByManager, ctx.sessionManager, epoch.anchorKey, {
				key,
				text: desired,
				tools,
			});
			epochs.reset();
			pi.appendEntry(WINDOW_GUIDANCE_TYPE, {
				version: 1,
				budgetKey: key,
				text: desired,
				tools,
			} satisfies WindowGuidanceRecord);
			epoch = epochs.read(ctx);
		}
		return {
			anchorId: epoch.anchorId,
			firstPostAnchorId: epoch.firstPostAnchorId,
			leading: epoch.leadingText ?? desired,
			current: desired,
			updates: epoch.updates,
		};
	};
	return {
		resolve(ctx, host) {
			const epoch = epochs.read(ctx);
			const key = budgetGuidanceKey(host);
			return (
				epoch.byBudget.get(key) ?? buildGuidance(host, epoch.tools ?? ALL_GUIDANCE_TOOLS)
			);
		},
		deliver(ctx, host) {
			return plan(ctx, host).current;
		},
		plan,
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
		const plan = windowGuidance.plan(ctx, policy(ctx));
		const system = event.messages.find((message) => message.role === "system");
		if (system === undefined) {
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
				content: plan.current,
				display: false,
				timestamp: 0,
			});
			return;
		}
		const placement = resolveGuidancePlacement(event.messages, ctx, plan);
		system.sections = {
			...system.sections,
			posthorse: wrapGuidanceSection(placement.leading),
		};
		let offset = 0;
		for (const item of placement.insertions) {
			event.messages.splice(item.at + offset, 0, guidanceUpdateMessage(item.text));
			offset += 1;
		}
	});
}
