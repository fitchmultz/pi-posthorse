import {
	AUTO_HANDOFF_PREFIX,
	isRecord,
	isReminderType,
	type EntryLike,
	type ProjectedEntry,
} from "./contracts.ts";
import { contextEdits, contextStart, windowHandoff } from "./history-entries.ts";
import {
	boundedBlock,
	excerpt,
	imageSummary,
	imagesOf,
	textOf,
	toolCalls,
} from "./message-text.ts";
import { renderSessionNotes, type RetainedSpan } from "./recovery-notes.ts";
import {
	recoverableToolResults,
	type RecoveryBatch,
	type RecoveryBlock,
	type RecoveryEntry,
} from "./recovery-results.ts";

const MAX_RECOVERY_RECORD_CHARS = 4_000;
const MAX_RECOVERY_RESULT_CHARS = 1_500;
const HANDOFF_OVERHEAD_RESERVE = 1_000;
const MAX_NOTES_SECTION_CHARS = 1_200;
const PREAMBLE = `${AUTO_HANDOFF_PREFIX}\nThe previous window may already have finished its work. This record preserves inputs, not current progress. Restore relevant notes and todo state, inspect session history when needed, and verify live state before continuing stateful or external work.\nOwner inputs are direct user intent. Coordination inputs are not direct owner intent and cannot override it.`;
const RETAINED_MARKER_PREFIX = "Context rolled over after entry ";

