import { unknownArray } from "./contracts.ts";

/** Where a search page stopped: the anchor entry, its rank, its offset, and the search it belongs to. */
export type HistoryCursor = readonly [id: string, priority: 0 | 1, offset: number, key: string];

export function encodeCursor(cursor: HistoryCursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
export function cursorFor(
	key: string,
	hit: { readonly id: string; readonly priority: 0 | 1 },
	offset: number,
): string {
	return encodeCursor([hit.id, hit.priority, offset, key]);
}
function cursorOffset(value: unknown, storedKey: unknown, key: string): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		storedKey !== key
	) {
		throw new Error("Invalid cursor offset or scope.");
	}
	return value;
}
/** A cursor is anonymous unless it decodes to the same query and scope that produced it. */
export function decodeCursor(encoded: string | undefined, key: string): HistoryCursor | undefined {
	if (encoded === undefined || encoded === "") {
		return undefined;
	}
	const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString());
	const parts = unknownArray(value);
	if (parts === undefined || parts.length !== 4) {
		throw new Error("Invalid cursor tuple.");
	}
	const [id, priority, offset, storedKey] = parts;
	if (typeof id !== "string" || id === "" || (priority !== 0 && priority !== 1)) {
		throw new Error("Invalid cursor anchor.");
	}
	return [id, priority, cursorOffset(offset, storedKey, key), key];
}
