import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { test as nodeTest, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as NativeSdk from "@earendil-works/pi-coding-agent";
import type * as NativeAi from "@earendil-works/pi-ai";
import { record, requireValue, stringValue } from "./harness.ts";
import { isRecord } from "../src/contracts.ts";
import { textOf, messageEntry, posthorseBoundaries } from "./host-helpers.ts";
import { fixtureDisplay, fixtureResult } from "./results.ts";
type TranscriptMessages = NativeAi.TranscriptContext["messages"];
import type { HistoryParams } from "../src/history-search.ts";
import { retainFile, retainSession } from "./fixture-files.ts";
const alternateHost = process.env.PI_HOST_INDEX;
const hostIndex =
	alternateHost !== undefined && alternateHost !== ""
		? pathToFileURL(alternateHost).href
		: import.meta.resolve("@earendil-works/pi-coding-agent");
// oxlint-disable-next-line typescript/no-unsafe-assignment -- QX-010: pi-loader verifies the runtime SDK against the compiler's installed graph.
const {
	createAgentSession,
	DefaultResourceLoader,
	discoverAndLoadExtensions,
	ExtensionRunner,
	ModelRuntime,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	wrapRegisteredTools,
}: typeof NativeSdk = await import(hostIndex);

// Resolve the faux provider from the selected host's graph as well.
const aiManifest = pathToFileURL(requireValue(findPackageJSON("@earendil-works/pi-ai", hostIndex)));
const aiPackage = record(JSON.parse(readFileSync(aiManifest, "utf8")));
const aiExport = record(record(aiPackage.exports)["."]);
// oxlint-disable-next-line typescript/no-unsafe-assignment -- QX-010: the selected SDK owns this provider package and its public exports.
const {
	fauxProvider,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	InMemoryCredentialStore,
}: typeof NativeAi = await import(new URL(stringValue(aiExport.import), aiManifest).href);
const { createPosthorse } = await import("../index.ts");
const nextCursor = (text: string) =>
	text.match(
		/\[More results; continue with cursor "([^"]+)" and the same query\/scope\.\]$/,
	)?.[1];
interface FixtureOptions {
	readonly contextWindow?: number;
	readonly maxTokens?: number;
	readonly enabled?: boolean;
	readonly customPrompt?: string | undefined;
	readonly extension?: NativeSdk.ExtensionFactory;
	readonly afterExtension?: NativeSdk.ExtensionFactory;
	readonly seed?: (manager: NativeSdk.SessionManager) => void;
}
async function fixture(t: TestContext, options: FixtureOptions = {}) {
	const temp = mkdtempSync(join(tmpdir(), "posthorse-regression-"));
	t.diagnostic(`fixture: ${temp}`);
	const cwd = join(temp, "project"),
		agentDir = join(temp, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const faux = fauxProvider({
		models: [
			{
				id: "posthorse-regression",
				contextWindow: options.contextWindow ?? 100_000,
				maxTokens: options.maxTokens ?? 1000,
			},
		],
	});
	const setResponses = faux.setResponses;
	faux.setResponses = (steps) =>
		setResponses(
			steps.map((step): NativeAi.FauxResponseFactory => (ctx, opts, state, model) => {
				// Avoid faux's synthetic first-prompt input/cache-write double count in capacity checks.
				assert.ok(opts);
				// oxlint-disable-next-line no-param-reassign -- QX-003: faux reads this request-owned options object after the hook.
				opts.cacheRetention = "none";
				return typeof step === "function" ? step(ctx, opts, state, model) : step;
			}),
		);
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
	});
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: options.enabled ?? true, reserveTokens: 16_384 },
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

		...(options.customPrompt !== undefined && options.customPrompt !== ""
			? { systemPromptOverride: () => options.customPrompt ?? "" }
			: {}),
		extensionFactories: [
			(pi) => {
				pi.registerProvider(faux.provider);
				return options.extension?.(pi);
			},
			createPosthorse(),
			...(options.afterExtension ? [options.afterExtension] : []),
		],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	const sessionManager = SessionManager.create(cwd, join(temp, "sessions"));
	options.seed?.(sessionManager);
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
		resourceLoader,
		modelRuntime,
	};
}

function reset(manager: NativeSdk.SessionManager, handoff: string) {
	return manager.appendCompaction(handoff, null, 100, { posthorse: 1 });
}

async function loadedHistory(t: TestContext) {
	t.diagnostic(`native history SDK: ${hostIndex}`);
	const cwd = mkdtempSync(join(tmpdir(), "posthorse-history-"));
	const evidence = process.env.PI_COMPAT_EVIDENCE_DIR;
	const managers =
		evidence !== undefined && evidence !== ""
			? new Map<string | NativeSdk.SessionManager, NativeSdk.SessionManager>()
			: undefined;
	const models = new ModelRegistry(
		await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
		}),
	);
	const model = fauxProvider({ models: [{ id: "offline", contextWindow: 400_000 }] }).getModel();
	t.after(() => {
		Array.from(managers?.values() ?? []).forEach((manager, index) => {
			retainSession(cwd, manager, `history-${index}`);
		});
		rmSync(cwd, { recursive: true, force: true });
	});
	const { extensions, errors, runtime } = await discoverAndLoadExtensions(
		[fileURLToPath(new URL("../index.ts", import.meta.url))],
		cwd,
		join(cwd, "agent"),
	);
	assert.deepEqual(errors, []);
	assert.equal(extensions.length, 1);
	const extension = requireValue(extensions[0]);
	runtime.getSettings = () => ({});
	runtime.getAllTools = () =>
		[...extension.tools.values()].map(({ definition, sourceInfo }) => {
			const info: NativeSdk.ToolInfo = {
				name: definition.name,
				description: definition.description,
				parameters: definition.parameters,
				sourceInfo,
				exposure: definition.exposure ?? "direct",
			};
			if (definition.promptGuidelines !== undefined) {
				info.promptGuidelines = definition.promptGuidelines;
			}
			if (definition.reachesTools !== undefined) {
				info.reachesTools = definition.reachesTools;
			}
			if (definition.namespace !== undefined) {
				info.namespace = definition.namespace;
			}
			if (definition.annotations !== undefined) {
				info.annotations = definition.annotations;
			}
			return info;
		});
	runtime.getActiveTools = () => runtime.getAllTools().map((tool) => tool.name);
	const history = requireValue(extension.tools.get("history")).definition;
	return {
		cwd,
		async call(sessionManager: NativeSdk.SessionManager, params: HistoryParams) {
			managers?.set(sessionManager.getSessionFile() ?? sessionManager, sessionManager);
			// Isolate extension extraction from the host's separate usage-estimation cost.
			const runner = new ExtensionRunner(extensions, runtime, cwd, sessionManager, models);
			// oxlint-disable-next-line unicorn/no-useless-undefined -- QX-005: the SDK requires its signal slot; this direct history fixture has no abort signal.
			const ctx = runner.createToolContext("history-regression", undefined);
			t.mock.getter(ctx, "model", () => model);
			t.mock.method(ctx, "getContextUsage", () => ({
				tokens: 1_000,
				contextWindow: 400_000,
				percent: 0.25,
			}));
			t.mock.method(ctx, "getSystemPrompt", () => "Offline history regression.");
			// Capture visibility before yielding to a caller that may edit the session.
			const handlers = (extension.handlers.get("turn_start") ?? []).map((handler) =>
				handler({ type: "turn_start", turnIndex: 0, timestamp: 1 }, ctx),
			);
			const [result] = await Promise.all([
				history.execute("history-regression", params, undefined, undefined, ctx),
				...handlers,
			]);
			return fixtureResult(result);
		},
	};
}

