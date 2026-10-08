import { isRecord } from "./text.ts";

export interface PageRange {
	readonly offset: number;
	readonly end: number;
	readonly total: number;
}

export interface HistorySpan {
	readonly headerLength: number;
	readonly length: number;
}

/** Display-only facts and offsets into content, never a second copy of a note or history page. */
export type PosthorseDisplay =
	| {
			readonly kind: "context";
			readonly usage?: {
				readonly tokens: number | null;
				readonly contextWindow: number;
				readonly percent: number | null;
			};
			readonly rollover?: "enabled" | "disabled" | "unsupported";
			readonly rolloverAt?: number;
	  }
	| {
			readonly kind: "notes-list" | "notes-search";
			readonly count: number;
			readonly headerLength?: number;
			readonly page?: PageRange;
			/** More matches follow; `page.total` counts only those found so far. */
			readonly more?: boolean;
	  }
	| ({ readonly kind: "note-read"; readonly headerLength?: number } & PageRange)
	| { readonly kind: "note-write" | "note-append" | "new-context" }
	| {
			readonly kind: "history-search";
			readonly entries: readonly HistorySpan[];
			readonly footerLength?: number;
			readonly more?: boolean;
			readonly skipped?: number;
	  }
	| ({
			readonly kind: "history-read";
			readonly headerLength: number;
			readonly imageOffset?: number;
			readonly imageEnd?: number;
			readonly imageTotal?: number;
	  } & PageRange);

function optionalNumbers(
	value: Readonly<Record<string, unknown>>,
	keys: readonly string[],
): boolean {
	return keys.every((key) => value[key] === undefined || typeof value[key] === "number");
}

function isPage(value: unknown): value is PageRange {
	return (
		isRecord(value) &&
		typeof value.offset === "number" &&
		typeof value.end === "number" &&
		typeof value.total === "number"
	);
}

function isSpan(value: unknown): value is HistorySpan {
	return (
		isRecord(value) &&
		typeof value.headerLength === "number" &&
		typeof value.length === "number"
	);
}

function isContextDisplay(value: Readonly<Record<string, unknown>>): boolean {
	const usage = value.usage;
	const validUsage = usage === undefined || isUsage(usage);
	return (
		validUsage &&
		optionalNumbers(value, ["rolloverAt"]) &&
		(value.rollover === undefined ||
			value.rollover === "enabled" ||
			value.rollover === "disabled" ||
			value.rollover === "unsupported")
	);
}

function isUsage(value: unknown): boolean {
	return (
		isRecord(value) &&
		(value.tokens === null || typeof value.tokens === "number") &&
		typeof value.contextWindow === "number" &&
		(value.percent === null || typeof value.percent === "number")
	);
}

function isSearchDisplay(value: Readonly<Record<string, unknown>>): boolean {
	return (
		Array.isArray(value.entries) &&
		value.entries.every(isSpan) &&
		optionalNumbers(value, ["footerLength", "skipped"]) &&
		(value.more === undefined || typeof value.more === "boolean")
	);
}

function isNotesDisplay(value: Readonly<Record<string, unknown>>): boolean {
	return (
		typeof value.count === "number" &&
		optionalNumbers(value, ["headerLength"]) &&
		(value.page === undefined || isPage(value.page)) &&
		(value.more === undefined || typeof value.more === "boolean")
	);
}

function isDisplay(value: unknown): value is PosthorseDisplay {
	if (!isRecord(value)) {
		return false;
	}
	switch (value.kind) {
		case "context":
			return isContextDisplay(value);
		case "notes-list":
		case "notes-search":
			return isNotesDisplay(value);
		case "note-read":
			return isPage(value) && optionalNumbers(value, ["headerLength"]);
		case "history-read":
			return (
				isPage(value) &&
				typeof value.headerLength === "number" &&
				optionalNumbers(value, ["imageOffset", "imageEnd", "imageTotal"])
			);
		case "history-search":
			return isSearchDisplay(value);
		case "note-write":
		case "note-append":
		case "new-context":
			return true;
		default:
			return false;
	}
}

/** Saved sessions and streamed tool results can predate the display contract. */
export function displayOf(value: unknown): PosthorseDisplay | undefined {
	return isDisplay(value) ? value : undefined;
}

export interface HistorySection {
	readonly body: string;
	readonly header: string;
}

function spansOf(
	raw: string,
	display: PosthorseDisplay | undefined,
): readonly HistorySpan[] | undefined {
	if (display?.kind === "history-search") {
		return display.entries;
	}
	if (display?.kind === "history-read") {
		return [{ headerLength: display.headerLength, length: raw.length }];
	}
	return undefined;
}

