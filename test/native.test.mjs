import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
const hostIndex = process.env.PI_HOST_INDEX ? pathToFileURL(process.env.PI_HOST_INDEX).href : import.meta.resolve("@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, estimateTokens, ModelRuntime, SessionManager, SettingsManager } = await import(hostIndex);

// Resolve the faux provider from the selected host's graph as well.
const aiManifest = pathToFileURL(findPackageJSON("@earendil-works/pi-ai", hostIndex));
const aiPackage = JSON.parse(readFileSync(aiManifest, "utf8"));
const { fauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, InMemoryCredentialStore } = await import(new URL(aiPackage.exports["."].import, aiManifest).href);
const { estimateMessageTokens } = await import(new URL(aiPackage.exports["./utils/*"].import.replace("*", "estimate"), aiManifest).href);
const { clampMaxTokensToContext } = await import(new URL(aiPackage.exports["./api/*"].import.replace("*", "simple-options"), aiManifest).href);
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
	const faux = fauxProvider({ api: options.nativeAsync ? "openai-responses" : undefined, models: [{ id: "posthorse-regression", contextWindow: options.contextWindow ?? 100_000, maxTokens: options.maxTokens ?? 1000 }] });
	if (options.nativeAsync) faux.getModel().compat = { supportsAsyncTools: true };
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
	return { cwd, agentDir, session, faux, sessionManager, settingsManager, resourceLoader, modelRuntime };
}

