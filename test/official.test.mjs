import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { createPosthorse } from "../index.ts";
import { retainSession } from "./fixture-files.ts";

const textOf = (message) =>
	typeof message?.content === "string"
		? message.content
		: (message?.content?.map((part) => part.text ?? "").join("\n") ?? "");
const toolTurn = (...calls) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const overflow = () =>
	fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: "prompt is too long: 300000 tokens > 100000 maximum",
	});
const boundaries = (h) =>
	h.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "compaction" && entry.details?.posthorse === 1);
const toolResult = (h, name) =>
	h.sessionManager
		.getBranch()
		.findLast(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === name,
		)?.message;

function isolateAgentDir(t, agentDir, options) {
	if (!options.fileExtension) {
		return;
	}
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previous;
		}
	});
}

async function fixture(t, options = {}) {
	const temp = mkdtempSync(join(tmpdir(), "posthorse-official-"));
	t.diagnostic(`isolated fixture: ${temp}`);
	const cwd = join(temp, "project"),
		agentDir = join(temp, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	isolateAgentDir(t, agentDir, options);
	const faux = fauxProvider({
		models: options.models ?? [
			{
				id: "official-posthorse",
				contextWindow: options.contextWindow ?? 100_000,
				maxTokens: 1000,
			},
		],
	});
	if (options.providerAuth) {
		faux.provider.auth = options.providerAuth;
	}
	const setResponses = faux.setResponses;
	faux.setResponses = (steps) =>
		setResponses(
			steps.map((step) => async (ctx, opts) => {
				// Faux computes usage from this same options object after the callback resolves.
				// Disable its synthetic cache double count without changing the real capacity assertion.
				opts.cacheRetention = "none";
				// Constructed fixtures must not look older than a compaction committed during this run.
				await new Promise((resolve) => setTimeout(resolve, 2));
				const response = await (typeof step === "function" ? step(ctx, opts) : step);
				return { ...response, timestamp: Date.now() };
			}),
		);
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
	});
	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: options.enabled ?? true,
			reserveTokens: options.reserveTokens ?? 16_384,
			keepRecentTokens: options.keepRecentTokens ?? 20_000,
		},
		retry: { enabled: false },
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPromptOverride: () => "OFFICIAL_SYSTEM_POLICY",
		additionalExtensionPaths: options.fileExtension
			? [fileURLToPath(new URL("../index.ts", import.meta.url))]
			: [],
		extensionFactories: [
			(pi) => {
				pi.registerProvider(faux.provider);
				options.extension?.(pi);
			},
			...(options.fileExtension ? [] : [createPosthorse(options.getPolicy)]),
			...(options.afterExtension ? [options.afterExtension] : []),
		],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, options.expectedErrors ?? []);
	const sessionManager = SessionManager.create(cwd, join(temp, "sessions"));
	options.seed?.(sessionManager, faux.getModel());
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		model: faux.getModel(),
		resourceLoader,
		settingsManager,
		sessionManager,
		noTools: "builtin",
	});
	t.after(() => {
		try {
			session.dispose();
		} finally {
			retainSession(temp, sessionManager, "final");
		}
	});
	await session.bindExtensions({
		onError(error) {
			throw new Error(error.error);
		},
	});
	return {
		cwd,
		agentDir,
		session,
		faux,
		sessionManager,
		settingsManager,
		modelRuntime,
		resourceLoader,
	};
}

function registerDump(pi, terminate = false, size = 600_000, image) {
	let dumps = 0;
	pi.registerTool({
		name: "dump",
		label: "Dump",
		description: "Oversized local output",
		parameters: { type: "object", properties: {} },
		async execute() {
			const chars =
				typeof size === "number" ? size : size[Math.min(dumps++, size.length - 1)];
			return {
				content: [
					{ type: "text", text: `DUMP_HEAD ${"x".repeat(chars)} DUMP_TAIL` },
					...(image ? [image] : []),
				],
				details: {},
				terminate,
			};
		},
	});
}

test("official explicit reset preserves system/tools and raw transcript; notes/history work after reset and resume", async (t) => {
	const h = await fixture(t, {
		extension(pi) {
			pi.on("turn_end", (event) =>
				event.toolResults.some((result) => result.toolName === "new_context")
					? {
							entries: [
								...event.entries,
								{
									type: "custom",
									customType: "prior-reset-state",
									data: { preserved: true },
								},
							],
						}
					: undefined,
			);
		},
	});
	let initial, fresh;
	h.faux.setResponses([
		(ctx) => {
			initial = getCurrentSystemPrompt(ctx.messages);
			return toolTurn(
				fauxToolCall("notes", {
					op: "write",
					path: "task.md",
					content: "DURABLE_NEXT_STEP",
				}),
				fauxToolCall("new_context", { handoff: "CONTINUE_HERE" }),
			);
		},
		(ctx) => {
			fresh = structuredClone(ctx.messages);
			return toolTurn(
				fauxToolCall("notes", { op: "read", path: "task.md" }),
				fauxToolCall("history", { op: "search", query: "RAW_ORIGINAL_OWNER" }),
			);
		},
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
	for (const prompt of [initial, getCurrentSystemPrompt(fresh)]) {
		assert.match(prompt, /Configured context capacity: 100,000 tokens/);
		assert.match(prompt, /rollover line is 83,617 tokens used/);
		assert.match(prompt, /Fresh windows use the active configuration/);
		assert.match(
			prompt,
			/Before reporting a remaining-token count or changing your work plan because of context limits, call get_context_remaining/,
		);
	}
	assert.deepEqual(
		getCurrentTools(fresh)
			.map((tool) => tool.name)
			.sort(),
		h.session.getActiveToolNames().sort(),
	);
	assert.equal(fresh.filter((message) => message.role !== "system").length, 1);
	assert.match(JSON.stringify(fresh), /CONTINUE_HERE/);
	assert.doesNotMatch(JSON.stringify(fresh), /RAW_ORIGINAL_OWNER|DURABLE_NEXT_STEP/);
	assert.match(textOf(toolResult(h, "notes")), /DURABLE_NEXT_STEP/);
	assert.match(textOf(toolResult(h, "history")), /RAW_ORIGINAL_OWNER/);
	assert.match(readFileSync(h.sessionManager.getSessionFile(), "utf8"), /RAW_ORIGINAL_OWNER/);
	assert.deepEqual(
		h.sessionManager.getBranch().find((entry) => entry.customType === "prior-reset-state").data,
		{ preserved: true },
		"Posthorse preserves drafts from handlers that ran before its explicit reset",
	);
	const reopened = SessionManager.open(h.sessionManager.getSessionFile());
	assert.deepEqual(
		reopened.buildSessionContext().messages,
		JSON.parse(JSON.stringify(h.sessionManager.buildSessionContext().messages)),
	);
	assert.equal(h.faux.state.callCount, 3);
});

for (const forced of [false, true]) {
	test(`context guidance follows model/settings changes during continuation and reset (forced=${forced})`, async (t) => {
		const h = await fixture(t, {
			models: [
				{ id: "small", contextWindow: 100_000, maxTokens: 1000 },
				{ id: "large", contextWindow: 272_000, maxTokens: 1000 },
			],
			extension(pi) {
				if (forced) {
					pi.on("before_agent_start", (event) => ({
						systemPrompt: `${event.systemPrompt}\n\nOTHER_POLICY`,
					}));
				}
				pi.registerTool({
					name: "switch_model",
					label: "Switch model",
					description: "Switch the active model and reserve",
					parameters: { type: "object", properties: {} },
					async execute() {
						await h.session.setModel(h.faux.getModel("large"));
						h.settingsManager.applyOverrides({ compaction: { reserveTokens: 64_000 } });
						return { content: [{ type: "text", text: "Switched." }], details: {} };
					},
				});
			},
		});
		const prompts = [];
		const capture = (ctx, response) => {
			prompts.push(
				[
					getCurrentSystemPrompt(ctx.messages),
					...ctx.messages.filter((message) => message.role !== "system").map(textOf),
				].join("\n"),
			);
			return response;
		};
		h.faux.setResponses([
			(ctx) => capture(ctx, toolTurn(fauxToolCall("switch_model", {}))),
			(ctx) =>
				capture(
					ctx,
					toolTurn(
						fauxToolCall("new_context", { handoff: "Continue with the larger model." }),
					),
				),
			(ctx) => capture(ctx, fauxAssistantMessage("Fresh.")),
		]);
		await h.session.prompt("Switch model, then start a fresh context.");
		assert.equal(boundaries(h).length, 1);
		assert.equal(prompts.length, 3);
		assert.match(prompts[0], /Configured context capacity: 100,000 tokens/);
		assert.match(prompts[0], /rollover line is 83,617 tokens used/);
		for (const prompt of prompts.slice(1)) {
			assert.match(prompt, /Configured context capacity: 272,000 tokens/);
			assert.match(prompt, /rollover line is 208,001 tokens used/);
			assert.doesNotMatch(prompt, /100,000|83,617/);
			assert.equal(prompt.split("## Context self-management (Posthorse)").length - 1, 1);
			assert.match(prompt, /OFFICIAL_SYSTEM_POLICY/);
			if (forced) {
				assert.match(prompt, /OTHER_POLICY/);
			}
		}
	});
}

test("routed guidance and handoff admission use native context capacity", async (t) => {
	const nativeCapacities = [];
	const h = await fixture(t, {
		models: [
			{ id: "large", contextWindow: 272_000, maxTokens: 1000 },
			{ id: "small", contextWindow: 8192, maxTokens: 4000 },
		],
		providerAuth: {
			apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "fixture-key" } }) },
		},
		afterExtension(pi) {
			pi.on("context_with_system", (_event, ctx) => {
				nativeCapacities.push(ctx.getContextUsage()?.contextWindow);
			});
		},
	});
	let physical = h.faux.getModel("large");
	h.modelRuntime.registerVirtualModel({
		provider: "posthorse-router",
		id: "auto",
		contextWindow: 100_000,
		maxTokens: 1000,
		route: () => ({ model: physical, thinkingLevel: "off" }),
	});
	await h.modelRuntime.setRuntimeApiKey(h.faux.provider.id, "fixture-key");
	await h.modelRuntime.getAvailable();
	await h.session.setModel(h.modelRuntime.getModel("posthorse-router", "auto"));
	let continuing, fresh;
	h.faux.setResponses([
		toolTurn(fauxToolCall("get_context_remaining", {})),
		(ctx) => {
			continuing = getCurrentSystemPrompt(ctx.messages);
			return toolTurn(
				fauxToolCall("new_context", { handoff: "Continue with routed limits." }),
			);
		},
		(ctx) => {
			fresh = getCurrentSystemPrompt(ctx.messages);
			return fauxAssistantMessage("Fresh.");
		},
	]);
	await h.session.prompt("Check the routed budget, then start fresh.");
	assert.equal(
		h.session.model.contextWindow,
		100_000,
		"the selected virtual declaration remains different",
	);
	assert.match(textOf(toolResult(h, "get_context_remaining")), /272,000 used/);
	assert.match(continuing, /Configured context capacity: 272,000 tokens/);
	assert.match(continuing, /rollover line is 255,617 tokens used/);
	assert.doesNotMatch(continuing, /100,000|83,617/);
	// Official Pi forgets the last physical response on reset; use its declared limit
	// until routing/usage makes a physical limit available again, matching the native meter.
	assert.match(
		fresh,
		new RegExp(
			`Configured context capacity: ${nativeCapacities.at(-1).toLocaleString("en-US")} tokens`,
		),
	);

	physical = h.faux.getModel("small");
	h.settingsManager.applyOverrides({ compaction: { enabled: false } });
	h.faux.setResponses([
		toolTurn(fauxToolCall("new_context", { handoff: "x".repeat(20_000) })),
		fauxAssistantMessage("Oversized handoff rejected."),
	]);
	await h.session.prompt("The next route is smaller; admit only a safe handoff.");
	assert.equal(toolResult(h, "new_context").isError, true);
	assert.match(textOf(toolResult(h, "new_context")), /Handoff is too large for the active model/);
	assert.equal(boundaries(h).length, 1, "the rejected handoff must not commit another reset");
});

