import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
const hostIndex = process.env.PI_HOST_INDEX ? pathToFileURL(process.env.PI_HOST_INDEX).href : import.meta.resolve("@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(hostIndex);

// Resolve the faux provider from the selected host's graph as well.
const aiManifest = pathToFileURL(findPackageJSON("@earendil-works/pi-ai", hostIndex));
const aiPackage = JSON.parse(readFileSync(aiManifest, "utf8"));
const { fauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, InMemoryCredentialStore } = await import(new URL(aiPackage.exports["."].import, aiManifest).href);
const root = fileURLToPath(new URL("..", import.meta.url));
const textOf = (message) => typeof message?.content === "string" ? message.content : message?.content?.map((part) => part.text ?? "").join("\n") ?? "";
const nextCursor = (text) => text.match(/\[More results; continue with cursor "([^"]+)" and the same query\/scope\.\]$/)?.[1];

async function fixture(t, options = {}) {
	const evidence = process.env.PI_COMPAT_EVIDENCE_DIR ?? tmpdir();
	mkdirSync(evidence, { recursive: true });
	const temp = mkdtempSync(join(evidence, "posthorse-regression-"));
	t.diagnostic(`fixture: ${temp}`);
	const cwd = join(temp, "project"), agentDir = join(temp, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	const faux = fauxProvider({ models: [{ id: "posthorse-regression", contextWindow: options.contextWindow ?? 100_000, maxTokens: 1000 }] });
	const setResponses = faux.setResponses;
	faux.setResponses = (steps) => setResponses(steps.map((step) => (ctx, opts) => {
		// Avoid faux's synthetic first-prompt input/cache-write double count in capacity checks.
		opts.cacheRetention = "none";
		return typeof step === "function" ? step(ctx, opts) : step;
	}));
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: options.enabled ?? true, reserveTokens: 16_384 }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [join(root, "index.ts")],
		systemPromptOverride: options.customPrompt ? () => options.customPrompt : undefined,
		extensionFactories: [(pi) => { pi.registerProvider(faux.provider); options.extension?.(pi); }],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const sessionManager = SessionManager.create(cwd, join(temp, "sessions"));
	options.seed?.(sessionManager);
	const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader, settingsManager, sessionManager, noTools: "builtin" });
	t.after(() => session.dispose());
	await session.bindExtensions({ onError(error) { throw new Error(error.error); } });
	return { cwd, session, faux, sessionManager, settingsManager, resourceLoader };
}


test("history recovers every image across pages and fresh contexts", async (t) => {
	const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=" };
	const images = Array.from({ length: 13 }, () => ({ ...image }));
	let id;
	const { session, faux, sessionManager } = await fixture(t, {
		contextWindow: 32_000,
		seed(manager) {
			id = manager.appendMessage({ role: "user", content: [{ type: "text", text: "Screenshots to recover" }, ...images], timestamp: Date.now() });
			manager.appendContextWindow("Recover the earlier screenshots.", null);
		},
	});
	let offset = 0, imageOffset = 0;
	const recovered = [];
	for (let page = 0; page < images.length; page++) {
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("history", { op: "read", id, offset, imageOffset }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("new_context", { handoff: "Continue recovering screenshots." }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Page recovered."),
		]);
		await session.prompt("Recover the next page, then start a fresh context.");
		const result = sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "history").message;
		assert.equal(result.isError, false, textOf(result));
		const returned = result.content.filter((part) => part.type === "image");
		assert.ok(returned.length > 0 && returned.length < images.length, "bounded pages must make image progress");
		recovered.push(...returned);
		const next = textOf(result).match(/and offset (\d+) and imageOffset (\d+)\./);
		if (!next) break;
		offset = Number(next[1]); imageOffset = Number(next[2]);
		assert.equal(imageOffset, recovered.length);
		assert.ok(offset > 0, "image-only pages retain the completed text offset");
	}
	assert.deepEqual(recovered, images);
});

