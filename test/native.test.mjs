import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
const hostIndex = process.env.PI_HOST_INDEX ? pathToFileURL(process.env.PI_HOST_INDEX).href : import.meta.resolve("@earendil-works/pi-coding-agent");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(hostIndex);

// Resolve the faux provider from the selected host's graph as well.
const aiManifest = pathToFileURL(findPackageJSON("@earendil-works/pi-ai", hostIndex));
const aiPackage = JSON.parse(readFileSync(aiManifest, "utf8"));
const { fauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore } = await import(new URL(aiPackage.exports["."].import, aiManifest).href);
const { createPosthorse } = await import("../index.ts");
const textOf = (message) => typeof message?.content === "string" ? message.content : message?.content?.map((part) => part.text ?? "").join("\n") ?? "";
const nextCursor = (text) => text.match(/\[More results; continue with cursor "([^"]+)" and the same query\/scope\.\]$/)?.[1];
async function fixture(t, options = {}) {
	const temp = mkdtempSync(join(tmpdir(), "posthorse-regression-"));
	t.diagnostic(`fixture: ${temp}`);
	const cwd = join(temp, "project"), agentDir = join(temp, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	const faux = fauxProvider({ models: [{ id: "posthorse-regression", contextWindow: options.contextWindow ?? 100_000, maxTokens: options.maxTokens ?? 1000 }] });
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

		systemPromptOverride: options.customPrompt ? () => options.customPrompt : undefined,
		extensionFactories: [(pi) => { pi.registerProvider(faux.provider); options.extension?.(pi); }, createPosthorse((ctx) => settingsManager.getCompactionSettings(ctx.model))],
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

function reset(manager, handoff) { return manager.appendCompaction(handoff, null, 100, { posthorse: 1 }); }

test("official resume keeps legacy saved window data recoverable after a public reset", async (t) => {
	let ownerId;
	const h = await fixture(t, { seed(manager) {
		ownerId = manager.appendMessage({ role: "user", content: "LEGACY_OWNER_INPUT", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("Saved response."));
		const file = manager.getSessionFile();
		appendFileSync(file, `${JSON.stringify({ type: "context_window", id: "legacy-window", parentId: manager.getLeafId(), timestamp: "2026-09-01T00:00:00Z", handoff: "LEGACY_SAVED_HANDOFF" })}\n`);
		manager.setSessionFile(file);
	} });
	h.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("new_context", { handoff: "Public fresh context" }), { stopReason: "toolUse" }),
		fauxAssistantMessage([
			fauxToolCall("history", { op: "search", query: "LEGACY_OWNER_INPUT" }),
			fauxToolCall("history", { op: "read", id: "legacy-window" }),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("Recovered saved data."),
	]);
	await h.session.prompt("Reset using public compaction, then recover the legacy record.");
	const results = h.sessionManager.getBranch().filter((entry) => entry.message?.toolName === "history").map((entry) => entry.message);
	assert.equal(results.length, 2);
	assert.ok(results.every((result) => !result.isError));
	assert.match(textOf(results[0]), /LEGACY_OWNER_INPUT/);
	assert.match(textOf(results[1]), /\[window legacy-window\].*Handoff: LEGACY_SAVED_HANDOFF/);
	const reopened = SessionManager.open(h.sessionManager.getSessionFile());
	assert.match(JSON.stringify(reopened.getEntry(ownerId)), /LEGACY_OWNER_INPUT/);
	assert.match(JSON.stringify(reopened.getEntry("legacy-window")), /LEGACY_SAVED_HANDOFF/);
	assert.ok(!reopened.buildSessionProjection().entries.some(({ sourceEntry }) => [ownerId, "legacy-window"].includes(sourceEntry.id)),
		"raw legacy inputs leave active context; only explicitly recovered tool receipts return");
});

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
			reset(manager, "Recover the earlier screenshots.");
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

for (const [callEdit, callNamespace] of [["visible", "survey"], ["omitted", "survey"], ["replaced", "survey"], ["no call namespace", undefined]]) test(`automatic rollover keeps namespaced ask_question as evidence, not owner input (${callEdit} call)`, async (t) => {
	const { session, faux, sessionManager } = await fixture(t, {
		seed(manager) {
			manager.appendMessage({ role: "user", content: "Earlier survey setup", timestamp: Date.now() });
			manager.appendMessage(fauxAssistantMessage("Ready to inspect only."));
		},
		extension(pi) {
			if (callEdit === "omitted" || callEdit === "replaced") pi.on("turn_end", (event, ctx) => {
				if (!event.toolResults.some((result) => result.toolName === "ask_question")) return;
				ctx.sessionManager.appendContextEdit(event.messageEntryId, callEdit === "omitted" ? null : { content: [{ type: "text", text: "Edited assistant call." }] });
			});
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
			{ ...fauxToolCall("ask_question", {}), ...(callNamespace ? { namespace: callNamespace } : {}) },
			fauxToolCall("dump", {}),
		], { stopReason: "toolUse" }),
		(ctx) => { nextRequest = JSON.stringify(ctx.messages); return fauxAssistantMessage("done"); },
	]);
	assert.equal(session.getAllTools().find((tool) => tool.name === "ask_question").namespace, "survey");
	await session.prompt("Read the survey only. Do not deploy.");
	if (!callNamespace) {
		const call = sessionManager.getBranch().find((entry) => entry.message?.role === "assistant" && entry.message.content.some((part) => part.type === "toolCall" && part.name === "ask_question"));
		assert.equal(call.message.content.find((part) => part.name === "ask_question").namespace, undefined);
	}
	const windows = sessionManager.getBranch().filter((entry) => entry.type === "compaction" && entry.details?.posthorse === 1);
	assert.equal(windows.length, 1);
	for (const text of [windows[0].summary, nextRequest]) {
		assert.match(text, /Do not deploy/);
		assert.match(text, /SURVEY_OUTPUT: deployment approved/);
		assert.match(text, /Tool result evidence/);
		assert.doesNotMatch(text, /owner answer via ask_question/);
	}
});

for (const outcome of ["answer", "cancelled", "error"]) test(`automatic rollover preserves bare owner question provenance (${outcome})`, async (t) => {
	const h = await fixture(t, {
		seed(manager) {
			manager.appendMessage({ role: "user", content: "Earlier owner setup", timestamp: Date.now() });
			manager.appendMessage(fauxAssistantMessage("Ready."));
		},
		extension(pi) {
			pi.registerTool({
				name: "ask_question", label: "Owner question", description: "Get direct owner input",
				parameters: { type: "object", properties: {} },
				async execute() {
					if (outcome === "error") throw new Error("OWNER_QUESTION_FAILURE");
					return { content: [{ type: "text", text: outcome === "cancelled" ? "Question cancelled by owner" : "OWNER_APPROVED_INSPECTION" }], details: {} };
				},
			});
			pi.registerTool({
				name: "dump", label: "Dump", description: "Large local result",
				parameters: { type: "object", properties: {} },
				async execute() { return { content: [{ type: "text", text: "x".repeat(600_000) }], details: {} }; },
			});
		},
	});
	let nextRequest;
	h.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("ask_question", {}), fauxToolCall("dump", {})], { stopReason: "toolUse" }),
		(ctx) => { nextRequest = JSON.stringify(ctx.messages); return fauxAssistantMessage("Done."); },
	]);
	await h.session.prompt("Ask the owner, then retain the result.");
	const boundary = h.sessionManager.getBranch().filter((entry) => entry.type === "compaction" && entry.details?.posthorse === 1);
	assert.equal(boundary.length, 1);
	for (const text of [boundary[0].summary, nextRequest]) {
		if (outcome === "error") {
			assert.doesNotMatch(text, /owner answer via ask_question/);
			assert.match(text, /OWNER_QUESTION_FAILURE/);
		} else {
			assert.match(text, /owner answer via ask_question/);
			assert.match(text, outcome === "cancelled" ? /Question cancelled by owner/ : /OWNER_APPROVED_INSPECTION/);
		}
	}
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
	const windows = sessionManager.getBranch().filter((entry) => entry.type === "compaction" && entry.details?.posthorse === 1);
	assert.equal(windows.length, 1);
	assert.equal(requests.length, 2);
	for (const text of [...requests, windows[0].summary]) {
		assert.equal(/PRIVATE_EDIT_MARKER|OBSOLETE_EDIT_MARKER/.test(text), false);
		assert.equal(text.includes("APPROVED_EDIT_MARKER"), true);
	}
	for (const text of [requests[1], windows[0].summary]) {
		assert.equal(text.includes("PRIVATE_TOOL_MARKER"), false);
		assert.equal(text.includes("APPROVED_TOOL_MARKER"), true);
	}
});

