import { isAbsolute } from "node:path";
import { contextStart } from "./boundary.ts";
import {
	isRecord,
	optionalString,
	presentText,
	unknownArray,
	type EntryLike,
	type ProjectedEntry,
	type ToolCallLike,
} from "./contracts.ts";
import { contextEdits } from "./history-entries.ts";
import { contentText, toolCalls } from "./message-text.ts";

export type Supersession = { readonly byEntryId: string; readonly inRetainedTail: boolean };
type ActiveEntry = {
	readonly index: number;
	readonly effectiveId: string;
	readonly inRetainedTail: boolean;
	readonly entry: EntryLike;
};
type StartMetadata = { readonly command?: string | undefined; readonly cwd?: string | undefined };
type JobBuilder = {
	readonly id: string;
	command?: string | undefined;
	cwd?: string | undefined;
	commandPreview?: string | undefined;
	outputTail: string;
};
type JobKeys = ReadonlySet<string>;
type SupersederIndex = {
	readonly jobsByIndex: Map<number, readonly JobKeys[]>;
	readonly bgTargetLatest: Map<string, ActiveEntry>;
	readonly escalationLatest: Map<string, ActiveEntry>;
	readonly completionLatest: Map<string, ActiveEntry>;
};

const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out", "unknown"]);
const ESCALATION_ACTIONS = new Set(["continue", "review", "stop"]);
const WATCH_PR_VALUE_FLAGS = new Set([
	"--repo",
	"-R",
	"--timeout",
	"--interval",
	"--sha",
	"--config",
]);
const SHELL_OPERATORS = new Set(["&&", "||", ";", "|"]);
const WATCH_PR_INVOCATION = /(?:^|[\s'"/])watch-pr(?:\.mjs)?(?=$|[\s'"])/u;
const WATCH_PR_TAIL_LINE = /^pr: https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)\r?$/gmu;
const WATCH_PR_URL =
	/https:\/\/github\.com\/([^/\s'"]+)\/([^/\s'"]+)\/pull\/(\d+)(?=$|[\s'"/#?])/giu;
const stripQuotes = (token: string): string => token.replace(/^['"]+|['"]+$/gu, "");
function appendSection(base: string, extra: string): string {
	if (base === "") {
		return extra;
	}
	return extra === "" ? base : `${base}\n\n${extra}`;
}

function parseJsonObject(text: string): Readonly<Record<string, unknown>> | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}
function uniqueWatchPrKey(matches: Iterable<RegExpExecArray>): string | undefined {
	const keys = new Set(
		[...matches].flatMap(([, owner, repo, num]) =>
			owner !== undefined && repo !== undefined && num !== undefined
				? [`watch-pr:${owner.toLowerCase()}/${repo.toLowerCase()}#${num}`]
				: [],
		),
	);
	return keys.size === 1 ? [...keys][0] : undefined;
}
const parseRepoPair = (raw: string | undefined): readonly [string, string] | undefined => {
	const match = raw === undefined ? null : /^([^/\s]+)\/([^/\s]+)$/u.exec(raw);
	return match?.[1] !== undefined && match[2] !== undefined ? [match[1], match[2]] : undefined;
};
function parseRepoFlag(tokens: readonly string[], index: number) {
	const token = tokens[index];
	if (token === "--repo" || token === "-R") {
		return { repo: parseRepoPair(tokens[index + 1]), advance: 1 };
	}
	if (token?.startsWith("--repo=") === true) {
		return { repo: parseRepoPair(stripQuotes(token.slice(7))), advance: 0 };
	}
	return;
}
function scanWatchPrTokens(tokens: readonly string[]): {
	readonly repo?: readonly [string, string] | undefined;
	readonly num?: string | undefined;
} {
	let repo: readonly [string, string] | undefined;
	const numbers: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		const flag = parseRepoFlag(tokens, index);
		if (flag !== undefined) {
			repo = flag.repo;
			index += flag.advance;
		} else if (WATCH_PR_VALUE_FLAGS.has(token)) {
			index++;
		} else if (/^\d+$/u.test(token)) {
			numbers.push(token);
		}
	}
	return { repo, num: numbers.length === 1 ? numbers[0] : undefined };
}
function parseWatchPrRepoAndNumber(after: string, mayBeTruncated: boolean): string | undefined {
	const raw = after.match(/&&|\|\||[;|]|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/gu) ?? [];
	const stop = raw.findIndex((token) => SHELL_OPERATORS.has(token));
	const { repo, num } = scanWatchPrTokens((stop < 0 ? raw : raw.slice(0, stop)).map(stripQuotes));
	if (repo === undefined || num === undefined || (mayBeTruncated && after.endsWith(num))) {
		return undefined;
	}
	return `watch-pr:${repo[0].toLowerCase()}/${repo[1].toLowerCase()}#${num}`;
}
function watchPrFromCommand(command: string, mayBeTruncated: boolean): string | undefined {
	const match = WATCH_PR_INVOCATION.exec(command);
	if (match === null) {
		return undefined;
	}
	const after = command.slice(match.index + match[0].length);
	const urlMatches = [...after.matchAll(WATCH_PR_URL)];
	if (mayBeTruncated && urlMatches.some((item) => item.index + item[0].length === after.length)) {
		return undefined;
	}
	return uniqueWatchPrKey(urlMatches) ?? parseWatchPrRepoAndNumber(after, mayBeTruncated);
}
function isPlainToolResult(entry: EntryLike, toolName: string): boolean {
	return (
		entry.type === "message" &&
		entry.message?.role === "toolResult" &&
		entry.message.toolName === toolName &&
		entry.message.namespace === undefined &&
		entry.message.isError !== true
	);
}
function callArgs(
	entry: EntryLike,
	calls: ReadonlyMap<string, ToolCallLike>,
): Readonly<Record<string, unknown>> | undefined {
	const callId = optionalString(entry.message?.toolCallId);
	const call = callId === undefined ? undefined : calls.get(callId);
	return isRecord(call?.arguments) ? call.arguments : undefined;
}
function backgroundToolContext(entry: EntryLike, calls: ReadonlyMap<string, ToolCallLike>) {
	const rawDetails = entry.message?.details;
	const details = isRecord(rawDetails)
		? rawDetails
		: parseJsonObject(contentText(entry.message?.content));
	const args = callArgs(entry, calls);
	return {
		details,
		args,
		action: optionalString(args?.action) ?? optionalString(details?.action),
	};
}
const absoluteText = (value: unknown): string | undefined => {
	const text = presentText(value);
	return text !== undefined && isAbsolute(text) ? text : undefined;
};
const isStartAction = (
	action: string | undefined,
	details: Readonly<Record<string, unknown>> | undefined,
): boolean => action === "start" || (action === undefined && details?.status === "starting");
function startRecordFromEntry(
	entry: EntryLike,
	calls: ReadonlyMap<string, ToolCallLike>,
): readonly [string, StartMetadata] | undefined {
	const { details, args, action } = backgroundToolContext(entry, calls);
	const jobId = presentText(details?.id);
	if (jobId === undefined || !isStartAction(action, details)) {
		return undefined;
	}
	return [
		jobId,
		{
			command: presentText(details?.command) ?? presentText(args?.command),
			cwd: presentText(details?.cwd) ?? absoluteText(args?.cwd),
		},
	];
}
function mergeJobDetails(
	builders: Map<string, JobBuilder>,
	raw: Readonly<Record<string, unknown>>,
	outputTail: string,
): string | undefined {
	const id = presentText(raw.id);
	if (id === undefined) {
		return undefined;
	}
	const next: JobBuilder = builders.get(id) ?? { id, outputTail: "" };
	next.command = presentText(raw.command) ?? next.command;
	next.cwd = presentText(raw.cwd) ?? next.cwd;
	next.commandPreview = presentText(raw.commandPreview) ?? next.commandPreview;
	next.outputTail = appendSection(next.outputTail, outputTail);
	builders.set(id, next);
	return id;
}
function parseContentJobBlocks(builders: Map<string, JobBuilder>, text: string): void {
	let currentJobId: string | undefined;
	for (const block of text
		.replace(/^Background commands finished:\r?\n/u, "")
		.split(/\r?\n\r?\n/u)) {
		if (block.trim() === "") {
			continue;
		}
		const nl = block.indexOf("\n");
		const parsed = parseJsonObject(nl < 0 ? block : block.slice(0, nl));
		const mergedId =
			parsed === undefined
				? undefined
				: mergeJobDetails(builders, parsed, nl < 0 ? "" : block.slice(nl + 1));
		if (mergedId !== undefined) {
			currentJobId = mergedId;
		} else if (currentJobId !== undefined) {
			const current = builders.get(currentJobId);
			if (current !== undefined) {
				current.outputTail = appendSection(current.outputTail, block);
			}
		}
	}
}
function watchPrKeyForJob(
	builder: JobBuilder,
	start: StartMetadata | undefined,
): string | undefined {
	const fromTail = uniqueWatchPrKey(builder.outputTail.matchAll(WATCH_PR_TAIL_LINE));
	if (fromTail !== undefined) {
		return fromTail;
	}
	const fullCommand = start?.command ?? builder.command;
	const fromFull = fullCommand === undefined ? undefined : watchPrFromCommand(fullCommand, false);
	if (fromFull !== undefined) {
		return fromFull;
	}
	const preview = builder.commandPreview;
	return preview === undefined ? undefined : watchPrFromCommand(preview, preview.length >= 160);
}
function jobTargetKeys(builder: JobBuilder, start: StartMetadata | undefined): ReadonlySet<string> {
	const keys = new Set<string>([`job:${builder.id}`]);
	const watchPr = watchPrKeyForJob(builder, start);
	if (watchPr !== undefined) {
		keys.add(watchPr);
	}
	const startCommand = start?.command?.trim();
	if (startCommand !== undefined && startCommand !== "" && start?.cwd !== undefined) {
		keys.add(`cmd:${start.cwd}\0${startCommand}`);
	}
	return keys;
}
function parseBackgroundCompleteJobs(
	entry: EntryLike,
	starts: ReadonlyMap<string, StartMetadata>,
): readonly JobKeys[] {
	const builders = new Map<string, JobBuilder>();
	for (const item of isRecord(entry.details) ? (unknownArray(entry.details.jobs) ?? []) : []) {
		if (isRecord(item)) {
			mergeJobDetails(builders, item, "");
		}
	}
	parseContentJobBlocks(builders, contentText(entry.content));
	return [...builders.values()].map((builder) => jobTargetKeys(builder, starts.get(builder.id)));
}
function applyContextEdit(entry: EntryLike, edit: EntryLike | undefined): EntryLike {
	if (edit?.replacement === undefined || edit.replacement === null) {
		return entry;
	}
	if (entry.type === "message") {
		return { ...entry, message: { ...entry.message, content: edit.replacement.content } };
	}
	return entry.type === "custom_message"
		? { ...entry, content: edit.replacement.content }
		: entry;
}
function recordTerminalJobs(
	details: Readonly<Record<string, unknown>>,
	item: ActiveEntry,
	bgTargetLatest: Map<string, ActiveEntry>,
): void {
	for (const raw of unknownArray(details.jobs) ?? [details]) {
		if (!isRecord(raw)) {
			continue;
		}
		const id = presentText(raw.id);
		const status = optionalString(raw.status);
		if (id !== undefined && status !== undefined && TERMINAL_JOB_STATUSES.has(status)) {
			bgTargetLatest.set(`job:${id}`, item);
		}
	}
}
function recordBackgroundToolSuperseder(
	item: ActiveEntry,
	calls: ReadonlyMap<string, ToolCallLike>,
	bgTargetLatest: Map<string, ActiveEntry>,
): void {
	const { details, args, action } = backgroundToolContext(item.entry, calls);
	if (action === "start") {
		const command = presentText(details?.command) ?? presentText(args?.command);
		const watchPr = command === undefined ? undefined : watchPrFromCommand(command, false);
		if (watchPr !== undefined) {
			bgTargetLatest.set(watchPr, item);
		}
		return;
	}
	if (details !== undefined && (action === "status" || action === "cancel")) {
		recordTerminalJobs(details, item, bgTargetLatest);
	}
}
function recordAgentRunsSuperseder(
	item: ActiveEntry,
	calls: ReadonlyMap<string, ToolCallLike>,
	index: SupersederIndex,
): void {
	const args = callArgs(item.entry, calls);
	const runId = presentText(args?.id);
	const action = optionalString(args?.action);
	if (runId === undefined || action === undefined) {
		return;
	}
	if (ESCALATION_ACTIONS.has(action)) {
		index.escalationLatest.set(runId, item);
	}
	if (action === "continue" || (action === "review" && args?.verdict === "changes_requested")) {
		index.completionLatest.set(runId, item);
	}
}
function recordCustomSuperseder(
	item: ActiveEntry,
	starts: ReadonlyMap<string, StartMetadata>,
	index: SupersederIndex,
): void {
	const { entry } = item;
	if (entry.customType === "background-command-complete") {
		const jobs = parseBackgroundCompleteJobs(entry, starts);
		index.jobsByIndex.set(item.index, jobs);
		for (const keys of jobs) {
			for (const key of keys) {
				index.bgTargetLatest.set(key, item);
			}
		}
		return;
	}
	const runId = isRecord(entry.details) ? presentText(entry.details.id) : undefined;
	if (runId === undefined) {
		return;
	}
	if (entry.customType === "agent-completion") {
		index.escalationLatest.set(runId, item);
		index.completionLatest.set(runId, item);
	} else if (entry.customType === "agent-escalation") {
		index.escalationLatest.set(runId, item);
	}
}
function newerEntry(
	current: ActiveEntry | undefined,
	candidate: ActiveEntry | undefined,
	afterIndex: number,
): ActiveEntry | undefined {
	if (candidate === undefined || candidate.index <= afterIndex) {
		return current;
	}
	return current === undefined || candidate.index > current.index ? candidate : current;
}
function latestSupersederForBatch(
	item: ActiveEntry,
	jobs: readonly JobKeys[],
	bgTargetLatest: ReadonlyMap<string, ActiveEntry>,
): ActiveEntry | undefined {
	let winner: ActiveEntry | undefined;
	for (const keys of jobs) {
		let bestForJob: ActiveEntry | undefined;
		for (const key of keys) {
			bestForJob = newerEntry(bestForJob, bgTargetLatest.get(key), item.index);
		}
		if (bestForJob === undefined) {
			return undefined;
		}
		winner = newerEntry(winner, bestForJob, item.index);
	}
	return winner;
}
function latestRunSuperseder(entry: EntryLike, index: SupersederIndex): ActiveEntry | undefined {
	const runId = isRecord(entry.details) ? presentText(entry.details.id) : undefined;
	if (runId === undefined) {
		return undefined;
	}
	if (entry.customType === "agent-escalation") {
		return index.escalationLatest.get(runId);
	}
	return entry.customType === "agent-completion" ? index.completionLatest.get(runId) : undefined;
}
function supersederForEntry(item: ActiveEntry, index: SupersederIndex): ActiveEntry | undefined {
	const { entry } = item;
	if (entry.type !== "custom_message" || entry.display !== true) {
		return undefined;
	}
	if (entry.customType === "background-command-complete") {
		return latestSupersederForBatch(
			item,
			index.jobsByIndex.get(item.index) ?? [],
			index.bgTargetLatest,
		);
	}
	const candidate = latestRunSuperseder(entry, index);
	return candidate !== undefined && candidate.index > item.index ? candidate : undefined;
}
function indexActive(
	active: readonly ActiveEntry[],
	calls: ReadonlyMap<string, ToolCallLike>,
	starts: ReadonlyMap<string, StartMetadata>,
): SupersederIndex {
	const index: SupersederIndex = {
		jobsByIndex: new Map(),
		bgTargetLatest: new Map(),
		escalationLatest: new Map(),
		completionLatest: new Map(),
	};
	for (const item of active) {
		if (item.entry.type === "custom_message") {
			recordCustomSuperseder(item, starts, index);
		} else if (isPlainToolResult(item.entry, "background_command")) {
			recordBackgroundToolSuperseder(item, calls, index.bgTargetLatest);
		} else if (isPlainToolResult(item.entry, "agent_runs")) {
			recordAgentRunsSuperseder(item, calls, index);
		}
	}
	return index;
}
export function supersededCoordinationMap(
	entries: readonly EntryLike[],
	projected: readonly ProjectedEntry[],
	options: {
		readonly retained: ReadonlySet<string>;
		readonly currentWindow?: readonly EntryLike[] | undefined;
	},
): ReadonlyMap<string, Supersession> {
	const edits = contextEdits(entries);
	const excluded = new Set([
		...projected
			.filter(({ messages }) => messages.length === 0)
			.map(({ sourceEntry }) => sourceEntry.id ?? ""),
		...[...edits].filter(([, edit]) => edit.replacement === null).map(([id]) => id),
	]);
	excluded.delete("");
	const calls = new Map(
		entries.flatMap((entry) =>
			entry.type === "message" && entry.message?.role === "assistant"
				? toolCalls(entry.message.content).flatMap((call) =>
						call.id !== undefined && call.id !== "" ? [[call.id, call] as const] : [],
					)
				: [],
		),
	);
	const starts = new Map(
		entries.flatMap((entry) => {
			const pair =
				excluded.has(entry.id ?? "") || !isPlainToolResult(entry, "background_command")
					? undefined
					: startRecordFromEntry(entry, calls);
			return pair === undefined ? [] : [pair];
		}),
	);
	const currentWindow = options.currentWindow ?? entries.slice(contextStart(entries).start);
	const active = currentWindow
		.filter((entry) => entry.id !== undefined && entry.id !== "" && !excluded.has(entry.id))
		.map((entry, index): ActiveEntry => {
			const sourceId = entry.id ?? "";
			const edit = edits.get(sourceId);
			return {
				index,
				effectiveId: edit?.id ?? sourceId,
				inRetainedTail: options.retained.has(sourceId),
				entry: applyContextEdit(entry, edit),
			};
		});
	const index = indexActive(active, calls, starts);
	const result = new Map<string, Supersession>();
	for (const item of active) {
		const winner = supersederForEntry(item, index);
		if (winner !== undefined) {
			result.set(item.effectiveId, {
				byEntryId: winner.effectiveId.slice(0, 120),
				inRetainedTail: winner.inRetainedTail,
			});
		}
	}
	return result;
}
