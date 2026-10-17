import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
	displayOf,
	displaySummary,
	historySections,
	pageSummary,
	summaryOnly,
	type HistorySection,
	type PosthorseDisplay,
} from "./display.ts";
import {
	argsOf,
	argument,
	clean,
	hint,
	leadingRows,
	textBlock,
	textOf,
	type OutputColor,
} from "./text.ts";

export type ToolName = "notes" | "history" | "get_context_remaining" | "new_context";
const titles: Readonly<Record<ToolName, string>> = {
	notes: "Notes",
	history: "History",
	get_context_remaining: "Context budget",
	new_context: "New context",
};
const n = (value: number): string => value.toLocaleString("en-US");

interface CallState {
	readonly isError: boolean;
	readonly isPartial: boolean;
	readonly executionStarted: boolean;
	readonly expanded: boolean;
}

function callTarget(name: ToolName, args: Readonly<Record<string, unknown>>): string {
	if (args.op === "search") {
		return ` · “${argument(args.query, "query")}”`;
	}
	if (name === "notes" && (args.op !== "list" || args.path !== undefined)) {
		return ` · ${argument(args.path, "path")}`;
	}
	return name === "history" && args.op === "read" ? ` · ${argument(args.id, "id")}` : "";
}

function callStatus(state: CallState): string {
	if (state.isError) {
		return " · error";
	}
	if (!state.isPartial) {
		return "";
	}
	return state.executionStarted ? " · running" : " · preparing";
}

function callDetails(name: ToolName, args: Readonly<Record<string, unknown>>): string {
	const scope =
		name === "history" && args.op === "search"
			? `Scope: ${args.all === true ? "all project sessions" : "current branch"}`
			: "";
	const offsets = [
		["offset", "Offset"],
		["imageOffset", "Image offset"],
		["limit", "Limit"],
	].map(([key, label]) => {
		const value = args[key];
		return value === undefined
			? ""
			: `${label}: ${typeof value === "number" ? n(value) : `[invalid ${key}]`}`;
	});
	return [scope, ...offsets].filter((part) => part.length > 0).join(" · ");
}

function callComponent(
	name: ToolName,
	args: Readonly<Record<string, unknown>>,
	theme: Theme,
	state: CallState,
): Component {
	let action = "";
	if (name === "notes" || name === "history") {
		action = ` · ${argument(args.op, "op")}`;
	} else if (name === "new_context") {
		action = " · request";
	}
	let marker = "▸";
	if (state.isPartial) {
		marker = "…";
	} else if (state.expanded) {
		marker = "▾";
	}
	const label = `${marker} ${titles[name]}${action}${callStatus(state)}${callTarget(name, args)}`;
	return {
		invalidate() {
			// Stateless layout is recomputed with the current width on every render.
		},
		render(width) {
			const heading = theme.fg(state.isError ? "error" : "toolTitle", theme.bold(label));
			if (!state.expanded) {
				return [truncateToWidth(heading.replace(/\s+/g, " "), width)];
			}
			return [
				...new Text(heading, 0, 0).render(width),
				...textBlock(callDetails(name, args), theme, "muted").render(width),
			];
		},
	};
}

interface ResultFacts {
	readonly name: ToolName;
	readonly raw: string;
	readonly args: Readonly<Record<string, unknown>>;
	readonly display: PosthorseDisplay | undefined;
	readonly isError: boolean;
	readonly isPartial: boolean;
	readonly expanded: boolean;
	readonly imageCount: number;
	readonly showImages: boolean;
}

function submittedText(facts: ResultFacts): string {
	const { name, args } = facts;
	if (name === "new_context" && typeof args.handoff === "string") {
		return `Handoff supplied:\n${args.handoff}`;
	}
	if (
		name === "notes" &&
		(args.op === "write" || args.op === "append") &&
		typeof args.content === "string"
	) {
		return `Submitted content:\n${args.content.length > 0 ? args.content : "(empty)"}`;
	}
	return "";
}

function resultSummary(
	facts: ResultFacts,
	sections: readonly HistorySection[] | undefined,
): string {
	if (facts.isError || facts.isPartial) {
		return "";
	}
	const { display } = facts;
	const summary = displaySummary(display, facts.args, sections !== undefined);
	if (
		(display?.kind === "notes-list" || display?.kind === "notes-search") &&
		display.page !== undefined &&
		(display.page.offset > 0 || display.page.end < display.page.total)
	) {
		return `${summary}\n${pageSummary(display.page, display.more)}`;
	}
	return summary;
}

function resultColor(facts: ResultFacts): OutputColor {
	if (facts.isError) {
		return "error";
	}
	const { display } = facts;
	if (facts.isPartial || display?.kind !== "context" || display.rollover !== "unsupported") {
		return "toolOutput";
	}
	const tokens = display.usage?.tokens;
	return tokens !== undefined && tokens !== null ? "warning" : "toolOutput";
}

function resultBody(facts: ResultFacts): string {
	if (facts.raw.trim().length > 0) {
		return facts.raw;
	}
	if (facts.isError) {
		return "No error details returned.";
	}
	if (facts.isPartial) {
		return "Running…";
	}
	return facts.name === "notes" && facts.args.op === "read" ? "Empty note" : "No text returned.";
}

