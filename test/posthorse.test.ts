import { strict as assert } from "node:assert";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import posthorse from "../index.ts";
import type { PosthorseDisplay } from "../ui.ts";

type Handler = (event: Record<string, unknown>, context: TestContext) => unknown;
type Tool = {
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal,
		onUpdate: () => void,
		context: TestContext,
	): Promise<{
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		newContext?: { handoff?: string };
		details?: PosthorseDisplay;
	}>;
};
type TestContext = {
	cwd: string;
	model: { contextWindow: number };
	sessionManager: {
		getBranch(): Record<string, unknown>[];
		getSessionDir(): string;
	};
	getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	getCompactionSettings(): { enabled: boolean; reserveTokens: number };
	getSystemPrompt(): string;
	newContext(options?: { handoff?: string }): void;
};

function setup() {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, Tool>();
	const toolDefinitions: Array<{ name: string; description?: string; parameters?: unknown }> = [];
	const messages: Array<{
		customType?: string;
		content: string;
		display?: boolean;
		details?: { windowId?: string };
	}> = [];
	const api = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerTool(tool: Tool & { name: string; description?: string; parameters?: unknown }) {
			tools.set(tool.name, tool);
			toolDefinitions.push(tool);
		},
		registerMessageRenderer() {},
		sendMessage(message: (typeof messages)[number]) {
			messages.push(message);
		},
		getActiveTools: () => [...tools.keys()],
		getAllTools: () => toolDefinitions.map((tool) => ({ ...tool, id: tool.name })),
	} as unknown as ExtensionAPI;
	posthorse(api);
	const context: TestContext = {
		cwd: process.cwd(),
		model: { contextWindow: 100_000 },
		sessionManager: { getBranch: () => [], getSessionDir: () => tmpdir() },
		getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384 }),
		getSystemPrompt: () => "You are a test assistant.",
		newContext: () => {},
	};
	return { handlers, tools, messages, context };
}

function toolText(result: { content: Array<{ text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

function run(tools: Map<string, Tool>, name: string, params: Record<string, unknown>, context: TestContext) {
	return tools.get(name)!.execute("id", params, new AbortController().signal, () => {}, context);
}

function turnEnd(handlers: Map<string, Handler>, context: TestContext, toolResults: Record<string, unknown>[] = []) {
	handlers.get("turn_end")!({ message: { role: "assistant", stopReason: toolResults.length ? "toolUse" : "stop" }, toolResults }, context);
}

/** A context whose usage sits at `tokens` inside a window of `contextWindow`. */
function usageContext(base: TestContext, contextWindow: number, tokens: number, reserveTokens = 16_384, enabled = true): TestContext {
	return {
		...base,
		model: { contextWindow },
		getContextUsage: () => ({ tokens, contextWindow, percent: (tokens / contextWindow) * 100 }),
		getCompactionSettings: () => ({ enabled, reserveTokens }),
	};
}

function automaticHandoff(handlers: Map<string, Handler>, context: TestContext, branchEntries: Record<string, unknown>[]) {
	return (
		handlers.get("session_before_auto_compact")!(
			{ reason: "threshold", branchEntries },
			context,
		) as { newContext: { handoff: string } }
	).newContext.handoff;
}

test("new_context returns an atomic handoff and automatic rollover builds a recovery record", async () => {
	const { handlers, tools, context } = setup();
	const result = await run(tools, "new_context", { handoff: "continue here" }, context);
	assert.deepEqual(result.newContext, { handoff: "continue here" });
	assert.equal(handlers.has("session_before_compact"), false, "manual /compact is left to Pi");

	const handoff = automaticHandoff(handlers, context, [
		{ type: "message", id: "user", timestamp: "2026-09-02T10:00:00Z", message: { role: "user", content: "keep working on the fix" } },
	]);
	assert.match(handoff, /^Automatic context rollover recovery record\./);
	assert.match(handoff, /owner input.*entry user/);
	assert.match(handoff, /keep working on the fix/);
	assert.match(handoff, /not current progress/);

	const prior = automaticHandoff(handlers, context, [
		{ type: "context_window", id: "prior", timestamp: "2026-09-02T10:01:00Z", handoff: "persisted task" },
	]);
	assert.match(prior, /older checkpoint; possibly stale/);
	assert.match(prior, /persisted task/);
	assert.match(prior, /No selected current-window/);
	assert.ok(prior.indexOf("No selected current-window") < prior.indexOf("older checkpoint"));

	const nonRecursive = automaticHandoff(handlers, context, [
		{
			type: "context_window",
			id: "prior-auto",
			timestamp: "2026-09-02T10:02:00Z",
			handoff: "Automatic context rollover recovery record.\nSECRET NESTED TEXT",
		},
	]);
	assert.match(nonRecursive, /Prior automatic recovery text is not nested/);
	assert.match(nonRecursive, /entry prior-auto/);
	assert.doesNotMatch(nonRecursive, /SECRET NESTED TEXT/);
});

test("automatic recovery keeps owner anchors and visible coordination without stale transcript guesses", () => {
	const { handlers, context } = setup();
	const branch: Record<string, unknown>[] = [
		{ type: "message", id: "old", message: { role: "user", content: "old completed task" } },
		{ type: "context_window", id: "window-2", timestamp: "2026-09-02T10:00:00Z", handoff: "Original approved goal" },
		{ type: "custom_message", id: "hidden", timestamp: "2026-09-02T10:01:00Z", customType: "todo-list-context", content: "hidden state", display: false },
		{ type: "custom_message", id: "reminder", timestamp: "2026-09-02T10:02:00Z", customType: "headroom-reminder", content: "stale reminder", display: true },
		{ type: "message", id: "owner-start", timestamp: "2026-09-02T10:03:00Z", message: { role: "user", content: `FIRST OWNER REQUEST ${"a".repeat(9_000)} OWNER REQUEST TAIL` } },
		{ type: "message", id: "ordinary-tool", timestamp: "2026-09-02T10:04:00Z", message: { role: "toolResult", toolName: "bash", content: "assistant-derived state" } },
	];
	for (let index = 0; index < 8; index++) {
		branch.push({
			type: "custom_message",
			id: `coord-${index}`,
			timestamp: `2026-09-02T10:${10 + index}:00Z`,
			customType: "intercom_message",
			content: `coordination ${index} ${"x".repeat(3_500)}`,
			display: true,
		});
	}
	branch.push(
		{
			type: "message",
			id: "owner-answer",
			timestamp: "2026-09-02T10:20:00Z",
			message: { role: "toolResult", toolName: "ask_question", isError: false, content: "OWNER APPROVED SHIP" },
		},
		{
			type: "custom_message",
			id: "latest-correction",
			timestamp: "2026-09-02T10:21:00Z",
			customType: "agent-irc",
			content: "LATEST COORDINATION CORRECTION",
			display: true,
		},
	);

	const handoff = automaticHandoff(handlers, context, branch);
	assert.ok(handoff.length <= 20_000);
	assert.match(handoff, /Original approved goal/);
	assert.match(handoff, /FIRST OWNER REQUEST/);
	assert.match(handoff, /OWNER REQUEST TAIL/);
	assert.match(handoff, /middle omitted/);
	assert.match(handoff, /OWNER APPROVED SHIP/);
	assert.match(handoff, /LATEST COORDINATION CORRECTION/);
	assert.match(handoff, /not direct owner input/);
	assert.match(handoff, /Omitted \d+ current-window input/);
	assert.ok(handoff.indexOf("entry owner-start") < handoff.indexOf("entry owner-answer"));
	assert.ok(handoff.indexOf("entry owner-answer") < handoff.indexOf("entry latest-correction"));
	assert.ok(handoff.indexOf("entry latest-correction") < handoff.indexOf("older checkpoint"));
	assert.doesNotMatch(handoff, /old completed task|hidden state|stale reminder|assistant-derived state/);
});

test("automatic recovery includes successful ask_question cancellations and excludes errors", () => {
	const { handlers, context } = setup();
	const handoff = automaticHandoff(handlers, context, [
		{ type: "message", id: "cancelled", timestamp: "1", message: { role: "toolResult", toolName: "ask_question", isError: false, content: "Question cancelled by owner" } },
		{ type: "message", id: "failed", timestamp: "2", message: { role: "toolResult", toolName: "ask_question", isError: true, content: "tool crashed" } },
	]);
	assert.match(handoff, /owner answer via ask_question/);
	assert.match(handoff, /Question cancelled by owner/);
	assert.doesNotMatch(handoff, /tool crashed/);
});

test("budget policy sends one best-effort reminder below the line and lets Pi own rollover", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-test-"));
	try {
		// A project file that disagrees with Pi's effective policy must be ignored: Pi decides trust, not Posthorse.
		mkdirSync(join(dir, ".pi"));
		writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ compaction: { enabled: false, reserveTokens: 1 } }));
		const { handlers, messages } = setup();
		const contextWindow = 100_000;
		const reserve = 64_000;
		const threshold = contextWindow - reserve;
		const rolloverAt = threshold + 1;
		const remindAt = 32_401; // Last 3,600 tokens of the 36,000 usable tokens.
		let tokens = remindAt - 1;
		const branch: Record<string, unknown>[] = [{ type: "context_window", id: "window-2" }];
		const rollovers: Array<{ handoff?: string }> = [];
		let branchReads = 0;
		const context: TestContext = {
			cwd: dir,
			model: { contextWindow },
			sessionManager: { getBranch: () => { branchReads++; return branch; }, getSessionDir: () => dir },
			getContextUsage: () => ({ tokens, contextWindow, percent: (tokens / contextWindow) * 100 }),
			getCompactionSettings: () => ({ enabled: true, reserveTokens: reserve }),
			getSystemPrompt: () => "You are a test assistant.",
			newContext: (options) => rollovers.push(options ?? {}),
		};

		handlers.get("session_start")!({}, context);
		turnEnd(handlers, context);
		assert.equal(messages.length, 0, "no reminder below the band");
		assert.equal(branchReads, 0, "below-band turns must not fetch history");
		tokens = remindAt;
		turnEnd(handlers, context, [{ toolName: "new_context" }]);
		assert.equal(messages.length, 0);
		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "error" }, toolResults: [] }, context);
		assert.equal(messages.length, 0);
		handlers.get("turn_end")!({ message: { role: "assistant", stopReason: "aborted" }, toolResults: [] }, context);
		assert.equal(messages.length, 0);
		assert.equal(branchReads, 0, "successful rollover batches, errors, and aborts need no history");

		turnEnd(handlers, context);
		assert.equal(messages.length, 1);
		assert.match(messages[0].content, /Checkpoint now/);
		assert.match(messages[0].content, /call new_context now/);
		assert.deepEqual(messages[0].details, { windowId: "window-2", contextWindow, reserveTokens: reserve });
		assert.equal(branchReads, 1, "the first token in the reminder band checks the current window");
		branch.push({ type: "custom_message", customType: "posthorse-reminder", details: messages[0].details });

		tokens = threshold;
		turnEnd(handlers, context);
		assert.equal(messages.length, 1, "Pi does not roll at exact threshold equality");
		branch.pop();
		messages.length = 0;
		turnEnd(handlers, context);
		assert.equal(messages.length, 1, "Posthorse still offers a checkpoint at equality");
		assert.equal(branchReads, 3, "in-band turns recheck persisted reminders, including threshold equality");

		messages.length = 0;
		tokens = rolloverAt;
		turnEnd(handlers, context);
		assert.equal(messages.length, 0, "Pi owns the first token that actually triggers rollover");
		assert.equal(branchReads, 3, "rollover equality must not fetch history");
		tokens += 1_000;
		turnEnd(handlers, context);
		assert.equal(messages.length, 0, "Posthorse also stays out of Pi's over-threshold path");
		assert.equal(branchReads, 3, "over-threshold turns must not fetch history");
		assert.equal(rollovers.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a large reserve does not send checkpoint reminders in a fresh window", () => {
	const { handlers, messages, context: base } = setup();
	for (const tokens of [1000, 9000]) turnEnd(handlers, usageContext(base, 400_000, tokens, 390_000));
	assert.equal(messages.length, 0, "a fresh 10K usable window must not immediately checkpoint again");
	turnEnd(handlers, usageContext(base, 400_000, 9001, 390_000));
	assert.equal(messages.length, 1);
	assert.match(messages[0].content, /1,000 tokens remain/);
});

