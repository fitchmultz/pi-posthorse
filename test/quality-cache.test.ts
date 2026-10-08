import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const repository = resolve(import.meta.dirname, "..");
const preparedCache = join(
	process.env.npm_config_cache ?? join(repository, "node_modules/.cache"),
	"pi-quality-engine",
);

// Exercise the real preparation entry points with binaries produced by quality:prepare.
// No compilers are available: a cache miss cannot masquerade as successful reuse.
// Protect cross-checkout installation, checksum refusal, input invalidation and --force.
function project(): {
	readonly root: string;
	readonly source: string;
	readonly cache: string;
} {
	const root = mkdtempSync(join(tmpdir(), "posthorse-engine-cache-"));
	const source = join(root, "consumer");
	mkdirSync(source);
	for (const directory of ["scripts", "patches"]) {
		cpSync(join(repository, directory), join(source, directory), { recursive: true });
	}
	for (const dependency of ["oxlint", "@oxlint", "@oxlint-tsgolint"]) {
		cpSync(
			join(repository, "node_modules", dependency),
			join(source, "node_modules", dependency),
			{ recursive: true },
		);
	}
	const cache = join(root, "npm-cache");
	cpSync(preparedCache, join(cache, "pi-quality-engine"), { recursive: true });
	return { root, source, cache };
}

function prepare(source: string, cache: string, script: string, force = false) {
	return spawnSync(
		process.execPath,
		[join(source, "scripts", script), ...(force ? ["--force"] : [])],
		{
			cwd: source,
			env: { ...process.env, npm_config_cache: cache, PATH: "" },
			encoding: "utf8",
			timeout: 10_000,
		},
	);
}

const engines = [
	{
		script: "setup-oxlint-engine.ts",
		installed: (path: string) => path.endsWith(".node"),
		cached: "oxlint.node",
		patch: "oxlint-import-cycles.patch",
	},
	{
		script: "setup-quality-engine.ts",
		installed: (path: string) => /[/\\]tsgolint(?:\.exe)?$/u.test(path),
		cached: process.platform === "win32" ? "tsgolint.exe" : "tsgolint",
		patch: "tsgolint-safe-call.patch",
	},
];

for (const engine of engines) {
	test(`${engine.script} reuses verified outputs in separate fresh dependency trees`, () => {
		const fixture = project();
		try {
			const expected = new Map(
				readdirSync(join(fixture.source, "node_modules"), {
					recursive: true,
					encoding: "utf8",
				})
					.filter(engine.installed)
					.map((path) => [
						path,
						readFileSync(join(fixture.source, "node_modules", path)),
					]),
			);
			assert.equal(expected.size, 1, "fixture must reach the installed native backend");
			for (const name of ["first", "second"]) {
				const consumer = join(fixture.root, name);
				cpSync(fixture.source, consumer, { recursive: true });
				for (const path of expected.keys()) {
					writeFileSync(join(consumer, "node_modules", path), "unprepared dependency");
				}
				const result = prepare(consumer, fixture.cache, engine.script);
				assert.equal(result.status, 0, result.stderr);
				for (const [path, bytes] of expected) {
					assert.deepEqual(readFileSync(join(consumer, "node_modules", path)), bytes);
				}
				const forced = prepare(consumer, fixture.cache, engine.script, true);
				assert.notEqual(forced.status, 0, "--force must not reuse cached outputs");
				for (const [path, bytes] of expected) {
					assert.deepEqual(readFileSync(join(consumer, "node_modules", path)), bytes);
				}
			}
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	test(`${engine.script} refuses corrupt outputs and invalidates changed patches`, () => {
		const fixture = project();
		try {
			const ready = prepare(fixture.source, fixture.cache, engine.script);
			assert.equal(ready.status, 0, ready.stderr);
			const cache = join(fixture.cache, "pi-quality-engine");
			const outputs = readdirSync(cache, { recursive: true, encoding: "utf8" }).filter(
				(path) => path.endsWith(`/${engine.cached}`) || path.endsWith(`\\${engine.cached}`),
			);
			assert.ok(outputs.length > 0, "positive control must include a prepared cache");
			for (const path of outputs) {
				writeFileSync(join(cache, path), "corrupted native output");
			}
			const corrupted = prepare(fixture.source, fixture.cache, engine.script);
			assert.equal(corrupted.status, 1, corrupted.stderr);
			assert.match(corrupted.stderr, /failed checksum verification/u);
			const patch = join(fixture.source, "patches", engine.patch);
			writeFileSync(patch, `${readFileSync(patch, "utf8")}\n`);
			const changed = prepare(fixture.source, fixture.cache, engine.script);
			assert.equal(changed.status, 1, "changed inputs must require an unavailable compiler");
			assert.match(changed.stderr, /ENOENT/u);
			assert.doesNotMatch(changed.stderr, /failed checksum verification/u);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
}
