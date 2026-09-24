import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createPosthorse } from "../index.ts";

const textOf = (message) => typeof message?.content === "string" ? message.content : message?.content?.map((part) => part.text ?? "").join("\n") ?? "";
const toolTurn = (...calls) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const overflow = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long: 300000 tokens > 100000 maximum" });
const boundaries = (h) => h.sessionManager.getBranch().filter((entry) => entry.type === "compaction" && entry.details?.posthorse === 1);
const result = (h, name) => h.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === name)?.message;

async function fixture(t, options = {}) {
	assert.equal(VERSION, "0.87.1");
	const temp = mkdtempSync(join(tmpdir(), "posthorse-official-"));
	t.diagnostic(`isolated fixture: ${temp}`);
	const cwd = join(temp, "project"), agentDir = join(temp, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	if (options.persistedPolicy) {
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { enabled: options.enabled ?? true, reserveTokens: options.reserveTokens ?? 16_384 } }));
	}
	const faux = fauxProvider({ models: [{ id: "official-posthorse", contextWindow: options.contextWindow ?? 100_000, maxTokens: 1000 }] });
	const setResponses = faux.setResponses;
	faux.setResponses = (steps) => setResponses(steps.map((step) => (ctx, opts) => {
		opts.cacheRetention = "none";
		return typeof step === "function" ? step(ctx, opts) : step;
	}));
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: options.enabled ?? true, reserveTokens: options.reserveTokens ?? 16_384 }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPromptOverride: () => "OFFICIAL_SYSTEM_POLICY",
		additionalExtensionPaths: options.persistedPolicy ? [fileURLToPath(new URL("../index.ts", import.meta.url))] : [],
		extensionFactories: [
			(pi) => { pi.registerProvider(faux.provider); options.extension?.(pi); },
			...(options.persistedPolicy ? [] : [createPosthorse((ctx) => settingsManager.getCompactionSettings(ctx.model))]),
			...(options.afterExtension ? [options.afterExtension] : []),
		],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const sessionManager = SessionManager.create(cwd, join(temp, "sessions"));
	options.seed?.(sessionManager, faux.getModel());
	const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model: faux.getModel(), resourceLoader, settingsManager, sessionManager, noTools: "builtin" });
	t.after(() => session.dispose());
	await session.bindExtensions({ onError(error) { throw new Error(error.error); } });
	return { cwd, agentDir, session, faux, sessionManager, settingsManager, modelRuntime, resourceLoader };
}

function registerDump(pi, terminate = false) {
	pi.registerTool({ name: "dump", label: "Dump", description: "Oversized local output", parameters: { type: "object", properties: {} },
		async execute() { return { content: [{ type: "text", text: `DUMP_HEAD ${"x".repeat(600_000)} DUMP_TAIL` }], details: {}, terminate }; },
	});
}

test("official explicit reset preserves system/tools and raw transcript; notes/history work after reset and resume", async (t) => {
	const h = await fixture(t);
	let fresh;
	h.faux.setResponses([
		toolTurn(fauxToolCall("notes", { op: "write", path: "task.md", content: "DURABLE_NEXT_STEP" }), fauxToolCall("new_context", { handoff: "CONTINUE_HERE" })),
		(ctx) => { fresh = structuredClone(ctx.messages); return toolTurn(fauxToolCall("notes", { op: "read", path: "task.md" }), fauxToolCall("history", { op: "search", query: "RAW_ORIGINAL_OWNER" })); },
		fauxAssistantMessage("Recovered."),
	]);
	await h.session.prompt("RAW_ORIGINAL_OWNER: save state and reset.");
	assert.equal(boundaries(h).length, 1);
	const boundary = boundaries(h)[0];
	assert.equal(boundary.firstKeptEntryId, boundary.id);
	assert.equal(boundary.usage, undefined, "no summarization model usage");
	assert.equal(fresh[0].role, "system");
	assert.match(getCurrentSystemPrompt(fresh), /OFFICIAL_SYSTEM_POLICY/);
	assert.match(getCurrentSystemPrompt(fresh), /Context self-management/);
	assert.deepEqual(getCurrentTools(fresh).map((tool) => tool.name).sort(), h.session.getActiveToolNames().sort());
	assert.equal(fresh.filter((message) => message.role !== "system").length, 1);
	assert.match(JSON.stringify(fresh), /CONTINUE_HERE/);
	assert.doesNotMatch(JSON.stringify(fresh), /RAW_ORIGINAL_OWNER|DURABLE_NEXT_STEP/);
	assert.match(textOf(result(h, "notes")), /DURABLE_NEXT_STEP/);
	assert.match(textOf(result(h, "history")), /RAW_ORIGINAL_OWNER/);
	assert.match(readFileSync(h.sessionManager.getSessionFile(), "utf8"), /RAW_ORIGINAL_OWNER/);
	const reopened = SessionManager.open(h.sessionManager.getSessionFile());
	assert.deepEqual(reopened.buildSessionContext().messages, JSON.parse(JSON.stringify(h.sessionManager.buildSessionContext().messages)));
	assert.equal(h.faux.state.callCount, 3);
});

