import { spawnSync } from "node:child_process";

const npm = process.env.npm_execpath;
const gates = process.argv.slice(2);
if (npm === undefined || npm === "" || gates.length === 0) {
	throw new Error("Run acceptance through an npm script with at least one required gate.");
}

// A failed independent check must not prevent the compiler, tests or other gates from running.
for (const gate of gates) {
	console.log(`\n--- Gate: ${gate} ---`);
	const result = spawnSync(process.execPath, [npm, "run", gate], { stdio: "inherit" });
	if (result.error !== undefined) {
		console.error(result.error);
	}
	console.log(
		`Gate ${gate}: ${result.status === null ? (result.signal ?? "spawn failed") : `exit ${result.status}`}`,
	);
	if (result.status !== 0 || result.error !== undefined) {
		process.exitCode = 1;
	}
}
