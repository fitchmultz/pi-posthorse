import type { PosthorseDisplay } from "../ui.ts";
import { pageCapacity } from "./budget.ts";
import {
	ESTIMATED_IMAGE_CHARS,
	MAX_PAGE_CHARS,
	MIN_PAGE_CHARS,
	PAGE_MARGIN_TOKENS,
	textResult,
	type ImageLike,
	type PolicyContext,
	type TextResult,
} from "./contracts.ts";

/** What else the page carries: images share the budget, and the header comes out of the body. */
export type PageRequest = {
	readonly imageCount?: number;
	readonly headerChars?: number;
};
export type NotesPage = {
	readonly rows: readonly string[];
	readonly offset: number;
	readonly kind: "notes-list" | "notes-search";
	readonly empty: string;
	readonly header?: string;
	/** Rows stop before the last match, so their joined length is only a lower bound. */
	readonly more?: boolean;
};
export type PageAccess = {
	readonly size: (ctx: PolicyContext, request?: PageRequest) => number;
	readonly result: (
		text: string,
		images: readonly ImageLike[],
		display: PosthorseDisplay,
	) => TextResult;
	readonly error: (ctx: PolicyContext, message: string) => never;
	readonly notes: (ctx: PolicyContext, page: NotesPage) => TextResult;
};
type PageAccounting = {
	readonly pendingTokens: number;
	readonly usage: number | null | undefined;
};
function reconcile(accounting: PageAccounting, usage: PageAccounting["usage"]): PageAccounting {
	// Native usage may already include serial results, but not parallel siblings.
	const counted =
		typeof usage === "number" && typeof accounting.usage === "number"
			? Math.max(0, usage - accounting.usage)
			: 0;
	return { pendingTokens: Math.max(0, accounting.pendingTokens - counted), usage };
}
/** Shared by note and history tools. Reservations precede delivery and reset at a turn boundary. */
export class PageReservations {
	private accounting: PageAccounting = { pendingTokens: 0, usage: undefined };
	private readonly toolTokens: () => number;
	constructor(toolTokens: () => number) {
		this.toolTokens = toolTokens;
	}
	reset(): void {
		this.accounting = { pendingTokens: 0, usage: undefined };
	}
	/**
	 * Body characters for the next page. Near the rollover line pages shrink to MIN_PAGE_CHARS
	 * instead of refusing, so reading keeps making progress; Pi's rollover handles the overshoot.
	 */
	size(ctx: PolicyContext, request: PageRequest = {}): number {
		this.settle(ctx);
		const remaining = pageCapacity(ctx, this.toolTokens) - this.accounting.pendingTokens;
		const budget = Math.min(
			MAX_PAGE_CHARS,
			Math.max(0, remaining - PAGE_MARGIN_TOKENS) * 4 -
				(request.imageCount ?? 0) * ESTIMATED_IMAGE_CHARS,
		);
		return Math.max(MIN_PAGE_CHARS, budget - (request.headerChars ?? 0));
	}
	private settle(ctx: PolicyContext): void {
		this.accounting = reconcile(this.accounting, ctx.getContextUsage()?.tokens);
	}
	private reserve(text: string, imageCount = 0): void {
		this.accounting = {
			...this.accounting,
			pendingTokens:
				this.accounting.pendingTokens +
				Math.ceil(text.length / 4) +
				imageCount * (ESTIMATED_IMAGE_CHARS / 4),
		};
	}
	result(text: string, images: readonly ImageLike[], display: PosthorseDisplay): TextResult {
		this.reserve(text, images.length);
		return textResult(text, images, display);
	}
	error(ctx: PolicyContext, message: string): never {
		this.settle(ctx);
		this.reserve(message);
		throw new Error(message);
	}
	notes(ctx: PolicyContext, page: NotesPage): TextResult {
		const { rows, offset, kind, empty, header = "", more } = page;
		const text = rows.length > 0 ? rows.join("\n") : empty;
		const chars = this.size(ctx, { headerChars: header.length });
		const footer = (end: number) =>
			`\n[chars ${offset}-${end}${more === true ? "; more matches follow" : ` of ${text.length}`}; continue with offset ${end}]`;
		if (offset > 0 && offset >= text.length) {
			this.error(ctx, "Offset is past the end; restart with offset 0.");
		}
		const range = notesRange(rows, {
			offset,
			end: Math.min(text.length, offset + chars),
			maxRows: kind === "notes-search" ? 20 : 100,
		});
		const end =
			range.end < text.length
				? Math.min(range.end, offset + chars - footer(text.length).length)
				: range.end;
		return this.result(
			header + text.slice(offset, end) + (end < text.length ? footer(end) : ""),
			[],
			{
				kind,
				headerLength: header.length,
				count: range.starts.filter((start) => start < end).length,
				page: { offset, end, total: text.length },
				...(more === true ? { more } : {}),
			},
		);
	}
}
function notesRange(
	rows: readonly string[],
	range: { readonly offset: number; readonly end: number; readonly maxRows: number },
): { end: number; starts: number[] } {
	let end = range.end;
	let start = 0;
	const starts: number[] = [];
	for (const row of rows) {
		if (start >= end) {
			break;
		}
		if (start + row.length > range.offset) {
			starts.push(start);
		}
		start += row.length + 1;
		if (starts.length === range.maxRows) {
			end = Math.min(end, start - 1);
			break;
		}
	}
	return { end, starts };
}
