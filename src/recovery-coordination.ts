import { contextStart } from "./boundary.ts";
import {
	isRecord,
	optionalString,
	presentText,
	unknownArray,
	type EntryLike,
	type ProjectedEntry,
	type ToolCallLike,
} from "./contracts.ts";
import { contextEdits } from "./history-entries.ts";
import { toolCalls } from "./message-text.ts";

export type Supersession = { readonly byEntryId: string; readonly inRetainedTail: boolean };

type ActiveEntry = {
	readonly index: number;
	readonly effectiveId: string;
	readonly inRetainedTail: boolean;
	readonly entry: EntryLike;
};

type SupersederIndex = {
	readonly jobsByIndex: Map<number, readonly string[]>;
	readonly jobLatest: Map<string, ActiveEntry>;
	readonly escalationLatest: Map<string, ActiveEntry>;
	readonly completionLatest: Map<string, ActiveEntry>;
};

const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "unknown"]);
const ESCALATION_ACTIONS = new Set(["continue", "review", "stop"]);

function isPlainToolResult(entry: EntryLike, toolName: string): boolean {
	return (
		entry.type === "message" &&
		entry.message?.role === "toolResult" &&
		entry.message.toolName === toolName &&
		entry.message.namespace === undefined &&
		entry.message.isError !== true
	);
}

function callArgs(
	entry: EntryLike,
	calls: ReadonlyMap<string, ToolCallLike>,
): Readonly<Record<string, unknown>> | undefined {
	const callId = optionalString(entry.message?.toolCallId);
	const call = callId === undefined ? undefined : calls.get(callId);
	return call?.namespace === undefined && isRecord(call?.arguments) ? call.arguments : undefined;
}

function backgroundCompleteJobIds(entry: EntryLike): readonly string[] {
	if (!isRecord(entry.details)) {
		return [];
	}
	const ids = new Set<string>();
	for (const item of unknownArray(entry.details.jobs) ?? []) {
		const id = isRecord(item) ? presentText(item.id) : undefined;
		if (id !== undefined) {
			ids.add(id);
		}
	}
	for (const item of unknownArray(entry.details.jobIds) ?? []) {
		const id = presentText(item);
		if (id !== undefined) {
			ids.add(id);
		}
	}
	return [...ids];
}

function singleJobAction(
	args: Readonly<Record<string, unknown>> | undefined,
	details: Readonly<Record<string, unknown>>,
): string | undefined {
	const callAction = optionalString(args?.action);
	if (callAction === "status" && presentText(args?.id) === undefined) {
		return undefined;
	}
	return callAction ?? optionalString(details.action);
}

function singleJobSupersederId(
	entry: EntryLike,
	calls: ReadonlyMap<string, ToolCallLike>,
): string | undefined {
	const details = entry.message?.details;
	if (!isRecord(details) || Array.isArray(details.jobs)) {
		return undefined;
	}
	const action = singleJobAction(callArgs(entry, calls), details);
	if (action !== "status" && action !== "cancel") {
		return undefined;
	}
	const id = presentText(details.id);
	const status = optionalString(details.status);
	return id !== undefined && status !== undefined && TERMINAL_JOB_STATUSES.has(status)
		? id
		: undefined;
}

function recordAgentRunsSuperseder(
	item: ActiveEntry,
	calls: ReadonlyMap<string, ToolCallLike>,
	index: SupersederIndex,
): void {
	const args = callArgs(item.entry, calls);
	const runId = presentText(args?.id);
	const action = optionalString(args?.action);
	if (runId === undefined || action === undefined) {
		return;
	}
	if (ESCALATION_ACTIONS.has(action)) {
		index.escalationLatest.set(runId, item);
	}
	if (action === "continue" || (action === "review" && args?.verdict === "changes_requested")) {
		index.completionLatest.set(runId, item);
	}
}

function recordCustomSuperseder(item: ActiveEntry, index: SupersederIndex): void {
	const { entry } = item;
	if (entry.customType === "background-command-complete") {
		const jobIds = backgroundCompleteJobIds(entry);
		index.jobsByIndex.set(item.index, jobIds);
		for (const jobId of jobIds) {
			index.jobLatest.set(jobId, item);
		}
		return;
	}
	const runId = isRecord(entry.details) ? presentText(entry.details.id) : undefined;
	if (runId === undefined) {
		return;
	}
	if (entry.customType === "agent-completion") {
		index.escalationLatest.set(runId, item);
		index.completionLatest.set(runId, item);
	} else if (entry.customType === "agent-escalation") {
		index.escalationLatest.set(runId, item);
	}
}

