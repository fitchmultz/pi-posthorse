import {
	isRecord,
	optionalString,
	type EntryLike,
	type MessageLike,
	type ToolCallLike,
} from "./contracts.ts";
import { textOf, toolCalls } from "./message-text.ts";
import { bareToolName, noteOperationKind, verifiedNoteOperations } from "./note-tool-effects.ts";
import { matchNoteDirectory, type NoteOwner } from "./note-scopes.ts";

export type ScannedNoteEntry = {
	readonly entry: EntryLike;
	readonly entryId: string;
	readonly inRetained: boolean;
};
type ContentTouchKind = "full-write" | "partial-write" | "read" | "clear";
export type NoteTarget = {
	readonly notePath: string;
	readonly absPath?: string | undefined;
	readonly referenceScope?: string | undefined;
};
export type NoteTouch = NoteTarget & {
	readonly entryId: string;
	readonly receiptId?: string | undefined;
	readonly owner?: NoteOwner | undefined;
} & (
		| { readonly kind: ContentTouchKind; readonly inRetained: boolean }
		| { readonly kind: "observed-write"; readonly inRetained: false }
	);
type ToolResultInfo = {
	readonly entryId: string;
	readonly sourceId: string;
	readonly inRetained: boolean;
	readonly isError: boolean;
	readonly toolName: string;
	readonly text: string;
	readonly details: unknown;
};
type TouchContext = {
	readonly entryId: string;
	readonly sourceId: string;
	readonly inRetained: boolean;
	readonly knownDirs: ReadonlySet<string>;
};

function normalizeRelPath(raw: string): string {
	const cleaned = raw
		.trim()
		.replaceAll("\\", "/")
		.replace(/^(?:\.\/)+/u, "")
		.replace(/^\/+/u, "");
	const invalid =
		cleaned === "" ||
		cleaned === "." ||
		cleaned === ".." ||
		cleaned.startsWith("../") ||
		cleaned.includes("/../") ||
		cleaned.endsWith("/");
	return invalid ? "" : cleaned;
}