function automaticRecovery({ session, sessionManager, resourceLoader }) {
	const extension = resourceLoader.getExtensions().extensions.find((item) => item.path === join(root, "index.ts"));
	const handler = extension.handlers.get("session_before_auto_compact")[0];
	const result = handler({
		type: "session_before_auto_compact", reason: "threshold",
		branchEntries: sessionManager.getBranch(), pendingMessages: [], retainedToolResultIds: [], signal: new AbortController().signal,
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

test("automatic rollover keeps namespaced ask_question output as tool evidence, not owner input", async (t) => {
	const { session, faux, sessionManager } = await fixture(t, {
		extension(pi) {
			pi.registerTool({
				name: "ask_question", namespace: "survey", label: "Survey", description: "Query an external survey",
				parameters: { type: "object", properties: {} },
				async execute() { return { content: [{ type: "text", text: "SURVEY_OUTPUT: deployment approved" }], details: {} }; },
			});
			pi.registerTool({
				name: "dump", label: "Dump", description: "Large local result",
				parameters: { type: "object", properties: {} },
				async execute() { return { content: [{ type: "text", text: "x".repeat(600_000) }], details: {} }; },
			});
		},
	});
	let nextRequest;
	faux.setResponses([
		fauxAssistantMessage([
			{ ...fauxToolCall("ask_question", {}), namespace: "survey" },
			fauxToolCall("dump", {}),
		], { stopReason: "toolUse" }),
		(ctx) => { nextRequest = JSON.stringify(ctx.messages); return fauxAssistantMessage("done"); },
	]);
	await session.prompt("Read the survey only. Do not deploy.");
	const windows = sessionManager.getBranch().filter((entry) => entry.type === "context_window");
	assert.equal(windows.length, 1);
	for (const text of [windows[0].handoff, nextRequest]) {
		assert.match(text, /Do not deploy/);
		assert.match(text, /SURVEY_OUTPUT: deployment approved/);
		assert.match(text, /Tool result evidence/);
		assert.doesNotMatch(text, /owner answer via ask_question/);
	}
});

test("recovery and history retain native tool identity and admitted arguments after rollover", async (t) => {
	const executed = [];
	const h = await fixture(t, {
		nativeAsync: true,
		extension(pi) {
			for (const namespace of ["ENVIRONMENT_A", "ENVIRONMENT_B"]) pi.registerTool({
				namespace, name: "record", async: true, label: "Record", description: "In-memory fixture operation",
				parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
				prepareArguments(args) { return { ...args, target: `${namespace}_ACTUAL_RESOURCE` }; },
				async execute(id, args) {
					executed.push({ namespace, id, args });
					return { content: [{ type: "text", text: "Fixture operation complete" }], details: {} };
				},
			});
		},
	});
	const calls = ["ENVIRONMENT_A", "ENVIRONMENT_B"].map((namespace, i) => {
		const call = { ...fauxToolCall("record", { target: "REQUESTED_ALIAS" }), namespace, async: true };
		call.responsesItem = { type: "function_call", id: `fc_identity_${i}`, call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments), async: true, status: "completed" };
		return call;
	});
	h.faux.setResponses([
		fauxAssistantMessage(calls, { responseId: "resp_identity", stopReason: "toolUse" }),
		fauxAssistantMessage("Done"),
	]);
	await h.session.prompt("Run both in-memory fixture operations exactly once.");
	assert.deepEqual(executed, calls.map((call) => ({
		namespace: call.namespace, id: call.id, args: { target: `${call.namespace}_ACTUAL_RESOURCE` },
	})));
	// History reads raw journal entries; each call's execution checkpoint holds its admitted input.
	const callEntries = calls.map((call) => h.sessionManager.getBranch().findLast((entry) =>
		entry.type === "message" && entry.message.role === "assistant" &&
		entry.message.content.some((part) => part.id === call.id && part.executionArguments)));
	const resultEntries = h.sessionManager.getBranch().filter((entry) =>
		entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "record");
	const handoff = automaticRecovery(h);
	h.session.newContext({ handoff });
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "context_window").length, 1);
	assert.ok(!h.sessionManager.buildSessionProjection().messages.some((message) =>
		message.role === "assistant" && message.content.some((part) => part.id === calls[0].id)));

	const lookups = [
		...callEntries.map((entry) => fauxToolCall("history", { op: "read", id: entry.id })),
		...resultEntries.map((entry) => fauxToolCall("history", { op: "read", id: entry.id })),
		fauxToolCall("history", { op: "search", query: "ENVIRONMENT_A" }),
		fauxToolCall("history", { op: "search", query: "ACTUAL_RESOURCE" }),
	];
	h.faux.setResponses([fauxAssistantMessage(lookups, { stopReason: "toolUse" }), fauxAssistantMessage("History recovered")]);
	await h.session.prompt("Recover the earlier operations from history.");
	const reads = lookups.map((lookup) => textOf(h.sessionManager.getBranch().find((entry) =>
		entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === lookup.id)?.message));
	for (const [i, call] of calls.entries()) {
		for (const text of [handoff, reads[i]]) {
			assert.ok(text.includes(`record (namespace: "${call.namespace}")`), text);
			assert.ok(text.includes(`Call ID: ${call.id}`), text);
			assert.ok(text.includes('{"target":"REQUESTED_ALIAS"}'), text);
			assert.ok(text.includes(`Execution arguments: {"target":"${call.namespace}_ACTUAL_RESOURCE"}`), text);
		}
		const resultText = reads[calls.length + resultEntries.findIndex((entry) => entry.message.toolCallId === call.id)];
		assert.ok(resultText.includes(`record (namespace: "${call.namespace}")`), resultText);
		assert.ok(resultText.includes(`Call ID: ${call.id}`), resultText);
	}
	assert.ok(reads.at(-2).includes(`[${callEntries[0].id}]`), reads.at(-2));
	assert.ok(reads.at(-1).includes(`[${callEntries[1].id}]`), reads.at(-1));
	assert.equal(executed.length, 2, "recovery does not execute the operations again");
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
		manager.appendMessage(fauxAssistantMessage("Later complete response"));
	} });
	assert.match(JSON.stringify(h.sessionManager.buildSessionProjection().messages), /safe orphan result/);
	const handoff = automaticRecovery(h);
	assert.match(handoff, /safe orphan result/);
	assert.doesNotMatch(handoff, new RegExp(`Tool-call entry ${olderId}`));
});

