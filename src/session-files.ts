import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	isRecord,
	optionalString,
	type EntryLike,
	type MessageLike,
	type WindowedEntry,
} from "./contracts.ts";
import { lfLines } from "./files.ts";
import { sessionLines, type LineMatcher, type SessionLine } from "./session-lines.ts";
import { toWindowedEntry, windowProjection } from "./history-entries.ts";
import { shortKey } from "./message-text.ts";

/** Newest archive bytes searched before the rest; common queries finish within them. */
const FIRST_SEARCH_BYTES = 256 * 1024 * 1024;
/** File-list characters per ripgrep run, within Windows' 32,767 and POSIX ARG_MAX limits. */
const ARGUMENT_CHARS = process.platform === "win32" ? 30_000 : 256 * 1024;
/** Pi writes these keys first, so most lines yield window metadata without JSON.parse. */
const ENTRY_HEAD = /^\{"type":"([^"\\]*)","id":"([^"\\]*)","parentId":(null|"[^"\\]*")[,}]/u;

function execFileText(
	file: string,
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<string> {
	return new Promise((resolveOutput, reject) => {
		execFile(file, args, { cwd, signal, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
			if (error !== null) {
				const failure: Error = error;
				reject(failure);
			} else {
				resolveOutput(stdout);
			}
		});
	});
}
/** Label text normalization adds, and raw JSONL that every entry showing it contains. */
const LABEL_SOURCES: readonly (readonly [label: string, needles: readonly string[]])[] = [
	["call id", ['"type":"toolCall"', '"toolCallId"']],
	["execution arguments", ['"executionArguments"']],
	["no handoff", ['"type":"context_window"']],
	["excluded from model context by pi", ['"excludeFromContext":true']],
	["images", ['"type":"image"']],
	["unknown type", ['"type":"image"']],
	["unknown", ['"type":"custom_message"']],
];
/**
 * Raw JSONL needles, one of which every line rendering the lowercase query contains; undefined
 * means every line must be scanned.
 */
export function prefilterNeedles(query: string): string[] | undefined {
	// A match contains every fragment between characters that JSON escapes or labels may add.
	const [fragment = ""] = query
		.split(/["\\[\](){}:$\p{Cc}\p{Cs}]/u)
		.map((part) => part.trim())
		.sort((a, b) => b.length - a.length);
	if (fragment === "") {
		return undefined;
	}
	const image = fragment.includes(",") || /^\d+ ?i?m?a?g?e?s?$/.test(fragment);
	return [
		fragment,
		...LABEL_SOURCES.filter(([label]) => label.includes(fragment)).flatMap(
			([, needles]) => needles,
		),
		...(image ? ['"type":"image"'] : []),
		// İ lowercases to i + U+0307, which case-insensitive raw matching cannot see.
		...(/i|\u0307/u.test(fragment) ? ["\u0130"] : []),
	];
}
/** UTF-8 of the only non-ASCII characters that case-fold to ASCII letters, read as Latin-1. */
const ASCII_FOLDS: Readonly<Partial<Record<string, string>>> = {
	k: "\u00e2\u0084\u00aa",
	s: "\u00c5\u00bf",
};
const DOTTED_I = Buffer.from("\u0130").toString("latin1");
/** Raw-line matcher for prefilterNeedles, ignoring case like the rendered text would. */
export function needleLines(needles: readonly string[]): LineMatcher {
	const overlap =
		4 * needles.reduce((longest, needle) => Math.max(longest, needle.length), 0) + 4;
	const others = needles.filter((needle) => needle !== "\u0130");
	const dotted = others.length < needles.length;
	if (others.every((needle) => /^[\0-\x7f]*$/u.test(needle))) {
		// ASCII text matches its Latin-1 byte view, so most lines are never decoded as UTF-8.
		const latin1 = others.map((needle) =>
			needle
				.split("")
				.map((char) => {
					const fold = ASCII_FOLDS[char.toLowerCase()];
					return fold === undefined ? RegExp.escape(char) : `(?:${char}|${fold})`;
				})
				.join(""),
		);
		const pattern = new RegExp(latin1.join("|"), "i");
		return {
			test: (text) => (dotted && text.includes(DOTTED_I)) || pattern.test(text),
			encoding: "latin1",
			overlap,
		};
	}
	const pattern = new RegExp(needles.map((needle) => RegExp.escape(needle)).join("|"), "iu");
	return { test: (text) => pattern.test(text), encoding: "utf8", overlap };
}
/** File lists that each fit one ripgrep command line. */
function commandGroups(paths: readonly string[]): string[][] {
	const groups: string[][] = [];
	let group: string[] = [];
	let chars = 0;
	for (const path of paths) {
		if (group.length > 0 && chars + path.length > ARGUMENT_CHARS) {
			groups.push(group);
			group = [];
			chars = 0;
		}
		group.push(path);
		chars += path.length + 1;
	}
	return group.length > 0 ? [...groups, group] : groups;
}
/** Files containing a needle, per ripgrep; files of a failed run stay candidates. */
function ripgrepFilter(
	dir: string,
	needles: readonly string[],
	signal?: AbortSignal,
): (files: readonly string[]) => Promise<string[]> {
	let binaries = [join(getAgentDir(), "bin", "rg"), "rg"];
	const flags = [
		"--files-with-matches",
		"--null",
		"--fixed-strings",
		"--ignore-case",
		"--no-messages",
		...needles.flatMap((needle) => ["--regexp", needle]),
		"--",
	];
	const matching = async (paths: readonly string[]): Promise<readonly string[]> => {
		for (const binary of binaries) {
			try {
				// Try the host-managed binary first; PATH is a fallback only when it is unavailable.
				return (await execFileText(binary, [...flags, ...paths], dir, signal)).split("\0");
			} catch (error) {
				const code = isRecord(error) ? error.code : undefined;
				if (code === 1) {
					return [];
				}
				if (code !== "ENOENT") {
					signal?.throwIfAborted();
					return paths;
				}
				binaries = binaries.filter((candidate) => candidate !== binary);
			}
		}
		return paths;
	};
	return async (files) => {
		const paths = files.map((file) => relative(dir, file));
		const found = new Set((await Promise.all(commandGroups(paths).map(matching))).flat());
		return files.filter((file) => found.has(relative(dir, file)));
	};
}
function messageFrom(value: unknown): MessageLike | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	return {
		role: optionalString(value.role),
		stopReason: optionalString(value.stopReason),
		errorMessage: optionalString(value.errorMessage),
		content: value.content,
		summary: optionalString(value.summary),
		toolName: optionalString(value.toolName),
		namespace: optionalString(value.namespace),
		toolCallId: optionalString(value.toolCallId),
		isError: value.isError === true,
		command: optionalString(value.command),
		output: optionalString(value.output),
		excludeFromContext: value.excludeFromContext === true,
	};
}
function parsedEntry(line: string): EntryLike | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (!isRecord(value)) {
			return undefined;
		}
		const replacement = isRecord(value.replacement)
			? { content: value.replacement.content }
			: undefined;
		return {
			type: optionalString(value.type),
			id: optionalString(value.id),
			parentId: value.parentId === null ? null : optionalString(value.parentId),
			timestamp: optionalString(value.timestamp),
			message: messageFrom(value.message),
			summary: optionalString(value.summary),
			customType: optionalString(value.customType),
			content: value.content,
			details: value.details,
			display: value.display === true,
			handoff: optionalString(value.handoff),
			firstKeptEntryId: optionalString(value.firstKeptEntryId),
			targetId: optionalString(value.targetId),
			replacement: value.replacement === null ? null : replacement,
		};
	} catch {
		return undefined;
	} // Pi skips malformed journal lines too.
}
/** Window metadata of a Pi-ordered line that cannot open a window, without parsing it. */
function entryHead(prefix: string): EntryLike | undefined {
	const head = ENTRY_HEAD.exec(prefix);
	if (head === null || head[1] === "compaction" || head[1] === "context_window") {
		return undefined;
	}
	return {
		type: head[1],
		id: head[2],
		parentId: head[3] === "null" ? null : head[3]?.slice(1, -1),
	};
}
/** Whether a caller may need a line; other lines only advance window ancestry. */
type LineFilter = (entry: EntryLike) => boolean;
async function readEntry(
	line: SessionLine,
	wanted: LineFilter,
): Promise<{ readonly entry: EntryLike; readonly selected: boolean } | undefined> {
	const head = entryHead(line.head);
	if (head !== undefined && (!line.matches || !wanted(head))) {
		return { entry: head, selected: false };
	}
	const entry = parsedEntry(await line.text());
	return entry === undefined
		? undefined
		: {
				entry,
				selected: head !== undefined || (line.matches && wanted(entry)),
			};
}
export async function* sessionWindowEntries(
	file: string,
	signal?: AbortSignal,
	wanted: LineFilter = () => true,
	matcher?: LineMatcher,
): AsyncGenerator<WindowedEntry> {
	if (!existsSync(file)) {
		return;
	}
	const project = windowProjection();
	for await (const line of sessionLines(file, signal, matcher)) {
		const candidate = await readEntry(line, wanted);
		if (candidate === undefined) {
			continue;
		}
		const windowId = project(candidate.entry);
		const item = candidate.selected ? toWindowedEntry(candidate.entry, windowId) : undefined;
		if (item !== undefined) {
			yield item;
		}
	}
}
/** Breadth-first, like readdirSync's recursive order, reading each level concurrently. */
async function sessionFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	let level = existsSync(dir) ? [dir] : [];
	while (level.length > 0) {
		// Each level lists the directories the previous level found.
		const listings = await Promise.all(
			level.map((path) => readdir(path, { withFileTypes: true })),
		);
		level = [];
		for (const entry of listings.flat()) {
			const path = join(entry.parentPath, entry.name);
			if (entry.isDirectory()) {
				level.push(path);
			} else if (
				entry.isFile() &&
				entry.name.endsWith(".jsonl") &&
				!entry.name.includes(".intent.")
			) {
				files.push(path);
			}
		}
	}
	return files;
}
type SessionFile = { readonly file: string; readonly size: number; readonly mtime: number };
async function newestFirst(files: readonly string[]): Promise<SessionFile[]> {
	const stats = await Promise.all(
		files.map(async (file) => {
			const info = await stat(file);
			return { file, size: info.size, mtime: info.mtimeMs };
		}),
	);
	return stats.sort((a, b) => b.mtime - a.mtime);
}
/** The newest files up to FIRST_SEARCH_BYTES, then the rest. */
function searchPhases(files: readonly SessionFile[]): readonly (readonly string[])[] {
	let count = 0;
	let bytes = 0;
	for (const file of files) {
		if (bytes >= FIRST_SEARCH_BYTES) {
			break;
		}
		bytes += file.size;
		count++;
	}
	const paths = files.map(({ file }) => file);
	return [paths.slice(0, count), paths.slice(count)];
}
async function sessionHeader(
	file: string,
	signal?: AbortSignal,
): Promise<{ readonly cwd?: string | undefined } | undefined> {
	for await (const line of lfLines(file, signal)) {
		try {
			const value: unknown = JSON.parse(line.toString("utf8"));
			if (value === null) {
				continue;
			}
			return isRecord(value) && value.type === "session" && typeof value.id === "string"
				? { cwd: optionalString(value.cwd) }
				: undefined;
		} catch {
			/* Pi skips malformed lines before the first parsed entry. */
		}
	}
	return;
}
function parentSession(
	file: string,
	dir: string,
	hasFile: (file: string) => boolean,
): string | undefined {
	const parts = relative(dir, file).split(sep);
	for (let i = parts.length - 1; i > 0; i--) {
		const candidate = `${join(dir, ...parts.slice(0, i))}.jsonl`;
		if (hasFile(candidate)) {
			return candidate;
		}
	}
	return;
}
export type SessionScope = {
	readonly dir: string;
	readonly cwd: string;
	readonly currentFile?: string | undefined;
	readonly signal?: AbortSignal | undefined;
	readonly fileKey?: string | undefined;
	/** Raw-text needles; files without any of them are skipped. */
	readonly needles?: readonly string[] | undefined;
};
/** Scope memoization is owned by one enumeration; nested runs inherit their parent's project. */
function membership(
	scope: SessionScope,
	hasFile: (file: string) => boolean,
): (file: string) => Promise<boolean> {
	const visible = new Map<string, boolean>();
	const belongs = async (file: string): Promise<boolean> => {
		const known = visible.get(file);
		if (known !== undefined) {
			return known;
		}
		const header = await sessionHeader(file, scope.signal);
		if (header === undefined) {
			visible.set(file, false);
			return false;
		}
		const parent = parentSession(file, scope.dir, hasFile);
		const project =
			header.cwd !== undefined && header.cwd !== "" && resolve(header.cwd) === scope.cwd;
		const allowed =
			file === scope.currentFile || (parent === undefined ? project : await belongs(parent));
		visible.set(file, allowed);
		return allowed;
	};
	return belongs;
}
/** Newest modified project session files, optionally limited by file key or needles. */
export async function* scopedSessionFiles(scope: SessionScope): AsyncGenerator<string> {
	const files = await sessionFiles(scope.dir);
	const fileSet = new Set(files);
	const belongs = membership(scope, (file) => fileSet.has(file));
	const selected = await newestFirst(
		files.filter(
			(file) =>
				scope.fileKey === undefined ||
				scope.fileKey.startsWith(shortKey(relative(scope.dir, file))),
		),
	);
	const prefilter =
		scope.needles === undefined
			? undefined
			: ripgrepFilter(scope.dir, scope.needles, scope.signal);
	for (const phase of searchPhases(selected)) {
		// Older files are searched only when the newest ones did not satisfy the caller.
		for (const file of prefilter === undefined ? phase : await prefilter(phase)) {
			// Preserve newest-first traversal while closing each header stream before opening another.
			if (await belongs(file)) {
				yield file;
			}
		}
	}
}
