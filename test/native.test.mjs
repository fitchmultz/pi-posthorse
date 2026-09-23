import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
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

function automaticRecovery({ session, sessionManager, resourceLoader }) {
	const extension = resourceLoader.getExtensions().extensions.find((item) => item.path === join(root, "index.ts"));
	const handler = extension.handlers.get("session_before_auto_compact")[0];
	const result = handler({
		type: "session_before_auto_compact", reason: "threshold",
		branchEntries: sessionManager.getBranch(), pendingMessages: [], signal: new AbortController().signal,
	}, session.extensionRunner.createContext());
	assert.ok(result?.newContext?.handoff);
	return result.newContext.handoff;
}


test("all-session history scopes project sessions and their nested subagents", async (t) => {
	let foreignId, ownId, foreignChildId, ownChildId;
	const { session, faux, sessionManager } = await fixture(t, {
		seed(manager) {
			const archive = (cwd, content, dir = manager.getSessionDir()) => {
				mkdirSync(cwd, { recursive: true });
				mkdirSync(dir, { recursive: true });
				const other = SessionManager.create(cwd, dir);
				const id = other.appendMessage({ role: "user", content, timestamp: Date.now() });
				other.appendMessage(fauxAssistantMessage("Archive saved."));
				const source = relative(manager.getSessionDir(), other.getSessionFile());
				return { id: `${id}@${createHash("sha256").update(source).digest("base64url")}`, file: other.getSessionFile() };
			};
			const foreignCwd = join(manager.getCwd(), "..", "foreign-project");
			const foreign = archive(foreignCwd, "SCOPE_NEEDLE foreign");
			const own = archive(manager.getCwd(), "SCOPE_NEEDLE own");
			const childDir = (file) => join(dirname(file), basename(file, ".jsonl"), "run-1", "run-0");
			foreignId = foreign.id;
			ownId = own.id;
			foreignChildId = archive(manager.getCwd(), "SCOPE_NEEDLE foreign child", childDir(foreign.file)).id;
			ownChildId = archive(foreignCwd, "SCOPE_NEEDLE own child", childDir(own.file)).id;
		},
	});
	const search = fauxToolCall("history", { op: "search", query: "SCOPE_NEEDLE", all: true });
	const foreignRead = fauxToolCall("history", { op: "read", id: foreignId });
	const foreignChildRead = fauxToolCall("history", { op: "read", id: foreignChildId });
	const ownRead = fauxToolCall("history", { op: "read", id: ownId });
	const ownChildRead = fauxToolCall("history", { op: "read", id: ownChildId });
	faux.setResponses([
		fauxAssistantMessage([search, foreignRead, foreignChildRead, ownRead, ownChildRead], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await session.prompt("Check archived history.");
	const result = (call) => sessionManager.getBranch().find((entry) =>
		entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === call.id)?.message;
	assert.match(textOf(result(search)), /\[user\] SCOPE_NEEDLE own/);
	assert.match(textOf(result(search)), /\[user\] SCOPE_NEEDLE own child/);
	assert.doesNotMatch(textOf(result(search)), /\[user\] SCOPE_NEEDLE foreign/);
	assert.equal(result(foreignRead)?.isError, true);
	assert.equal(result(foreignChildRead)?.isError, true);
	assert.match(textOf(result(ownRead)), /\[user\] SCOPE_NEEDLE own/);
	assert.match(textOf(result(ownChildRead)), /\[user\] SCOPE_NEEDLE own child/);
});

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

test("automatic rollover respects context edits in its recovery handoff", async (t) => {
	const { session, faux, sessionManager } = await fixture(t, {
		contextWindow: 128_000,
		seed(manager) {
			const omitted = manager.appendMessage({ role: "user", content: "PRIVATE_EDIT_MARKER", timestamp: Date.now() });
			manager.appendContextEdit(omitted, null);
			const revised = manager.appendMessage({ role: "user", content: "OBSOLETE_EDIT_MARKER", timestamp: Date.now() });
			manager.appendContextEdit(revised, { content: "APPROVED_EDIT_MARKER" });
		},
		extension(pi) {
			pi.registerTool({
				name: "dump", label: "dump", description: "Large local result",
				parameters: { type: "object", properties: {} },
				async execute() { return { content: [{ type: "text", text: `PRIVATE_TOOL_MARKER ${"x".repeat(600_000)}` }], details: {} }; },
			});
			pi.on("turn_end", (event, ctx) => {
				if (!event.toolResults.some((result) => result.toolName === "dump")) return;
				const result = ctx.sessionManager.getBranch().findLast((entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "dump");
				ctx.sessionManager.appendContextEdit(result.id, { content: [{ type: "text", text: `APPROVED_TOOL_MARKER ${"x".repeat(600_000)}` }] });
			});
		},
	});
	const requests = [];
	faux.setResponses([
		(ctx) => { requests.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage(fauxToolCall("dump", {}), { stopReason: "toolUse" }); },
		(ctx) => { requests.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage("done"); },
	]);
	await session.prompt("Run the local dump tool.");
	const windows = sessionManager.getBranch().filter((entry) => entry.type === "context_window");
	assert.equal(windows.length, 1);
	assert.equal(requests.length, 2);
	for (const text of [...requests, windows[0].handoff]) {
		assert.equal(/PRIVATE_EDIT_MARKER|OBSOLETE_EDIT_MARKER/.test(text), false);
		assert.equal(text.includes("APPROVED_EDIT_MARKER"), true);
	}
	for (const text of [requests[1], windows[0].handoff]) {
		assert.equal(text.includes("PRIVATE_TOOL_MARKER"), false);
		assert.equal(text.includes("APPROVED_TOOL_MARKER"), true);
	}
});

test("recovery does not use an edited assistant's unedited checkpoint", async (t) => {
	const h = await fixture(t, { seed(manager) {
		const call = { ...fauxToolCall("work", { token: "PRIVATE_CHECKPOINT_ARGUMENT" }), async: true };
		manager.appendMessage(fauxAssistantMessage(call, { responseId: "checkpoint-response", stopReason: "pending" }), true);
		const final = manager.appendMessage(fauxAssistantMessage(call, { responseId: "checkpoint-response", stopReason: "toolUse" }));
		manager.appendMessage(fauxAssistantMessage({ ...call, executionStarted: true }, { responseId: "checkpoint-response", stopReason: "pending" }), true);
		manager.appendMessage({
			role: "toolResult", toolName: "work", toolCallId: call.id,
			content: [{ type: "text", text: "safe result" }], isError: false, timestamp: Date.now(),
		});
		manager.appendContextEdit(final, null);
	} });
	assert.doesNotMatch(JSON.stringify(h.sessionManager.buildSessionProjection().messages), /PRIVATE_CHECKPOINT_ARGUMENT/);
	const handoff = automaticRecovery(h);
	assert.doesNotMatch(handoff, /PRIVATE_CHECKPOINT_ARGUMENT/);
	assert.match(handoff, /safe result/);
});

test("a projected orphan result is not attributed to an older assistant", async (t) => {
	let olderId;
	const h = await fixture(t, { seed(manager) {
		olderId = manager.appendMessage(fauxAssistantMessage("Earlier unrelated response"));
		const call = { ...fauxToolCall("work", {}), async: true };
		const final = manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
		manager.appendMessage({
			role: "toolResult", toolName: "work", toolCallId: call.id,
			content: [{ type: "text", text: "safe orphan result" }], isError: false, timestamp: Date.now(),
		});
		manager.appendContextEdit(final, null);
	} });
	assert.match(JSON.stringify(h.sessionManager.buildSessionProjection().messages), /safe orphan result/);
	const handoff = automaticRecovery(h);
	assert.match(handoff, /safe orphan result/);
	assert.doesNotMatch(handoff, new RegExp(`Tool-call entry ${olderId}`));
});

test("recovery keeps a projected result whose call predates the window", async (t) => {
	const h = await fixture(t, { seed(manager) {
		const call = { ...fauxToolCall("work", {}), async: true };
		manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
		manager.appendContextWindow("Fresh window", null);
		manager.appendMessage(fauxAssistantMessage("Unrelated response"));
		manager.appendMessage({
			role: "toolResult", toolName: "work", toolCallId: call.id,
			content: [{ type: "text", text: "CROSS_WINDOW_RESULT" }], isError: false, timestamp: Date.now(),
		});
	} });
	assert.match(JSON.stringify(h.sessionManager.buildSessionProjection().messages), /CROSS_WINDOW_RESULT/);
	const handoff = automaticRecovery(h);
	assert.match(handoff, /CROSS_WINDOW_RESULT/);
	assert.match(handoff, /No matching trailing tool call/);
});

test("mixed projected results retain their own call provenance", async (t) => {
	let otherCallEntry;
	const h = await fixture(t, { seed(manager) {
		const omittedCall = { ...fauxToolCall("work", { token: "PRIVATE_MIXED_ARGUMENT" }), async: true };
		const omittedEntry = manager.appendMessage(fauxAssistantMessage(omittedCall, { stopReason: "toolUse" }));
		const otherCall = fauxToolCall("read", { path: "safe.txt" });
		otherCallEntry = manager.appendMessage(fauxAssistantMessage(otherCall, { stopReason: "toolUse" }));
		for (const [call, text] of [[omittedCall, "RESULT_A"], [otherCall, "RESULT_B"]]) {
			manager.appendMessage({
				role: "toolResult", toolName: call.name, toolCallId: call.id,
				content: [{ type: "text", text }], isError: false, timestamp: Date.now(),
			});
		}
		manager.appendContextEdit(omittedEntry, null);
	} });
	const projected = JSON.stringify(h.sessionManager.buildSessionProjection().messages);
	assert.match(projected, /RESULT_A/);
	assert.match(projected, /RESULT_B/);
	assert.doesNotMatch(projected, /PRIVATE_MIXED_ARGUMENT/);
	const handoff = automaticRecovery(h);
	assert.match(handoff, /RESULT_A/);
	assert.match(handoff, /RESULT_B/);
	assert.doesNotMatch(handoff, /PRIVATE_MIXED_ARGUMENT/);
	assert.doesNotMatch(handoff, new RegExp(`Tool-call entry ${otherCallEntry}:`));
	assert.match(handoff, new RegExp(`Call entry: ${otherCallEntry}`));
	assert.match(handoff, /RESULT_A[\s\S]*No matching trailing call/);
});

test("recovery excludes results dependent on an omitted async call", async (t) => {
	const h = await fixture(t, { seed(manager) {
		const call = { ...fauxToolCall("work", {}), async: true, executionStarted: true };
		const callId = manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
		const laterId = manager.appendMessage(fauxAssistantMessage("Unrelated complete response"));
		manager.appendMessage({
			role: "toolResult", toolName: "work", toolCallId: call.id,
			content: [{ type: "text", text: "PRIVATE_ASYNC_RESULT" }], isError: false, timestamp: Date.now(),
		});
		manager.appendCompaction("Previous context", laterId, 100);
		manager.appendContextEdit(callId, null);
	} });
	assert.doesNotMatch(JSON.stringify(h.sessionManager.buildSessionProjection().messages), /PRIVATE_ASYNC_RESULT/);
	assert.doesNotMatch(automaticRecovery(h), /PRIVATE_ASYNC_RESULT/);
});

test("edited image recovery points to the replacement rather than the raw original", async (t) => {
	const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=" };
	let editId;
	const h = await fixture(t, { seed(manager) {
		const original = manager.appendMessage({ role: "user", content: "PRIVATE_IMAGE_ORIGINAL", timestamp: Date.now() });
		editId = manager.appendContextEdit(original, { content: [image] });
	} });
	assert.doesNotMatch(JSON.stringify(h.sessionManager.buildSessionProjection().messages), /PRIVATE_IMAGE_ORIGINAL/);
	const handoff = automaticRecovery(h);
	const pointer = handoff.match(/recover with history read id ([^\s]+)/)?.[1];
	assert.ok(pointer, handoff);
	h.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("history", { op: "read", id: pointer }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await h.session.prompt("Recover the edited image.");
	const result = h.sessionManager.getBranch().findLast((entry) =>
		entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "history").message;
	assert.equal(result.isError, false);
	assert.equal(result.content.filter((part) => part.type === "image").length, 1);
	assert.doesNotMatch(textOf(result), /PRIVATE_IMAGE_ORIGINAL/);
	assert.equal(pointer, editId);
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

test("namespaced tools count toward the fresh handoff budget", async (t) => {
	const h = await fixture(t, { contextWindow: 32_768, extension(pi) {
		pi.registerTool({
			name: "catalog", namespace: "example", label: "Catalog", description: "d".repeat(52_000),
			parameters: { type: "object", properties: {} },
			async execute() { return { content: [{ type: "text", text: "unused" }], details: undefined }; },
		});
	} });
	const catalog = h.session.getAllTools().find((tool) => tool.name === "catalog");
	h.session.setActiveToolsByName(["new_context", catalog.id]);
	const handoff = "h".repeat(20_000);
	h.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("new_context", { handoff }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Done."),
	]);
	await h.session.prompt("Save the handoff.");
	const branch = h.sessionManager.getBranch();
	const result = branch.findLast((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "new_context").message;
	assert.equal(result.isError, true, "active namespaced tool declarations must reduce the handoff budget");
	assert.match(textOf(result), /Handoff is too large for the active model/);
	assert.ok(!branch.some((entry) => entry.type === "context_window" && entry.handoff === handoff));
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
	const nativeIds = returned.map((id) => id.split("@")[0]);
	assert.deepEqual(nativeIds.slice(0, originals.length), originals, "original entries keep order and appear exactly once");
	assert.ok(returned.every((id) => id.includes("@") === all), "all-session references identify their source file");
	assert.equal(new Set(returned).size, returned.length, "lookup echoes cannot repeat previously returned entries");
	assert.ok(returned.length > originals.length, "prior and new lookup echoes remain searchable");
	assert.ok(nativeIds.includes(priorEcho), "the original recovery echo remains retrievable too");
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