nodeTest(
	"native page reads estimate current active schemas only when usage is unknown",
	async (t) => {
		const h = await fixture(t, {
			customPrompt: "Offline page regression.",
			extension(pi) {
				pi.registerTool({
					name: "catalog",
					label: "Catalog",
					description: "d".repeat(280_000),
					parameters: { type: "object", properties: {} },
					async execute() {
						return { content: [{ type: "text", text: "unused" }], details: {} };
					},
				});
			},
		});
		t.after(() => rmSync(dirname(h.cwd), { recursive: true, force: true }));
		const runner = h.session.extensionRunner;
		assert.ok(runner instanceof ExtensionRunner);
		const tools = wrapRegisteredTools(runner.getAllRegisteredTools(), runner);
		const runtime = h.resourceLoader.getExtensions().runtime;
		let usage: ReturnType<NativeSdk.ExtensionContext["getContextUsage"]>;
		const probes = [
			t.mock.method(runtime, "getActiveTools", () => h.session.getActiveToolNames()),
			t.mock.method(runtime, "getAllTools", () => h.session.getAllTools()),
			t.mock.method(h.session, "getContextUsage", () => usage),
			t.mock.method(runtime, "getSettings", () => h.settingsManager.getSettings()),
		];
		const dir = join(h.cwd, ".pi", "notes");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "state.md");
		writeFileSync(file, "saved state");
		const id = h.sessionManager.appendMessage({
			role: "user",
			content: "saved state",
			timestamp: 1,
		});
		const actual: number[][] = [],
			expected: number[][] = [];
		const call = async (name: string, params: Record<string, NativeAi.JsonValue>) => {
			await runner.emit({ type: "turn_start", turnIndex: 0, timestamp: 1 });
			for (const probe of probes) {
				probe.mock.resetCalls();
			}
			const result = fixtureResult(
				await requireValue(tools.find((tool) => tool.name === name)).execute(
					"page",
					params,
				),
			);
			const counts = probes.map((probe) => probe.mock.callCount());
			const unknown = usage === undefined || usage.tokens === null;
			actual.push(counts);
			expected.push([Number(unknown), Number(unknown), 1, Number(usage !== undefined)]);
			t.diagnostic(
				`${name} tokens=${String(usage?.tokens)} active/all/usage/policy=${counts.join("/")}`,
			);
			return result;
		};
		const readPair = async (
			tokens: number | null | undefined,
		): Promise<
			readonly [ReturnType<typeof fixtureResult>, ReturnType<typeof fixtureResult>]
		> => {
			usage =
				tokens === undefined
					? undefined
					: {
							tokens,
							contextWindow: 100_000,
							percent: tokens === null ? null : tokens / 1000,
						};
			return [
				await call("notes", { op: "read", path: "state.md" }),
				await call("history", { op: "read", id }),
			];
		};
		h.session.setActiveToolsByName(["notes", "history"]);
		const baseline = await readPair(1_000);
		assert.equal(textOf(baseline[0]), `File: ${file}\nsaved state`);
		assert.equal(
			textOf(baseline[1]),
			`${requireValue(h.sessionManager.getEntry(id)).timestamp} [window initial] [${id}] [chars 0-18 of 18] [user] saved state`,
		);
		for (const tokens of [0, null, undefined]) {
			// Each evaluation owns the native usage state and callback counters.
			assert.deepEqual(await readPair(tokens), baseline);
		}
		const body = "n".repeat(50_000);
		writeFileSync(file, body);
		const small = await readPair(null);
		h.session.setActiveToolsByName(["notes", "history", "catalog"]);
		const large = await readPair(null);
		assert.ok(small[0].details?.kind === "note-read");
		assert.ok(large[0].details?.kind === "note-read");
		assert.ok(
			large[0].details.end < small[0].details.end,
			"new active schemas reduce unknown-usage capacity",
		);
		const end = large[0].details.end;
		assert.equal(
			textOf(large[0]),
			`File: ${file}\n${body.slice(0, end)}\n[chars 0-${end} of 50000; continue with offset ${end}]`,
		);
		assert.deepEqual(large[1], baseline[1]);
		h.session.setActiveToolsByName(["notes", "history"]);
		assert.deepEqual(
			await readPair(null),
			small,
			"later loadouts are estimated afresh, not cached",
		);
		assert.equal(
			h.faux.state.callCount,
			0,
			"registered tool execution needs no provider request",
		);
		assert.deepEqual(actual, expected, "only unknown usage invokes the active-tool estimator");
	},
);

function countedArchive(cwd: string) {
	const manager = SessionManager.inMemory(cwd);
	const ids: string[] = [];
	let windowId: string | undefined;
	for (let i = 0; i < 4_096; i++) {
		if (i === 2_048) {
			windowId = reset(manager, "Earlier boundary.");
		}
		ids.push(
			manager.appendMessage({
				role: "user",
				content: `HIST_NEEDLE old:${i}.`,
				timestamp: i,
			}),
		);
	}
	reset(manager, "Current boundary.");
	manager.appendMessage({ role: "user", content: "HIST_NEEDLE visible.", timestamp: 5_000 });
	for (let i = 0; i < 100; i++) {
		manager.appendMessage({
			role: "user",
			content: "Current unrelated.",
			timestamp: 5_001 + i,
		});
	}
	const accessed = new Set<string>();
	for (const id of ids) {
		const message = messageEntry(manager.getEntry(id)).message;
		assert.ok("content" in message);
		const content = message.content;
		Object.defineProperty(message, "content", {
			get() {
				accessed.add(id);
				return content;
			},
		});
	}
	return { manager, ids, windowId: requireValue(windowId), accessed };
}

nodeTest(
	"native history searches do not serialize unrelated active tool arguments twice",
	async (t) => {
		const h = await loadedHistory(t);
		const manager = SessionManager.inMemory(h.cwd);
		const ids = Array.from({ length: 5 }, (_, index) =>
			manager.appendMessage({
				role: "user",
				content: `PROJECTION_NEEDLE old:${index}.`,
				timestamp: index,
			}),
		);
		reset(manager, "Earlier entries archived.");
		for (let index = 0; index < 64; index++) {
			manager.appendMessage(
				fauxAssistantMessage(
					fauxToolCall("unrelated", {
						historyProjectionProbe: true,
						payload: "x".repeat(65_536),
						index,
					}),
					{ stopReason: "toolUse" },
				),
			);
		}
		manager.appendMessage({
			role: "user",
			content: "PROJECTION_NEEDLE visible.",
			timestamp: 100,
		});
		let serialized = 0;
		const stringify = JSON.stringify;
		t.mock.method(JSON, "stringify", (value: unknown, replacer: unknown, space: unknown) => {
			if (isRecord(value) && value.historyProjectionProbe === true) {
				serialized++;
			}
			const result: unknown = Reflect.apply(stringify, JSON, [value, replacer, space]);
			return result;
		});
		const first = await h.call(manager, { op: "search", query: "PROJECTION_NEEDLE", limit: 2 });
		assert.deepEqual(
			textOf(first).split("\n").slice(0, 2),
			[4, 3].map(
				(index) =>
					`${requireValue(manager.getEntry(requireValue(ids[index]))).timestamp} [window initial] [${requireValue(ids[index])}] [user] PROJECTION_NEEDLE old:${index}.`,
			),
		);
		assert.ok(first.details?.kind === "history-search");
		assert.equal(first.details.skipped, 1);
		assert.equal(first.details.more, true);
		assert.ok(
			serialized <= 64,
			`first page serialized ${serialized}/64 unrelated argument objects`,
		);
		serialized = 0;
		const second = await h.call(manager, {
			op: "search",
			query: "PROJECTION_NEEDLE",
			limit: 2,
			cursor: requireValue(nextCursor(textOf(first))),
		});
		assert.deepEqual(
			textOf(second).split("\n").slice(0, 2),
			[2, 1].map(
				(index) =>
					`${requireValue(manager.getEntry(requireValue(ids[index]))).timestamp} [window initial] [${requireValue(ids[index])}] [user] PROJECTION_NEEDLE old:${index}.`,
			),
		);
		assert.ok(second.details?.kind === "history-search");
		assert.equal(second.details.skipped, 1);
		assert.ok(
			serialized <= 64,
			`second page serialized ${serialized}/64 unrelated argument objects`,
		);
		serialized = 0;
		const absent = await h.call(manager, { op: "search", query: "NO_MATCH_102" });
		assert.equal(textOf(absent), 'No history matches "NO_MATCH_102".');
		assert.ok(
			serialized <= 64,
			`no-match search serialized ${serialized}/64 unrelated argument objects`,
		);
	},
);

for (const all of [false, true]) {
	nodeTest(`native history normalizes a shared edit target only once (all=${all})`, async (t) => {
		const h = await loadedHistory(t);
		const manager = SessionManager.create(h.cwd, join(h.cwd, "sessions"));
		const id = manager.appendMessage(fauxAssistantMessage("Before edits."));
		let lastArguments: NativeAi.ToolCall["arguments"] | undefined;
		for (let index = 0; index < 8; index++) {
			lastArguments = { value: "MATCH_EDIT_ARGUMENT", payload: "x".repeat(4096) };
			manager.appendContextEdit(id, {
				content: [fauxToolCall("unrelated", lastArguments, { id: "same-call" })],
			});
		}
		let serialized = 0;
		const stringify = JSON.stringify;
		t.mock.method(JSON, "stringify", (value: unknown, replacer: unknown, space: unknown) => {
			if (value === lastArguments) {
				serialized++;
			}
			const result: unknown = Reflect.apply(stringify, JSON, [value, replacer, space]);
			return result;
		});
		const result = await h.call(manager, { op: "search", query: "MATCH_EDIT_ARGUMENT", all });
		assert.match(textOf(result), /No history matches/);
		assert.ok(result.details?.kind === "history-search");
		assert.equal(result.details.skipped, 8);
		assert.ok(
			serialized <= (all ? 1 : 3),
			`the same native projected target was serialized ${serialized} times`,
		);
		t.diagnostic(`shared target serializations: ${serialized}; edits: 8; all: ${all}`);
	});
}

