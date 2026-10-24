import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Check } from "typebox/value";
import { registerHistory } from "../src/history.ts";
import { PageReservations } from "../src/paging.ts";
import { loadFixture, requireValue } from "./harness.ts";
import { fixtureResult } from "./results.ts";

async function historyAt(dir: string) {
	const { extension } = await loadFixture((pi) => {
		registerHistory(
			pi,
			() => ({
				getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384 }),
				getContextUsage: () => ({ tokens: 1000, contextWindow: 100_000, percent: 1 }),
				getSystemPrompt: () => "Synthetic archive test",
			}),
			new PageReservations(() => 0),
		);
	});
	const { definition } = requireValue(extension.tools.get("history"));
	const context = {
		cwd: dir,
		sessionManager: {
			getSessionDir: () => dir,
			getSessionFile: () => join(dir, "synthetic.jsonl"),
			getBranch: () => [],
			buildSessionProjection: () => ({ entries: [] }),
		},
	};
	return async (
		params: Readonly<Record<string, unknown>>,
		signal = new AbortController().signal,
	) => {
		assert.ok(Check(definition.parameters, params));
		const value: unknown = await Reflect.apply(definition.execute.bind(definition), undefined, [
			"archive-test",
			params,
			signal,
			() => {
				// The registered history executor does not stream updates.
			},
			context,
		]);
		return fixtureResult(value);
	};
}
function text(result: {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}
function header(dir: string): string {
	return (
		JSON.stringify({
			type: "session",
			version: 3,
			id: "synthetic",
			timestamp: "2026-10-24T00:00:00Z",
			cwd: dir,
		}) + "\n"
	);
}
function message(id: string, content: unknown, parentId: string | null = null): string {
	return JSON.stringify({ type: "message", id, parentId, message: { role: "user", content } });
}

test("archive search and later reads pass a nonmatching image beyond V8's string limit", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "posthorse-giant-archive-"));
	t.diagnostic(`generated public archive: ${dir}`);
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = openSync(join(dir, "synthetic.jsonl"), "wx");
	try {
		writeSync(file, header(dir));
		writeSync(
			file,
			JSON.stringify({
				type: "context_window",
				id: "window",
				parentId: null,
				handoff: "new window",
			}) + "\n",
		);
		writeSync(
			file,
			'{"type":"message","id":"large001","parentId":"window","message":{"role":"toolResult","toolCallId":"fake","toolName":"read","content":[{"type":"image","mimeType":"image/png","data":"',
		);
		const chunk = Buffer.alloc(1024 * 1024, 65);
		for (let i = 0; i < 513; i++) {
			writeSync(file, chunk);
		}
		writeSync(file, '"}]}}\n');
		writeSync(file, message("older", "small marker older", "large001") + "\n");
		writeSync(
			file,
			message(
				"newer",
				[
					{ type: "text", text: "small marker newer" },
					{ type: "image", mimeType: "image/png", data: "AA==" },
				],
				"older",
			) + "\n",
		);
	} finally {
		closeSync(file);
	}
	const history = await historyAt(dir);
	const first = text(await history({ op: "search", all: true, query: "small marker", limit: 1 }));
	assert.match(first, /\[window window\] \[newer@[^\]]+\] \[user\] small marker newer/);
	const cursor = requireValue(first.match(/continue with cursor "([^"]+)"/)?.[1]);
	const next = text(
		await history({ op: "search", all: true, query: "small marker", limit: 1, cursor }),
	);
	assert.match(next, /\[window window\] \[older@[^\]]+\] \[user\] small marker older/);
	assert.doesNotMatch(next, /continue with cursor/);
	const id = requireValue(first.match(/\[(newer@[^\]]+)\]/)?.[1]);
	const read = await history({ op: "read", id });
	assert.match(text(read), /\[user\] small marker newer/);
	assert.deepEqual(
		read.content.filter((part) => part.type === "image"),
		[{ type: "image", mimeType: "image/png", data: "AA==" }],
	);
});

test("archive prefilter keeps boundary-spanning text and Unicode folds", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "posthorse-boundary-archive-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = openSync(join(dir, "synthetic.jsonl"), "wx");
	const cases = [
		["ascii", "small marker", "SMALL MARKER"],
		["unicode", "éclair 🐴", "ÉCLAIR 🐴"],
		["astral", "🐴 beacon", "🐴 BEACON"],
		["kelvin", "kelvin", "KELVIN"],
		["longs", "ſail", "ſAIL"],
		["dotted", "i\u0307stanbul", "İSTANBUL"],
		["escaped", 'say "needle"', 'say "needle"'],
	] as const;
	try {
		let position = writeSync(file, header(dir) + "malformed line\n");
		for (const [id, _query, value] of cases) {
			const prefix = `{"type":"message","id":"${id}","parentId":null,"message":{"role":"user","content":"`;
			position += writeSync(file, prefix);
			const padding =
				(1024 * 1024 - 1 - (position % (1024 * 1024)) + 1024 * 1024) % (1024 * 1024);
			position += writeSync(file, Buffer.alloc(padding, 32));
			position += writeSync(
				file,
				JSON.stringify(value).slice(1, -1) + '"}}' + (id === "escaped" ? "" : "\n"),
			);
		}
	} finally {
		closeSync(file);
	}
	const history = await historyAt(dir);
	for (const [id, query] of cases) {
		// Each query reopens the same generated archive; avoid concurrent scans of this fixture.
		// oxlint-disable-next-line no-await-in-loop
		const output = text(await history({ op: "search", all: true, query }));
		assert.match(output, new RegExp(`\\[${id}@[^\\]]+\\]`));
	}
	const controller = new AbortController();
	const reason = new Error("cancel archive scan");
	controller.abort(reason);
	await assert.rejects(
		history({ op: "search", all: true, query: "small marker" }, controller.signal),
		(error: unknown) => error === reason,
	);
});
