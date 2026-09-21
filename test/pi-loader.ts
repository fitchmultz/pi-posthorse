import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Use the selected graph's public SDK, not the old 0.85.0 bundle workaround.
// Runtime imports and tsc must resolve the same installed package.
const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const packageDir = fileURLToPath(new URL("..", entry));
const { version } = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8"));
if (process.env.PI_HOST_INDEX) {
	assert.equal(realpathSync(process.env.PI_HOST_INDEX), realpathSync(fileURLToPath(entry)), "PI_HOST_INDEX must select the installed SDK/types graph");
}
if (process.env.PI_COMPAT_EXPECTED_PACKAGE_DIR) {
	assert.equal(realpathSync(packageDir), realpathSync(process.env.PI_COMPAT_EXPECTED_PACKAGE_DIR));
}
if (process.env.PI_COMPAT_EXPECTED_VERSION) assert.equal(version, process.env.PI_COMPAT_EXPECTED_VERSION);
console.log(JSON.stringify({ host: process.env.PI_COMPAT_HOST ?? "local", version, sdk: entry, packageDir }));