test("a failed sibling cancels the explicit reset for the whole batch", async (t) => {
	const h = await fixture(t);
	let next;
	h.faux.setResponses([
		toolTurn(fauxToolCall("new_context", { handoff: "MUST_NOT_COMMIT" }), fauxToolCall("notes", { op: "read", path: "missing.md" })),
		(ctx) => { next = JSON.stringify(ctx.messages); return fauxAssistantMessage("Handle the failed note first."); },
	]);
	await h.session.prompt("BATCH_OWNER_INPUT");
	assert.equal(result(h, "notes").isError, true);
	assert.equal(boundaries(h).length, 0);
	assert.match(next, /BATCH_OWNER_INPUT/);
});

test("oversized tool output rolls over without credentials and repeated resets do not nest recovery", async (t) => {
	const h = await fixture(t, { extension: registerDump });
	const requests = [];
	h.faux.setResponses([
		toolTurn(fauxToolCall("dump", {})),
		(ctx) => { requests.push(structuredClone(ctx.messages)); return toolTurn(fauxToolCall("dump", {})); },
		(ctx) => { requests.push(structuredClone(ctx.messages)); return fauxAssistantMessage("Done."); },
	]);
	await h.session.prompt("OWNER_APPROVAL: inspect only.");
	assert.equal(boundaries(h).length, 2);
	assert.equal(h.faux.state.callCount, 3, "no summarization request");
	for (const request of requests) {
		assert.equal(request[0].role, "system");
		assert.equal(request.filter((message) => message.role !== "system").length, 1);
		assert.match(JSON.stringify(request), /DUMP_HEAD/);
		assert.match(JSON.stringify(request), /DUMP_TAIL/);
		assert.ok(JSON.stringify(request).length < 30_000);
	}
	assert.match(boundaries(h)[0].summary, /OWNER_APPROVAL/);
	assert.match(boundaries(h)[1].summary, /Prior automatic recovery text is not nested/);
	assert.equal(boundaries(h)[1].summary.split("Automatic context rollover recovery record.").length, 2);
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.message?.toolName === "dump").length, 2);
});

test("automatic rollover preserves a terminating tool batch without another provider request", async (t) => {
	const h = await fixture(t, { extension: (pi) => registerDump(pi, true) });
	h.faux.setResponses([toolTurn(fauxToolCall("dump", {})), fauxAssistantMessage("MUST_NOT_RUN")]);
	await h.session.prompt("Read the output and stop.");
	assert.equal(boundaries(h).length, 1);
	assert.equal(h.faux.state.callCount, 1);
	assert.match(boundaries(h)[0].summary, /DUMP_HEAD/);
});

test("overflow recovery retries once, then leaves the second failure in history without summarization", async (t) => {
	const h = await fixture(t);
	h.faux.setResponses([overflow(), overflow(), fauxAssistantMessage("MUST_NOT_RUN")]);
	await h.session.prompt("Keep this owner request.");
	assert.equal(h.faux.state.callCount, 2);
	assert.equal(boundaries(h).length, 1);
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.message?.stopReason === "error").length, 2);
	assert.equal(h.sessionManager.getBranch().filter((entry) => entry.customType === "posthorse-overflow-retry").length, 1);
	assert.equal(h.sessionManager.getBranch().at(-1).type, "context_edit");
});

