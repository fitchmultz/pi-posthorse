import { spawn } from "node:child_process";
import { join } from "node:path";

// The Rust and Go corrections are independent, so a cold preparation waits only for the slower build.
const exits = await Promise.all(
	["setup-oxlint-engine.ts", "setup-quality-engine.ts"].map(
		(script) =>
			new Promise<number | null>((resolve, reject) => {
				spawn(process.execPath, [join(import.meta.dirname, script)], { stdio: "inherit" })
					.on("error", reject)
					.on("close", resolve);
			}),
	),
);
if (exits.some((code) => code !== 0)) {
	process.exitCode = 1;
}
