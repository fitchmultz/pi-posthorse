import {
	MIN_PAGE_CHARS,
	ESTIMATED_IMAGE_CHARS,
	type HistoryHit,
	type PolicyContext,
	type TextResult,
	type WindowedEntry,
} from "./contracts.ts";
import { excerpt, shortKey, sourceTag } from "./message-text.ts";
import type { HistoryMatches, HistoryParams } from "./history-search.ts";
import type { PageAccess } from "./paging.ts";

type SearchPage = {
	readonly parts: readonly string[];
	readonly spans: readonly { readonly headerLength: number; readonly length: number }[];
	readonly next?: string;
};
function cursorFor(matches: HistoryMatches, hit: HistoryHit, offset: number): string {
	return Buffer.from(JSON.stringify([hit.id, hit.priority, offset, matches.key])).toString(
		"base64url",
	);
}
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
	let next: string | undefined;
	for (const hit of matches.hits) {
		const fragment = hitFragment(hit, matches.cursor, available, parts.length === 0);
		if (fragment === undefined) {
			break;
		}
		parts.push(fragment.part);
		spans.push({ headerLength: fragment.headerLength, length: fragment.part.length });
		available -= fragment.part.length + 1;
		next =
			fragment.end < hit.text.length || parts.length < matches.hits.length
				? cursorFor(matches, hit, fragment.end)
				: undefined;
		if (available <= 0 || parts.length >= matches.limit) {
			break;
		}
	}
	return { parts, spans, next };
}
export function searchPage(
	matches: HistoryMatches,
	params: HistoryParams,
	host: PolicyContext,
	pages: PageAccess,
): TextResult {
	const chars = pages.size(host, { offset: 0, cursor: params.cursor });
	const reserve = Math.max(
		0,
		...matches.hits.map((hit) => searchFooter(cursorFor(matches, hit, hit.text.length)).length),
	);
	if (reserve >= chars) {
		pages.error(host, "History entry id is too large for pagination.", params.cursor);
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
	const tail = skippedNote + (page.next === undefined ? "" : searchFooter(page.next));
	return pages.result(body + tail, [], {
		kind: "history-search",
		entries: [...page.spans],
		footerLength: tail.length,
		more: page.next !== undefined,
		skipped: matches.skipped,
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
	const chars = access.pages.size(access.host, {
		offset,
		imageCount: firstImage,
		imageOffset: item.images.length > 0 ? imageOffset : undefined,
	});
	const imageEnd = Math.min(
		item.images.length,
		imageOffset + firstImage + Math.floor((chars - MIN_PAGE_CHARS) / ESTIMATED_IMAGE_CHARS),
	);
	const images = item.images.slice(imageOffset, imageEnd);
	const end = Math.min(
		item.text.length,
		offset + chars - (images.length - firstImage) * ESTIMATED_IMAGE_CHARS,
	);
	const more =
		end < item.text.length || imageEnd < item.images.length
			? `\nMore remains; call history read with id "${shownId}" and offset ${end}${item.images.length > 0 ? ` and imageOffset ${imageEnd}` : ""}.`
			: "";
	const header = `${item.entry.timestamp ?? ""}${sourceTag(source)} [window ${item.windowId}] [${shownId}] [chars ${offset}-${end} of ${item.text.length}] `;
	return access.pages.result(`${header}${item.text.slice(offset, end)}${more}`, images, {
		kind: "history-read",
		headerLength: header.length,
		offset,
		end,
		total: item.text.length,
		imageOffset,
		imageEnd,
		imageTotal: item.images.length,
	});
}
