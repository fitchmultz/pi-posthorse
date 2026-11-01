import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import { fileURLToPath } from "node:url";
import { objectValue, readObject } from "../scripts/quality-settings.ts";
import { repository, runCli } from "./quality-support.ts";

nodeTest(
	"the actual verify command rejects a different invoking npm before any child gate",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "posthorse-toolchain-"));
		try {
			const pkg = readObject(join(repository, "package.json"));
			assert.ok(objectValue(pkg.scripts));
			writeFileSync(
				join(root, "package.json"),
				JSON.stringify({
					...pkg,
					packageManager: "npm@0.0.0",
					scripts: {
						...pkg.scripts,
						"quality:policy": `node -e "require('node:fs').writeFileSync('child-ran', 'yes')"`,
					},
				}),
			);
			symlinkSync(join(repository, "scripts"), join(root, "scripts"), "junction");
			const result = await runCli("npm", ["run", "verify"], root);
			assert.equal(result.signal, null);
			assert.equal(existsSync(join(root, "child-ran")), false);
			assert.equal(result.status, 1);
			assert.match(
				result.stderr,
				/Toolchain policy: package\.json packageManager requires npm@0\.0\.0, but the invoking CLI is npm@\d+\.\d+\.\d+/u,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

nodeTest(
	"QX-010 loader accepts the installed graph and rejects a foreign SDK before execution",
	() => {
		const root = mkdtempSync(join(tmpdir(), "posthorse-sdk-identity-"));
		const installed = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
		const foreign = join(root, "foreign.js");
		writeFileSync(foreign, "export const foreign = true;\n");
		try {
			for (const path of [installed, foreign]) {
				const result = spawnSync(
					process.execPath,
					["--import", join(repository, "test/pi-loader.ts"), "--eval", ""],
					{ encoding: "utf8", env: { ...process.env, PI_HOST_INDEX: path } },
				);
				assert.equal(result.signal, null);
				assert.equal(result.status, path === installed ? 0 : 1);
				if (path === installed) {
					assert.equal(result.stderr, "");
					assert.ok(result.stdout.includes('"sdk":'), result.stdout);
				} else {
					assert.match(
						result.stderr,
						/PI_HOST_INDEX must select the installed SDK\/types graph/u,
					);
				}
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);

nodeTest(
	"verification cannot substitute a PATH guess when invoking npm provenance is missing",
	() => {
		const result = spawnSync(
			process.execPath,
			[join(repository, "scripts/toolchain-policy.ts"), repository],
			{ encoding: "utf8", env: { ...process.env, npm_execpath: "" } },
		);
		assert.equal(result.signal, null);
		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			/npm provenance is missing; invoke acceptance with npm run verify/u,
		);
	},
);