test("successful overflow retry receives a fresh context and later requests can recover again", async (t) => {
	const h = await fixture(t);
	let retry;
	for (let cycle = 0; cycle < 2; cycle++) {
		h.faux.setResponses([overflow(), (ctx) => { retry = ctx.messages; return fauxAssistantMessage("Recovered."); }]);
		await h.session.prompt(`Owner request ${cycle}`);
		assert.equal(retry.filter((message) => message.role !== "system").length, 1);
		assert.doesNotMatch(JSON.stringify(retry), /prompt is too long/);
	}
	assert.equal(boundaries(h).length, 2);
	assert.equal(h.faux.state.callCount, 4);
});

for (const stopReason of ["error", "aborted"]) test(`ordinary ${stopReason} does not trigger a Posthorse reset`, async (t) => {
	const h = await fixture(t);
	h.faux.setResponses([fauxAssistantMessage("", { stopReason, errorMessage: stopReason === "error" ? "HTTP 529 overloaded" : "cancelled" })]);
	await h.session.prompt("Do not lose this input.");
	assert.equal(boundaries(h).length, 0);
	assert.equal(h.faux.state.callCount, 1);
});

test("disabled live settings suppress automatic rollover and reminders but retain explicit reset", async (t) => {
	const h = await fixture(t, { enabled: false, extension: registerDump });
	let oversized;
	h.faux.setResponses([toolTurn(fauxToolCall("dump", {})), (ctx) => { oversized = JSON.stringify(ctx.messages); return fauxAssistantMessage("Done."); }]);
	await h.session.prompt("Inspect the output.");
	assert.equal(boundaries(h).length, 0);
	assert.ok(oversized.length > 600_000);
	assert.match(oversized, /Pi compaction is disabled/);
	h.faux.setResponses([toolTurn(fauxToolCall("new_context", {})), fauxAssistantMessage("Fresh.")]);
	await h.session.prompt("Start fresh.");
	assert.equal(boundaries(h).length, 1);
});

test("checkpoint reminder is deduplicated and removed from active context after live disable", async (t) => {
	const h = await fixture(t);
	h.faux.setResponses([fauxAssistantMessage("First response"), fauxAssistantMessage("Reminder received")]);
	await h.session.prompt("p".repeat(305_000));
	const reminders = () => h.sessionManager.getBranch().filter((entry) => entry.customType === "posthorse-reminder");
	assert.equal(reminders().length, 1);
	h.settingsManager.applyOverrides({ compaction: { enabled: false } });
	let next;
	h.faux.setResponses([(ctx) => { next = JSON.stringify(ctx.messages); return fauxAssistantMessage("Done."); }]);
	await h.session.prompt("Continue without automatic resets.");
	assert.equal(reminders().length, 1);
	assert.doesNotMatch(next, /Checkpoint now:/);
	assert.match(next, /Pi compaction is disabled/);
});

test("automatic handoff preserves projected edits and marks compactions as history windows", async (t) => {
	const h = await fixture(t, { extension: registerDump, seed(manager) {
		const id = manager.appendMessage({ role: "user", content: "PRIVATE_ORIGINAL", timestamp: Date.now() });
		manager.appendContextEdit(id, { content: "APPROVED_REPLACEMENT" });
	} });
	h.faux.setResponses([toolTurn(fauxToolCall("dump", {})), toolTurn(fauxToolCall("history", { op: "search", query: "Automatic context rollover recovery record" })), fauxAssistantMessage("Done.")]);
	await h.session.prompt("Inspect only.");
	assert.match(boundaries(h)[0].summary, /APPROVED_REPLACEMENT/);
	assert.doesNotMatch(boundaries(h)[0].summary, /PRIVATE_ORIGINAL/);
	assert.match(textOf(result(h, "history")), new RegExp(`\\[window ${boundaries(h)[0].id}\\]`));
});