test("recovery keeps a projected result whose call predates the window", async (t) => {
	let callEntry;
	const h = await fixture(t, { seed(manager) {
		const call = { ...fauxToolCall("work", {}), async: true };
		callEntry = manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
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
	assert.ok(h.sessionManager.buildSessionProjection().entries.some((entry) =>
		entry.sourceEntry.id === callEntry && entry.messages.some((message) => message.role === "assistant")));
	assert.match(handoff, new RegExp(`Tool-call entry ${callEntry}:`));
	assert.match(handoff, /Call arguments: \{\}/);
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
	assert.match(handoff, /RESULT_A[\s\S]*No matching projected call/);
});

test("interleaved async receipts retain projected provenance across complete responses", async (t) => {
	const image = { type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE_BYTES" };
	let firstEntry, secondEntry, editId;
	const h = await fixture(t, { seed(manager) {
		const first = { ...fauxToolCall("work", { task: "first" }), async: true };
		const second = { ...fauxToolCall("work", { task: "second" }), async: true };
		const sync = fauxToolCall("read", { path: "already-read.txt" });
		firstEntry = manager.appendMessage(fauxAssistantMessage(first, { stopReason: "toolUse" }));
		manager.appendMessage(fauxAssistantMessage(sync, { stopReason: "toolUse" }));
		manager.appendMessage({
			role: "toolResult", toolName: sync.name, toolCallId: sync.id,
			content: [{ type: "text", text: "HANDLED_SYNC_RESULT" }], isError: false, timestamp: Date.now(),
		});
		manager.appendMessage(fauxAssistantMessage("Finished synchronous work"));
		secondEntry = manager.appendMessage(fauxAssistantMessage(second, { stopReason: "toolUse" }));
		const firstResult = manager.appendMessage({
			role: "toolResult", toolName: first.name, toolCallId: first.id,
			content: [{ type: "text", text: "PRIVATE_FIRST_RESULT" }], isError: false, timestamp: Date.now(),
		});
		manager.appendMessage(fauxAssistantMessage("Another complete response"));
		manager.appendMessage({
			role: "toolResult", toolName: second.name, toolCallId: second.id,
			content: [{ type: "text", text: "SECOND_ASYNC_RECEIPT" }], isError: false, timestamp: Date.now(),
		});
		manager.appendMessage(fauxAssistantMessage("Both results handled"));
		editId = manager.appendContextEdit(firstResult, { content: [{ type: "text", text: "EDITED_FIRST_RECEIPT" }, image] });
	} });
	const handoff = automaticRecovery(h);
	assert.match(handoff, /EDITED_FIRST_RECEIPT/);
	assert.match(handoff, /SECOND_ASYNC_RECEIPT/);
	assert.match(handoff, new RegExp(`Call entry: ${firstEntry}\\nCall arguments: \\{"task":"first"\\}`));
	assert.match(handoff, new RegExp(`Call entry: ${secondEntry}\\nCall arguments: \\{"task":"second"\\}`));
	assert.match(handoff, new RegExp(`recover with history read id ${editId}`));
	assert.doesNotMatch(handoff, /PRIVATE_FIRST_RESULT|PRIVATE_IMAGE_BYTES|HANDLED_SYNC_RESULT|Both results handled/);
	assert.match(handoff, /may already have been received or handled; not current progress/);
	assert.ok(handoff.indexOf("EDITED_FIRST_RECEIPT") < handoff.indexOf("SECOND_ASYNC_RECEIPT"));
});

for (const toolName of ["work", "ask_question"]) test(`recovery excludes ${toolName} results dependent on an omitted async call`, async (t) => {
	const h = await fixture(t, { seed(manager) {
		const call = { ...fauxToolCall(toolName, {}), async: true, executionStarted: true };
		const callId = manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
		const laterId = manager.appendMessage(fauxAssistantMessage("Unrelated complete response"));
		manager.appendMessage({
			role: "toolResult", toolName, toolCallId: call.id,
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
	assert.match(JSON.stringify(recovery), /Tool result evidence/);
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

test("recovery retains the owner correction and a receipt journaled during a completed response", async (t) => {
	const h = await fixture(t, { seed(manager) {
		const slow = { ...fauxToolCall("slow", {}), async: true };
		const dump = fauxToolCall("dump", {});
		manager.appendMessage(fauxAssistantMessage([slow, dump], { stopReason: "toolUse" }));
		manager.appendMessage({
			role: "toolResult", toolName: dump.name, toolCallId: dump.id,
			content: [{ type: "text", text: "HANDLED_DUMP" }], isError: false, timestamp: Date.now(),
		});
		manager.appendMessage({ role: "user", content: "NEW_OWNER_DECISION: Work only on the revised request.", timestamp: Date.now() });
		// Native journal order when slow finishes during a request that did not receive its result.
		manager.appendMessage({
			role: "toolResult", toolName: slow.name, toolCallId: slow.id,
			content: [{ type: "text", text: "LATE_RECEIPT" }], isError: false, timestamp: Date.now(),
		});
		manager.appendMessage(fauxAssistantMessage("Waiting for receipt"));
	} });
	assert.match(JSON.stringify(h.sessionManager.buildSessionProjection().messages), /LATE_RECEIPT/);
	const handoff = automaticRecovery(h);
	assert.match(handoff, /NEW_OWNER_DECISION/);
	assert.match(handoff, /LATE_RECEIPT/);
	assert.match(handoff, /may already have been received or handled; not current progress/);
	assert.doesNotMatch(handoff, /HANDLED_DUMP|Waiting for receipt/);
});

for (const [stopReason, pendingChars] of [["error", 0], ["aborted", 0], ["length", 0], ["aborted", 240_000]]) test(`completed native async results survive ${stopReason} and rollover (new input=${pendingChars})`, async (t) => {
	let executions = 0, recovery = "";
	let recoveredMessages;
	const reserve = 16_384;
	const h = await fixture(t, { nativeAsync: true, maxTokens: stopReason === "length" ? 24_000 : 1000, extension(pi) {
		pi.registerTool({ name: "receipt", async: true, label: "Receipt", description: "Local receipt", parameters: { type: "object", properties: {} }, async execute() {
			executions++;
			return { content: [{ type: "text", text: `COMPLETED_ACTION_RECEIPT ${stopReason === "error" ? "" : "r".repeat(600_000)}` }], details: {} };
		} });
	} });
	const call = { ...fauxToolCall("receipt", {}), async: true };
	call.responsesItem = { type: "function_call", id: "fc_receipt", call_id: call.id, name: call.name, arguments: "{}", async: true, status: "completed" };
	h.faux.setResponses([
		fauxAssistantMessage(call, {
			responseId: "resp_receipt", stopReason,
			...(stopReason === "error" ? { errorMessage: "context_length_exceeded: Your input exceeds the context window of this model" } : {}),
		}),
		(ctx) => {
			recoveredMessages = structuredClone(ctx.messages);
			recovery = ctx.messages.map(textOf).join("\n");
			return fauxAssistantMessage("Continued");
		},
	]);
	await h.session.prompt("Perform the local operation exactly once and check its receipt.");
	if (stopReason === "aborted") await h.session.prompt(`Continue without repeating the operation. ${"p".repeat(pendingChars)}`);
	const branch = h.sessionManager.getBranch();
	const inputTokens = recoveredMessages.reduce((sum, message) => sum + estimateTokens(message), 0);
	assert.ok(inputTokens + reserve <= 100_000, `fresh provider input ${inputTokens} plus reserve exceeds capacity`);
	assert.equal(h.faux.state.callCount, 2, "rollover must not add a provider request");
	assert.equal(executions, 1);
	assert.ok(branch.some((entry) => entry.type === "message" && entry.message.role === "toolResult" && !entry.message.isError && textOf(entry.message).includes("COMPLETED_ACTION_RECEIPT")));
	// The large new prompt needs another window after the first rollover retained its receipt.
	assert.equal(branch.filter((entry) => entry.type === "context_window").length, pendingChars ? 2 : 1);
	assert.match(recovery, /Tool result evidence/);
	assert.match(recovery, /COMPLETED_ACTION_RECEIPT/);
	const receipt = recoveredMessages.find((message) => message.role === "toolResult" && message.toolCallId === call.id);
	assert.equal(receipt?.isError, false);
	assert.equal(receipt?.toolName, "receipt");
	if (stopReason !== "error") {
		const sourceId = textOf(receipt).match(/history read id ([a-f0-9]+)\./)?.[1];
		assert.ok(sourceId, "bounded receipt must expose its full-history reference");
		let source = h.sessionManager.getEntry(sourceId);
		if (pendingChars) {
			assert.equal(source.type, "context_edit", "the second window must preserve the prior replacement as its recovery source");
			source = h.sessionManager.getEntry(textOf(source.replacement).match(/history read id ([a-f0-9]+)\./)?.[1]);
		}
		assert.equal(textOf(source.message), `COMPLETED_ACTION_RECEIPT ${"r".repeat(600_000)}`);
		if (stopReason === "length") {
			let offset = 0, recovered = "";
			for (;;) {
				h.session.newContext({ handoff: "Recover the original receipt without repeating the operation." });
				h.faux.setResponses([
					fauxAssistantMessage(fauxToolCall("history", { op: "read", id: sourceId, offset }), { stopReason: "toolUse" }),
					fauxAssistantMessage("Page received"),
				]);
				await h.session.prompt("Read the next receipt page.");
				const page = h.sessionManager.getBranch().findLast((entry) =>
					entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "history").message;
				assert.equal(page.isError, false);
				const { headerLength, end, total } = page.details;
				recovered += textOf(page).slice(headerLength, headerLength + end - offset);
				assert.ok(end > offset, "history paging must progress");
				offset = end;
				if (end === total) break;
			}
			assert.equal(recovered, `[toolResult] COMPLETED_ACTION_RECEIPT ${"r".repeat(600_000)}\nTool: receipt\nCall ID: ${call.id}`);
			assert.equal(executions, 1, "history recovery cannot repeat the operation");
		}
	}
	t.diagnostic(JSON.stringify({ stopReason, pendingChars, inputTokens, reserve }));
});

for (const mode of ["explicit", "automatic"]) test(`large model output ceilings allow ${mode} rollover`, async (t) => {
	const h = await fixture(t, {
		maxTokens: mode === "explicit" ? 100_000 : 150_000,
		extension(pi) {
			pi.registerTool({
				name: "dump", label: "Dump", description: "Trigger automatic rollover",
				parameters: { type: "object", properties: {} },
				async execute() { return { content: [{ type: "text", text: "d".repeat(600_000) }], details: {} }; },
			});
		},
	});
	if (mode === "explicit") h.session.newContext({ handoff: "Continue in a fresh window" });
	let observed = false;
	h.faux.setResponses([
		...(mode === "automatic" ? [fauxAssistantMessage(fauxToolCall("dump", {}), { stopReason: "toolUse" })] : []),
		(ctx) => {
			observed = true;
			assert.equal(ctx.messages.filter((message) => message.role === "toolResult").length, 0);
			const tokens = ctx.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
			assert.ok(tokens + 16_384 <= 100_000, "fresh input fits Pi's configured reserve");
			return fauxAssistantMessage("Fresh window received");
		},
	]);
	await h.session.prompt("Continue the local work.");
	assert.equal(observed, true);
	assert.equal(h.faux.state.callCount, mode === "explicit" ? 1 : 2);
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "context_window").length, 1);
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "context_edit").length, 0);
});

test("a receipt fitting Pi's reserve stays unchanged despite a large model output ceiling", async (t) => {
	const content = [{ type: "text", text: `FITTING_RECEIPT ${"r".repeat(200_000)}` }];
	const call = { ...fauxToolCall("receipt", {}), async: true };
	call.responsesItem = { type: "function_call", id: "fc_fitting", call_id: call.id, name: call.name, arguments: "{}", async: true, status: "completed" };
	const h = await fixture(t, {
		maxTokens: 60_000, nativeAsync: true,
		seed(manager) {
			manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
			manager.appendMessage({
				role: "toolResult", toolName: call.name, toolCallId: call.id,
				content, isError: false, timestamp: Date.now(),
			});
		},
	});
	h.session.newContext({ handoff: "Inspect the retained receipt." });
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "context_edit").length, 0);
	let observed = false;
	h.faux.setResponses([(ctx) => {
		observed = true;
		const receipt = ctx.messages.find((message) => message.role === "toolResult" && message.toolCallId === call.id);
		assert.deepEqual(receipt?.content, content);
		const tokens = ctx.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		assert.ok(tokens + 16_384 <= 100_000);
		return fauxAssistantMessage("Receipt received");
	}]);
	await h.session.prompt("Check the receipt without repeating the action.");
	assert.equal(observed, true);
	assert.equal(h.faux.state.callCount, 1);
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "context_window").length, 1);
});

test("consumed native receipts cannot claim an empty rollover when working context needs a summary", async (t) => {
	let executions = 0;
	const retained = [];
	const requirement = "Preserve the owner working requirement.";
	const h = await fixture(t, {
		nativeAsync: true, customPrompt: "s".repeat(88_000),
		extension(pi) {
			pi.registerTool({ name: "receipt", async: true, label: "Receipt", description: "Local operation", parameters: { type: "object", properties: {} }, async execute() {
				executions++;
				return { content: [{ type: "text", text: "Operation completed" }], details: {} };
			} });
			pi.on("session_before_auto_compact", (event) => { retained.push(event.retainedToolResultIds); });
			pi.on("session_before_compact", (event) => ({
				compaction: { summary: requirement, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore },
			}));
		},
	});
	h.session.setActiveToolsByName(["receipt"]);
	h.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const call = { ...fauxToolCall("receipt", {}), async: true };
	h.faux.setResponses([
		fauxAssistantMessage(call, { stopReason: "toolUse" }),
		(ctx) => {
			assert.ok(ctx.messages.some((message) => message.role === "toolResult" && message.toolCallId === call.id));
			return fauxAssistantMessage("Operation acknowledged.");
		},
	]);
	await h.session.prompt(`${requirement} ${"w".repeat(10_000)}`);
	assert.equal(executions, 1);
	const receipt = h.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === call.id);
	assert.ok(h.sessionManager.getBranch().some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.consumedToolResultIds?.includes(receipt.id)));
	h.session.agent.state.model = { ...h.session.model, contextWindow: 40_000 };
	let nextRequest;
	h.faux.setResponses([(ctx) => { nextRequest = JSON.stringify(ctx.messages); return fauxAssistantMessage("Continued with the working requirement."); }]);
	await h.session.prompt("Continue the authorized work.");
	assert.deepEqual(retained, [[]]);
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "context_window").length, 0);
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
	assert.match(nextRequest, /Preserve the owner working requirement/);
	assert.equal(executions, 1);
});

