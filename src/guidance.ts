import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
	ALL_GUIDANCE_TOOLS,
	budgetGuidanceKey,
	buildGuidance,
	type GuidanceTools,
} from "./budget.ts";
import { isRecord, type EntryLike, type PolicyContext, type SnapshotReader } from "./contracts.ts";

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
type EpochState = {
	readonly manager: ExtensionContext["sessionManager"];
	readonly sessionId: string;
	readonly file: string | undefined;
	readonly leaf: EntryLike | undefined;
	readonly anchorKey: string;
	readonly byBudget: ReadonlyMap<string, string>;
	readonly tools: GuidanceTools | undefined;
};
export type WindowGuidance = {
	readonly resolve: (ctx: ExtensionContext, host: PolicyContext) => string;
	readonly deliver: (ctx: ExtensionContext, host: PolicyContext) => string;
	readonly reset: () => void;
};

export function activeGuidanceTools(pi: ExtensionAPI): GuidanceTools {
	const active = new Set(pi.getActiveTools());
	const unnamespaced = new Set(
		pi
			.getAllTools()
			.filter((tool) => tool.namespace === undefined)
			.map((tool) => tool.name),
	);
	return {
		newContext: active.has("new_context") && unnamespaced.has("new_context"),
		getContextRemaining:
			active.has("get_context_remaining") && unnamespaced.has("get_context_remaining"),
	};
}
/**
 * A compaction with a provider summary block carries forward the previous window's leading system
 * message unchanged, so its guidance section must stay locked to that earlier epoch too.
 */
function startsFreshGuidanceEpoch(entry: EntryLike): boolean {
	if (entry.type === "context_window") {
		return true;
	}
	return (
		entry.type === "compaction" &&
		!(isRecord(entry.providerSummary) && isRecord(entry.providerSummary.block))
	);
}
function parentEntry(
	manager: ExtensionContext["sessionManager"],
	id: string | null | undefined,
): EntryLike | undefined {
	const raw: unknown = manager;
	if (id === undefined || id === null || id === "" || !isRecord(raw)) {
		return undefined;
	}
	return typeof raw.getEntry === "function" ? manager.getEntry(id) : undefined;
}
function sessionIdentityOf(manager: ExtensionContext["sessionManager"]): {
	readonly sessionId: string;
	readonly file: string | undefined;
	readonly leaf: EntryLike | undefined;
} {
	const raw: unknown = manager;
	const sessionId =
		isRecord(raw) && typeof raw.getSessionId === "function" ? manager.getSessionId() : "";
	const file =
		isRecord(raw) && typeof raw.getSessionFile === "function"
			? manager.getSessionFile()
			: undefined;
	const leafId =
		isRecord(raw) && typeof raw.getLeafId === "function" ? manager.getLeafId() : null;
	return { sessionId, file, leaf: parentEntry(manager, leafId) };
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
	manager: ExtensionContext["sessionManager"],
	identity: { readonly sessionId: string; readonly leaf: EntryLike | undefined },
	previous: EpochState | undefined,
	memoryByEpoch: ReadonlyMap<string, MemoryEpoch> | undefined,
): Pick<EpochState, "anchorKey" | "byBudget" | "tools"> {
	const reversed: EntryLike[] = [];
	let anchor: EntryLike | undefined;
	for (
		let entry = identity.leaf;
		entry !== undefined;
		entry = parentEntry(manager, entry.parentId)
	) {
		if (previous !== undefined && previous.leaf === entry) {
			const collected = collectGuidanceEntries(
				reversed.reverse(),
				previous.byBudget,
				previous.tools,
			);
			return {
				anchorKey: previous.anchorKey,
				...withMemoryEpoch(collected, memoryByEpoch?.get(previous.anchorKey)),
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
export function createWindowGuidance(pi: ExtensionAPI): WindowGuidance {
	let state: EpochState | undefined;
	let memoryByManager = new WeakMap<object, Map<string, MemoryEpoch>>();
	const readEpoch = (ctx: ExtensionContext): EpochState => {
		const manager = ctx.sessionManager;
		const { sessionId, file, leaf } = sessionIdentityOf(manager);
		const previous =
			state?.manager === manager && state.sessionId === sessionId && state.file === file
				? state
				: undefined;
		if (previous !== undefined && previous.leaf === leaf) {
			return previous;
		}
		state = {
			manager,
			sessionId,
			file,
			leaf,
			...scanGuidanceEpoch(
				manager,
				{ sessionId, leaf },
				previous,
				memoryByManager.get(manager),
			),
		};
		return state;
	};
	return {
		resolve(ctx, host) {
			const epoch = readEpoch(ctx);
			const key = budgetGuidanceKey(host);
			return (
				epoch.byBudget.get(key) ?? buildGuidance(host, epoch.tools ?? ALL_GUIDANCE_TOOLS)
			);
		},
		deliver(ctx, host) {
			const epoch = readEpoch(ctx);
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
			state = undefined;
			pi.appendEntry(WINDOW_GUIDANCE_TYPE, {
				version: 1,
				budgetKey: key,
				text,
				tools,
			} satisfies WindowGuidanceRecord);
			return text;
		},
		reset() {
			state = undefined;
			memoryByManager = new WeakMap();
		},
	};
}
export function registerGuidance(
	pi: ExtensionAPI,
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