test("edited image recovery points to the replacement rather than the raw original", async (t) => {
	const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=" };
	let editId;
	const h = await fixture(t, { seed(manager) {
		const original = manager.appendMessage({ role: "user", content: "PRIVATE_IMAGE_ORIGINAL", timestamp: Date.now() });
		editId = manager.appendContextEdit(original, { content: [image] });
	}, extension(pi) {
		pi.registerTool({ name: "dump", label: "Dump", description: "Trigger local rollover", parameters: { type: "object", properties: {} },
			async execute() { return { content: [{ type: "text", text: "x".repeat(600_000) }], details: {} }; },
		});
	} });
	assert.doesNotMatch(JSON.stringify(h.sessionManager.buildSessionProjection().messages), /PRIVATE_IMAGE_ORIGINAL/);
	let pointer;
	h.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("dump", {}), { stopReason: "toolUse" }),
		() => {
			const handoff = h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction").summary;
			pointer = handoff.match(/recover with history read id ([^\s]+)/)?.[1];
			assert.ok(pointer, handoff);
			return fauxAssistantMessage(fauxToolCall("history", { op: "read", id: pointer }), { stopReason: "toolUse" });
		},
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

for (const mode of ["structured", "custom", "forced-before", "forced-after"]) test(`public Posthorse guidance survives tool additions and rollover (${mode})`, async (t) => {
	const h = await fixture(t, { customPrompt: mode === "custom" ? "CUSTOM_PROMPT_POLICY" : undefined, extension(pi) {
		pi.registerTool({ name: "extra", label: "Extra", description: "Additional fixture tool", parameters: { type: "object", properties: {} }, async execute() {
			return { content: [{ type: "text", text: "done" }], details: {} };
		} });
	} });
	const extension = h.resourceLoader.getExtensions().extensions.find((item) => item.handlers.has("session_before_compact"));
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
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction" && entry.details?.posthorse === 1).length, 1);
	for (const messages of captures) {
		const prompt = getCurrentSystemPrompt(messages);
		const guidance = mode.startsWith("forced-")
			? messages.map(textOf).find((text) => text.includes("## Context self-management (Posthorse)")) ?? ""
			: prompt;
		assert.equal(guidance.split("## Context self-management (Posthorse)").length - 1, 1);
		assert.match(guidance, /verify live state/);
		assert.match(guidance, /available file-editing tools at its absolute path/);
		assert.match(guidance, /already current, leave it unchanged/);
		assert.match(guidance, /Preserve decisions and safety constraints/);
		if (mode.startsWith("forced-")) {
			assert.match(prompt, /OTHER_EXTENSION_POLICY/);
		}
		if (mode === "custom") assert.match(prompt, /CUSTOM_PROMPT_POLICY/);
	}
	if (!mode.startsWith("forced-")) {
		assert.deepEqual(captures[1][0], captures[0][0], "adding a tool must preserve the initial prompt and declarations");
		assert.match(captures[0][0].sections?.posthorse ?? "", /Context self-management/);
		assert.ok(captures[1].slice(1).some((message) => message.role === "system" && message.toolsAdded?.some((tool) => tool.name === "extra")));
	}
	const reopened = SessionManager.open(h.sessionManager.getSessionFile()).buildSessionContext().messages;
	assert.deepEqual(getCurrentTools(reopened).map((tool) => tool.name).sort(), ["extra", "new_context"]);
	if (mode.startsWith("forced-")) assert.doesNotMatch(getCurrentSystemPrompt(reopened), /OTHER_EXTENSION_POLICY/, "run-only forced policy must not replace the saved structured prompt");
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
	h.session.setActiveToolsByName(["new_context", catalog.name]);
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
	assert.equal(branch.filter((entry) => entry.type === "compaction" && entry.details?.posthorse === 1).length, 0, "a denied handoff must not commit any Posthorse boundary");
});

for (const [enabled, reads] of [[false, 4], [true, 4], [false, 6], [false, 50]]) test(`public mixed searches/list/reads stay below configured capacity (compaction=${enabled}, reads=${reads})`, async (t) => {
	const h = await fixture(t, { enabled, seed(manager) {
		for (let index = 0; index < 60; index++) manager.appendMessage({ role: "user", content: `needle ${"h".repeat(500)}`, timestamp: index });
		reset(manager, "Historical fixture");
	} });
	const dir = join(h.cwd, ".pi", "notes");
	mkdirSync(dir, { recursive: true });
	for (let index = 0; index < 220; index++) writeFileSync(join(dir, `${index}-${"n".repeat(100)}.md`), `needle ${"n".repeat(300)}`);
	writeFileSync(join(dir, "long.md"), "L".repeat(30_000));
	let before, after, results, calls;
	h.faux.setResponses([
		() => {
			before = h.session.getContextUsage().tokens;
			const owner = h.sessionManager.getBranch().findLast((entry) => entry.message?.role === "user");
			calls = reads === 4 ? [
				fauxToolCall("history", { op: "search", query: "needle", limit: 50 }),
				fauxToolCall("notes", { op: "search", query: "needle" }),
				fauxToolCall("notes", { op: "list" }),
				fauxToolCall("notes", { op: "read", path: "long.md" }),
			] : Array.from({ length: reads }, (_, index) => index % 2
				? fauxToolCall("history", { op: "read", id: owner.id, offset: (index % 3) * 20_000 })
				: fauxToolCall("notes", { op: "read", path: "long.md" }));
			return fauxAssistantMessage(calls, { stopReason: "toolUse" });
		},
		(ctx) => {
			after = h.session.getContextUsage().tokens;
			results = ctx.messages.filter((message) => message.role === "toolResult");
			return fauxAssistantMessage("done");
		},
	]);
	await h.session.prompt("p".repeat(reads === 4 ? enabled ? 305_000 : 365_000 : 300_000));
	assert.equal(h.faux.getPendingResponseCount(), 0);
	assert.ok(after < (enabled ? 83_617 : 100_000), JSON.stringify({ before, after, enabled }));
	assert.equal(results.length, reads, "bounded results should not force avoidable rollover");
	assert.ok(results.some((result) => result.isError));
	for (const result of results) {
		const details = h.sessionManager.getBranch().findLast((entry) => entry.message?.toolCallId === result.toolCallId)?.message?.details;
		if (details?.kind === "history-read" || details?.kind === "note-read") {
			assert.ok(details.end - details.offset <= 40_000, "read payload ceiling excludes its bounded header/continuation");
		} else assert.ok(textOf(result).length <= 40_000);
	}
	if (reads > 4) {
		assert.ok(results.some((result) => /continue with offset|and offset/.test(textOf(result))), "partial pages retain continuation offsets");
		assert.ok(results.some((result) => textOf(result).includes("Too little context remains")), "at least one sibling refusal carries retry guidance");
		const offsets = new Map(calls.map((call) => [call.id, call.arguments.offset ?? 0]));
		for (const result of results) if (textOf(result).includes("Too little context remains")) {
			assert.match(textOf(result), new RegExp(`retry with offset ${offsets.get(result.toolCallId)}`));
		}
	}
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.type === "compaction" && entry.details?.posthorse === 1).length, 1);
	t.diagnostic(JSON.stringify({ before, after, enabled, reads }));
});

