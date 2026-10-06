import {
	isRecord,
	isReminderType,
	unknownArray,
	type EntryLike,
	type HistoryHit,
	type MessageLike,
	type WindowedEntry,
} from "./contracts.ts";
import {
	assistantFailure,
	excerptAround,
	imageSummary,
	imagesOf,
	isRecoveryCall,
	isRecoveryTool,
	shortKey,
	sourceTag,
	textOf,
	toolIdentity,
} from "./message-text.ts";

export function isWindow(entry: EntryLike): boolean {
	return (
		entry.type === "context_window" ||
		(entry.type === "compaction" && isRecord(entry.details) && entry.details.posthorse === 1)
	);
}
export function windowHandoff(entry: EntryLike | undefined): string | undefined {
	return entry?.type === "compaction" ? entry.summary : entry?.handoff;
}
/** First active branch entry, including tails retained by Pi's own /compact. */
export function contextStart(entries: readonly EntryLike[]): {
	start: number;
	boundary?: EntryLike;
} {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "context_window") {
			return { start: i + 1, boundary: entry };
		}
		if (entry.type === "compaction") {
			const kept = entries.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
			return { start: kept >= 0 ? kept : i + 1, boundary: entry };
		}
	}
	return { start: 0 };
}
export function contextEdits(entries: readonly EntryLike[]): Map<string, EntryLike> {
	return new Map(
		entries.flatMap((entry) =>
			entry.type === "context_edit" && entry.targetId !== undefined && entry.targetId !== ""
				? [[entry.targetId, entry]]
				: [],
		),
	);
}
function flattenMessage(message: MessageLike): string {
	if (message.role === "bashExecution") {
		if (message.excludeFromContext === true) {
			return "[bashExecution] (excluded from model context by Pi)";
		}
		return `[bashExecution] $ ${message.command ?? ""}\n${message.output ?? ""}`;
	}
	const identity =
		message.role === "toolResult"
			? `Tool: ${toolIdentity(message.toolName, message.namespace)}${message.toolCallId === undefined ? "" : `\nCall ID: ${message.toolCallId}`}`
			: "";
	const parts = [
		textOf(message),
		assistantFailure(message),
		imageSummary(imagesOf(message.content)),
		identity,
	];
	return `[${message.role ?? "message"}] ${parts.filter((part) => part !== "").join("\n")}`;
}
export function flattenEntry(entry: EntryLike): string | undefined {
	switch (entry.type) {
		case "message":
			return flattenMessage(entry.message ?? {});
		case "compaction":
		case "branch_summary":
			return `[${entry.type}] ${entry.summary ?? ""}`;
		case "context_window":
			return `[context_window] ${entry.handoff === undefined || entry.handoff === "" ? "No handoff" : `Handoff: ${entry.handoff}`}`;
		case "custom_message":
			return `[custom:${entry.customType ?? "unknown"}] ${contentText(entry.content)}`;
		case "context_edit":
			return entry.replacement === undefined || entry.replacement === null
				? undefined
				: `[context_edit] ${contentText(entry.replacement.content)}`;
		case undefined:
			return undefined;
		default:
			return undefined;
	}
}
function contentText(content: unknown): string {
	return [textOf({ content }), imageSummary(imagesOf(content))]
		.filter((part) => part !== "")
		.join("\n");
}
function ownAssistantText(message: MessageLike, images: WindowedEntry["images"]): string[] {
	const originals = [""];
	for (const part of unknownArray(message.content) ?? []) {
		if (isRecoveryCall(part)) {
			originals.push("");
		} else {
			const partText = textOf({ content: [part] });
			const index = originals.length - 1;
			if (partText !== "") {
				originals[index] += `${originals[index] === "" ? "" : "\n"}${partText}`;
			}
		}
	}
	const metadata = [assistantFailure(message), imageSummary(images)]
		.filter((part) => part !== "")
		.join("\n");
	const last = originals.length - 1;
	if (metadata !== "") {
		originals[last] += `${originals[last] === "" ? "" : "\n"}${metadata}`;
	}
	if (originals[0] !== "") {
		originals[0] = `[assistant] ${originals[0]}`;
	}
	return originals;
}
function echoPriority(entry: EntryLike): 0 | 1 {
	if (
		entry.type === "context_window" ||
		entry.type === "compaction" ||
		entry.type === "branch_summary"
	) {
		return 1;
	}
	if (entry.type === "custom_message" && isReminderType(entry.customType)) {
		return 1;
	}
	return entry.type === "message" &&
		entry.message?.role === "toolResult" &&
		isRecoveryTool(entry.message.toolName)
		? 1
		: 0;
}
function originalMatch(
	item: WindowedEntry,
	query: string,
): { readonly text?: string; readonly mixed: boolean } {
	const message = item.entry.message;
	if (item.entry.type !== "message" || message?.role !== "assistant") {
		return { mixed: false };
	}
	if (!(unknownArray(message.content) ?? []).some(isRecoveryCall)) {
		return { mixed: false };
	}
	const originals = ownAssistantText(message, item.images);
	const original = originals.find((part) => part.toLowerCase().includes(query));
	if (original === undefined || original === "") {
		return { mixed: true };
	}
	return { mixed: true, text: original === originals[0] ? original : `[assistant] ${original}` };
}
export function historyHit(
	item: WindowedEntry,
	query: string,
	source = "",
): HistoryHit | undefined {
	const { entry } = item;
	const id = entry.id;
	if (id === undefined || id === "" || !item.text.toLowerCase().includes(query)) {
		return undefined;
	}
	const original = originalMatch(item, query);
	const text = original.text ?? item.text;
	let priority = echoPriority(entry);
	if (original.mixed) {
		priority = original.text === undefined ? 1 : 0;
	}
	const qualifiedId = source === "" ? id : `${id}@${shortKey(source)}`;
	const header = `${entry.timestamp ?? ""}${sourceTag(source)} [window ${item.windowId}] [${qualifiedId}] `;
	return {
		id: qualifiedId,
		priority,
		text: `${header}${excerptAround(text, text.toLowerCase().indexOf(query), 100, 400)}`,
		headerLength: header.length,
	};
}
export function entryContent(entry: EntryLike): unknown {
	switch (entry.type) {
		case "context_edit":
			return entry.replacement?.content;
		case "message":
			return entry.message?.content;
		case undefined:
			return entry.content;
		default:
			return entry.content;
	}
}
export function toWindowedEntry(
	entry: EntryLike,
	inheritedWindow: string,
): WindowedEntry | undefined {
	const id = entry.id;
	const text = flattenEntry(entry);
	if (id === undefined || id === "" || text === undefined || text === "") {
		return undefined;
	}
	return {
		entry,
		windowId: isWindow(entry) ? id : inheritedWindow,
		text,
		images: imagesOf(entryContent(entry)),
	};
}
export function windowProjection(): (entry: EntryLike) => WindowedEntry | undefined {
	const windows = new Map<string, string>();
	return (entry) => {
		const inherited = windows.get(entry.parentId ?? "") ?? "initial";
		const windowId = isWindow(entry) ? (entry.id ?? inherited) : inherited;
		if (entry.id !== undefined && entry.id !== "") {
			windows.set(entry.id, windowId);
		}
		return toWindowedEntry(entry, windowId);
	};
}
export function* windowEntries(entries: readonly EntryLike[]): Generator<WindowedEntry> {
	const project = windowProjection();
	for (const entry of entries) {
		const item = project(entry);
		if (item !== undefined) {
			yield item;
		}
	}
}
export function seenText(message: MessageLike): string {
	return [
		textOf(message),
		assistantFailure(message),
		imageSummary(imagesOf(message.content)),
		message.summary,
		message.command,
		message.output,
	]
		.filter((part) => part !== undefined && part !== "")
		.join("\n")
		.toLowerCase();
}
