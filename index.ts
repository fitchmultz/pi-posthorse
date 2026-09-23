/**
 * Posthorse — fresh context, same journey.
 *
 * Native no-summary context windows for the fitchmultz/pi fork. Pi owns the persisted
 * boundary. Posthorse owns the policy: sparse budget reminders, rollover tools, durable
 * notes, and history recovery.
 */

import { createHash } from "node:crypto";
import {
	appendFileSync,
	constants,
	copyFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import * as codingAgent from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerPosthorseMessages, toolCards, type PosthorseDisplay } from "./ui.ts";

const REMINDER_BUFFER_TOKENS = 32_000;
/** Absolute ceiling for handoffs and recovery pages; pages shrink to the live remaining budget. */
const MAX_HANDOFF_CHARS = 20_000;
const MAX_RECOVERY_RECORD_CHARS = 4_000;
const HANDOFF_OVERHEAD_RESERVE = 1_000;
const PAGE_MARGIN_TOKENS = 1_000;
const MIN_PAGE_CHARS = 1_000;
const ESTIMATED_IMAGE_CHARS = 4_800;
/** A window must hold the largest handoff (~5,000 tokens) plus equal working room below Pi's line. */
const MIN_USABLE_TOKENS = Math.ceil(MAX_HANDOFF_CHARS / 4) * 2;
const REMINDER_TYPE = "posthorse-reminder";
/** Persisted by pi-headroom transcripts before the rename; still recognized everywhere. */
const LEGACY_REMINDER_TYPE = "headroom-reminder";
const AUTO_HANDOFF_PREFIX = "Automatic context rollover recovery record.";
const LEGACY_AUTO_HANDOFF_PREFIX =
	"Automatic context rollover. Continue the current task without asking the user to repeat it.";

type CompactionPolicy = { enabled: boolean; reserveTokens: number };
type ContextUsage = { tokens: number | null; contextWindow: number; percent: number | null };
/** Fork-only SDK export; the public npm declarations do not include it. */
const { publishLocalFile } = codingAgent as typeof codingAgent & {
	publishLocalFile(absolutePath: string, content: string | Uint8Array, signal?: AbortSignal): Promise<void>;
};

/** Fork-only ExtensionContext members; the published Pi types do not declare them. */
type NativeContext = {
	model?: { contextWindow: number };
	newContext(options?: { handoff?: string }): void;
	getCompactionSettings(): CompactionPolicy;
	getContextUsage(): ContextUsage | undefined;
	getSystemPrompt(): string;
};

type NativeExtensionAPI = {
	on(
		event: "session_before_auto_compact",
		handler: (
			event: { reason: "overflow" | "threshold"; branchEntries: EntryLike[]; pendingMessages?: MessageLike[] },
			ctx: unknown,
		) => { newContext: { handoff?: string } } | undefined,
	): void;
};

type ImageLike = { type: "image"; data: string; mimeType: string };
type MessageLike = {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	command?: string;
	output?: string;
	excludeFromContext?: boolean;
};
type EntryLike = {
	type?: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	message?: MessageLike;
	summary?: string;
	customType?: string;
	content?: unknown;
	details?: unknown;
	display?: boolean;
	handoff?: string;
};

type WindowedEntry = { entry: EntryLike; windowId: string; text: string; images: ImageLike[] };
type HistoryHit = { id: string; text: string; headerLength: number; priority: 0 | 1 };
type RecoveryRecord = {
	id: string;
	timestamp: string;
	kind: "owner" | "coordination";
	label: string;
	text: string;
};
type ReminderFingerprint = { windowId: string; contextWindow?: number; reserveTokens?: number };
type Budget = {
	contextWindow: number;
	reserveTokens: number;
	enabled: boolean;
	usable: number;
	rolloverAt: number;
	supported: boolean;
};

function nativeContext<T>(ctx: T): T & NativeContext {
	const candidate = ctx as T & Partial<NativeContext>;
	if (
		typeof candidate.newContext !== "function" ||
		typeof candidate.getCompactionSettings !== "function" ||
		typeof candidate.getSystemPrompt !== "function" ||
		typeof publishLocalFile !== "function"
	) {
		throw new Error("Posthorse requires the fitchmultz/pi fork with native context windows and publishLocalFile (see README).");
	}
	return candidate as T & NativeContext;
}

function isReminderType(customType: unknown): boolean {
	return customType === REMINDER_TYPE || customType === LEGACY_REMINDER_TYPE;
}

function isImage(part: unknown): part is ImageLike {
	const block = part as Partial<ImageLike> | null;
	return typeof block === "object" && block !== null && block.type === "image" && typeof block.data === "string";
}

function imagesOf(content: unknown): ImageLike[] {
	return Array.isArray(content) ? content.filter(isImage) : [];
}

