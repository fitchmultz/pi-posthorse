import { keyText, type ExtensionAPI, type MessageRenderer, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, MouseRegion, Text, stripTerminalSequences, truncateToWidth, type Component } from "@earendil-works/pi-tui";

/** Display-only facts and offsets into content, never a second copy of a note or history page. */
export type PosthorseDisplay =
	| { kind: "context"; usage?: { tokens: number | null; contextWindow: number; percent: number | null }; rollover?: "enabled" | "disabled" | "unsupported"; rolloverAt?: number }
	| { kind: "notes-list" | "notes-search"; count: number }
	| { kind: "note-read"; offset: number; end: number; total: number }
	| { kind: "note-write" | "note-append" | "new-context" }
	| { kind: "history-search"; entries: Array<{ headerLength: number; length: number }> }
	| { kind: "history-read"; headerLength: number; offset: number; end: number; total: number };

type ToolName = "notes" | "history" | "get_context_remaining" | "new_context";
const titles: Record<ToolName, string> = { notes: "Notes", history: "History", get_context_remaining: "Context budget", new_context: "New context" };
const n = (value: number) => value.toLocaleString("en-US");

function clean(value: string): string {
	return stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\ufff9-\ufffb]/g, "");
}
function argsOf(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function argument(value: unknown, name: string): string {
	return typeof value === "string" ? clean(value) : value == null ? "…" : `[invalid ${name}]`;
}
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : "";
}
function textBlock(text: string, theme: Theme, color: "toolOutput" | "muted" | "dim" | "error" | "warning" = "toolOutput"): Text {
	return new Text(text ? theme.fg(color, clean(text)) : "", 0, 0);
}
function hint(theme: Theme, width: number): string {
	const key = keyText("app.tools.expand");
	return truncateToWidth(theme.fg("dim", key ? `… ${key} to expand` : "… details hidden"), width);
}
function pageSummary(page: { offset: number; end: number; total: number }): string {
	if (!page.total) return "Empty note";
	if (!page.offset && page.end === page.total) return `${n(page.total)} chars · complete`;
	return `Chars ${n(page.offset)}–${n(page.end)} of ${n(page.total)}${page.end < page.total ? `\nNext offset ${n(page.end)}` : " · final page"}`;
}

function historySections(raw: string, display: PosthorseDisplay | undefined): Array<{ body: string; header: string }> | undefined {
	const spans = display?.kind === "history-search" ? display.entries : display?.kind === "history-read" ? [{ headerLength: display.headerLength, length: raw.length }] : undefined;
	if (!Array.isArray(spans) || !spans.length) return undefined;
	let start = 0;
	const sections: Array<{ body: string; header: string }> = [];
	for (const span of spans) {
		if (!Number.isInteger(span.headerLength) || !Number.isInteger(span.length) || span.headerLength < 0 || span.headerLength > span.length || start + span.length > raw.length) return undefined;
		sections.push({ header: raw.slice(start, start + span.headerLength).trimEnd(), body: raw.slice(start + span.headerLength, start + span.length) });
		start += span.length + 1;
	}
	return start === raw.length + 1 ? sections : undefined;
}

