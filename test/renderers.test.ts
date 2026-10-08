import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CustomMessageComponent,
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
	stripTerminalSequences,
	visibleWidth,
	TuiMainScreen,
	ProcessTerminal,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { createPosthorse } from "../index.ts";
import { fixturePolicy, loadFixture, requireValue } from "./harness.ts";
import { fixtureDisplay, fixtureResult } from "./results.ts";
import { Check } from "typebox/value";

initTheme("dark");

async function setup() {
	const loaded = await loadFixture(createPosthorse(fixturePolicy));
	const tools = new Map(
		[...loaded.extension.tools].map(([name, registration]) => [name, registration.definition]),
	);
	loaded.runtime.getActiveTools = () => [...tools.keys()];
	loaded.runtime.getAllTools = () =>
		[...loaded.extension.tools.values()].map(({ definition, sourceInfo }) => ({
			name: definition.name,
			parameters: definition.parameters,
			description: definition.description,
			exposure: "direct",
			sourceInfo,
		}));
	return { tools, messages: loaded.extension.messageRenderers };
}

class RenderOnlyTUI extends TuiMainScreen {
	constructor() {
		super(new ProcessTerminal());
	}
	override requestRender(): void {
		// The fixture renders synchronously and never starts a terminal event loop.
	}
}

async function card(name: string, args: unknown = {}) {
	const definition = requireValue((await setup()).tools.get(name));
	return new ToolExecutionComponent(
		name,
		"tool-1",
		args,
		{},
		definition,
		new RenderOnlyTUI(),
		tmpdir(),
	);
}

function lines(component: { readonly render: (width: number) => string[] }, width = 80) {
	const rendered = component.render(width);
	for (const line of rendered) {
		assert.ok(visibleWidth(line) <= width, `row exceeds ${width} columns`);
	}
	return rendered.map((line) => stripTerminalSequences(line).trimEnd());
}
const text = (component: { readonly render: (width: number) => string[] }, width = 80) =>
	lines(component, width).join("\n");
const result = (value: string, details?: unknown, isError = false) => ({
	content: [{ type: "text", text: value }],
	details,
	isError,
});
function click(
	component: {
		readonly handleMouse: (
			event: Readonly<TuiMouseEvent>,
		) => { readonly handled?: boolean } | undefined;
	},
	width: number,
	y: number,
) {
	return component.handleMouse({
		type: "click",
		button: "left",
		x: 2,
		y,
		screenX: 2,
		screenY: y,
		width,
		height: 100,
		shift: false,
		alt: false,
		ctrl: false,
	});
}

function context(cwd: string, branch: readonly unknown[] = []) {
	return {
		cwd,
		model: { contextWindow: 100_000 },
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384 }),
		getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
		getSystemPrompt: () => "test",
		sessionManager: {
			getSessionFile: (): string | undefined => undefined,
			buildSessionProjection: () => ({ entries: [] }),
			getBranch: () => branch,
			getSessionDir: () => cwd,
		},
	};
}
async function execute(
	name: string,
	args: Readonly<Record<string, unknown>>,
	ctx: Readonly<Omit<ReturnType<typeof context>, "model" | "sessionManager">> & {
		readonly model: Readonly<ReturnType<typeof context>["model"]>;
		readonly sessionManager: Readonly<ReturnType<typeof context>["sessionManager"]>;
	},
) {
	const definition = requireValue((await setup()).tools.get(name));
	assert.ok(
		Check(definition.parameters, args),
		"Executed renderer fixtures must satisfy the registered tool schema",
	);
	const value: unknown = await Reflect.apply(definition.execute.bind(definition), undefined, [
		"tool-1",
		args,
		undefined,
		undefined,
		ctx,
	]);
	return fixtureResult(value);
}