test("native fork rollover retains recovery history and survives a checkpoint restore", async (t) => {
	const evidence = process.env.PI_COMPAT_EVIDENCE_DIR ?? tmpdir();
	mkdirSync(evidence, { recursive: true });
	const temp = mkdtempSync(join(evidence, "posthorse-native-"));
	// Retain the native journal for failure inspection; this is never the user's profile.
	t.diagnostic(`fixture: ${temp}`);
	const cwd = join(temp, "project");
	const agentDir = join(temp, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const faux = fauxProvider({ models: [{ id: "posthorse-native", contextWindow: 128_000, maxTokens: 1000 }] });
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 16_384 }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [join(root, "index.ts")],
		extensionFactories: [(pi) => {
			pi.registerProvider(faux.provider);
			pi.registerTool({
				name: "dump", label: "dump", description: "Local oversized result",
				parameters: { type: "object", properties: {} },
				async execute() { return { content: [{ type: "text", text: `DUMP HEAD ${"r".repeat(600_000)} DUMP TAIL` }], details: {} }; },
			});
		}],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const sessionManager = SessionManager.create(cwd, join(temp, "sessions"));
	const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader, settingsManager, sessionManager });
	t.after(() => session.dispose());
	const context = session.extensionRunner.createContext();
	for (const method of ["newContext", "getCompactionSettings"]) {
		assert.equal(typeof context[method], "function", `Posthorse requires the fork's native ${method}; official refusal is checked separately`);
	}
	assert.equal(typeof session.acquireCheckpoint, "function", "Fork qualification must not silently skip checkpoints");
	await session.bindExtensions({ onError(error) { throw new Error(error.error); } });
	let recovery;
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("dump", {}), { stopReason: "toolUse" }),
		(ctx) => {
			recovery = ctx.messages.filter((message) => message.role !== "system");
			const result = [...sessionManager.getBranch()].reverse().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "dump");
			assert.ok(result);
			return fauxAssistantMessage(fauxToolCall("history", { op: "read", id: result.id }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("recovered"),
	]);
	await session.prompt("dump everything");
	assert.equal(faux.getPendingResponseCount(), 0);
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "context_window").length, 1);
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
	assert.equal(recovery.length, 1);
	assert.match(JSON.stringify(recovery), /Automatic context rollover recovery record/);
	assert.match(JSON.stringify(recovery), /Trailing tool batch/);
	assert.match(JSON.stringify(recovery), /DUMP HEAD/);
	assert.match(JSON.stringify(recovery), /DUMP TAIL/);
	const history = session.messages.find((message) => message.role === "toolResult" && message.toolName === "history");
	assert.ok(history && !history.isError);
	assert.match(JSON.stringify(history.content), /More remains; call history read/);

	// Explicit rollover and an actual native checkpoint preserve only the fresh window in context.
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("new_context", { handoff: "continue here" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("fresh"),
	]);
	await session.prompt("finish this window");
	assert.equal(faux.getPendingResponseCount(), 0);
	assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "context_window").length, 2);
	const hold = await session.acquireCheckpoint({ boundary: "settled", quiesce: () => () => {}, signal: AbortSignal.timeout(5000) });
	let checkpoint;
	try {
		assert.equal(hold.sleepReady, true, JSON.stringify(hold.sleepBlockers));
		checkpoint = structuredClone(hold.checkpoint);
	} finally { hold.release(); }
	session.dispose();
	const { session: restored } = await createAgentSession({ checkpoint, agentDir, modelRuntime, resourceLoader, settingsManager });
	try {
		await restored.bindExtensions({ onError(error) { throw new Error(error.error); } });
		assert.equal(restored.sessionId, sessionManager.getSessionId());
		assert.deepEqual(restored.getActiveToolNames(), checkpoint.selection.activeTools);
		const messages = restored.messages.filter((message) => message.role !== "system");
		assert.deepEqual(messages.map((message) => message.role), ["custom", "assistant"]);
		assert.match(JSON.stringify(messages), /continue here/);
		assert.doesNotMatch(JSON.stringify(messages), /dump everything|DUMP HEAD/);
		assert.equal(faux.state.callCount, 5, "Restoring must not call a provider");
	} finally { restored.dispose(); }
});

