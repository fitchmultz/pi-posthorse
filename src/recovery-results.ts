import type { EntryLike, ToolCallLike } from "./contracts.ts";
import {
	executionArgumentsText,
	imageSummary,
	imagesOf,
	safeJsonStringify,
	textOf,
	toolCalls,
	toolIdentity,
} from "./message-text.ts";

type LinkedCall = { readonly entry: EntryLike; readonly block: ToolCallLike };
export type RecoveryBlock = { readonly header: string; readonly text: string };
export type RecoveryBatch = { readonly callId?: string; readonly blocks: readonly RecoveryBlock[] };
function callsById(entries: readonly EntryLike[]): Map<string, LinkedCall> {
	const calls = new Map<string, LinkedCall>();
	for (const entry of entries) {
		if (entry.message?.role !== "assistant") {
			continue;
		}
		for (const block of toolCalls(entry.message.content)) {
			if (block.id !== undefined) {
				calls.set(block.id, { entry, block });
			}
		}
	}
	return calls;
}
function trailingStart(entries: readonly EntryLike[]): number {
	let hasTrailingResult = false;
	for (let i = entries.length - 1; i >= 0; i--) {
		const message = entries[i].message;
		if (message?.role === "toolResult") {
			hasTrailingResult = true;
		} else if (message?.role === "assistant") {
			const invalid =
				message.stopReason === "error" ||
				message.stopReason === "aborted" ||
				message.stopReason === "length";
			if (!invalid || hasTrailingResult) {
				return i;
			}
		}
	}
	return -1;
}
function resultOutput(result: EntryLike): string {
	const message = result.message ?? {};
	const resultId = (result.id ?? "unknown").slice(0, 120);
	const images = imageSummary(imagesOf(message.content));
	const output = [
		textOf(message).trim(),
		images === "" ? "" : `${images} — recover with history read id ${resultId}`,
	]
		.filter((part) => part !== "")
		.join("\n");
	return output === "" ? "(empty result)" : output;
}
function callDetails(matching: LinkedCall | undefined, allLinked: boolean): string {
	if (matching === undefined) {
		return "\nNo matching projected call";
	}
	const entry = allLinked
		? ""
		: `\nCall entry: ${(matching.entry.id ?? "unknown").slice(0, 120)}`;
	return `${entry}\nCall arguments: ${safeJsonStringify(matching.block.arguments ?? {})}${executionArgumentsText(matching.block)}`;
}
function resultBlock(
	result: EntryLike,
	matching: LinkedCall | undefined,
	allLinked: boolean,
): RecoveryBlock {
	const message = result.message ?? {};
	const name = toolIdentity(
		message.toolName ?? matching?.block.name,
		message.namespace ?? matching?.block.namespace,
	);
	const resultId = (result.id ?? "unknown").slice(0, 120);
	return {
		header: `[${message.isError === true ? "error" : "result"} entry ${resultId}]`,
		text: `${resultOutput(result)}\n\nTool: ${name}\nCall ID: ${message.toolCallId ?? "unknown"}${callDetails(matching, allLinked)}`,
	};
}
/** Async receipts may arrive after a response; completion does not establish receipt delivery. */
export function recoverableToolResults(entries: readonly EntryLike[]): RecoveryBatch | undefined {
	const calls = callsById(entries);
	const start = trailingStart(entries);
	const results = entries.filter((entry, index) => {
		const message = entry.message;
		if (message?.role !== "toolResult" || message.toolCallId === undefined) {
			return false;
		}
		const call = calls.get(message.toolCallId);
		// Only projected provenance is eligible. Orphans never resurrect a raw call.
		return index > start || call === undefined || call.block.async === true;
	});
	const first = results.at(0);
	if (first === undefined) {
		return undefined;
	}
	const call = calls.get(first.message?.toolCallId ?? "")?.entry;
	const allLinked =
		call !== undefined &&
		results.every((result) => calls.get(result.message?.toolCallId ?? "")?.entry === call);
	return {
		callId: allLinked ? (call.id ?? "unknown").slice(0, 120) : undefined,
		blocks: results.map((result) =>
			resultBlock(result, calls.get(result.message?.toolCallId ?? ""), allLinked),
		),
	};
}