export function toolCards(name: ToolName): Pick<ToolDefinition, "renderCall" | "renderResult"> {
	return {
		renderCall(rawArgs, theme, context) {
			const args = argsOf(rawArgs);
			const action = name === "notes" || name === "history" ? ` · ${argument(args.op, "op")}` : name === "new_context" ? " · request" : "";
			const status = context.isError ? " · error" : context.isPartial ? context.executionStarted ? " · running" : " · preparing" : "";
			const target = args.op === "search" ? ` · “${argument(args.query, "query")}”` : name === "notes" && args.op !== "list" ? ` · ${argument(args.path, "path")}` : name === "history" && args.op === "read" ? ` · ${argument(args.id, "id")}` : "";
			const label = `${context.isPartial ? "…" : context.expanded ? "▾" : "▸"} ${titles[name]}${action}${status}${target}`;
			return {
				invalidate() {},
				render(width) {
					const heading = theme.fg(context.isError ? "error" : "toolTitle", theme.bold(label));
					if (!context.expanded) return [truncateToWidth(heading.replace(/\s+/g, " "), width)];
					const details = [
						name === "history" && args.op === "search" ? `Scope: ${args.all === true ? "all project sessions" : "current branch"}` : "",
						args.offset !== undefined ? `Offset: ${typeof args.offset === "number" ? n(args.offset) : "[invalid offset]"}` : "",
						args.limit !== undefined ? `Limit: ${typeof args.limit === "number" ? n(args.limit) : "[invalid limit]"}` : "",
					].filter(Boolean).join(" · ");
					return [...new Text(heading, 0, 0).render(width), ...textBlock(details, theme, "muted").render(width)];
				},
			};
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const args = argsOf(context.args);
			const raw = textOf(result.content);
			const display = result.details as PosthorseDisplay | undefined;
			const sections = !context.isError && !isPartial ? historySections(raw, display) : undefined;
			let summary = "";
			let body = raw;
			let color: "toolOutput" | "warning" | "error" = context.isError ? "error" : "toolOutput";
			if (!context.isError && !isPartial) {
				switch (display?.kind) {
					case "context": {
						const usage = display.usage;
						if (!usage || usage.tokens == null) { summary = "Context usage unknown"; break; }
						const hard = `≈${n(Math.max(0, usage.contextWindow - usage.tokens))} tokens to hard limit`;
						const rollover = display.rollover === "enabled" && display.rolloverAt !== undefined ? `≈${n(Math.max(0, display.rolloverAt - usage.tokens))} tokens to rollover` : `Automatic rollover ${display.rollover ?? "unknown"}`;
						summary = `${rollover}\n${hard}\n≈${n(usage.tokens)} / ${n(usage.contextWindow)} used${usage.percent == null ? "" : ` (≈${Math.round(usage.percent)}%)`}`;
						if (display.rollover === "unsupported") color = "warning";
						break;
					}
					case "notes-list": summary = display.count ? `${n(display.count)} note${display.count === 1 ? "" : "s"}` : "No notes yet"; break;
					case "notes-search": summary = display.count ? `${n(display.count)} matches returned` : "No matches"; break;
					case "note-read": summary = pageSummary(display); break;
					case "note-write": summary = args.content === "" ? "Cleared note" : "Saved note"; break;
					case "note-append": summary = "Appended to note"; break;
					case "history-search": if (Array.isArray(display.entries) && (!display.entries.length || sections)) summary = `${display.entries.length ? `${n(display.entries.length)} matches` : "No matches"} · ${args.all === true ? "all sessions" : "current branch"}`; break;
					case "history-read": summary = pageSummary(display); break;
					case "new-context": summary = "Requested for after the whole tool batch succeeds."; break;
				}
			}
			if (!body.trim()) body = context.isError ? "No error details returned." : isPartial ? "Running…" : name === "notes" && args.op === "read" ? "Empty note" : "No text returned.";
			const submitted = name === "new_context" && typeof args.handoff === "string" ? `Handoff supplied:\n${args.handoff}` : name === "notes" && (args.op === "write" || args.op === "append") && typeof args.content === "string" ? `Submitted content:\n${args.content || "(empty)"}` : "";
			const images = Array.isArray(result.content) ? result.content.filter((part) => part.type === "image") : [];
			const attachment = images.length ? `${images.length} image${images.length === 1 ? "" : "s"} attached${context.showImages ? "" : " (display hidden)"}` : "";
			const fullText = sections ? new Text(sections.map(({ body, header }) => `${theme.fg("toolOutput", clean(body))}\n${theme.fg("dim", clean(header))}`).join("\n\n"), 0, 0) : textBlock(body, theme, color);
			const summaryText = textBlock(summary, theme, color);
			const submittedText = textBlock(submitted, theme);
			const attachmentText = textBlock(attachment, theme, "muted");
			// Old results have no spans. Only the preview sheds the known history prefix.
			const preview = sections ? sections.map(({ body }) => body).join("\n") : name === "history" && !context.isError ? body.replace(/^[^\n]*?\[window [^\]\n]+\] \[[^\]\n]+\](?: \[chars \d+-\d+ of \d+\])? /gm, "") : body;
			const previewText = textBlock(preview, theme, color);
			const searchPreviews = sections && display?.kind === "history-search" ? sections.slice(0, 3).map(({ body }) => theme.fg("toolOutput", clean(body).replace(/\s+/g, " "))) : undefined;
			const summaryOnly = display?.kind === "context" || display?.kind === "new-context" || display?.kind === "note-write" || display?.kind === "note-append" || ((display?.kind === "notes-list" || display?.kind === "notes-search") && display.count === 0) || (display?.kind === "note-read" && display.total === 0) || (display?.kind === "history-search" && Array.isArray(display.entries) && display.entries.length === 0);
			return {
				invalidate() {},
				render(width) {
					if (expanded) {
						return [...fullText.render(width), ...attachmentText.render(width), ...(submitted ? ["", ...submittedText.render(width)] : [])];
					}
					const summaryRows = summaryText.render(width).slice(0, 5);
					const previewRows = summaryOnly && !context.isError && !isPartial ? [] : searchPreviews
						? searchPreviews.map((line) => truncateToWidth(line, width))
						: previewText.render(width);
					const shown = previewRows.slice(0, Math.max(0, Math.min(3, 5 - summaryRows.length - (attachment ? 1 : 0))));
					const hidden = summaryOnly || previewRows.length > shown.length || Boolean(sections || submitted);
					return [...summaryRows, ...shown, ...(attachment ? [truncateToWidth(theme.fg("muted", attachment), width)] : []), ...(hidden ? [hint(theme, width)] : [])];
				},
			};
		},
	};
}