export function historySections(
	raw: string,
	display: PosthorseDisplay | undefined,
): readonly HistorySection[] | undefined {
	const spans = spansOf(raw, display);
	if (spans === undefined || spans.length === 0) {
		return undefined;
	}
	const footerLength = display?.kind === "history-search" ? (display.footerLength ?? 0) : 0;
	if (!validFooter(footerLength, raw.length)) {
		return undefined;
	}
	const bodyLength = raw.length - footerLength;
	let start = 0;
	const sections: HistorySection[] = [];
	for (const span of spans) {
		if (!validSpan(span, start, bodyLength)) {
			return undefined;
		}
		sections.push({
			header: raw.slice(start, start + span.headerLength).trimEnd(),
			body: raw.slice(start + span.headerLength, start + span.length),
		});
		start += span.length + 1;
	}
	return start === bodyLength + 1 ? sections : undefined;
}

function validFooter(length: number, rawLength: number): boolean {
	return Number.isInteger(length) && length >= 0 && length <= rawLength;
}

function validSpan(span: HistorySpan, start: number, bodyLength: number): boolean {
	return (
		Number.isInteger(span.headerLength) &&
		Number.isInteger(span.length) &&
		span.headerLength >= 0 &&
		span.headerLength <= span.length &&
		start + span.length <= bodyLength
	);
}

const n = (value: number): string => value.toLocaleString("en-US");

export function pageSummary(page: PageRange, more = false): string {
	if (page.total === 0) {
		return "Empty note";
	}
	if (page.offset === 0 && page.end === page.total) {
		return `${n(page.total)} chars · complete`;
	}
	return `Chars ${n(page.offset)}–${n(page.end)} of ${n(page.total)}${more ? "+" : ""}${page.end < page.total ? `\nNext offset ${n(page.end)}` : " · final page"}`;
}

function contextSummary(display: Extract<PosthorseDisplay, { readonly kind: "context" }>): string {
	const usage = display.usage;
	if (usage === undefined || usage.tokens === null) {
		return "Context usage unknown";
	}
	const configured = `≈${n(Math.max(0, usage.contextWindow - usage.tokens))} tokens to configured context limit`;
	const rollover =
		display.rollover === "enabled" && display.rolloverAt !== undefined
			? `≈${n(Math.max(0, display.rolloverAt - usage.tokens))} tokens to rollover`
			: `Automatic rollover ${display.rollover ?? "unknown"}`;
	return `${rollover}\n${configured}\n≈${n(usage.tokens)} / ${n(usage.contextWindow)} used${usage.percent === null ? "" : ` (≈${Math.round(usage.percent)}%)`}`;
}

function historyReadSummary(
	display: Extract<PosthorseDisplay, { readonly kind: "history-read" }>,
): string {
	if (
		display.imageTotal === undefined ||
		display.imageTotal === 0 ||
		display.imageEnd === undefined
	) {
		return pageSummary(display);
	}
	const summary = `${pageSummary(display).split("\n")[0]}\nImages ${n(display.imageOffset ?? 0)}–${n(display.imageEnd)} of ${n(display.imageTotal)}`;
	return display.end < display.total || display.imageEnd < display.imageTotal
		? `Next offset ${n(display.end)}\nimageOffset ${n(display.imageEnd)}\n${summary}`
		: summary;
}

function historySearchSummary(
	display: Extract<PosthorseDisplay, { readonly kind: "history-search" }>,
	all: boolean,
	validSections: boolean,
): string {
	if (display.entries.length > 0 && !validSections) {
		return "";
	}
	const skipped = display.skipped ?? 0;
	const more = display.more ?? (display.footerLength ?? 0) > 0;
	return `${display.entries.length > 0 ? `${n(display.entries.length)} matches` : "No matches"} · ${all ? "all sessions" : "current branch"}${skipped > 0 ? ` · ${n(skipped)} in context skipped` : ""}${more ? "\nMore results; continue with cursor" : ""}`;
}

export function displaySummary(
	display: PosthorseDisplay | undefined,
	args: Readonly<Record<string, unknown>>,
	validSections: boolean,
): string {
	switch (display?.kind) {
		case "context":
			return contextSummary(display);
		case "notes-list":
			return display.count > 0
				? `${n(display.count)} note${display.count === 1 ? "" : "s"} returned`
				: "No notes yet";
		case "notes-search":
			return display.count > 0 ? `${n(display.count)} matches returned` : "No matches";
		case "note-read":
			return pageSummary(display);
		case "note-write":
			return args.content === "" ? "Cleared note" : "Saved note";
		case "note-append":
			return "Appended to note";
		case "history-search":
			return historySearchSummary(display, args.all === true, validSections);
		case "history-read":
			return historyReadSummary(display);
		case "new-context":
			return "Requested after foreground tools succeed.\nBackground work continues.";
		case undefined:
			return "";
	}
}

export function summaryOnly(display: PosthorseDisplay | undefined): boolean {
	switch (display?.kind) {
		case "context":
		case "new-context":
		case "note-write":
		case "note-append":
			return true;
		case "notes-list":
		case "notes-search":
			return display.count === 0;
		case "note-read":
			return display.total === 0;
		case "history-search":
			return display.entries.length === 0;
		case "history-read":
		case undefined:
			return false;
	}
}
