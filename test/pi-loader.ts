import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Runtime imports and the compiler must resolve the same installed SDK/types graph.
const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const packageDir = fileURLToPath(new URL("..", entry));
const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8"));
assert.ok(typeof manifest === "object" && manifest !== null && "version" in manifest);
const { version } = manifest;
assert.equal(typeof version, "string");
const { PI_HOST_INDEX, PI_COMPAT_EXPECTED_PACKAGE_DIR, PI_COMPAT_EXPECTED_VERSION } = process.env;
if (PI_HOST_INDEX !== undefined && PI_HOST_INDEX !== "") {
	assert.equal(
		realpathSync(PI_HOST_INDEX),
		realpathSync(fileURLToPath(entry)),
		"PI_HOST_INDEX must select the installed SDK/types graph",
	);
}
if (PI_COMPAT_EXPECTED_PACKAGE_DIR !== undefined && PI_COMPAT_EXPECTED_PACKAGE_DIR !== "") {
	assert.equal(realpathSync(packageDir), realpathSync(PI_COMPAT_EXPECTED_PACKAGE_DIR));
}
if (PI_COMPAT_EXPECTED_VERSION !== undefined && PI_COMPAT_EXPECTED_VERSION !== "") {
	assert.equal(version, PI_COMPAT_EXPECTED_VERSION);
}
console.log(
	JSON.stringify({
		host: process.env.PI_COMPAT_HOST ?? "local",
		version,
		sdk: entry,
		packageDir,
	}),
);