for (const mode of ["fixed prompt", "carried arguments", "disabled overflow", "disabled fitting"]) test(`failed native receipt preparation admits no oversized follow-up (${mode})`, async (t) => {
	let executions = 0;
	const disabled = mode.startsWith("disabled");
	const argumentsSize = mode === "carried arguments" ? 16_000 : 0;
	const content = "r".repeat(600_000);
	const h = await fixture(t, {
		nativeAsync: true, enabled: !disabled, contextWindow: 40_000, maxTokens: 16_384,
		customPrompt: "s".repeat(argumentsSize ? 80_000 : 100_000),
		extension(pi) {
			pi.registerTool({ name: "receipt", async: true, label: "Receipt", description: "Local operation", parameters: { type: "object", properties: { input: { type: "string" } } }, async execute() {
				executions++;
				return { content: [{ type: "text", text: content }], details: {} };
			} });
		},
	});
	const call = { ...fauxToolCall("receipt", { input: "a".repeat(argumentsSize) }), async: true };
	call.responsesItem = { type: "function_call", id: "fc_preflight", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments), async: true, status: "completed" };
	const inputs = [];
	const capture = (ctx) => {
		const tokens = ctx.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
		assert.ok(tokens < h.session.model.contextWindow, `oversized provider dispatch: ${tokens}`);
		const output = clampMaxTokensToContext(h.session.model, ctx, h.session.model.maxTokens);
		assert.ok(tokens + output <= h.session.model.contextWindow);
		inputs.push({ tokens, output });
	};
	h.faux.setResponses([(ctx) => { capture(ctx); return fauxAssistantMessage(call, { responseId: "resp_preflight", stopReason: "aborted" }); }]);
	await h.session.prompt("Execute the operation once.");
	assert.equal(executions, 1);
	assert.equal(inputs.length, 1);
	const source = h.sessionManager.getBranch().find((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === call.id);
	assert.equal(textOf(source.message), content);
	if (mode === "disabled overflow") h.session.agent.state.model = { ...h.session.model, contextWindow: 20_000 };
	const refused = mode !== "disabled fitting";
	const original = h.sessionManager.getBranch();
	if (refused) {
		assert.throws(() => h.session.newContext(), /fresh context cannot fit fixed input/);
		assert.deepEqual(h.sessionManager.getBranch(), original, "failed preparation publishes nothing");
	} else h.session.newContext();
	const expectHistory = () => {
		assert.equal(textOf(h.sessionManager.getEntry(source.id).message), content);
		assert.equal(executions, 1, "preparation and prompts cannot replay the operation");
		assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "context_window").length, refused ? 0 : 1);
		assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction").length, 0);
		assert.deepEqual(h.session.messages, h.sessionManager.buildSessionProjection().messages);
	};
	for (const prompt of ["First actual follow-up", "Second actual follow-up"]) {
		h.faux.setResponses([(ctx) => { capture(ctx); return fauxAssistantMessage("Receipt received"); }]);
		try { await h.session.prompt(prompt); }
		catch (error) { assert.ok(refused); assert.match(error.message, /fresh context cannot fit fixed input/); }
		expectHistory();
		if (refused) assert.equal(h.faux.state.callCount, 1);
	}
	const reopened = SessionManager.open(h.sessionManager.getSessionFile());
	assert.deepEqual(JSON.parse(JSON.stringify(reopened.buildSessionProjection().messages)), JSON.parse(JSON.stringify(h.session.messages)));
	h.session.dispose();
	await h.resourceLoader.reload();
	const { session: restored } = await createAgentSession({ cwd: h.cwd, agentDir: h.agentDir, modelRuntime: h.modelRuntime, model: h.session.model, resourceLoader: h.resourceLoader, settingsManager: h.settingsManager, sessionManager: reopened, noTools: "builtin" });
	t.after(() => restored.dispose());
	h.session = restored;
	h.sessionManager = reopened;
	await restored.bindExtensions({ onError(error) { throw new Error(error.error); } });
	if (refused) {
		h.faux.setResponses([(ctx) => { capture(ctx); return fauxAssistantMessage("must not dispatch"); }]);
		try { await restored.prompt("Retry after reopening"); }
		catch (error) { assert.match(error.message, /fresh context cannot fit fixed input/); }
		assert.equal(h.faux.state.callCount, 1);
		expectHistory();
		// Correct the capacity, then use the ordinary reset/request path without a failure latch.
		restored.agent.state.model = { ...restored.model, contextWindow: 100_000 };
		restored.newContext();
		assert.equal(reopened.getBranch().filter((entry) => entry.type === "context_window").length, 1);
		const projected = reopened.buildSessionProjection().messages;
		const retained = projected.find((message) => message.role === "toolResult" && message.toolCallId === call.id);
		assert.match(textOf(retained), new RegExp(`history read id ${source.id}\\.`));
		const retainedCall = projected.flatMap((message) => message.role === "assistant" ? message.content : []).find((part) => part.id === call.id);
		assert.deepEqual(retainedCall.responsesItem, call.responsesItem);
		h.faux.setResponses([(ctx) => { capture(ctx); return fauxAssistantMessage("Recovered receipt received"); }]);
		await restored.prompt("Continue without repeating the operation");
		assert.equal(h.faux.state.callCount, 2);
		assert.equal(executions, 1);
		assert.equal(textOf(reopened.getEntry(source.id).message), content);
	}
	t.diagnostic(JSON.stringify({ mode, inputs, executions }));
});