for (const mode of ["structured", "custom", "forced-before", "forced-after"]) test(`native Posthorse guidance survives tool additions and rollover (${mode})`, async (t) => {
	const h = await fixture(t, { customPrompt: mode === "custom" ? "CUSTOM_PROMPT_POLICY" : undefined, extension(pi) {
		pi.registerTool({ name: "extra", label: "Extra", description: "Additional fixture tool", parameters: { type: "object", properties: {} }, async execute() {
			return { content: [{ type: "text", text: "done" }], details: {} };
		} });
	} });
	const extension = h.resourceLoader.getExtensions().extensions.find((item) => item.path === join(root, "index.ts"));
	const handlers = extension.handlers.get("before_agent_start");
	if (mode.startsWith("forced-")) handlers[mode === "forced-before" ? "unshift" : "push"]((event) => ({ systemPrompt: `${event.systemPrompt}\n\nOTHER_EXTENSION_POLICY` }));
	const captures = [];
	const capture = (ctx, reset = false) => {
		captures.push(structuredClone(ctx.messages));
		return reset ? fauxAssistantMessage(fauxToolCall("new_context", { handoff: "Checkpoint ready" }), { stopReason: "toolUse" }) : fauxAssistantMessage("done");
	};
	h.session.setActiveToolsByName(["new_context"]);
	h.faux.setResponses([(ctx) => capture(ctx)]);
	await h.session.prompt("First request");
	h.session.setActiveToolsByName(["new_context", "extra"]);
	h.faux.setResponses([(ctx) => capture(ctx)]);
	await h.session.prompt("Use the new tool if needed");
	h.faux.setResponses([(ctx) => capture(ctx, true), (ctx) => capture(ctx)]);
	await h.session.prompt("Continue in a fresh window");
	assert.equal(h.faux.getPendingResponseCount(), 0);
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "context_window").length, 1);
	for (const messages of captures) {
		const prompt = getCurrentSystemPrompt(messages);
		assert.equal(prompt.split("## Context self-management (Posthorse)").length - 1, 1);
		assert.match(prompt, /verify live state/);
		if (mode.startsWith("forced-")) assert.match(prompt, /OTHER_EXTENSION_POLICY/);
		if (mode === "custom") assert.match(prompt, /CUSTOM_PROMPT_POLICY/);
	}
	if (!mode.startsWith("forced-")) {
		assert.deepEqual(captures[1][0], captures[0][0], "adding a tool must preserve the initial prompt and declarations");
		assert.match(captures[0][0].sections?.posthorse ?? "", /Context self-management/);
		assert.ok(captures[1].slice(1).some((message) => message.role === "system" && message.toolsAdded?.some((tool) => tool.name === "extra")));
	}
});