test("guidance uses native sections and preserves earlier full or custom prompts", () => {
	const { handlers, context } = setup();
	const handler = handlers.get("before_agent_start")!;
	const sections: Record<string, string> = { other: "Keep this policy" };
	const options = { sections, customPrompt: "Custom instructions" };
	assert.equal(handler({ systemPrompt: "Custom instructions", systemPromptOptions: options }, context), undefined);
	assert.equal(sections.other, "Keep this policy");
	assert.match(sections.posthorse, /Context self-management \(Posthorse\)/);
	assert.match(sections.posthorse, /save goal\/progress\/decisions\/next steps/);
	assert.match(sections.posthorse, /verify live state/);

	const result = handler({ systemPrompt: "Forced instructions", systemPromptOptions: { sections: {}, forceSystemPrompt: "Forced instructions" } }, context) as { systemPrompt: string };
	assert.equal(result.systemPrompt, `Forced instructions\n\n${sections.posthorse}`);
});

test("disabled Pi compaction disables automatic Posthorse behavior but not new_context", async () => {
	const { handlers, messages, tools, context: base } = setup();
	const context: TestContext = {
		...base,
		getContextUsage: () => ({ tokens: 99_000, contextWindow: 100_000, percent: 99 }),
		getCompactionSettings: () => ({ enabled: false, reserveTokens: 16_384 }),
	};
	const guidance = handlers.get("before_agent_start")!({ systemPrompt: "base", systemPromptOptions: { forceSystemPrompt: "base", sections: {} } }, context) as { systemPrompt: string };
	assert.match(guidance.systemPrompt, /Pi compaction is disabled/);
	assert.match(guidance.systemPrompt, /Context self-management \(Posthorse\)/);
	turnEnd(handlers, context);
	assert.equal(messages.length, 0);
	const remaining = toolText(await run(tools, "get_context_remaining", {}, context));
	assert.match(remaining, /Automatic rollover is disabled/);
	assert.match(remaining, /1,000 tokens until the configured context limit/);
	const result = await run(tools, "new_context", {}, context);
	assert.deepEqual(result.newContext, { handoff: undefined });
});

test("disabling compaction filters persisted reminders without changing history or deduplication", () => {
	const { handlers, context: base, messages } = setup();
	for (const customType of ["posthorse-reminder", "headroom-reminder"]) {
		let enabled = true;
		const reminder = { role: "custom", customType, content: "Checkpoint now", details: { windowId: "initial", contextWindow: 100_000, reserveTokens: 16_384 } };
		const branch = [{ ...reminder, type: "custom_message", id: "reminder" }];
		const context = { ...usageContext(base, 100_000, 76_000), getCompactionSettings: () => ({ enabled, reserveTokens: 16_384 }), sessionManager: { getBranch: () => branch, getSessionDir: () => tmpdir() } };
		const owner = { role: "user", content: "continue" };
		assert.equal(handlers.get("context")!({ messages: [owner, reminder] }, context), undefined);
		enabled = false;
		assert.deepEqual(handlers.get("context")!({ messages: [owner, reminder] }, context), { messages: [owner] });
		assert.equal(branch[0].content, "Checkpoint now", "raw history stays intact");
		enabled = true;
		turnEnd(handlers, context);
		assert.equal(messages.length, 0, "reenabling does not emit another reminder");
	}
});

test("reminder-free context skips history without hiding native compatibility errors", () => {
	const { handlers, context } = setup();
	const marker = { role: "custom", customType: "context-window", content: "new", details: { windowId: "new" } };
	const user = { role: "user", content: "posthorse-reminder and headroom-reminder are just text here" };
	const other = { role: "custom", customType: "intercom_message", content: "keep" };
	let branchReads = 0;
	context.sessionManager.getBranch = () => {
		branchReads++;
		return [{ type: "custom_message", customType: "headroom-reminder", details: { windowId: "old" } }];
	};
	for (const method of ["newContext", "getCompactionSettings", "getSystemPrompt"]) {
		const incompatible = { ...context };
		Reflect.deleteProperty(incompatible, method);
		assert.throws(
			() => handlers.get("context")!({ messages: [marker, user, other] }, incompatible),
			/Posthorse requires the fitchmultz\/pi fork/,
		);
	}
	for (const messages of [[], [user, other], [marker, user, other]]) {
		const original = structuredClone(messages);
		assert.equal(handlers.get("context")!({ messages }, context), undefined);
		assert.deepEqual(messages, original, "unrelated messages remain unchanged");
	}
	assert.equal(branchReads, 0, "no history is needed even if old reminders remain in the transcript");
	for (const customType of ["posthorse-reminder", "headroom-reminder"]) {
		const current = { role: "custom", customType, content: "current", details: { windowId: "new" } };
		const stale = { ...current, content: "stale", details: { windowId: "old" } };
		assert.deepEqual(
			handlers.get("context")!({ messages: [marker, user, other, stale, current] }, context),
			{ messages: [marker, user, other, current] },
			`${customType} alone must still trigger stale filtering`,
		);
	}
	assert.equal(branchReads, 2, "both reminder types still consult history when present");
});

test("context filtering removes reminders from an older window or a different budget, legacy ids included", () => {
	const { handlers, context } = setup();
	const marker = { role: "custom", customType: "context-window", content: "new", details: { windowId: "new" } };
	const current = {
		role: "custom",
		customType: "posthorse-reminder",
		content: "current",
		details: { windowId: "new", contextWindow: 100_000, reserveTokens: 16_384 },
	};
	const legacyCurrent = { role: "custom", customType: "headroom-reminder", content: "legacy current", details: { windowId: "new" } };
	const old = { role: "custom", customType: "posthorse-reminder", content: "old", details: { windowId: "old", contextWindow: 100_000, reserveTokens: 16_384 } };
	const legacyOld = { role: "custom", customType: "headroom-reminder", content: "legacy old", details: { windowId: "old" } };
	const otherModel = { role: "custom", customType: "posthorse-reminder", content: "smaller model", details: { windowId: "new", contextWindow: 50_000, reserveTokens: 16_384 } };
	const otherReserve = { role: "custom", customType: "posthorse-reminder", content: "other reserve", details: { windowId: "new", contextWindow: 100_000, reserveTokens: 64_000 } };
	const other = { role: "custom", customType: "intercom_message", content: "keep" };
	const filtered = handlers.get("context")!(
		{ messages: [marker, old, legacyOld, otherModel, otherReserve, other, current, legacyCurrent] },
		context,
	) as { messages: unknown[] };
	assert.deepEqual(filtered.messages, [marker, other, current, legacyCurrent]);
	assert.equal(handlers.get("context")!({ messages: [marker, other, current, legacyCurrent] }, context), undefined);
	// Before any rollover the window is "initial"; a reminder computed for another model size is still stale.
	const initial = { role: "custom", customType: "posthorse-reminder", content: "initial", details: { windowId: "initial", contextWindow: 100_000, reserveTokens: 16_384 } };
	const filteredInitial = handlers.get("context")!({ messages: [otherModel, initial] }, context) as { messages: unknown[] };
	assert.deepEqual(filteredInitial.messages, [initial]);
});

