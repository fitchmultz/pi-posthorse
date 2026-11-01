import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { objectValue, readObject } from "../scripts/quality-settings.ts";
import { parseDocument } from "yaml";

export const repository = resolve(import.meta.dirname, "..");
export const policy = readObject(join(repository, ".oxlintrc.json"));
/** Independent CLI probes are process-bound; run about one per core. */
export const probeConcurrency = availableParallelism();

export interface Finding {
	readonly code: string;
	readonly file: string;
	readonly line: number;
}
export interface CliResult {
	readonly status: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;
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
		writeFileSync(join(root, ".gitignore"), "node_modules/\n");
		const compiler = readObject(join(repository, "tsconfig.json"));
		assert.ok(objectValue(compiler.compilerOptions));
		writeFileSync(
			join(root, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: { ...compiler.compilerOptions, ...options.compiler },
				include: [
					"**/*.ts",
					"**/*.tsx",
					"**/*.mts",
					"**/*.cts",
					"**/*.js",
					"**/*.jsx",
					"**/*.mjs",
					"**/*.cjs",
				],
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

/** Run a CLI without blocking other probes; spawn failures reject. */
export function runCli(command: string, args: readonly string[], cwd: string): Promise<CliResult> {
	return new Promise((resolveResult, reject) => {
		const child = spawn(command, args, { cwd, timeout: 30_000 });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (status, signal) => {
			resolveResult({ status, signal, stdout, stderr });
		});
	});
}

export async function lintFixture(options: FixtureOptions): Promise<readonly Finding[]> {
	const project = fixture(options);
	try {
		const paths =
			options.paths ??
			Object.keys(options.files).filter(
				(file) => /\.[cm]?[jt]sx?$/u.test(file) && !file.startsWith("node_modules/"),
			);
		const result = await runCli(
			join(repository, "node_modules/.bin/oxlint"),
			["--threads=2", "--format=json", ...paths],
			project.root,
		);
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

export async function expectFindings(
	options: FixtureOptions,
	expected: readonly Finding[],
): Promise<void> {
	const actual = await lintFixture(options);
	const sort = (items: readonly Finding[]) =>
		items.map((item) => `${item.file}:${item.line}:${item.code}`).toSorted();
	assert.deepEqual(sort(actual), sort(expected));
}

export function changeConfiguration(
	root: string,
	file: string,
	path: readonly (string | number)[],
	value: unknown,
): void {
	const document = parseDocument(readFileSync(join(root, file), "utf8"));
	document.setIn(path, value);
	writeFileSync(
		join(root, file),
		file.endsWith(".json") ? JSON.stringify(document.toJS()) : document.toString(),
	);
}

export function fileText(path: string): string {
	return readFileSync(join(repository, path), "utf8");
}
