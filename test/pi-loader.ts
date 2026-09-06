import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

// Pi 0.85.0's unbundled entry imports an undeclared pi-server package. Test its
// shipped native bundle; remove this workaround when updating the pinned SDK.
const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
const { version } = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8"));
if (version !== "0.85.0") throw new Error("Recheck Pi's native test entry before updating the SDK baseline.");
registerHooks({
	resolve(specifier, context, nextResolve) {
		const resolved = nextResolve(specifier, context);
		return resolved.url === entry ? { ...resolved, url: new URL("bundle/index.js", entry).href } : resolved;
	},
});
