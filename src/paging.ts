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

export type PageRequest = {
	readonly offset: number;
	readonly imageCount?: number;
	readonly cursor?: string;
	readonly imageOffset?: number;
};
export type NotesPage = {
	readonly rows: readonly string[];
	readonly offset: number;
	readonly kind: "notes-list" | "notes-search";
	readonly empty: string;
	readonly header?: string;
};
export type PageAccess = {
	readonly size: (ctx: PolicyContext, request: PageRequest) => number;
	readonly result: (
		text: string,
		images: readonly ImageLike[],
		display: PosthorseDisplay,
	) => TextResult;
	readonly error: (ctx: PolicyContext, message: string, cursor?: string) => never;
	readonly notes: (ctx: PolicyContext, page: NotesPage) => TextResult;
};
/** Shared by note and history tools. Reservations precede delivery and reset at a turn boundary. */
export class PageReservations {
	private pendingTokens = 0;
	private previousUsage: number | null | undefined;
	private readonly toolTokens: () => number;
	constructor(toolTokens: () => number) {
		this.toolTokens = toolTokens;
	}
	reset(): void {
		this.pendingTokens = 0;
		this.previousUsage = undefined;
	}
	size(ctx: PolicyContext, request: PageRequest): number {
		const usage = ctx.getContextUsage()?.tokens;
		// Native usage may already include serial results, but not parallel siblings.
		if (
			usage !== undefined &&
			usage !== null &&
			this.previousUsage !== undefined &&
			this.previousUsage !== null
		) {
			this.pendingTokens = Math.max(
				0,
				this.pendingTokens - Math.max(0, usage - this.previousUsage),
			);
		}
		this.previousUsage = usage;
		const remaining = pageCapacity(ctx, this.toolTokens()) - this.pendingTokens;
		const chars = Math.min(
			MAX_PAGE_CHARS,
			Math.max(0, remaining - PAGE_MARGIN_TOKENS) * 4 -
				(request.imageCount ?? 0) * ESTIMATED_IMAGE_CHARS,
		);
		if (chars < MIN_PAGE_CHARS) {
			this.refuse(remaining, request);
		}
		return chars;
	}
	private refuse(remaining: number, request: PageRequest): never {
		const position =
			request.cursor !== undefined && request.cursor !== ""
				? "with the same cursor"
				: `with offset ${request.offset}${request.imageOffset === undefined ? "" : ` and imageOffset ${request.imageOffset}`}`;
		const message = `Too little context remains to read a page safely. Call new_context first, then retry ${position}.`;
		// Even refusals consume context; omit repeated guidance when it no longer fits.
		const text = Math.ceil(message.length / 4) <= remaining ? message : "";
		this.pendingTokens += Math.ceil(text.length / 4);
		throw new Error(text);
	}
	result(text: string, images: readonly ImageLike[], display: PosthorseDisplay): TextResult {
		this.pendingTokens +=
			Math.ceil(text.length / 4) + images.length * (ESTIMATED_IMAGE_CHARS / 4);
		return textResult(text, images, display);
	}
	error(ctx: PolicyContext, message: string, cursor?: string): never {
		this.size(ctx, { offset: 0, cursor });
		this.pendingTokens += Math.ceil(message.length / 4);
		throw new Error(message);
	}
	notes(ctx: PolicyContext, page: NotesPage): TextResult {
		const { rows, offset, kind, empty, header = "" } = page;
		const text = rows.length > 0 ? rows.join("\n") : empty;
		const chars = this.size(ctx, { offset }) - header.length;
		const footer = (end: number) =>
			`\n[chars ${offset}-${end} of ${text.length}; continue with offset ${end}]`;
		if (chars <= footer(text.length).length) {
			this.error(
				ctx,
				`Too little context remains to include the notes path. Call new_context first, then retry with offset ${offset}.`,
			);
		}
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