test("explicit handoff admission counts the real prompt and active tool schemas", async (t) => {
	const h = await fixture(t, {
		contextWindow: 32_768,
		enabled: false,
		afterExtension(pi) {
			let promptOptions, toolTokens;
			pi.on("before_agent_start", (event) => {
				promptOptions = event.systemPromptOptions;
				const active = new Set(pi.getActiveTools());
				toolTokens = pi
					.getAllTools()
					.filter((tool) => active.has(tool.name))
					.reduce(
						(total, tool) =>
							total +
							Math.ceil(
								JSON.stringify({
									name: tool.name,
									description: tool.description ?? "",
									parameters: tool.parameters,
								}).length / 4,
							),
						0,
					);
				return { systemPrompt: "FORCED_POLICY" };
			});
			pi.on("context_with_system", (event) => {
				const guidance = textOf(
					event.messages.find(
						(message) =>
							message.role === "custom" &&
							message.customType === "posthorse-guidance",
					),
				);
				assert.ok(guidance.length > 0);
				const guidanceTokens = Math.ceil(
					`<posthorse>\n${guidance}\n</posthorse>`.length / 4,
				);
				const promptTokens = 32_768 - 1000 - toolTokens - guidanceTokens - 2250;
				assert.ok(promptTokens > 0);
				promptOptions.forceSystemPrompt = "s".repeat(promptTokens * 4);
				// The mutable request-local hook must expose the actual forced prompt to admission checks.
				event.messages[0].content = promptOptions.forceSystemPrompt;
			});
		},
	});
	let fresh;
	h.faux.setResponses([
		toolTurn(fauxToolCall("new_context", { handoff: "x".repeat(5000) })),
		() => {
			assert.equal(toolResult(h, "new_context").isError, true);
			assert.match(textOf(toolResult(h, "new_context")), /too large.*limit 4,500/i);
			return toolTurn(fauxToolCall("new_context", { handoff: "y".repeat(4000) }));
		},
		(ctx) => {
			fresh = ctx.messages;
			return fauxAssistantMessage("Fresh.");
		},
	]);
	await h.session.prompt("Admit only a safe handoff.");
	assert.equal(boundaries(h).length, 1);
	assert.equal(boundaries(h)[0].summary, "y".repeat(4000));
	assert.equal(
		fresh.filter((message) => message.role !== "system").length,
		2,
		"only the handoff and current forced-prompt guidance remain",
	);
	assert.equal(
		fresh.filter((message) =>
			textOf(message).startsWith("## Context self-management (Posthorse)"),
		).length,
		1,
	);
	assert.doesNotMatch(JSON.stringify(fresh), /x{5000}/);
});

test("a failed sibling cancels the explicit reset for the whole batch", async (t) => {
	const h = await fixture(t);
	let next;
	h.faux.setResponses([
		toolTurn(
			fauxToolCall("new_context", { handoff: "MUST_NOT_COMMIT" }),
			fauxToolCall("notes", { op: "read", path: "missing.md" }),
		),
		(ctx) => {
			next = JSON.stringify(ctx.messages);
			return fauxAssistantMessage("Handle the failed note first.");
		},
	]);
	await h.session.prompt("BATCH_OWNER_INPUT");
	assert.equal(toolResult(h, "notes").isError, true);
	assert.equal(boundaries(h).length, 0);
	assert.match(next, /BATCH_OWNER_INPUT/);
	h.faux.setResponses([
		toolTurn(fauxToolCall("new_context", { handoff: "SUCCESS_AFTER_FAILURE" })),
		fauxAssistantMessage("Fresh."),
	]);
	await h.session.prompt("Retry the checkpoint.");
	assert.equal(boundaries(h).length, 1);
	assert.equal(boundaries(h)[0].summary, "SUCCESS_AFTER_FAILURE");
	assert.doesNotMatch(
		JSON.stringify(
			SessionManager.open(h.sessionManager.getSessionFile()).buildSessionContext().messages,
		),
		/BATCH_OWNER_INPUT|MUST_NOT_COMMIT/,
	);
});

for (const order of ["before", "after"]) {
	test(`a colliding foreign new_context cannot authorize Posthorse rollover (${order})`, async (t) => {
		let foreignCalls = 0,
			next;
		const foreign = (pi) =>
			pi.registerTool({
				name: "new_context",
				namespace: "survey",
				label: "Survey context",
				description: "An unrelated context query",
				parameters: { type: "object", properties: { handoff: { type: "string" } } },
				async execute() {
					foreignCalls++;
					return {
						content: [{ type: "text", text: "FOREIGN_RESULT" }],
						details: { foreign: true },
					};
				},
			});
		const h = await fixture(t, {
			...(order === "before" ? { extension: foreign } : { afterExtension: foreign }),
			expectedErrors: [
				{
					path: order === "before" ? "<inline:2>" : "<inline:3>",
					error: `Tool "new_context" conflicts with ${order === "before" ? "<inline:1>" : "<inline:2>"}`,
				},
			],
		});
		h.faux.setResponses([
			toolTurn({
				...fauxToolCall("new_context", { handoff: "COLLIDING_ARGUMENT" }),
				namespace: "survey",
			}),
			(ctx) => {
				next = JSON.stringify(ctx.messages);
				return fauxAssistantMessage("Done.");
			},
		]);
		await h.session.prompt("OWNER_KEEP_CONTEXT");
		assert.equal(foreignCalls, order === "before" ? 1 : 0);
		assert.equal(boundaries(h).length, order === "before" ? 0 : 1);
		if (order === "before") {
			assert.equal(toolResult(h, "new_context").details.foreign, true);
			assert.match(next, /OWNER_KEEP_CONTEXT|FOREIGN_RESULT/);
		} else {
			assert.equal(toolResult(h, "new_context").details.kind, "new-context");
			assert.equal(boundaries(h)[0].summary, "COLLIDING_ARGUMENT");
			assert.doesNotMatch(next, /OWNER_KEEP_CONTEXT|FOREIGN_RESULT/);
		}
	});
}

test("oversized tool output rolls over without credentials and repeated resets do not nest recovery", async (t) => {
	const image = {
		type: "image",
		mimeType: "image/png",
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=",
	};
	const h = await fixture(t, { extension: (pi) => registerDump(pi, false, 600_000, image) });
	const requests = [];
	for (let cycle = 0; cycle < 2; cycle++) {
		h.faux.setResponses([
			toolTurn(fauxToolCall("dump", {})),
			(ctx) => {
				requests.push(structuredClone(ctx.messages));
				const entry = h.sessionManager
					.getBranch()
					.findLast((candidate) => candidate.message?.toolName === "dump");
				assert.match(
					boundaries(h).at(-1).summary,
					new RegExp(
						`\\[1 image: image/png\\] — recover with history read id ${entry.id}`,
					),
				);
				assert.doesNotMatch(
					boundaries(h).at(-1).summary,
					new RegExp(image.data.slice(0, 20)),
				);
				return toolTurn(fauxToolCall("history", { op: "read", id: entry.id }));
			},
			fauxAssistantMessage("Done."),
		]);
		// Reuse the same session to prove later resets do not nest the earlier recovery.
		// oxlint-disable-next-line no-await-in-loop
		await h.session.prompt(`OWNER_APPROVAL: inspect only. Cycle ${cycle}.`);
		assert.deepEqual(
			toolResult(h, "history").content.filter((part) => part.type === "image"),
			[image],
		);
		assert.match(textOf(toolResult(h, "history")), /\[toolResult\] DUMP_HEAD/);
		assert.match(textOf(toolResult(h, "history")), /More remains; call history read/);
	}
	assert.equal(boundaries(h).length, 2);
	assert.equal(
		h.faux.state.callCount,
		6,
		"two dump/recovery/response batches, no summarization request",
	);
	for (const request of requests) {
		assert.equal(request[0].role, "system");
		assert.equal(request.filter((message) => message.role !== "system").length, 1);
		assert.match(JSON.stringify(request), /DUMP_HEAD/);
		assert.match(JSON.stringify(request), /DUMP_TAIL/);
		assert.ok(JSON.stringify(request).length < 30_000);
	}
	assert.match(boundaries(h)[0].summary, /OWNER_APPROVAL/);
	assert.match(boundaries(h)[1].summary, /Earlier automatic records skipped/);
	assert.equal(
		boundaries(h)[1].summary.split("Automatic context rollover recovery record.").length,
		2,
	);
	assert.equal(
		h.sessionManager.getBranch().filter((entry) => entry.message?.toolName === "dump").length,
		2,
	);
	for (const boundary of boundaries(h)) {
		assert.equal(boundary.fromHook, true);
		assert.equal(boundary.usage, undefined);
		assert.equal(
			h.sessionManager.getEntry(boundary.firstKeptEntryId).customType,
			"posthorse-boundary",
		);
	}
	const reopened = SessionManager.open(h.sessionManager.getSessionFile());
	assert.deepEqual(
		reopened.buildSessionContext().messages,
		JSON.parse(JSON.stringify(h.sessionManager.buildSessionContext().messages)),
	);
});