test("history reads current entries without opening every archived session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-history-test-"));
	try {
		mkdirSync(join(dir, "unrelated.jsonl"));
		const { tools, context: base } = setup();
		const context: TestContext = {
			...base,
			sessionManager: {
				getBranch: () => [
					{ type: "message", id: "current", parentId: null, timestamp: "1", message: { role: "user", content: "keep me" } },
				],
				getSessionDir: () => dir,
			},
		};

		const reads = await Promise.all(
			Array.from({ length: 5 }, () => run(tools, "history", { op: "read", id: "current" }, context)),
		);
		for (const result of reads) assert.match(toolText(result), /keep me/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("all-session history recurses and returns newest matching entries first", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-recursive-history-test-"));
	try {
		const nested = join(dir, "subagents");
		mkdirSync(nested);
		const oldFile = join(dir, "old.jsonl");
		const newFile = join(nested, "new.jsonl");
		writeFileSync(oldFile, JSON.stringify({ type: "message", id: "old", parentId: null, timestamp: "1", message: { role: "user", content: "recursive needle old" } }));
		writeFileSync(
			newFile,
			[
				JSON.stringify({ type: "context_window", id: "nested-window", parentId: null, timestamp: "2", handoff: "resume" }),
				JSON.stringify({ type: "message", id: "nested-old", parentId: "nested-window", timestamp: "3", message: { role: "user", content: "recursive needle nested old" } }),
				JSON.stringify({ type: "message", id: "nested-new", parentId: "nested-old", timestamp: "4", message: { role: "user", content: "recursive needle nested newest" } }),
			].join("\n"),
		);
		utimesSync(oldFile, new Date(1_000), new Date(1_000));
		utimesSync(newFile, new Date(2_000), new Date(2_000));
		const { tools, context: base } = setup();
		let mayReadCurrentBranch = false;
		const context: TestContext = {
			...base,
			sessionManager: {
				getBranch: () => {
					assert.ok(mayReadCurrentBranch, "all-session search must not normalize the current branch");
					return [];
				},
				getSessionDir: () => dir,
			},
		};
		const search = await tools.get("history")!.execute(
			"id",
			{ op: "search", query: "recursive needle", all: true, limit: 2 },
			new AbortController().signal,
			() => {},
			context,
		);
		const text = toolText(search);
		assert.match(text, /^subagents\/new\.jsonl .+\[nested-new\].+nested newest/s);
		assert.ok(text.indexOf("nested-new") < text.indexOf("nested-old"));
		assert.doesNotMatch(text, /\[old\]/);
		mayReadCurrentBranch = true;
		const read = await tools.get("history")!.execute(
			"id",
			{ op: "read", id: "nested-new" },
			new AbortController().signal,
			() => {},
			context,
		);
		assert.match(toolText(read), /^subagents\/new\.jsonl .+\[window nested-window\].+nested newest/s);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("history searches normalized text and reports native window ids", async () => {
	const { tools, context: base } = setup();
	const branch = [
		{ type: "message", id: "needle-only-in-id", parentId: null, timestamp: "1", message: { role: "user", content: "plain" } },
		{ type: "message", id: "before", parentId: "needle-only-in-id", timestamp: "2", message: { role: "user", content: "needle before" } },
		{ type: "context_window", id: "window-2", parentId: "before", timestamp: "3", handoff: "continue" },
		{ type: "message", id: "after", parentId: "window-2", timestamp: "4", message: { role: "assistant", content: "needle after" } },
		{ type: "message", id: "long", parentId: "after", timestamp: "5", message: { role: "user", content: `${"x".repeat(20_100)}needle tail` } },
	];
	const context: TestContext = {
		...base,
		sessionManager: { getBranch: () => branch, getSessionDir: () => join(tmpdir(), "missing") },
	};
	const result = await tools.get("history")!.execute(
		"id",
		{ op: "search", query: "needle" },
		new AbortController().signal,
		() => {},
		context,
	);
	const text = toolText(result);
	assert.doesNotMatch(text, /needle-only-in-id/);
	assert.ok(text.indexOf("[long]") < text.indexOf("[after]"));
	assert.match(text, /\[window initial\] \[before\]/);
	assert.match(text, /\[window window-2\] \[after\]/);

	const firstPage = await tools.get("history")!.execute(
		"id",
		{ op: "read", id: "long" },
		new AbortController().signal,
		() => {},
		context,
	);
	assert.match(toolText(firstPage), /offset 20000/);
	const secondPage = await tools.get("history")!.execute(
		"id",
		{ op: "read", id: "long", offset: 20_000 },
		new AbortController().signal,
		() => {},
		context,
	);
	assert.match(toolText(secondPage), /needle tail/);
});

test("history ranks matching original content before recovery and lookup echoes without hiding either", async () => {
	const { tools, context: base } = setup();
	const image = { type: "image", data: "UE5HREFUQQ==", mimeType: "image/png" };
	const branch = [
		{ type: "message", id: "owner", message: { role: "user", content: "needle original request" } },
		{ type: "message", id: "assistant", message: { role: "assistant", content: "needle original response" } },
		{ type: "message", id: "result", message: { role: "toolResult", toolName: "read", content: "needle original output" } },
		{ type: "context_window", id: "window", handoff: "needle checkpoint" },
		{ type: "compaction", id: "summary", summary: "needle summary" },
		{ type: "branch_summary", id: "branch-summary", summary: "needle branch summary" },
		{ type: "custom_message", id: "reminder", customType: "posthorse-reminder", content: "needle reminder" },
		{ type: "custom_message", id: "legacy", customType: "headroom-reminder", content: "needle legacy reminder" },
		{ type: "message", id: "notes", message: { role: "toolResult", toolName: "notes", content: "needle saved note" } },
		{ type: "message", id: "lookup", message: { role: "toolResult", toolName: "history", content: [{ type: "text", text: "needle recovered output" }, image] } },
		{ type: "message", id: "rollover", message: { role: "assistant", content: [{ type: "toolCall", name: "new_context", arguments: { handoff: "needle" } }] } },
		{ type: "message", id: "mixed-call", message: { role: "assistant", content: [
			{ type: "toolCall", name: "notes", arguments: { op: "write", content: `needle ECHO ${"x".repeat(500)}` } },
			{ type: "toolCall", name: "bash", arguments: { command: "needle MATCHING SIBLING" } },
		] } },
		{ type: "message", id: "mixed-prose", message: { role: "assistant", content: [
			{ type: "text", text: "needle MATCHING PROSE" },
			{ type: "text", text: "second line" },
			{ type: "toolCall", name: "history", arguments: { op: "search", query: `needle ECHO ${"x".repeat(500)}` } },
		] } },
		{ type: "message", id: "mixed-echo", message: { role: "assistant", content: [
			{ type: "toolCall", name: "history", arguments: { op: "search", query: "needle lookup-only" } },
			{ type: "text", text: "ordinary prose does not match" },
		] } },
		{ type: "message", id: "current-search", message: { role: "assistant", content: [{ type: "toolCall", name: "history", arguments: { op: "search", query: "[assistant] needle MATCHING PROSE" } }] } },
	].map((entry, index, entries) => ({ ...entry, timestamp: `${index}`, parentId: entries[index - 1]?.id ?? null }));
	const context = { ...base, sessionManager: { getBranch: () => branch, getSessionDir: () => join(tmpdir(), "missing") } };
	const search = async (query: string, limit = 50) => toolText(await run(tools, "history", { op: "search", query, limit }, context));
	const ids = (text: string) => [...text.matchAll(/\[window [^\]]+\] \[([^\]]+)\]/g)].map((match) => match[1]);
	const all = await search("NEEDLE");
	assert.deepEqual(ids(all), [
		"mixed-prose", "mixed-call", "result", "assistant", "owner",
		"current-search", "mixed-echo", "rollover", "lookup", "notes", "legacy", "reminder", "branch-summary", "summary", "window",
	]);
	const originals = await search("needle", 5);
	assert.deepEqual(ids(originals), ids(all).slice(0, 5));
	assert.match(originals, /MATCHING PROSE/);
	assert.match(originals, /MATCHING SIBLING/);
	assert.doesNotMatch(originals, /ECHO/);
	assert.deepEqual(ids(await search("needle", 1)), ["mixed-prose"]);
	assert.deepEqual(ids(await search("needle MATCHING PROSE\nsecond line", 1)), ["mixed-prose"]);
	assert.deepEqual(ids(await search("[assistant] needle MATCHING PROSE", 1)), ["mixed-prose"]);
	assert.deepEqual(ids(await search("lookup-only")), ["mixed-echo"]);
	assert.match(all, /\[window window\] \[mixed-call\]/);
	const read = await run(tools, "history", { op: "read", id: "mixed-call" }, context);
	assert.match(toolText(read), /needle ECHO/);
	assert.match(toolText(read), /MATCHING SIBLING/);
	const recovered = await run(tools, "history", { op: "read", id: "lookup" }, context);
	assert.match(toolText(recovered), /needle recovered output/);
	assert.deepEqual(recovered.content.slice(1), [image]);
});

test("archived history preserves Unicode separators across chunks and an unterminated final record", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-jsonl-"));
	try {
		const { tools, context: base } = setup();
		const body = `${"x".repeat(66_000)}unicode needle\u2028line\u2029paragraph`;
		const entries = [
			{ type: "context_window", id: "unicode-window", parentId: null, handoff: "prior\u2028checkpoint" },
			{ type: "message", id: "unicode", parentId: "unicode-window", message: { role: "user", content: body } },
			{ type: "message", id: "last", parentId: "unicode", message: { role: "user", content: "final needle\u2029tail" } },
		];
		writeFileSync(join(dir, "session.jsonl"), entries.map((entry) => JSON.stringify(entry)).join("\r\n"));
		const context = { ...base, sessionManager: { getBranch: () => [], getSessionDir: () => dir } };
		const hits = toolText(await run(tools, "history", { op: "search", query: "needle", all: true }, context));
		assert.match(hits, /\[window unicode-window\] \[unicode\]/);
		assert.match(hits, /\[window unicode-window\] \[last\]/);
		const read = toolText(await run(tools, "history", { op: "read", id: "unicode", offset: 66_000 }, context));
		assert.ok(read.endsWith(body.slice(66_000 - "[user] ".length)));
		assert.ok(toolText(await run(tools, "history", { op: "read", id: "last" }, context)).endsWith("[user] final needle\u2029tail"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("history preserves assistant failures and ranks them ahead of recovery echoes", async () => {
	const { tools, context: base } = setup();
	const branch = [
		{ type: "message", id: "failed", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "HTTP 429 QUOTA_EXCEEDED" } },
		{ type: "message", id: "partial", message: { role: "assistant", content: [
			{ type: "text", text: "Partial response" },
			{ type: "toolCall", name: "history", arguments: { op: "search", query: "prior state" } },
		], stopReason: "aborted", errorMessage: "QUOTA_EXCEEDED while streaming" } },
		{ type: "message", id: "echo", message: { role: "toolResult", toolName: "notes", content: "QUOTA_EXCEEDED copied into notes" } },
	];
	const context = { ...base, sessionManager: { getBranch: () => branch, getSessionDir: () => join(tmpdir(), "missing") } };
	assert.ok(toolText(await run(tools, "history", { op: "read", id: "failed" }, context)).endsWith("[assistant] [error] HTTP 429 QUOTA_EXCEEDED"));
	const partial = toolText(await run(tools, "history", { op: "read", id: "partial" }, context));
	assert.match(partial, /Partial response/);
	assert.match(partial, /\[aborted\] QUOTA_EXCEEDED while streaming/);
	const hit = toolText(await run(tools, "history", { op: "search", query: "QUOTA_EXCEEDED", limit: 1 }, context));
	assert.match(hit, /\[partial\] \[assistant\] \[aborted\] QUOTA_EXCEEDED while streaming/);
	assert.doesNotMatch(hit, /\[echo\]/);
});

test("all-session ranking keeps older originals ahead of newer echoes before applying the result limit", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-ranking-test-"));
	try {
		const old = { type: "message", id: "old", message: { role: "user", content: "needle oldest original" } };
		const newer = { type: "message", id: "newer", message: { role: "toolResult", toolName: "bash", content: "needle newer original" } };
		const echoes = Array.from({ length: 6 }, (_, index) => ({
			type: "message", id: `echo-${index}`, message: { role: "toolResult", toolName: "history", content: `needle echo-only ${index}` },
		}));
		for (const [index, entries] of [[old], [newer, ...echoes], [echoes[5]]].entries()) {
			const file = join(dir, `${index}.jsonl`);
			writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n"));
			utimesSync(file, new Date((index + 1) * 1000), new Date((index + 1) * 1000));
		}
		const { tools, context: base } = setup();
		const context = { ...base, sessionManager: { getBranch: () => [], getSessionDir: () => dir } };
		const search = async (query: string, limit: number) => toolText(await run(tools, "history", { op: "search", query, all: true, limit }, context));
		const ids = (text: string) => [...text.matchAll(/\[window initial\] \[([^\]]+)\]/g)].map((match) => match[1]);
		assert.deepEqual(ids(await search("needle", 1)), ["newer"]);
		assert.deepEqual(ids(await search("needle", 2)), ["newer", "old"]);
		assert.deepEqual(ids(await search("needle", 4)), ["newer", "old", "echo-5", "echo-4"]);
		const all = await search("needle", 50);
		assert.deepEqual(ids(all), ["newer", "old", ...echoes.map((entry) => entry.id).reverse()]);
		assert.match(all, /2\.jsonl[^\n]+\[echo-5\]/, "fork copies use the newest file");
		assert.deepEqual(ids(await search("echo-only", 2)), ["echo-5", "echo-4"]);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(tools.get("history")!.execute("id", { op: "search", query: "needle", all: true }, controller.signal, () => {}, context), { name: "AbortError" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a persisted legacy headroom-reminder still deduplicates, and a model switch invalidates it", () => {
	const { handlers, messages, context: base } = setup();
	const branch: Record<string, unknown>[] = [
		{ type: "context_window", id: "window-2" },
		{ type: "custom_message", id: "legacy", customType: "headroom-reminder", details: { windowId: "window-2" } },
	];
	const context = { ...usageContext(base, 100_000, 76_000), sessionManager: { getBranch: () => branch, getSessionDir: () => tmpdir() } };
	turnEnd(handlers, context);
	assert.equal(messages.length, 0, "legacy reminder in the same window counts");

	branch.push({ type: "model_change", id: "switch", provider: "test", modelId: "larger" });
	const switched = { ...context, ...usageContext(base, 200_000, 175_000), sessionManager: context.sessionManager };
	turnEnd(handlers, switched);
	assert.equal(messages.length, 1);
	assert.deepEqual(messages[0].details, { windowId: "window-2", contextWindow: 200_000, reserveTokens: 16_384 });
	branch.push({ type: "custom_message", id: "current", customType: "posthorse-reminder", details: messages[0].details });
	turnEnd(handlers, switched);
	assert.equal(messages.length, 1, "one reminder per window and budget");

	const marker = { role: "custom", customType: "context-window", content: "new", details: { windowId: "window-2" } };
	const legacy = { role: "custom", customType: "headroom-reminder", content: "legacy", details: { windowId: "window-2" } };
	const current = { role: "custom", customType: "posthorse-reminder", content: "current", details: messages[0].details };
	const filtered = handlers.get("context")!({ messages: [marker, legacy, current] }, switched) as { messages: unknown[] };
	assert.deepEqual(filtered.messages, [marker, current]);
});

test("new_context beside a failed sibling tool does not suppress the reminder", () => {
	const { handlers, messages, context: base } = setup();
	const context = usageContext(base, 100_000, 76_000);
	turnEnd(handlers, context, [{ toolName: "new_context" }, { toolName: "bash", isError: true }]);
	assert.equal(messages.length, 1, "Pi will not commit the boundary, so the checkpoint reminder still applies");
	messages.length = 0;
	turnEnd(handlers, context, [{ toolName: "new_context" }, { toolName: "bash", isError: false }]);
	assert.equal(messages.length, 0, "a fully successful batch rolls over; no reminder needed");
});

test("automatic handoff carries only the trailing incomplete-response tool batch, with entry ids and no base64", () => {
	const { handlers, context } = setup();
	const image = { type: "image", data: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=", mimeType: "image/png" };
	const batch: Record<string, unknown>[] = [
		{ type: "context_window", id: "older-window", handoff: "FIRST read obsolete-checkpoint.md" },
		{ type: "message", id: "owner", timestamp: "1", message: { role: "user", content: "run the checks" } },
		{
			type: "message",
			id: "assistant-1",
			timestamp: "2",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "ASSISTANT PROSE" },
					{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "npm test" } },
					{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "missing.txt" } },
					{ type: "toolCall", id: "call-3", name: "screenshot", arguments: {} },
				],
			},
		},
		{ type: "message", id: "result-1", timestamp: "3", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: `3 tests failed FAILURE DETAIL ${"z".repeat(30_000)} FAILURE TAIL` }] } },
		{ type: "message", id: "result-2", timestamp: "4", message: { role: "toolResult", toolCallId: "call-2", toolName: "read", isError: true, content: "ENOENT missing.txt" } },
		{ type: "message", id: "result-3", timestamp: "5", message: { role: "toolResult", toolCallId: "call-3", toolName: "screenshot", content: [image] } },
	];
	const handoff = automaticHandoff(handlers, context, batch);
	assert.ok(handoff.length <= 20_000);
	assert.match(handoff, /Trailing tool batch without a later complete assistant response \(failed or interrupted requests may already have received these results\)/);
	assert.match(handoff, /Tool-call entry assistant-1/);
	assert.match(handoff, /\[result entry result-1\]\n3 tests failed FAILURE DETAIL/);
	assert.match(handoff, /Call arguments: \{"command":"npm test"\}/);
	assert.match(handoff, /middle omitted[\s\S]*FAILURE TAIL/);
	assert.match(handoff, /\[error entry result-2\]\nENOENT missing.txt/);
	assert.match(handoff, /\[result entry result-3\]\n\[1 image: image\/png\] — recover with history read id result-3/);
	assert.doesNotMatch(handoff, /ASSISTANT PROSE|QUJDREVG/);
	assert.ok(handoff.indexOf("entry result-1") < handoff.indexOf("entry result-2"), "results keep their order");
	assert.ok(handoff.indexOf("entry owner") < handoff.indexOf("Trailing tool batch"));
	assert.ok(handoff.indexOf("entry result-3") < handoff.indexOf("older checkpoint"));
	assert.match(handoff, /FIRST read obsolete-checkpoint\.md/);

	for (const stopReason of ["error", "aborted", "length"]) {
		const interrupted = automaticHandoff(handlers, context, [
			...batch,
			{ type: "message", id: "assistant-interrupted", timestamp: "6", message: { role: "assistant", stopReason, content: "I received these results" } },
		]);
		assert.match(interrupted, /Trailing tool batch/);
		assert.match(interrupted, /entry result-3/);
		assert.doesNotMatch(interrupted, /no model has seen|no model has consumed/);
	}

	const truncatedCall = automaticHandoff(handlers, context, [
		...batch,
		{
			type: "message",
			id: "assistant-length",
			timestamp: "6",
			message: {
				role: "assistant",
				stopReason: "length",
				content: [{ type: "toolCall", id: "truncated-call", name: "write", arguments: { path: "secret" } }],
			},
		},
		{
			type: "message",
			id: "truncated-result",
			timestamp: "7",
			message: { role: "toolResult", toolCallId: "truncated-call", toolName: "write", isError: true, content: "not executed" },
		},
	]);
	assert.doesNotMatch(truncatedCall, /Trailing tool batch|truncated-result|entry result-3/);

	const consumed = automaticHandoff(handlers, context, [
		...batch,
		{ type: "message", id: "assistant-2", timestamp: "6", message: { role: "assistant", stopReason: "stop", content: "All done." } },
	]);
	assert.doesNotMatch(consumed, /Trailing tool batch|FAILURE DETAIL|ENOENT/);
	assert.match(consumed, /run the checks/);

	const calls = Array.from({ length: 300 }, (_, index) => ({
		type: "toolCall",
		id: `stress-call-${index}`,
		name: "read",
		arguments: { path: `${index}.txt` },
	}));
	const resultIds = calls.map((_, index) => `00000000-0000-7000-8000-${index.toString().padStart(12, "0")}`);
	const stressed = automaticHandoff(handlers, context, [
		{ type: "context_window", id: "prior", handoff: "p".repeat(6000) },
		{ type: "message", id: "first-owner", timestamp: "1", message: { role: "user", content: "a".repeat(6000) } },
		{ type: "message", id: "latest-owner", timestamp: "2", message: { role: "user", content: "b".repeat(6000) } },
		{ type: "custom_message", id: "latest-input", timestamp: "3", customType: "intercom", content: "c".repeat(6000), display: true },
		{ type: "message", id: "stress-assistant", timestamp: "4", message: { role: "assistant", stopReason: "toolUse", content: calls } },
		...calls.map((call, index) => ({
			type: "message",
			id: resultIds[index],
			timestamp: `${index + 5}`,
			message: { role: "toolResult", toolCallId: call.id, toolName: call.name, content: `result ${index} ${"r".repeat(1000)}` },
		})),
	]);
	assert.ok(stressed.length <= 20_000);
	for (const id of resultIds) assert.match(stressed, new RegExp(`entry ${id}\\]`));
});

