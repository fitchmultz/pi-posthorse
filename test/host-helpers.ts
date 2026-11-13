import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionAPI,
	type ExtensionFactory,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	type AssistantMessage,
	type FauxContentBlock,
	type FauxModelDefinition,
	type FauxResponseFactory,
	type ImageContent,
	type Model,
	type Provider,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createPosthorse } from "../index.ts";
import { isRecord, REMINDER_TYPE } from "../src/contracts.ts";
import { textOf as plainTextOf } from "../src/ui/text.ts";
import { retainFile, retainSession } from "./fixture-files.ts";
import { ISOLATED_LOADER_FLAGS, record, requireValue } from "./harness.ts";

export type TranscriptMessages = TranscriptContext["messages"];

export const FIXTURE_PNG: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0ioAAAAASUVORK5CYII=",
};

/** Transcript assertions read text blocks without treating tool calls or images as text. */
export function textOf(message: unknown): string {
	return plainTextOf(isRecord(message) ? message.content : message);
}

export function messageEntry(
	entry: SessionEntry | undefined,
): Extract<SessionEntry, { type: "message" }> {
	assert.ok(entry?.type === "message", "Expected a persisted message entry");
	return entry;
}

export function posthorseBoundaries(
	manager: Pick<SessionManager, "getBranch">,
): Extract<SessionEntry, { type: "compaction" }>[] {
	return manager
		.getBranch()
		.filter((entry) => entry.type === "compaction")
		.filter((entry) => isRecord(entry.details) && entry.details.posthorse === 1);
}