function imageSummary(images: ImageLike[]): string {
	if (!images.length) return "";
	const types = [...new Set(images.map((image) => image.mimeType || "unknown type"))].join(", ");
	return `[${images.length} image${images.length === 1 ? "" : "s"}: ${types}]`;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function textOf(message: MessageLike): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const block = part as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
			if (block.type === "text") return block.text ?? "";
			if (block.type === "thinking") return block.thinking ?? "";
			if (block.type === "toolCall") return `${block.name ?? "tool"} ${safeJsonStringify(block.arguments ?? {})}`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function textResult(text: string, images: ImageLike[] = [], display?: PosthorseDisplay) {
	return { content: [{ type: "text" as const, text }, ...images], details: display };
}

/** Import old checkout-local notes without overwriting shared notes, including concurrent writes. */
function importLegacyNotes(source: string, target: string): void {
	if (!existsSync(source)) return;
	if (existsSync(target) && (!statSync(target).isDirectory() || realpathSync(source) === realpathSync(target))) return;
	mkdirSync(target, { recursive: true });
	for (const name of readdirSync(source)) {
		const from = join(source, name);
		const to = join(target, name);
		if (statSync(from).isDirectory()) {
			importLegacyNotes(from, to);
		} else {
			try {
				copyFileSync(from, to, constants.COPYFILE_EXCL);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
	}
}

/** Conventional repos use the main checkout; separate Git directories are their own shared root. */
function notesRoot(cwd: string): string {
	for (let dir = cwd; ; dir = dirname(dir)) {
		const marker = join(dir, ".git");
		if (existsSync(marker)) {
			let root: string;
			try {
				let target = marker;
				if (!statSync(marker).isDirectory()) {
					const gitdir = readFileSync(marker, "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
					if (!gitdir) return dir;
					target = resolve(dir, gitdir);
				}
				target = realpathSync(target);
				const commonFile = join(target, "commondir");
				const common = realpathSync(existsSync(commonFile) ? resolve(target, readFileSync(commonFile, "utf8").trim()) : target);
				root = basename(common) === ".git" ? dirname(common) : common;
			} catch {
				// Orphaned/copied worktrees can outlive their Git metadata; local notes still work.
				return dir;
			}
			if (root !== dir) importLegacyNotes(join(dir, ".pi", "notes"), join(root, ".pi", "notes"));
			return root;
		}
		if (dirname(dir) === dir) return cwd;
	}
}

function requireValue(value: string | undefined, name: string, op: string): string {
	if (value === undefined || value === "") throw new Error(`"${name}" is required for op "${op}".`);
	return value;
}

function excerptAround(text: string, index: number, before: number, length: number): string {
	const start = Math.max(0, index - before);
	const end = Math.min(text.length, start + length);
	return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function assistantFailure(message: MessageLike): string {
	if (message.role !== "assistant") return "";
	if (message.stopReason !== "error" && message.stopReason !== "aborted" && !message.errorMessage) return "";
	return `[${message.stopReason ?? "error"}]${message.errorMessage ? ` ${message.errorMessage}` : ""}`;
}

function flattenEntry(entry: EntryLike): string | undefined {
	if (entry.type === "message") {
		const message = entry.message ?? {};
		if (message.role === "bashExecution") {
			// Pi keeps these out of every model's input on purpose; do not smuggle them back in through history.
			if (message.excludeFromContext === true) return "[bashExecution] (excluded from model context by Pi)";
			return `[bashExecution] $ ${message.command ?? ""}\n${message.output ?? ""}`;
		}
		return `[${message.role ?? "message"}] ${[textOf(message), assistantFailure(message), imageSummary(imagesOf(message.content))].filter(Boolean).join("\n")}`;
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return `[${entry.type}] ${entry.summary ?? ""}`;
	}
	if (entry.type === "custom_message") {
		return `[custom:${entry.customType ?? "unknown"}] ${[textOf({ content: entry.content }), imageSummary(imagesOf(entry.content))].filter(Boolean).join("\n")}`;
	}
	if (entry.type === "context_window") {
		return `[context_window] ${entry.handoff ? `Handoff: ${entry.handoff}` : "No handoff"}`;
	}
	return undefined;
}

function isRecoveryTool(name: unknown): boolean {
	return name === "history" || name === "notes" || name === "new_context";
}

function isRecoveryCall(part: unknown): boolean {
	const block = part as { type?: string; name?: string } | null;
	return block?.type === "toolCall" && isRecoveryTool(block.name);
}

function historyFileKey(source: string): string {
	return createHash("sha256").update(source).digest("base64url");
}

function historyHit(item: WindowedEntry, query: string, source = ""): HistoryHit | undefined {
	const { entry } = item;
	let text = item.text;
	let matchIndex = text.toLowerCase().indexOf(query);
	if (matchIndex === -1) return undefined;
	let priority: 0 | 1 =
		entry.type === "context_window" ||
		entry.type === "compaction" ||
		entry.type === "branch_summary" ||
		(entry.type === "custom_message" && isReminderType(entry.customType)) ||
		(entry.type === "message" && entry.message?.role === "toolResult" && isRecoveryTool(entry.message.toolName))
			? 1
			: 0;

	if (
		entry.type === "message" && entry.message?.role === "assistant" &&
		Array.isArray(entry.message.content) && entry.message.content.some(isRecoveryCall)
	) {
		// A lookup beside a matching ordinary call or prose must not demote that original content.
		const originals = [""];
		for (const part of entry.message.content) {
			if (isRecoveryCall(part)) {
				originals.push("");
			} else {
				const partText = textOf({ content: [part] });
				if (partText) originals[originals.length - 1] += `${originals.at(-1) ? "\n" : ""}${partText}`;
			}
		}
		const metadata = [assistantFailure(entry.message), imageSummary(item.images)].filter(Boolean).join("\n");
		if (metadata) originals[originals.length - 1] += `${originals.at(-1) ? "\n" : ""}${metadata}`;
		if (originals[0]) originals[0] = `[assistant] ${originals[0]}`;
		const original = originals.find((part) => part.toLowerCase().includes(query));
		priority = original ? 0 : 1;
		if (original) {
			text = original === originals[0] ? original : `[assistant] ${original}`;
			matchIndex = text.toLowerCase().indexOf(query);
		}
	}
	const id = source ? `${entry.id}@${historyFileKey(source)}` : entry.id!;
	const header = `${source ? `${source} ` : ""}${entry.timestamp ?? ""} [window ${item.windowId}] [${id}] `;
	return {
		id,
		priority,
		text: `${header}${excerptAround(text, matchIndex, 100, 400)}`,
		headerLength: header.length,
	};
}

function toWindowedEntry(entry: EntryLike, windows: Map<string, string>): WindowedEntry | undefined {
	const inheritedWindow = entry.parentId ? (windows.get(entry.parentId) ?? "initial") : "initial";
	const windowId = entry.type === "context_window" && entry.id ? entry.id : inheritedWindow;
	if (entry.id) windows.set(entry.id, windowId);
	const text = flattenEntry(entry);
	if (!text || !entry.id) return undefined;
	const images = imagesOf(entry.type === "message" ? entry.message?.content : entry.content);
	return { entry, windowId, text, images };
}

function* windowEntries(entries: Iterable<EntryLike>): Generator<WindowedEntry> {
	const windows = new Map<string, string>();
	for (const entry of entries) {
		const item = toWindowedEntry(entry, windows);
		if (item) yield item;
	}
}

/** JSONL splits on LF, not the Unicode separators that Node's readline also recognizes. */
async function* jsonlLines(file: string, signal?: AbortSignal): AsyncGenerator<string> {
	const stream = createReadStream(file, { encoding: "utf8", signal });
	let pending = "";
	for await (const chunk of stream) {
		const lines = (pending + chunk).split("\n");
		pending = lines.pop()!;
		yield* lines;
	}
	if (pending) yield pending;
}

async function* sessionWindowEntries(file: string, signal?: AbortSignal): AsyncGenerator<WindowedEntry> {
	if (!existsSync(file)) return;
	const windows = new Map<string, string>();
	for await (const line of jsonlLines(file, signal)) {
		let entry: EntryLike;
		try {
			entry = JSON.parse(line) as EntryLike;
		} catch {
			continue;
		}
		if (!entry) continue;
		const item = toWindowedEntry(entry, windows);
		if (item) yield item;
	}
}

function sessionFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const files = readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.includes(".intent."))
		.map((entry) => join(entry.parentPath, entry.name));
	if (files.length < 2) return files;
	return files
		.map((file) => ({ file, mtime: statSync(file).mtimeMs }))
		.sort((a, b) => b.mtime - a.mtime)
		.map(({ file }) => file);
}

async function* scopedSessionFiles(
	dir: string, cwd: string, currentFile: string | undefined, signal?: AbortSignal, fileKey?: string,
): AsyncGenerator<string> {
	const files = sessionFiles(dir);
	const fileSet = new Set(files);
	const visible = new Map<string, boolean>();
	const belongs = async (file: string): Promise<boolean> => {
		const known = visible.get(file);
		if (known !== undefined) return known;
		let header: { cwd?: string } | null = null;
		for await (const line of jsonlLines(file, signal)) {
			try {
				const entry = JSON.parse(line) as { type?: string; id?: unknown; cwd?: unknown } | null;
				if (!entry) continue;
				if (entry.type === "session" && typeof entry.id === "string") header = { cwd: typeof entry.cwd === "string" ? entry.cwd : undefined };
				break;
			} catch {
				// Pi also skips malformed lines before the first parsed entry.
			}
		}
		if (!header) {
			visible.set(file, false);
			return false;
		}
		const parts = relative(dir, file).split(sep);
		let parent: string | undefined;
		for (let i = parts.length - 1; i > 0; i--) {
			const candidate = `${join(dir, ...parts.slice(0, i))}.jsonl`;
			if (fileSet.has(candidate)) {
				parent = candidate;
				break;
			}
		}
		const allowed = file === currentFile || (parent ? await belongs(parent) : !!header.cwd && resolve(header.cwd) === cwd);
		visible.set(file, allowed);
		return allowed;
	};
	for (const file of files) {
		if (fileKey && historyFileKey(relative(dir, file)) !== fileKey) continue;
		if (await belongs(file)) yield file;
	}
}

function currentWindowId(entries: readonly EntryLike[]): string {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "context_window" && entry.id) return entry.id;
	}
	return "initial";
}

function excerpt(text: string, limit: number): string {
	if (text.length <= limit) return text;
	const marker = "\n… middle omitted …\n";
	if (limit <= marker.length) return text.slice(0, limit);
	const head = Math.floor((limit - marker.length) / 2);
	return `${text.slice(0, head)}${marker}${text.slice(text.length - (limit - marker.length - head))}`;
}

function boundedBlock(header: string, text: string, limit: number): string {
	const textLimit = Math.max(0, limit - header.length - 1);
	return textLimit ? `${header}\n${excerpt(text, textLimit)}` : header;
}

function recoveryRecord(entry: EntryLike): RecoveryRecord | undefined {
	let kind: RecoveryRecord["kind"];
	let label: string;
	let text: string;
	let images: ImageLike[] = [];
	if (entry.type === "message" && entry.message?.role === "user") {
		kind = "owner";
		label = "owner input";
		text = textOf(entry.message).trim();
		images = imagesOf(entry.message.content);
	} else if (
		entry.type === "message" &&
		entry.message?.role === "toolResult" &&
		entry.message.toolName === "ask_question" &&
		entry.message.isError !== true
	) {
		kind = "owner";
		label = "owner answer via ask_question";
		text = textOf(entry.message).trim();
	} else if (entry.type === "custom_message" && entry.display === true && !isReminderType(entry.customType)) {
		kind = "coordination";
		label = `visible ${(entry.customType ?? "custom").slice(0, 80)} coordination input (not direct owner input)`;
		text = textOf({ content: entry.content }).trim();
		images = imagesOf(entry.content);
	} else {
		return undefined;
	}
	const id = entry.id?.slice(0, 120) ?? "unknown";
	const summary = imageSummary(images);
	return {
		id,
		timestamp: entry.timestamp?.slice(0, 80) ?? "unknown time",
		kind,
		label,
		text: [text, summary && `${summary} — recover with history read id ${id}`].filter(Boolean).join("\n") || "(non-text content; recover the entry from history)",
	};
}

function formatRecoveryRecord(record: RecoveryRecord, limit: number): string {
	return boundedBlock(`[${record.label} | ${record.timestamp} | entry ${record.id}]`, record.text, limit);
}

function formatPriorCheckpoint(entry: EntryLike | undefined, limit: number): string | undefined {
	const handoff = entry?.handoff?.trim();
	if (!entry || !handoff) return undefined;
	const id = entry.id?.slice(0, 120) ?? "unknown";
	const header = `[older checkpoint; possibly stale | context-window entry ${id}]`;
	if (handoff.startsWith(AUTO_HANDOFF_PREFIX) || handoff.startsWith(LEGACY_AUTO_HANDOFF_PREFIX)) {
		return boundedBlock(header, `Prior automatic recovery text is not nested here. Use history read with entry ${id} if needed.`, limit);
	}
	return boundedBlock(header, handoff, limit);
}

/** Trailing results without a later complete assistant response; interrupted requests may have received them. */
function trailingToolBatch(
	entries: readonly EntryLike[],
): { callId: string; blocks: Array<{ header: string; text: string }> } | undefined {
	const results: EntryLike[] = [];
	let call: EntryLike | undefined;
	for (let i = entries.length - 1; i >= 0 && !call; i--) {
		const entry = entries[i];
		const role = entry.type === "message" ? entry.message?.role : undefined;
		if (role === "toolResult") {
			results.unshift(entry);
		} else if (role === "assistant") {
			const invalid =
				entry.message?.stopReason === "error" ||
				entry.message?.stopReason === "aborted" ||
				entry.message?.stopReason === "length";
			if (invalid) {
				if (results.length) return undefined;
			} else {
				call = entry;
			}
		}
	}
	if (!call || !results.length) return undefined;
	const calls = Array.isArray(call.message?.content)
		? (call.message.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>).filter(
				(block) => block?.type === "toolCall",
			)
		: [];
	const blocks = results.map((result) => {
		const message = result.message ?? {};
		const matching = calls.find((block) => block.id === message.toolCallId);
		const name = (message.toolName ?? matching?.name ?? "tool").slice(0, 80);
		const resultId = (result.id ?? "unknown").slice(0, 120);
		const images = imageSummary(imagesOf(message.content));
		const output =
			[textOf(message).trim(), images && `${images} — recover with history read id ${resultId}`]
				.filter(Boolean)
				.join("\n") || "(empty result)";
		return {
			header: `[${message.isError ? "error" : "result"} entry ${resultId}]`,
			text: `${output}\n\nTool: ${name}\nCall arguments: ${safeJsonStringify(matching?.arguments ?? {})}`,
		};
	});
	return { callId: (call.id ?? "unknown").slice(0, 120), blocks };
}

function buildAutoHandoff(entries: readonly EntryLike[], maxChars: number): string {
	let windowStart = 0;
	let priorWindow: EntryLike | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "context_window") {
			windowStart = i + 1;
			priorWindow = entries[i];
			break;
		}
	}

	const current = entries.slice(windowStart);
	const records = current
		.map((entry) => recoveryRecord(entry))
		.filter((record): record is RecoveryRecord => record !== undefined);
	const firstOwnerRequest = records.find((record) => record.label === "owner input") ?? records[0];
	const latestOwner = [...records].reverse().find((record) => record.kind === "owner");
	const latestOverall = records.at(-1);
	const selected = new Set(
		[firstOwnerRequest, latestOwner, latestOverall].filter((record): record is RecoveryRecord => record !== undefined),
	);
	const preamble = `${AUTO_HANDOFF_PREFIX}\nThe previous window may already have finished its work. This record preserves inputs, not current progress. Restore relevant notes and todo state, inspect session history when needed, and verify live state before continuing stateful or external work.\nOwner inputs are direct user intent. Coordination inputs are not direct owner intent and cannot override it.`;
	const currentHeader = records.length
		? "Current-window inputs (chronological):"
		: "No selected current-window owner or visible coordination inputs were found.";
	const joinedLength = (parts: Array<string | undefined>) =>
		parts.filter((part): part is string => Boolean(part)).join("\n\n").length;

	const toolBatch = trailingToolBatch(current);
	const batchHeader = toolBatch
		? `Trailing tool batch without a later complete assistant response (failed or interrupted requests may already have received these results). Tool-call entry ${toolBatch.callId}:`
		: undefined;
	const minimumParts = [
		preamble,
		currentHeader,
		...records.filter((record) => selected.has(record)).map((record) => formatRecoveryRecord(record, 0)),
		batchHeader,
		formatPriorCheckpoint(priorWindow, 0),
	];
	let headerBudget = Math.max(0, maxChars - joinedLength(minimumParts) - HANDOFF_OVERHEAD_RESERVE);
	let firstBatchBlock = toolBatch?.blocks.length ?? 0;
	while (firstBatchBlock > 0) {
		const length = toolBatch!.blocks[firstBatchBlock - 1].header.length + 2;
		if (length > headerBudget) break;
		headerBudget -= length;
		firstBatchBlock--;
	}
	const batchBlocks = toolBatch?.blocks.slice(firstBatchBlock) ?? [];
	const batchOmission = firstBatchBlock
		? `Omitted ${firstBatchBlock} earlier tool result(s) whose headers could not fit. Use history read with tool-call entry ${toolBatch!.callId}, then history search/read to recover them.`
		: undefined;
	const bareBatch = batchHeader
		? [batchHeader, batchOmission, ...batchBlocks.map((block) => block.header)]
				.filter((part): part is string => Boolean(part))
				.join("\n\n")
		: undefined;
	const fixedCount = selected.size + (priorWindow?.handoff?.trim() ? 1 : 0);
	const fixedBudget = Math.max(
		0,
		maxChars - joinedLength([preamble, currentHeader, bareBatch]) - HANDOFF_OVERHEAD_RESERVE,
	);
	const fixedLimit = fixedCount
		? Math.min(MAX_RECOVERY_RECORD_CHARS, Math.floor(fixedBudget / fixedCount))
		: MAX_RECOVERY_RECORD_CHARS;
	const prior = formatPriorCheckpoint(priorWindow, fixedLimit);
	const formatted = new Map(
		records.map((record) => [
			record,
			formatRecoveryRecord(record, selected.has(record) ? fixedLimit : MAX_RECOVERY_RECORD_CHARS),
		]),
	);
	const fixedParts = () => [
		preamble,
		currentHeader,
		...records.filter((record) => selected.has(record)).map((record) => formatted.get(record)!),
	];

	let batch: string | undefined;
	if (batchHeader && bareBatch) {
		const availableText = Math.max(
			0,
			maxChars -
				joinedLength([...fixedParts(), bareBatch, prior]) -
				HANDOFF_OVERHEAD_RESERVE -
				batchBlocks.length,
		);
		const perBlock = Math.min(MAX_RECOVERY_RECORD_CHARS, Math.floor(availableText / batchBlocks.length));
		batch = [
			batchHeader,
			batchOmission,
			...batchBlocks.map((block) => (perBlock ? `${block.header}\n${excerpt(block.text, perBlock)}` : block.header)),
		]
			.filter((part): part is string => Boolean(part))
			.join("\n\n");
	}

	let optionalBudget = Math.max(0, maxChars - joinedLength([...fixedParts(), batch, prior]) - HANDOFF_OVERHEAD_RESERVE);
	for (let i = records.length - 1; i >= 0; i--) {
		const record = records[i];
		if (selected.has(record)) continue;
		const length = formatted.get(record)!.length + 2;
		if (length > optionalBudget) continue;
		selected.add(record);
		optionalBudget -= length;
	}

	const omitted = records.filter((record) => !selected.has(record));
	const omission = omitted.length
		? `Omitted ${omitted.length} current-window input(s) to stay within the handoff limit (${omitted.filter((record) => record.kind === "owner").length} owner, ${omitted.filter((record) => record.kind === "coordination").length} coordination; ${omitted[0].timestamp} through ${omitted.at(-1)!.timestamp}). Use history search/read to recover them.`
		: undefined;
	return [...fixedParts(), omission, batch, prior].filter((part): part is string => Boolean(part)).join("\n\n");
}

