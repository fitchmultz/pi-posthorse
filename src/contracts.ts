import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type Immutable<T> = T extends
	| string
	| number
	| boolean
	| bigint
	| symbol
	| null
	| undefined
	| ((...args: never[]) => unknown)
	? T
	: T extends readonly (infer Item)[]
		? readonly Immutable<Item>[]
		: T extends object
			? { readonly [Key in keyof T]: Immutable<T[Key]> }
			: T;

export type CompactionPolicy = {
	readonly enabled: boolean;
	readonly reserveTokens: number;
	readonly keepRecentTokens?: number | undefined;
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
	readonly getGuidance?: () => string;
};
export type PolicyReader = (ctx: ExtensionContext) => CompactionPolicy;
export type SnapshotReader = (
	ctx: ExtensionContext,
	livePolicy?: CompactionPolicy,
) => PolicyContext;
export type ImageLike = {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
};
export type ToolCallLike = {
	readonly type?: string | undefined;
	readonly id?: string | undefined;
	readonly name?: string | undefined;
	readonly namespace?: string | undefined;
	readonly arguments?: unknown;
	readonly executionArguments?: unknown;
	readonly async?: boolean | undefined;
};
export type MessageLike = {
	readonly role?: string | undefined;
	readonly timestamp?: number | undefined;
	readonly sections?: unknown;
	readonly stopReason?: string | undefined;
	readonly errorMessage?: string | undefined;
	readonly content?: unknown;
	readonly summary?: string | undefined;
	readonly toolName?: string | undefined;
	readonly customType?: string | undefined;
	readonly namespace?: string | undefined;
	readonly toolCallId?: string | undefined;
	readonly isError?: boolean | undefined;
	readonly details?: unknown;
	readonly nestedCalls?: unknown;
	readonly command?: string | undefined;
	readonly output?: string | undefined;
	readonly excludeFromContext?: boolean | undefined;
};
export type EntryLike = {
	readonly type?: string | undefined;
	readonly id?: string | undefined;
	readonly parentId?: string | null | undefined;
	readonly timestamp?: string | undefined;
	readonly message?: MessageLike | undefined;
	readonly summary?: string | undefined;
	readonly customType?: string | undefined;
	readonly content?: unknown;
	readonly details?: unknown;
	readonly display?: boolean | undefined;
	readonly data?: unknown;
	readonly cwd?: string | undefined;
	readonly parentSession?: string | undefined;
	readonly handoff?: string | undefined;
	readonly firstKeptEntryId?: string | null | undefined;
	readonly providerSummary?: unknown;
	readonly targetId?: string | undefined;
	readonly replacement?: { readonly content: unknown } | null | undefined;
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
	readonly contextWindow?: number | undefined;
	readonly reserveTokens?: number | undefined;
};

export const MAX_HANDOFF_CHARS = 20_000;
export const MAX_PAGE_CHARS = 40_000;
export const MIN_PAGE_CHARS = 1_000;
export const PAGE_MARGIN_TOKENS = 1_000;
export const ESTIMATED_IMAGE_CHARS = 4_800;
export const REMINDER_TYPE = "posthorse-reminder";
/** The session's model may answer an owner question; only the plain tool registration is owner provenance. */
export const OWNER_QUESTION_TOOL = "ask_question";
export const AUTO_HANDOFF_PREFIX = "Automatic context rollover recovery record.";
export const EMPTY_HANDOFF = "Fresh context. Restore relevant notes and history before continuing.";

/**
 * Journal wording is a storage format: recovery reads sessions back, across releases, by
 * matching this exact text. Producers and parsers share one vocabulary, so a wording change
 * is a migration and must keep reading the previous release's journals.
 */
export const BOUNDARY_TYPE = "posthorse-boundary";
export const RESET_DEFERRED_TYPE = "posthorse-reset-deferred";
export const RETAINED_TAIL_TYPE = "posthorse-retained-tail";
export const RETAINED_MARKER_PREFIX = "Context rolled over after entry ";
/** Display marker the legacy fork's context-window extension projects into messages. */
export const LEGACY_WINDOW_TYPE = "context-window";
/** The details marker every compaction Posthorse drafts carries; readers reject other values. */
export const POSTHORSE_COMPACTION = 1;

export function posthorseDetails(reason: string): {
	readonly posthorse: typeof POSTHORSE_COMPACTION;
	readonly reason: string;
} {
	return { posthorse: POSTHORSE_COMPACTION, reason };
}

/** Receipt lines the notes tool returns; recovery matches them to record note touches. */
export const NOTE_RECEIPT = {
	wrote: "Wrote ",
	appended: "Appended to ",
	file: "File: ",
	directory: "Notes directory: ",
} as const;

export function noteWriteReceipt(path: string): string {
	return `${NOTE_RECEIPT.wrote}${path}`;
}
export function noteAppendReceipt(path: string): string {
	return `${NOTE_RECEIPT.appended}${path}`;
}
export function noteReadHeader(path: string): string {
	return `${NOTE_RECEIPT.file}${path}\n`;
}
export function notesDirectoryHeader(directory: string): string {
	return `${NOTE_RECEIPT.directory}${directory}\n`;
}

export function unknownArray(value: unknown): readonly unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}
export function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
export function errorCode(error: unknown): string | undefined {
	return isRecord(error) ? optionalString(error.code) : undefined;
}
export function formatCount(value: number): string {
	return value.toLocaleString("en-US");
}
/** Some models send every optional argument; an empty string means the argument was omitted. */
export function presentText(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
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