for (const enabled of [false, true]) test(`fixed-prompt-only requests allow reduced output (compaction=${enabled})`, async (t) => {
	const h = await fixture(t, { enabled, contextWindow: 40_000, maxTokens: 16_384, customPrompt: "s".repeat(100_000) });
	if (enabled) assert.throws(() => h.session.newContext(), /fresh context cannot fit fixed input/);
	else h.session.newContext();
	let tokens, output;
	h.faux.setResponses([(ctx) => { tokens = ctx.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0); output = clampMaxTokensToContext(h.session.model, ctx, 16_384); return fauxAssistantMessage("Fitting request received"); }]);
	await h.session.prompt("Continue with reduced output");
	assert.equal(h.faux.state.callCount, 1);
	assert.ok(tokens > 40_000 - 16_384, "input intentionally exceeds the compaction reserve line");
	assert.ok(output > 0 && output < 16_384, "native output clamp leaves a valid reduced allocation");
	assert.ok(tokens + output <= 40_000);
});

test("a 600k native receipt completed during the awaited rollover hook is bounded before dispatch", async (t) => {
	const gate = Promise.withResolvers(), written = Promise.withResolvers();
	let executions = 0, requests = 0;
	const content = `DURING_HOOK_HEAD ${"r".repeat(600_000)} DURING_HOOK_TAIL`;
	const h = await fixture(t, { nativeAsync: true, extension(pi) {
		pi.registerTool({
			name: "late", async: true, label: "Late", description: "Receipt arriving during rollover",
			parameters: { type: "object", properties: {} },
			async execute() {
				executions++;
				await gate.promise;
				return { content: [{ type: "text", text: content }], details: {} };
			},
		});
		pi.registerTool({
			name: "dump", label: "Dump", description: "Trigger automatic rollover",
			parameters: { type: "object", properties: {} },
			async execute() { return { content: [{ type: "text", text: "d".repeat(340_000) }], details: {} }; },
		});
		pi.on("session_before_auto_compact", async () => {
			gate.resolve();
			await written.promise;
		});
	} });
	const call = { ...fauxToolCall("late", {}), async: true };
	call.responsesItem = { type: "function_call", id: "fc_late", call_id: call.id, name: call.name, arguments: "{}", async: true, status: "completed" };
	h.session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "toolResult" && event.message.toolCallId === call.id) written.resolve();
	});
	h.faux.setResponses([
		() => { requests++; return fauxAssistantMessage([call, fauxToolCall("dump", {})], { stopReason: "toolUse" }); },
		(ctx) => {
			requests++;
			const tokens = ctx.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
			assert.ok(tokens + 16_384 <= 100_000, `late receipt input ${tokens} plus reserve exceeds capacity`);
			const receipt = ctx.messages.find((message) => message.role === "toolResult" && message.toolCallId === call.id);
			assert.equal(receipt?.isError, false);
			assert.match(textOf(receipt), /DURING_HOOK_HEAD/);
			assert.match(textOf(receipt), /DURING_HOOK_TAIL/);
			const sourceId = textOf(receipt).match(/history read id ([a-f0-9]+)\./)?.[1];
			assert.equal(textOf(h.sessionManager.getEntry(sourceId).message), content);
			return fauxAssistantMessage("Receipt checked");
		},
	]);
	await h.session.prompt("Execute both local operations once.");
	assert.equal(executions, 1);
	assert.equal(requests, 2);
	assert.equal(h.faux.state.callCount, 2);
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "context_window").length, 1);
});