nodeTest(
	"native all-session history keeps invocation-time context visibility across archive I/O",
	async (t) => {
		const h = await loadedHistory(t);
		const manager = SessionManager.create(h.cwd, join(h.cwd, "sessions"));
		const id = manager.appendMessage({
			role: "user",
			content: "SNAPSHOT_NEEDLE original.",
			timestamp: 1,
		});
		manager.appendMessage(fauxAssistantMessage("Acknowledged."));
		const pending = h.call(manager, { op: "search", query: "SNAPSHOT_NEEDLE", all: true });
		manager.appendContextEdit(id, null);
		const initial = await pending;
		assert.ok(initial.details?.kind === "history-search");
		assert.match(textOf(initial), /No history matches/);
		assert.equal(initial.details.skipped, 1);
		const updated = await h.call(manager, {
			op: "search",
			query: "SNAPSHOT_NEEDLE",
			all: true,
		});
		assert.ok(updated.details?.kind === "history-search");
		assert.match(textOf(updated), /\[user\] SNAPSHOT_NEEDLE original\./);
		assert.equal(updated.details.skipped, 0);
	},
);

for (const all of [false, true]) {
	nodeTest(
		`native history visibility follows edits, branches and session replacements (all=${all})`,
		async (t) => {
			const h = await loadedHistory(t);
			const dir = join(h.cwd, "sessions");
			const manager = SessionManager.create(h.cwd, dir);
			const original = "EDIT_NEEDLE original.";
			const id = manager.appendMessage({ role: "user", content: original, timestamp: 1 });
			manager.appendMessage(fauxAssistantMessage("Acknowledged."));
			const call = (selected = manager) =>
				h.call(selected, { op: "search", query: original, all });
			assert.match(textOf(await call()), /No history matches/);
			manager.appendContextEdit(id, { content: "Replacement only." });
			assert.match(textOf(await call()), /\[user\] EDIT_NEEDLE original\./);
			const editedLeaf = requireValue(manager.getLeafId());
			manager.appendContextEdit(id, { content: original });
			assert.match(textOf(await call()), /No history matches/);
			manager.appendContextEdit(id, null);
			assert.match(textOf(await call()), /\[user\] EDIT_NEEDLE original\./);
			manager.branch(id);
			manager.appendMessage(fauxAssistantMessage("Other branch."));
			assert.match(textOf(await call()), /No history matches/);
			manager.branch(editedLeaf);
			assert.match(textOf(await call()), /\[user\] EDIT_NEEDLE original\./);
			manager.appendCompaction("Native compact with retained tail.", id, 100);
			assert.match(textOf(await call()), /\[user\] EDIT_NEEDLE original\./);
			manager.appendContextEdit(id, { content: original });
			assert.match(textOf(await call()), /No history matches/);
			reset(manager, "Posthorse rollover.");
			assert.match(textOf(await call()), /\[user\] EDIT_NEEDLE original\./);
			const file = requireValue(manager.getSessionFile());
			assert.ok(file !== "");
			assert.match(
				textOf(await call(SessionManager.open(file, dir))),
				/\[user\] EDIT_NEEDLE original\./,
			);
			const rewritten = readFileSync(file, "utf8")
				.split("\n")
				.map((line) => {
					if (line === "") {
						return line;
					}
					const entry = record(JSON.parse(line));
					return JSON.stringify(
						entry.id === id
							? {
									...entry,
									message: {
										...record(entry.message),
										content: "Rewritten synthetic entry.",
									},
								}
							: entry,
					);
				})
				.join("\n");
			retainFile(h.cwd, file, "before-rewrite");
			writeFileSync(file, rewritten);
			assert.doesNotMatch(
				textOf(await call(SessionManager.open(file, dir))),
				new RegExp(`\\[${id}(?:@[^\\]]+)?\\]`),
			);
			const other = SessionManager.create(h.cwd, join(h.cwd, "replacement"));
			other.appendMessage({ role: "user", content: original, timestamp: 1 });
			other.appendMessage(fauxAssistantMessage("Different session."));
			const replacement = await call(other);
			assert.ok(replacement.details?.kind === "history-search");
			assert.match(textOf(replacement), /No history matches/);
			assert.equal(replacement.details.skipped, 1);
		},
	);
}

nodeTest(
	"native loaded history extracts only early page hits and lookahead from a large archive",
	async (t) => {
		const h = await loadedHistory(t);
		const { manager, ids, windowId, accessed } = countedArchive(h.cwd);
		const first = await h.call(manager, { op: "search", query: "HIST_NEEDLE", limit: 10 });
		const expected = (from: number) =>
			Array.from({ length: 10 }, (_, offset) => {
				const index = from - offset;
				const id = requireValue(ids[index]);
				return `${requireValue(manager.getEntry(id)).timestamp} [window ${windowId}] [${id}] [user] HIST_NEEDLE old:${index}.`;
			});
		assert.deepEqual(textOf(first).split("\n").slice(0, 10), expected(4_095));
		assert.ok(first.details?.kind === "history-search");
		assert.equal(first.details.skipped, 1);
		assert.equal(first.details.more, true);
		assert.ok(nextCursor(textOf(first)) !== undefined, "the full archive remains pageable");
		assert.ok(
			accessed.size <= 11,
			`page plus one lookahead extracted ${accessed.size} records`,
		);
		t.diagnostic(`first-page archived content: ${accessed.size}/4096 entries extracted`);
		const second = await h.call(manager, {
			op: "search",
			query: "HIST_NEEDLE",
			limit: 10,
			cursor: requireValue(nextCursor(textOf(first))),
		});
		assert.deepEqual(textOf(second).split("\n").slice(0, 10), expected(4_085));
		const oldest = await h.call(manager, { op: "search", query: "old:0." });
		assert.match(
			textOf(oldest),
			new RegExp(`\\[window initial\\] \\[${requireValue(ids[0])}\\]`),
		);
		assert.match(textOf(oldest), /\[user\] HIST_NEEDLE old:0\./);
	},
);

nodeTest(
	"native loaded history reads only the selected content and preserves abandoned-branch locators",
	async (t) => {
		const h = await loadedHistory(t);
		const { manager, ids, windowId, accessed } = countedArchive(h.cwd);
		for (const { index, window } of [
			{ index: 4_095, window: windowId },
			{ index: 0, window: "initial" },
		]) {
			accessed.clear();
			const id = requireValue(ids[index]);
			// Each independent read must finish before measuring the next selected entry.
			const result = await h.call(manager, { op: "read", id });
			assert.ok(textOf(result).includes(`[window ${window}] [${id}]`));
			assert.ok(textOf(result).endsWith(`[user] HIST_NEEDLE old:${index}.`));
			assert.deepEqual([...accessed], [id], "unselected archive content stays untouched");
			t.diagnostic(`known-ID archived content: ${accessed.size}/4096 entries extracted`);
		}
		const persisted = SessionManager.create(h.cwd, join(h.cwd, "sessions"));
		const root = persisted.appendMessage({ role: "user", content: "Root.", timestamp: 1 });
		const abandonedWindow = reset(persisted, "Abandoned boundary.");
		for (let i = 0; i < 64; i++) {
			const call = fauxToolCall("archive_probe", { archivePayload: "unselected", index: i });
			persisted.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
			persisted.appendMessage({
				role: "toolResult",
				toolName: "archive_probe",
				toolCallId: call.id,
				content: [{ type: "text", text: "Saved result." }],
				isError: false,
				timestamp: 2,
			});
		}
		const abandoned = persisted.appendMessage({
			role: "user",
			content: "ABANDONED_NEEDLE original.",
			timestamp: 2,
		});
		persisted.branch(root);
		persisted.appendMessage({ role: "user", content: "Chosen alternative.", timestamp: 3 });
		reset(persisted, "Chosen boundary.");
		const branch = await h.call(persisted, { op: "search", query: "ABANDONED_NEEDLE" });
		assert.match(textOf(branch), /No history matches/);
		const source = relative(
			persisted.getSessionDir(),
			requireValue(persisted.getSessionFile()),
		);
		const qualified = `${abandoned}@${createHash("sha256").update(source).digest("base64url").slice(0, 10)}`;
		let unselectedArguments = 0;
		const stringify = JSON.stringify;
		const serialization = t.mock.method(
			JSON,
			"stringify",
			(value: unknown, replacer: unknown, space: unknown) => {
				if (isRecord(value) && value.archivePayload === "unselected") {
					unselectedArguments++;
				}
				const result: unknown = Reflect.apply(stringify, JSON, [value, replacer, space]);
				return result;
			},
		);
		const read = await h.call(persisted, { op: "read", id: abandoned });
		const qualifiedRead = await h.call(persisted, { op: "read", id: qualified });
		serialization.mock.restore();
		for (const result of [read, qualifiedRead]) {
			assert.ok(textOf(result).includes(`[window ${abandonedWindow}] [${qualified}]`));
			assert.ok(textOf(result).endsWith("[user] ABANDONED_NEEDLE original."));
		}
		assert.equal(
			unselectedArguments,
			0,
			"archived ID reads must not extract unrelated arguments",
		);
		t.diagnostic(
			`bare/qualified archived-ID unrelated argument serializations: ${unselectedArguments}`,
		);
		const all = await h.call(persisted, { op: "search", query: "ABANDONED_NEEDLE", all: true });
		assert.ok(textOf(all).includes(`[window ${abandonedWindow}] [${qualified}]`));
	},
);