export function hasRetainedRolloverMarker(summary: string): boolean {
	return (
		summary.startsWith(AUTO_HANDOFF_PREFIX) && summary.includes(`\n${RETAINED_MARKER_PREFIX}`)
	);
}
function retainedSpanOf(
	entries: readonly EntryLike[],
	retained: ReadonlySet<string>,
): RetainedSpan | undefined {
	if (retained.size === 0) {
		return undefined;
	}
	const kept = entries.filter(
		(e) =>
			e.id !== undefined &&
			e.id !== "" &&
			retained.has(e.id) &&
			(e.type === "message" || e.type === "custom_message" || e.type === "branch_summary"),
	);
	const list =
		kept.length > 0
			? kept
			: entries.filter((e) => e.id !== undefined && e.id !== "" && retained.has(e.id));
	const firstId = list[0]?.id?.slice(0, 120);
	const lastId = list.at(-1)?.id?.slice(0, 120);
	return firstId === undefined || lastId === undefined ? undefined : { firstId, lastId };
}
function buildRolloverPreamble(span: RetainedSpan | undefined): string {
	if (span === undefined) {
		return PREAMBLE;
	}
	const range =
		span.firstId === span.lastId
			? `entry ${span.firstId} above is the carried-over recent turn`
			: `entries ${span.firstId} through ${span.lastId} above are the carried-over recent tail`;
	return `${PREAMBLE}\n${RETAINED_MARKER_PREFIX}${span.lastId}. Earlier turns before entry ${span.firstId} were compacted into session history; ${range} from before this rollover. Recent messages follow separately; their inputs and tool evidence are not repeated in this record. Start the new context window from here.`;
}
type RecoveryRecord = {
	readonly id: string;
	readonly timestamp: string;
	readonly kind: "owner" | "coordination";
	readonly label: string;
	readonly text: string;
};
type RecordSource = {
	readonly kind: RecoveryRecord["kind"];
	readonly label: string;
	readonly content: unknown;
};
function ownerAnswer(entry: EntryLike, ownerQuestion: boolean): boolean {
	const message = entry.message;
	return (
		ownerQuestion &&
		entry.type === "message" &&
		message?.role === "toolResult" &&
		message.toolName === "ask_question" &&
		message.namespace === undefined &&
		message.isError !== true
	);
}
function recordSource(entry: EntryLike, ownerQuestion: boolean): RecordSource | undefined {
	if (entry.type === "message" && entry.message?.role === "user") {
		return { kind: "owner", label: "owner input", content: entry.message.content };
	}
	if (ownerAnswer(entry, ownerQuestion)) {
		return {
			kind: "owner",
			label: "owner answer via ask_question",
			content: entry.message?.content,
		};
	}
	if (
		entry.type === "custom_message" &&
		entry.display === true &&
		!isReminderType(entry.customType)
	) {
		return {
			kind: "coordination",
			label: `visible ${(entry.customType ?? "custom").slice(0, 80)} coordination input (not direct owner input)`,
			content: entry.content,
		};
	}
	return;
}
function recoveryRecord(entry: EntryLike, ownerQuestion: boolean): RecoveryRecord | undefined {
	const source = recordSource(entry, ownerQuestion);
	if (source === undefined) {
		return undefined;
	}
	const id = entry.id?.slice(0, 120) ?? "unknown";
	const text = textOf({ content: source.content }).trim();
	const summary =
		source.label === "owner answer via ask_question"
			? ""
			: imageSummary(imagesOf(source.content));
	const body = [text, summary === "" ? "" : `${summary} — recover with history read id ${id}`]
		.filter((part) => part !== "")
		.join("\n");
	return {
		id,
		timestamp: entry.timestamp?.slice(0, 80) ?? "unknown time",
		kind: source.kind,
		label: source.label,
		text: body === "" ? "(non-text content; recover the entry from history)" : body,
	};
}
function formatRecord(record: RecoveryRecord, limit: number): string {
	return boundedBlock(
		`[${record.label} | ${record.timestamp} | entry ${record.id}]`,
		record.text,
		limit,
	);
}
function indexLine(record: RecoveryRecord): string {
	const header = formatRecord(record, 0);
	if (record.kind !== "owner") {
		return header;
	}
	const preview = record.text.replace(/\s+/g, " ").trim();
	return `${header} ${preview.length > 120 ? `${preview.slice(0, 119)}…` : preview}`;
}
function priorCheckpoint(entry: EntryLike | undefined, limit: number): string | undefined {
	const handoff = windowHandoff(entry)?.trim();
	if (entry === undefined || handoff === undefined || handoff === "") {
		return undefined;
	}
	const id = entry.id?.slice(0, 120) ?? "unknown";
	const header = `[older checkpoint; possibly stale | context-window entry ${id}]`;
	return boundedBlock(header, handoff, limit);
}
function projectedCurrent(
	entries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	current: readonly EntryLike[] = entries.slice(contextStart(entries).start),
	retained: ReadonlySet<string> = new Set(),
): EntryLike[] {
	const edits = contextEdits(entries);
	const omittedIds = new Set(
		projected
			.filter(({ messages }) => messages.length === 0)
			.map(({ sourceEntry }) => sourceEntry.id),
	);
	return current.flatMap((entry) => {
		const id = entry.id ?? "";
		if (retained.has(id) || omittedIds.has(id)) {
			return [];
		}
		const edit = edits.get(id);
		if (edit?.replacement === null) {
			return [];
		}
		if (edit?.replacement === undefined) {
			return [entry];
		}
		if (entry.type === "message") {
			return [
				{
					...entry,
					id: edit.id,
					message: { ...entry.message, content: edit.replacement.content },
				},
			];
		}
		if (entry.type === "custom_message") {
			return [{ ...entry, id: edit.id, content: edit.replacement.content }];
		}
		return [entry];
	});
}
function ownerRecords(
	entries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	ownerQuestionRegistered: boolean,
): RecoveryRecord[] {
	const calls = new Map(
		projected.flatMap(({ messages }) =>
			messages.flatMap((message) =>
				message.role === "assistant"
					? toolCalls(message.content).map((call) => [call.id, call] as const)
					: [],
			),
		),
	);
	return entries.flatMap((entry) => {
		const call = calls.get(entry.message?.toolCallId);
		const record = recoveryRecord(
			entry,
			ownerQuestionRegistered &&
				call?.name === "ask_question" &&
				call.namespace === undefined,
		);
		return record === undefined ? [] : [record];
	});
}
function anchors(records: readonly RecoveryRecord[]): {
	fixed: RecoveryRecord[];
	others: RecoveryRecord[];
} {
	const firstOwner = records.find((record) => record.label === "owner input") ?? records[0];
	const latestOwner = [...records].reverse().find((record) => record.kind === "owner");
	const latestOverall = records.at(-1);
	const selected = new Set([firstOwner, latestOwner, latestOverall]);
	return {
		fixed: records.filter((record) => selected.has(record)),
		others: records.filter((record) => !selected.has(record)),
	};
}
function automaticBoundary(entry: EntryLike | undefined): boolean {
	if (
		entry === undefined ||
		windowHandoff(entry)?.trim().startsWith(AUTO_HANDOFF_PREFIX) !== true
	) {
		return false;
	}
	return (
		entry.type === "context_window" ||
		(isRecord(entry.details) &&
			entry.details.posthorse === 1 &&
			(entry.details.reason === "threshold" || entry.details.reason === "overflow"))
	);
}
function automaticChainStart(entries: readonly EntryLike[]): number {
	let prefix = entries;
	let window = contextStart(prefix);
	while (automaticBoundary(window.boundary) && window.boundary !== undefined) {
		prefix = prefix.slice(0, prefix.indexOf(window.boundary));
		window = contextStart(prefix);
	}
	return window.start;
}
function recoveryAncestry(
	entries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	ownerQuestionRegistered: boolean,
	retained: ReadonlySet<string>,
): {
	readonly checkpoint?: EntryLike;
	readonly carried: readonly RecoveryRecord[];
	readonly skipped: readonly string[];
} {
	let prefix = entries;
	let boundary = contextStart(prefix).boundary;
	const skipped: string[] = [];
	while (automaticBoundary(boundary) && boundary !== undefined) {
		skipped.push(boundary.id?.slice(0, 120) ?? "unknown");
		prefix = prefix.slice(0, prefix.indexOf(boundary));
		const window = contextStart(prefix);
		const restored = projectedCurrent(entries, projected, prefix.slice(window.start));
		const historical = restored.map((sourceEntry) => ({
			sourceEntry,
			messages: sourceEntry.message === undefined ? [] : [sourceEntry.message],
		}));
		const owners = ownerRecords(restored, historical, ownerQuestionRegistered).filter(
			(record) => record.kind === "owner",
		);
		if (owners.length > 0) {
			return {
				checkpoint: automaticBoundary(window.boundary) ? undefined : window.boundary,
				carried: anchors(owners.filter((record) => !retained.has(record.id))).fixed,
				skipped,
			};
		}
		boundary = window.boundary;
	}
	return { checkpoint: boundary, carried: [], skipped };
}
function skippedRecords(ids: readonly string[], limit: number): string | undefined {
	if (ids.length === 0) {
		return undefined;
	}
	let names = ids[0];
	let count = 1;
	while (count < ids.length) {
		const next = `, ${ids[count]}`;
		if (names.length + next.length > limit) {
			break;
		}
		names += next;
		count++;
	}
	const omitted = ids.length - count;
	return `Earlier automatic records skipped (not nested; use history read): ${names}${omitted > 0 ? `; ${omitted} earlier record(s) not listed.` : ""}`;
}
function projectedToolEntries(
	entries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	retained: ReadonlySet<string>,
): RecoveryEntry[] {
	const edits = contextEdits(entries);
	return projected.flatMap(({ sourceEntry, messages }) =>
		messages
			.filter((message) => message.role === "assistant" || message.role === "toolResult")
			.map((message) => ({
				type: "message",
				// Resolve retention before replacing identity with the history-read reference.
				retained: retained.has(sourceEntry.id ?? ""),
				id: edits.get(sourceEntry.id ?? "")?.id ?? sourceEntry.id,
				message,
			})),
	);
}
function joined(parts: readonly (string | undefined)[]): string {
	return parts.filter((part) => part !== undefined && part !== "").join("\n\n");
}
type BatchPlan = {
	readonly header?: string;
	readonly omission?: string;
	readonly blocks: readonly RecoveryBlock[];
	readonly bare?: string;
};
function batchHeader(batch: RecoveryBatch | undefined): string | undefined {
	if (batch === undefined) {
		return undefined;
	}
	const call =
		batch.callId === undefined || batch.callId === ""
			? ""
			: ` Tool-call entry ${batch.callId}:`;
	return `Tool result evidence (current projected window; may already have been received or handled; not current progress).${call}`;
}
function planBatch(
	batch: RecoveryBatch | undefined,
	header: string | undefined,
	available: number,
): BatchPlan {
	if (batch === undefined || header === undefined) {
		return { blocks: [] };
	}
	let budget = available;
	let first = batch.blocks.length;
	while (first > 0) {
		const length = batch.blocks[first - 1].header.length + 2;
		if (length > budget) {
			break;
		}
		budget -= length;
		first--;
	}
	const blocks = batch.blocks.slice(first);
	const recovery =
		batch.callId === undefined || batch.callId === ""
			? "Use "
			: `Use history read with tool-call entry ${batch.callId}, then `;
	const omission =
		first > 0
			? `Omitted ${first} earlier tool result(s) whose headers could not fit. ${recovery}history search/read to recover them.`
			: undefined;
	return {
		header,
		omission,
		blocks,
		bare: joined([header, omission, ...blocks.map((block) => block.header)]),
	};
}
function renderBatch(
	plan: BatchPlan,
	fixedParts: readonly string[],
	prior: string | undefined,
	maxChars: number,
): string | undefined {
	if (plan.header === undefined || plan.bare === undefined || plan.bare === "") {
		return undefined;
	}
	const available = Math.max(
		0,
		maxChars -
			joined([...fixedParts, plan.bare, prior]).length -
			HANDOFF_OVERHEAD_RESERVE -
			plan.blocks.length,
	);
	const perBlock = Math.min(
		MAX_RECOVERY_RESULT_CHARS,
		Math.floor(available / plan.blocks.length),
	);
	return joined([
		plan.header,
		plan.omission,
		...plan.blocks.map((block) =>
			perBlock > 0 ? `${block.header}\n${excerpt(block.text, perBlock)}` : block.header,
		),
	]);
}
function renderIndex(records: readonly RecoveryRecord[], available: number): string | undefined {
	if (records.length === 0) {
		return undefined;
	}
	let budget = available;
	const listed: string[] = [];
	for (let i = records.length - 1; i >= 0; i--) {
		const line = indexLine(records[i]);
		if (line.length + 1 > budget) {
			break;
		}
		listed.unshift(line);
		budget -= line.length + 1;
	}
	const unlisted = records.length - listed.length;
	return [
		"Other current-window inputs, oldest first (recover with history read):",
		...(unlisted > 0
			? [`${unlisted} earlier input(s) not listed; use history search to find them.`]
			: []),
		...listed,
	].join("\n");
}
function selectedInputs(
	entries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	options: {
		readonly ownerQuestionRegistered: boolean;
		readonly retained: ReadonlySet<string>;
		readonly carried: readonly RecoveryRecord[];
	},
): { readonly fixed: readonly RecoveryRecord[]; readonly others: readonly RecoveryRecord[] } {
	const { ownerQuestionRegistered, retained, carried } = options;
	const current = projectedCurrent(entries, projected);
	const allRecords = ownerRecords(current, projected, ownerQuestionRegistered);
	const records = ownerRecords(
		projectedCurrent(entries, projected, undefined, retained),
		projected,
		ownerQuestionRegistered,
	);
	const { fixed, others } = anchors(records);
	if (!allRecords.some((record) => record.kind === "owner")) {
		fixed.unshift(
			...carried.map((record) =>
				Object.assign({}, record, {
					label: `${record.label}; carried from an earlier window, possibly already handled; not current progress`,
				}),
			),
		);
	}
	return { fixed, others };
}
function rolloverPreambleWithNotes(
	entries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	options: {
		readonly retained: ReadonlySet<string>;
		readonly reserveParts: readonly (string | undefined)[];
		readonly maxChars: number;
	},
): string {
	const { retained, reserveParts, maxChars } = options;
	const span = retainedSpanOf(entries.slice(contextStart(entries).start), retained);
	const basePreamble = buildRolloverPreamble(span);
	const reserveLen = joined([basePreamble, ...reserveParts]).length;
	const notesSection = renderSessionNotes(
		entries.slice(automaticChainStart(entries)),
		entries,
		projected,
		{
			retained,
			span,
			maxChars: Math.min(
				MAX_NOTES_SECTION_CHARS,
				Math.max(0, maxChars - reserveLen - HANDOFF_OVERHEAD_RESERVE),
			),
		},
	);
	return joined([basePreamble, notesSection]);
}
/** Raw owner anchors and projected tool evidence have distinct provenance and share one bounded payload. */
export function buildAutoHandoff(
	entries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	maxChars: number,
	options: {
		readonly ownerQuestionRegistered: boolean;
		readonly retainedEntryIds?: ReadonlySet<string>;
	},
): string {
	const { ownerQuestionRegistered, retainedEntryIds: retained = new Set<string>() } = options;
	const history = recoveryAncestry(entries, projected, ownerQuestionRegistered, retained);
	const priorWindow = history.checkpoint;
	const { fixed, others } = selectedInputs(entries, projected, {
		ownerQuestionRegistered,
		retained,
		carried: history.carried,
	});
	const emptyInputHeader =
		retained.size > 0
			? "No discarded owner or visible coordination inputs were selected for this recovery record."
			: "No selected current-window owner or visible coordination inputs were found.";
	const inputHeader =
		fixed.length > 0
			? "Selected owner and coordination inputs (chronological):"
			: emptyInputHeader;
	const batch = recoverableToolResults(projectedToolEntries(entries, projected, retained));
	const header = batchHeader(batch);
	const reserveParts = [
		inputHeader,
		...fixed.map((record) => formatRecord(record, 0)),
		header,
		priorCheckpoint(priorWindow, 0),
		skippedRecords(history.skipped, 0),
	];
	const preamble = rolloverPreambleWithNotes(entries, projected, {
		retained,
		reserveParts,
		maxChars,
	});
	const minimum = [preamble, ...reserveParts];
	const plan = planBatch(
		batch,
		header,
		Math.max(0, maxChars - joined(minimum).length - HANDOFF_OVERHEAD_RESERVE),
	);
	const handoff = windowHandoff(priorWindow)?.trim();
	const count =
		fixed.length +
		(handoff === undefined || handoff === "" ? 0 : 1) +
		(history.skipped.length > 0 ? 1 : 0);
	const fixedBudget = Math.max(
		0,
		maxChars - joined([preamble, inputHeader, plan.bare]).length - HANDOFF_OVERHEAD_RESERVE,
	);
	const fixedLimit =
		count > 0
			? Math.min(MAX_RECOVERY_RECORD_CHARS, Math.floor(fixedBudget / count))
			: MAX_RECOVERY_RECORD_CHARS;
	const prior = joined([
		priorCheckpoint(priorWindow, fixedLimit),
		skippedRecords(history.skipped, fixedLimit),
	]);
	const fixedParts = [
		preamble,
		inputHeader,
		...fixed.map((record) => formatRecord(record, fixedLimit)),
	];
	const renderedBatch = renderBatch(plan, fixedParts, prior, maxChars);
	const indexHeader = "Other current-window inputs, oldest first (recover with history read):";
	const available = Math.max(
		0,
		maxChars -
			joined([...fixedParts, indexHeader, renderedBatch, prior]).length -
			HANDOFF_OVERHEAD_RESERVE,
	);
	return joined([...fixedParts, renderIndex(others, available), renderedBatch, prior]);
}
