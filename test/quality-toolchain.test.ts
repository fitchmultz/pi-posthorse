import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { objectValue, readObject } from "../scripts/quality-policy.ts";
import { repository, runCli } from "./quality-support.ts";

test("the actual verify command rejects a different invoking npm before running lint", async () => {
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
					lint: `node -e "require('node:fs').writeFileSync('lint-ran', 'yes')"`,
				},
			}),
		);
		symlinkSync(join(repository, "scripts"), join(root, "scripts"), "junction");
		const result = await runCli("npm", ["run", "verify"], root);
		assert.equal(result.signal, null);
		assert.equal(existsSync(join(root, "lint-ran")), false);
		assert.equal(result.status, 1);
		assert.match(
			result.stderr,
			/Toolchain policy: package\.json packageManager requires npm@0\.0\.0, but the invoking CLI is npm@\d+\.\d+\.\d+/u,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("verification cannot substitute a PATH guess when invoking npm provenance is missing", () => {
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
});