function noteHeaderLength(facts: ResultFacts): number {
	const { display } = facts;
	return !facts.isError && (display?.kind === "note-read" || display?.kind === "notes-list")
		? (display.headerLength ?? 0)
		: 0;
}

function previewBody(facts: ResultFacts, sections: readonly HistorySection[] | undefined): string {
	if (sections !== undefined) {
		return sections.map(({ body }) => body).join("\n");
	}
	const body = resultBody(facts);
	const headerLength = noteHeaderLength(facts);
	if (headerLength > 0) {
		return body.slice(headerLength);
	}
	// Old results have no spans. Only the preview sheds the known history prefix.
	return facts.name === "history" && !facts.isError
		? body.replace(
				/^[^\n]*?\[window [^\]\n]+\] \[[^\]\n]+\](?: \[chars \d+-\d+ of \d+\])? /gm,
				"",
			)
		: body;
}

function attachmentSummary(facts: ResultFacts): string {
	if (facts.imageCount === 0) {
		return "";
	}
	return `${facts.imageCount} image${facts.imageCount === 1 ? "" : "s"} attached${facts.showImages ? "" : " (display hidden)"}`;
}

function fullBody(
	facts: ResultFacts,
	sections: readonly HistorySection[] | undefined,
	theme: Theme,
): Component {
	if (sections === undefined) {
		return textBlock(resultBody(facts), theme, resultColor(facts));
	}
	return new Text(
		sections
			.map(
				({ body, header }) =>
					`${theme.fg("toolOutput", clean(body))}\n${theme.fg("dim", clean(header))}`,
			)
			.join("\n\n"),
		0,
		0,
	);
}

function searchPreviews(
	facts: ResultFacts,
	sections: readonly HistorySection[] | undefined,
	theme: Theme,
): readonly string[] | undefined {
	return sections !== undefined && facts.display?.kind === "history-search"
		? sections
				.slice(0, 3)
				.map(({ body }) => theme.fg("toolOutput", clean(body).replace(/\s+/g, " ")))
		: undefined;
}

type RowView = (width: number) => string[];

function expandedView(
	facts: ResultFacts,
	sections: readonly HistorySection[] | undefined,
	theme: Theme,
): RowView {
	const full = fullBody(facts, sections, theme);
	const attachment = textBlock(attachmentSummary(facts), theme, "muted");
	const { display } = facts;
	const footerLength = display?.kind === "history-search" ? (display.footerLength ?? 0) : 0;
	const footer = textBlock(
		sections !== undefined && footerLength > 0 ? facts.raw.slice(-footerLength) : "",
		theme,
		"muted",
	);
	const submission = submittedText(facts);
	const submitted = textBlock(submission, theme);
	return (width) => [
		...full.render(width),
		...attachment.render(width),
		...footer.render(width),
		...(submission.length > 0 ? ["", ...submitted.render(width)] : []),
	];
}

function previewSource(
	facts: ResultFacts,
	sections: readonly HistorySection[] | undefined,
	theme: Theme,
): (width: number) => readonly string[] {
	if (summaryOnly(facts.display) && !facts.isError && !facts.isPartial) {
		return () => [];
	}
	const searches = searchPreviews(facts, sections, theme);
	if (searches !== undefined) {
		return (width) => searches.map((line) => truncateToWidth(line, width));
	}
	return leadingRows(previewBody(facts, sections), theme, resultColor(facts), 3);
}

function collapsedView(
	facts: ResultFacts,
	sections: readonly HistorySection[] | undefined,
	theme: Theme,
): RowView {
	const summary = textBlock(resultSummary(facts, sections), theme, resultColor(facts));
	const previews = previewSource(facts, sections, theme);
	const attachment = attachmentSummary(facts);
	const details =
		summaryOnly(facts.display) ||
		sections !== undefined ||
		submittedText(facts).length > 0 ||
		noteHeaderLength(facts) > 0;
	return (width) => {
		const summaryRows = summary.render(width).slice(0, 5);
		const rows = previews(width);
		const shown = rows.slice(
			0,
			Math.max(0, Math.min(3, 5 - summaryRows.length - (attachment.length > 0 ? 1 : 0))),
		);
		const attachments =
			attachment.length > 0 ? [truncateToWidth(theme.fg("muted", attachment), width)] : [];
		const hidden = details || rows.length > shown.length;
		return [...summaryRows, ...shown, ...attachments, ...(hidden ? [hint(theme, width)] : [])];
	};
}

function resultComponent(facts: ResultFacts, theme: Theme): Component {
	const sections =
		!facts.isError && !facts.isPartial ? historySections(facts.raw, facts.display) : undefined;
	const render = (facts.expanded ? expandedView : collapsedView)(facts, sections, theme);
	return {
		invalidate() {
			// Pi creates this presentation for each result, theme, and expansion update.
		},
		render,
	};
}

export function toolCards(name: ToolName): Pick<ToolDefinition, "renderCall" | "renderResult"> {
	return {
		renderCall(rawArgs, theme, context) {
			return callComponent(name, argsOf(rawArgs), theme, context);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			return resultComponent(
				{
					name,
					raw: textOf(result.content),
					args: argsOf(context.args),
					display: displayOf(result.details),
					isError: context.isError,
					isPartial,
					expanded,
					imageCount: result.content.filter((part) => part.type === "image").length,
					showImages: context.showImages,
				},
				theme,
			);
		},
	};
}
