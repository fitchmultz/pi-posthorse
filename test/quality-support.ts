import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { objectValue, readObject } from "../scripts/quality-policy.ts";

export const repository = resolve(import.meta.dirname, "..");
export const policy = readObject(join(repository, ".oxlintrc.json"));

export interface Finding {
	readonly code: string;
	readonly file: string;
	readonly line: number;
}
export interface FixtureOptions {
	readonly files: Readonly<Record<string, string>>;
	readonly rules?: Readonly<Record<string, unknown>>;
	readonly config?: Readonly<Record<string, unknown>>;
	readonly compiler?: Readonly<Record<string, unknown>>;
	readonly paths?: readonly string[];
}

export function fixture(options: FixtureOptions): {
	readonly root: string;
	readonly dispose: () => void;
} {
	const root = mkdtempSync(join(tmpdir(), "posthorse-quality-"));
	try {
		mkdirSync(join(root, "node_modules"));
		for (const name of [
			".bin",
			"@types",
			"@earendil-works",
			"@oxlint-tsgolint",
			"typescript",
			"typebox",
			"oxlint-tsgolint",
		]) {
			symlinkSync(
				join(repository, "node_modules", name),
				join(root, "node_modules", name),
				"dir",
			);
		}
		writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
		writeFileSync(
			join(root, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					target: "ESNext",
					module: "NodeNext",
					types: ["node"],
					strict: true,
					noImplicitReturns: true,
					noEmit: true,
					allowJs: true,
					checkJs: false,
					allowImportingTsExtensions: true,
					skipLibCheck: true,
					...options.compiler,
				},
				include: ["**/*.ts", "**/*.js", "**/*.mjs"],
			}),
		);
		if (!objectValue(policy.rules)) {
			throw new Error("Root lint rules are missing");
		}
		writeFileSync(
			join(root, ".oxlintrc.json"),
			JSON.stringify({
				...policy,
				...options.config,
				rules: { ...policy.rules, ...options.rules },
			}),
		);
		for (const [file, text] of Object.entries(options.files)) {
			mkdirSync(dirname(join(root, file)), { recursive: true });
			writeFileSync(join(root, file), text);
		}
		return {
			root,
			dispose: () => {
				rmSync(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

function finding(value: unknown): Finding {
	assert.ok(objectValue(value), "CLI diagnostic must be an object");
	assert.equal(value.severity, "error", "warnings must not be silently accepted");
	assert.equal(typeof value.code, "string", "diagnostic must identify its rule or compiler code");
	assert.equal(typeof value.filename, "string");
	assert.ok(Array.isArray(value.labels) && value.labels.length > 0);
	const label: unknown = value.labels[0];
	assert.ok(objectValue(label) && objectValue(label.span));
	assert.equal(typeof label.span.line, "number");
	if (
		typeof value.code !== "string" ||
		typeof value.filename !== "string" ||
		typeof label.span.line !== "number"
	) {
		throw new Error("Invalid diagnostic location");
	}
	return {
		code: value.code.replace(/^(\w+)\(([^)]+)\)$/u, "$1/$2"),
		file: value.filename,
		line: label.span.line,
	};
}

export function lintFixture(options: FixtureOptions): readonly Finding[] {
	const project = fixture(options);
	try {
		const paths =
			options.paths ??
			Object.keys(options.files).filter(
				(file) => /\.[cm]?[jt]sx?$/u.test(file) && !file.startsWith("node_modules/"),
			);
		const result = spawnSync(
			join(repository, "node_modules/.bin/oxlint"),
			["--threads=2", "--format=json", ...paths],
			{ cwd: project.root, encoding: "utf8", timeout: 30_000 },
		);
		assert.equal(result.error, undefined, "CLI must run successfully");
		assert.equal(result.signal, null, "CLI must not crash or timeout");
		assert.equal(result.stderr, "", "unexpected engine/configuration warnings");
		const output: unknown = JSON.parse(result.stdout);
		assert.ok(
			objectValue(output) && Array.isArray(output.diagnostics),
			"CLI must emit structured diagnostics",
		);
		const raw: readonly unknown[] = output.diagnostics;
		const diagnostics = raw.map(finding);
		assert.equal(
			result.status,
			diagnostics.length === 0 ? 0 : 1,
			"child failure status must agree with its diagnostics",
		);
		return diagnostics;
	} finally {
		project.dispose();
	}
}

export function expectFindings(options: FixtureOptions, expected: readonly Finding[]): void {
	const actual = lintFixture(options);
	const sort = (items: readonly Finding[]) =>
		items.map((item) => `${item.file}:${item.line}:${item.code}`).toSorted();
	assert.deepEqual(sort(actual), sort(expected));
}

export function fileText(path: string): string {
	return readFileSync(join(repository, path), "utf8");
}
