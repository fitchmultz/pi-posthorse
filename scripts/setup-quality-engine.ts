import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const revision = "eb9339115edde6811ca94c3433adf69ea9852880";
const typescriptRevision = "2bd066d87f5bafd315be9f40889d0a60b9e58e0b";
const patch = join(root, "patches/tsgolint-safe-call.patch");
const cache = join(root, "node_modules/.cache/pi-quality-engine");
const binary = join(cache, process.platform === "win32" ? "tsgolint.exe" : "tsgolint");
const manifestPath = join(cache, "manifest.json");
const installedBinary = join(
	root,
	"node_modules",
	"@oxlint-tsgolint",
	`${process.platform}-${process.arch}`,
	process.platform === "win32" ? "tsgolint.exe" : "tsgolint",
);

interface EngineIdentity {
	readonly revision: string;
	readonly typescriptRevision: string;
	readonly patchSha256: string;
	readonly platform: string;
	readonly arch: string;
}

function digest(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(
	command: string,
	args: readonly string[],
	cwd: string,
	env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
	const result = spawnSync(command, [...args], {
		cwd,
		env,
		encoding: "utf8",
		timeout: 600_000,
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error !== undefined) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed (${result.status ?? result.signal ?? "unknown"}):\n${result.stdout}\n${result.stderr}`,
		);
	}
	return result.stdout.trim();
}

/** Reproduce upstream's source preparation before applying the declaration-identity correction. */
function prepareSources(source: string): void {
	run("git", ["init", "--quiet"], source);
	run("git", ["remote", "add", "origin", "https://github.com/oxc-project/tsgolint.git"], source);
	run("git", ["fetch", "--depth=1", "origin", revision], source);
	run("git", ["checkout", "--detach", "FETCH_HEAD"], source);
	run("git", ["submodule", "update", "--init", "--depth=1"], source);
	const tsSource = join(source, "typescript-go");
	if (run("git", ["rev-parse", "HEAD"], tsSource) !== typescriptRevision) {
		throw new Error("Unexpected TypeScript submodule revision");
	}
	const upstreamPatches = readdirSync(join(source, "patches"))
		.filter((name) => name.endsWith(".patch"))
		.sort((a, b) => a.localeCompare(b, "en"));
	run(
		"git",
		[
			"-c",
			"user.name=quality-engine",
			"-c",
			"user.email=quality-engine@localhost",
			"am",
			"--no-gpg-sign",
			...upstreamPatches.map((name) => join(source, "patches", name)),
		],
		tsSource,
	);
	const collections = join(source, "internal/collections");
	mkdirSync(collections, { recursive: true });
	for (const name of readdirSync(join(tsSource, "internal/collections"))) {
		if (name.endsWith(".go") && !name.endsWith("_test.go")) {
			cpSync(join(tsSource, "internal/collections", name), join(collections, name));
		}
	}
	run("git", ["apply", "--check", patch], source);
	run("git", ["apply", patch], source);
}

function cachedEngineMatches(identity: EngineIdentity): boolean {
	if (!existsSync(manifestPath) || !existsSync(binary)) {
		return false;
	}
	const value: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	return (
		Object.entries(identity).every(([key, expected]) => Reflect.get(value, key) === expected) &&
		Reflect.get(value, "binarySha256") === digest(binary)
	);
}

/** Stage on the cache filesystem; a failed build leaves the last verified executable intact. */
function buildEngine(identity: EngineIdentity): void {
	const goVersion = run("go", ["version"], root);
	mkdirSync(cache, { recursive: true });
	const source = mkdtempSync(join(tmpdir(), "posthorse-quality-engine-"));
	const output = join(source, "tsgolint");
	try {
		prepareSources(source);
		run(
			"go",
			[
				"build",
				"-mod=readonly",
				"-p=2",
				"-buildvcs=false",
				"-ldflags=-s -w",
				"-trimpath",
				"-o",
				output,
				"./cmd/tsgolint",
			],
			source,
			{
				...process.env,
				CGO_ENABLED: "0",
				GOOS: process.platform,
				GOARCH: process.arch === "x64" ? "amd64" : "arm64",
			},
		);
		const manifest = { ...identity, goVersion, binarySha256: digest(output) };
		cpSync(output, join(cache, "tsgolint.next"));
		renameSync(join(cache, "tsgolint.next"), binary);
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		publishInstalledEngine();
		console.log(`Built corrected quality engine: ${binary}`);
	} finally {
		rmSync(source, { recursive: true, force: true });
	}
}

/** Reproducible dependency patching also corrects raw CLI and native editor lookup. */
function publishInstalledEngine(): void {
	if (!existsSync(installedBinary)) {
		throw new Error(
			"The lockfile-resolved platform tsgolint package is missing; run npm ci first.",
		);
	}
	if (digest(installedBinary) === digest(binary)) {
		return;
	}
	const staged = `${installedBinary}.next`;
	cpSync(binary, staged);
	renameSync(staged, installedBinary);
}

function setup(): void {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		console.log(
			"Usage: node scripts/setup-quality-engine.ts [--force]\nBuild the pinned declaration-corrected tsgolint (Git and Go >=1.26 required).\nExample: npm ci --ignore-scripts && npm run quality:prepare\nUse OXLINT_TSGOLINT_PATH=node_modules/.cache/pi-quality-engine/tsgolint with Oxlint.",
		);
		return;
	}
	if (args.some((arg) => arg !== "--force")) {
		throw new Error("Unknown argument. Use --help for usage.");
	}
	if (
		!["darwin", "linux"].includes(process.platform) ||
		!["arm64", "x64"].includes(process.arch)
	) {
		throw new Error(`Unsupported build host: ${process.platform}/${process.arch}`);
	}
	const identity: EngineIdentity = {
		revision,
		typescriptRevision,
		patchSha256: digest(patch),
		platform: process.platform,
		arch: process.arch,
	};
	if (!args.includes("--force") && cachedEngineMatches(identity)) {
		publishInstalledEngine();
		console.log(`Corrected quality engine ready: ${binary}`);
		return;
	}
	buildEngine(identity);
}

try {
	setup();
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
