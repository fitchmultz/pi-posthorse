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

export function hint(theme: Theme, width: number): string {
	const key = keyText("app.tools.expand");
	return truncateToWidth(
		theme.fg("dim", key.length > 0 ? `… ${key} to expand` : "… details hidden"),
		width,
	);
}