nodeTest(
	"official resume keeps legacy saved window data recoverable after a public reset",
	async (t) => {
		let ownerId: string | undefined;
		const h = await fixture(t, {
			seed(manager) {
				ownerId = manager.appendMessage({
					role: "user",
					content: "LEGACY_OWNER_INPUT",
					timestamp: 1,
				});
				manager.appendMessage(fauxAssistantMessage("Saved response."));
				const file = requireValue(manager.getSessionFile());
				appendFileSync(
					file,
					`${JSON.stringify({ type: "context_window", id: "legacy-window", parentId: manager.getLeafId(), timestamp: "2026-09-01T00:00:00Z", handoff: "LEGACY_SAVED_HANDOFF" })}\n`,
				);
				retainFile(dirname(manager.getCwd()), file, "before-reload");
				manager.setSessionFile(file);
			},
		});
		h.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("new_context", { handoff: "Public fresh context" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					fauxToolCall("history", { op: "search", query: "LEGACY_OWNER_INPUT" }),
					fauxToolCall("history", { op: "read", id: "legacy-window" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Recovered saved data."),
		]);
		await h.session.prompt("Reset using public compaction, then recover the legacy record.");
		const results = h.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message)
			.filter((message) => message.role === "toolResult")
			.filter((message) => message.toolName === "history");
		assert.equal(results.length, 2);
		assert.ok(results.every((result) => !result.isError));
		assert.match(textOf(results[0]), /LEGACY_OWNER_INPUT/);
		assert.match(textOf(results[1]), /\[window legacy-window\].*Handoff: LEGACY_SAVED_HANDOFF/);
		const reopened = SessionManager.open(requireValue(h.sessionManager.getSessionFile()));
		assert.match(
			JSON.stringify(reopened.getEntry(requireValue(ownerId))),
			/LEGACY_OWNER_INPUT/,
		);
		assert.match(JSON.stringify(reopened.getEntry("legacy-window")), /LEGACY_SAVED_HANDOFF/);
		assert.ok(
			!reopened
				.buildSessionProjection()
				.entries.some(({ sourceEntry }) =>
					[ownerId, "legacy-window"].includes(sourceEntry.id),
				),
			"raw legacy inputs leave active context; only explicitly recovered tool receipts return",
		);
	},
);

nodeTest("all-session history scopes project sessions and their nested subagents", async (t) => {
	let foreignId: string | undefined,
		ownId: string | undefined,
		foreignChildId: string | undefined,
		ownChildId: string | undefined;
	const { session, faux, sessionManager } = await fixture(t, {
		seed(manager) {
			const archive = (cwd: string, content: string, dir = manager.getSessionDir()) => {
				mkdirSync(cwd, { recursive: true });
				mkdirSync(dir, { recursive: true });
				const other = SessionManager.create(cwd, dir);
				const id = other.appendMessage({ role: "user", content, timestamp: Date.now() });
				other.appendMessage(fauxAssistantMessage("Archive saved."));
				retainSession(dirname(manager.getCwd()), other, "archive");
				const file = requireValue(other.getSessionFile());
				const source = relative(manager.getSessionDir(), file);
				return {
					id: `${id}@${createHash("sha256").update(source).digest("base64url")}`,
					file,
				};
			};
			const foreignCwd = join(manager.getCwd(), "..", "foreign-project");
			const foreign = archive(foreignCwd, "SCOPE_NEEDLE foreign");
			const own = archive(manager.getCwd(), "SCOPE_NEEDLE own");
			const childDir = (file: string) =>
				join(dirname(file), basename(file, ".jsonl"), "run-1", "run-0");
			foreignId = foreign.id;
			ownId = own.id;
			foreignChildId = archive(
				manager.getCwd(),
				"SCOPE_NEEDLE foreign child",
				childDir(foreign.file),
			).id;
			ownChildId = archive(foreignCwd, "SCOPE_NEEDLE own child", childDir(own.file)).id;
		},
	});
	const search = fauxToolCall("history", { op: "search", query: "SCOPE_NEEDLE", all: true });
	const foreignRead = fauxToolCall("history", { op: "read", id: requireValue(foreignId) });
	const foreignChildRead = fauxToolCall("history", {
		op: "read",
		id: requireValue(foreignChildId),
	});
	const ownRead = fauxToolCall("history", { op: "read", id: requireValue(ownId) });
	const ownChildRead = fauxToolCall("history", { op: "read", id: requireValue(ownChildId) });
	faux.setResponses([
		fauxAssistantMessage([search, foreignRead, foreignChildRead, ownRead, ownChildRead], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("done"),
	]);
	await session.prompt("Check archived history.");
	const result = (call: NativeAi.ToolCall) =>
		sessionManager
			.getBranch()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message)
			.filter((message) => message.role === "toolResult")
			.find((message) => message.toolCallId === call.id);
	assert.match(textOf(result(search)), /\[user\] SCOPE_NEEDLE own/);
	assert.match(textOf(result(search)), /\[user\] SCOPE_NEEDLE own child/);
	assert.doesNotMatch(textOf(result(search)), /\[user\] SCOPE_NEEDLE foreign/);
	assert.equal(result(foreignRead)?.isError, true);
	assert.equal(result(foreignChildRead)?.isError, true);
	assert.match(textOf(result(ownRead)), /\[user\] SCOPE_NEEDLE own/);
	assert.match(textOf(result(ownChildRead)), /\[user\] SCOPE_NEEDLE own child/);
});

nodeTest("history recovers every image across pages and fresh contexts", async (t) => {
	const image: NativeAi.ImageContent = {
		type: "image",
		mimeType: "image/png",
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=",
	};
	const images = Array.from({ length: 13 }, () => ({ ...image }));
	let id: string | undefined;
	const { session, faux, sessionManager } = await fixture(t, {
		contextWindow: 32_000,
		seed(manager) {
			id = manager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "Screenshots to recover" }, ...images],
				timestamp: Date.now(),
			});
			reset(manager, "Recover the earlier screenshots.");
		},
	});
	let offset = 0,
		imageOffset = 0;
	const recovered = [];
	for (let page = 0; page < images.length; page++) {
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("history", { op: "read", id: requireValue(id), offset, imageOffset }),
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage(
				fauxToolCall("new_context", { handoff: "Continue recovering screenshots." }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Page recovered."),
		]);
		// Each page needs the prior receipt offsets and its committed context reset.
		await session.prompt("Recover the next page, then start a fresh context.");
		const entry = messageEntry(
			sessionManager
				.getBranch()
				.findLast(
					(candidate) =>
						candidate.type === "message" &&
						candidate.message.role === "toolResult" &&
						candidate.message.toolName === "history",
				),
		);
		const result = entry.message;
		assert.ok(result.role === "toolResult");
		assert.equal(result.isError, false, textOf(result));
		const returned = result.content.filter((part) => part.type === "image");
		assert.ok(
			returned.length > 0 && returned.length < images.length,
			"bounded pages must make image progress",
		);
		recovered.push(...returned);
		const next = textOf(result).match(/and offset (\d+) and imageOffset (\d+)\./);
		if (!next) {
			break;
		}
		offset = Number(next[1]);
		imageOffset = Number(next[2]);
		assert.equal(imageOffset, recovered.length);
		assert.ok(offset > 0, "image-only pages retain the completed text offset");
	}
	assert.deepEqual(recovered, images);
});