for (const enabled of [false, true]) test(`native mixed searches/list/reads stay below configured capacity (compaction=${enabled})`, async (t) => {
	const h = await fixture(t, { enabled, seed(manager) {
		for (let index = 0; index < 60; index++) manager.appendMessage({ role: "user", content: `needle ${"h".repeat(500)}`, timestamp: index });
		manager.appendContextWindow("Historical fixture", null);
	} });
	const dir = join(h.cwd, ".pi", "notes");
	mkdirSync(dir, { recursive: true });
	for (let index = 0; index < 220; index++) writeFileSync(join(dir, `${index}-${"n".repeat(100)}.md`), `needle ${"n".repeat(300)}`);
	writeFileSync(join(dir, "long.md"), "L".repeat(30_000));
	let before, after, results;
	h.faux.setResponses([
		() => {
			before = h.session.getContextUsage().tokens;
			return fauxAssistantMessage([
				fauxToolCall("history", { op: "search", query: "needle", limit: 50 }),
				fauxToolCall("notes", { op: "search", query: "needle" }),
				fauxToolCall("notes", { op: "list" }),
				fauxToolCall("notes", { op: "read", path: "long.md" }),
			], { stopReason: "toolUse" });
		},
		(ctx) => {
			after = h.session.getContextUsage().tokens;
			results = ctx.messages.filter((message) => message.role === "toolResult");
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("p".repeat(enabled ? 305_000 : 365_000));
	assert.equal(h.faux.getPendingResponseCount(), 0);
	assert.ok(after < (enabled ? 83_617 : 100_000), JSON.stringify({ before, after, enabled }));
	assert.equal(results.length, 4, "bounded results should not force avoidable rollover");
	assert.ok(results.some((result) => result.isError));
	for (const result of results) assert.ok(textOf(result).length <= 20_000);
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "context_window").length, 1);
	t.diagnostic(JSON.stringify({ before, after, enabled }));
});

test("native enabled-to-disabled policy removes the active reminder but keeps its journal entry", async (t) => {
	const h = await fixture(t);
	h.faux.setResponses([fauxAssistantMessage("First response in reminder band"), fauxAssistantMessage("Checkpoint reminder received")]);
	await h.session.prompt("p".repeat(305_000));
	const reminders = () => h.sessionManager.getBranch().filter((entry) => entry.type === "custom_message" && entry.customType === "posthorse-reminder");
	assert.equal(reminders().length, 1);
	const original = structuredClone(reminders()[0]);
	h.settingsManager.applyOverrides({ compaction: { enabled: false } });
	let input;
	h.faux.setResponses([(ctx) => {
		input = [getCurrentSystemPrompt(ctx.messages), ...ctx.messages.filter((message) => message.role !== "system").map(textOf)].join("\n");
		return fauxAssistantMessage("Done");
	}]);
	await h.session.prompt("Continue without automatic rollover");
	assert.match(input, /Pi compaction is disabled/);
	assert.doesNotMatch(input, /Checkpoint now:|then call new_context now/);
	assert.deepEqual(reminders(), [original]);
});

for (const all of [false, true]) test(`native search cursors finish despite appended lookup echoes (all=${all})`, async (t) => {
	const h = await fixture(t, { seed(manager) {
		for (let index = 0; index < 9; index++) manager.appendMessage({ role: "user", content: `CURSOR-NEEDLE original ${index}`, timestamp: index });
		manager.appendMessage({ role: "toolResult", toolName: "notes", toolCallId: "prior", content: [{ type: "text", text: "CURSOR-NEEDLE prior recovery echo" }], isError: false, timestamp: 10 });
	} });
	const originals = h.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").map((entry) => entry.id).reverse();
	const priorEcho = h.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult").id;
	const returned = [];
	let complete = false;
	const call = (cursor) => fauxAssistantMessage(fauxToolCall("history", { op: "search", query: "CURSOR-NEEDLE", limit: 2, all, ...(cursor ? { cursor } : {}) }), { stopReason: "toolUse" });
	h.faux.setResponses([
		call(),
		...Array.from({ length: 30 }, () => (ctx) => {
			const result = ctx.messages.at(-1);
			assert.equal(result.toolName, "history");
			assert.ok(!result.isError, textOf(result));
			const text = textOf(result);
			// Excerpts can contain previous result headers. Native display spans delimit actual hits.
			const journal = [...h.sessionManager.getBranch()].reverse().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === result.toolCallId);
			assert.ok(journal.message.details.entries);
			let start = 0;
			for (const span of journal.message.details.entries) {
				const header = text.slice(start, start + span.headerLength);
				const id = header.match(/\[window [^\]]+\] \[([^\]]+)\] /)?.[1];
				assert.ok(id, header);
				returned.push(id);
				start += span.length + 1;
			}
			assert.equal(start - 1, text.length - journal.message.details.footerLength);
			const cursor = nextCursor(text);
			if (cursor) return call(cursor);
			complete = true;
			return fauxAssistantMessage("Finished paging");
		}),
	]);
	await h.session.prompt("Recover earlier source entries");
	assert.equal(complete, true);
	assert.deepEqual(returned.slice(0, originals.length), originals, "original entries keep order and appear exactly once");
	assert.equal(new Set(returned).size, returned.length, "lookup echoes cannot repeat previously returned entries");
	assert.ok(returned.length > originals.length, "prior and new lookup echoes remain searchable");
	assert.ok(returned.includes(priorEcho), "the original recovery echo remains retrievable too");
	t.diagnostic(JSON.stringify({ all, originals: originals.length, returned: returned.length }));
});

for (const stopReason of ["error", "length", "aborted"]) test(`native delivered tool results remain recoverable after ${stopReason} without an unseen claim`, async (t) => {
	const h = await fixture(t, { extension(pi) {
		pi.registerTool({ name: "receipt", label: "Receipt", description: "Local receipt", parameters: { type: "object", properties: {} }, async execute() {
			return { content: [{ type: "text", text: `ACTION-RECEIPT ${"r".repeat(40_000)}` }], details: {} };
		} });
	} });
	let delivered = false, recovery = "";
	h.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("receipt", {}), { stopReason: "toolUse" }),
		(ctx) => {
			delivered = ctx.messages.some((message) => message.toolName === "receipt" && textOf(message).includes("ACTION-RECEIPT"));
			return fauxAssistantMessage("I received ACTION-RECEIPT", { stopReason, ...(stopReason === "error" ? { errorMessage: "prompt is too long: 300000 tokens > 100000 maximum" } : {}) });
		},
		(ctx) => { recovery = ctx.messages.map(textOf).join("\n"); return fauxAssistantMessage("Continued"); },
	]);
	await h.session.prompt("Check the receipt without repeating the action");
	if (stopReason === "aborted") {
		h.settingsManager.applyOverrides({ compaction: { enabled: true, reserveTokens: 90_000 } });
		await h.session.prompt("Continue after cancellation");
	}
	assert.equal(delivered, true);
	assert.ok(h.sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === stopReason && textOf(entry.message).includes("I received ACTION-RECEIPT")));
	assert.match(recovery, /Trailing tool batch without a later complete assistant response/);
	assert.match(recovery, /ACTION-RECEIPT/);
	assert.doesNotMatch(recovery, /no model has seen|no model has consumed/);
});