function matchMarkerPath(slash: string): string | undefined {
	for (const marker of ["/.pi/notes/", "/posthorse-notes/"]) {
		const idx = slash.lastIndexOf(marker);
		if (idx >= 0) {
			return slash.slice(idx + marker.length);
		}
	}
	if (slash.startsWith(".pi/notes/") || slash.startsWith("./.pi/notes/")) {
		return slash.replace(/^(?:\.\/)?\.pi\/notes\//u, "");
	}
	const pkgMatch = /\/\.pi\/package-notes\/[0-9a-f]{64}\/notes\/(.+)$/u.exec(slash);
	if (pkgMatch !== null) {
		return pkgMatch[1];
	}
	return /\/\.pi\/(?:agent\/)?notes\/[^/]+\/[^/]+\/[^/]+\/(.+)$/u.exec(slash)?.[1];
}

function unscopedNoteTarget(trimmed: string, slash: string): NoteTarget | undefined {
	if (slash.startsWith("/") || /^[A-Za-z]:\//u.test(slash)) {
		const base = normalizeRelPath(slash.slice(slash.lastIndexOf("/") + 1));
		return base === "" ? undefined : { notePath: base, absPath: trimmed };
	}
	const rel = normalizeRelPath(slash);
	return rel === "" ? undefined : { notePath: rel };
}
function resolveNoteTarget(
	rawPath: string | undefined,
	knownDirs: ReadonlySet<string>,
	fromNotesTool: boolean,
): NoteTarget | undefined {
	if (rawPath === undefined) {
		return undefined;
	}
	const trimmed = rawPath.trim();
	const slash = trimmed.replaceAll("\\", "/");
	const matched = matchNoteDirectory(slash, [...knownDirs])?.path ?? matchMarkerPath(slash);
	if (matched !== undefined) {
		const rel = matched.startsWith(".forks/") ? "" : normalizeRelPath(matched);
		return rel === "" ? undefined : { notePath: rel, absPath: trimmed };
	}
	return fromNotesTool ? unscopedNoteTarget(trimmed, slash) : undefined;
}

function extractNotesResultTarget(
	text: string,
): { readonly kind: ContentTouchKind; readonly rawPath: string } | undefined {
	const patterns: readonly (readonly [RegExp, ContentTouchKind])[] = [
		[/^Wrote ([^\r\n]+)$/mu, "full-write"],
		[/^Appended to ([^\r\n]+)$/mu, "partial-write"],
		[/^File: ([^\r\n]+)$/mu, "read"],
	];
	for (const [pattern, kind] of patterns) {
		const rawPath = pattern.exec(text)?.[1];
		if (rawPath !== undefined) {
			return { kind, rawPath };
		}
	}
	return undefined;
}

function collectResultMap(
	entries: readonly ScannedNoteEntry[],
): ReadonlyMap<string, ToolResultInfo> {
	const results = new Map<string, ToolResultInfo>();
	for (const item of entries) {
		const msg = item.entry.message;
		const callId = optionalString(msg?.toolCallId);
		if (
			item.entry.type === "message" &&
			msg?.role === "toolResult" &&
			callId !== undefined &&
			callId !== ""
		) {
			results.set(callId, {
				entryId: item.entryId,
				sourceId: item.entry.id ?? item.entryId,
				inRetained: item.inRetained,
				isError: msg.isError === true,
				toolName: bareToolName(msg.toolName),
				text: textOf(msg),
				details: msg.details,
			});
		}
	}
	return results;
}

function inferDirFromCall(
	call: ToolCallLike,
	results: ReadonlyMap<string, ToolResultInfo>,
): string | undefined {
	const callId = optionalString(call.id);
	const res = callId === undefined ? undefined : results.get(callId);
	if (res === undefined || res.isError) {
		return undefined;
	}
	const parsed = extractNotesResultTarget(res.text);
	const rawCallPath = isRecord(call.arguments) ? optionalString(call.arguments.path) : undefined;
	const callPath = rawCallPath === undefined ? "" : normalizeRelPath(rawCallPath);
	if (parsed === undefined || callPath === "") {
		return undefined;
	}
	const slash = parsed.rawPath.trim().replaceAll("\\", "/");
	const suffix = `/${callPath}`;
	return slash.endsWith(suffix) && slash.length > suffix.length
		? slash.slice(0, slash.length - suffix.length)
		: undefined;
}

function assistantCallsOf(entry: EntryLike): readonly ToolCallLike[] {
	return entry.type === "message" && entry.message?.role === "assistant"
		? toolCalls(entry.message.content)
		: [];
}

function learnNotesDirs(
	entries: readonly ScannedNoteEntry[],
	results: ReadonlyMap<string, ToolResultInfo>,
): ReadonlySet<string> {
	const dirs = new Set<string>();
	for (const info of results.values()) {
		const match =
			!info.isError && info.toolName === "notes"
				? /^Notes directory: ([^\r\n]+)$/mu.exec(info.text)?.[1]
				: undefined;
		if (match !== undefined) {
			dirs.add(match.trim().replaceAll("\\", "/").replace(/\/+$/u, ""));
		}
	}
	for (const item of entries) {
		for (const call of assistantCallsOf(item.entry)) {
			const inferred = inferDirFromCall(call, results);
			if (inferred !== undefined) {
				dirs.add(inferred);
			}
		}
	}
	return dirs;
}

function fileToolTouches(
	tool: string,
	args: Readonly<Record<string, unknown>>,
	result: { readonly details: unknown; readonly isError: boolean },
	context: TouchContext,
): NoteTouch[] {
	return verifiedNoteOperations(tool, args, result).flatMap((operation) => {
		const target = resolveNoteTarget(operation.path, context.knownDirs, false);
		return target === undefined
			? []
			: [
					{
						...target,
						kind:
							tool === "apply_patch" && operation.action !== "delete"
								? "partial-write"
								: noteOperationKind(operation.action),
						entryId: context.entryId,
						inRetained: context.inRetained,
					},
				];
	});
}

function notesCallKind(args: Readonly<Record<string, unknown>>): ContentTouchKind | undefined {
	if (args.op === "write") {
		return args.content === "" ? "clear" : "full-write";
	}
	if (args.op === "append") {
		return "partial-write";
	}
	return args.op === "read" ? "read" : undefined;
}

function mergeNoteTargets(
	callTarget: NoteTarget | undefined,
	resTarget: NoteTarget | undefined,
): NoteTarget | undefined {
	const notePath = callTarget?.notePath ?? resTarget?.notePath;
	return notePath === undefined
		? undefined
		: { notePath, absPath: resTarget?.absPath ?? callTarget?.absPath };
}

function notesToolTouches(
	args: Readonly<Record<string, unknown>>,
	resultText: string | undefined,
	context: TouchContext,
): NoteTouch[] {
	const parsed = resultText === undefined ? undefined : extractNotesResultTarget(resultText);
	const kind = notesCallKind(args) ?? parsed?.kind;
	const path = optionalString(args.path);
	const scopedPath =
		typeof args.scope === "string" && path !== undefined ? `${args.scope}/${path}` : path;
	const callTarget = resolveNoteTarget(scopedPath, context.knownDirs, true);
	const resTarget = resolveNoteTarget(parsed?.rawPath, context.knownDirs, true);
	const merged = mergeNoteTargets(callTarget, resTarget);
	return kind === undefined || merged === undefined
		? []
		: [{ ...merged, kind, entryId: context.entryId, inRetained: context.inRetained }];
}

function extractNestedCalls(message: MessageLike): readonly unknown[] {
	const nested = isRecord(message.nestedCalls) ? message.nestedCalls.calls : undefined;
	if (Array.isArray(nested)) {
		return nested;
	}
	const details = isRecord(message.details) ? message.details : undefined;
	if (details !== undefined && Array.isArray(details.calls)) {
		return details.calls;
	}
	const detailNested =
		details !== undefined && isRecord(details.nestedCalls)
			? details.nestedCalls.calls
			: undefined;
	return Array.isArray(detailNested) ? detailNested : [];
}

function nestedArgs(raw: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
	if (isRecord(raw.arguments)) {
		return raw.arguments;
	}
	if (isRecord(raw.args)) {
		return raw.args;
	}
	return isRecord(raw.input) ? raw.input : {};
}

function touchesFromNested(message: MessageLike, context: TouchContext): NoteTouch[] {
	return extractNestedCalls(message).flatMap((raw) => {
		if (
			!isRecord(raw) ||
			raw.isError === true ||
			raw.status === "error" ||
			raw.status === "unfinished" ||
			(typeof raw.error === "string" && raw.error !== "")
		) {
			return [];
		}
		const name = bareToolName(optionalString(raw.name) ?? optionalString(raw.toolName));
		const args = nestedArgs(raw);
		const touches =
			name === "notes"
				? notesToolTouches(args, optionalString(raw.result), context)
				: fileToolTouches(name, args, { details: raw.result, isError: false }, context);
		return touches.map((touch): NoteTouch =>
			Object.assign({}, touch, {
				kind:
					touch.kind === "read" || touch.kind === "clear" ? touch.kind : "observed-write",
				inRetained: false,
				receiptId: context.sourceId,
			} satisfies Pick<NoteTouch, "kind" | "inRetained" | "receiptId">),
		);
	});
}

function touchesFromAssistantCall(
	call: ToolCallLike,
	results: ReadonlyMap<string, ToolResultInfo>,
	context: TouchContext,
): { readonly consumedCallId?: string | undefined; readonly touches: readonly NoteTouch[] } {
	const callId = optionalString(call.id);
	const res = callId === undefined ? undefined : results.get(callId);
	const consumedCallId = callId !== undefined && res !== undefined ? callId : undefined;
	if (res === undefined || (res.isError && bareToolName(call.name) === "notes")) {
		return { consumedCallId, touches: [] };
	}
	const tool = bareToolName(call.name);
	const args = isRecord(call.arguments) ? call.arguments : {};
	const touches =
		tool === "notes"
			? notesToolTouches(args, res.text, context)
			: fileToolTouches(tool, args, res, context);
	return {
		consumedCallId,
		touches: touches.map((touch) => Object.assign({}, touch, { receiptId: res.sourceId })),
	};
}

function touchesFromToolResult(
	msg: MessageLike,
	handledResultIds: ReadonlySet<string>,
	context: TouchContext,
): NoteTouch[] {
	if (msg.role !== "toolResult" || msg.isError === true) {
		return [];
	}
	const callId = optionalString(msg.toolCallId) ?? "";
	const direct =
		!handledResultIds.has(callId) && bareToolName(msg.toolName) === "notes"
			? notesToolTouches({}, textOf(msg), context)
			: [];
	return [...direct, ...touchesFromNested(msg, context)];
}

export function collectTouches(
	entries: readonly ScannedNoteEntry[],
	directories: ReadonlySet<string> = new Set(),
): {
	readonly touches: readonly NoteTouch[];
	readonly defaultDir?: string | undefined;
} {
	const results = collectResultMap(entries);
	const knownDirs = new Set([...directories, ...learnNotesDirs(entries, results)]);
	const handledResultIds = new Set<string>();
	const touches: NoteTouch[] = [];
	for (const item of entries) {
		const msg = item.entry.message;
		const context: TouchContext = {
			entryId: item.entryId,
			sourceId: item.entry.id ?? item.entryId,
			inRetained: item.inRetained,
			knownDirs,
		};
		for (const call of assistantCallsOf(item.entry)) {
			const out = touchesFromAssistantCall(call, results, context);
			if (out.consumedCallId !== undefined) {
				handledResultIds.add(out.consumedCallId);
			}
			touches.push(...out.touches);
		}
		if (item.entry.type === "message" && msg !== undefined) {
			touches.push(...touchesFromToolResult(msg, handledResultIds, context));
		}
	}
	const defaultDir = knownDirs.size === 1 ? [...knownDirs][0] : undefined;
	return { touches, defaultDir };
}