/** Legacy reminders carry only windowId; they match on it alone until the model changes. */
function reminderMatches(details: unknown, fingerprint: ReminderFingerprint): boolean {
	const stored = (details ?? {}) as Partial<ReminderFingerprint>;
	return (
		stored.windowId === fingerprint.windowId &&
		(stored.contextWindow ?? fingerprint.contextWindow) === fingerprint.contextWindow &&
		(stored.reserveTokens ?? fingerprint.reserveTokens) === fingerprint.reserveTokens
	);
}

function reminderIsStale(
	customType: unknown,
	details: unknown,
	fingerprint: ReminderFingerprint,
	branch: readonly EntryLike[],
): boolean {
	if (!reminderMatches(details, fingerprint)) return true;
	const stored = (details ?? {}) as Partial<ReminderFingerprint>;
	if (customType !== LEGACY_REMINDER_TYPE || stored.contextWindow !== undefined || stored.reserveTokens !== undefined) {
		return false;
	}
	let reminderIndex = -1;
	for (let i = 0; i < branch.length; i++) {
		const entry = branch[i];
		if (
			entry.type === "custom_message" &&
			entry.customType === LEGACY_REMINDER_TYPE &&
			((entry.details ?? {}) as Partial<ReminderFingerprint>).windowId === stored.windowId
		) {
			reminderIndex = i;
		}
	}
	return reminderIndex !== -1 && branch.slice(reminderIndex + 1).some((entry) => entry.type === "model_change");
}