for (const { callEdit, callNamespace } of [
	{ callEdit: "visible", callNamespace: "survey" },
	{ callEdit: "omitted", callNamespace: "survey" },
	{ callEdit: "replaced", callNamespace: "survey" },
	{ callEdit: "no call namespace" },
]) {
	nodeTest(
		`automatic rollover keeps namespaced ask_question as evidence, not owner input (${callEdit} call)`,
		async (t) => {
			const { session, faux, sessionManager } = await fixture(t, {
				seed(manager) {
					manager.appendMessage({
						role: "user",
						content: "Earlier survey setup",
						timestamp: Date.now(),
					});
					manager.appendMessage(fauxAssistantMessage("Ready to inspect only."));
				},
				extension(pi) {
					if (callEdit === "omitted" || callEdit === "replaced") {
						pi.on("turn_end", (event, ctx) => {
							if (
								!event.toolResults.some(
									(result) => result.toolName === "ask_question",
								)
							) {
								return;
							}
							assert.ok(ctx.sessionManager instanceof SessionManager);
							ctx.sessionManager.appendContextEdit(
								event.messageEntryId,
								callEdit === "omitted"
									? null
									: {
											content: [
												{ type: "text", text: "Edited assistant call." },
											],
										},
							);
						});
					}
					pi.registerTool({
						name: "ask_question",
						namespace: { name: "survey" },
						label: "Survey",
						description: "Query an external survey",
						parameters: { type: "object", properties: {} },
						async execute() {
							return {
								content: [
									{ type: "text", text: "SURVEY_OUTPUT: deployment approved" },
								],
								details: {},
							};
						},
					});
					pi.registerTool({
						name: "dump",
						label: "Dump",
						description: "Large local result",
						parameters: { type: "object", properties: {} },
						async execute() {
							return {
								content: [{ type: "text", text: "x".repeat(600_000) }],
								details: {},
							};
						},
					});
				},
			});
			let nextRequest: string | undefined;
			faux.setResponses([
				fauxAssistantMessage(
					[
						{
							...fauxToolCall("ask_question", {}),
							...(callNamespace !== undefined && callNamespace !== ""
								? { namespace: callNamespace }
								: {}),
						},
						fauxToolCall("dump", {}),
					],
					{ stopReason: "toolUse" },
				),
				(ctx) => {
					nextRequest = JSON.stringify(ctx.messages);
					return fauxAssistantMessage("done");
				},
			]);
			assert.deepEqual(
				requireValue(session.getAllTools().find((tool) => tool.name === "ask_question"))
					.namespace,
				{ name: "survey" },
			);
			await session.prompt("Read the survey only. Do not deploy.");
			if (callNamespace === undefined || callNamespace === "") {
				const call = messageEntry(
					sessionManager
						.getBranch()
						.find(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "assistant" &&
								entry.message.content.some(
									(part) =>
										part.type === "toolCall" && part.name === "ask_question",
								),
						),
				).message;
				assert.ok(call.role === "assistant");
				const question = requireValue(
					call.content.find(
						(part) => part.type === "toolCall" && part.name === "ask_question",
					),
				);
				assert.ok(question.type === "toolCall");
				assert.equal(question.namespace, undefined);
			}
			const windows = posthorseBoundaries(sessionManager);
			assert.equal(windows.length, 1);
			for (const text of [requireValue(windows[0]).summary, requireValue(nextRequest)]) {
				assert.match(text, /Do not deploy/);
				assert.match(text, /SURVEY_OUTPUT: deployment approved/);
				assert.match(text, /Tool result evidence/);
				assert.doesNotMatch(text, /owner answer via ask_question/);
			}
		},
	);
}

for (const outcome of ["answer", "cancelled", "error"]) {
	nodeTest(
		`automatic rollover preserves bare owner question provenance (${outcome})`,
		async (t) => {
			const h = await fixture(t, {
				seed(manager) {
					manager.appendMessage({
						role: "user",
						content: "Earlier owner setup",
						timestamp: Date.now(),
					});
					manager.appendMessage(fauxAssistantMessage("Ready."));
				},
				extension(pi) {
					pi.registerTool({
						name: "ask_question",
						label: "Owner question",
						description: "Get direct owner input",
						parameters: { type: "object", properties: {} },
						async execute() {
							if (outcome === "error") {
								throw new Error("OWNER_QUESTION_FAILURE");
							}
							return {
								content: [
									{
										type: "text",
										text:
											outcome === "cancelled"
												? "Question cancelled by owner"
												: "OWNER_APPROVED_INSPECTION",
									},
								],
								details: {},
							};
						},
					});
					pi.registerTool({
						name: "dump",
						label: "Dump",
						description: "Large local result",
						parameters: { type: "object", properties: {} },
						async execute() {
							return {
								content: [{ type: "text", text: "x".repeat(600_000) }],
								details: {},
							};
						},
					});
				},
			});
			let nextRequest: string | undefined, chainedRequest: string | undefined;
			h.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("ask_question", {}), fauxToolCall("dump", {})], {
					stopReason: "toolUse",
				}),
				(ctx) => {
					nextRequest = JSON.stringify(ctx.messages);
					return fauxAssistantMessage([fauxToolCall("dump", {})], {
						stopReason: "toolUse",
					});
				},
				(ctx) => {
					chainedRequest = JSON.stringify(ctx.messages);
					return fauxAssistantMessage("Done.");
				},
			]);
			await h.session.prompt("Ask the owner, then retain the result.");
			const boundary = h.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "compaction")
				.filter((entry) => isRecord(entry.details) && entry.details.posthorse === 1);
			assert.equal(boundary.length, 2);
			for (const text of [requireValue(boundary[0]).summary, requireValue(nextRequest)]) {
				if (outcome === "error") {
					assert.doesNotMatch(text, /owner answer via ask_question/);
					assert.match(text, /OWNER_QUESTION_FAILURE/);
				} else {
					assert.match(text, /owner answer via ask_question/);
					assert.match(
						text,
						outcome === "cancelled"
							? /Question cancelled by owner/
							: /OWNER_APPROVED_INSPECTION/,
					);
				}
			}
			for (const text of [requireValue(boundary[1]).summary, requireValue(chainedRequest)]) {
				assert.match(text, /carried from an earlier window/);
				if (outcome === "error") {
					assert.doesNotMatch(
						text,
						/owner answer via ask_question|OWNER_QUESTION_FAILURE/,
					);
				} else {
					assert.match(
						text,
						/owner answer via ask_question; carried from an earlier window/,
					);
					assert.match(
						text,
						outcome === "cancelled"
							? /Question cancelled by owner/
							: /OWNER_APPROVED_INSPECTION/,
					);
				}
			}
		},
	);
}

nodeTest("automatic rollover respects context edits in its recovery handoff", async (t) => {
	const { session, faux, sessionManager } = await fixture(t, {
		contextWindow: 128_000,
		seed(manager) {
			const omitted = manager.appendMessage({
				role: "user",
				content: "PRIVATE_EDIT_MARKER",
				timestamp: Date.now(),
			});
			manager.appendContextEdit(omitted, null);
			const revised = manager.appendMessage({
				role: "user",
				content: "OBSOLETE_EDIT_MARKER",
				timestamp: Date.now(),
			});
			manager.appendContextEdit(revised, { content: "APPROVED_EDIT_MARKER" });
		},
		extension(pi) {
			pi.registerTool({
				name: "dump",
				label: "dump",
				description: "Large local result",
				parameters: { type: "object", properties: {} },
				async execute() {
					return {
						content: [
							{ type: "text", text: `PRIVATE_TOOL_MARKER ${"x".repeat(600_000)}` },
						],
						details: {},
					};
				},
			});
			pi.on("turn_end", (event, ctx) => {
				if (!event.toolResults.some((result) => result.toolName === "dump")) {
					return;
				}
				const result = ctx.sessionManager
					.getBranch()
					.findLast(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolName === "dump",
					);
				assert.ok(ctx.sessionManager instanceof SessionManager);
				ctx.sessionManager.appendContextEdit(requireValue(result).id, {
					content: [
						{ type: "text", text: `APPROVED_TOOL_MARKER ${"x".repeat(600_000)}` },
					],
				});
			});
		},
	});
	const requests: string[] = [];
	faux.setResponses([
		(ctx) => {
			requests.push(JSON.stringify(ctx.messages));
			return fauxAssistantMessage(fauxToolCall("dump", {}), { stopReason: "toolUse" });
		},
		(ctx) => {
			requests.push(JSON.stringify(ctx.messages));
			return fauxAssistantMessage("done");
		},
	]);
	await session.prompt("Run the local dump tool.");
	const windows = sessionManager
		.getBranch()
		.filter((entry) => entry.type === "compaction")
		.filter((entry) => isRecord(entry.details) && entry.details.posthorse === 1);
	assert.equal(windows.length, 1);
	assert.equal(requests.length, 2);
	for (const text of [...requests, requireValue(windows[0]).summary]) {
		assert.equal(/PRIVATE_EDIT_MARKER|OBSOLETE_EDIT_MARKER/.test(text), false);
		assert.equal(text.includes("APPROVED_EDIT_MARKER"), true);
	}
	for (const text of [requireValue(requests[1]), requireValue(windows[0]).summary]) {
		assert.equal(text.includes("PRIVATE_TOOL_MARKER"), false);
		assert.equal(text.includes("APPROVED_TOOL_MARKER"), true);
	}
});