for (const reserveTokens of [64_000, 32_000, 24_000]) {
	test(`reserve investigation preserves stable request inputs across automatic rollover (${reserveTokens})`, async (t) => {
		const h = await fixture(t, { contextWindow: 335_000, reserveTokens });
		let initialSystem, initialTools, fresh;
		h.faux.setResponses([
			(ctx) => {
				initialSystem = getCurrentSystemPrompt(ctx.messages);
				initialTools = structuredClone(getCurrentTools(ctx.messages));
				return fauxAssistantMessage("Ready for the synthetic fixture.");
			},
		]);
		await h.session.prompt("Establish the stable system and tools.");
		h.sessionManager.appendMessage({
			role: "user",
			content: `ARCHIVED_OWNER ${"o".repeat(1_200_000)}`,
			timestamp: 1,
		});
		h.sessionManager.appendMessage(
			fauxAssistantMessage(`RECENT_ASSISTANT ${"a".repeat(16_000)}`),
		);
		h.sessionManager.appendMessage({
			role: "user",
			content: `RETAINED_OWNER ${"u".repeat(20_000)}`,
			timestamp: 2,
		});
		h.sessionManager.appendMessage(
			toolTurn({ ...fauxToolCall("read", {}), id: "stable-read" }),
		);
		h.sessionManager.appendMessage({
			role: "toolResult",
			toolName: "read",
			toolCallId: "stable-read",
			content: [{ type: "text", text: `RETAINED_RECEIPT ${"r".repeat(40_000)}` }],
			isError: false,
			timestamp: 3,
		});
		h.faux.setResponses([fauxAssistantMessage("Finish the full window.")]);
		await h.session.prompt("Finish this synthetic window.");
		assert.equal(
			h.faux.state.callCount,
			2,
			"rollover must not add a summary or wake a finished run",
		);
		assert.equal(boundaries(h).length, 1);
		assert.equal(boundaries(h)[0].details.reason, "threshold");
		h.faux.setResponses([
			(ctx) => {
				fresh = structuredClone(ctx.messages);
				return fauxAssistantMessage("Continue from the retained tail.");
			},
		]);
		await h.session.prompt("Continue after the synthetic automatic boundary.");
		assert.equal(h.faux.state.callCount, 3);
		assert.equal(boundaries(h)[0].usage, undefined);
		assert.ok(boundaries(h)[0].summary.length <= 20_000);
		assert.equal(getCurrentSystemPrompt(fresh), initialSystem);
		assert.deepEqual(getCurrentTools(fresh), initialTools);
		for (const marker of ["RECENT_ASSISTANT", "RETAINED_OWNER", "RETAINED_RECEIPT"]) {
			assert.ok(
				fresh.some((message) => textOf(message).startsWith(marker)),
				marker,
			);
			assert.ok(!boundaries(h)[0].summary.includes(marker), marker);
		}
		assert.ok(!fresh.some((message) => textOf(message).startsWith("ARCHIVED_OWNER")));
		assert.match(boundaries(h)[0].summary, /ARCHIVED_OWNER/);
		const evidence = process.env.PI_COMPAT_EVIDENCE_DIR;
		if (evidence) {
			mkdirSync(evidence, { recursive: true });
			writeFileSync(
				join(evidence, `reserve-${reserveTokens}.jsonl`),
				readFileSync(h.sessionManager.getSessionFile()),
			);
		}
	});
}

for (const [reason, asynchronous] of [
	["threshold", false],
	["threshold", true],
	["overflow", false],
	["overflow", true],
]) {
	test(`automatic ${reason} retains the effective recent projected tail without duplicating recovery (async=${asynchronous})`, async (t) => {
		const ids = {};
		const h = await fixture(t, {
			contextWindow: 335_000,
			reserveTokens: 64_000,
			keepRecentTokens: 1,
			seed(manager) {
				manager.appendMessage({
					role: "user",
					content: `DISCARDED_OWNER ${"o".repeat(reason === "threshold" ? 1_100_000 : 200_000)}`,
					timestamp: 1,
				});
				ids.prose = manager.appendMessage(
					fauxAssistantMessage(`RECENT_ASSISTANT ${"a".repeat(40_000)}`),
				);
				ids.owner = manager.appendMessage({
					role: "user",
					content: `RETAINED_OWNER ${"u".repeat(20_000)}`,
					timestamp: 2,
				});
				const omitted = manager.appendMessage({
					role: "user",
					content: "OMITTED_PRIVATE_INPUT",
					timestamp: 3,
				});
				manager.appendContextEdit(omitted, null);
				ids.call = manager.appendMessage(
					toolTurn({
						...fauxToolCall("read", {}),
						id: "retained-read",
						...(asynchronous ? { async: true } : {}),
					}),
				);
				ids.result = manager.appendMessage({
					role: "toolResult",
					toolName: "read",
					toolCallId: "retained-read",
					content: [{ type: "text", text: "PRIVATE_UNEDITED_RESULT" }],
					isError: false,
					timestamp: 4,
				});
				manager.appendContextEdit(ids.result, {
					content: [{ type: "text", text: `PROJECTED_RECEIPT ${"r".repeat(80_000)}` }],
				});
			},
		});
		h.settingsManager.applyOverrides({
			compaction: {
				modelOverrides: { "faux/official-posthorse": { keepRecentTokens: 30_000 } },
			},
		});
		let fresh;
		h.faux.setResponses([
			...(reason === "overflow" ? [overflow()] : []),
			(ctx) => {
				fresh = ctx.messages;
				return toolTurn(
					fauxToolCall("history", { op: "search", query: "PROJECTED_RECEIPT" }),
				);
			},
			fauxAssistantMessage("Finished without summarization."),
		]);
		await h.session.prompt("Continue with this new input.");
		assert.equal(boundaries(h).length, 1);
		const boundary = boundaries(h)[0];
		assert.equal(boundary.details.reason, reason);
		assert.equal(boundary.firstKeptEntryId, ids.prose);
		assert.equal(boundary.usage, undefined);
		assert.equal(h.faux.state.callCount, reason === "overflow" ? 3 : 2);
		const retained = fresh.filter((message) => message.role !== "system");
		assert.equal(
			retained[0].role,
			"user",
			"retained assistant tail gets a leading user anchor",
		);
		const idxAssistant = retained.findIndex((message) =>
			textOf(message).startsWith("RECENT_ASSISTANT"),
		);
		const idxOwner = retained.findIndex((message) =>
			textOf(message).startsWith("RETAINED_OWNER"),
		);
		const idxReceipt = retained.findIndex((message) =>
			textOf(message).startsWith("PROJECTED_RECEIPT"),
		);
		const idxSummary = retained.findIndex((message) =>
			textOf(message).includes("Automatic context rollover recovery record."),
		);
		assert.ok(idxAssistant >= 0 && idxOwner > idxAssistant && idxReceipt > idxOwner);
		assert.ok(
			idxSummary > idxReceipt,
			"compaction recovery record appears chronologically after the retained pre-rollover tail",
		);
		assert.doesNotMatch(JSON.stringify(fresh), /OMITTED_PRIVATE_INPUT|PRIVATE_UNEDITED_RESULT/);
		assert.doesNotMatch(boundary.summary, /RETAINED_OWNER|PROJECTED_RECEIPT|RECENT_ASSISTANT/);
		assert.match(boundary.summary, /DISCARDED_OWNER/);
		assert.match(
			boundary.summary,
			new RegExp(
				`Context rolled over after entry .*entries ${ids.prose} through .* above are the carried-over recent tail`,
			),
		);
		assert.match(textOf(toolResult(h, "history")), /skipped.*context/i);
		assert.match(textOf(toolResult(h, "history")), /^No history matches/);
		const reopened = SessionManager.open(h.sessionManager.getSessionFile());
		assert.deepEqual(
			reopened.buildSessionContext().messages,
			JSON.parse(JSON.stringify(h.sessionManager.buildSessionContext().messages)),
		);
		h.settingsManager.applyOverrides({
			compaction: {
				modelOverrides: { "faux/official-posthorse": { keepRecentTokens: 25_000 } },
			},
		});
		let repeated;
		h.faux.setResponses([
			overflow(),
			(ctx) => {
				repeated = ctx.messages;
				return fauxAssistantMessage("Recovered again.");
			},
		]);
		await h.session.prompt("Continue after another overflow.");
		assert.equal(boundaries(h).length, 2);
		assert.equal(boundaries(h)[1].firstKeptEntryId, ids.owner);
		const repeatedNonSystem = repeated.filter((message) => message.role !== "system");
		assert.ok(
			textOf(repeatedNonSystem[0]).startsWith("RETAINED_OWNER"),
			"when firstKeptEntryId is already a user message, no extra anchor is prepended",
		);
		const repReceiptIdx = repeatedNonSystem.findIndex((message) =>
			textOf(message).startsWith("PROJECTED_RECEIPT"),
		);
		const repSummaryIdx = repeatedNonSystem.findIndex((message) =>
			textOf(message).includes("Automatic context rollover recovery record."),
		);
		assert.ok(repReceiptIdx > 0 && repSummaryIdx > repReceiptIdx);
		assert.match(JSON.stringify(repeated), /RETAINED_OWNER|PROJECTED_RECEIPT/);
		assert.doesNotMatch(boundaries(h)[1].summary, /RETAINED_OWNER|PROJECTED_RECEIPT/);
		assert.match(
			boundaries(h)[1].summary,
			/No discarded owner or visible coordination inputs were selected for this recovery record\./,
		);
		assert.doesNotMatch(boundaries(h)[1].summary, /No selected current-window owner/);
		assert.equal(
			boundaries(h)[1].summary.split("Automatic context rollover recovery record.").length,
			2,
		);
	});
}

for (const [contextWindow, keepRecentTokens] of [
	[32_000, 0],
	[32_000, 30_000],
	[100_000, 0],
]) {
	test(`automatic retain-none is safe in a ${contextWindow} fresh budget (keep=${keepRecentTokens})`, async (t) => {
		const h = await fixture(t, {
			contextWindow,
			reserveTokens: 1_000,
			keepRecentTokens,
			seed(manager) {
				manager.appendMessage({
					role: "user",
					content: "Earlier input that native preparation can discard.",
					timestamp: 0,
				});
				manager.appendMessage({
					role: "user",
					content: `OLD_INPUT ${"o".repeat(contextWindow * 4)}`,
					timestamp: 1,
				});
				manager.appendMessage(
					toolTurn({ ...fauxToolCall("read", {}), id: "oversized-group" }),
				);
				manager.appendMessage({
					role: "toolResult",
					toolCallId: "oversized-group",
					toolName: "read",
					content: [{ type: "text", text: `BOUNDED_RECEIPT ${"r".repeat(48_000)}` }],
					isError: false,
					timestamp: 2,
				});
			},
		});
		let fresh;
		h.faux.setResponses([
			(ctx) => {
				fresh = ctx.messages;
				return fauxAssistantMessage("Done.");
			},
		]);
		await h.session.prompt("Continue.");
		assert.equal(boundaries(h).length, 1);
		assert.equal(
			h.sessionManager.getEntry(boundaries(h)[0].firstKeptEntryId).customType,
			"posthorse-boundary",
		);
		assert.ok(!fresh.some((message) => message.role === "toolResult"));
		assert.match(boundaries(h)[0].summary, /BOUNDED_RECEIPT/);
		assert.ok(JSON.stringify(fresh).length < 32_000);
		assert.equal(h.faux.state.callCount, 1);
	});
}

