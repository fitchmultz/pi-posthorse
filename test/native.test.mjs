import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
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
const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } = await import(new URL(aiPackage.exports["."].import, aiManifest).href);
const root = fileURLToPath(new URL("..", import.meta.url));

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
	assert.match(JSON.stringify(recovery), /Unconsumed tool batch/);
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