test("all four native cards identify pending calls and tolerate malformed streamed arguments", async () => {
	await Promise.all(
		(
			[
				["notes", { op: "read", path: "plan.md" }, /Notes.*read.*plan\.md/],
				["history", { op: "search", query: "relay", all: true }, /History.*search.*relay/],
				["get_context_remaining", {}, /Context/],
				["new_context", { handoff: "next station" }, /New context/],
			] as const
		).map(async ([name, args, expected]) => {
			const definition = requireValue((await setup()).tools.get(name));
			assert.equal(
				typeof definition.renderCall,
				"function",
				`${name} needs its native call renderer`,
			);
			assert.equal(
				typeof definition.renderResult,
				"function",
				`${name} needs its native result renderer`,
			);
			assert.notEqual(definition.renderShell, "self", "Pi owns the card shell and expansion");
			const component = await card(name, args);
			component.markExecutionStarted();
			assert.match(text(component), expected);
			assert.match(text(component), /running/i);
			for (const malformed of [
				undefined,
				null,
				{ op: 3, path: {} },
				{ query: ["bad"], id: false },
			]) {
				component.updateArgs(malformed);
				assert.ok(lines(component, 24).length <= 6);
			}
		}),
	);
});

test("native cards cap actual wrapped rows and expose complete legacy text by click or global expansion", async () => {
	const body = `START ${"界 👩🏽‍💻 é ".repeat(900)} END`;
	const component = await card("notes", { op: "read", path: `${"長".repeat(100)}.md` });
	component.updateResult(result(body));
	for (const width of [24, 40, 80, 196]) {
		const collapsed = text(component, width);
		assert.ok(lines(component, width).length <= 10, `collapsed height is bounded at ${width}`);
		assert.match(collapsed, /START/);
		assert.doesNotMatch(collapsed, / END/);
	}
	assert.equal(click(component, 80, 2)?.handled, true);
	assert.match(text(component), / END/);
	component.setExpanded(false);
	assert.doesNotMatch(text(component), / END/);
	component.setExpanded(true);
	assert.match(text(component), / END/);
});