test("fresh-window fallback retains paired receipts with a compatible injected policy reader", async (t) => {
	let receipts = 0;
	const h = await fixture(t, {
		getPolicy: () => ({ enabled: true, reserveTokens: 16_384 }),
		extension(pi) {
			pi.registerTool({
				name: "receipt",
				label: "Receipt",
				description: "Read a sizable receipt",
				parameters: { type: "object", properties: {} },
				async execute() {
					return {
						content: [
							{ type: "text", text: `RECEIPT_${++receipts} ${"r".repeat(80_000)}` },
						],
						details: {},
					};
				},
			});
		},
	});
	let fresh;
	h.faux.setResponses([
		toolTurn(fauxToolCall("new_context", { handoff: "Keep inspecting receipts." })),
		...Array.from({ length: 6 }, () => toolTurn(fauxToolCall("receipt", {}))),
		(ctx) => {
			fresh = ctx.messages;
			return fauxAssistantMessage("Done.");
		},
	]);
	await h.session.prompt("Inspect receipts.");
	assert.equal(boundaries(h).length, 2);
	const boundary = boundaries(h)[1];
	assert.equal(boundary.details.reason, "threshold");
	const call = h.sessionManager.getEntry(boundary.firstKeptEntryId);
	assert.equal(call.message.role, "assistant");
	const ids = new Set(
		call.message.content.filter((part) => part.type === "toolCall").map((part) => part.id),
	);
	const result = h.sessionManager.getBranch().find((entry) => ids.has(entry.message?.toolCallId));
	assert.ok(fresh.some((message) => message.toolCallId === result.message.toolCallId));
	assert.ok(!boundary.summary.includes(textOf(result.message).split(" ")[0]));
	assert.ok(fresh.filter((message) => message.role === "toolResult").length < receipts);
	assert.equal(h.faux.state.callCount, 8);
});

test("automatic retention of owner input permits another native threshold rollover in the same run", async (t) => {
	const h = await fixture(t, {
		seed(manager) {
			manager.appendMessage({
				role: "user",
				content: `DISCARDED_OWNER ${"o".repeat(400_000)}`,
				timestamp: 1,
			});
			manager.appendMessage(fauxAssistantMessage("a".repeat(40_000)));
			manager.appendMessage({
				role: "user",
				content: `RETAINED_OWNER ${"u".repeat(10_000)}`,
				timestamp: 2,
			});
		},
		extension(pi) {
			registerDump(pi, false, 80_000);
		},
	});
	const requests = [];
	h.faux.setResponses([
		...Array.from({ length: 6 }, () => (ctx) => {
			requests.push(ctx.messages);
			return toolTurn(fauxToolCall("dump", {}));
		}),
		(ctx) => {
			requests.push(ctx.messages);
			return fauxAssistantMessage("Finished the same uninterrupted run.");
		},
	]);
	await h.session.prompt("Keep working without another owner prompt.");
	assert.equal(boundaries(h).length, 2);
	assert.ok(requests[0].some((message) => textOf(message).startsWith("RETAINED_OWNER")));
	for (const boundary of boundaries(h)) {
		assert.equal(boundary.details.reason, "threshold");
		assert.equal(boundary.fromHook, true, "the native hook, not the fresh-window fallback");
		assert.equal(boundary.usage, undefined);
	}
	assert.equal(
		h.sessionManager.getBranch().filter((entry) => entry.message?.toolName === "dump").length,
		6,
	);
	assert.equal(h.faux.state.callCount, 7, "no extra summary or continuation requests");
	assert.match(textOf(requests.at(-1).at(-1)), /DUMP_TAIL/);
});

for (const omitted of ["call", "result"]) {
	test(`automatic retention drops an incomplete projected tool group (omitted ${omitted})`, async (t) => {
		const h = await fixture(t, {
			keepRecentTokens: 1,
			seed(manager) {
				manager.appendMessage({
					role: "user",
					content: "o".repeat(400_000),
					timestamp: 1,
				});
				manager.appendMessage({
					role: "user",
					content: "LATER_OWNER_INPUT",
					timestamp: 2,
				});
				const call = manager.appendMessage(
					toolTurn({ ...fauxToolCall("read", {}), id: "omitted-call" }),
				);
				const result = manager.appendMessage({
					role: "toolResult",
					toolName: "read",
					toolCallId: "omitted-call",
					content: [{ type: "text", text: "LEGACY_ORPHAN_RECEIPT" }],
					isError: false,
					timestamp: 3,
				});
				manager.appendContextEdit(omitted === "call" ? call : result, null);
			},
		});
		let fresh;
		h.faux.setResponses([
			...(omitted === "call" ? [overflow()] : []),
			(ctx) => {
				fresh = ctx.messages;
				return fauxAssistantMessage("Done.");
			},
		]);
		await h.session.prompt("Continue.");
		assert.equal(boundaries(h).length, 1, "native preparation reached the automatic hook");
		assert.ok(!fresh.some((message) => message.role === "toolResult"));
		assert.ok(!fresh.some((message) => message.role === "assistant"));
		if (omitted === "call") {
			assert.match(boundaries(h)[0].summary, /LEGACY_ORPHAN_RECEIPT/);
			assert.match(boundaries(h)[0].summary, /No matching projected call/);
		} else {
			assert.doesNotMatch(JSON.stringify(fresh), /LEGACY_ORPHAN_RECEIPT/);
		}
		assert.equal(h.faux.state.callCount, omitted === "call" ? 2 : 1);
	});
}

test("a retained old notes reminder neither leaks nor suppresses the new window's notes nudge", async (t) => {
	let oldWindow;
	let oldReminder;
	const h = await fixture(t, {
		keepRecentTokens: 30_000,
		seed(manager) {
			oldWindow = manager.appendCompaction("Earlier explicit handoff.", null, 100, {
				posthorse: 1,
				reason: "explicit",
			});
			manager.appendMessage({
				role: "user",
				content: "o".repeat(250_000),
				timestamp: 1,
			});
			manager.appendMessage(fauxAssistantMessage("a".repeat(40_000)));
			oldReminder = manager.appendCustomMessageEntry(
				"posthorse-reminder",
				"OLD_NOTES_NUDGE",
				true,
				{ windowId: oldWindow, contextWindow: 100_000, reserveTokens: 16_384 },
			);
			manager.appendMessage({
				role: "user",
				content: "u".repeat(20_000),
				timestamp: 2,
			});
			manager.appendMessage({
				...toolTurn({ ...fauxToolCall("read", {}), id: "retained-nudge-receipt" }),
				// Native preflight requires an assistant newer than the preceding compaction.
				timestamp: Date.parse(manager.getEntry(oldWindow).timestamp) + 1,
			});
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "retained-nudge-receipt",
				toolName: "read",
				content: [{ type: "text", text: "r".repeat(80_000) }],
				isError: false,
				timestamp: 3,
			});
		},
	});
	const requests = [];
	h.faux.setResponses([
		(ctx) => {
			requests.push(ctx.messages);
			return toolTurn(fauxToolCall("get_context_remaining", {}));
		},
		(ctx) => {
			requests.push(ctx.messages);
			return fauxAssistantMessage("Continue working after saving notes.");
		},
	]);
	await h.session.prompt("p".repeat(160_000));
	assert.equal(boundaries(h).length, 2, "the earlier explicit boundary and automatic rollover");
	const current = boundaries(h)[1];
	const reminders = h.sessionManager
		.getBranch()
		.filter((entry) => entry.customType === "posthorse-reminder");
	assert.equal(reminders.length, 2);
	assert.equal(reminders[1].details.windowId, current.id);
	assert.notEqual(reminders[1].details.windowId, oldWindow);
	assert.ok(
		h.sessionManager
			.buildSessionProjection()
			.entries.some((entry) => entry.sourceEntry.id === oldReminder),
		"the old reminder really lies in the retained range",
	);
	assert.doesNotMatch(JSON.stringify(requests), /OLD_NOTES_NUDGE/);
	assert.match(
		JSON.stringify(requests[1]),
		/Notes checkpoint:[\s\S]*continue working; let automatic rollover happen without calling new_context/,
	);
	assert.equal(h.faux.state.callCount, 2);
});

test("native terminating batch keeps its receipt without a reset or unsolicited request", async (t) => {
	const h = await fixture(t, { extension: (pi) => registerDump(pi, true) });
	h.faux.setResponses([toolTurn(fauxToolCall("dump", {})), fauxAssistantMessage("MUST_NOT_RUN")]);
	await h.session.prompt("Read the output and stop.");
	assert.equal(boundaries(h).length, 0);
	assert.equal(h.faux.state.callCount, 1);
	let next;
	h.faux.setResponses([
		(ctx) => {
			next = JSON.stringify(ctx.messages);
			return fauxAssistantMessage("Resumed.");
		},
	]);
	await h.session.prompt("Continue after that receipt.");
	assert.equal(boundaries(h).length, 1);
	assert.equal(h.faux.state.callCount, 2, "no summary request or unsolicited continuation");
	assert.match(next, /DUMP_HEAD/);
	assert.match(textOf(toolResult(h, "dump")), /DUMP_TAIL/);
});

test("eligible overflow recovery (keepRecentTokens=1) retries once without summarization", async (t) => {
	const h = await fixture(t, { keepRecentTokens: 1 });
	h.faux.setResponses([overflow(), overflow(), fauxAssistantMessage("MUST_NOT_RUN")]);
	await h.session.prompt("Keep this owner request.");
	assert.equal(h.faux.state.callCount, 2);
	assert.equal(boundaries(h).length, 1);
	assert.equal(
		h.sessionManager.getBranch().filter((entry) => entry.message?.stopReason === "error")
			.length,
		2,
	);
	assert.equal(
		h.sessionManager
			.getBranch()
			.filter((entry) => entry.customType === "posthorse-overflow-retry").length,
		0,
	);
	assert.equal(h.sessionManager.getBranch().at(-1).message.stopReason, "error");
});

test("eligible overflow (keepRecentTokens=1) retries fresh and later requests can recover again", async (t) => {
	const h = await fixture(t, {
		keepRecentTokens: 1,
		extension: (pi) => registerDump(pi, false, 20_000),
	});
	let retry;
	for (let cycle = 0; cycle < 2; cycle++) {
		h.faux.setResponses([
			toolTurn(fauxToolCall("dump", {})),
			overflow(),
			(ctx) => {
				retry = ctx.messages;
				return fauxAssistantMessage("Recovered.");
			},
		]);
		// The later request must recover after the previous retry has settled.
		// oxlint-disable-next-line no-await-in-loop
		await h.session.prompt(`Owner request ${cycle}`);
		const results = retry.filter((message) => message.role === "toolResult");
		assert.equal(results.length, 1, "the safe recent call/result group survives recovery");
		assert.doesNotMatch(JSON.stringify(retry), /prompt is too long/);
		assert.match(textOf(results[0]), /DUMP_HEAD[\s\S]*DUMP_TAIL/);
		assert.doesNotMatch(boundaries(h).at(-1).summary, /Tool result evidence|DUMP_HEAD/);
	}
	assert.equal(boundaries(h).length, 2);
	assert.equal(h.faux.state.callCount, 6);
});

for (const stopReason of ["error", "aborted"]) {
	test(`ordinary ${stopReason} does not trigger a Posthorse reset`, async (t) => {
		const h = await fixture(t);
		h.faux.setResponses([
			fauxAssistantMessage("", {
				stopReason,
				errorMessage: stopReason === "error" ? "HTTP 529 overloaded" : "cancelled",
			}),
		]);
		await h.session.prompt("Do not lose this input.");
		assert.equal(boundaries(h).length, 0);
		assert.equal(h.faux.state.callCount, 1);
	});
}