function hasReminder(entries: readonly EntryLike[], fingerprint: ReminderFingerprint): boolean {
	return entries.some(
		(entry) =>
			entry.type === "custom_message" &&
			isReminderType(entry.customType) &&
			!reminderIsStale(entry.customType, entry.details, fingerprint, entries),
	);
}

function budgetFor(ctx: NativeContext, contextWindow = ctx.model?.contextWindow): Budget | undefined {
	if (!contextWindow || contextWindow <= 0) return undefined;
	const { enabled, reserveTokens } = ctx.getCompactionSettings();
	const usable = contextWindow - reserveTokens;
	return { contextWindow, reserveTokens, enabled, usable, rolloverAt: usable + 1, supported: !enabled || usable >= MIN_USABLE_TOKENS };
}

/** Half the fresh capacity after prompt/tool/input overhead remains for continued work. */
function freshPayloadChars(ctx: NativeContext, toolTokens: number, pendingMessages: readonly MessageLike[] = []): number {
	const contextWindow = ctx.model?.contextWindow;
	if (!contextWindow || contextWindow <= 0) return MAX_HANDOFF_CHARS;
	const budget = budgetFor(ctx, contextWindow);
	const line = budget?.enabled && budget.supported ? budget.rolloverAt : contextWindow;
	const promptTokens = Math.ceil(ctx.getSystemPrompt().length / 4);
	const pendingTokens = pendingMessages.reduce(
		(total, message) => total + Math.ceil(textOf(message).length / 4) + imagesOf(message.content).length * (ESTIMATED_IMAGE_CHARS / 4),
		0,
	);
	return Math.min(
		MAX_HANDOFF_CHARS,
		Math.max(0, Math.floor((line - PAGE_MARGIN_TOKENS - promptTokens - toolTokens - pendingTokens) / 2)) * 4,
	);
}

