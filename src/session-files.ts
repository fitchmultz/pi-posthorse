import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
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
import { toWindowedEntry, windowProjection } from "./history-entries.ts";
import { shortKey } from "./message-text.ts";

function execFileText(
	file: string,
	args: readonly string[],
	signal?: AbortSignal,
): Promise<string> {
	return new Promise((resolveOutput, reject) => {
		execFile(file, args, { signal, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
			if (error !== null) {
				const failure: Error = error;
				reject(failure);
			} else {
				resolveOutput(stdout);
			}
		});
	});
}
/** Raw JSONL needles must cover every match in normalized text; otherwise scan all files. */
export function prefilterNeedles(query: string): string[] | undefined {
	if (/["\\[\](){}:$\p{Cc}]/u.test(query) || query.trim() !== query) {
		return undefined;
	}
	if (
		["call id", "execution arguments", "no handoff", "excluded from model context by pi"].some(
			(phrase) => phrase.includes(query),
		)
	) {
		return undefined;
	}
	const image =
		query.includes(",") ||
		/^\d+ ?i?m?a?g?e?s?$/.test(query) ||
		["images", "unknown type"].some((phrase) => phrase.includes(query));
	return image ? [query, '"type":"image"'] : [query];
}
export async function filesContaining(
	dir: string,
	needles: readonly string[],
	signal?: AbortSignal,
): Promise<Set<string> | undefined> {
	const args = [
		"--files-with-matches",
		"--fixed-strings",
		"--ignore-case",
		"--no-ignore",
		"--hidden",
		"--no-messages",
		"--glob",
		"*.jsonl",
		...needles.flatMap((needle) => ["--regexp", needle]),
		dir,
	];
	for (const rg of [join(getAgentDir(), "bin", "rg"), "rg"]) {
		try {
			// Try the host-managed binary first; PATH is a fallback only when it is unavailable.
			// oxlint-disable-next-line no-await-in-loop
			const stdout = await execFileText(rg, args, signal);
			return new Set(
				stdout
					.split("\n")
					.filter((file) => file !== "")
					.map((file) => resolve(file)),
			);
		} catch (error) {
			const code = isRecord(error) ? error.code : undefined;
			if (code === 1) {
				return new Set();
			}
			if (code === "ENOENT") {
				continue;
			}
			signal?.throwIfAborted();
			return undefined;
		}
	}
	return;
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
export async function* sessionWindowEntries(
	file: string,
	signal?: AbortSignal,
	entryId?: string,
): AsyncGenerator<WindowedEntry> {
	if (!existsSync(file)) {
		return;
	}
	const project = windowProjection();
	for await (const line of lfLines(file, signal)) {
		const entry = parsedEntry(line);
		if (entry === undefined) {
			continue;
		}
		const windowId = project(entry);
		if (entryId !== undefined && entry.id !== entryId) {
			continue;
		}
		const item = toWindowedEntry(entry, windowId);
		if (item !== undefined) {
			yield item;
		}
	}
}
function sessionFiles(dir: string): string[] {
	if (!existsSync(dir)) {
		return [];
	}
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter(
			(entry) =>
				entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.includes(".intent."),
		)
		.map((entry) => join(entry.parentPath, entry.name));
}
async function sessionHeader(
	file: string,
	signal?: AbortSignal,
): Promise<{ readonly cwd?: string } | undefined> {
	for await (const line of lfLines(file, signal)) {
		try {
			const value: unknown = JSON.parse(line);
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
	readonly currentFile?: string;
	readonly signal?: AbortSignal;
	readonly fileKey?: string;
	readonly candidates?: (file: string) => boolean;
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
/** Newest modified project session files, optionally limited by file key or prefilter. */
export async function* scopedSessionFiles(scope: SessionScope): AsyncGenerator<string> {
	const files = sessionFiles(scope.dir);
	const fileSet = new Set(files);
	const belongs = membership(scope, (file) => fileSet.has(file));
	const selected = files
		.filter(
			(file) =>
				(scope.candidates === undefined || scope.candidates(resolve(file))) &&
				(scope.fileKey === undefined ||
					scope.fileKey.startsWith(shortKey(relative(scope.dir, file)))),
		)
		.map((file) => ({ file, mtime: statSync(file).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime);
	for (const { file } of selected) {
		// Preserve newest-first traversal while closing each header stream before opening another.
		// oxlint-disable-next-line no-await-in-loop
		if (await belongs(file)) {
			yield file;
		}
	}
}