test("disabled live settings suppress automatic rollover and reminders but retain explicit reset", async (t) => {
	const h = await fixture(t, {
		enabled: false,
		extension: (pi) => registerDump(pi, false, 340_000),
	});
	let oversized;
	h.faux.setResponses([
		toolTurn(fauxToolCall("dump", {})),
		(ctx) => {
			oversized = JSON.stringify(ctx.messages);
			return fauxAssistantMessage("Done.");
		},
	]);
	await h.session.prompt("Inspect the output.");
	assert.equal(boundaries(h).length, 0);
	assert.ok(oversized.length > 340_000, "above the rollover line but within physical capacity");
	assert.match(oversized, /Pi compaction is disabled/);
	h.faux.setResponses([
		toolTurn(fauxToolCall("new_context", {})),
		fauxAssistantMessage("Fresh."),
	]);
	await h.session.prompt("Start fresh.");
	assert.equal(boundaries(h).length, 1);
});

test("automatic handoff preserves projected edits and marks compactions as history windows", async (t) => {
	const h = await fixture(t, {
		extension: registerDump,
		seed(manager) {
			const id = manager.appendMessage({
				role: "user",
				content: "PRIVATE_ORIGINAL",
				timestamp: Date.now(),
			});
			manager.appendContextEdit(id, { content: "APPROVED_REPLACEMENT" });
		},
	});
	// The fresh window's own boundary is in context, so read it rather than search for it.
	h.faux.setResponses([
		toolTurn(fauxToolCall("dump", {})),
		() => toolTurn(fauxToolCall("history", { op: "read", id: boundaries(h)[0].id })),
		fauxAssistantMessage("Done."),
	]);
	await h.session.prompt("Inspect only.");
	assert.match(boundaries(h)[0].summary, /APPROVED_REPLACEMENT/);
	assert.doesNotMatch(boundaries(h)[0].summary, /PRIVATE_ORIGINAL/);
	assert.match(
		textOf(toolResult(h, "history")),
		new RegExp(`\\[window ${boundaries(h)[0].id}\\] \\[${boundaries(h)[0].id}\\]`),
	);
});

test("note publication retains symlinks/modes, serializes write+append, and propagates failure", async (t) => {
	const h = await fixture(t);
	const dir = join(h.cwd, ".pi", "notes");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "target.md"), "old");
	chmodSync(join(dir, "target.md"), 0o640);
	symlinkSync("target.md", join(dir, "alias.md"));
	symlinkSync("new-target.md", join(dir, "dangling.md"));
	mkdirSync(join(dir, "directory"));
	h.faux.setResponses([
		toolTurn(
			fauxToolCall("notes", { op: "write", path: "alias.md", content: "new" }),
			fauxToolCall("notes", { op: "append", path: "alias.md", content: "tail" }),
			fauxToolCall("notes", { op: "write", path: "dangling.md", content: "created" }),
			fauxToolCall("notes", { op: "write", path: "n".repeat(250), content: "long filename" }),
		),
		toolTurn(
			fauxToolCall("notes", { op: "write", path: "directory", content: "failure" }),
			fauxToolCall("new_context", { handoff: "MUST_NOT_COMMIT" }),
		),
		fauxAssistantMessage("Failed publication reported."),
	]);
	await h.session.prompt("Update notes.");
	assert.equal(readFileSync(join(dir, "target.md"), "utf8"), "new\ntail\n");
	assert.equal(readFileSync(join(dir, "new-target.md"), "utf8"), "created");
	assert.equal(readFileSync(join(dir, "n".repeat(250)), "utf8"), "long filename");
	assert.equal(lstatSync(join(dir, "alias.md")).isSymbolicLink(), true);
	assert.equal(lstatSync(join(dir, "target.md")).mode & 0o777, 0o640);
	assert.equal(toolResult(h, "notes").isError, true);
	assert.equal(boundaries(h).length, 0);
	assert.equal(
		readdirSync(dir).some((name) => name.endsWith(".tmp")),
		false,
	);
});

test("default file extension keeps guidance, reminders and explicit reset despite malformed disk settings", async (t) => {
	const h = await fixture(t, { fileExtension: true });
	writeFileSync(join(h.agentDir, "settings.json"), "{malformed");
	const requests = [];
	h.faux.setResponses([
		(ctx) => {
			requests.push(ctx.messages);
			return toolTurn(fauxToolCall("get_context_remaining", {}));
		},
		(ctx) => {
			requests.push(ctx.messages);
			return fauxAssistantMessage("Checkpoint received.");
		},
	]);
	await h.session.prompt("p".repeat(305_000));
	assert.equal(requests.length, 2);
	for (const request of requests) {
		assert.match(getCurrentSystemPrompt(request), /Context self-management \(Posthorse\)/);
	}
	assert.match(JSON.stringify(requests[1]), /Notes checkpoint:/);
	assert.equal(
		h.sessionManager
			.getBranch()
			.filter(
				(entry) =>
					entry.type === "custom_message" && entry.customType === "posthorse-reminder",
			).length,
		1,
	);
	h.faux.setResponses([
		toolTurn(fauxToolCall("new_context", { handoff: "Live settings test." })),
		fauxAssistantMessage("Fresh."),
	]);
	await h.session.prompt("Start fresh.");
	assert.equal(boundaries(h).length, 1);
});

test("default policy follows runtime and per-model overrides for guidance, budget and reminders", async (t) => {
	const h = await fixture(t, { fileExtension: true, enabled: false });
	writeFileSync(
		join(h.agentDir, "settings.json"),
		JSON.stringify({ compaction: { enabled: true, reserveTokens: 90_000 } }),
	);
	h.faux.setResponses([
		toolTurn(fauxToolCall("get_context_remaining", {})),
		fauxAssistantMessage("Disabled."),
	]);
	await h.session.prompt("Read the disabled budget.");
	assert.match(textOf(toolResult(h, "get_context_remaining")), /Automatic rollover is disabled/);
	h.settingsManager.applyOverrides({
		compaction: {
			enabled: true,
			reserveTokens: 1_000,
			modelOverrides: { "faux/official-posthorse": { reserveTokens: 32_000 } },
		},
	});
	const requests = [];
	h.faux.setResponses([
		(ctx) => {
			requests.push(ctx.messages);
			return toolTurn(fauxToolCall("get_context_remaining", {}));
		},
		(ctx) => {
			requests.push(ctx.messages);
			return fauxAssistantMessage("Checkpoint received.");
		},
	]);
	await h.session.prompt("p".repeat(240_000));
	for (const request of requests) {
		assert.match(getCurrentSystemPrompt(request), /rollover line is 68,001 tokens/);
	}
	assert.match(textOf(toolResult(h, "get_context_remaining")), /line at 68,001/);
	assert.match(JSON.stringify(requests), /Notes checkpoint:/);
	assert.equal(
		h.sessionManager
			.getBranch()
			.filter(
				(entry) =>
					entry.type === "custom_message" && entry.customType === "posthorse-reminder",
			).length,
		1,
	);
	assert.equal(boundaries(h).length, 0);
});

test("queued input arrives unchanged after native automatic rollover", async (t) => {
	const h = await fixture(t, {
		contextWindow: 32_000,
		reserveTokens: 1_000,
		extension(pi) {
			pi.registerTool({
				name: "queue_dump",
				label: "Queue dump",
				description: "Queue input and emit output",
				parameters: { type: "object", properties: {} },
				async execute() {
					await session.steer(`QUEUED_OWNER_INPUT ${"q".repeat(80_000)}`);
					return { content: [{ type: "text", text: "d".repeat(150_000) }], details: {} };
				},
			});
		},
	});
	const session = h.session;
	let next;
	h.faux.setResponses([
		toolTurn(fauxToolCall("queue_dump", {})),
		(ctx) => {
			next = ctx.messages;
			return fauxAssistantMessage("Done.");
		},
	]);
	await session.prompt(`ORIGINAL_OWNER ${"a".repeat(12_000)}`);
	assert.equal(boundaries(h).length, 1);
	assert.ok(boundaries(h)[0].summary.length < 20_000);
	assert.ok(
		next.some((message) => textOf(message) === `QUEUED_OWNER_INPUT ${"q".repeat(80_000)}`),
	);
	assert.equal(h.faux.state.callCount, 2);
});

test("oversized incoming input obeys the selected host's preflight boundary", async (t) => {
	const h = await fixture(t);
	let first, retry;
	const input = `OVERSIZED_FRESH_INPUT ${"p".repeat(600_000)} OVERSIZED_OWNER_TAIL`;
	h.faux.setResponses([
		(ctx) => {
			first = JSON.stringify(ctx.messages);
			return overflow();
		},
		(ctx) => {
			retry = JSON.stringify(ctx.messages);
			return fauxAssistantMessage("Recovered after provider rejection.");
		},
	]);
	await h.session.prompt(input);
	assert.match(boundaries(h)[0].summary, /OVERSIZED_FRESH_INPUT[\s\S]*OVERSIZED_OWNER_TAIL/);
	assert.ok(first.includes(input), "native input remains unchanged before provider recovery");
	assert.ok(first.length > 600_000);
	assert.ok(retry.length < 30_000);
	assert.equal(boundaries(h).length, 1);
	assert.equal(h.faux.state.callCount, 2);
});

test("manual compact remains native and calls the summarization provider", async (t) => {
	const h = await fixture(t, { enabled: false });
	h.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	h.faux.setResponses([
		fauxAssistantMessage("An ordinary response."),
		fauxAssistantMessage("Another response."),
		fauxAssistantMessage("NATIVE_MODEL_SUMMARY"),
		fauxAssistantMessage("NATIVE_PREFIX_SUMMARY"),
	]);
	await h.session.prompt("Ordinary conversation.");
	await h.session.prompt("More conversation.");
	await h.session.compact();
	assert.equal(boundaries(h).length, 0);
	assert.equal(
		h.faux.state.callCount,
		4,
		"native split-span compaction summarizes history and the retained turn prefix",
	);
	assert.match(
		h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction").summary,
		/NATIVE_MODEL_SUMMARY/,
	);
});

// PR #51 review: recovery after Pi's own /compact starts at its kept tail and carries its summary.
test("automatic recovery after a native /compact excludes summarized inputs and keeps the native summary", async (t) => {
	const h = await fixture(t, { extension: registerDump });
	h.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	h.faux.setResponses([
		fauxAssistantMessage("First response."),
		fauxAssistantMessage("Second response."),
		fauxAssistantMessage("NATIVE_MODEL_SUMMARY"),
		fauxAssistantMessage("NATIVE_PREFIX_SUMMARY"),
	]);
	await h.session.prompt("ANCIENT_OWNER_REQUEST");
	await h.session.prompt("Second owner turn.");
	await h.session.compact();
	assert.equal(h.faux.state.callCount, 4);
	h.faux.setResponses([toolTurn(fauxToolCall("dump", {})), fauxAssistantMessage("Done.")]);
	await h.session.prompt("AFTER_COMPACT_OWNER: inspect only.");
	assert.equal(boundaries(h).length, 1);
	const summary = boundaries(h)[0].summary;
	assert.match(summary, /AFTER_COMPACT_OWNER/);
	assert.match(summary, /older checkpoint; possibly stale[\s\S]*NATIVE_MODEL_SUMMARY/);
	assert.doesNotMatch(summary, /ANCIENT_OWNER_REQUEST/);
	assert.equal(h.faux.state.callCount, 6, "no summary request for the automatic rollover");
});