export function registerPosthorseMessages(pi: ExtensionAPI): void {
	const states = new WeakMap<object, { global: boolean; expanded: boolean }>();
	const renderer: MessageRenderer = (message, options, theme) => {
		let state = states.get(message);
		if (!state || state.global !== options.expanded) {
			state = { global: options.expanded, expanded: options.expanded };
			states.set(message, state);
		}
		const view = state;
		const window = message.customType === "context-window";
		const raw = textOf(message.content);
		const handoffLabel = "\n\nHandoff from the previous window:\n";
		const handoffAt = raw.indexOf(handoffLabel);
		const preview = window ? handoffAt < 0 ? "" : raw.slice(handoffAt + handoffLabel.length) : raw;
		const fullText = textBlock(raw, theme);
		const previewText = textBlock(preview, theme);
		const historyText = textBlock("Earlier conversation remains in history.", theme, "muted");
		const content: Component = {
			invalidate() {},
			render(width) {
				const padding = Math.min(options.outputPad, Math.max(0, Math.floor((width - 1) / 2)));
				const inner = Math.max(1, width - padding * 2);
				const title = `${view.expanded ? "▾" : "▸"} ${window ? "Context window started" : "Checkpoint reminder"}`;
				const heading = truncateToWidth(theme.fg(window ? "customMessageLabel" : "warning", theme.bold(title)), inner);
				const body = view.expanded ? fullText.render(inner) : [
					...(window ? historyText.render(inner).slice(0, 2) : []),
					...previewText.render(inner).slice(0, window ? 2 : 3),
					hint(theme, inner),
				];
				const box = new Box(padding, 1, (line) => theme.bg("customMessageBg", line));
				box.addChild({ render: () => [heading, ...body], invalidate() {} });
				return box.render(width);
			},
		};
		return new MouseRegion(content, (event) => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			view.expanded = !view.expanded;
			return { handled: true };
		});
	};
	for (const type of ["context-window", "posthorse-reminder", "headroom-reminder"]) pi.registerMessageRenderer(type, renderer);
}
