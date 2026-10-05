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
import { argsOf, argument, clean, hint, textBlock, textOf, type OutputColor } from "./text.ts";

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
		return `${summary}\n${pageSummary(display.page)}`;
	}
	return summary;
}

function resultColor(facts: ResultFacts): OutputColor {
	if (facts.isError) {
		return "error";
	}
	return !facts.isPartial &&
		facts.display?.kind === "context" &&
		facts.display.rollover === "unsupported"
		? "warning"
		: "toolOutput";
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

interface ResultLayout {
	readonly full: Component;
	readonly summary: Component;
	readonly preview: Component;
	readonly submitted: Component;
	readonly attachment: string;
	readonly attachmentBlock: Component;
	readonly footer: Component;
	readonly searchPreviews: readonly string[] | undefined;
	readonly hasDetails: boolean;
}

function resultLayout(
	facts: ResultFacts,
	sections: readonly HistorySection[] | undefined,
	theme: Theme,
): ResultLayout {
	const color = resultColor(facts);
	const submission = submittedText(facts);
	const attachment = attachmentSummary(facts);
	const { display } = facts;
	const footerLength = display?.kind === "history-search" ? (display.footerLength ?? 0) : 0;
	return {
		full: fullBody(facts, sections, theme),
		summary: textBlock(resultSummary(facts, sections), theme, color),
		preview: textBlock(previewBody(facts, sections), theme, color),
		submitted: textBlock(submission, theme),
		attachment,
		attachmentBlock: textBlock(attachment, theme, "muted"),
		footer: textBlock(
			sections !== undefined && footerLength > 0 ? facts.raw.slice(-footerLength) : "",
			theme,
			"muted",
		),
		searchPreviews: searchPreviews(facts, sections, theme),
		hasDetails: sections !== undefined || submission.length > 0 || noteHeaderLength(facts) > 0,
	};
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

function previewRows(facts: ResultFacts, layout: ResultLayout, width: number): string[] {
	if (summaryOnly(facts.display) && !facts.isError && !facts.isPartial) {
		return [];
	}
	return (
		layout.searchPreviews?.map((line) => truncateToWidth(line, width)) ??
		layout.preview.render(width)
	);
}

function collapsedRows(
	facts: ResultFacts,
	layout: ResultLayout,
	theme: Theme,
	width: number,
): string[] {
	const summaryRows = layout.summary.render(width).slice(0, 5);
	const previews = previewRows(facts, layout, width);
	const shown = previews.slice(
		0,
		Math.max(0, Math.min(3, 5 - summaryRows.length - (layout.attachment.length > 0 ? 1 : 0))),
	);
	const hidden =
		summaryOnly(facts.display) || previews.length > shown.length || layout.hasDetails;
	const attachments =
		layout.attachment.length > 0
			? [truncateToWidth(theme.fg("muted", layout.attachment), width)]
			: [];
	return [...summaryRows, ...shown, ...attachments, ...(hidden ? [hint(theme, width)] : [])];
}

function resultComponent(facts: ResultFacts, theme: Theme): Component {
	const sections =
		!facts.isError && !facts.isPartial ? historySections(facts.raw, facts.display) : undefined;
	const layout = resultLayout(facts, sections, theme);
	return {
		invalidate() {
			// Pi creates this presentation for each result/theme update; it keeps no width cache.
		},
		render(width) {
			if (facts.expanded) {
				const submitted =
					submittedText(facts).length > 0 ? ["", ...layout.submitted.render(width)] : [];
				return [
					...layout.full.render(width),
					...layout.attachmentBlock.render(width),
					...layout.footer.render(width),
					...submitted,
				];
			}
			return collapsedRows(facts, layout, theme, width);
		},
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