test("cooperating boundary entries and continuation survive automatic rollover", async (t) => {
	let ownerId;
	const h = await fixture(t, {
		seed(manager) {
			ownerId = manager.appendMessage({
				role: "user",
				content: "PRIVATE_BEFORE_EDIT",
				timestamp: Date.now(),
			});
		},
		extension(pi) {
			pi.on("turn_end", (event) => {
				if (!textOf(event.message).startsWith("LARGE_COMPLETED_RESPONSE")) {
					return;
				}
				return {
					entries: [
						...event.entries,
						{
							type: "custom",
							customType: "other-extension-state",
							data: { preserved: true },
						},
						{
							type: "context_edit",
							targetId: ownerId,
							replacement: { content: "REPLACED_OWNER_INPUT" },
						},
						{
							type: "custom_message",
							customType: "continue-request",
							display: true,
							content: "Continue the inspection.",
						},
					],
					continue: true,
				};
			});
		},
	});
	h.faux.setResponses([
		fauxAssistantMessage(`LARGE_COMPLETED_RESPONSE ${"x".repeat(600_000)}`),
		fauxAssistantMessage("Continuation preserved."),
	]);
	await h.session.prompt("Continue after the boundary.");
	assert.equal(h.faux.state.callCount, 2);
	assert.equal(boundaries(h).length, 1);
	assert.match(boundaries(h)[0].summary, /REPLACED_OWNER_INPUT/);
	assert.doesNotMatch(boundaries(h)[0].summary, /PRIVATE_BEFORE_EDIT/);
	assert.ok(
		h.sessionManager.getBranch().some((entry) => entry.customType === "other-extension-state"),
	);
	assert.ok(
		h.sessionManager
			.getBranch()
			.some((entry) => entry.type === "context_edit" && entry.targetId === ownerId),
	);
});

test("eligible overflow retry (keepRecentTokens=1) preserves later metadata and settlement drafts", async (t) => {
	const h = await fixture(t, {
		keepRecentTokens: 1,
		extension(pi) {
			pi.on("agent_before_settle", (event) => ({
				entries: [
					...event.entries,
					{ type: "custom", customType: "other-settlement-state" },
				],
			}));
		},
		afterExtension(pi) {
			pi.on("turn_end", (event) => ({
				entries: [...event.entries, { type: "custom", customType: "after-turn-metadata" }],
			}));
		},
	});
	h.faux.setResponses([overflow(), fauxAssistantMessage("Recovered with other extensions.")]);
	await h.session.prompt("Recover the failed request.");
	assert.equal(h.faux.state.callCount, 2);
	const entries = h.sessionManager.getBranch();
	assert.ok(entries.some((entry) => entry.customType === "posthorse-boundary"));
	assert.ok(!entries.some((entry) => entry.customType === "posthorse-overflow-retry"));
	assert.ok(entries.some((entry) => entry.customType === "other-settlement-state"));
	assert.equal(entries.filter((entry) => entry.customType === "after-turn-metadata").length, 2);
});

test("late queued input defers an explicit handoff that no longer fits", async (t) => {
	const h = await fixture(t, {
		contextWindow: 32_000,
		reserveTokens: 1_000,
		extension(pi) {
			pi.registerTool({
				name: "late_input",
				label: "Late input",
				description: "Queue late input",
				parameters: { type: "object", properties: {} },
				async execute() {
					await new Promise((resolve) => setImmediate(resolve));
					await session.steer("q".repeat(85_000));
					return { content: [{ type: "text", text: "Queued." }], details: {} };
				},
			});
		},
	});
	const session = h.session;
	h.faux.setResponses([
		toolTurn(
			fauxToolCall("new_context", { handoff: "h".repeat(20_000) }),
			fauxToolCall("late_input", {}),
		),
		fauxAssistantMessage("Process queued input first."),
	]);
	await session.prompt("Save a handoff.");
	assert.equal(
		toolResult(h, "new_context").isError,
		false,
		"execute accepted the original capacity",
	);
	assert.equal(boundaries(h).length, 0, "the boundary must recheck pending input");
	assert.ok(
		h.sessionManager
			.getBranch()
			.some((entry) => entry.customType === "posthorse-reset-deferred"),
	);
});

