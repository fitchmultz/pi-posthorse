import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const version = "1.87.0";
const revision = "2bd08ebe8f36fcf1954a675ffdeb4c6d0129f609";
const patch = join(root, "patches/oxlint-import-cycles.patch");
const require = createRequire(import.meta.url);
const targets: Readonly<Record<string, string>> = {
	"darwin-arm64": "aarch64-apple-darwin",
	"darwin-x64": "x86_64-apple-darwin",
	"linux-arm64-gnu": "aarch64-unknown-linux-gnu",
	"linux-x64-gnu": "x86_64-unknown-linux-gnu",
	"linux-arm64-musl": "aarch64-unknown-linux-musl",
	"linux-x64-musl": "x86_64-unknown-linux-musl",
	"win32-arm64-msvc": "aarch64-pc-windows-msvc",
	"win32-x64-msvc": "x86_64-pc-windows-msvc",
};

function run(executable: string, args: readonly string[], cwd?: string): string {
	return execFileSync(executable, [...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
		timeout: 600_000,
	}).trim();
}

function digest(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function platformBinding(): string {
	const platform = `${process.platform}-${process.arch}`;
	if (process.platform === "win32") {
		return `${platform}-msvc`;
	}
	if (process.platform !== "linux") {
		return platform;
	}
	const report: unknown = process.report.getReport();
	const header: unknown =
		typeof report === "object" && report !== null ? Reflect.get(report, "header") : undefined;
	const glibc =
		typeof header === "object" &&
		header !== null &&
		Reflect.get(header, "glibcVersionRuntime") !== undefined;
	return `${platform}-${glibc ? "gnu" : "musl"}`;
}

function installedAddon(binding: string): string {
	const metadata: unknown = JSON.parse(
		readFileSync(require.resolve("oxlint/package.json"), "utf8"),
	);
	if (
		typeof metadata !== "object" ||
		metadata === null ||
		!("version" in metadata) ||
		metadata.version !== version
	) {
		throw new Error(
			`Native correction requires locked Oxlint ${version}; review before upgrading.`,
		);
	}
	return require.resolve(`@oxlint/binding-${binding}`);
}

function cachedAddon(cache: string): string | undefined {
	const addon = join(cache, "oxlint.node");
	const receipt = join(cache, "manifest.json");
	if (!existsSync(addon) || !existsSync(receipt)) {
		return;
	}
	const manifest: unknown = JSON.parse(readFileSync(receipt, "utf8"));
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		!("binarySha256" in manifest) ||
		manifest.binarySha256 !== digest(addon)
	) {
		throw new Error(
			`Cached native Oxlint failed checksum verification: ${cache}. Use --force to rebuild.`,
		);
	}
	return addon;
}

function toolchain(target: string): {
	readonly cargo: string;
	readonly rustc: string;
	readonly version: string;
	readonly compiler: string;
} {
	const rustVersion = run("rustc", ["--version"]);
	const minor = /^rustc 1\.(\d+)\./u.exec(rustVersion)?.[1];
	if (minor === undefined || Number(minor) < 97) {
		throw new Error("Native Oxlint requires Rust >=1.97 (qualified with 1.99.0).");
	}
	if (/^host: (.+)$/mu.exec(run("rustc", ["-vV"]))?.[1] !== target) {
		throw new Error(
			"Rust's native host target must match Node's platform, architecture and libc.",
		);
	}
	const bin = join(run("rustc", ["--print", "sysroot"]), "bin");
	const suffix = process.platform === "win32" ? ".exe" : "";
	const cargo = join(bin, `cargo${suffix}`);
	return {
		cargo,
		rustc: join(bin, `rustc${suffix}`),
		version: `${rustVersion}\n${run(cargo, ["--version"])}`,
		compiler:
			process.platform === "win32"
				? "Native MSVC linker selected by Rust"
				: run("cc", ["--version"]),
	};
}

function checkout(directory: string): void {
	run("git", ["init", "--quiet", directory]);
	run("git", ["remote", "add", "origin", "https://github.com/oxc-project/oxc.git"], directory);
	run("git", ["fetch", "--quiet", "--depth=1", "origin", revision], directory);
	run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], directory);
	if (run("git", ["rev-parse", "HEAD"], directory) !== revision) {
		throw new Error("Fetched Oxlint source does not match the immutable revision.");
	}
	run("git", ["apply", "--check", patch], directory);
	run("git", ["apply", patch], directory);
}

