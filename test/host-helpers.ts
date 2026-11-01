import { isRecord, optionalString, unknownArray } from "../src/contracts.ts";
import assert from "node:assert/strict";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";

/** Transcript assertions read text blocks without treating tool calls or images as text. */
export function textOf(message: unknown): string {
	const content = isRecord(message) ? message.content : undefined;
	if (typeof content === "string") {
		return content;
	}
	return (unknownArray(content) ?? [])
		.map((part) => (isRecord(part) ? (optionalString(part.text) ?? "") : ""))
		.join("\n");
}

export function messageEntry(
	entry: SessionEntry | undefined,
): Extract<SessionEntry, { type: "message" }> {
	assert.ok(entry?.type === "message", "Expected a persisted message entry");
	return entry;
}

export function posthorseBoundaries(
	manager: Pick<SessionManager, "getBranch">,
): Extract<SessionEntry, { type: "compaction" }>[] {
	return manager
		.getBranch()
		.filter((entry) => entry.type === "compaction")
		.filter((entry) => isRecord(entry.details) && entry.details.posthorse === 1);
}