for (const trigger of ["user", "custom"]) {
	test(`resumed over-budget ${trigger} run respects native preflight without a summary request`, async (t) => {
		let api;
		const trace = [];
		const persisted = "persisted ".repeat(70_000);
		const seed = (manager, model) => {
			manager.appendMessage({
				role: "user",
				content: persisted,
				timestamp: Date.now(),
			});
			manager.appendMessage({
				...fauxAssistantMessage("Prior response."),
				provider: model.provider,
				model: model.id,
				api: model.api,
				usage: {
					input: 150_000,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150_010,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
		};
		const h = await fixture(t, {
			seed: trigger === "user" ? seed : undefined,
			extension(pi) {
				api = pi;
				pi.on("before_agent_start", (event) => {
					trace.push(`${event.messageType}_start`);
				});
				pi.on("session_before_compact", () => {
					trace.push("compact");
				});
			},
		});
		if (trigger === "custom") {
			h.faux.setResponses([fauxAssistantMessage("Initial run completed.")]);
			await h.session.prompt("Complete the initial run before custom delivery.");
			seed(h.sessionManager, h.faux.getModel());
			h.session.refreshContext();
			trace.length = 0;
		}
		h.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const requests = [];
		h.faux.setResponses(
			Array.from({ length: 5 }, () => (ctx) => {
				trace.push("request");
				requests.push(structuredClone(ctx.messages));
				return fauxAssistantMessage("New run completed.");
			}),
		);
		const input =
			trigger === "user"
				? `NEW_OWNER_AFTER_PREFLIGHT ${"q".repeat(100_000)}`
				: "NEW_CUSTOM_AFTER_PREFLIGHT: background work completed.";
		if (trigger === "user") {
			await h.session.prompt(input);
		} else {
			api.sendMessage(
				{ customType: "background-completion", content: input, display: true },
				{ triggerTurn: true },
			);
			await h.session.waitForIdle();
		}
		assert.deepEqual(trace, ["compact", `${trigger}_start`, "request"]);
		assert.equal(
			requests.length,
			1,
			"the only provider request delivers the input, not a summary",
		);
		assert.equal(h.faux.state.callCount, trigger === "user" ? 1 : 2);
		assert.equal(boundaries(h).length, 1);
		const boundary = boundaries(h)[0];
		assert.ok(boundary.summary.length <= 20_000);
		assert.equal(boundary.usage, undefined, "no summary-model usage");
		assert.match(boundary.summary, /persisted/);
		assert.ok(!boundary.summary.includes(input));
		assert.equal(requests[0].filter((message) => textOf(message) === persisted).length, 0);
		assert.equal(requests[0].filter((message) => textOf(message) === input).length, 1);
		if (trigger === "custom") {
			assert.ok(JSON.stringify(requests[0]).length < 30_000);
			assert.equal(
				h.sessionManager
					.getBranch()
					.filter((entry) => entry.customType === "background-completion").length,
				1,
			);
		}
	});
}

test("same-boundary replacement and custom-message references recover committed text and images", async (t) => {
	const image = {
		type: "image",
		mimeType: "image/png",
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=",
	};
	const replacement = (kind) => [
		{ type: "text", text: `${kind}_START ${"r".repeat(15_000)} ${kind}_END` },
		image,
	];
	let ownerId, toolId, handoff;
	const h = await fixture(t, {
		seed(manager) {
			ownerId = manager.appendMessage({
				role: "user",
				content: "PRIVATE_BEFORE_REPLACEMENT",
				timestamp: Date.now(),
			});
		},
		extension(pi) {
			registerDump(pi);
			pi.on("turn_end", (event) => {
				if (!event.toolResults.some((entry) => entry.toolName === "dump")) {
					return;
				}
				toolId = event.toolResultEntryIds[0];
				return {
					entries: [
						...event.entries,
						{
							type: "context_edit",
							targetId: ownerId,
							replacement: { content: replacement("OWNER") },
						},
						{
							type: "context_edit",
							targetId: toolId,
							replacement: { content: replacement("TOOL") },
						},
						{
							type: "custom_message",
							customType: "review-draft",
							display: true,
							content: replacement("CUSTOM"),
						},
						{
							type: "custom_message",
							customType: "context-pressure",
							display: false,
							content: "p".repeat(600_000),
						},
					],
				};
			});
		},
	});
	h.faux.setResponses([
		toolTurn(fauxToolCall("dump", {})),
		() => {
			handoff = boundaries(h)[0].summary;
			assert.doesNotMatch(handoff, /entry unknown|PRIVATE_BEFORE_REPLACEMENT/);
			const committed = h.sessionManager
				.getBranch()
				.filter(
					(entry) =>
						(entry.type === "context_edit" &&
							[ownerId, toolId].includes(entry.targetId)) ||
						(entry.type === "custom_message" && entry.customType === "review-draft"),
				)
				.map((entry) => entry.id);
			assert.equal(committed.length, 3);
			for (const id of committed) {
				assert.match(handoff, new RegExp(`history read id ${id}`));
			}
			assert.doesNotMatch(
				handoff,
				/history search query/,
				"native hook sees committed IDs, not draft locators",
			);
			return toolTurn(...committed.map((id) => fauxToolCall("history", { op: "read", id })));
		},
		fauxAssistantMessage("Recovered replacement evidence."),
	]);
	await h.session.prompt("Inspect only, then recover the full boundary evidence.");
	const reads = h.sessionManager
		.getBranch()
		.filter(
			(entry) =>
				entry.message?.toolName === "history" &&
				entry.message.details?.kind === "history-read",
		);
	assert.equal(reads.length, 3);
	for (const kind of ["OWNER", "TOOL", "CUSTOM"]) {
		const read = reads.find((entry) => textOf(entry.message).includes(`${kind}_START`));
		assert.ok(read, kind);
		assert.match(textOf(read.message), new RegExp(`${kind}_END`));
		assert.deepEqual(
			read.message.content.filter((part) => part.type === "image"),
			[image],
		);
	}
	assert.match(handoff, /middle omitted/);
});

test("multiple successful explicit requests select the first handoff", async (t) => {
	const h = await fixture(t);
	let fresh;
	h.faux.setResponses([
		toolTurn(
			fauxToolCall("new_context", { handoff: "FIRST_HANDOFF" }),
			fauxToolCall("new_context", { handoff: "LAST_HANDOFF" }),
		),
		(ctx) => {
			fresh = JSON.stringify(ctx.messages);
			return fauxAssistantMessage("Done.");
		},
	]);
	await h.session.prompt("Use the first successful request.");
	assert.equal(boundaries(h).length, 1);
	assert.equal(boundaries(h)[0].summary, "FIRST_HANDOFF");
	assert.match(fresh, /FIRST_HANDOFF/);
	assert.doesNotMatch(fresh, /LAST_HANDOFF/);
});

test("eligible early length recovery (keepRecentTokens=1) makes no summary request", async (t) => {
	const h = await fixture(t, { keepRecentTokens: 1 });
	let fresh;
	h.faux.setResponses([
		fauxAssistantMessage("INCOMPLETE_RESPONSE", { stopReason: "length" }),
		(ctx) => {
			fresh = JSON.stringify(ctx.messages);
			return fauxAssistantMessage("Recovered.");
		},
	]);
	await h.session.prompt("ORIGINAL_LENGTH_OWNER");
	assert.equal(h.faux.state.callCount, 2);
	assert.equal(boundaries(h).length, 1);
	assert.equal(boundaries(h)[0].usage, undefined);
	assert.match(fresh, /ORIGINAL_LENGTH_OWNER/);
	assert.doesNotMatch(fresh, /INCOMPLETE_RESPONSE/);
	assert.match(readFileSync(h.sessionManager.getSessionFile(), "utf8"), /INCOMPLETE_RESPONSE/);
});

test("eligible mixed overflow/length recovery (keepRecentTokens=1) never replenishes the retry allowance", async (t) => {
	const h = await fixture(t, { keepRecentTokens: 1 });
	h.faux.setResponses([
		overflow(),
		fauxAssistantMessage([fauxToolCall("new_context", { handoff: "TRUNCATED_CALL" })], {
			stopReason: "length",
		}),
		overflow(),
		fauxAssistantMessage("MUST_NOT_RUN"),
	]);
	await h.session.prompt("Keep the original owner input.");
	assert.equal(h.faux.state.callCount, 3);
	assert.equal(boundaries(h).length, 1);
	assert.equal(toolResult(h, "new_context").isError, true, "truncated calls never execute");
	assert.doesNotMatch(boundaries(h)[0].summary, /TRUNCATED_CALL/);
});

test("later turn_end replacements are read live by automatic recovery", async (t) => {
	let ownerId;
	const h = await fixture(t, {
		seed(manager) {
			ownerId = manager.appendMessage({
				role: "user",
				content: "PRIVATE_LATE_SOURCE",
				timestamp: Date.now(),
			});
		},
		extension: registerDump,
		afterExtension(pi) {
			pi.on("turn_end", (event) =>
				event.toolResults.length
					? {
							entries: [
								...event.entries,
								{
									type: "context_edit",
									targetId: ownerId,
									replacement: { content: "APPROVED_LATE_SOURCE" },
								},
							],
						}
					: undefined,
			);
		},
	});
	h.faux.setResponses([toolTurn(fauxToolCall("dump", {})), fauxAssistantMessage("Done.")]);
	await h.session.prompt("Inspect only.");
	assert.equal(boundaries(h).length, 1);
	assert.match(boundaries(h)[0].summary, /APPROVED_LATE_SOURCE/);
	assert.doesNotMatch(boundaries(h)[0].summary, /PRIVATE_LATE_SOURCE/);
});

for (const signal of ["active turn", "compaction"]) {
	test(`automatic cancellation checks the ${signal} signal before its sentinel`, async (t) => {
		let intercepted = 0;
		const h = await fixture(t, {
			keepRecentTokens: 1,
			extension(pi) {
				pi.on("session_before_compact", (_event, ctx) => {
					intercepted++;
					if (signal === "active turn") {
						ctx.abort();
					} else {
						session.abortCompaction();
					}
				});
			},
		});
		const session = h.session;
		h.faux.setResponses([overflow(), fauxAssistantMessage("MUST_NOT_RUN")]);
		await session.prompt("Keep the original.");
		assert.equal(intercepted, 1);
		assert.equal(h.faux.state.callCount, 1);
		assert.equal(boundaries(h).length, 0);
		assert.ok(
			!h.sessionManager
				.getBranch()
				.some((entry) => entry.customType === "posthorse-boundary"),
		);
	});
}

for (const cancellation of ["cancel result", "abort"]) {
	test(`a later compaction ${cancellation} leaves only an invisible sentinel and no reset`, async (t) => {
		const h = await fixture(t, {
			keepRecentTokens: 1,
			afterExtension(pi) {
				pi.on("session_before_compact", (_event, ctx) => {
					if (cancellation === "abort") {
						ctx.abort();
					} else {
						return { cancel: true };
					}
				});
			},
		});
		h.faux.setResponses([overflow(), fauxAssistantMessage("MUST_NOT_RUN")]);
		await h.session.prompt("RETAIN_THIS_OWNER");
		assert.equal(h.faux.state.callCount, 1);
		assert.equal(boundaries(h).length, 0);
		assert.equal(
			h.sessionManager
				.getBranch()
				.filter((entry) => entry.customType === "posthorse-boundary").length,
			1,
		);
		const projection = JSON.stringify(h.sessionManager.buildSessionContext().messages);
		assert.match(projection, /RETAIN_THIS_OWNER/);
		assert.doesNotMatch(projection, /posthorse-boundary/);
	});
}

test("explicit reset is cancelled during sibling work but cannot prevent a later-handler abort commit", async (t) => {
	let release, started;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const start = new Promise((resolve) => {
		started = resolve;
	});
	let writes = 0;
	const h = await fixture(t, {
		extension(pi) {
			pi.registerTool({
				name: "write_receipt",
				label: "Write receipt",
				description: "Local receipt",
				parameters: { type: "object", properties: {} },
				async execute() {
					writes++;
					started();
					await gate;
					return {
						content: [{ type: "text", text: "SIDE_EFFECT_RECEIPT" }],
						details: {},
					};
				},
			});
		},
	});
	h.faux.setResponses([
		toolTurn(
			fauxToolCall("new_context", { handoff: "CANCELLED" }),
			fauxToolCall("write_receipt", {}),
		),
	]);
	const prompt = h.session.prompt("Write once.");
	await start;
	const abort = h.session.abort();
	release();
	await Promise.all([prompt, abort]);
	assert.equal(writes, 1);
	assert.equal(boundaries(h).length, 0);

	const late = await fixture(t, {
		afterExtension(pi) {
			pi.on("turn_end", (event, ctx) => {
				if (event.toolResults.some((entry) => entry.toolName === "new_context")) {
					ctx.abort();
				}
			});
		},
	});
	late.faux.setResponses([
		toolTurn(fauxToolCall("new_context", { handoff: "OFFICIAL_LATE_ABORT_LIMIT" })),
	]);
	await late.session.prompt("Reset then abort.");
	assert.equal(
		boundaries(late).length,
		1,
		"official Pi commits drafts after a later turn_end abort",
	);
	assert.equal(late.faux.state.callCount, 1);
});

test("automatic recovery uses event settings even when proactive settings disagree", async (t) => {
	let guidance;
	const h = await fixture(t, {
		extension: registerDump,
		getPolicy: () => ({ enabled: false, reserveTokens: 99_999 }),
	});
	h.faux.setResponses([
		(ctx) => {
			guidance = getCurrentSystemPrompt(ctx.messages);
			return toolTurn(fauxToolCall("dump", {}), fauxToolCall("get_context_remaining", {}));
		},
		fauxAssistantMessage("Done."),
	]);
	await h.session.prompt("The native host still enables compaction.");
	assert.equal(boundaries(h).length, 1);
	assert.equal(boundaries(h)[0].details.reason, "threshold");
	assert.equal(h.faux.state.callCount, 2);
	assert.match(guidance, /disabled in the available settings/);
	assert.match(
		textOf(toolResult(h, "get_context_remaining")),
		/disabled in the available settings/,
	);
});

test("unexpected recovery-builder failure cancels instead of falling through to a summarizer", async (t) => {
	const reported = [];
	t.mock.method(console, "error", (message) => reported.push(message));
	const h = await fixture(t, {
		keepRecentTokens: 1,
		extension(pi) {
			pi.on("session_before_compact", (_event, ctx) => {
				t.mock.method(
					ctx.sessionManager,
					"buildSessionProjection",
					() => {
						throw new Error("INJECTED_PROJECTION_FAILURE");
					},
					{ times: 1 },
				);
			});
		},
	});
	h.faux.setResponses([overflow(), fauxAssistantMessage("MUST_NOT_SUMMARIZE")]);
	await h.session.prompt("Preserve this request.");
	assert.equal(h.faux.state.callCount, 1);
	assert.equal(boundaries(h).length, 0);
	assert.ok(
		!h.sessionManager.getBranch().some((entry) => entry.customType === "posthorse-boundary"),
	);
	assert.match(reported.join("\n"), /rollover cancelled: INJECTED_PROJECTION_FAILURE/);
});

test("unsupported automatic budget deliberately keeps native model summarization", async (t) => {
	const h = await fixture(t, { contextWindow: 20_000, keepRecentTokens: 1 });
	h.faux.setResponses([
		fauxAssistantMessage("Partial.", { stopReason: "length" }),
		fauxAssistantMessage("NATIVE_UNSUPPORTED_SUMMARY"),
		fauxAssistantMessage("Recovered."),
	]);
	await h.session.prompt("Keep native fallback for this small budget.");
	assert.equal(boundaries(h).length, 0);
	assert.equal(h.faux.state.callCount, 3);
	const native = h.sessionManager.getBranch().find((entry) => entry.type === "compaction");
	assert.match(native.summary, /NATIVE_UNSUPPORTED_SUMMARY/);
	assert.equal(native.fromHook, false);
});

for (const reason of ["overflow", "length"]) {
	test(`tiny ${reason} obeys native recovery eligibility with default keepRecentTokens`, async (t) => {
		let intercepted = 0;
		const h = await fixture(t, {
			extension(pi) {
				pi.on("session_before_compact", () => {
					intercepted++;
				});
			},
		});
		h.faux.setResponses([
			reason === "overflow"
				? overflow()
				: fauxAssistantMessage("Partial.", { stopReason: "length" }),
			fauxAssistantMessage("MUST_NOT_RUN"),
		]);
		await h.session.prompt("Tiny input.");
		assert.equal(intercepted, 0, "native preparation declines a tiny span");
		assert.equal(boundaries(h).length, 0);
		assert.equal(h.faux.state.callCount, 1);
	});
}

for (const keepRecentTokens of [20_000, 1]) {
	for (const start of ["automatic", "explicit"]) {
		for (const size of [350_000, 450_000]) {
			test(`fresh-window threshold protects the next request (${start}, ${size} chars, keepRecentTokens=${keepRecentTokens})`, async (t) => {
				const h = await fixture(t, {
					keepRecentTokens,
					extension(pi) {
						registerDump(pi, false, start === "automatic" ? [600_000, size] : size);
					},
				});
				let third;
				h.faux.setResponses([
					toolTurn(
						start === "automatic"
							? fauxToolCall("dump", {})
							: fauxToolCall("new_context", {
									handoff: "Continue inspecting the next output.",
								}),
					),
					toolTurn(fauxToolCall("dump", {})),
					(ctx) => {
						third = ctx.messages;
						return ctx.messages.some(
							(message) =>
								message.role === "toolResult" && textOf(message).length > size,
						) && size === 450_000
							? overflow()
							: fauxAssistantMessage("Done.");
					},
				]);
				await h.session.prompt("Inspect two outputs.");
				assert.equal(third.filter((message) => message.role !== "system").length, 1);
				assert.ok(!third.some((message) => message.role === "toolResult"));
				assert.equal(boundaries(h).length, 2);
				assert.equal(
					boundaries(h)[0].details.reason,
					start === "automatic" ? "threshold" : "explicit",
				);
				assert.equal(boundaries(h)[1].details.reason, "threshold");
				assert.match(boundaries(h)[1].summary, /DUMP_HEAD/);
				assert.match(boundaries(h)[1].summary, /DUMP_TAIL/);
				assert.equal(h.faux.state.callCount, 3);
				assert.equal(
					h.sessionManager
						.getBranch()
						.findLast((entry) => entry.message?.role === "assistant").message
						.stopReason,
					"stop",
				);
			});
		}
	}
}

for (const unavailable of ["unknown usage", "disabled policy"]) {
	test(`fresh-window fallback skips ${unavailable}`, async (t) => {
		const h = await fixture(t, {
			extension(pi) {
				registerDump(pi, false, 350_000);
				pi.on("turn_end", (event, ctx) => {
					if (event.toolResults.some((result) => result.toolName === "dump")) {
						if (unavailable === "unknown usage") {
							t.mock.method(ctx, "getContextUsage", () => ({
								tokens: null,
								contextWindow: 100_000,
								percent: null,
							}));
						} else {
							h.settingsManager.applyOverrides({ compaction: { enabled: false } });
						}
					}
				});
			},
		});
		let third;
		h.faux.setResponses([
			toolTurn(fauxToolCall("new_context", { handoff: "Continue." })),
			toolTurn(fauxToolCall("dump", {})),
			(ctx) => {
				third = ctx.messages;
				return fauxAssistantMessage("Done.");
			},
		]);
		await h.session.prompt("Inspect.");
		assert.ok(
			third.some(
				(message) => message.role === "toolResult" && textOf(message).length > 350_000,
			),
		);
		assert.equal(h.faux.state.callCount, 3);
	});
}

test("earlier turn-start drafts leave fresh-window compaction Pi-owned", async (t) => {
	let intercepted = 0;
	const h = await fixture(t, {
		extension(pi) {
			registerDump(pi, false, 350_000);
			pi.on("session_before_compact", () => {
				intercepted++;
			});
			pi.on("turn_end", (event) =>
				event.toolResults.some((result) => result.toolName === "dump")
					? {
							entries: [
								...event.entries,
								{
									type: "custom_message",
									customType: "coordination",
									content: "NEW_TURN_START_DRAFT",
									display: true,
								},
							],
						}
					: undefined,
			);
		},
	});
	h.faux.setResponses([
		toolTurn(fauxToolCall("new_context", { handoff: "Continue." })),
		toolTurn(fauxToolCall("dump", {})),
		fauxAssistantMessage("Done."),
	]);
	await h.session.prompt("Inspect.");
	assert.equal(intercepted, 1, "the native automatic hook owns this eligible span");
	assert.equal(boundaries(h).length, 2);
	assert.match(JSON.stringify(h.session.messages), /NEW_TURN_START_DRAFT/);
	assert.doesNotMatch(boundaries(h)[1].summary, /NEW_TURN_START_DRAFT/);
	assert.equal(h.faux.state.callCount, 3);
});

for (const start of ["explicit", "automatic", "replaced owner", "omitted owner"]) {
	test(`automatic chains preserve durable intent (${start})`, async (t) => {
		let editId;
		const h = await fixture(t, {
			extension(pi) {
				registerDump(pi, false, start === "explicit" ? 350_000 : [600_000, 350_000]);
				pi.on("turn_end", (event) => {
					if (
						(start === "replaced owner" || start === "omitted owner") &&
						boundaries(h).length === 1 &&
						event.toolResults.some((result) => result.toolName === "dump")
					) {
						const owner = h.sessionManager
							.getBranch()
							.find((entry) => entry.message?.role === "user");
						editId = h.sessionManager.appendContextEdit(
							owner.id,
							start === "omitted owner"
								? null
								: { content: "REPLACED_OWNER_INTENT: no bash." },
						);
					}
				});
			},
		});
		h.faux.setResponses([
			toolTurn(
				start === "explicit"
					? fauxToolCall("new_context", {
							handoff: "EXPLICIT_APPROVED_HANDOFF: continue without bash.",
						})
					: fauxToolCall("dump", {}),
			),
			toolTurn(fauxToolCall("dump", {})),
			...(start === "explicit" ? [toolTurn(fauxToolCall("dump", {}))] : []),
			fauxAssistantMessage("Done."),
		]);
		await h.session.prompt("ORIGINAL_OWNER_INTENT: inspect without bash.");
		const records = boundaries(h);
		const last = records.at(-1).summary;
		assert.equal(records.length, start === "explicit" ? 3 : 2);
		assert.equal(h.faux.state.callCount, start === "explicit" ? 4 : 3);
		assert.ok(last.length <= 20_000);
		assert.match(last, /Earlier automatic records skipped/);
		assert.ok(last.includes(records.at(-2).id));
		assert.doesNotMatch(last, /Prior automatic recovery text is not nested/);
		if (start === "explicit") {
			assert.match(last, /EXPLICIT_APPROVED_HANDOFF: continue without bash/);
			assert.ok(last.includes(records[0].id));
			assert.doesNotMatch(last, /ORIGINAL_OWNER_INTENT/);
		} else if (start === "omitted owner") {
			assert.doesNotMatch(last, /ORIGINAL_OWNER_INTENT|carried from an earlier window/);
		} else {
			const owner = h.sessionManager
				.getBranch()
				.find((entry) => entry.message?.role === "user");
			assert.match(last, /Selected owner and coordination inputs \(chronological\):/);
			assert.match(
				last,
				/owner input; carried from an earlier window, possibly already handled; not current progress/,
			);
			assert.ok(last.includes(owner.timestamp));
			if (start === "replaced owner") {
				assert.match(last, /REPLACED_OWNER_INTENT: no bash/);
				assert.doesNotMatch(last, /ORIGINAL_OWNER_INTENT/);
				assert.ok(last.includes(`entry ${editId}`));
			} else {
				assert.match(last, /ORIGINAL_OWNER_INTENT: inspect without bash/);
				assert.ok(last.includes(`entry ${owner.id}`));
			}
		}
		const firstDump = h.sessionManager
			.getBranch()
			.find((entry) => entry.message?.toolName === "dump");
		assert.ok(!last.includes(firstDump.id), "older automatic tool evidence is never nested");
	});
}

test("fresh-window truncated answers keep native omit-and-retry recovery", async (t) => {
	const intercepted = [];
	const h = await fixture(t, {
		models: [{ id: "official-posthorse", contextWindow: 100_000, maxTokens: 30_000 }],
		extension(pi) {
			registerDump(pi, false, [40_000, 240_000]);
			pi.on("session_before_compact", (event) => {
				intercepted.push({ reason: event.reason, willRetry: event.willRetry });
			});
		},
	});
	h.faux.setResponses([
		toolTurn(fauxToolCall("new_context", { handoff: "Continue." })),
		toolTurn(fauxToolCall("dump", {})),
		toolTurn(fauxToolCall("dump", {})),
		fauxAssistantMessage("y".repeat(80_000), { stopReason: "length" }),
		fauxAssistantMessage("RECOVERED"),
	]);
	await h.session.prompt("Inspect.");
	assert.deepEqual(intercepted, [{ reason: "overflow", willRetry: true }]);
	assert.equal(h.faux.state.callCount, 5);
	const last = h.sessionManager
		.getBranch()
		.findLast((entry) => entry.message?.role === "assistant").message;
	assert.equal(last.stopReason, "stop");
	assert.equal(textOf(last), "RECOVERED");
});

test("earlier redaction drafts defer fallback and never copy unredacted evidence", async (t) => {
	const h = await fixture(t, {
		extension(pi) {
			registerDump(pi, false, 350_000);
			pi.on("turn_end", (event) => {
				const index = event.toolResults.findIndex((result) => result.toolName === "dump");
				return index < 0
					? undefined
					: {
							entries: [
								...event.entries,
								{
									type: "context_edit",
									targetId: event.toolResultEntryIds[index],
									replacement: { content: [{ type: "text", text: "REDACTED" }] },
								},
							],
						};
			});
		},
	});
	let third;
	h.faux.setResponses([
		toolTurn(fauxToolCall("new_context", { handoff: "Continue." })),
		toolTurn(fauxToolCall("dump", {})),
		(ctx) => {
			third = ctx.messages;
			return fauxAssistantMessage("Done.");
		},
	]);
	await h.session.prompt("Inspect.");
	assert.equal(boundaries(h).length, 1, "the committed redaction shrinks usage below threshold");
	assert.match(JSON.stringify(third), /REDACTED/);
	assert.doesNotMatch(JSON.stringify(third), /DUMP_HEAD/);
	assert.ok(boundaries(h).every((entry) => !entry.summary.includes("DUMP_HEAD")));
	assert.equal(h.faux.state.callCount, 3);
});

test("fresh-window threshold after a final answer does not request another response", async (t) => {
	const h = await fixture(t);
	h.faux.setResponses([
		toolTurn(fauxToolCall("new_context", { handoff: "Finish in the next window." })),
		fauxAssistantMessage("x".repeat(350_000)),
		fauxAssistantMessage("MUST_NOT_RUN"),
	]);
	await h.session.prompt("Finish.");
	assert.equal(h.faux.state.callCount, 2);
	assert.equal(boundaries(h).length, 2);
	assert.equal(boundaries(h)[1].details.reason, "threshold");
});

test("note publication rejects directory-only symlink targets and traversal through a file", async (t) => {
	const h = await fixture(t);
	const dir = join(h.cwd, ".pi", "notes");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "blocker"), "REGULAR_FILE");
	writeFileSync(join(dir, "protected.md"), "ORIGINAL_BYTES");
	symlinkSync("missing-directory/", join(dir, "directory-link.md"));
	symlinkSync("blocker/../protected.md", join(dir, "file-parent-link.md"));
	h.faux.setResponses([
		toolTurn(
			fauxToolCall("notes", {
				op: "write",
				path: "directory-link.md",
				content: "MUST_NOT_CREATE",
			}),
			fauxToolCall("notes", {
				op: "write",
				path: "file-parent-link.md",
				content: "MUST_NOT_REPLACE",
			}),
			fauxToolCall("new_context", { handoff: "MUST_NOT_COMMIT" }),
		),
		fauxAssistantMessage("Both publication failures reported."),
	]);
	await h.session.prompt("Check malformed note links.");
	const failures = h.sessionManager
		.getBranch()
		.filter((entry) => entry.message?.toolName === "notes");
	assert.equal(failures.length, 2);
	assert.ok(failures.every((entry) => entry.message.isError));
	assert.equal(existsSync(join(dir, "missing-directory")), false);
	assert.equal(readFileSync(join(dir, "protected.md"), "utf8"), "ORIGINAL_BYTES");
	assert.equal(readFileSync(join(dir, "blocker"), "utf8"), "REGULAR_FILE");
	assert.ok(lstatSync(join(dir, "directory-link.md")).isSymbolicLink());
	assert.ok(lstatSync(join(dir, "file-parent-link.md")).isSymbolicLink());
	assert.equal(boundaries(h).length, 0);
	assert.ok(!readdirSync(dir).some((name) => name.startsWith(".posthorse-")));
});