function libraryName(): string {
	if (process.platform === "darwin") {
		return "liboxlint.dylib";
	}
	return process.platform === "win32" ? "oxlint.dll" : "liboxlint.so";
}

function build(cache: string, target: string): string {
	const tools = toolchain(target);
	mkdirSync(cache, { recursive: true });
	const staging = mkdtempSync(join(cache, "build-"));
	try {
		const source = join(staging, "source");
		checkout(source);
		const lock = digest(join(source, "Cargo.lock"));
		const env = Object.fromEntries(
			Object.entries(process.env).filter(
				([name]) =>
					!/^CARGO_(?:PROFILE_|BUILD_|TARGET_|ENCODED_RUSTFLAGS$)/u.test(name) &&
					!/^RUST(?:FLAGS$|C_)/u.test(name) &&
					!/^(?:(?:HOST|TARGET)_)?(?:CC|CXX|AR|CFLAGS|CXXFLAGS|LDFLAGS)(?:_|$)/u.test(
						name,
					),
			),
		);
		execFileSync(
			tools.cargo,
			["build", "--locked", "--release", "-p", "oxlint", "--lib", "--features", "allocator"],
			{
				cwd: source,
				stdio: "inherit",
				timeout: 1_200_000,
				env: {
					...env,
					RUSTC: tools.rustc,
					...(process.platform === "win32" ? {} : { CC: "cc" }),
					CARGO_TARGET_DIR: join(staging, "target"),
					CARGO_BUILD_JOBS: "2",
				},
			},
		);
		if (digest(join(source, "Cargo.lock")) !== lock) {
			throw new Error("Native build changed the immutable Cargo lockfile.");
		}
		const compiled = join(staging, "target", "release", libraryName());
		const binarySha256 = digest(compiled);
		const addon = join(cache, "oxlint.node");
		renameSync(compiled, addon);
		writeFileSync(
			join(staging, "manifest.json"),
			`${JSON.stringify({ revision, patchSha256: digest(patch), target, rustVersion: tools.version, compiler: tools.compiler, cargoLockSha256: lock, binarySha256 }, null, 2)}\n`,
		);
		renameSync(join(staging, "manifest.json"), join(cache, "manifest.json"));
		return addon;
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

function install(addon: string, installed: string): void {
	if (digest(installed) === digest(addon)) {
		return;
	}
	const temporary = join(dirname(installed), `.oxlint-${randomUUID()}.node`);
	try {
		copyFileSync(addon, temporary);
		if (digest(temporary) !== digest(addon)) {
			throw new Error(
				"Native addon copy failed checksum verification; installation was not changed.",
			);
		}
		renameSync(temporary, installed);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function setup(): void {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		console.log(
			"Usage: node scripts/setup-oxlint-engine.ts [--force]\nBuild the pinned native Oxlint import-cycle correction (Git, Rust >=1.97 and a native linker required).\nExample: npm ci --ignore-scripts && npm run quality:prepare\nThe verified project cache atomically installs the NAPI addon used by raw CLI and editor/LSP. Restart existing language servers after preparation. Use --force for a fresh build. Exit 1 on preparation failure.",
		);
		return;
	}
	if (args.some((arg) => arg !== "--force")) {
		throw new Error("Unknown argument. Use --help for usage.");
	}
	const binding = platformBinding();
	if (!Object.hasOwn(targets, binding)) {
		throw new Error(`Unsupported native build host: ${binding}`);
	}
	const target = targets[binding];
	const installed = installedAddon(binding);
	const fingerprint = createHash("sha256")
		.update([revision, digest(patch), digest(import.meta.filename), binding].join("\n"))
		.digest("hex");
	const cache = join(root, "node_modules/.cache/pi-quality-engine/oxlint", fingerprint);
	const addon = args.includes("--force")
		? build(cache, target)
		: (cachedAddon(cache) ?? build(cache, target));
	install(addon, installed);
	console.log(`Corrected native Oxlint ${version} ready: ${binding}`);
}

try {
	setup();
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
