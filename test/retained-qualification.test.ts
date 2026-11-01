import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import { repository, runCli } from "./quality-support.ts";

nodeTest("release qualification must cover the retained package and selected host", async () => {
	const root = mkdtempSync(join(tmpdir(), "posthorse-retained-"));
	const candidatePath = join(root, "release.json");
	const reportPath = join(root, "qualification.json");
	const host = {
		version: "1.4.0",
		indexSha256: "index",
		cliSha256: "cli",
		runtimeLockSha256: "lock",
		runtimeGraphSha256: "graph",
	};
	const candidate = {
		source: "reviewed-source",
		name: "pi-posthorse",
		version: "0.10.1",
		sha256: "retained-package",
		hosts: { official: host },
	};
	const report = {
		result: "passed",
		source: "reviewed-source",
		sourceDirty: false,
		flavor: "official",
		package: { name: "pi-posthorse", version: "0.10.1", sha256: "retained-package" },
		host,
	};
	try {
		writeFileSync(candidatePath, JSON.stringify(candidate));
		const run = async (value: unknown) => {
			writeFileSync(reportPath, JSON.stringify(value));
			return runCli(
				process.execPath,
				[
					join(repository, "scripts/verify-retained-qualification.ts"),
					candidatePath,
					reportPath,
					"official",
				],
				root,
			);
		};
		const matching = await run(report);
		assert.equal(matching.status, 0, matching.stderr);
		const mismatches = [
			[
				await run({
					...report,
					package: { ...report.package, sha256: "different-package" },
				}),
				/Qualified package differs: sha256/u,
			],
			[
				await run({
					...report,
					host: { ...report.host, runtimeGraphSha256: "different-host" },
				}),
				/Qualified host differs: runtimeGraphSha256/u,
			],
			[
				await run({ ...report, source: "different-source" }),
				/Host qualification used a different source/u,
			],
		] as const;
		for (const [result, message] of mismatches) {
			assert.equal(result.status, 1);
			assert.match(result.stderr, message);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
