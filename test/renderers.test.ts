import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import {
	CustomMessageComponent,
	initTheme,
	ToolExecutionComponent,
	type ExtensionAPI,
	type ExtensionContext,
	type MessageRenderer,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import posthorse from "../index.ts";

initTheme("dark");

function setup() {
	const tools = new Map<string, ToolDefinition>();
	const messages = new Map<string, MessageRenderer>();
	posthorse({
		on() {},
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerMessageRenderer: (name: string, renderer: MessageRenderer) => messages.set(name, renderer),
		getActiveTools: () => [...tools.keys()],
		getAllTools: () => [...tools.values()],
	} as unknown as ExtensionAPI);
	return { tools, messages };
}

function card(name: string, args: unknown = {}) {
	const definition = setup().tools.get(name)!;
	return new ToolExecutionComponent(name, "tool-1", args, {}, definition, { requestRender() {} } as TUI, tmpdir());
}

function lines(component: { render(width: number): string[] }, width = 80) {
	const rendered = component.render(width);
	for (const line of rendered) assert.ok(visibleWidth(line) <= width, `row exceeds ${width} columns`);
	return rendered.map((line) => stripTerminalSequences(line).trimEnd());
}
const text = (component: { render(width: number): string[] }, width = 80) => lines(component, width).join("\n");
const result = (value: string, details?: unknown, isError = false) => ({
	content: [{ type: "text", text: value }], details, isError,
});
function click(component: { handleMouse(event: TuiMouseEvent): { handled?: boolean } | undefined }, width: number, y: number) {
	return component.handleMouse({ type: "click", button: "left", x: 2, y, screenX: 2, screenY: y, width, height: 100, shift: false, alt: false, ctrl: false });
}

function context(cwd: string, branch: unknown[] = []): ExtensionContext {
	return {
		cwd,
		model: { contextWindow: 100_000 },
		newContext() {},
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384 }),
		getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
		getSystemPrompt: () => "test",
		sessionManager: { getBranch: () => branch, getSessionDir: () => cwd },
	} as unknown as ExtensionContext;
}
async function execute(name: string, args: Record<string, unknown>, ctx: ExtensionContext) {
	return setup().tools.get(name)!.execute("tool-1", args, undefined, undefined, ctx);
}

test("all four native cards identify pending calls and tolerate malformed streamed arguments", () => {
	for (const [name, args, expected] of [
		["notes", { op: "read", path: "plan.md" }, /Notes.*read.*plan\.md/],
		["history", { op: "search", query: "relay", all: true }, /History.*search.*relay/],
		["get_context_remaining", {}, /Context/],
		["new_context", { handoff: "next station" }, /New context/],
	] as const) {
		const definition = setup().tools.get(name)!;
		assert.equal(typeof definition.renderCall, "function", `${name} needs its native call renderer`);
		assert.equal(typeof definition.renderResult, "function", `${name} needs its native result renderer`);
		assert.notEqual(definition.renderShell, "self", "Pi owns the card shell and expansion");
		const component = card(name, args);
		component.markExecutionStarted();
		assert.match(text(component), expected);
		assert.match(text(component), /running/i);
		for (const malformed of [undefined, null, { op: 3, path: {} }, { query: ["bad"], id: false }]) {
			component.updateArgs(malformed);
			assert.ok(lines(component, 24).length <= 6);
		}
	}
});