test("note publication retains symlinks/modes, serializes write+append, and propagates failure", async (t) => {
	const h = await fixture(t);
	const dir = join(h.cwd, ".pi", "notes");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "target.md"), "old"); chmodSync(join(dir, "target.md"), 0o640);
	symlinkSync("target.md", join(dir, "alias.md"));
	symlinkSync("new-target.md", join(dir, "dangling.md"));
	mkdirSync(join(dir, "directory"));
	h.faux.setResponses([
		toolTurn(fauxToolCall("notes", { op: "write", path: "alias.md", content: "new" }), fauxToolCall("notes", { op: "append", path: "alias.md", content: "tail" }), fauxToolCall("notes", { op: "write", path: "dangling.md", content: "created" }), fauxToolCall("notes", { op: "write", path: "n".repeat(250), content: "long filename" })),
		toolTurn(fauxToolCall("notes", { op: "write", path: "directory", content: "failure" }), fauxToolCall("new_context", { handoff: "MUST_NOT_COMMIT" })),
		fauxAssistantMessage("Failed publication reported."),
	]);
	await h.session.prompt("Update notes.");
	assert.equal(readFileSync(join(dir, "target.md"), "utf8"), "new\ntail\n");
	assert.equal(readFileSync(join(dir, "new-target.md"), "utf8"), "created");
	assert.equal(readFileSync(join(dir, "n".repeat(250)), "utf8"), "long filename");
	assert.equal(lstatSync(join(dir, "alias.md")).isSymbolicLink(), true);
	assert.equal(lstatSync(join(dir, "target.md")).mode & 0o777, 0o640);
	assert.equal(result(h, "notes").isError, true);
	assert.equal(boundaries(h).length, 0);
	assert.equal(readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
});

test("the default file extension loads on official Pi and reads persisted settings", async (t) => {
	const h = await fixture(t, { persistedPolicy: true, enabled: false });
	let request;
	h.faux.setResponses([(ctx) => { request = ctx.messages; return toolTurn(fauxToolCall("new_context", { handoff: "Persisted settings test." })); }, fauxAssistantMessage("Fresh.")]);
	await h.session.prompt("Start fresh.");
	assert.match(getCurrentSystemPrompt(request), /Pi compaction is disabled/);
	assert.equal(boundaries(h).length, 1);
	const context = h.session.extensionRunner.createContext();
	assert.equal(context.newContext, undefined);
	assert.equal(context.getCompactionSettings, undefined);
});

test("pending messages reduce the automatic handoff allowance and arrive unchanged after reset", async (t) => {
	let session;
	const h = await fixture(t, { contextWindow: 32_000, reserveTokens: 1_000, extension(pi) {
		pi.registerTool({ name: "queue_dump", label: "Queue dump", description: "Queue input and emit output", parameters: { type: "object", properties: {} },
			async execute() {
				await session.steer(`QUEUED_OWNER_INPUT ${"q".repeat(80_000)}`);
				return { content: [{ type: "text", text: "d".repeat(150_000) }], details: {} };
			},
		});
	} });
	session = h.session;
	let next;
	h.faux.setResponses([toolTurn(fauxToolCall("queue_dump", {})), (ctx) => { next = ctx.messages; return fauxAssistantMessage("Done."); }]);
	await session.prompt(`ORIGINAL_OWNER ${"a".repeat(12_000)}`);
	assert.equal(boundaries(h).length, 1);
	assert.ok(boundaries(h)[0].summary.length < 20_000);
	assert.ok(next.some((message) => textOf(message) === `QUEUED_OWNER_INPUT ${"q".repeat(80_000)}`));
	assert.equal(h.faux.state.callCount, 2);
});

test("an oversized incoming prompt reaches the provider before the first turn_end boundary", async (t) => {
	const h = await fixture(t);
	let first, retry;
	const input = `OVERSIZED_FRESH_INPUT ${"p".repeat(600_000)}`;
	h.faux.setResponses([
		(ctx) => { first = JSON.stringify(ctx.messages); return overflow(); },
		(ctx) => { retry = JSON.stringify(ctx.messages); return fauxAssistantMessage("Recovered after provider rejection."); },
	]);
	await h.session.prompt(input);
	assert.ok(first.includes(input), "turn_end cannot intercept initial provider input");
	assert.ok(first.length > 600_000);
	assert.ok(retry.length < 30_000);
	assert.equal(boundaries(h).length, 1);
	assert.equal(h.faux.state.callCount, 2);
});

