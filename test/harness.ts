import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import {
	DefaultResourceLoader,
	SettingsManager,
	type ExtensionContext,
	type ExtensionFactory,
	type Extension,
	type ExtensionRuntime,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import { isRecord, type CompactionPolicy } from "../src/contracts.ts";
import { fixtureResult } from "./results.ts";

export const ISOLATED_LOADER_FLAGS = {
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
} as const;

function hasPolicyGetter(
	value: object,
): value is { readonly getCompactionSettings: () => unknown } {
	return "getCompactionSettings" in value && typeof value.getCompactionSettings === "function";
}

export function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
	return typeof value === "function";
}

export function fixturePolicy(context: ExtensionContext): CompactionPolicy {
	if (!hasPolicyGetter(context)) {
		throw new Error("Fixture context must expose its compaction policy");
	}
	const value = record(context.getCompactionSettings());
	assert.ok(typeof value.enabled === "boolean");
	assert.ok(typeof value.reserveTokens === "number");
	return { enabled: value.enabled, reserveTokens: value.reserveTokens };
}

export async function loadFixture(
	factory: ExtensionFactory,
): Promise<{ readonly extension: Extension; readonly runtime: ExtensionRuntime }> {
	const loader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: tmpdir(),
		settingsManager: SettingsManager.inMemory(),
		...ISOLATED_LOADER_FLAGS,
		extensionFactories: [factory],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	const extension = requireValue(loaded.extensions.at(0), "loaded extension");
	return { extension, runtime: loaded.runtime };
}

export async function executeFixtureTool(
	extension: Extension,
	name: string,
	params: Readonly<Record<string, unknown>>,
	context: unknown,
	options: {
		readonly id?: string | undefined;
		readonly signal?: AbortSignal | undefined;
	} = {},
): Promise<ReturnType<typeof fixtureResult>> {
	const { definition } = requireValue(extension.tools.get(name), `tool ${name}`);
	assert.ok(
		Check(definition.parameters, params),
		`Fixture arguments for ${name} must satisfy the registered schema`,
	);
	const id = options.id ?? "id";
	for (const handler of extension.handlers.get("tool_execution_start") ?? []) {
		await handler(
			{ type: "tool_execution_start", toolCallId: id, toolName: name, args: params },
			context,
		);
	}
	const value: unknown = await Reflect.apply(definition.execute.bind(definition), undefined, [
		id,
		params,
		options.signal,
		undefined,
		context,
	]);
	for (const handler of extension.handlers.get("tool_execution_end") ?? []) {
		await handler(
			{
				type: "tool_execution_end",
				toolCallId: id,
				toolName: name,
				result: value,
				isError: false,
			},
			context,
		);
	}
	return fixtureResult(value);
}

export function requireValue<T>(value: T | null | undefined, label = "fixture value"): T {
	assert.ok(value !== undefined && value !== null, `Missing ${label}`);
	return value;
}

export function record(value: unknown): Record<string, unknown> {
	assert.ok(isRecord(value));
	return value;
}

export function stringValue(value: unknown): string {
	assert.ok(typeof value === "string", "Expected a fixture string");
	return value;
}
