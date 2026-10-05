import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PosthorseDisplay } from "../ui.ts";

export type CompactionPolicy = {
	readonly enabled: boolean;
	readonly reserveTokens: number;
};
export type ContextUsage = {
	readonly tokens: number | null;
	readonly contextWindow: number;
	readonly percent: number | null;
};
export type PolicyContext = {
	readonly getCompactionSettings: () => CompactionPolicy;
	readonly getContextUsage: () => ContextUsage | undefined;
	readonly getSystemPrompt: () => string;
};
export type PolicyReader = (ctx: ExtensionContext) => CompactionPolicy;
export type ImageLike = {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
};
export type ToolCallLike = {
	readonly type?: string;
	readonly id?: string;
	readonly name?: string;
	readonly namespace?: string;
	readonly arguments?: unknown;
	readonly executionArguments?: unknown;
	readonly async?: boolean;
};
export type MessageLike = {
	readonly role?: string;
	readonly stopReason?: string;
	readonly errorMessage?: string;
	readonly content?: unknown;
	readonly summary?: string;
	readonly toolName?: string;
	readonly namespace?: string;
	readonly toolCallId?: string;
	readonly isError?: boolean;
	readonly command?: string;
	readonly output?: string;
	readonly excludeFromContext?: boolean;
};
export type EntryLike = {
	readonly type?: string;
	readonly id?: string;
	readonly parentId?: string | null;
	readonly timestamp?: string;
	readonly message?: MessageLike;
	readonly summary?: string;
	readonly customType?: string;
	readonly content?: unknown;
	readonly details?: unknown;
	readonly display?: boolean;
	readonly handoff?: string;
	readonly firstKeptEntryId?: string | null;
	readonly targetId?: string;
	readonly replacement?: { readonly content: unknown } | null;
};
export type WindowedEntry = {
	readonly entry: EntryLike;
	readonly windowId: string;
	readonly text: string;
	readonly images: readonly ImageLike[];
};
export type ProjectedEntry = {
	readonly sourceEntry: EntryLike;
	readonly messages: readonly MessageLike[];
};
export type HistoryHit = {
	readonly id: string;
	readonly text: string;
	readonly headerLength: number;
	readonly priority: 0 | 1;
};
export type ReminderFingerprint = {
	readonly windowId: string;
	readonly contextWindow?: number;
	readonly reserveTokens?: number;
};
export type TextResult = {
	content: Array<
		{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
	>;
	details: PosthorseDisplay | undefined;
};

export const MAX_HANDOFF_CHARS = 20_000;
export const MAX_PAGE_CHARS = 40_000;
export const MIN_PAGE_CHARS = 1_000;
export const PAGE_MARGIN_TOKENS = 1_000;
export const ESTIMATED_IMAGE_CHARS = 4_800;
export const REMINDER_TYPE = "posthorse-reminder";
export const AUTO_HANDOFF_PREFIX = "Automatic context rollover recovery record.";
export const EMPTY_HANDOFF = "Fresh context. Restore relevant notes and history before continuing.";

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function unknownArray(value: unknown): readonly unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}
export function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
export function requireValue(value: string | undefined, name: string, op: string): string {
	if (value === undefined || value === "") {
		throw new Error(`"${name}" is required for op "${op}".`);
	}
	return value;
}
export function isReminderType(customType: unknown): boolean {
	return customType === REMINDER_TYPE;
}
export function textResult(
	text: string,
	images: readonly ImageLike[] = [],
	display?: PosthorseDisplay,
): TextResult {
	return { content: [{ type: "text", text }, ...images], details: display };
}