test("notes show page range and next offset even when the preview fills the compact card", async () => {
	const cwd = mkdtempSync(`${tmpdir()}/posthorse-render-`);
	try {
		const ctx = context(cwd);
		const body = `START ${"n".repeat(56_176)} END`;
		await execute("notes", { op: "write", path: "ledger.md", content: body }, ctx);
		const args = { op: "read", path: "ledger.md" };
		const output = await execute("notes", args, ctx);
		const snapshot = structuredClone(output);
		const component = await card("notes", args);
		component.updateResult({ ...output, isError: false });
		const compact = text(component, 40);
		const end = 40_000 - `File: ${join(cwd, ".pi", "notes", "ledger.md")}\n`.length;
		assert.match(compact, new RegExp(`0[–-]${end.toLocaleString("en-US")}.*56,186`, "s"));
		assert.match(compact, new RegExp(`offset ${end.toLocaleString("en-US")}`));
		assert.match(compact, /START/);
		assert.doesNotMatch(
			compact,
			/File:/,
			"the path header must not displace the compact content preview",
		);
		assert.ok(lines(component, 40).length <= 10);
		assert.equal(click(component, 40, 4)?.handled, true, "the visible body also expands");
		assert.match(text(component), new RegExp(`continue with offset ${end}`));
		assert.ok(text(component, 196).includes(join(cwd, ".pi", "notes", "ledger.md")));
		assert.deepEqual(output, snapshot, "rendering must not mutate model-visible output");
		assert.ok(
			JSON.stringify(output.details).length < 200,
			"page metadata must not duplicate the note",
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("empty notes, no matches, actual errors, and submitted content stay distinct", async () => {
	const empty = await card("notes", { op: "read", path: "empty.md" });
	empty.updateResult(result(""));
	assert.match(text(empty), /Empty note/);
	const error = await card("notes", { op: "read", path: "missing.md" });
	error.updateResult(result("No note at missing.md. Use list.", undefined, true));
	assert.match(text(error), /error/i);
	assert.match(text(error), /No note at missing\.md/);
	const noMatches = await card("history", { op: "search", query: "nothing" });
	noMatches.updateResult(result('No history matches "nothing".'));
	assert.match(text(noMatches), /No history matches/);
	const write = await card("notes", { op: "write", path: "draft.md", content: "SUBMITTED TEXT" });
	write.updateResult(result("Wrote .pi/notes/draft.md"));
	write.setExpanded(true);
	assert.match(text(write), /SUBMITTED TEXT/);
});

test("empty history has one compact summary and keeps the returned text on expansion", async () => {
	const cwd = mkdtempSync(`${tmpdir()}/posthorse-empty-history-`);
	try {
		const args = { op: "search", query: "absent", all: true };
		const output = await execute("history", args, context(cwd));
		const component = await card("history", args);
		component.updateResult({ ...output, isError: false });
		assert.match(text(component), /No matches · all sessions/);
		assert.doesNotMatch(text(component), /No history matches/);
		component.setExpanded(true);
		assert.match(text(component), /No history matches "absent"\./);
		assert.deepEqual(output.content, [{ type: "text", text: 'No history matches "absent".' }]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("history searches lead with content and retain every entry and recovery identifier expanded", async () => {
	const branch = Array.from({ length: 30 }, (_, index) => ({
		type: "message",
		id: `entry-${index}`,
		timestamp: "2026-09-06T17:43:46.741Z",
		message: {
			role: "user",
			content: `Relay station ${index}: ${"route details ".repeat(20)}`,
		},
	}));
	const args = { op: "search", query: "Relay station", limit: 30 };
	const output = await execute("history", args, context(tmpdir(), branch));
	const component = await card("history", args);
	component.updateResult({ ...output, isError: false });
	assert.match(text(component, 40), /30 matches/);
	assert.match(text(component, 40), /Relay station 29/);
	assert.match(text(component, 40), /Relay station 28/);
	assert.doesNotMatch(text(component, 40), /2026-09-06T17/);
	assert.ok(lines(component, 40).length <= 10);
	component.setExpanded(true);
	const expanded = text(component, 196);
	for (let index = 0; index < 30; index++) {
		assert.match(expanded, new RegExp(`\\[entry-${index}\\]`));
	}
	assert.ok(expanded.indexOf("Relay station 29") < expanded.indexOf("2026-09-06T17"));
	assert.ok(
		JSON.stringify(output.details).length < 2000,
		"search display data is numeric boundaries, not copied bodies",
	);
});

test("paginated searches retain accurate counts, spans, identifiers and continuation in native cards", async () => {
	const branch = Array.from({ length: 60 }, (_, index) => ({
		type: "message",
		id: `entry-${index}`,
		timestamp: "2026-09-06T17:43:46.741Z",
		message: { role: "user", content: `needle station ${index} ${"r".repeat(500)}` },
	}));
	const args = { op: "search", query: "needle", limit: 50 };
	// Late in the window, the remaining budget rather than the result limit ends the page.
	const late = Object.assign(context(tmpdir(), branch), {
		getContextUsage: () => ({ tokens: 78_000, contextWindow: 100_000, percent: 78 }),
	});
	const output = await execute("history", args, late);
	const display = fixtureDisplay(output.details);
	assert.equal(display.kind, "history-search");

	assert.ok(display.entries.length < 50);
	assert.ok(display.footerLength !== undefined && display.footerLength > 0);
	const raw = output.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	assert.ok(raw.length <= 20_000);
	assert.equal(
		display.entries.reduce((sum, span) => sum + span.length + 1, -1),
		raw.length - display.footerLength,
	);
	const component = await card("history", args);
	component.updateResult({ ...output, isError: false });
	assert.match(text(component), new RegExp(`${display.entries.length} matches`));
	assert.match(text(component), /More results; continue with cursor/);
	component.setExpanded(true);
	assert.match(text(component, 196), /\[entry-59\]/);
	assert.match(text(component, 196), /\[More results; continue with cursor/);
	assert.match(
		text(component, 196),
		new RegExp(requireValue(raw.slice(-display.footerLength).match(/cursor "([^"]+)"/))[1]),
	);

	const cwd = mkdtempSync(`${tmpdir()}/posthorse-list-render-`);
	try {
		const ctx = context(cwd);
		await execute(
			"notes",
			{
				op: "write",
				path: "ledger.md",
				content: Array.from(
					{ length: 30 },
					(_, index) => `needle ${index} ${"n".repeat(150)}`,
				).join("\n"),
			},
			ctx,
		);
		Object.assign(ctx, {
			getContextUsage: () => ({ tokens: 98_000, contextWindow: 100_000, percent: 98 }),
			getCompactionSettings: () => ({ enabled: false, reserveTokens: 16_384 }),
		});
		const searchResult = await execute("notes", { op: "search", query: "needle" }, ctx);
		const details = fixtureDisplay(searchResult.details);
		assert.equal(details.kind, "notes-search");

		assert.ok(details.page && details.page.end < details.page.total);
		const notes = await card("notes", { op: "search", query: "needle" });
		notes.updateResult({ ...searchResult, isError: false });
		assert.match(text(notes), new RegExp(`${details.count} matches returned`));
		assert.match(text(notes), /Next offset/);
		notes.setExpanded(true);
		assert.match(text(notes), new RegExp(`continue with offset ${details.page.end}`));

		await execute(
			"notes",
			{
				op: "write",
				path: "more.md",
				content: Array.from(
					{ length: 300 },
					(_, index) => `needle ${index} ${"m".repeat(150)}`,
				).join("\n"),
			},
			ctx,
		);
		const partial = await execute("notes", { op: "search", query: "needle" }, ctx);
		const found = fixtureDisplay(partial.details);
		assert.ok(found.kind === "notes-search" && found.more === true && found.page);
		const partialCard = await card("notes", { op: "search", query: "needle" });
		partialCard.updateResult({ ...partial, isError: false });
		assert.match(
			text(partialCard),
			new RegExp(`of ${found.page.total.toLocaleString("en-US")}\\+\\s+Next offset`),
			"a search that stopped early must not show its count so far as the total",
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("context summaries preserve approximation and native disabled, unsupported, unknown states", async () => {
	await Promise.all(
		(
			[
				[1000, 100_000, true, /≈.*rollover/],
				[1000, 100_000, false, /disabled/i],
				[1000, 8192, true, /unsupported/i],
				[null, 100_000, true, /unknown|not known/i],
			] as const
		).map(async ([tokens, window, enabled, expected]) => {
			const ctx = context(tmpdir());
			Object.assign(ctx, {
				getContextUsage: () => ({ tokens, contextWindow: window, percent: null }),
				getCompactionSettings: () => ({ enabled, reserveTokens: 16_384 }),
			});
			const output = await execute("get_context_remaining", {}, ctx);
			const component = await card("get_context_remaining");
			component.updateResult({ ...output, isError: false });
			assert.match(text(component, 80), expected);
			assert.doesNotMatch(text(component, 80), /0%|hard limit/);
			if (tokens !== null) {
				assert.match(text(component, 80), /configured context limit/);
			}
			component.setExpanded(true);
			assert.ok(/native\s+estimate/.test(text(component, 196)) || tokens === null);
		}),
	);
});

test("new_context remains a conditional request and only its committed message says the window started", async () => {
	const handoff = Array.from({ length: 60 }, (_, i) => `Handoff line ${i + 1}`).join("\n");
	const args = { handoff };
	const output = await execute("new_context", args, context(tmpdir()));
	assert.match(
		output.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
		/Requested.*foreground tools succeed.*Background work continues/s,
	);
	const component = await card("new_context", args);
	component.updateResult({ ...output, isError: false });
	assert.match(text(component), /Requested.*foreground tools succeed/s);
	assert.match(text(component), /Background work continues/);
	assert.doesNotMatch(text(component), /committed|window started/i);
	component.setExpanded(true);
	assert.match(text(component), /Handoff line 60/);
	const message = {
		role: "custom" as const,
		customType: "context-window",
		display: true,
		timestamp: 0,
		details: { windowId: "window-2", tokensBefore: 1000 },
		content: `Context window window-2 starts here. Earlier conversation is not available in this window.\n\nHandoff from the previous window:\n${handoff}`,
	};
	const renderer = (await setup()).messages.get("context-window");
	assert.equal(typeof renderer, "function");
	const committed = new CustomMessageComponent(message, renderer, undefined, 0);
	assert.match(text(committed), /history/);
	assert.ok(lines(committed, 40).length <= 10);
	assert.doesNotMatch(text(committed), /Handoff line 60/);
	assert.equal(click(committed, 80, 2)?.handled, true);
	assert.match(text(committed), /Handoff line 60/);
	committed.setExpanded(true);
	committed.setExpanded(false);
	assert.doesNotMatch(text(committed), /Handoff line 60/);
	committed.setExpanded(true);
	assert.match(text(committed), /Handoff line 60/);
	assert.equal(click(committed, 80, 4)?.handled, true, "clicking the message body collapses it");
	assert.doesNotMatch(text(committed), /Handoff line 60/);
	committed.setOutputPad(2);
	committed.invalidate();
	assert.doesNotMatch(
		text(committed),
		/Handoff line 60/,
		"padding/theme invalidation preserves the local choice",
	);
	assert.equal(message.content.endsWith(handoff), true);
});

test("native rendering preserves theme changes and leaves drag selection to Pi", async () => {
	const component = await card("notes", { op: "read", path: "theme.md" });
	component.updateResult(result("A readable note"));
	const before = component.render(80).join("\n");
	try {
		initTheme("light");
		component.invalidate();
		const after = component.render(80).join("\n");
		const withoutShellBackground = (value: string) => {
			// Color comparison strips only the intentional ANSI background sequences.
			// oxlint-disable-next-line no-control-regex
			return value.replace(/\x1b\[(?:48;[0-9;]+|49)m/g, "");
		};
		const noteRow = (value: string) =>
			requireValue(value.split("\n").find((line) => line.includes("A readable note")));
		assert.notEqual(
			withoutShellBackground(noteRow(after)),
			withoutShellBackground(noteRow(before)),
			"result colors update, not just Pi's shell or title",
		);
		assert.equal(stripTerminalSequences(after), stripTerminalSequences(before));
		assert.equal(
			component.handleMouse({
				type: "drag",
				button: "left",
				x: 4,
				y: 3,
				screenX: 4,
				screenY: 3,
				width: 80,
				height: 10,
				shift: false,
				alt: false,
				ctrl: false,
			}),
			undefined,
		);
	} finally {
		initTheme("dark");
	}
});

test("partial and error results cannot inherit a success summary or terminal controls", async () => {
	const controls = "\x1b[2J\x1b]52;c;c2VjcmV0\x07\x1b_hidden\x1b\\\x00\r";
	const component = await card("notes", {
		op: "write",
		path: `draft${controls}.md`,
		content: `saved${controls}`,
	});
	component.updateResult(result(`still running${controls}`, { kind: "note-write" }), true);
	assert.match(text(component), /still running/);
	assert.doesNotMatch(text(component), /Saved note/);
	component.updateResult(
		result(
			`ERROR HEAD ${"problem ".repeat(100)} ERROR TAIL${controls}`,
			{ kind: "note-write" },
			true,
		),
	);
	assert.match(text(component), /ERROR HEAD/);
	assert.doesNotMatch(text(component), /Saved note/);
	component.setExpanded(true);
	assert.match(text(component), /ERROR TAIL/);
	// Sanitization must reject terminal erase/clipboard controls and C0 bytes from results.
	// oxlint-disable-next-line no-control-regex
	assert.doesNotMatch(component.render(80).join("\n"), /\x1b\[2J|\x1b\]52|hidden|\x00|\r/);
});

test("history pages keep paging, metadata, and native image attachments without copied bodies", async () => {
	const image = {
		type: "image",
		mimeType: "image/png",
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	};
	const body = `ENTRY HEAD ${"route ".repeat(8000)} ENTRY TAIL`;
	const branch = [
		{
			type: "message",
			id: "picture-entry",
			timestamp: "2026-09-06T17:43:46Z",
			message: { role: "user", content: [{ type: "text", text: body }, image] },
		},
	];
	const args = { op: "read", id: "picture-entry" };
	const output = await execute("history", args, context(tmpdir(), branch));
	const component = await card("history", args);
	component.updateResult({ ...output, isError: false });
	component.setShowImages(false);
	assert.match(text(component, 40), /Next offset 40,000/);
	assert.match(text(component, 40), /1 image attached/);
	assert.ok(lines(component, 40).length <= 10);
	assert.deepEqual(output.content.slice(1), [image]);
	assert.ok(JSON.stringify(output.details).length < 200);
	component.setExpanded(true);
	const expanded = text(component, 196);
	assert.ok(expanded.indexOf("ENTRY HEAD") < expanded.indexOf("2026-09-06T17"));
	assert.match(expanded, /\[picture-entry\]/);
	assert.match(expanded, /More remains; call history read/);
	const continuation = await execute(
		"history",
		{ ...args, offset: 40_000 },
		context(tmpdir(), branch),
	);
	assert.equal(continuation.content.length, 1);

	const manyImages = [
		{
			...branch[0],
			message: {
				role: "user",
				content: [{ type: "text", text: body }, ...Array.from({ length: 13 }, () => image)],
			},
		},
	];
	const imagePage = await execute("history", args, context(tmpdir(), manyImages));
	const imageDetails = fixtureDisplay(imagePage.details);
	assert.equal(imageDetails.kind, "history-read");
	assert.notEqual(imageDetails.imageEnd, undefined);
	component.setExpanded(false);
	component.updateResult({ ...imagePage, isError: false });
	for (const width of [24, 100]) {
		const compact = text(component, width);
		assert.match(
			compact,
			new RegExp(`Next offset ${imageDetails.end.toLocaleString("en-US")}`),
		);
		assert.match(compact, new RegExp(`imageOffset ${requireValue(imageDetails.imageEnd)}`));
		assert.equal(compact.match(/Next offset/g)?.length, 1);
	}
	component.setExpanded(true);
	assert.match(
		text(component, 196),
		new RegExp(
			`and offset ${imageDetails.end} and imageOffset ${requireValue(imageDetails.imageEnd)}`,
		),
	);
});

test("legacy history and malformed display spans fall back to the complete returned text", async () => {
	const raw =
		"archive.jsonl 2026-09-06T17:43:46Z [window old] [owner-1] [user] Relay station is ready.\nSECOND LINE";
	await Promise.all(
		[
			undefined,
			{ kind: "history-search", entries: [{ headerLength: 99_999, length: 3 }] },
			{ kind: "history-search", entries: [null] },
			{ kind: "context", usage: { tokens: "not-number", contextWindow: 100, percent: null } },
		].map(async (details) => {
			const component = await card("history", { op: "search", query: "Relay station" });
			component.updateResult(result(raw, details));
			assert.match(text(component, 40), /Relay station/);
			assert.ok(lines(component, 40).length <= 10);
			component.setExpanded(true);
			assert.doesNotMatch(text(component), /NaN|tokens to rollover/);
			for (const line of raw.split("\n")) {
				assert.ok(text(component, 196).includes(line));
			}
		}),
	);
	const blankBlocks = await card("history", { op: "read", id: "spaced" });
	blankBlocks.updateResult({
		content: [
			{ type: "text", text: "FIRST" },
			{ type: "text", text: "" },
			{ type: "text", text: "LAST" },
		],
		isError: false,
	});
	blankBlocks.setExpanded(true);
	assert.ok(
		/FIRST[ \t]*\n[ \t]*\n[ \t]*LAST/.test(text(blankBlocks)),
		"valid empty text blocks preserve intentional spacing",
	);
});

test("owned reminders are compact, expandable, and sanitize terminal control content", async () => {
	const customType = "posthorse-reminder";
	const renderer = (await setup()).messages.get(customType);
	assert.equal(typeof renderer, "function");
	const message = {
		role: "custom" as const,
		customType,
		display: true,
		timestamp: 0,
		content: `Checkpoint now\n${"remember\n".repeat(50)}LAST\x1b[2J\x1b]52;c;c2VjcmV0\x07\x00`,
	};
	const component = new CustomMessageComponent(message, renderer, undefined, 2);
	assert.ok(lines(component, 24).length <= 10);
	component.setExpanded(true);
	assert.match(text(component), /LAST/);
	const raw = component.render(80).join("\n");
	// Reminder rendering must reject terminal erase/clipboard controls and C0 bytes.
	// oxlint-disable-next-line no-control-regex
	assert.doesNotMatch(raw, /\x1b\[2J|\x1b\]52|\x00/);
	const blankBlocks = new CustomMessageComponent(
		{
			...message,
			content: [
				{ type: "text", text: "FIRST" },
				{ type: "text", text: "" },
				{ type: "text", text: "LAST" },
			],
		},
		renderer,
		undefined,
		0,
	);
	blankBlocks.setExpanded(true);
	assert.ok(
		/FIRST[ \t]*\n[ \t]*\n[ \t]*LAST/.test(text(blankBlocks)),
		"reminders preserve valid empty blocks",
	);
});
