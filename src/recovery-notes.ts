import {
	isRecord,
	optionalString,
	type EntryLike,
	type MessageLike,
	type ProjectedEntry,
	type ToolCallLike,
} from "./contracts.ts";
import { contextEdits } from "./history-entries.ts";
import { textOf, toolCalls } from "./message-text.ts";

const MAX_WRITTEN_NOTES = 4;
const MAX_READ_NOTES = 3;

type ScannedNoteEntry = {
	readonly entry: EntryLike;
	readonly entryId: string;
	readonly inRetained: boolean;
};
export type RetainedSpan = { readonly firstId: string; readonly lastId: string };
type NoteOpKind = "full-write" | "partial-write" | "read" | "clear";
type NoteTarget = { readonly notePath: string; readonly absPath?: string };
type NoteTouch = NoteTarget & {
	readonly kind: NoteOpKind;
	readonly entryId: string;
	readonly inRetained: boolean;
};
type TrackedNote = NoteTarget & {
	readonly written: boolean;
	readonly lastEntryId: string;
	readonly lastInRetained: boolean;
	readonly lastWriteEntryId?: string;
	readonly fullWriteRetainedEntryId?: string;
	readonly partialEditRetainedEntryId?: string;
	readonly order: number;
};
type ToolResultInfo = {
	readonly entryId: string;
	readonly inRetained: boolean;
	readonly isError: boolean;
	readonly toolName: string;
	readonly text: string;
	readonly details: unknown;
};
type TouchContext = {
	readonly entryId: string;
	readonly inRetained: boolean;
	readonly knownDirs: ReadonlySet<string>;
};

function bareToolName(name: string | undefined): string {
	if (name === undefined || name === "") {
		return "";
	}
	const cut = Math.max(name.lastIndexOf(":"), name.lastIndexOf("/"));
	return cut >= 0 ? name.slice(cut + 1) : name;
}

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

function matchKnownDir(slash: string, knownDirs: ReadonlySet<string>): string | undefined {
	for (const dir of knownDirs) {
		if (slash.startsWith(`${dir}/`)) {
			return slash.slice(dir.length + 1);
		}
	}
	return undefined;
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
	const matched = matchKnownDir(slash, knownDirs) ?? matchMarkerPath(slash);
	if (matched !== undefined) {
		const rel = normalizeRelPath(matched);
		return rel === "" ? undefined : { notePath: rel, absPath: trimmed };
	}
	if (!fromNotesTool) {
		return undefined;
	}
	if (slash.startsWith("/") || /^[A-Za-z]:\//u.test(slash)) {
		const base = normalizeRelPath(slash.slice(slash.lastIndexOf("/") + 1));
		return base === "" ? undefined : { notePath: base, absPath: trimmed };
	}
	const rel = normalizeRelPath(slash);
	return rel === "" ? undefined : { notePath: rel };
}