test("history returns stored images for a requested entry and summarizes them elsewhere", async () => {
	const { handlers, tools, context: base } = setup();
	const png = { type: "image", data: "UE5HREFUQQ==", mimeType: "image/png" };
	const jpeg = { type: "image", data: "SlBFR0RBVEE=", mimeType: "image/jpeg" };
	const webp = { type: "image", data: "V0VCUERBVEE=", mimeType: "image/webp" };
	const branch = [
		{ type: "message", id: "img-user", parentId: null, timestamp: "1", message: { role: "user", content: [png] } },
		{ type: "message", id: "img-tool", parentId: "img-user", timestamp: "2", message: { role: "toolResult", toolName: "screenshot", content: [jpeg] } },
		{ type: "message", id: "mixed", parentId: "img-tool", timestamp: "3", message: { role: "user", content: [{ type: "text", text: "look at this" }, webp, { type: "text", text: "and fix it" }] } },
	];
	const context = { ...base, sessionManager: { getBranch: () => branch, getSessionDir: () => join(tmpdir(), "missing") } };

	const user = await run(tools, "history", { op: "read", id: "img-user" }, context);
	assert.match(user.content[0].text!, /\[user\] \[1 image: image\/png\]/);
	assert.deepEqual(user.content.slice(1), [png]);
	const tool = await run(tools, "history", { op: "read", id: "img-tool" }, context);
	assert.match(tool.content[0].text!, /\[toolResult\] \[1 image: image\/jpeg\]/);
	assert.deepEqual(tool.content.slice(1), [jpeg]);
	const mixed = await run(tools, "history", { op: "read", id: "mixed" }, context);
	assert.match(mixed.content[0].text!, /look at this\nand fix it\n\[1 image: image\/webp\]/);
	assert.deepEqual(mixed.content.slice(1), [webp]);
	const laterPage = await run(tools, "history", { op: "read", id: "mixed", offset: 5 }, context);
	assert.equal(laterPage.content.length, 1, "images ride along with the first page only");

	const longImage = [{
		type: "message",
		id: "long-image",
		parentId: null,
		timestamp: "4",
		message: { role: "user", content: [{ type: "text", text: "z".repeat(25_000) }, png] },
	}];
	const tightImage = {
		...usageContext(base, 100_000, 82_117),
		sessionManager: { getBranch: () => longImage, getSessionDir: () => join(tmpdir(), "missing") },
	};
	await assert.rejects(run(tools, "history", { op: "read", id: "long-image" }, tightImage), /Too little context remains/);

	const search = toolText(await run(tools, "history", { op: "search", query: "image/" }, context));
	assert.match(search, /\[img-tool\] \[toolResult\] \[1 image: image\/jpeg\]/);
	assert.match(search, /\[img-user\] \[user\] \[1 image: image\/png\]/);
	assert.doesNotMatch(search, /UE5HREFUQQ|SlBFR0RBVEE/);

	const handoff = automaticHandoff(handlers, context, branch);
	assert.match(handoff, /\[owner input \| 1 \| entry img-user\]\n\[1 image: image\/png\] — recover with history read id img-user/);
	assert.match(handoff, /look at this\nand fix it\n\[1 image: image\/webp\] — recover with history read id mixed/);
	assert.doesNotMatch(handoff, /UE5HREFUQQ|SlBFR0RBVEE|V0VCUERBVEE/);
});

