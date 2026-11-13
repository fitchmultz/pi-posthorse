import {
	MIN_PAGE_CHARS,
	ESTIMATED_IMAGE_CHARS,
	type HistoryHit,
	type PolicyContext,
	type WindowedEntry,
} from "./contracts.ts";
import { textResult, type TextResult } from "./ui/display.ts";
import { excerpt, shortKey, sourceTag } from "./message-text.ts";
import { cursorFor as cursorAt } from "./history-cursor.ts";
import type { HistoryMatches, HistoryParams } from "./history-search.ts";
import type { PageAccess } from "./paging.ts";

type Continuation<Position> =
	| { readonly kind: "complete" }
	| { readonly kind: "more"; readonly next: Position };
type SearchPage = {
	readonly parts: readonly string[];
	readonly spans: readonly { readonly headerLength: number; readonly length: number }[];
	readonly continuation: Continuation<string>;
};
function searchFooter(next: string): string {
	return `\n[More results; continue with cursor "${next}" and the same query/scope.]`;
}
function hitFragment(
	hit: HistoryHit,
	cursor: HistoryMatches["cursor"],
	available: number,
	first: boolean,
):
	| {
			readonly part: string;
			readonly end: number;
			readonly headerLength: number;
	  }
	| undefined {
	const offset = cursor?.[0] === hit.id ? cursor[2] : 0;
	if (!first && hit.text.length - offset > available) {
		return undefined;
	}
	const prefix =
		offset > 0 || hit.text.length > available ? `[entry ${hit.id}; from char ${offset}] ` : "";
	if (prefix.length >= available) {
		return undefined;
	}
	const end = Math.min(hit.text.length, offset + available - prefix.length);
	return {
		part: prefix + hit.text.slice(offset, end),
		end,
		headerLength:
			prefix.length + Math.max(0, Math.min(hit.headerLength - offset, end - offset)),
	};
}
function searchParts(matches: HistoryMatches, chars: number): SearchPage {
	const parts: string[] = [];
	const spans: Array<{ headerLength: number; length: number }> = [];
	let available = chars;
	let continuation: Continuation<string> = { kind: "complete" };
	for (const hit of matches.hits) {
		const fragment = hitFragment(hit, matches.cursor, available, parts.length === 0);
		if (fragment === undefined) {
			break;
		}
		parts.push(fragment.part);
		spans.push({ headerLength: fragment.headerLength, length: fragment.part.length });
		available -= fragment.part.length + 1;
		continuation =
			fragment.end < hit.text.length || parts.length < matches.hits.length
				? { kind: "more", next: cursorAt(matches.key, hit, fragment.end) }
				: { kind: "complete" };
		if (available <= 0 || parts.length >= matches.limit) {
			break;
		}
	}
	return { parts, spans, continuation };
}
export function searchPage(
	matches: HistoryMatches,
	params: HistoryParams,
	host: PolicyContext,
	pages: PageAccess,
): TextResult {
	return pages.deliver(host, {}, (chars) => {
		const reserve = Math.max(
			0,
			...matches.hits.map(
				(hit) => searchFooter(cursorAt(matches.key, hit, hit.text.length)).length,
			),
		);
		if (reserve >= chars) {
			pages.error(host, "History entry id is too large for pagination.");
		}
		const skippedNote =
			matches.skipped > 0 && (params.cursor === undefined || params.cursor === "")
				? `\n[Skipped ${matches.skipped} match${matches.skipped === 1 ? "" : "es"} already in your active context.]`
				: "";
		const page = searchParts(matches, chars - reserve - skippedNote.length);
		const body =
			page.parts.length > 0
				? page.parts.join("\n")
				: `No history matches "${excerpt(params.query ?? "", 200)}".`;
		const tail =
			skippedNote +
			(page.continuation.kind === "more" ? searchFooter(page.continuation.next) : "");
		return textResult(body + tail, [], {
			kind: "history-search",
			entries: [...page.spans],
			footerLength: tail.length,
			more: page.continuation.kind === "more",
			skipped: matches.skipped,
		});
	});
}
function readOffsets(
	item: WindowedEntry,
	params: HistoryParams,
): { readonly offset: number; readonly imageOffset: number } {
	const offset = params.offset ?? 0;
	const imageOffset = params.imageOffset ?? (offset === 0 ? 0 : item.images.length);
	const id = params.id ?? "";
	if (imageOffset > item.images.length) {
		throw new Error(
			`Image offset ${imageOffset} is past the end of history entry "${id}" (${item.images.length} images).`,
		);
	}
	if (
		offset > item.text.length ||
		(offset === item.text.length && imageOffset === item.images.length)
	) {
		throw new Error(
			`Offset ${offset} is past the end of history entry "${id}" (${item.text.length} chars).`,
		);
	}
	return { offset, imageOffset };
}
function shownEntryId(item: WindowedEntry, id: string | undefined, source: string): string {
	return source === "" ? (id ?? "") : `${item.entry.id ?? "unknown"}@${shortKey(source)}`;
}
export function historyReadPage(
	item: WindowedEntry,
	params: HistoryParams,
	access: { readonly host: PolicyContext; readonly pages: PageAccess },
	source = "",
): TextResult {
	const shownId = shownEntryId(item, params.id, source);
	const { offset, imageOffset } = readOffsets(item, params);
	const firstImage = imageOffset < item.images.length ? 1 : 0;
	return access.pages.deliver(access.host, { imageCount: firstImage }, (chars) => {
		const imageEnd = Math.min(
			item.images.length,
			imageOffset + firstImage + Math.floor((chars - MIN_PAGE_CHARS) / ESTIMATED_IMAGE_CHARS),
		);
		const images = item.images.slice(imageOffset, imageEnd);
		const end = Math.min(
			item.text.length,
			offset + chars - (images.length - firstImage) * ESTIMATED_IMAGE_CHARS,
		);
		const continuation: Continuation<{
			readonly offset: number;
			readonly imageOffset: number;
		}> =
			end < item.text.length || imageEnd < item.images.length
				? { kind: "more", next: { offset: end, imageOffset: imageEnd } }
				: { kind: "complete" };
		const more =
			continuation.kind === "more"
				? `\nMore remains; call history read with id "${shownId}" and offset ${continuation.next.offset}${item.images.length > 0 ? ` and imageOffset ${continuation.next.imageOffset}` : ""}.`
				: "";
		const header = `${item.entry.timestamp ?? ""}${sourceTag(source)} [window ${item.windowId}] [${shownId}] [chars ${offset}-${end} of ${item.text.length}] `;
		return textResult(`${header}${item.text.slice(offset, end)}${more}`, images, {
			kind: "history-read",
			headerLength: header.length,
			offset,
			end,
			total: item.text.length,
			imageOffset,
			imageEnd,
			imageTotal: item.images.length,
		});
	});
}