test("public enabled-to-disabled policy removes the active reminder but keeps its journal entry", async (t) => {
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

test("public checkpoint reminder reaches the model after Pi compacts inside a rollover window", async (t) => {
	const h = await fixture(t, { seed(manager) {
		manager.appendMessage({ role: "user", content: "first window", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("ok"));
		reset(manager, "prior handoff");
		manager.appendMessage({ role: "user", content: "second window, summarized", timestamp: 2 });
		manager.appendMessage(fauxAssistantMessage("ok"));
		const kept = manager.appendMessage({ role: "user", content: "second window, kept", timestamp: 3 });
		manager.appendMessage(fauxAssistantMessage("ok"));
		manager.appendCompaction("Pi summary of the window's start", kept, 5000);
	} });
	let input;
	h.faux.setResponses([
		fauxAssistantMessage("First response in reminder band"),
		(ctx) => {
			input = JSON.stringify(ctx.messages);
			return fauxAssistantMessage("Checkpoint reminder received");
		},
	]);
	await h.session.prompt("p".repeat(305_000));
	assert.doesNotMatch(input ?? "", /Context window \S+ starts here/, "the compaction removed the window marker");
	assert.match(input ?? "", /Checkpoint now:/);
});

for (const nativeCompact of [false, true]) test(`public history search skips entries still in the active context (nativeCompact=${nativeCompact})`, async (t) => {
	const h = await fixture(t, { seed(manager) {
		manager.appendMessage({ role: "user", content: "IN_CONTEXT_NEEDLE before rollover", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("ok"));
		if (!nativeCompact) reset(manager, "carry on");
		const kept = manager.appendMessage({ role: "user", content: "IN_CONTEXT_NEEDLE after rollover", timestamp: 2 });
		manager.appendMessage(fauxAssistantMessage("ok"));
		if (nativeCompact) manager.appendCompaction("Earlier work summarized", kept, 100);
	} });
	h.faux.setResponses([
		fauxAssistantMessage([
			fauxToolCall("history", { op: "search", query: "in_context_needle" }),
			fauxToolCall("history", { op: "search", query: "in_context_needle", all: true }),
		], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await h.session.prompt("Look back.");
	const results = h.sessionManager.getBranch().filter((entry) => entry.type === "message" && entry.message.toolName === "history").map((entry) => textOf(entry.message));
	assert.equal(results.length, 2);
	for (const text of results) {
		assert.match(text, /\[user\] IN_CONTEXT_NEEDLE before rollover/);
		assert.doesNotMatch(text, /IN_CONTEXT_NEEDLE after rollover/);
		assert.match(text, /\[Skipped \d+ match(es)? already in your active context\.\]/);
	}
});

for (const all of [false, true]) test(`public search cursors finish despite appended lookup echoes (all=${all})`, async (t) => {
	const h = await fixture(t, { seed(manager) {
		for (let index = 0; index < 9; index++) manager.appendMessage({ role: "user", content: `CURSOR-NEEDLE original ${index}`, timestamp: index });
		manager.appendMessage({ role: "toolResult", toolName: "notes", toolCallId: "prior", content: [{ type: "text", text: "CURSOR-NEEDLE prior recovery echo" }], isError: false, timestamp: 10 });
		// Earlier-window entries are what search recovers; this window's lookup echoes stay in context.
		reset(manager, "Paging fixture");
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
	assert.ok(returned.length > originals.length, "the earlier window's recovery echo remains searchable");
	assert.ok(nativeIds.includes(priorEcho), "the original recovery echo remains retrievable too");
	t.diagnostic(JSON.stringify({ all, originals: originals.length, returned: returned.length }));
});