test("native cards cap actual wrapped rows and expose complete legacy text by click or global expansion", () => {
	const body = `START ${"界 👩🏽‍💻 é ".repeat(900)} END`;
	const component = card("notes", { op: "read", path: `${"長".repeat(100)}.md` });
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
		const component = card("notes", args);
		component.updateResult({ ...output, isError: false });
		const compact = text(component, 40);
		assert.match(compact, /0[–-]20,000.*56,186/s);
		assert.match(compact, /offset 20,000/);
		assert.ok(lines(component, 40).length <= 10);
		assert.equal(click(component, 40, 4)?.handled, true, "the visible body also expands");
		assert.match(text(component), /continue with offset 20000/);
		assert.deepEqual(output, snapshot, "rendering must not mutate model-visible output");
		assert.ok(JSON.stringify(output.details).length < 200, "page metadata must not duplicate the note");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("empty notes, no matches, actual errors, and submitted content stay distinct", async () => {
	const empty = card("notes", { op: "read", path: "empty.md" });
	empty.updateResult(result(""));
	assert.match(text(empty), /Empty note/);
	const error = card("notes", { op: "read", path: "missing.md" });
	error.updateResult(result("No note at missing.md. Use list.", undefined, true));
	assert.match(text(error), /error/i);
	assert.match(text(error), /No note at missing\.md/);
	const noMatches = card("history", { op: "search", query: "nothing" });
	noMatches.updateResult(result('No history matches "nothing".'));
	assert.match(text(noMatches), /No history matches/);
	const write = card("notes", { op: "write", path: "draft.md", content: "SUBMITTED TEXT" });
	write.updateResult(result("Wrote .pi/notes/draft.md"));
	write.setExpanded(true);
	assert.match(text(write), /SUBMITTED TEXT/);
});

test("empty history has one compact summary and keeps the returned text on expansion", async () => {
	const cwd = mkdtempSync(`${tmpdir()}/posthorse-empty-history-`);
	try {
		const args = { op: "search", query: "absent", all: true };
		const output = await execute("history", args, context(cwd));
		const component = card("history", args);
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
		type: "message", id: `entry-${index}`, timestamp: "2026-09-06T17:43:46.741Z",
		message: { role: "user", content: `Relay station ${index}: ${"route details ".repeat(20)}` },
	}));
	const args = { op: "search", query: "Relay station", limit: 30 };
	const output = await execute("history", args, context(tmpdir(), branch));
	const component = card("history", args);
	component.updateResult({ ...output, isError: false });
	assert.match(text(component, 40), /30 matches/);
	assert.match(text(component, 40), /Relay station 29/);
	assert.match(text(component, 40), /Relay station 28/);
	assert.doesNotMatch(text(component, 40), /2026-09-06T17/);
	assert.ok(lines(component, 40).length <= 10);
	component.setExpanded(true);
	const expanded = text(component, 196);
	for (let index = 0; index < 30; index++) assert.match(expanded, new RegExp(`\\[entry-${index}\\]`));
	assert.ok(expanded.indexOf("Relay station 29") < expanded.indexOf("2026-09-06T17"));
	assert.ok(JSON.stringify(output.details).length < 2000, "search display data is numeric boundaries, not copied bodies");
});

test("context summaries preserve approximation and native disabled, unsupported, unknown states", async () => {
	for (const [tokens, window, enabled, expected] of [
		[1000, 100_000, true, /≈.*rollover/],
		[1000, 100_000, false, /disabled/i],
		[1000, 8192, true, /unsupported/i],
		[null, 100_000, true, /unknown|not known/i],
	] as const) {
		const ctx = context(tmpdir());
		Object.assign(ctx, {
			getContextUsage: () => ({ tokens, contextWindow: window, percent: null }),
			getCompactionSettings: () => ({ enabled, reserveTokens: 16_384 }),
		});
		const output = await execute("get_context_remaining", {}, ctx);
		const component = card("get_context_remaining");
		component.updateResult({ ...output, isError: false });
		assert.match(text(component, 80), expected);
		assert.doesNotMatch(text(component, 80), /0%/);
		component.setExpanded(true);
		assert.ok(text(component, 196).includes("native estimate") || tokens === null);
	}
});

test("new_context remains a conditional request and only its committed message says the window started", async () => {
	const handoff = Array.from({ length: 60 }, (_, i) => `Handoff line ${i + 1}`).join("\n");
	const args = { handoff };
	const output = await execute("new_context", args, context(tmpdir()));
	assert.deepEqual(output.content, [{ type: "text", text: "Requested a fresh Pi context after this complete tool batch succeeds. Earlier conversation stays in session history." }]);
	const component = card("new_context", args);
	component.updateResult({ ...output, isError: false });
	assert.match(text(component), /Requested.*batch succeeds/s);
	assert.doesNotMatch(text(component), /committed|window started/i);
	component.setExpanded(true);
	assert.match(text(component), /Handoff line 60/);
	const message = {
		role: "custom" as const, customType: "context-window", display: true, timestamp: 0,
		details: { windowId: "window-2", tokensBefore: 1000 },
		content: `Context window window-2 starts here. Earlier conversation is not available in this window.\n\nHandoff from the previous window:\n${handoff}`,
	};
	const renderer = setup().messages.get("context-window");
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
	assert.doesNotMatch(text(committed), /Handoff line 60/, "padding/theme invalidation preserves the local choice");
	assert.equal(message.content.endsWith(handoff), true);
});