test("history image continuations preserve order, text, and retry offsets", async () => {
	for (const text of ["short", "x".repeat(25_000)]) {
		const { handlers, tools, context: base } = setup();
		const images = Array.from({ length: 13 }, (_, index) => ({ type: "image", mimeType: "image/png", data: Buffer.from(`image ${index}`).toString("base64") }));
		const context = {
			...usageContext(base, 32_000, 1_000),
			sessionManager: {
				getBranch: () => [{ type: "message", id: "images", message: { role: "user", content: [{ type: "text", text }, ...images] } }],
				getSessionDir: () => join(tmpdir(), "missing"),
			},
		};
		let offset = 0, imageOffset = 0;
		let recoveredText = "";
		const recoveredImages = [];
		for (let page = 0; page < 30; page++) {
			handlers.get("turn_start")!({}, context);
			const result = await run(tools, "history", { op: "read", id: "images", offset, imageOffset }, context);
			const display = result.details;
			assert.equal(display?.kind, "history-read");
			if (display?.kind !== "history-read") throw new Error("Missing history metadata");
			recoveredText += toolText(result).slice(display.headerLength, display.headerLength + display.end - display.offset);
			recoveredImages.push(...result.content.slice(1));
			const next = toolText(result).match(/and offset (\d+) and imageOffset (\d+)\./);
			if (!next) break;
			offset = Number(next[1]); imageOffset = Number(next[2]);
			assert.ok(offset > display.offset || imageOffset > (display.imageOffset ?? 0));
		}
		assert.equal(recoveredText, `[user] ${text}\n[13 images: image/png]`);
		assert.deepEqual(recoveredImages, images);
		await assert.rejects(run(tools, "history", { op: "read", id: "images", imageOffset: 14 }, context), /Image offset 14 is past the end/);
		const tight = usageContext(context, 32_000, 14_117);
		await assert.rejects(run(tools, "history", { op: "read", id: "images", offset: 5, imageOffset: 4 }, tight), /retry with offset 5 and imageOffset 4/);
	}
});

test("small-context configurations are unsupported; larger ones derive honest budgets", async () => {
	for (const contextWindow of [4096, 8_192, 16_384]) {
		const { handlers, tools, messages, context: base } = setup();
		const context = usageContext(base, contextWindow, contextWindow - 500);
		const guidance = handlers.get("before_agent_start")!({ systemPrompt: "base", systemPromptOptions: { forceSystemPrompt: "base", sections: {} } }, context) as { systemPrompt: string };
		assert.match(guidance.systemPrompt, /unsupported configuration/);
		assert.match(guidance.systemPrompt, /Lower compaction.reserveTokens in Pi settings or use a larger-context model/);
		assert.doesNotMatch(guidance.systemPrompt, /% used/);
		turnEnd(handlers, context);
		assert.equal(messages.length, 0, `${contextWindow}: no reminder`);
		assert.equal(handlers.get("session_before_auto_compact")!({ reason: "threshold", branchEntries: [] }, context), undefined, `${contextWindow}: Pi keeps its own compaction`);
		const remaining = toolText(await run(tools, "get_context_remaining", {}, context));
		assert.match(remaining, /unsupported configuration/);
		assert.match(remaining, /500 tokens until the configured context limit/);
		const rollover = await run(tools, "new_context", { handoff: "still works" }, context);
		assert.deepEqual(rollover.newContext, { handoff: "still works" });
		const oldLimit = Math.min(20_000, Math.floor(contextWindow / 2) * 4);
		if (oldLimit < 20_000) {
			await assert.rejects(
				run(tools, "new_context", { handoff: "x".repeat(oldLimit) }, context),
				/too large for the active model/i,
			);
		}
	}

	{
		const { handlers, messages, context: base } = setup();
		// 32,768 - 16,384 leaves 16,384 usable: line at 16,385 (50%), band 1,638 tokens wide.
		const context = usageContext(base, 32_768, 15_000);
		const guidance = handlers.get("before_agent_start")!({ systemPrompt: "base", systemPromptOptions: { forceSystemPrompt: "base", sections: {} } }, context) as { systemPrompt: string };
		assert.match(guidance.systemPrompt, /rollover line \(50% used\)/);
		turnEnd(handlers, context);
		assert.equal(messages.length, 1);
		assert.match(messages[0].content, /1,385 tokens remain/);
		assert.ok(handlers.get("session_before_auto_compact")!({ reason: "threshold", branchEntries: [] }, context));
	}

	{
		const { handlers, tools, context: base } = setup();
		const large = usageContext(base, 400_000, 1_000, 64_000);
		const guidance = handlers.get("before_agent_start")!({ systemPrompt: "base", systemPromptOptions: { forceSystemPrompt: "base", sections: {} } }, large) as { systemPrompt: string };
		assert.match(guidance.systemPrompt, /rollover line \(84% used\)/);
		assert.match(guidance.systemPrompt, /best available native estimate/);
		// A 272K window with a 64K reserve has its line at 208,001 (76%).
		const sol = usageContext(base, 272_000, 205_000, 64_000);
		assert.match((handlers.get("before_agent_start")!({ systemPrompt: "base", systemPromptOptions: { forceSystemPrompt: "base", sections: {} } }, sol) as { systemPrompt: string }).systemPrompt, /rollover line \(76% used\)/);
		assert.match(toolText(await run(tools, "get_context_remaining", {}, sol)), /^≈3,001 tokens until automatic rollover \(line at 208,001\); ≈67,000 tokens until the configured context limit/);
		const remaining = toolText(await run(tools, "get_context_remaining", {}, usageContext(base, 100_000, 36_000, 64_000)));
		assert.match(remaining, /^≈1 tokens until automatic rollover \(line at 36,001\); ≈64,000 tokens until the configured context limit \(36,000\/100,000 used, 36%\)\. Best available native estimate\.$/);
		const unknown = toolText(await run(tools, "get_context_remaining", {}, { ...base, getContextUsage: () => undefined }));
		assert.match(unknown, /not known until the next model response/);
	}
});

