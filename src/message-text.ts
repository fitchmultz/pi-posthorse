import { createHash } from "node:crypto";
import { sep } from "node:path";
import {
	isRecord,
	optionalString,
	unknownArray,
	type ImageLike,
	type MessageLike,
	type ToolCallLike,
} from "./contracts.ts";

export function isImage(part: unknown): part is ImageLike {
	return (
		isRecord(part) &&
		part.type === "image" &&
		typeof part.data === "string" &&
		typeof part.mimeType === "string"
	);
}
export function imagesOf(content: unknown): ImageLike[] {
	return unknownArray(content)?.filter(isImage) ?? [];
}
export function imageSummary(images: readonly ImageLike[]): string {
	if (images.length === 0) {
		return "";
	}
	const types = [
		...new Set(
			images.map((image) => (image.mimeType === "" ? "unknown type" : image.mimeType)),
		),
	].join(", ");
	return `[${images.length} image${images.length === 1 ? "" : "s"}: ${types}]`;
}
export function safeJsonStringify(value: unknown): string {
	try {
		const encoded: unknown = JSON.stringify(value);
		return typeof encoded === "string" ? encoded : "undefined";
	} catch {
		return "[unserializable]";
	}
}
export function toolIdentity(name?: string, namespace?: string): string {
	return `${name ?? "tool"}${namespace === undefined ? "" : ` (namespace: ${safeJsonStringify(namespace)})`}`;
}
export function executionArgumentsText(call: ToolCallLike): string {
	return call.executionArguments === undefined
		? ""
		: `\nExecution arguments: ${safeJsonStringify(call.executionArguments)}`;
}
export function toolCallOf(part: unknown): ToolCallLike | undefined {
	if (!isRecord(part) || part.type !== "toolCall") {
		return undefined;
	}
	return {
		type: "toolCall",
		id: optionalString(part.id),
		name: optionalString(part.name),
		namespace: optionalString(part.namespace),
		arguments: part.arguments,
		executionArguments: part.executionArguments,
		async: part.async === true,
	};
}
export function toolCalls(content: unknown): ToolCallLike[] {
	return (unknownArray(content) ?? []).flatMap((part) => {
		const call = toolCallOf(part);
		return call === undefined ? [] : [call];
	});
}
function blockText(part: unknown): string {
	if (!isRecord(part)) {
		return "";
	}
	if (part.type === "text") {
		return optionalString(part.text) ?? "";
	}
	if (part.type === "thinking") {
		return optionalString(part.thinking) ?? "";
	}
	const call = toolCallOf(part);
	if (call === undefined) {
		return "";
	}
	return `${toolIdentity(call.name, call.namespace)} ${safeJsonStringify(call.arguments ?? {})}${call.id === undefined ? "" : `\nCall ID: ${call.id}`}${executionArgumentsText(call)}`;
}
export function textOf(message: MessageLike): string {
	if (typeof message.content === "string") {
		return message.content;
	}
	return (unknownArray(message.content) ?? [])
		.map(blockText)
		.filter((text) => text !== "")
		.join("\n");
}
export function assistantFailure(message: MessageLike): string {
	if (message.role !== "assistant") {
		return "";
	}
	const error = message.errorMessage ?? "";
	if (message.stopReason !== "error" && message.stopReason !== "aborted" && error === "") {
		return "";
	}
	return `[${message.stopReason ?? "error"}]${error === "" ? "" : ` ${error}`}`;
}
export function isRecoveryTool(name: unknown): boolean {
	return name === "history" || name === "notes" || name === "new_context";
}
export function isRecoveryCall(part: unknown): boolean {
	const block = toolCallOf(part);
	return block !== undefined && isRecoveryTool(block.name);
}
/** Ten base64url characters of SHA-256; legacy whole-digest keys start with these. */
export function shortKey(text: string): string {
	return createHash("sha256").update(text).digest("base64url").slice(0, 10);
}
/** Nested session files are subagent runs, whose input came from a parent agent. */
export function sourceTag(source: string): string {
	return source.includes(sep) ? " [subagent]" : "";
}
export function excerptAround(text: string, index: number, before: number, length: number): string {
	const start = Math.max(0, index - before);
	const end = Math.min(text.length, start + length);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
export function excerpt(text: string, limit: number): string {
	if (text.length <= limit) {
		return text;
	}
	const marker = "\n… middle omitted …\n";
	if (limit <= marker.length) {
		return text.slice(0, limit);
	}
	const head = Math.floor((limit - marker.length) / 2);
	return `${text.slice(0, head)}${marker}${text.slice(text.length - (limit - marker.length - head))}`;
}
export function boundedBlock(header: string, text: string, limit: number): string {
	const textLimit = Math.max(0, limit - header.length - 1);
	return textLimit > 0 ? `${header}\n${excerpt(text, textLimit)}` : header;
}