function unsupportedMessage(budget: Budget): string {
	const n = (value: number) => value.toLocaleString("en-US");
	return `Posthorse: unsupported configuration. The model's context window (${n(budget.contextWindow)} tokens) minus Pi's compaction.reserveTokens (${n(budget.reserveTokens)}) leaves ${n(budget.usable)} usable tokens; Posthorse needs at least ${n(MIN_USABLE_TOKENS)}. Automatic rollover and checkpoint reminders are off for this model. Lower compaction.reserveTokens in Pi settings or use a larger-context model. new_context remains available with a model-aware handoff limit.`;
}

/** Capacity before Pi's automatic line (or configured context limit), including page metadata and refusals. */
function pageCapacity(ctx: NativeContext, toolTokens: number): number {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens == null) return freshPayloadChars(ctx, toolTokens) / 4 + PAGE_MARGIN_TOKENS;
	const budget = budgetFor(ctx, usage.contextWindow);
	const line = budget?.enabled && budget.supported ? budget.rolloverAt : usage.contextWindow;
	return line - usage.tokens;
}

function buildGuidance(ctx: NativeContext): string {
	const budget = budgetFor(ctx);
	const enabled = budget?.enabled ?? ctx.getCompactionSettings().enabled;
	let automatic: string;
	if (!enabled) {
		automatic =
			"Pi compaction is disabled, so Posthorse sends no checkpoint reminder and performs no automatic rollover. new_context remains available.";
	} else if (budget && !budget.supported) {
		automatic = unsupportedMessage(budget);
	} else {
		const deadline = budget
			? `${Math.max(1, Math.round((budget.rolloverAt / budget.contextWindow) * 100))}% used`
			: "the configured Pi context limit";
		automatic = `Automatic Posthorse rollover follows Pi's enabled compaction setting. At most one best-effort checkpoint reminder may appear before the rollover line (${deadline}); a large turn, overflow, restart, or smaller model can skip it.\nWhen reminded, stop normal work, save goal/progress/decisions/next steps, then call new_context now.`;
	}
	return `## Context self-management (Posthorse)
Context windows are finite. Use get_context_remaining for the best available native estimate when it matters; routine turns do not include a changing meter.
${automatic}
new_context starts a genuinely fresh Pi context after the complete tool batch. Earlier conversation remains in the session transcript and is recoverable with notes and history.
Automatic handoffs are emergency recovery records, not proof of current state. Restore notes/todos/history and verify live state before continuing stateful or external work.`;
}