test("native rendering preserves theme changes and leaves drag selection to Pi", () => {
	const component = card("notes", { op: "read", path: "theme.md" });
	component.updateResult(result("A readable note"));
	const before = component.render(80).join("\n");
	try {
		initTheme("light");
		component.invalidate();
		const after = component.render(80).join("\n");
		const withoutShellBackground = (value: string) => value.replace(/\x1b\[(?:48;[0-9;]+|49)m/g, "");
		const noteRow = (value: string) => value.split("\n").find((line) => line.includes("A readable note"))!;
		assert.notEqual(withoutShellBackground(noteRow(after)), withoutShellBackground(noteRow(before)), "result colors update, not just Pi's shell or title");
		assert.equal(stripTerminalSequences(after), stripTerminalSequences(before));
		assert.equal(component.handleMouse({ type: "drag", button: "left", x: 4, y: 3, screenX: 4, screenY: 3, width: 80, height: 10, shift: false, alt: false, ctrl: false }), undefined);
	} finally {
		initTheme("dark");
	}
});

test("partial and error results cannot inherit a success summary or terminal controls", () => {
	const controls = "\x1b[2J\x1b]52;c;c2VjcmV0\x07\x1b_hidden\x1b\\\x00\r";
	const component = card("notes", { op: "write", path: `draft${controls}.md`, content: `saved${controls}` });
	component.updateResult(result(`still running${controls}`, { kind: "note-write" }), true);
	assert.match(text(component), /still running/);
	assert.doesNotMatch(text(component), /Saved note/);
	component.updateResult(result(`ERROR HEAD ${"problem ".repeat(100)} ERROR TAIL${controls}`, { kind: "note-write" }, true));
	assert.match(text(component), /ERROR HEAD/);
	assert.doesNotMatch(text(component), /Saved note/);
	component.setExpanded(true);
	assert.match(text(component), /ERROR TAIL/);
	assert.doesNotMatch(component.render(80).join("\n"), /\x1b\[2J|\x1b\]52|hidden|\x00|\r/);
});

test("history pages keep paging, metadata, and native image attachments without copied bodies", async () => {
	const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==" };
	const body = `ENTRY HEAD ${"route ".repeat(5000)} ENTRY TAIL`;
	const branch = [{ type: "message", id: "picture-entry", timestamp: "2026-09-06T17:43:46Z", message: { role: "user", content: [{ type: "text", text: body }, image] } }];
	const args = { op: "read", id: "picture-entry" };
	const output = await execute("history", args, context(tmpdir(), branch));
	const component = card("history", args);
	component.updateResult({ ...output, isError: false });
	component.setShowImages(false);
	assert.match(text(component, 40), /Next offset 20,000/);
	assert.match(text(component, 40), /1 image attached/);
	assert.ok(lines(component, 40).length <= 10);
	assert.deepEqual(output.content.slice(1), [image]);
	assert.ok(JSON.stringify(output.details).length < 200);
	component.setExpanded(true);
	const expanded = text(component, 196);
	assert.ok(expanded.indexOf("ENTRY HEAD") < expanded.indexOf("2026-09-06T17"));
	assert.match(expanded, /\[picture-entry\]/);
	assert.match(expanded, /More remains; call history read/);
	const continuation = await execute("history", { ...args, offset: 20_000 }, context(tmpdir(), branch));
	assert.equal(continuation.content.length, 1);
});

test("legacy history and malformed display spans fall back to the complete returned text", () => {
	const raw = "archive.jsonl 2026-09-06T17:43:46Z [window old] [owner-1] [user] Relay station is ready.\nSECOND LINE";
	for (const details of [undefined, { kind: "history-search", entries: [{ headerLength: 99_999, length: 3 }] }]) {
		const component = card("history", { op: "search", query: "Relay station" });
		component.updateResult(result(raw, details));
		assert.match(text(component, 40), /Relay station/);
		assert.ok(lines(component, 40).length <= 10);
		component.setExpanded(true);
		for (const line of raw.split("\n")) assert.ok(text(component, 196).includes(line));
	}
});

test("owned reminders are compact, expandable, and sanitize terminal control content", () => {
	for (const customType of ["posthorse-reminder", "headroom-reminder"]) {
		const renderer = setup().messages.get(customType);
		assert.equal(typeof renderer, "function");
		const message = { role: "custom" as const, customType, display: true, timestamp: 0, content: `Checkpoint now\n${"remember\n".repeat(50)}LAST\x1b[2J\x1b]52;c;c2VjcmV0\x07\x00` };
		const component = new CustomMessageComponent(message, renderer, undefined, 2);
		assert.ok(lines(component, 24).length <= 10);
		component.setExpanded(true);
		assert.match(text(component), /LAST/);
		const raw = component.render(80).join("\n");
		assert.doesNotMatch(raw, /\x1b\[2J|\x1b\]52|\x00/);
	}
});