nodeTest(
	"edited image recovery points to the replacement rather than the raw original",
	async (t) => {
		const image: NativeAi.ImageContent = {
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=",
		};
		let editId: string | undefined;
		const h = await fixture(t, {
			seed(manager) {
				const original = manager.appendMessage({
					role: "user",
					content: "PRIVATE_IMAGE_ORIGINAL",
					timestamp: Date.now(),
				});
				editId = manager.appendContextEdit(original, { content: [image] });
			},
			extension(pi) {
				pi.registerTool({
					name: "dump",
					label: "Dump",
					description: "Trigger local rollover",
					parameters: { type: "object", properties: {} },
					async execute() {
						return {
							content: [{ type: "text", text: "x".repeat(600_000) }],
							details: {},
						};
					},
				});
			},
		});
		assert.doesNotMatch(
			JSON.stringify(h.sessionManager.buildSessionProjection().messages),
			/PRIVATE_IMAGE_ORIGINAL/,
		);
		let pointer: string | undefined;
		h.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("dump", {}), { stopReason: "toolUse" }),
			() => {
				const handoff = requireValue(
					h.sessionManager.getBranch().findLast((entry) => entry.type === "compaction"),
				).summary;
				pointer = handoff.match(/recover with history read id ([^\s]+)/)?.[1];
				assert.ok(pointer !== undefined && pointer !== "", handoff);
				return fauxAssistantMessage(fauxToolCall("history", { op: "read", id: pointer }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("Recover the edited image.");
		const result = messageEntry(
			h.sessionManager
				.getBranch()
				.findLast(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						entry.message.toolName === "history",
				),
		).message;
		assert.ok(result.role === "toolResult");
		assert.equal(result.isError, false);
		assert.equal(result.content.filter((part) => part.type === "image").length, 1);
		assert.doesNotMatch(textOf(result), /PRIVATE_IMAGE_ORIGINAL/);
		assert.equal(pointer, editId);
	},
);

for (const mode of ["structured", "custom", "forced-before", "forced-after"]) {
	nodeTest(
		`public Posthorse guidance survives tool additions and rollover (${mode})`,
		async (t) => {
			const h = await fixture(t, {
				customPrompt: mode === "custom" ? "CUSTOM_PROMPT_POLICY" : undefined,
				extension(pi) {
					pi.registerTool({
						name: "extra",
						label: "Extra",
						description: "Additional fixture tool",
						parameters: { type: "object", properties: {} },
						async execute() {
							return { content: [{ type: "text", text: "done" }], details: {} };
						},
					});
				},
			});
			const extension = requireValue(
				h.resourceLoader
					.getExtensions()
					.extensions.find((item) => item.handlers.has("session_before_compact")),
			);
			const handlers = requireValue(extension.handlers.get("before_agent_start"));
			if (mode.startsWith("forced-")) {
				handlers[mode === "forced-before" ? "unshift" : "push"](async (event) => ({
					systemPrompt: `${stringValue(record(event).systemPrompt)}\n\nOTHER_EXTENSION_POLICY`,
				}));
			}
			const captures: TranscriptMessages[] = [];
			const capture = (ctx: NativeAi.TranscriptContext, requestReset = false) => {
				captures.push(structuredClone(ctx.messages));
				return requestReset
					? fauxAssistantMessage(
							fauxToolCall("new_context", { handoff: "Checkpoint ready" }),
							{ stopReason: "toolUse" },
						)
					: fauxAssistantMessage("done");
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
			assert.equal(
				h.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "compaction")
					.filter((entry) => isRecord(entry.details) && entry.details.posthorse === 1)
					.length,
				1,
			);
			for (const messages of captures) {
				const prompt = getCurrentSystemPrompt(messages);
				const guidance = mode.startsWith("forced-")
					? (messages
							.map(textOf)
							.find((text) =>
								text.includes("## Context self-management (Posthorse)"),
							) ?? "")
					: prompt;
				assert.equal(
					guidance.split("## Context self-management (Posthorse)").length - 1,
					1,
				);
				assert.match(guidance, /verify live state/);
				assert.match(guidance, /available file-editing tools at its absolute path/);
				assert.match(guidance, /already current, leave it unchanged/);
				assert.match(guidance, /Preserve decisions and safety constraints/);
				if (mode.startsWith("forced-")) {
					assert.match(prompt, /OTHER_EXTENSION_POLICY/);
				}
				if (mode === "custom") {
					assert.match(prompt, /CUSTOM_PROMPT_POLICY/);
				}
			}
			if (!mode.startsWith("forced-")) {
				assert.deepEqual(
					requireValue(captures[1])[0],
					requireValue(captures[0])[0],
					"adding a tool must preserve the initial prompt and declarations",
				);
				const initialPrompt = requireValue(requireValue(captures[0])[0]);
				assert.ok(initialPrompt.role === "system");
				assert.match(initialPrompt.sections?.posthorse ?? "", /Context self-management/);
				assert.ok(
					requireValue(captures[1])
						.slice(1)
						.some(
							(message) =>
								message.role === "system" &&
								message.toolsAdded?.some((tool) => tool.name === "extra") === true,
						),
				);
			}
			const reopened = SessionManager.open(
				requireValue(h.sessionManager.getSessionFile()),
			).buildSessionContext().messages;
			assert.deepEqual(
				getCurrentTools(reopened)
					.map((tool) => tool.name)
					.sort(),
				["extra", "new_context"],
			);
			if (mode.startsWith("forced-")) {
				assert.doesNotMatch(
					getCurrentSystemPrompt(reopened),
					/OTHER_EXTENSION_POLICY/,
					"run-only forced policy must not replace the saved structured prompt",
				);
			}
		},
	);
}

for (const mode of ["unforced", "forced", "forced-user-to-custom"]) {
	nodeTest(`idle custom wakeup gets current request-local guidance (${mode})`, async (t) => {
		let api: NativeSdk.ExtensionAPI | undefined;
		let projected: NativeSdk.ContextWithSystemEvent["messages"] | undefined;
		let forcePrompt = mode === "forced-user-to-custom";
		const starts: {
			readonly messageType: NativeSdk.BeforeAgentStartEvent["messageType"];
			readonly message: unknown;
			readonly hasPrompt: boolean;
			readonly idle: boolean;
			readonly options: NativeSdk.BeforeAgentStartEvent["systemPromptOptions"];
		}[] = [];
		const h = await fixture(t, {
			customPrompt: "CUSTOM_RUN_POLICY",
			extension(pi) {
				api = pi;
				pi.on("before_agent_start", (event, ctx) => {
					starts.push({
						messageType: event.messageType,
						message: "message" in event ? event.message : undefined,
						hasPrompt: "prompt" in event,
						idle: ctx.isIdle(),
						options: event.systemPromptOptions,
					});
					if (forcePrompt) {
						return { systemPrompt: "OPAQUE_FORCED_POLICY" };
					}
					return;
				});
			},
			afterExtension(pi) {
				pi.on("context_with_system", (event) => {
					projected = structuredClone(event.messages);
				});
			},
		});
		h.faux.setResponses([fauxAssistantMessage("First run completed.")]);
		await h.session.prompt("Initial owner request.");
		assert.equal(starts.length, 1);
		const userStart = requireValue(starts[0]);
		assert.equal(userStart.messageType, "user");
		const previousOptions = userStart.options;
		forcePrompt = mode === "forced";
		h.settingsManager.applyOverrides({ compaction: { reserveTokens: 32_000 } });
		let request: TranscriptMessages | undefined;
		h.faux.setResponses([
			(ctx) => {
				request = structuredClone(ctx.messages);
				return fauxAssistantMessage("Custom run completed.");
			},
		]);
		const content = "BACKGROUND_COMPLETION: inspect current state.";
		requireValue(api).sendMessage(
			{ customType: "background-completion", content, display: true },
			{ triggerTurn: true },
		);
		await h.session.waitForIdle();
		assert.ok(request);
		assert.ok(projected);
		assert.equal(h.faux.state.callCount, 2);
		assert.equal(starts.length, 2);
		const customStart = requireValue(starts[1]);
		assert.equal(customStart.messageType, "custom");
		assert.equal(customStart.hasPrompt, false);
		assert.equal(customStart.idle, false);
		assert.equal(textOf(customStart.message), content);
		assert.notEqual(customStart.options, previousOptions);
		const forced = forcePrompt;
		const local = projected.filter(
			(message) => "customType" in message && message.customType === "posthorse-guidance",
		);
		assert.equal(local.length, forced ? 1 : 0);
		const prompt = getCurrentSystemPrompt(request);
		const guidance = forced ? textOf(local[0]) : prompt;
		assert.match(guidance, /Configured context capacity: 100,000 tokens/);
		assert.match(guidance, /rollover line is 68,001 tokens used/);
		assert.doesNotMatch(guidance, /83,617/);
		assert.equal(
			[prompt, ...request.filter((message) => message.role !== "system").map(textOf)]
				.join("\n")
				.split("## Context self-management (Posthorse)").length - 1,
			1,
		);
		if (forced) {
			assert.equal(prompt, "OPAQUE_FORCED_POLICY");
			const guidanceMessage = requireValue(local[0]);
			assert.ok("display" in guidanceMessage);
			assert.equal(guidanceMessage.display, false);
		} else {
			assert.match(prompt, /CUSTOM_RUN_POLICY/);
			assert.doesNotMatch(prompt, /OPAQUE_FORCED_POLICY/);
			assert.equal(
				request.filter(
					(message) =>
						message.role === "system" &&
						typeof message.sections?.posthorse === "string",
				).length,
				1,
			);
		}
		assert.equal(request.filter((message) => textOf(message) === content).length, 1);
		const saved = h.sessionManager.getBranch();
		assert.equal(
			saved.filter(
				(entry) => "customType" in entry && entry.customType === "background-completion",
			).length,
			1,
		);
		assert.equal(
			saved.filter(
				(entry) => "customType" in entry && entry.customType === "posthorse-guidance",
			).length,
			0,
		);
	});
}

nodeTest("namespaced tools count toward the fresh handoff budget", async (t) => {
	const h = await fixture(t, {
		contextWindow: 32_768,
		extension(pi) {
			pi.registerTool({
				name: "catalog",
				namespace: { name: "example" },
				label: "Catalog",
				description: "d".repeat(52_000),
				parameters: { type: "object", properties: {} },
				async execute() {
					return { content: [{ type: "text", text: "unused" }], details: undefined };
				},
			});
		},
	});
	const catalog = h.session.getAllTools().find((tool) => tool.name === "catalog");
	assert.ok(catalog);
	h.session.setActiveToolsByName(["new_context", catalog.name]);
	const handoff = "h".repeat(20_000);
	h.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("new_context", { handoff }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Done."),
	]);
	await h.session.prompt("Save the handoff.");
	const branch = h.sessionManager.getBranch();
	const result = messageEntry(
		branch.findLast(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "new_context",
		),
	).message;
	assert.ok(result.role === "toolResult");
	assert.equal(
		result.isError,
		true,
		"active namespaced tool declarations must reduce the handoff budget",
	);
	assert.match(textOf(result), /Handoff is too large for the active model/);
	assert.equal(
		branch
			.filter((entry) => entry.type === "compaction")
			.filter((entry) => isRecord(entry.details) && entry.details.posthorse === 1).length,
		0,
		"a denied handoff must not commit any Posthorse boundary",
	);
});

for (const { enabled, reads } of [
	{ enabled: false, reads: 4 },
	{ enabled: true, reads: 4 },
	{ enabled: false, reads: 6 },
	{ enabled: false, reads: 50 },
]) {
	nodeTest(
		`public mixed searches/list/reads stay below configured capacity (compaction=${enabled}, reads=${reads})`,
		async (t) => {
			const h = await fixture(t, {
				enabled,
				seed(manager) {
					for (let index = 0; index < 60; index++) {
						manager.appendMessage({
							role: "user",
							content: `needle ${"h".repeat(500)}`,
							timestamp: index,
						});
					}
					reset(manager, "Historical fixture");
				},
			});
			const dir = join(h.cwd, ".pi", "notes");
			mkdirSync(dir, { recursive: true });
			for (let index = 0; index < 220; index++) {
				writeFileSync(
					join(dir, `${index}-${"n".repeat(100)}.md`),
					`needle ${"n".repeat(300)}`,
				);
			}
			writeFileSync(join(dir, "long.md"), "L".repeat(30_000));
			let before: number | null | undefined, after: number | null | undefined;
			let results: Extract<TranscriptMessages[number], { role: "toolResult" }>[] | undefined;
			let calls: NativeAi.ToolCall[] | undefined;
			h.faux.setResponses([
				() => {
					before = h.session.getContextUsage()?.tokens;
					const owner = h.sessionManager
						.getBranch()
						.findLast(
							(entry) => entry.type === "message" && entry.message.role === "user",
						);
					calls =
						reads === 4
							? [
									fauxToolCall("history", {
										op: "search",
										query: "needle",
										limit: 50,
									}),
									fauxToolCall("notes", { op: "search", query: "needle" }),
									fauxToolCall("notes", { op: "list" }),
									fauxToolCall("notes", { op: "read", path: "long.md" }),
								]
							: Array.from({ length: reads }, (_, index) =>
									index % 2 !== 0
										? fauxToolCall("history", {
												op: "read",
												id: requireValue(owner).id,
												offset: (index % 3) * 20_000,
											})
										: fauxToolCall("notes", { op: "read", path: "long.md" }),
								);
					return fauxAssistantMessage(calls, { stopReason: "toolUse" });
				},
				(ctx) => {
					after = h.session.getContextUsage()?.tokens;
					results = ctx.messages.filter((message) => message.role === "toolResult");
					return fauxAssistantMessage("done");
				},
			]);
			let promptLength = 300_000;
			if (reads === 4) {
				promptLength = enabled ? 305_000 : 365_000;
			}
			await h.session.prompt("p".repeat(promptLength));
			assert.ok(after !== null && after !== undefined);
			assert.ok(results);
			assert.ok(calls);
			assert.equal(h.faux.getPendingResponseCount(), 0);
			assert.ok(
				after < (enabled ? 83_617 : 100_000),
				JSON.stringify({ before, after, enabled }),
			);
			assert.equal(
				results.length,
				reads,
				"bounded results should not force avoidable rollover",
			);
			assert.ok(results.some((result) => result.isError));
			for (const result of results) {
				const journal = messageEntry(
					h.sessionManager
						.getBranch()
						.findLast(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "toolResult" &&
								entry.message.toolCallId === result.toolCallId,
						),
				);
				assert.ok(journal.message.role === "toolResult");
				const details = journal.message.details;
				if (
					isRecord(details) &&
					(details.kind === "history-read" || details.kind === "note-read")
				) {
					const display = fixtureDisplay(details);
					assert.ok(display.kind === "history-read" || display.kind === "note-read");
					assert.ok(
						display.end - display.offset <= 40_000,
						"read payload ceiling excludes its bounded header/continuation",
					);
				} else {
					assert.ok(textOf(result).length <= 40_000);
				}
			}
			if (reads > 4) {
				assert.ok(
					results.some((result) =>
						/continue with offset|and offset/.test(textOf(result)),
					),
					"partial pages retain continuation offsets",
				);
				assert.ok(
					results.some((result) => textOf(result).includes("Too little context remains")),
					"at least one sibling refusal carries retry guidance",
				);
				const offsets = new Map(calls.map((call) => [call.id, call.arguments.offset ?? 0]));
				for (const result of results) {
					if (textOf(result).includes("Too little context remains")) {
						const offset = offsets.get(result.toolCallId);
						assert.ok(typeof offset === "number");
						assert.match(textOf(result), new RegExp(`retry with offset ${offset}`));
					}
				}
			}
			assert.equal(
				h.sessionManager
					.getBranch()
					.filter((entry) => entry.type === "compaction")
					.filter((entry) => isRecord(entry.details) && entry.details.posthorse === 1)
					.length,
				1,
			);
			t.diagnostic(JSON.stringify({ before, after, enabled, reads }));
		},
	);
}

const settlementCases: readonly {
	readonly continuation: "none" | "steer" | "followUp" | "boundary";
	readonly stopReason: NativeAi.AssistantMessage["stopReason"];
}[] = [
	{ continuation: "none", stopReason: "stop" },
	{ continuation: "none", stopReason: "length" },
	{ continuation: "steer", stopReason: "stop" },
	{ continuation: "followUp", stopReason: "stop" },
	{ continuation: "boundary", stopReason: "stop" },
];
for (const { continuation, stopReason } of settlementCases) {
	nodeTest(
		`public answer in the reminder band preserves native settlement (continuation=${continuation}, stopReason=${stopReason})`,
		async (t) => {
			const h = await fixture(t, {
				extension(pi) {
					if (continuation === "steer" || continuation === "followUp") {
						pi.on("turn_end", (event) => {
							if (textOf(event.message) === "Final report.") {
								pi.sendUserMessage("Continue the requested work.", {
									deliverAs: continuation,
								});
							}
						});
					}
					if (continuation === "boundary") {
						pi.on("turn_end", (event) => {
							if (textOf(event.message) === "Final report.") {
								return {
									entries: [
										...event.entries,
										{
											type: "custom_message",
											customType: "continue-work",
											content: "Continue the requested work.",
											display: false,
										},
									],
									continue: true,
								};
							}
							return;
						});
					}
				},
			});
			const requests: TranscriptMessages[] = [];
			h.faux.setResponses([
				(ctx) => {
					requests.push(ctx.messages);
					return fauxAssistantMessage("Final report.", { stopReason });
				},
				(ctx) => {
					requests.push(ctx.messages);
					return fauxAssistantMessage("Continued report.");
				},
				(ctx) => {
					requests.push(ctx.messages);
					return fauxAssistantMessage("Checkpoint received.");
				},
			]);
			await h.session.prompt("p".repeat(305_000));
			const reminders = () =>
				h.sessionManager
					.getBranch()
					.filter(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "posthorse-reminder",
					);
			if (continuation !== "none") {
				assert.equal(reminders().length, 1);
				assert.match(JSON.stringify(requests.slice(1)), /Notes checkpoint:/);
				assert.match(
					textOf(reminders()[0]),
					/Then continue working; let automatic rollover happen without calling new_context/,
				);
				assert.doesNotMatch(
					JSON.stringify(requests.slice(1)),
					/Stop normal work|Then call new_context/,
				);
				assert.equal(
					requireValue(
						h.session.messages.findLast((message) => message.role === "assistant"),
					).stopReason,
					"stop",
				);
				return;
			}
			assert.equal(reminders().length, 0);
			if (stopReason === "length") {
				assert.equal(requests.length, 2, "native truncation recovery still retries once");
				assert.equal(
					textOf(h.session.messages.findLast((message) => message.role === "assistant")),
					"Continued report.",
				);
				return;
			}
			assert.equal(requests.length, 1, "a checkpoint must not wake a finished agent");
			assert.equal(
				textOf(h.session.messages.findLast((message) => message.role === "assistant")),
				"Final report.",
			);
			const usage = h.session.getContextUsage();
			assert.ok(usage?.tokens !== null && usage?.tokens !== undefined);
			assert.ok(
				usage.tokens >= 75_255 && usage.tokens < 83_617,
				"the final answer is inside the reminder band",
			);
			h.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("get_context_remaining", {})], {
					stopReason: "toolUse",
				}),
				(ctx) => {
					requests.push(ctx.messages);
					return fauxAssistantMessage("Working turn completed.");
				},
			]);
			await h.session.prompt("Continue working.");
			assert.equal(
				reminders().length,
				1,
				"a skipped final answer does not consume the reminder",
			);
			assert.match(JSON.stringify(requests.at(-1)), /Notes checkpoint:/);
			h.faux.setResponses([
				fauxAssistantMessage([fauxToolCall("get_context_remaining", {})], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("Another working turn completed."),
			]);
			await h.session.prompt("Continue working again.");
			assert.equal(reminders().length, 1, "the reminder is still once per window");
		},
	);
}