test("fresh payload budgets count the system prompt, pending input, and automatic handoff", async () => {
	const { handlers, tools, context: base } = setup();
	const context = {
		...usageContext(base, 32_768, 1000),
		getSystemPrompt: () => "s".repeat(60_000),
	};
	await assert.rejects(run(tools, "new_context", { handoff: "h".repeat(10_000) }, context), /limit 0/);
	assert.equal(
		handlers.get("session_before_auto_compact")!(
			{ reason: "threshold", branchEntries: [{ type: "message", id: "owner", message: { role: "user", content: "continue" } }] },
			context,
		),
		undefined,
	);
	const pendingContext = { ...usageContext(base, 32_768, 1000), getSystemPrompt: () => "" };
	const pendingEvent = {
		reason: "threshold",
		branchEntries: [],
		pendingMessages: [{ role: "user", content: "p".repeat(60_000) }],
	};
	assert.equal(handlers.get("session_before_auto_compact")!(pendingEvent, pendingContext), undefined);
	assert.ok(
		handlers.get("session_before_auto_compact")!(pendingEvent, base),
		"the handoff cap must not limit separate pending input that fits a larger fresh window",
	);
});

test("read pages shrink to the remaining budget and refuse unsafe pages while preserving the offset", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-page-test-"));
	try {
		const { tools, handlers, context: base } = setup();
		const branch = [{ type: "message", id: "long", parentId: null, timestamp: "1", message: { role: "user", content: "h".repeat(25_000) } }];
		const withBranch = (context: TestContext) => ({ ...context, cwd: dir, sessionManager: { getBranch: () => branch, getSessionDir: () => dir } });
		await run(tools, "notes", { op: "write", path: "long.md", content: "n".repeat(25_000) }, withBranch(base));

		// Line at 83,617; 1,500 tokens short of it leaves 500 tokens after the margin: a 2,000-character page.
		const tight = withBranch(usageContext(base, 100_000, 82_117));
		const note = toolText(await run(tools, "notes", { op: "read", path: "long.md" }, tight));
		assert.match(note, /^n{2000}\n\[chars 0-2000 of 25000; continue with offset 2000\]$/);
		// These compare independent reads at the same starting usage, not sibling calls.
		handlers.get("turn_start")?.({}, tight);
		const entry = toolText(await run(tools, "history", { op: "read", id: "long" }, tight));
		assert.match(entry, /\[chars 0-2000 of 25007\] \[user\] h{1993}\nMore remains; call history read with id "long" and offset 2000\.$/);

		const tighter = withBranch(usageContext(base, 100_000, 82_517));
		await assert.rejects(run(tools, "notes", { op: "read", path: "long.md", offset: 2000 }, tighter), /Call new_context first, then retry with offset 2000/);
		await assert.rejects(run(tools, "history", { op: "read", id: "long", offset: 2000 }, tighter), /Call new_context first, then retry with offset 2000/);

		// Disabled compaction measures against the configured context limit instead of the rollover line.
		const disabled = withBranch(usageContext(base, 100_000, 98_000, 16_384, false));
		assert.match(toolText(await run(tools, "notes", { op: "read", path: "long.md" }, disabled)), /continue with offset 4000/);
		const unknown = withBranch({ ...base, model: { contextWindow: 4096 }, getContextUsage: () => undefined });
		handlers.get("turn_start")?.({}, unknown);
		const unknownPage = toolText(await run(tools, "notes", { op: "read", path: "long.md" }, unknown));
		const unknownOffset = unknownPage.match(/continue with offset (\d+)/)?.[1];
		assert.ok(unknownOffset);
		assert.ok(Number(unknownOffset) < 8192);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("note and history pages share a batch budget without double-counting consumed pages", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-batch-pages-"));
	try {
		const { tools, handlers, context: base } = setup();
		let tokens = 98_000;
		const context = {
			...usageContext(base, 100_000, tokens, 16_384, false), cwd: dir,
			getContextUsage: () => ({ tokens, contextWindow: 100_000, percent: tokens / 1000 }),
			sessionManager: {
				getBranch: () => [{ type: "message", id: "long", message: { role: "user", content: "h".repeat(25_000) } }],
				getSessionDir: () => dir,
			},
		};
		await run(tools, "notes", { op: "write", path: "long.md", content: "n".repeat(25_000) }, context);
		await run(tools, "notes", { op: "write", path: "short.md", content: "s".repeat(800) }, context);
		const startTurn = () => handlers.get("turn_start")?.({}, context);
		startTurn();
		assert.match(toolText(await run(tools, "notes", { op: "read", path: "long.md" }, context)), /continue with offset 4000/);
		await assert.rejects(run(tools, "history", { op: "read", id: "long", offset: 4000 }, context), /retry with offset 4000/);
		startTurn();
		assert.match(toolText(await run(tools, "history", { op: "read", id: "long" }, context)), /offset 4000/);
		await assert.rejects(run(tools, "notes", { op: "read", path: "long.md", offset: 4000 }, context), /retry with offset 4000/);

		startTurn();
		tokens = 97_000;
		assert.equal(toolText(await run(tools, "notes", { op: "read", path: "short.md" }, context)), "s".repeat(800));
		// Serial execution has already added the 800-character result to native usage.
		tokens += 200;
		assert.match(toolText(await run(tools, "notes", { op: "read", path: "long.md" }, context)), /continue with offset 7200/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("notes list and search page every result through the shared budget, including oversized paths", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-search-pages-"));
	try {
		const { tools, handlers, context: base } = setup();
		const context = { ...usageContext(base, 100_000, 98_750, 16_384, false), cwd: dir };
		const root = join(dir, ".pi", "notes");
		const nested = Array.from({ length: 4 }, () => "d".repeat(180)).join("/");
		mkdirSync(join(root, nested), { recursive: true });
		const files = Array.from({ length: 120 }, (_, index) => `${index.toString().padStart(3, "0")}-${"n".repeat(180)}.md`);
		files.push(`${nested}/long-${"f".repeat(70)}.md`);
		for (const path of files) writeFileSync(join(root, path), `needle sample ${"s".repeat(180)}`);
		for (const op of ["list", "search"]) {
			const expectedRows = files.map((path) => op === "list" ? path : `${path}:1: needle sample ${"s".repeat(180)}`);
			const expected = expectedRows.join("\n");
			let offset = 0;
			let recovered = "";
			for (let page = 0; page < 100; page++) {
				handlers.get("turn_start")!({}, context);
				const result = await run(tools, "notes", { op, query: "needle", offset }, context);
				const display = result.details;
				assert.ok(display?.kind === "notes-list" || display?.kind === "notes-search");
				assert.ok(display.page, "list/search must expose continuation metadata");
				const { end, total } = display.page;
				const text = toolText(result);
				assert.ok(text.length <= 1000, "headers and continuation fit the admitted page");
				assert.equal(total, expected.length);
				let position = 0;
				const count = expectedRows.filter((row) => {
					const overlap = position < end && position + row.length > offset;
					position += row.length + 1;
					return overlap;
				}).length;
				assert.equal(display.count, count, "count describes only row portions actually returned");
				assert.ok(op !== "search" || count <= 20);
				recovered += text.slice(0, end - offset);
				assert.ok(end > offset);
				if (end === total) break;
				assert.match(text, new RegExp(`continue with offset ${end}`));
				offset = end;
			}
			assert.equal(recovered, expected, "no result tail is lost even when a single path spans pages");
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("mixed search/list/read outputs and no-match refusals share one reservation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-mixed-pages-"));
	try {
		const { tools, handlers, context: base } = setup();
		const branch = Array.from({ length: 60 }, (_, index) => ({ type: "message", id: `entry-${index}`, message: { role: "user", content: `needle ${"h".repeat(500)}` } }));
		const context = { ...usageContext(base, 100_000, 98_000, 16_384, false), cwd: dir, sessionManager: { getBranch: () => branch, getSessionDir: () => dir } };
		mkdirSync(join(dir, ".pi", "notes"), { recursive: true });
		writeFileSync(join(dir, ".pi", "notes", "long.md"), Array.from({ length: 60 }, () => `needle ${"n".repeat(300)}`).join("\n"));
		for (const first of ["history", "notes"]) {
			handlers.get("turn_start")!({}, context);
			const results = await Promise.allSettled([
				run(tools, first, { op: "search", query: "needle", limit: 50 }, context),
				run(tools, "notes", { op: "list" }, context),
				run(tools, "notes", { op: "read", path: "long.md" }, context),
				run(tools, "history", { op: "read", id: "entry-0" }, context),
			]);
			const text = results.map((result) => result.status === "fulfilled" ? toolText(result.value) : result.reason.message);
			assert.ok(text.reduce((total, value) => total + Math.ceil(value.length / 4), 0) <= 2000);
			assert.ok(results.some((result) => result.status === "rejected"));
		}
		handlers.get("turn_start")!({}, context);
		const hugeQuery = "absent".repeat(20_000);
		for (const tool of ["notes", "history"]) {
			const output = toolText(await run(tools, tool, { op: "search", query: hugeQuery }, context));
			assert.ok(output.length < 300, "a no-match echo cannot reprint an unbounded query");
			assert.match(output, /No (notes|history) match/);
		}
		const tight = { ...context, ...usageContext(context, 100_000, 99_750, 16_384, false) };
		handlers.get("turn_start")!({}, tight);
		let refusalTokens = 0;
		for (let index = 0; index < 20; index++) {
			await assert.rejects(run(tools, index % 2 ? "notes" : "history", { op: "search", query: hugeQuery, offset: 123 }, tight), (error: Error) => { refusalTokens += Math.ceil(error.message.length / 4); return true; });
		}
		assert.ok(refusalTokens <= 250, "even repeated no-match refusals stay inside the remaining budget");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("history cursors finish partial headers and progress past growing lookup echoes", async () => {
	const { tools, handlers, context: base } = setup();
	const branch: Record<string, unknown>[] = [
		{ type: "message", id: "old", timestamp: "1", message: { role: "user", content: "needle oldest" } },
		{ type: "message", id: "long", parentId: "old", timestamp: "T".repeat(4000), message: { role: "user", content: "needle long metadata" } },
		{ type: "message", id: "echo", parentId: "long", message: { role: "toolResult", toolName: "history", content: "needle prior lookup" } },
	];
	const context = { ...usageContext(base, 100_000, 98_700, 16_384, false), sessionManager: { getBranch: () => branch, getSessionDir: () => join(tmpdir(), "missing") } };
	let cursor: string | undefined;
	let recovered = "";
	const returned: string[] = [];
	let pages = 0;
	for (; pages < 20; pages++) {
		handlers.get("turn_start")!({}, context);
		branch.push({ type: "message", id: `call-${pages}`, message: { role: "assistant", content: [{ type: "toolCall", name: "history", arguments: { op: "search", query: "needle", cursor } }] } });
		const result = await run(tools, "history", { op: "search", query: "needle", limit: 1, cursor }, context);
		const output = toolText(result);
		assert.ok(output.length <= 1200);
		assert.equal(result.details?.kind, "history-search");
		if (result.details?.kind !== "history-search") throw new Error("missing history spans");
		assert.equal(result.details.entries.reduce((sum, span) => sum + span.length + 1, -1), output.length - (result.details.footerLength ?? 0));
		for (const span of result.details.entries) assert.ok(span.headerLength >= 0 && span.headerLength <= span.length);
		const body = output.slice(0, output.length - (result.details.footerLength ?? 0));
		const id = body.match(/^\[entry ([^;]+); from char \d+\]/)?.[1] ?? body.match(/\[window [^\]]+\] \[([^\]]+)\]/)?.[1];
		assert.ok(id, "every partial page keeps a usable native entry id");
		returned.push(id);
		if (id === "old" || id === "long") recovered += body.replace(/^\[entry [^;]+; from char \d+\] /, "");
		branch.push({ type: "message", id: `result-${pages}`, message: { role: "toolResult", toolName: "history", content: output } });
		const next = output.match(/\[More results; continue with cursor "([^"]+)" and the same query\/scope\.\]$/)?.[1];
		assert.notEqual(next, cursor || "never", "every continued page advances");
		if (!next) break;
		cursor = next;
	}
	assert.ok(pages < 20, `new echoes must not keep the search alive forever: ${JSON.stringify(returned)}`);
	assert.match(recovered, new RegExp(`T{4000} \\[window initial\\] \\[long\\] \\[user\\] needle long metadata`));
	assert.equal(recovered.match(/\[old\] \[user\] needle oldest/g)?.length, 1);
	assert.equal(returned.filter((id) => id === "echo").length, 1);
	assert.equal(returned.filter((id) => id === "old").length, 1);
	for (const params of [{ query: "different", cursor }, { query: "needle", cursor, all: true }, { query: "needle", cursor: "not-json" }]) {
		handlers.get("turn_start")!({}, context);
		await assert.rejects(run(tools, "history", { op: "search", ...params }, context), /Invalid history cursor/);
	}
});

test("all-session cursors retain ranking and fork deduplication across pages", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-cursor-forks-"));
	try {
		const { tools, handlers, context: base } = setup();
		const original = { type: "message", id: "shared", message: { role: "user", content: "needle shared ancestor" } };
		const older = [original, { type: "message", id: "older", message: { role: "user", content: "needle older source" } }];
		const current: Record<string, unknown>[] = [original, { type: "message", id: "newer", message: { role: "user", content: "needle newer source" } }, { type: "message", id: "prior-echo", message: { role: "toolResult", toolName: "notes", content: "needle prior echo" } }];
		const oldFile = join(dir, "old.jsonl"), activeFile = join(dir, "current.jsonl");
		writeFileSync(oldFile, older.map((entry) => JSON.stringify(entry)).join("\n"));
		const context = { ...base, sessionManager: { getBranch: () => [], getSessionDir: () => dir } };
		let cursor: string | undefined;
		const ids: string[] = [];
		for (let page = 0; page < 20; page++) {
			handlers.get("turn_start")!({}, context);
			current.push({ type: "message", id: `lookup-${page}`, message: { role: "assistant", content: [{ type: "toolCall", name: "history", arguments: { op: "search", query: "needle", cursor } }] } });
			writeFileSync(activeFile, current.map((entry) => JSON.stringify(entry)).join("\n"));
			utimesSync(oldFile, new Date(1000), new Date(1000));
			utimesSync(activeFile, new Date(2000 + page), new Date(2000 + page));
			const result = await run(tools, "history", { op: "search", query: "needle", limit: 1, all: true, cursor }, context);
			const text = toolText(result);
			ids.push(text.match(/^[^\n]*?\[window [^\]]+\] \[([^\]]+)\]/)![1]);
			current.push({ type: "message", id: `result-${page}`, message: { role: "toolResult", toolName: "history", content: text } });
			const next = text.match(/\[More results; continue with cursor "([^"]+)" and the same query\/scope\.\]$/)?.[1];
			if (!next) break;
			cursor = next;
		}
		assert.deepEqual(ids.slice(0, 3), ["newer", "shared", "older"]);
		assert.equal(new Set(ids).size, ids.length);
		assert.ok(ids.includes("prior-echo"), "pagination reaches the oldest echo and terminates");
		assert.ok(ids.length < 20);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("note replacement keeps the existing checkpoint on a real file-size failure", { skip: process.platform === "win32" }, () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-write-failure-"));
	try {
		const notesDir = join(dir, ".pi", "notes");
		mkdirSync(notesDir, { recursive: true });
		const path = join(notesDir, "durable.md");
		writeFileSync(path, "original checkpoint");
		const code = `import assert from "node:assert/strict";
import posthorse from ${JSON.stringify(new URL("../index.ts", import.meta.url).href)};
let notes;
posthorse({ on() {}, registerMessageRenderer() {}, registerTool(tool) { if (tool.name === "notes") notes = tool; } });
process.on("SIGXFSZ", () => {});
await assert.rejects(notes.execute("fault", { op: "write", path: "durable.md", content: "N".repeat(8192) }, new AbortController().signal, undefined, { cwd: process.cwd() }), { code: "EFBIG" });`;
		execFileSync("/bin/bash", ["-c", 'ulimit -f 2; exec "$@"', "note-publication", process.execPath, "--input-type=module", "-e", code], {
			cwd: dir,
			env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, PI_CODING_AGENT_DIR: join(dir, "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0", NODE_DISABLE_COMPILE_CACHE: "1", NODE_OPTIONS: process.env.NODE_OPTIONS, PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR },
			encoding: "utf8", timeout: 30_000,
		});
		assert.equal(readFileSync(path, "utf8"), "original checkpoint");
		assert.deepEqual(readdirSync(notesDir), ["durable.md"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("notes resolve the repository root from nested directories, worktrees, and plain folders", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-root-test-"));
	try {
		const repo = join(dir, "repo");
		const main = join(dir, "main");
		const worktree = join(dir, "wt");
		const plain = join(dir, "plain", "sub");
		mkdirSync(join(repo, ".git"), { recursive: true });
		mkdirSync(join(repo, "packages", "app"), { recursive: true });
		mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
		writeFileSync(join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
		mkdirSync(join(worktree, "packages", "app"), { recursive: true });
		writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
		mkdirSync(plain, { recursive: true });
		const { tools, context } = setup();
		const notes = (cwd: string, params: Record<string, unknown>) => run(tools, "notes", params, { ...context, cwd });
		const write = (cwd: string) => notes(cwd, { op: "write", path: "state.md", content: cwd });

		await write(join(repo, "packages", "app"));
		assert.equal(readFileSync(join(repo, ".pi", "notes", "state.md"), "utf8"), join(repo, "packages", "app"));
		assert.equal(existsSync(join(repo, "packages", "app", ".pi")), false);
		await write(worktree);
		assert.equal(readFileSync(join(main, ".pi", "notes", "state.md"), "utf8"), worktree);
		assert.equal(toolText(await notes(worktree, { op: "list" })), "state.md");
		writeFileSync(join(worktree, ".git"), "gitdir: ../main/.git/worktrees/wt\n");
		await write(join(worktree, "packages", "app"));
		assert.equal(readFileSync(join(main, ".pi", "notes", "state.md"), "utf8"), join(worktree, "packages", "app"));
		assert.equal(existsSync(join(worktree, ".pi")), false);
		await write(plain);
		assert.equal(readFileSync(join(plain, ".pi", "notes", "state.md"), "utf8"), plain);

		// A copied or orphaned worktree must still be able to keep local notes.
		const orphan = join(dir, "orphan");
		mkdirSync(join(orphan, "nested"), { recursive: true });
		writeFileSync(join(orphan, ".git"), "gitdir: ../missing/.git/worktrees/orphan\n");
		await write(join(orphan, "nested"));
		assert.equal(readFileSync(join(orphan, ".pi", "notes", "state.md"), "utf8"), join(orphan, "nested"));
		assert.equal(toolText(await notes(orphan, { op: "read", path: "state.md" })), join(orphan, "nested"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

for (const marker of ["file", "directory symlink"]) test(`separate Git directories share notes and preserve old local notes (${marker})`, async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-posthorse-separate-git-")));
	try {
		const main = join(dir, "main");
		const gitdir = join(dir, "git-storage");
		const worktree = join(dir, "worktree");
		const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe" });
		git("init", "--separate-git-dir", gitdir, main);
		if (marker === "directory symlink") {
			unlinkSync(join(main, ".git"));
			symlinkSync(gitdir, join(main, ".git"), "dir");
		}
		git("-C", main, "-c", "user.name=Posthorse test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "--allow-empty", "-m", "fixture");
		git("-C", main, "worktree", "add", "--detach", worktree);
		const { tools, context } = setup();
		const notes = (cwd: string, params: Record<string, unknown>) => run(tools, "notes", params, { ...context, cwd });
		mkdirSync(join(main, ".pi", "notes"), { recursive: true });
		writeFileSync(join(main, ".pi", "notes", "shared.md"), "original state");
		assert.equal(toolText(await notes(main, { op: "read", path: "shared.md" })), "original state");
		assert.equal(toolText(await notes(worktree, { op: "read", path: "shared.md" })), "original state");
		const append = toolText(await notes(worktree, { op: "append", path: "shared.md", content: "worktree update" }));
		assert.ok(append.includes(join(gitdir, ".pi", "notes", "shared.md")));
		assert.equal(toolText(await notes(main, { op: "read", path: "shared.md" })), "original state\nworktree update\n");
		assert.equal(readFileSync(join(main, ".pi", "notes", "shared.md"), "utf8"), "original state", "legacy originals stay intact");
		assert.equal(existsSync(join(worktree, ".pi")), false, "new writes do not create a worktree-local copy");

		mkdirSync(join(worktree, ".pi", "notes", "nested"), { recursive: true });
		writeFileSync(join(worktree, ".pi", "notes", "shared.md"), "older divergent copy");
		writeFileSync(join(worktree, ".pi", "notes", "nested", "worker.md"), "old worker note");
		assert.equal(toolText(await notes(worktree, { op: "read", path: "nested/worker.md" })), "old worker note");
		assert.equal(toolText(await notes(worktree, { op: "read", path: "shared.md" })), "original state\nworktree update\n");
		await notes(main, { op: "write", path: "shared.md", content: "" });
		assert.equal(toolText(await notes(worktree, { op: "read", path: "shared.md" })), "", "imports cannot resurrect a cleared note");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("long notes page fully, empty writes clear, appends stay separated, and search centers on the match", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-notes-ops-test-"));
	try {
		const { tools, context: base } = setup();
		const context = { ...base, cwd: dir };
		const notes = (params: Record<string, unknown>) => run(tools, "notes", params, context);
		const body = `${"a".repeat(20_000)}${"b".repeat(20_000)}${"c".repeat(5_000)}`;
		await notes({ op: "write", path: "big.md", content: body });
		const first = toolText(await notes({ op: "read", path: "big.md" }));
		assert.match(first, /^a{20000}\n\[chars 0-20000 of 45000; continue with offset 20000\]$/);
		const second = toolText(await notes({ op: "read", path: "big.md", offset: 20_000 }));
		assert.match(second, /^b{20000}\n\[chars 20000-40000 of 45000; continue with offset 40000\]$/);
		const third = toolText(await notes({ op: "read", path: "big.md", offset: 40_000 }));
		assert.equal(third, "c".repeat(5_000));
		await assert.rejects(notes({ op: "read", path: "big.md", offset: 45_000 }), /past the end/);

		await notes({ op: "write", path: "big.md", content: "" });
		assert.equal(readFileSync(join(dir, ".pi", "notes", "big.md"), "utf8"), "");
		assert.equal(toolText(await notes({ op: "read", path: "big.md" })), "");
		await assert.rejects(notes({ op: "write", path: "big.md" }), /"content" is required for op "write"/);

		await notes({ op: "append", path: "log.md", content: "A" });
		await notes({ op: "append", path: "log.md", content: "B\n" });
		assert.equal(readFileSync(join(dir, ".pi", "notes", "log.md"), "utf8"), "A\nB\n");
		await notes({ op: "write", path: "log.md", content: "X" });
		await notes({ op: "append", path: "log.md", content: "Y" });
		assert.equal(readFileSync(join(dir, ".pi", "notes", "log.md"), "utf8"), "X\nY\n");
		await assert.rejects(notes({ op: "append", path: "log.md", content: "" }), /"content" is required/);

		await notes({ op: "write", path: "search.md", content: `${" ".repeat(100)}${"x".repeat(250)} needle-here ${"y".repeat(100)}\nsecond line` });
		const hits = toolText(await notes({ op: "search", query: "NEEDLE-here" }));
		assert.match(hits, /^search\.md:1: …x{49} needle-here y{100}$/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("history flattens bashExecution entries and honors excludeFromContext", async () => {
	const { tools, context: base } = setup();
	const branch = [
		{ type: "message", id: "sh", parentId: null, timestamp: "1", message: { role: "bashExecution", command: "ls -la", output: "total 0\nnotes.md" } },
		{ type: "message", id: "hidden", parentId: "sh", timestamp: "2", message: { role: "bashExecution", command: "cat token", output: "TOPSECRET", excludeFromContext: true } },
	];
	const context = { ...base, sessionManager: { getBranch: () => branch, getSessionDir: () => join(tmpdir(), "missing") } };
	assert.match(toolText(await run(tools, "history", { op: "search", query: "notes.md" }, context)), /\[sh\] \[bashExecution\] \$ ls -la\ntotal 0\nnotes\.md/);
	assert.match(toolText(await run(tools, "history", { op: "read", id: "sh" }, context)), /\[bashExecution\] \$ ls -la\ntotal 0\nnotes\.md$/);
	assert.match(toolText(await run(tools, "history", { op: "search", query: "TOPSECRET" }, context)), /No history matches/);
	assert.match(toolText(await run(tools, "history", { op: "search", query: "cat token" }, context)), /No history matches/);
	const hidden = toolText(await run(tools, "history", { op: "read", id: "hidden" }, context));
	assert.match(hidden, /\[bashExecution\] \(excluded from model context by Pi\)$/);
	assert.doesNotMatch(hidden, /TOPSECRET|cat token/);
});

test("all-session search reports a fork-copied entry once, from the newest-modified session", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-fork-test-"));
	try {
		const original = join(dir, "original.jsonl");
		const fork = join(dir, "fork.jsonl");
		const shared = JSON.stringify({ type: "message", id: "shared", parentId: null, timestamp: "1", message: { role: "user", content: "fork needle shared" } });
		writeFileSync(original, shared);
		writeFileSync(fork, [shared, JSON.stringify({ type: "message", id: "fork-new", parentId: "shared", timestamp: "2", message: { role: "user", content: "fork needle newer" } })].join("\n"));
		utimesSync(original, new Date(1_000), new Date(1_000));
		utimesSync(fork, new Date(2_000), new Date(2_000));
		const { tools, context: base } = setup();
		const context = { ...base, sessionManager: { getBranch: () => [], getSessionDir: () => dir } };
		const text = toolText(await run(tools, "history", { op: "search", query: "fork needle", all: true, limit: 5 }, context));
		assert.deepEqual(
			text.split("\n").map((line) => line.split(" ").slice(0, 1)[0] + line.match(/\[[a-z-]+\] \[/)?.[0]),
			["fork.jsonl[fork-new] [", "fork.jsonl[shared] ["],
		);
		assert.equal(text.match(/\[shared\]/g)?.length, 1);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("session search and archived reads preserve modification-time ordering including ties", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-mtime-test-"));
	try {
		for (const [name, mtime] of [["z", 1000], ["m", 2000], ["a", 2000]] as const) {
			const file = join(dir, `${name}.jsonl`);
			writeFileSync(file, [
				{ type: "message", id: "shared", message: { role: "user", content: "shared ancestor" } },
				{ type: "message", id: name, parentId: "shared", message: { role: "user", content: "mtime needle" } },
			].map((entry) => JSON.stringify(entry)).join("\n"));
			utimesSync(file, new Date(mtime), new Date(mtime));
		}
		const expected = readdirSync(dir).sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
		const { tools, context: base } = setup();
		const context = { ...base, sessionManager: { getBranch: () => [], getSessionDir: () => dir } };
		const search = toolText(await run(tools, "history", { op: "search", query: "mtime needle", all: true }, context));
		assert.deepEqual(search.split("\n").map((line) => line.split(" ")[0]), expected);
		const read = toolText(await run(tools, "history", { op: "read", id: "shared" }, context));
		assert.equal(read.split(" ")[0], expected[0]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("appends from concurrent Pi processes never merge records", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-posthorse-concurrent-append-"));
	try {
		// Each child loads the real extension and appends 200 records to one shared note as fast as it can.
		const script = `
			await import(${JSON.stringify(new URL("./pi-loader.ts", import.meta.url).href)});
			const { default: posthorse } = await import(${JSON.stringify(new URL("../index.ts", import.meta.url).href)});
			const tools = new Map();
			posthorse({ on() {}, registerTool: (tool) => tools.set(tool.name, tool), registerMessageRenderer() {}, sendMessage() {} });
			const [cwd, letter] = process.argv.slice(1);
			const context = { cwd, newContext() {}, getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384 }), getContextUsage: () => undefined };
			for (let i = 0; i < 200; i++) {
				await tools.get("notes").execute("id", { op: "append", path: "shared.md", content: letter.repeat(300) }, undefined, () => {}, context);
			}
		`;
		await Promise.all(
			["A", "B"].map(
				(letter) =>
					new Promise<void>((resolve, reject) => {
						execFile(process.execPath, ["--input-type=module", "-e", script, dir, letter], (error, _stdout, stderr) =>
							error ? reject(new Error(stderr || error.message)) : resolve(),
						);
					}),
			),
		);
		const lines = readFileSync(join(dir, ".pi", "notes", "shared.md"), "utf8").split("\n");
		assert.equal(lines.pop(), "", "file ends with a newline");
		// A torn read of an in-flight append may add a blank separator line; records themselves never merge.
		const records = lines.filter(Boolean);
		assert.equal(records.length, 400);
		assert.ok(records.every((line) => line === "A".repeat(300) || line === "B".repeat(300)), "every record is intact");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
