import { keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";

export type OutputColor = "toolOutput" | "muted" | "dim" | "error" | "warning";

export function clean(value: string): string {
	// Tool previews must not execute terminal controls or Unicode interlinear annotations.
	// oxlint-disable-next-line no-control-regex
	return stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\ufff9-\ufffb]/g, "");
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function argsOf(value: unknown): Readonly<Record<string, unknown>> {
	return isRecord(value) ? value : {};
}

export function argument(value: unknown, name: string): string {
	if (typeof value === "string") {
		return clean(value);
	}
	return value === null || value === undefined ? "…" : `[invalid ${name}]`;
}

export function textOf(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.flatMap((part: unknown) => {
			return isRecord(part) && part.type === "text" && typeof part.text === "string"
				? [part.text]
				: [];
		})
		.join("\n");
}

export function textBlock(text: string, theme: Theme, color: OutputColor = "toolOutput"): Text {
	return new Text(text.length > 0 ? theme.fg(color, clean(text)) : "", 0, 0);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Rows of `textBlock(text)` wrapped only as far as a preview needs, so resizing long text stays
 * cheap: the first `count` rows are exact, and any further row means the full text has more.
 */
export function leadingRows(
	text: string,
	theme: Theme,
	color: OutputColor,
	count: number,
): (width: number) => readonly string[] {
	// One line past `count` already wraps to more rows when the text continues.
	const head = clean(text)
		.split("\n", count + 1)
		.join("\n");
	const segments = graphemes.segment(head);
	const wrap = (width: number): readonly string[] => {
		for (let limit = (count + 1) * width + 1024; ; limit *= 2) {
			// pi-tui wraps greedily by grapheme, so text cut between graphemes wraps like the
			// whole text in every row but its last.
			const end = segments.containing(limit)?.index ?? head.length;
			const prefix = theme.fg(color, head.slice(0, end));
			const rows = new Text(text.length > 0 ? prefix : "", 0, 0).render(width);
			if (end === head.length || rows.length > count) {
				return rows;
			}
		}
	};
	let cached: { readonly width: number; readonly rows: readonly string[] } | undefined;
	return (width) => {
		if (cached?.width !== width) {
			cached = { width, rows: wrap(width) };
		}
		return cached.rows;
	};
}

export function hint(theme: Theme, width: number): string {
	const key = keyText("app.tools.expand");
	return truncateToWidth(
		theme.fg("dim", key.length > 0 ? `… ${key} to expand` : "… details hidden"),
		width,
	);
}
