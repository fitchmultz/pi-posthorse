import { open, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { lfChunks } from "./files.ts";

export type LineMatcher = {
	readonly test: (text: string) => boolean;
	readonly encoding: "latin1" | "utf8";
	/** Enough characters to include every case-fold alternative of any needle. */
	readonly overlap: number;
};
export type SessionLine = {
	readonly head: string;
	readonly matches: boolean;
	readonly text: () => Promise<string>;
};
type LineRange = {
	readonly start: number;
	readonly end: number;
	readonly head: string;
	readonly matches: boolean;
	readonly bytes?: Readonly<Pick<Buffer, "toString">>;
};
async function* lineRanges(
	file: string,
	handle: Readonly<Pick<FileHandle, "createReadStream">>,
	signal: AbortSignal | undefined,
	matcher: LineMatcher | undefined,
): AsyncGenerator<LineRange> {
	let start = 0;
	let position = 0;
	let head = Buffer.alloc(0);
	let tail = "";
	let decoder = new StringDecoder(matcher?.encoding);
	let matches = matcher === undefined;
	for await (const { bytes, end } of lfChunks(file, signal, 1024 * 1024, handle)) {
		if (head.length < 512) {
			head = Buffer.concat([head, bytes.subarray(0, 512 - head.length)]);
		}
		if (!matches && matcher !== undefined) {
			const window = tail + decoder.write(bytes) + (end ? decoder.end() : "");
			matches = matcher.test(window);
			tail = window.slice(-matcher.overlap);
		}
		position += bytes.length;
		if (end) {
			yield {
				start,
				end: position,
				head: head.toString("utf8"),
				matches,
				bytes: position - start === bytes.length ? bytes : undefined,
			};
			position++;
			start = position;
			head = Buffer.alloc(0);
			tail = "";
			decoder = new StringDecoder(matcher?.encoding);
			matches = matcher === undefined;
		}
	}
}
async function rangeText(
	handle: Readonly<Pick<FileHandle, "read">>,
	line: LineRange,
	signal?: AbortSignal,
): Promise<string> {
	signal?.throwIfAborted();
	if (line.bytes !== undefined) {
		return line.bytes.toString("utf8");
	}
	const buffer = Buffer.alloc(line.end - line.start);
	let offset = 0;
	while (offset < buffer.length) {
		signal?.throwIfAborted();
		// Positioned reads may be short; each continues the same selected record.
		// oxlint-disable-next-line no-await-in-loop
		const { bytesRead } = await handle.read(
			buffer,
			offset,
			buffer.length - offset,
			line.start + offset,
		);
		if (bytesRead === 0) {
			throw new Error("Session file changed while reading a history entry.");
		}
		offset += bytesRead;
	}
	return buffer.toString("utf8");
}
/** Irrelevant lines retain only their prefix, byte range and needle overlap, not their payload. */
export async function* sessionLines(
	file: string,
	signal?: AbortSignal,
	matcher?: LineMatcher,
): AsyncGenerator<SessionLine> {
	const handle = await open(file, "r");
	try {
		for await (const line of lineRanges(file, handle, signal, matcher)) {
			yield {
				head: line.head,
				matches: line.matches,
				text: () => rangeText(handle, line, signal),
			};
		}
	} finally {
		await handle.close();
	}
}
