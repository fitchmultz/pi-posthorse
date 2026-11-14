import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { formatCount, type ImageLike, type Immutable } from "../contracts.ts";

const pageRangeSchema = Type.Object({
	offset: Type.Number(),
	end: Type.Number(),
	total: Type.Number(),
});
const historySpanSchema = Type.Object({
	headerLength: Type.Number(),
	length: Type.Number(),
});
const usageSchema = Type.Object({
	tokens: Type.Union([Type.Number(), Type.Null()]),
	contextWindow: Type.Number(),
	percent: Type.Union([Type.Number(), Type.Null()]),
});
/** The saved-result contract: one schema decides which display facts a renderer may trust. */
export const displaySchema = Type.Union([
	Type.Object({
		kind: Type.Literal("context"),
		usage: Type.Optional(usageSchema),
		rollover: Type.Optional(Type.Enum(["enabled", "disabled", "unsupported"])),
		rolloverAt: Type.Optional(Type.Number()),
	}),
	Type.Object({
		kind: Type.Enum(["notes-list", "notes-search"]),
		count: Type.Number(),
		headerLength: Type.Optional(Type.Number()),
		page: Type.Optional(pageRangeSchema),
		more: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		...pageRangeSchema.properties,
		kind: Type.Literal("note-read"),
		headerLength: Type.Optional(Type.Number()),
	}),
	Type.Object({
		kind: Type.Enum(["note-write", "note-append", "new-context"]),
	}),
	Type.Object({
		kind: Type.Literal("history-search"),
		entries: Type.Array(historySpanSchema),
		footerLength: Type.Optional(Type.Number()),
		more: Type.Optional(Type.Boolean()),
		skipped: Type.Optional(Type.Number()),
	}),
	Type.Object({
		...pageRangeSchema.properties,
		kind: Type.Literal("history-read"),
		headerLength: Type.Number(),
		imageOffset: Type.Optional(Type.Number()),
		imageEnd: Type.Optional(Type.Number()),
		imageTotal: Type.Optional(Type.Number()),
	}),
]);

export type PageRange = Immutable<Static<typeof pageRangeSchema>>;
export type HistorySpan = Immutable<Static<typeof historySpanSchema>>;
/** Display-only facts and offsets into content, never a second copy of a note or history page. */
export type PosthorseDisplay = Immutable<Static<typeof displaySchema>>;
export type TextResult = {
	content: Array<
		{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
	>;
	details: PosthorseDisplay | undefined;
};

export function textResult(
	text: string,
	images: readonly ImageLike[] = [],
	display?: PosthorseDisplay,
): TextResult {
	return { content: [{ type: "text", text }, ...images], details: display };
}

/** Saved sessions and streamed tool results can predate the display contract. */
export function displayOf(value: unknown): PosthorseDisplay | undefined {
	return Check(displaySchema, value) ? value : undefined;
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

export function pageSummary(page: PageRange, more = false): string {
	if (page.total === 0) {
		return "Empty note";
	}
	if (page.offset === 0 && page.end === page.total) {
		return `${formatCount(page.total)} chars · complete`;
	}
	return `Chars ${formatCount(page.offset)}–${formatCount(page.end)} of ${formatCount(page.total)}${more ? "+" : ""}${page.end < page.total ? `\nNext offset ${formatCount(page.end)}` : " · final page"}`;
}

function contextSummary(display: Extract<PosthorseDisplay, { readonly kind: "context" }>): string {
	const usage = display.usage;
	if (usage === undefined || usage.tokens === null) {
		return "Context usage unknown";
	}
	const configured = `≈${formatCount(Math.max(0, usage.contextWindow - usage.tokens))} tokens to configured context limit`;
	const rollover =
		display.rollover === "enabled" && display.rolloverAt !== undefined
			? `≈${formatCount(Math.max(0, display.rolloverAt - usage.tokens))} tokens to rollover`
			: `Automatic rollover ${display.rollover ?? "unknown"}`;
	return `${rollover}\n${configured}\n≈${formatCount(usage.tokens)} / ${formatCount(usage.contextWindow)} used${usage.percent === null ? "" : ` (≈${Math.round(usage.percent)}%)`}`;
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
	const summary = `${pageSummary(display).split("\n", 1).join("")}\nImages ${formatCount(display.imageOffset ?? 0)}–${formatCount(display.imageEnd)} of ${formatCount(display.imageTotal)}`;
	return display.end < display.total || display.imageEnd < display.imageTotal
		? `Next offset ${formatCount(display.end)}\nimageOffset ${formatCount(display.imageEnd)}\n${summary}`
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
	return `${display.entries.length > 0 ? `${formatCount(display.entries.length)} matches` : "No matches"} · ${all ? "all sessions" : "current branch"}${skipped > 0 ? ` · ${formatCount(skipped)} in context skipped` : ""}${more ? "\nMore results; continue with cursor" : ""}`;
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
				? `${formatCount(display.count)} note${display.count === 1 ? "" : "s"} returned`
				: "No notes yet";
		case "notes-search":
			return display.count > 0
				? `${formatCount(display.count)} matches returned`
				: "No matches";
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