function extractNotesResultTarget(
	text: string,
): { readonly kind: NoteOpKind; readonly rawPath: string } | undefined {
	const patterns: readonly (readonly [RegExp, NoteOpKind])[] = [
		[/^Wrote ([^\r\n]+)$/mu, "full-write"],
		[/^Appended to ([^\r\n]+)$/mu, "partial-write"],
		[/^File: ([^\r\n]+)$/mu, "read"],
	];
	for (const [pattern, kind] of patterns) {
		const match = pattern.exec(text);
		if (match !== null) {
			return { kind, rawPath: match[1] };
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
				? /^Notes directory: ([^\r\n]+)$/mu.exec(info.text)
				: null;
		if (match !== null) {
			dirs.add(match[1].trim().replaceAll("\\", "/").replace(/\/+$/u, ""));
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

function pathsFromFileList(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.flatMap((item: unknown) => {
		if (typeof item === "string") {
			return [item];
		}
		const itemPath = isRecord(item) ? optionalString(item.path) : undefined;
		const skipped =
			isRecord(item) && (item.status === "failed" || item.status === "unattempted");
		return itemPath !== undefined && !skipped ? [itemPath] : [];
	});
}

function patchPaths(input: unknown): string[] {
	return typeof input === "string"
		? Array.from(
				input.matchAll(/^\*\*\* (?:Update File|Add File|Move to): ([^\r\n]+)$/gmu),
				(m) => m[1],
			)
		: [];
}

function detailFilePaths(details: unknown): string[] {
	return isRecord(details)
		? [...pathsFromFileList(details.modifiedFiles), ...pathsFromFileList(details.files)]
		: [];
}

function extractFileToolSpec(
	tool: string,
	args: Readonly<Record<string, unknown>>,
	details: unknown,
): { readonly kind: NoteOpKind; readonly rawPaths: readonly string[] } | undefined {
	if (args.preview === true) {
		return undefined;
	}
	const directPath = optionalString(args.path);
	const directKinds: Readonly<Record<string, NoteOpKind | undefined>> = {
		write: args.content === "" ? "clear" : "full-write",
		edit: "partial-write",
		read: "read",
	};
	const directKind = directKinds[tool];
	if (directKind !== undefined && directPath !== undefined) {
		return { kind: directKind, rawPaths: [directPath] };
	}
	if (tool === "write_files" || tool === "replace_text") {
		const kind: NoteOpKind = tool === "write_files" ? "full-write" : "partial-write";
		return { kind, rawPaths: [...pathsFromFileList(args.files), ...detailFilePaths(details)] };
	}
	return tool === "apply_patch"
		? {
				kind: "partial-write",
				rawPaths: [...patchPaths(args.input), ...detailFilePaths(details)],
			}
		: undefined;
}

function fileToolTouches(
	tool: string,
	args: Readonly<Record<string, unknown>>,
	details: unknown,
	context: TouchContext,
): NoteTouch[] {
	const spec = extractFileToolSpec(tool, args, details);
	if (spec === undefined) {
		return [];
	}
	return spec.rawPaths.flatMap((raw) => {
		const target = resolveNoteTarget(raw, context.knownDirs, false);
		return target === undefined
			? []
			: [
					{
						...target,
						kind: spec.kind,
						entryId: context.entryId,
						inRetained: context.inRetained,
					},
				];
	});
}

function notesCallKind(args: Readonly<Record<string, unknown>>): NoteOpKind | undefined {
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
	const callTarget = resolveNoteTarget(optionalString(args.path), context.knownDirs, true);
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
			(typeof raw.error === "string" && raw.error !== "")
		) {
			return [];
		}
		const name = bareToolName(optionalString(raw.name) ?? optionalString(raw.toolName));
		const args = nestedArgs(raw);
		return name === "notes"
			? notesToolTouches(args, optionalString(raw.result), context)
			: fileToolTouches(name, args, raw.result, context);
	});
}

function touchesFromAssistantCall(
	call: ToolCallLike,
	results: ReadonlyMap<string, ToolResultInfo>,
	context: TouchContext,
): { readonly consumedCallId?: string; readonly touches: readonly NoteTouch[] } {
	const callId = optionalString(call.id);
	const res = callId === undefined ? undefined : results.get(callId);
	const consumedCallId = callId !== undefined && res !== undefined ? callId : undefined;
	if (res?.isError === true) {
		return { consumedCallId, touches: [] };
	}
	const tool = bareToolName(call.name);
	const args = isRecord(call.arguments) ? call.arguments : {};
	const touches =
		tool === "notes"
			? notesToolTouches(args, res?.text, context)
			: fileToolTouches(tool, args, res?.details, context);
	return { consumedCallId, touches };
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

function collectTouches(entries: readonly ScannedNoteEntry[]): {
	readonly touches: readonly NoteTouch[];
	readonly defaultDir?: string;
} {
	const results = collectResultMap(entries);
	const knownDirs = learnNotesDirs(entries, results);
	const handledResultIds = new Set<string>();
	const touches: NoteTouch[] = [];
	for (const item of entries) {
		const msg = item.entry.message;
		const context: TouchContext = {
			entryId: item.entryId,
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

function applyReadTouch(
	previous: TrackedNote | undefined,
	touch: NoteTouch,
	order: number,
): TrackedNote {
	const wasWritten = previous?.written === true;
	return {
		notePath: touch.notePath,
		absPath: touch.absPath ?? previous?.absPath,
		written: wasWritten,
		lastEntryId: touch.entryId,
		lastInRetained: touch.inRetained,
		lastWriteEntryId: previous?.lastWriteEntryId,
		fullWriteRetainedEntryId: previous?.fullWriteRetainedEntryId,
		partialEditRetainedEntryId: previous?.partialEditRetainedEntryId,
		order: wasWritten ? previous.order : order,
	};
}

function applyWriteTouch(
	previous: TrackedNote | undefined,
	touch: NoteTouch,
	order: number,
): TrackedNote {
	return {
		notePath: touch.notePath,
		absPath: touch.absPath ?? previous?.absPath,
		written: true,
		lastEntryId: touch.entryId,
		lastInRetained: touch.inRetained,
		lastWriteEntryId: touch.entryId,
		fullWriteRetainedEntryId:
			touch.kind === "full-write" && touch.inRetained
				? touch.entryId
				: previous?.fullWriteRetainedEntryId,
		partialEditRetainedEntryId:
			touch.kind === "partial-write" && touch.inRetained
				? touch.entryId
				: previous?.partialEditRetainedEntryId,
		order,
	};
}

function formatNoteLabel(note: TrackedNote): string {
	return note.absPath !== undefined && note.absPath !== note.notePath
		? `${note.notePath} (${note.absPath})`
		: note.notePath;
}

function formatWrittenNoteLine(note: TrackedNote, span: RetainedSpan | undefined): string {
	const label = formatNoteLabel(note);
	const writeId = note.lastWriteEntryId ?? note.lastEntryId;
	if (span === undefined) {
		return `- Active note (written): ${label} [compacted at entry ${writeId} — read this note now]`;
	}
	if (note.fullWriteRetainedEntryId !== undefined) {
		const updated =
			note.partialEditRetainedEntryId !== undefined &&
			note.lastWriteEntryId === note.partialEditRetainedEntryId
				? `, updated at entry ${note.partialEditRetainedEntryId}`
				: "";
		return `- Active note (written): ${label} [latest full write is in the retained tail above at entry ${note.fullWriteRetainedEntryId}${updated}]`;
	}
	if (note.partialEditRetainedEntryId !== undefined) {
		return `- Active note (written): ${label} [only partial edits are in the retained tail above at entry ${note.partialEditRetainedEntryId} — read full note now]`;
	}
	return `- Active note (written): ${label} [compacted before entry ${span.firstId} — read this note now]`;
}

function formatReadNoteLine(note: TrackedNote, span: RetainedSpan | undefined): string {
	const label = formatNoteLabel(note);
	if (span !== undefined && note.lastInRetained) {
		return `- Referenced note (read): ${label} [read in the retained tail above at entry ${note.lastEntryId}]`;
	}
	return span !== undefined
		? `- Referenced note (read): ${label} [compacted before entry ${span.firstId}]`
		: `- Referenced note (read): ${label} [compacted at entry ${note.lastEntryId}]`;
}

function formatNotesAction(
	primaryWritten: TrackedNote | undefined,
	span: RetainedSpan | undefined,
): string {
	if (primaryWritten === undefined) {
		return "Read the referenced note again if its context is still needed, and keep one current-state note for this task.";
	}
	if (span !== undefined && primaryWritten.fullWriteRetainedEntryId !== undefined) {
		return `Your latest full write to ${primaryWritten.notePath} is already visible above at entry ${primaryWritten.fullWriteRetainedEntryId}; do not rewrite it unless new findings after entry ${span.lastId} require it.`;
	}
	return `Read ${primaryWritten.notePath} (notes read or read on its path) before continuing to restore the saved goal, progress, decisions, and next steps, then keep that note current as work progresses.`;
}

function projectNoteEntries(
	chainEntries: readonly EntryLike[],
	allEntries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	retained: ReadonlySet<string>,
): ScannedNoteEntry[] {
	const edits = contextEdits(allEntries);
	const omittedIds = new Set(
		projected
			.filter(({ messages }) => messages.length === 0)
			.map(({ sourceEntry }) => sourceEntry.id),
	);
	return chainEntries.flatMap((entry) => {
		const rawId = entry.id ?? "";
		const edit = edits.get(rawId);
		if (omittedIds.has(rawId) || edit?.replacement === null) {
			return [];
		}
		const effective =
			edit?.replacement !== undefined && entry.type === "message"
				? {
						...entry,
						id: edit.id,
						message: { ...entry.message, content: edit.replacement.content },
					}
				: entry;
		const resolvedId = (effective.id ?? rawId).slice(0, 120);
		return [
			{
				entry: effective,
				entryId: resolvedId === "" ? "unknown" : resolvedId,
				inRetained: retained.has(rawId),
			},
		];
	});
}

export function renderSessionNotes(
	chainEntries: readonly EntryLike[],
	allEntries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	options: {
		readonly retained: ReadonlySet<string>;
		readonly span: RetainedSpan | undefined;
		readonly maxChars: number;
	},
): string | undefined {
	const { retained, span, maxChars } = options;
	const entries = projectNoteEntries(chainEntries, allEntries, projected, retained);
	const { touches, defaultDir } = collectTouches(entries);
	const tracked = new Map<string, TrackedNote>();
	let order = 0;
	for (const rawTouch of touches) {
		order += 1;
		const touch =
			rawTouch.absPath === undefined && defaultDir !== undefined
				? { ...rawTouch, absPath: `${defaultDir}/${rawTouch.notePath}` }
				: rawTouch;
		if (touch.kind === "clear") {
			tracked.delete(touch.notePath);
		} else if (touch.kind === "read") {
			tracked.set(touch.notePath, applyReadTouch(tracked.get(touch.notePath), touch, order));
		} else {
			tracked.set(touch.notePath, applyWriteTouch(tracked.get(touch.notePath), touch, order));
		}
	}
	if (tracked.size === 0) {
		return undefined;
	}
	const all = [...tracked.values()].sort((a, b) => b.order - a.order);
	const written = all.filter((note) => note.written).slice(0, MAX_WRITTEN_NOTES);
	const readOnly = all.filter((note) => !note.written).slice(0, MAX_READ_NOTES);
	const lines = [
		...written.map((note) => formatWrittenNoteLine(note, span)),
		...readOnly.map((note) => formatReadNoteLine(note, span)),
	];
	const header = "Task notes in this session:";
	const action = formatNotesAction(written[0], span);
	const selected: string[] = [];
	for (const line of lines) {
		if ([header, ...selected, line, action].join("\n").length <= maxChars) {
			selected.push(line);
		}
	}
	return selected.length === 0 ? undefined : [header, ...selected, action].join("\n");
}
