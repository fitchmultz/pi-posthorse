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

export interface FixturePolicy {
	readonly enabled: boolean;
	readonly reserveTokens: number;
}

export function fixturePolicy(context: ExtensionContext): FixturePolicy {
	if (
		!("getCompactionSettings" in context) ||
		typeof context.getCompactionSettings !== "function"
	) {
		throw new Error("Fixture context must expose its compaction policy");
	}
	const value: unknown = Reflect.apply(context.getCompactionSettings, context, []);
	assert.ok(value !== null && typeof value === "object");
	assert.ok("enabled" in value && typeof value.enabled === "boolean");
	assert.ok("reserveTokens" in value && typeof value.reserveTokens === "number");
	return { enabled: value.enabled, reserveTokens: value.reserveTokens };
}

export async function loadFixture(
	factory: ExtensionFactory,
): Promise<{ readonly extension: Extension; readonly runtime: ExtensionRuntime }> {
	const loader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: tmpdir(),
		settingsManager: SettingsManager.inMemory(),
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [factory],
	});
	await loader.reload();
	const loaded = loader.getExtensions();
	assert.deepEqual(loaded.errors, []);
	const extension = requireValue(loaded.extensions.at(0), "loaded extension");
	return { extension, runtime: loaded.runtime };
}

export function requireValue<T>(value: T | null | undefined, label = "fixture value"): T {
	assert.notEqual(value, undefined, `Missing ${label}`);
	if (value === undefined || value === null) {
		throw new Error(`Missing ${label}`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
	assert.ok(isRecord(value));
	return value;
}

export function stringValue(value: unknown): string {
	assert.equal(typeof value, "string");
	if (typeof value !== "string") {
		throw new Error("Expected a fixture string");
	}
	return value;
}