nodeTest(
	"public enabled-to-disabled policy removes the active reminder but keeps its journal entry",
	async (t) => {
		const h = await fixture(t);
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("get_context_remaining", {})], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Checkpoint reminder received"),
		]);
		await h.session.prompt("p".repeat(305_000));
		const reminders = () =>
			h.sessionManager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "posthorse-reminder",
				);
		assert.equal(reminders().length, 1);
		const original = structuredClone(reminders()[0]);
		h.settingsManager.applyOverrides({ compaction: { enabled: false } });
		let input: string | undefined;
		h.faux.setResponses([
			(ctx) => {
				input = [
					getCurrentSystemPrompt(ctx.messages),
					...ctx.messages.filter((message) => message.role !== "system").map(textOf),
				].join("\n");
				return fauxAssistantMessage("Done");
			},
		]);
		await h.session.prompt("Continue without automatic rollover");
		assert.ok(input !== undefined && input !== "");
		assert.match(input, /Pi compaction is disabled/);
		assert.doesNotMatch(input, /Notes checkpoint:|then call new_context now/);
		assert.deepEqual(reminders(), [original]);
	},
);

nodeTest(
	"public checkpoint reminder reaches the model after Pi compacts inside a rollover window",
	async (t) => {
		const h = await fixture(t, {
			seed(manager) {
				manager.appendMessage({ role: "user", content: "first window", timestamp: 1 });
				manager.appendMessage(fauxAssistantMessage("ok"));
				reset(manager, "prior handoff");
				manager.appendMessage({
					role: "user",
					content: "second window, summarized",
					timestamp: 2,
				});
				manager.appendMessage(fauxAssistantMessage("ok"));
				const kept = manager.appendMessage({
					role: "user",
					content: "second window, kept",
					timestamp: 3,
				});
				manager.appendMessage(fauxAssistantMessage("ok"));
				manager.appendCompaction("Pi summary of the window's start", kept, 5000);
			},
		});
		let input: string | undefined;
		h.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("get_context_remaining", {})], {
				stopReason: "toolUse",
			}),
			(ctx) => {
				input = JSON.stringify(ctx.messages);
				return fauxAssistantMessage("Checkpoint reminder received");
			},
		]);
		await h.session.prompt("p".repeat(305_000));
		assert.doesNotMatch(
			input ?? "",
			/Context window \S+ starts here/,
			"the compaction removed the window marker",
		);
		assert.match(input ?? "", /Notes checkpoint:/);
	},
);