function latestSupersederForJobs(
	item: ActiveEntry,
	jobIds: readonly string[],
	jobLatest: ReadonlyMap<string, ActiveEntry>,
): ActiveEntry | undefined {
	if (jobIds.length === 0) {
		return undefined;
	}
	let winner: ActiveEntry | undefined;
	for (const jobId of jobIds) {
		const candidate = jobLatest.get(jobId);
		if (candidate === undefined || candidate.index <= item.index) {
			return undefined;
		}
		if (winner === undefined || candidate.index > winner.index) {
			winner = candidate;
		}
	}
	return winner;
}

function latestRunSuperseder(entry: EntryLike, index: SupersederIndex): ActiveEntry | undefined {
	const runId = isRecord(entry.details) ? presentText(entry.details.id) : undefined;
	if (runId === undefined) {
		return undefined;
	}
	if (entry.customType === "agent-escalation") {
		return index.escalationLatest.get(runId);
	}
	return entry.customType === "agent-completion" ? index.completionLatest.get(runId) : undefined;
}

function supersederForEntry(item: ActiveEntry, index: SupersederIndex): ActiveEntry | undefined {
	const { entry } = item;
	if (entry.type !== "custom_message" || entry.display !== true) {
		return undefined;
	}
	if (entry.customType === "background-command-complete") {
		return latestSupersederForJobs(
			item,
			index.jobsByIndex.get(item.index) ?? [],
			index.jobLatest,
		);
	}
	const candidate = latestRunSuperseder(entry, index);
	return candidate !== undefined && candidate.index > item.index ? candidate : undefined;
}

function indexActive(
	active: readonly ActiveEntry[],
	calls: ReadonlyMap<string, ToolCallLike>,
): SupersederIndex {
	const index: SupersederIndex = {
		jobsByIndex: new Map(),
		jobLatest: new Map(),
		escalationLatest: new Map(),
		completionLatest: new Map(),
	};
	for (const item of active) {
		if (item.entry.type === "custom_message") {
			recordCustomSuperseder(item, index);
		} else if (isPlainToolResult(item.entry, "background_command")) {
			const jobId = singleJobSupersederId(item.entry, calls);
			if (jobId !== undefined) {
				index.jobLatest.set(jobId, item);
			}
		} else if (isPlainToolResult(item.entry, "agent_runs")) {
			recordAgentRunsSuperseder(item, calls, index);
		}
	}
	return index;
}

function activeCalls(
	entries: readonly EntryLike[],
	excluded: ReadonlySet<string>,
	edits: ReadonlyMap<string, EntryLike>,
): Map<string, ToolCallLike> {
	return new Map(
		entries.flatMap((entry) => {
			const id = entry.id ?? "";
			if (
				excluded.has(id) ||
				entry.type !== "message" ||
				entry.message?.role !== "assistant"
			) {
				return [];
			}
			const content = edits.get(id)?.replacement?.content ?? entry.message.content;
			return toolCalls(content).flatMap((call) =>
				call.id !== undefined && call.id !== "" ? [[call.id, call] as const] : [],
			);
		}),
	);
}

export function supersededCoordinationMap(
	entries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	options: {
		readonly retained: ReadonlySet<string>;
		readonly currentWindow?: readonly EntryLike[] | undefined;
	},
): ReadonlyMap<string, Supersession> {
	const edits = contextEdits(entries);
	const excluded = new Set([
		...projected
			.filter(({ messages }) => messages.length === 0)
			.map(({ sourceEntry }) => sourceEntry.id ?? ""),
		...[...edits].filter(([, edit]) => edit.replacement === null).map(([id]) => id),
	]);
	excluded.delete("");
	const calls = activeCalls(entries, excluded, edits);
	const currentWindow = options.currentWindow ?? entries.slice(contextStart(entries).start);
	const active = currentWindow
		.filter((entry) => entry.id !== undefined && entry.id !== "" && !excluded.has(entry.id))
		.map((entry, index): ActiveEntry => {
			const sourceId = entry.id ?? "";
			const edit = edits.get(sourceId);
			return {
				index,
				effectiveId: edit?.replacement !== undefined ? (edit.id ?? sourceId) : sourceId,
				inRetainedTail: options.retained.has(sourceId),
				entry,
			};
		});
	const index = indexActive(active, calls);
	const result = new Map<string, Supersession>();
	for (const item of active) {
		const winner = supersederForEntry(item, index);
		if (winner !== undefined) {
			result.set(item.effectiveId, {
				byEntryId: winner.effectiveId.slice(0, 120),
				inRetainedTail: winner.inRetainedTail,
			});
		}
	}
	return result;
}