export default function (pi: ExtensionAPI) {
	registerPosthorseMessages(pi);
	const activeToolTokens = () => {
		const active = new Set(pi.getActiveTools());
		return pi
			.getAllTools()
			// Public npm declarations omit the fork's tool IDs.
			.filter((tool) => active.has((tool as typeof tool & { id: string }).id))
			.reduce(
				(total, tool) =>
					total +
					Math.ceil(
						safeJsonStringify({ name: tool.name, description: tool.description ?? "", parameters: tool.parameters })
							.length / 4,
					),
				0,
			);
	};

	let pendingPageTokens = 0;
	let previousPageUsage: number | null | undefined;
	const pageSize = (ctx: NativeContext, offset: number, imageCount: number, cursor?: string, imageOffset?: number) => {
		const usage = ctx.getContextUsage()?.tokens;
		// Parallel siblings are not in native usage yet; sequential results must not be counted twice.
		if (usage != null && previousPageUsage != null) {
			pendingPageTokens = Math.max(0, pendingPageTokens - Math.max(0, usage - previousPageUsage));
		}
		previousPageUsage = usage;
		const remaining = pageCapacity(ctx, activeToolTokens()) - pendingPageTokens;
		const chars = Math.min(
			MAX_HANDOFF_CHARS,
			Math.max(0, remaining - PAGE_MARGIN_TOKENS) * 4 - imageCount * ESTIMATED_IMAGE_CHARS,
		);
		if (chars < MIN_PAGE_CHARS) {
			const message = `Too little context remains to read a page safely. Call new_context first, then retry ${cursor ? "with the same cursor" : `with offset ${offset}${imageOffset === undefined ? "" : ` and imageOffset ${imageOffset}`}`}.`;
			// Refusals consume context too. Once even the guidance no longer fits, omit repeated text;
			// the failed call still carries its original offset and earlier refusals explain the retry.
			const text = Math.ceil(message.length / 4) <= remaining ? message : "";
			pendingPageTokens += Math.ceil(text.length / 4);
			throw new Error(text);
		}
		return chars;
	};
	const pageResult = (text: string, images: ImageLike[], display: PosthorseDisplay) => {
		pendingPageTokens += Math.ceil(text.length / 4) + images.length * (ESTIMATED_IMAGE_CHARS / 4);
		return textResult(text, images, display);
	};
	const pageError = (ctx: NativeContext, message: string, cursor?: string): never => {
		pageSize(ctx, 0, 0, cursor);
		pendingPageTokens += Math.ceil(message.length / 4);
		throw new Error(message);
	};
	const notesPage = (ctx: NativeContext, rows: string[], offset: number, kind: "notes-list" | "notes-search", empty: string) => {
		const text = rows.length ? rows.join("\n") : empty;
		const chars = pageSize(ctx, offset, 0);
		if (offset && offset >= text.length) pageError(ctx, "Offset is past the end; restart with offset 0.");
		// Reserve the complete continuation, even when one path or excerpt needs several pages.
		const footer = (end: number) => `\n[chars ${offset}-${end} of ${text.length}; continue with offset ${end}]`;
		let end = Math.min(text.length, offset + chars);
		let start = 0;
		const starts: number[] = [];
		for (const row of rows) {
			if (start >= end) break;
			if (start + row.length > offset) starts.push(start);
			start += row.length + 1;
			if (kind === "notes-search" && starts.length === 20) { end = Math.min(end, start - 1); break; }
		}
		// A result-count cap can require continuation even when the character cap did not.
		if (end < text.length) end = Math.min(end, offset + chars - footer(text.length).length);
		return pageResult(text.slice(offset, end) + (end < text.length ? footer(end) : ""), [], { kind, count: starts.filter((start) => start < end).length, page: { offset, end, total: text.length } });
	};
	pi.on("turn_start", () => {
		pendingPageTokens = 0;
		previousPageUsage = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		pendingPageTokens = 0;
		previousPageUsage = undefined;
		nativeContext(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const guidance = buildGuidance(nativeContext(ctx));
		// An earlier full-prompt override makes section edits invisible to Pi.
		if (event.systemPromptOptions.forceSystemPrompt !== undefined) {
			return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
		}
		event.systemPromptOptions.sections.posthorse = guidance;
	});

	pi.on("turn_end", (event, ctx) => {
		const native = nativeContext(ctx);
		if (
			event.message.role === "assistant" &&
			(event.message.stopReason === "error" || event.message.stopReason === "aborted")
		)
			return;
		// Pi commits a new_context request only when every tool in the batch succeeded.
		if (
			event.toolResults.some((result) => result.toolName === "new_context") &&
			!event.toolResults.some((result) => result.isError)
		)
			return;
		const usage = native.getContextUsage();
		if (!usage || usage.tokens == null || usage.contextWindow <= 0) return;
		const budget = budgetFor(native, usage.contextWindow);
		if (!budget || !budget.enabled || !budget.supported) return;
		if (usage.tokens >= budget.rolloverAt) return;
		const reminderBuffer = Math.min(REMINDER_BUFFER_TOKENS, Math.floor(budget.usable * 0.1));
		const remindAt = budget.rolloverAt - reminderBuffer;
		if (usage.tokens < remindAt) return;

		const branch = ctx.sessionManager.getBranch() as EntryLike[];
		const fingerprint: ReminderFingerprint = {
			windowId: currentWindowId(branch),
			contextWindow: budget.contextWindow,
			reserveTokens: budget.reserveTokens,
		};
		if (hasReminder(branch, fingerprint)) return;
		pi.sendMessage(
			{
				customType: REMINDER_TYPE,
				content: `[posthorse] Checkpoint now: ${(budget.rolloverAt - usage.tokens).toLocaleString("en-US")} tokens remain before Pi's automatic rollover line. Stop normal work, save goal/progress/decisions/next steps, then call new_context now. This reminder is best-effort; a large turn, overflow, restart, or smaller model can reach rollover without one.`,
				display: true,
				details: fingerprint,
			},
			{ deliverAs: "steer" },
		);
	});

	// Filter active input only; raw reminders remain in history for deduplication and recovery.
	pi.on("context", (event, ctx) => {
		const marker = event.messages.find(
			(message) => message.role === "custom" && message.customType === "context-window",
		);
		const windowId = marker?.role === "custom" ? (marker.details as { windowId?: unknown } | undefined)?.windowId : "initial";
		if (typeof windowId !== "string") return;
		const native = nativeContext(ctx);
		if (!event.messages.some((message) => message.role === "custom" && isReminderType(message.customType))) return;
		const budget = budgetFor(native);
		const branch = ctx.sessionManager.getBranch() as EntryLike[];
		const fingerprint: ReminderFingerprint = {
			windowId,
			contextWindow: budget?.contextWindow,
			reserveTokens: budget?.reserveTokens,
		};
		const stale = (message: (typeof event.messages)[number]) =>
			message.role === "custom" &&
			isReminderType(message.customType) &&
			(!native.getCompactionSettings().enabled || reminderIsStale(message.customType, message.details, fingerprint, branch));
		if (event.messages.some(stale)) return { messages: event.messages.filter((message) => !stale(message)) };
	});

	// Claim Pi's automatic threshold/overflow trigger with a fresh window: no summary, no summarization auth.
	(pi as unknown as NativeExtensionAPI).on("session_before_auto_compact", (event, ctx) => {
		const native = nativeContext(ctx);
		const budget = budgetFor(native);
		// An unsupported budget would roll over every turn; leave Pi's own behavior in place instead.
		if (budget && !budget.supported) return undefined;
		const limit = freshPayloadChars(native, activeToolTokens(), event.pendingMessages);
		if (limit < MIN_PAGE_CHARS) return undefined;
		const handoff = buildAutoHandoff(event.branchEntries, limit);
		if (handoff.length > limit) return undefined;
		return { newContext: { handoff } };
	});

	pi.registerTool({
		name: "new_context",
		label: "New Context",
		...toolCards("new_context"),
		description:
			"Start a genuinely fresh context window after this tool batch. Earlier conversation leaves active context without a generated summary but remains recoverable through history. Pass concise continuation state in handoff, or save richer state with notes first.",
		promptSnippet: "start a fresh context window with an optional atomic handoff",
		promptGuidelines: [
			"Before calling new_context, pass concise continuation state in handoff or save durable goal/progress/decisions/next-steps with notes",
		],
		parameters: Type.Object({
			handoff: Type.Optional(
				Type.String({
					description: "Concise state the fresh window needs to continue correctly",
					maxLength: MAX_HANDOFF_CHARS,
				}),
			),
		}),
		async execute(_id, { handoff }, _signal, _onUpdate, ctx) {
			const native = nativeContext(ctx);
			const trimmed = handoff?.trim() || undefined;
			const limit = freshPayloadChars(native, activeToolTokens());
			if (trimmed && trimmed.length > limit) {
				throw new Error(
					`Handoff is too large for the active model (${trimmed.length.toLocaleString("en-US")} characters; limit ${limit.toLocaleString("en-US")}). Save fuller state in notes, then retry with a shorter handoff or no handoff.`,
				);
			}
			return {
				...textResult(
					"Requested a fresh Pi context after this complete tool batch succeeds. Earlier conversation stays in session history.",
					[],
					{ kind: "new-context" },
				),
				newContext: { handoff: trimmed },
			};
		},
	});

	pi.registerTool({
		name: "get_context_remaining",
		label: "Context Remaining",
		...toolCards("get_context_remaining"),
		description:
			"Best available native estimate of the context budget: tokens until Pi's automatic rollover line and until the configured context limit.",
		promptSnippet: "check the remaining context budget only when needed",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const native = nativeContext(ctx);
			const usage = native.getContextUsage();
			if (!usage || usage.tokens == null) return textResult("Context usage is not known until the next model response.", [], { kind: "context" });
			const n = (value: number) => value.toLocaleString("en-US");
			const budget = budgetFor(native, usage.contextWindow);
			const display: PosthorseDisplay = {
				kind: "context", usage,
				rollover: !budget?.enabled ? "disabled" : budget.supported ? "enabled" : "unsupported",
				rolloverAt: budget?.rolloverAt,
			};
			const configured = `≈${n(Math.max(0, usage.contextWindow - usage.tokens))} tokens until the configured context limit (${n(usage.tokens)}/${n(usage.contextWindow)} used, ${Math.round(usage.percent ?? 0)}%). Best available native estimate.`;
			if (!budget?.enabled) return textResult(`Automatic rollover is disabled (Pi compaction.enabled=false). ${configured}`, [], display);
			if (!budget.supported) return textResult(`${unsupportedMessage(budget)} ${configured}`, [], display);
			return textResult(
				`≈${n(Math.max(0, budget.rolloverAt - usage.tokens))} tokens until automatic rollover (line at ${n(budget.rolloverAt)}); ${configured}`,
				[], display,
			);
		},
	});

	pi.registerTool({
		name: "notes",
		label: "Notes",
		...toolCards("notes"),
		description:
			"Persistent notes in .pi/notes/ that survive context resets. Ops: list/read/search (paged; repeat with offset to continue), write (create/replace; empty content clears), append. Search matches case-insensitive substrings over note lines. Git worktrees share notes: at the main checkout for conventional .git layouts, or in the common Git directory when metadata is stored separately. Old checkout-local notes are imported without overwriting shared notes.",
		promptSnippet: "save and recall durable state that survives context resets",
		promptGuidelines: [
			"Use notes for durable state too large for a new_context handoff",
			"Reload relevant notes after a context rollover",
		],
		parameters: Type.Object({
			op: Type.Union(
				[Type.Literal("list"), Type.Literal("read"), Type.Literal("write"), Type.Literal("append"), Type.Literal("search")],
				{ description: "Operation to perform" },
			),
			path: Type.Optional(Type.String({ description: "Note path relative to .pi/notes/ (read/write/append)" })),
			content: Type.Optional(Type.String({ description: "Full file content (write) or text to add (append)" })),
			query: Type.Optional(Type.String({ description: "Substring to find in notes (search)" })),
			offset: Type.Optional(Type.Integer({ description: "Character offset for list/read/search (default 0)", minimum: 0 })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const dir = join(notesRoot(ctx.cwd), ".pi", "notes");
			const safeJoin = (path: string) => {
				const relative = normalize(path.replace(/^[/\\]+/, ""));
				if (relative === ".." || relative.startsWith(`..${sep}`) || isAbsolute(relative)) {
					throw new Error(`Invalid path "${path}": must stay inside .pi/notes/.`);
				}
				return join(dir, relative);
			};
			const walk = (directory: string, output: string[]) => {
				for (const file of readdirSync(directory)) {
					const path = join(directory, file);
					if (statSync(path).isDirectory()) walk(path, output);
					else output.push(path);
				}
			};

			switch (params.op) {
				case "list": {
					const files: string[] = [];
					if (existsSync(dir)) walk(dir, files);
					return notesPage(nativeContext(ctx), files.map((file) => file.slice(dir.length + 1)), params.offset ?? 0, "notes-list", "(no notes yet)");
				}
				case "read": {
					const relative = requireValue(params.path, "path", params.op);
					const path = safeJoin(relative);
					if (!existsSync(path)) throw new Error(`No note at ${relative}. Use op "list" to see available notes.`);
					const text = readFileSync(path, "utf8");
					const offset = params.offset ?? 0;
					if (offset && offset >= text.length) {
						throw new Error(`Offset ${offset} is past the end of ${relative} (${text.length} chars).`);
					}
					const end = Math.min(text.length, offset + pageSize(nativeContext(ctx), offset, 0));
					const more =
						end < text.length ? `\n[chars ${offset}-${end} of ${text.length}; continue with offset ${end}]` : "";
					return pageResult(`${text.slice(offset, end)}${more}`, [], { kind: "note-read", offset, end, total: text.length });
				}
				case "write": {
					const relative = requireValue(params.path, "path", params.op);
					if (params.content === undefined) throw new Error(`"content" is required for op "write" (use "" to clear a note).`);
					const path = safeJoin(relative);
					mkdirSync(dirname(path), { recursive: true });
					await publishLocalFile(path, params.content, signal);
					return textResult(`Wrote ${path}`, [], { kind: "note-write" });
				}
				case "append": {
					const relative = requireValue(params.path, "path", params.op);
					const content = requireValue(params.content, "content", params.op);
					const path = safeJoin(relative);
					mkdirSync(dirname(path), { recursive: true });
					// One O_APPEND write per newline-terminated record, so concurrent Pi processes appending to a
					// shared note never merge records. The separator only matters after a write that left no trailing
					// newline; a torn read of another process's in-flight append costs at most one blank line.
					const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
					const separator = existing && !existing.endsWith("\n") ? "\n" : "";
					appendFileSync(path, `${separator}${content.replace(/\n?$/, "\n")}`);
					return textResult(`Appended to ${path}`, [], { kind: "note-append" });
				}
				case "search": {
					const query = requireValue(params.query, "query", params.op).toLowerCase();
					const files: string[] = [];
					if (existsSync(dir)) walk(dir, files);
					const hits: string[] = [];
					for (const file of files) {
						for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
							const trimmed = line.trim();
							const match = trimmed.toLowerCase().indexOf(query);
							if (match !== -1) {
								hits.push(`${file.slice(dir.length + 1)}:${index + 1}: ${excerptAround(trimmed, match, 50, 200)}`);
							}
						}
					}
					return notesPage(nativeContext(ctx), hits, params.offset ?? 0, "notes-search", `No notes match "${excerpt(params.query!, 200)}".`);
				}
			}
		},
	});

	pi.registerTool({
		name: "history",
		label: "History",
		...toolCards("history"),
		description:
			"Search or read normalized session entries, including earlier native context windows. Search prioritizes original content before recovery notes, handoffs, and history lookups; all remain searchable. Current branch by default; all=true searches sessions from this working directory and their nested subagents, including fork copies, and returns file-qualified entry ids for unambiguous reads. Within each group: newest-modified sessions first, newest entries per session. Continue searches with the returned cursor and the same query/scope; new searches see newer entries. Reads page text and stored images; continue with the returned offset and imageOffset.",
		promptSnippet: "recover earlier conversation that left the active context window",
		promptGuidelines: ["Use history search first, then history read with the returned entry id"],
		parameters: Type.Object({
			op: Type.Union([Type.Literal("search"), Type.Literal("read")], { description: "Operation to perform" }),
			query: Type.Optional(Type.String({ description: "Case-insensitive text to find (search)" })),
			id: Type.Optional(Type.String({ description: "Entry id returned by search (read)" })),
			all: Type.Optional(Type.Boolean({ description: "Search all project sessions instead of the current branch" })),
			limit: Type.Optional(Type.Integer({ description: "Maximum search results per page (default 10, max 50)", minimum: 1, maximum: 50 })),
			cursor: Type.Optional(Type.String({ description: "Search continuation returned by the previous page; keep query and all unchanged", maxLength: 512 })),
			offset: Type.Optional(Type.Integer({ description: "Character offset for read (default 0)", minimum: 0 })),
			imageOffset: Type.Optional(Type.Integer({ description: "First image to return for read (default 0 on the first text page; otherwise skips images). Use both offsets from the continuation.", minimum: 0 })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const manager = ctx.sessionManager;
			const cwd = resolve(ctx.cwd);
			const currentFile = manager.getSessionFile?.();

			if (params.op === "search") {
				const query = requireValue(params.query, "query", params.op).toLowerCase();
				const limit = params.limit ?? 10;
				const searchKey = createHash("sha256").update(JSON.stringify([query, params.all === true])).digest("base64url");
				let cursor: [string, 0 | 1, number, string] | undefined;
				if (params.cursor) {
					try {
						const value = JSON.parse(Buffer.from(params.cursor, "base64url").toString());
						if (!Array.isArray(value) || value.length !== 4 || typeof value[0] !== "string" || !value[0] || ![0, 1].includes(value[1]) || !Number.isSafeInteger(value[2]) || value[2] < 0 || value[3] !== searchKey) throw new Error();
						cursor = value as typeof cursor;
					} catch { pageError(nativeContext(ctx), "Invalid history cursor or changed query/scope; restart the search without it.", params.cursor); }
				}
				const hits: HistoryHit[][] = [[], []];
				let found = !cursor;
				const addHit = (hit: HistoryHit | undefined) => {
					if (!hit) return;
					if (cursor && hit.priority < cursor[1]) return;
					if (cursor && hit.priority === cursor[1] && !found) {
						if (hit.id !== cursor[0]) return;
						found = true;
						if (cursor[2] > hit.text.length) pageError(nativeContext(ctx), "History cursor is past the entry; restart the search without it.", params.cursor);
						if (cursor[2] === hit.text.length) return;
					}
					if (hits[hit.priority].length <= limit) hits[hit.priority].push(hit);
				};

				if (params.all) {
					for await (const file of scopedSessionFiles(manager.getSessionDir(), cwd, currentFile, signal)) {
						const recent: HistoryHit[][] = [[], []];
						let anchorHere = false;
						const source = relative(manager.getSessionDir(), file);
						for await (const item of sessionWindowEntries(file, signal)) {
							const hit = historyHit(item, query, source);
							if (!hit) continue;
							const seeking = cursor && !found && hit.priority === cursor[1];
							if (seeking && anchorHere) continue;
							if (seeking && hit.id === cursor?.[0]) anchorHere = true;
							const group = recent[hit.priority];
							group.push(hit);
							// Keep one page plus its anchor and lookahead, not every matching excerpt.
							if (group.length > limit + 2) group.shift();
						}
						if (cursor && !found && !anchorHere) recent[cursor[1]] = [];
						for (const group of recent) for (const hit of group.reverse()) addHit(hit);
						if (hits[0].length > limit) break;
					}
				} else {
					const current = [...windowEntries(manager.getBranch() as EntryLike[])];
					for (const item of current.reverse()) {
						addHit(historyHit(item, query));
						if (hits[0].length > limit) break;
					}
				}
				const chars = pageSize(nativeContext(ctx), 0, 0, params.cursor);
				if (!found) pageError(nativeContext(ctx), "History cursor entry no longer matches; restart the search without it.", params.cursor);
				const results = hits.flat();
				const cursorFor = (hit: HistoryHit, offset: number) => Buffer.from(JSON.stringify([hit.id, hit.priority, offset, searchKey])).toString("base64url");
				const footer = (next: string) => `\n[More results; continue with cursor "${next}" and the same query/scope.]`;
				const reserve = Math.max(0, ...results.map((hit) => footer(cursorFor(hit, hit.text.length)).length));
				if (reserve >= chars) pageError(nativeContext(ctx), "History entry id is too large for pagination.", params.cursor);
				const parts: string[] = [];
				const spans: Array<{ headerLength: number; length: number }> = [];
				let available = chars - reserve;
				let next: string | undefined;
				for (const hit of results) {
					const offset = cursor?.[0] === hit.id ? cursor[2] : 0;
					if (parts.length && hit.text.length - offset > available) break;
					// A split header or excerpt must still identify the native entry on every page.
					const prefix = offset || hit.text.length > available ? `[entry ${hit.id}; from char ${offset}] ` : "";
					if (prefix.length >= available) break;
					const end = Math.min(hit.text.length, offset + available - prefix.length);
					const part = prefix + hit.text.slice(offset, end);
					parts.push(part);
					spans.push({ headerLength: prefix.length + Math.max(0, Math.min(hit.headerLength - offset, end - offset)), length: part.length });
					available -= part.length + 1;
					next = end < hit.text.length || parts.length < results.length ? cursorFor(hit, end) : undefined;
					if (available <= 0 || parts.length >= limit) break;
				}
				const body = parts.length ? parts.join("\n") : `No history matches "${excerpt(params.query!, 200)}".`;
				const more = next ? footer(next) : "";
				return pageResult(body + more, [], { kind: "history-search", entries: spans, footerLength: more.length });
			}

			const id = requireValue(params.id, "id", params.op);
			const separator = id.indexOf("@");
			const entryId = separator < 0 ? id : id.slice(0, separator);
			const fileKey = separator < 0 ? undefined : id.slice(separator + 1);
			const formatEntry = (item: WindowedEntry, source = "") => {
				const offset = params.offset ?? 0;
				const imageOffset = params.imageOffset ?? (offset === 0 ? 0 : item.images.length);
				if (imageOffset > item.images.length) {
					throw new Error(`Image offset ${imageOffset} is past the end of history entry "${id}" (${item.images.length} images).`);
				}
				if (offset > item.text.length || (offset === item.text.length && imageOffset === item.images.length)) {
					throw new Error(`Offset ${offset} is past the end of history entry "${id}" (${item.text.length} chars).`);
				}
				// Reserve one image first so an image-only continuation either advances or asks for fresh context.
				const firstImage = imageOffset < item.images.length ? 1 : 0;
				const chars = pageSize(nativeContext(ctx), offset, firstImage, undefined, item.images.length ? imageOffset : undefined);
				const imageEnd = Math.min(item.images.length, imageOffset + firstImage + Math.floor((chars - MIN_PAGE_CHARS) / ESTIMATED_IMAGE_CHARS));
				const images = item.images.slice(imageOffset, imageEnd);
				const end = Math.min(
					item.text.length,
					offset + chars - (images.length - firstImage) * ESTIMATED_IMAGE_CHARS,
				);
				const more = end < item.text.length || imageEnd < item.images.length
					? `\nMore remains; call history read with id "${id}" and offset ${end}${item.images.length ? ` and imageOffset ${imageEnd}` : ""}.` : "";
				const header = `${source ? `${source} ` : ""}${item.entry.timestamp ?? ""} [window ${item.windowId}] [${id}] [chars ${offset}-${end} of ${item.text.length}] `;
				return pageResult(
					`${header}${item.text.slice(offset, end)}${more}`,
					images,
					{ kind: "history-read", headerLength: header.length, offset, end, total: item.text.length, imageOffset, imageEnd, imageTotal: item.images.length },
				);
			};

			if (fileKey === undefined) {
				for (const item of windowEntries(manager.getBranch() as EntryLike[])) {
					if (item.entry.id === entryId) return formatEntry(item);
				}
			}
			for await (const file of scopedSessionFiles(manager.getSessionDir(), cwd, currentFile, signal, fileKey)) {
				const fileSource = relative(manager.getSessionDir(), file);
				for await (const item of sessionWindowEntries(file, signal)) {
					if (item.entry.id === entryId) return formatEntry(item, fileSource);
				}
			}
			throw new Error(`No history entry with id "${id}".`);
		},
	});
}