export function reminderEntries(
	manager: Pick<SessionManager, "getBranch">,
): Extract<SessionEntry, { type: "custom_message" }>[] {
	return manager
		.getBranch()
		.filter(
			(entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
				entry.type === "custom_message" && entry.customType === REMINDER_TYPE,
		);
}

export function toolTurn(...calls: FauxContentBlock[]): AssistantMessage {
	return fauxAssistantMessage(calls, { stopReason: "toolUse" });
}

export function toolResults(
	manager: Pick<SessionManager, "getBranch">,
	match?: string | { readonly toolCallId: string },
): ToolResultMessage[] {
	return manager.getBranch().flatMap((entry) => {
		if (entry.type !== "message" || entry.message.role !== "toolResult") {
			return [];
		}
		if (typeof match === "string" && entry.message.toolName !== match) {
			return [];
		}
		if (typeof match === "object" && entry.message.toolCallId !== match.toolCallId) {
			return [];
		}
		return [entry.message];
	});
}

export function lastToolResult(
	manager: Pick<SessionManager, "getBranch">,
	match: string | { readonly toolCallId: string },
): ToolResultMessage {
	const found = toolResults(manager, match).at(-1);
	assert.ok(
		found !== undefined,
		`Missing ${typeof match === "string" ? match : match.toolCallId} result`,
	);
	return found;
}

export interface DumpOptions {
	readonly terminate?: boolean;
	readonly size?: number | readonly [number, ...number[]];
	readonly image?: ImageContent;
}

export function registerDump(pi: ExtensionAPI, options: DumpOptions = {}): void {
	const { terminate = false, size = 600_000, image } = options;
	let dumps = 0;
	pi.registerTool({
		name: "dump",
		label: "Dump",
		description: "Oversized local output",
		parameters: { type: "object", properties: {} },
		async execute() {
			const chars =
				typeof size === "number"
					? size
					: (size[Math.min(dumps++, size.length - 1)] ?? size[0]);
			return {
				content: [
					{ type: "text", text: `DUMP_HEAD ${"x".repeat(chars)} DUMP_TAIL` },
					...(image === undefined ? [] : [image]),
				],
				details: {},
				terminate,
			};
		},
	});
}

export interface HostFixtureOptions {
	readonly cwd?: string;
	readonly posthorse?: boolean;
	readonly fileTools?: boolean;
	readonly fileExtension?: boolean;
	readonly manager?: (cwd: string, directory: string) => SessionManager;
	readonly models?: FauxModelDefinition[];
	readonly contextWindow?: number;
	readonly providerAuth?: Provider["auth"];
	readonly enabled?: boolean;
	readonly reserveTokens?: number;
	readonly keepRecentTokens?: number;
	readonly systemPrompt?: string | undefined;
	readonly extension?: ExtensionFactory;
	readonly afterExtension?: ExtensionFactory;
	readonly getPolicy?: Parameters<typeof createPosthorse>[0];
	readonly expectedErrors?: ReturnType<DefaultResourceLoader["getExtensions"]>["errors"];
	readonly seed?: ((manager: SessionManager, model: Model<string>) => void) | undefined;
}

export interface HostFixture {
	readonly cwd: string;
	readonly agentDir: string;
	readonly session: AgentSession;
	readonly faux: ReturnType<typeof fauxProvider>;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly modelRuntime: ModelRuntime;
	readonly resourceLoader: DefaultResourceLoader;
}

function isolateAgentDir(t: TestContext, agentDir: string, enabled: boolean): void {
	if (!enabled) {
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

function createHostFaux(options: HostFixtureOptions): ReturnType<typeof fauxProvider> {
	const faux = fauxProvider({
		models: options.models ?? [
			{
				id: "official-posthorse",
				contextWindow: options.contextWindow ?? 100_000,
				maxTokens: 1000,
			},
		],
	});
	const setResponses = faux.setResponses;
	faux.setResponses = (steps) =>
		setResponses(
			steps.map((step): FauxResponseFactory => async (ctx, opts, state, model) => {
				// Constructed fixtures must not look older than a compaction committed during this run.
				await new Promise((resolve) => {
					setTimeout(resolve, 2);
				});
				const response = await (typeof step === "function"
					? step(ctx, opts, state, model)
					: step);
				return { ...response, timestamp: Date.now() };
			}),
		);
	return faux;
}

async function createHostResourceLoader(
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
	faux: ReturnType<typeof fauxProvider>,
	options: HostFixtureOptions,
): Promise<DefaultResourceLoader> {
	const { systemPrompt } = options;
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		...ISOLATED_LOADER_FLAGS,
		...(systemPrompt !== undefined && systemPrompt !== ""
			? { systemPromptOverride: () => systemPrompt }
			: {}),
		additionalExtensionPaths:
			options.fileExtension === true
				? [fileURLToPath(new URL("../index.ts", import.meta.url))]
				: [],
		extensionFactories: [
			(pi) => {
				pi.registerProvider(
					options.providerAuth === undefined
						? faux.provider
						: { ...faux.provider, auth: options.providerAuth },
				);
				return options.extension?.(pi);
			},
			...(options.fileExtension === true || options.posthorse === false
				? []
				: [createPosthorse(options.getPolicy)]),
			...(options.afterExtension ? [options.afterExtension] : []),
		],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, options.expectedErrors ?? []);
	return resourceLoader;
}

export async function hostFixture(
	t: TestContext,
	options: HostFixtureOptions = {},
): Promise<HostFixture> {
	const temp = realpathSync(mkdtempSync(join(tmpdir(), "posthorse-host-")));
	t.diagnostic(`isolated fixture: ${temp}`);
	const cwd = options.cwd ?? join(temp, "project");
	const agentDir = join(temp, "agent");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir);
	isolateAgentDir(t, agentDir, options.fileExtension === true);
	const faux = createHostFaux(options);
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
	});
	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: options.enabled ?? true,
			reserveTokens: options.reserveTokens ?? 16_384,
			...(options.keepRecentTokens === undefined
				? {}
				: { keepRecentTokens: options.keepRecentTokens }),
		},
		retry: { enabled: false },
	});
	const resourceLoader = await createHostResourceLoader(
		cwd,
		agentDir,
		settingsManager,
		faux,
		options,
	);
	const sessionsDir = join(temp, "sessions");
	const sessionManager =
		options.manager?.(cwd, sessionsDir) ?? SessionManager.create(cwd, sessionsDir);
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
		...(options.fileTools === true ? { tools: ["+read", "+write", "+edit"] } : {}),
	});
	t.after(() => {
		try {
			session.dispose();
		} finally {
			try {
				retainSession(temp, sessionManager, "final");
			} finally {
				rmSync(temp, { recursive: true, force: true });
			}
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

export async function forkFixture(
	t: TestContext,
	parent: { readonly cwd: string; readonly sessionManager: SessionManager },
	options: HostFixtureOptions & {
		readonly branch?: string | undefined;
		readonly sourceFile?: string | undefined;
	} = {},
): Promise<HostFixture> {
	const { branch, sourceFile, ...rest } = options;
	const file = sourceFile ?? requireValue(parent.sessionManager.getSessionFile());
	return hostFixture(t, {
		cwd: parent.cwd,
		...rest,
		manager: (cwd, directory) => {
			const manager = SessionManager.forkFrom(file, cwd, directory);
			if (branch !== undefined) {
				manager.branch(branch);
			}
			return manager;
		},
	});
}

export async function resumeFixture(
	t: TestContext,
	source: { readonly cwd: string; readonly sessionManager: SessionManager },
	options: HostFixtureOptions = {},
): Promise<HostFixture> {
	const file = requireValue(source.sessionManager.getSessionFile());
	return hostFixture(t, {
		cwd: source.cwd,
		...options,
		manager: (_cwd, directory) => SessionManager.open(file, directory),
	});
}

export function reopenedMessages(
	manager: SessionManager,
): ReturnType<SessionManager["buildSessionContext"]>["messages"] {
	return SessionManager.open(requireValue(manager.getSessionFile())).buildSessionContext()
		.messages;
}

export function requireForkCapability(
	t: TestContext,
	supported: boolean,
	feature: string,
): boolean {
	if (supported) {
		return true;
	}
	assert.notEqual(
		process.env.PI_COMPAT_HOST,
		"fork",
		`The maintained fork must expose ${feature}.`,
	);
	t.skip(`This host does not expose ${feature}; fork qualification owns this case.`);
	return false;
}

export function enableBackgroundCodemode(t: TestContext, h: HostFixture): boolean {
	h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "codemode"]);
	const codemode = requireValue(h.session.getAllTools().find((tool) => tool.name === "codemode"));
	return requireForkCapability(
		t,
		codemode.description.includes('"background": true'),
		"background codemode",
	);
}

export function rewriteSessionJsonl(
	root: string,
	file: string,
	transform: (entry: Record<string, unknown>) => Record<string, unknown>,
): void {
	const rewritten = readFileSync(file, "utf8")
		.split("\n")
		.map((line) => (line === "" ? "" : JSON.stringify(transform(record(JSON.parse(line))))))
		.join("\n");
	retainFile(root, file, "before-rewrite");
	writeFileSync(file, rewritten);
}