test("explicit windows share receipt capacity, preserve edited provenance, and reopen without growth", async (t) => {
	const ids = [], calls = [];
	let approvedId;
	const h = await fixture(t, {
		contextWindow: 100_000,
		nativeAsync: true,
		extension(pi) {
			pi.registerTool({
				name: "catalog", namespace: "large", label: "Catalog", description: "d".repeat(20_000),
				parameters: { type: "object", properties: {} },
				async execute() { throw new Error("Receipt recovery must not execute a tool"); },
			});
		},
		seed(manager) {
			for (const [index, content] of [
				[{ type: "text", text: "PRIVATE_ORIGINAL" }],
				Array.from({ length: 120 }, () => ({ type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE" })),
				[{ type: "text", text: "small receipt" }],
			].entries()) {
				const call = { ...fauxToolCall("catalog", { index }), namespace: "large", async: true, executionStarted: true };
				call.responsesItem = { type: "function_call", id: `fc_multi_${index}`, call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments), async: true, status: "completed" };
				calls.push(call);
				manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
				ids.push(manager.appendMessage({
					role: "toolResult", toolName: "catalog", namespace: "large", toolCallId: call.id,
					content, isError: index === 0, timestamp: Date.now(),
				}));
			}
			approvedId = manager.appendContextEdit(ids[0], { content: `APPROVED_HEAD ${"a".repeat(600_000)} APPROVED_TAIL` });
			manager.appendContextWindow("Prior retained window", null, ids);
		},
	});
	const handoff = automaticRecovery(h);
	assert.ok(handoff.includes(`entry ${approvedId}`), "handoffs must use edits from before the prior window");
	h.session.newContext({ handoff });
	const projection = h.sessionManager.buildSessionProjection();
	const results = projection.messages.filter((message) => message.role === "toolResult");
	assert.deepEqual(results.map((message) => message.toolCallId), calls.map((call) => call.id));
	assert.deepEqual(results.map((message) => message.isError), [true, false, false]);
	assert.ok(results.every((message) => message.namespace === "large"));
	assert.match(textOf(results[0]), new RegExp(`history read id ${approvedId}\\.`));
	assert.match(textOf(results[0]), /APPROVED_HEAD/);
	assert.match(textOf(results[0]), /APPROVED_TAIL/);
	assert.doesNotMatch(JSON.stringify(results), /PRIVATE_ORIGINAL|PRIVATE_IMAGE/);
	assert.match(textOf(results[1]), new RegExp(`history read id ${ids[1]}\\.`));
	assert.match(textOf(results[1]), /120 images/);
	assert.equal(textOf(results[2]), "small receipt");
	assert.deepEqual(
		SessionManager.open(h.sessionManager.getSessionFile()).buildSessionProjection().messages.filter((message) => message.role === "toolResult"),
		results,
	);
	const edits = h.sessionManager.getBranch().filter((entry) => entry.type === "context_edit");
	h.session.newContext({ handoff: "Same capacity" });
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "context_edit").length, edits.length);
	h.session.agent.state.model = { ...h.session.model, contextWindow: 40_000 };
	h.session.newContext({ handoff: "Smaller model" });
	const smaller = h.sessionManager.buildSessionProjection().messages.filter((message) => message.role === "toolResult");
	const priorExcerpt = edits.findLast((entry) => entry.targetId === ids[0]);
	assert.match(textOf(smaller[0]), new RegExp(`history read id ${priorExcerpt.id}\\.`));
	assert.doesNotMatch(JSON.stringify(smaller), /PRIVATE_ORIGINAL|PRIVATE_IMAGE/);
	assert.deepEqual(
		SessionManager.open(h.sessionManager.getSessionFile()).buildSessionProjection().messages.filter((message) => message.role === "toolResult"),
		smaller,
	);
	h.faux.setResponses([(ctx) => {
		const tokens = ctx.messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		assert.ok(tokens + 16_384 <= 40_000, `complete multi-receipt input ${tokens} plus reserve exceeds capacity`);
		assert.equal(ctx.messages.filter((message) => message.role === "toolResult").length, 3);
		return fauxAssistantMessage("Checked the retained receipts");
	}]);
	await h.session.prompt("Check the retained receipts.");
	assert.equal(h.faux.state.callCount, 1);
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
	assert.match(recovery, /Tool result evidence \(current projected window; may already have been received or handled; not current progress\)/);
	assert.match(recovery, /ACTION-RECEIPT/);
	assert.doesNotMatch(recovery, /no model has seen|no model has consumed/);
});