test("manual compact remains native and calls the summarization provider", async (t) => {
	const h = await fixture(t, { enabled: false });
	h.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	h.faux.setResponses([fauxAssistantMessage("An ordinary response."), fauxAssistantMessage("Another response."), fauxAssistantMessage("NATIVE_MODEL_SUMMARY"), fauxAssistantMessage("NATIVE_PREFIX_SUMMARY")]);
	await h.session.prompt("Ordinary conversation.");
	await h.session.prompt("More conversation.");
	await h.session.compact();
	assert.equal(boundaries(h).length, 0);
	assert.equal(h.faux.state.callCount, 4, "native split-span compaction summarizes history and the retained turn prefix");
	assert.match(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction").summary, /NATIVE_MODEL_SUMMARY/);
});

test("cooperating boundary entries and continuation survive automatic rollover", async (t) => {
	let ownerId;
	const h = await fixture(t, {
		seed(manager) { ownerId = manager.appendMessage({ role: "user", content: "PRIVATE_BEFORE_EDIT", timestamp: Date.now() }); },
		extension(pi) {
			pi.on("turn_end", (event) => {
				if (!textOf(event.message).startsWith("LARGE_COMPLETED_RESPONSE")) return;
				return { entries: [...event.entries,
					{ type: "custom", customType: "other-extension-state", data: { preserved: true } },
					{ type: "context_edit", targetId: ownerId, replacement: { content: "REPLACED_OWNER_INPUT" } },
				], continue: true };
			});
		},
	});
	h.faux.setResponses([fauxAssistantMessage(`LARGE_COMPLETED_RESPONSE ${"x".repeat(600_000)}`), fauxAssistantMessage("Continuation preserved.")]);
	await h.session.prompt("Continue after the boundary.");
	assert.equal(h.faux.state.callCount, 2);
	assert.equal(boundaries(h).length, 1);
	assert.match(boundaries(h)[0].summary, /REPLACED_OWNER_INPUT/);
	assert.doesNotMatch(boundaries(h)[0].summary, /PRIVATE_BEFORE_EDIT/);
	assert.ok(h.sessionManager.getBranch().some((entry) => entry.customType === "other-extension-state"));
	assert.ok(h.sessionManager.getBranch().some((entry) => entry.type === "context_edit" && entry.targetId === ownerId));
});

test("overflow retry survives later metadata and preserves earlier settlement drafts", async (t) => {
	const h = await fixture(t, {
		extension(pi) {
			pi.on("agent_before_settle", (event) => ({ entries: [...event.entries, { type: "custom", customType: "other-settlement-state" }] }));
		},
		afterExtension(pi) {
			pi.on("turn_end", (event) => ({ entries: [...event.entries, { type: "custom", customType: "after-turn-metadata" }] }));
		},
	});
	h.faux.setResponses([overflow(), fauxAssistantMessage("Recovered with other extensions.")]);
	await h.session.prompt("Recover the failed request.");
	assert.equal(h.faux.state.callCount, 2);
	const entries = h.sessionManager.getBranch();
	assert.ok(entries.some((entry) => entry.customType === "posthorse-overflow-retry"));
	assert.ok(entries.some((entry) => entry.customType === "other-settlement-state"));
	assert.equal(entries.filter((entry) => entry.customType === "after-turn-metadata").length, 2);
});

test("late queued input defers an explicit handoff that no longer fits", async (t) => {
	let session;
	const h = await fixture(t, { contextWindow: 32_000, reserveTokens: 1_000, extension(pi) {
		pi.registerTool({ name: "late_input", label: "Late input", description: "Queue late input", parameters: { type: "object", properties: {} },
			async execute() {
				await new Promise((resolve) => setImmediate(resolve));
				await session.steer("q".repeat(85_000));
				return { content: [{ type: "text", text: "Queued." }], details: {} };
			},
		});
	} });
	session = h.session;
	h.faux.setResponses([toolTurn(fauxToolCall("new_context", { handoff: "h".repeat(20_000) }), fauxToolCall("late_input", {})), fauxAssistantMessage("Process queued input first.")]);
	await session.prompt("Save a handoff.");
	assert.equal(result(h, "new_context").isError, false, "execute accepted the original capacity");
	assert.equal(boundaries(h).length, 0, "the boundary must recheck pending input");
	assert.ok(h.sessionManager.getBranch().some((entry) => entry.customType === "posthorse-reset-deferred"));
});

test("resumed over-budget context can invoke native summarization before Posthorse's turn hook", async (t) => {
	let beforeAgent = false, nativeBeforePrompt = false, summaryRequests = 0;
	const h = await fixture(t, {
		seed(manager, model) {
			manager.appendMessage({ role: "user", content: "persisted ".repeat(70_000), timestamp: Date.now() });
			manager.appendMessage({ ...fauxAssistantMessage("Prior response."), provider: model.provider, model: model.id, api: model.api,
				usage: { input: 150_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 150_010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			});
		},
		extension(pi) {
			pi.on("before_agent_start", () => { beforeAgent = true; });
			pi.on("session_before_compact", () => { nativeBeforePrompt = !beforeAgent; });
		},
	});
	h.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	h.faux.setResponses(Array.from({ length: 5 }, () => () => {
		if (!beforeAgent) { summaryRequests++; return fauxAssistantMessage("NATIVE_PREPROMPT_SUMMARY"); }
		return fauxAssistantMessage("New prompt completed.");
	}));
	await h.session.prompt("Resume this session.");
	assert.equal(nativeBeforePrompt, true);
	assert.ok(summaryRequests > 0);
	assert.equal(boundaries(h).length, 0);
	assert.match(h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction").summary, /NATIVE_PREPROMPT_SUMMARY/);
});

test("same-boundary replacement and custom-message references recover committed text and images", async (t) => {
	const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=" };
	const replacement = (kind) => [{ type: "text", text: `${kind}_START ${"r".repeat(15_000)} ${kind}_END` }, image];
	let ownerId, toolId, handoff;
	const h = await fixture(t, {
		seed(manager) { ownerId = manager.appendMessage({ role: "user", content: "PRIVATE_BEFORE_REPLACEMENT", timestamp: Date.now() }); },
		extension(pi) {
			registerDump(pi);
			pi.on("turn_end", (event) => {
				if (!event.toolResults.some((entry) => entry.toolName === "dump")) return;
				toolId = event.toolResultEntryIds[0];
				return { entries: [...event.entries,
					{ type: "context_edit", targetId: ownerId, replacement: { content: replacement("OWNER") } },
					{ type: "context_edit", targetId: toolId, replacement: { content: replacement("TOOL") } },
					{ type: "custom_message", customType: "review-draft", display: true, content: replacement("CUSTOM") },
				] };
			});
		},
	});
	h.faux.setResponses([
		toolTurn(fauxToolCall("dump", {})),
		() => {
			handoff = boundaries(h)[0].summary;
			assert.doesNotMatch(handoff, /entry unknown|PRIVATE_BEFORE_REPLACEMENT/);
			const queries = [...new Set([...handoff.matchAll(/history search query "([^"]+)"/g)].map((match) => match[1]))];
			assert.equal(queries.length, 3, "each draft must have a searchable post-commit locator");
			return toolTurn(...queries.map((query) => fauxToolCall("history", { op: "search", query })));
		},
		(ctx) => {
			const searches = ctx.messages.filter((message) => message.role === "toolResult" && message.toolName === "history");
			assert.equal(searches.length, 3);
			const ids = searches.map((message) => textOf(message).match(/\[window [^\]]+\] \[([^\]]+)\]/)?.[1]);
			const committed = h.sessionManager.getBranch().filter((entry) =>
				entry.type === "context_edit" && [ownerId, toolId].includes(entry.targetId) ||
				entry.type === "custom_message" && entry.customType === "review-draft",
			).map((entry) => entry.id);
			assert.deepEqual([...ids].sort(), committed.sort(), "locators resolve to actual committed entries, never preview IDs or raw originals");
			return toolTurn(...ids.map((id) => fauxToolCall("history", { op: "read", id })));
		},
		fauxAssistantMessage("Recovered replacement evidence."),
	]);
	await h.session.prompt("Inspect only, then recover the full boundary evidence.");
	const reads = h.sessionManager.getBranch().filter((entry) => entry.message?.toolName === "history" && entry.message.details?.kind === "history-read");
	assert.equal(reads.length, 3);
	for (const kind of ["OWNER", "TOOL", "CUSTOM"]) {
		const read = reads.find((entry) => textOf(entry.message).includes(`${kind}_START`));
		assert.ok(read, kind);
		assert.match(textOf(read.message), new RegExp(`${kind}_END`));
		assert.deepEqual(read.message.content.filter((part) => part.type === "image"), [image]);
	}
	assert.match(handoff, /middle omitted/);
});