for (const nativeCompact of [false, true]) {
	nodeTest(
		`public history search skips entries still in the active context (nativeCompact=${nativeCompact})`,
		async (t) => {
			const h = await fixture(t, {
				seed(manager) {
					manager.appendMessage({
						role: "user",
						content: "IN_CONTEXT_NEEDLE before rollover",
						timestamp: 1,
					});
					manager.appendMessage(fauxAssistantMessage("ok"));
					if (!nativeCompact) {
						reset(manager, "carry on");
					}
					const kept = manager.appendMessage({
						role: "user",
						content: "IN_CONTEXT_NEEDLE after rollover",
						timestamp: 2,
					});
					manager.appendMessage(fauxAssistantMessage("ok"));
					if (nativeCompact) {
						manager.appendCompaction("Earlier work summarized", kept, 100);
					}
				},
			});
			h.faux.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("history", { op: "search", query: "in_context_needle" }),
						fauxToolCall("history", {
							op: "search",
							query: "in_context_needle",
							all: true,
						}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
			]);
			await h.session.prompt("Look back.");
			const results = h.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message")
				.filter(
					(entry) =>
						entry.message.role === "toolResult" && entry.message.toolName === "history",
				)
				.map((entry) => textOf(entry.message));
			assert.equal(results.length, 2);
			for (const text of results) {
				assert.match(text, /\[user\] IN_CONTEXT_NEEDLE before rollover/);
				assert.doesNotMatch(text, /IN_CONTEXT_NEEDLE after rollover/);
				assert.match(text, /\[Skipped \d+ match(es)? already in your active context\.\]/);
			}
		},
	);
}

for (const all of [false, true]) {
	nodeTest(
		`public search cursors finish despite appended lookup echoes (all=${all})`,
		async (t) => {
			const h = await fixture(t, {
				seed(manager) {
					for (let index = 0; index < 9; index++) {
						manager.appendMessage({
							role: "user",
							content: `CURSOR-NEEDLE original ${index}`,
							timestamp: index,
						});
					}
					manager.appendMessage({
						role: "toolResult",
						toolName: "notes",
						toolCallId: "prior",
						content: [{ type: "text", text: "CURSOR-NEEDLE prior recovery echo" }],
						isError: false,
						timestamp: 10,
					});
					// Earlier-window entries are what search recovers; this window's lookup echoes stay in context.
					reset(manager, "Paging fixture");
				},
			});
			const originals = h.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "user")
				.map((entry) => entry.id)
				.reverse();
			const priorEcho = requireValue(
				h.sessionManager
					.getBranch()
					.find(
						(entry) => entry.type === "message" && entry.message.role === "toolResult",
					),
			).id;
			const returned: string[] = [];
			let complete = false;
			const call = (cursor?: string) =>
				fauxAssistantMessage(
					fauxToolCall("history", {
						op: "search",
						query: "CURSOR-NEEDLE",
						limit: 2,
						all,
						...(cursor !== undefined && cursor !== "" ? { cursor } : {}),
					}),
					{ stopReason: "toolUse" },
				);
			h.faux.setResponses([
				call(),
				...Array.from({ length: 30 }, (): NativeAi.FauxResponseFactory => (ctx) => {
					const result = ctx.messages.at(-1);
					assert.ok(result?.role === "toolResult");
					assert.equal(result.toolName, "history");
					assert.ok(!result.isError, textOf(result));
					const text = textOf(result);
					// Excerpts can contain previous result headers. Native display spans delimit actual hits.
					const journal = [...h.sessionManager.getBranch()]
						.reverse()
						.find(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "toolResult" &&
								entry.message.toolCallId === result.toolCallId,
						);
					const message = messageEntry(journal).message;
					assert.ok(message.role === "toolResult");
					const details = fixtureResult(message).details;
					assert.ok(details?.kind === "history-search");
					let start = 0;
					for (const span of details.entries) {
						const header = text.slice(start, start + span.headerLength);
						const id = header.match(/\[window [^\]]+\] \[([^\]]+)\] /)?.[1];
						assert.ok(id !== undefined && id !== "", header);
						returned.push(id);
						start += span.length + 1;
					}
					assert.equal(start - 1, text.length - requireValue(details.footerLength));
					const cursor = nextCursor(text);
					if (cursor !== undefined && cursor !== "") {
						return call(cursor);
					}
					complete = true;
					return fauxAssistantMessage("Finished paging");
				}),
			]);
			await h.session.prompt("Recover earlier source entries");
			assert.equal(complete, true);
			const nativeIds = returned.map((id) => requireValue(id.split("@")[0]));
			assert.deepEqual(
				nativeIds.slice(0, originals.length),
				originals,
				"original entries keep order and appear exactly once",
			);
			assert.ok(
				returned.every((id) => id.includes("@") === all),
				"all-session references identify their source file",
			);
			assert.equal(
				new Set(returned).size,
				returned.length,
				"lookup echoes cannot repeat previously returned entries",
			);
			assert.ok(
				returned.length > originals.length,
				"the earlier window's recovery echo remains searchable",
			);
			assert.ok(
				nativeIds.includes(priorEcho),
				"the original recovery echo remains retrievable too",
			);
			t.diagnostic(
				JSON.stringify({ all, originals: originals.length, returned: returned.length }),
			);
		},
	);
}
