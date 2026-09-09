import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RuntimeHarness, call, message, contextWindow, requestText, discoverNotes } from "./runtime-harness.mjs";

const acceptance = process.env.POSTHORSE_ACCEPTANCE === "1";
const localRecovery = process.env.POSTHORSE_LOCAL_RECOVERY === "1";
const ownerRequest = "OWNER_REQUEST_47: preserve this instruction and finish the recovery proof.";
const unreadResult = "UNREAD_TOOL_RESULT_83";
const failedResult = "FAILED_SIBLING_RESULT_59";

async function usingRuntime(t, name, options, run) {
	const h = await RuntimeHarness.create(name, options);
	t.diagnostic(`Retained real-runtime artifacts: ${h.root}`);
	try { await h.thread(); await run(h); }
	finally { await h.close(); }
}

async function recordAcceptance(t, h, name, passed, detail) {
	await writeFile(join(h.root, "acceptance.json"), JSON.stringify({
		name, passed, detail, runtime: process.env.POSTHORSE_CODEX_BIN ?? "codex",
		threadId: h.threadId, transcript: h.transcript,
	}, null, 2) + "\n");
	if (!passed) t.diagnostic(`UNMET ACCEPTANCE: ${detail}`);
	if (acceptance || localRecovery) assert.ok(passed, detail);
}

function visibleFailure(h, turn) {
	return Boolean(turn.error?.message) || h.events.some((event) =>
		(event.method === "error" && event.params.error?.message) ||
		(event.method === "warning" && /recovery|context was not reset/i.test(event.params.message)) ||
		(event.method === "hook/completed" && ["failed", "stopped"].includes(event.params.run.status) && event.params.run.entries.some((entry) => entry.text)));
}

test("automatic rollover restores user instructions and unread output through the real notes bridge, then survives restart", async (t) => {
	await usingRuntime(t, "auto-restart", {}, async (h) => {
		const turn = await h.turn(ownerRequest, [
			{ items: [call("exec_command", { cmd: `printf '${unreadResult}\\n'`, login: false }, "unread-result")], tokens: 9_500 },
			{ items: [message("automatic rollover finished")] },
		]);
		assert.equal(turn.status, "completed");
		assert.equal(h.requests.length, 2);
		assert.ok(h.events.some((event) => event.method === "mcpServer/startupStatus/updated" && event.params.name === "notes" && event.params.status === "ready"), "real notes MCP must be connected");
		const firstWindow = contextWindow(h.requests[0]);
		const nextWindow = contextWindow(h.requests[1]);
		assert.ok(firstWindow && nextWindow);
		assert.notEqual(nextWindow, firstWindow, "native rollover must actually occur");
		assert.match(requestText(h.requests[1]), /OWNER_REQUEST_47/);
		assert.match(requestText(h.requests[1]), /UNREAD_TOOL_RESULT_83/);
		assert.ok(!h.requests[1].body.input.some((item) => item.type === "function_call_output" && item.call_id === "unread-result"), "recovery must arrive in notes, not retained active tool history");
		const transcript = await h.transcriptItems();
		assert.ok(transcript.some((entry) => entry.type === "compacted"), "rollover checkpoint must be persisted");
		assert.ok(JSON.stringify(transcript).includes(unreadResult), "original tool output remains in full history");
		const originalOutput = transcript.find((entry) => entry.type === "response_item" && entry.payload.type === "function_call_output" && entry.payload.call_id === "unread-result");
		await h.turn("Save the durable handoff note.", [
			{ items: [discoverNotes()] },
			{ items: [call("notes", { op: "write", threadId: h.threadId, path: "handoff.md", content: "DURABLE_NOTE_14: continue the existing recovery proof." }, "write-note", "mcp__notes")] },
			{ items: [message("durable note saved")] },
		]);
		assert.match(JSON.stringify(h.requests.at(-1).body.input.find((item) => item.call_id === "write-note" && item.type === "function_call_output")), /writtenChars/);
		await h.restart();
		await h.turn("Continue the same task after restarting the runtime.", [
			{ items: [discoverNotes()] },
			{ items: [
				call("notes", { op: "read", threadId: h.threadId, path: "handoff.md" }, "read-note", "mcp__notes"),
				call("history", { op: "read", threadId: h.threadId, id: `ordinal:${originalOutput.ordinal}` }, "read-original-output", "mcp__notes"),
			] },
			{ items: [message("restart recovery finished")] },
		]);
		const resumed = h.requests.at(-1);
		assert.match(requestText(resumed), /OWNER_REQUEST_47/);
		assert.match(requestText(resumed), /UNREAD_TOOL_RESULT_83/);
		assert.match(JSON.stringify(resumed.body.input.find((item) => item.call_id === "read-note" && item.type === "function_call_output")), /DURABLE_NOTE_14/);
		assert.match(JSON.stringify(resumed.body.input.find((item) => item.call_id === "read-original-output" && item.type === "function_call_output")), /UNREAD_TOOL_RESULT_83/);
		assert.equal(contextWindow(resumed), nextWindow);
		await recordAcceptance(t, h, "automatic-rollover-and-restart", true, "Native rollover and restart preserve original user instructions and unread tool output through local recovery notes.");
	});
});

test("a failed checkpoint stops automatic rollover and preserves the original transcript", async (t) => {
	await usingRuntime(t, "failed-checkpoint", { failCheckpoint: true }, async (h) => {
		const turn = await h.turn(ownerRequest, [
			{ items: [call("exec_command", { cmd: `printf '${unreadResult}\\n'`, login: false }, "unread-before-failed-write")], tokens: 9_500 },
		]);
		assert.notEqual(turn.status, "completed");
		assert.equal(h.requests.length, 1, "failed checkpoint must stop before another model request");
		const transcript = await h.transcriptItems();
		assert.equal(transcript.filter((entry) => entry.type === "compacted").length, 0);
		assert.ok(JSON.stringify(transcript).includes(ownerRequest));
		assert.ok(JSON.stringify(transcript).includes(unreadResult));
		assert.ok(visibleFailure(h, turn), "the stopped checkpoint must explain the failure to the client");
		await rename(h.state, `${h.state}-blocked-path`);
		await rename(`${h.state}-before-failure`, h.state);
		await h.restart();
		const retry = await h.turn("Retry the same task after restoring checkpoint storage.", [{ items: [message("recovered after checkpoint repair")] }]);
		assert.equal(retry.status, "completed");
		assert.match(requestText(h.requests.at(-1)), /OWNER_REQUEST_47/);
		assert.match(requestText(h.requests.at(-1)), /UNREAD_TOOL_RESULT_83/);
		assert.notEqual(contextWindow(h.requests.at(-1)), contextWindow(h.requests[0]));
		await recordAcceptance(t, h, "checkpoint-failure", true, "A real filesystem checkpoint failure stops rollover without removing original history.");
	});
});

test("stock opt-out still permits rollover after a hook process exits nonzero", async (t) => {
	await usingRuntime(t, "stock-hook-crash", { localRecovery: false, hookFailure: "nonzero" }, async (h) => {
		const turn = await h.turn(ownerRequest, [
			{ items: [call("exec_command", { cmd: `printf '${unreadResult}\\n'`, login: false }, "stock-unread-output")], tokens: 9_500 },
			{ items: [message("stock continuation")] },
		]);
		assert.equal(turn.status, "completed");
		assert.equal(h.requests.length, 2);
		assert.notEqual(contextWindow(h.requests[1]), contextWindow(h.requests[0]));
		assert.ok(h.events.some((event) => event.method === "hook/completed" && event.params.run.eventName === "preCompact" && event.params.run.status === "failed"));
		assert.match(JSON.stringify(await h.transcriptItems()), /UNREAD_TOOL_RESULT_83/);
	});
});

if (localRecovery) {
	test("an oversized pre-existing hint is rejected during initial context loading without hiding the new request", async (t) => {
		await usingRuntime(t, "initial-oversize-hint", {}, async (h) => {
			const id = randomUUID();
			const directory = join(h.state, "checkpoints", h.threadId);
			await mkdir(directory, { recursive: true });
			await mkdir(join(h.state, "threads"), { recursive: true });
			const checkpointPath = join(directory, `${id}.json`);
			const identity = { version: 1, threadId: h.threadId, rootThreadId: h.threadId, transcriptPath: h.transcript };
			await writeFile(checkpointPath, JSON.stringify({ ...identity, id, trigger: "auto", recovery: "INITIAL_OVERSIZE_MARKER_67" + "😀".repeat(9_000) }));
			await writeFile(join(h.state, "threads", `${h.threadId}.json`), JSON.stringify({ ...identity, checkpointPath }));
			const turn = await h.turn(ownerRequest, [{ items: [message("new request completed") ] }]);
			assert.equal(turn.status, "completed");
			assert.equal(h.requests.length, 1);
			assert.ok(!requestText(h.requests[0]).includes("INITIAL_OVERSIZE_MARKER_67"), "initial prompt construction must use the same bounded hint validation as rollover");
			assert.match(requestText(h.requests[0]), /OWNER_REQUEST_47/);
			assert.ok(visibleFailure(h, turn), "ignored recovery state must be explained, not silently discarded");
			assert.ok(Buffer.byteLength(await readFile(checkpointPath, "utf8")) > 32_000, "the original oversized checkpoint remains recoverable");
			assert.equal((await h.transcriptItems()).filter((entry) => entry.type === "compacted").length, 0);
		});
	});

	for (const hintFailure of ["invalid-json", "oversize"]) {
		test(`notes thread_hint ${hintFailure} after a successful checkpoint prevents reset`, async (t) => {
			await usingRuntime(t, `hint-${hintFailure}-after-checkpoint`, { hintFailure }, async (h) => {
				const turn = await h.turn(ownerRequest, [
					{ items: [call("exec_command", { cmd: `printf '${unreadResult}\\n'`, login: false }, "hint-failure-unread")], tokens: 9_500 },
				]);
				assert.notEqual(turn.status, "completed");
				assert.equal(h.requests.length, 1);
				assert.ok(visibleFailure(h, turn), "MCP recovery failure must explain why reset was stopped");
				const completedHooks = h.events.filter((event) => event.method === "hook/completed" && event.params.run.eventName === "preCompact");
				assert.equal(completedHooks.length, 1);
				assert.ok(completedHooks.every((event) => event.params.run.status === "completed"), "the checkpoint succeeded before the real MCP server encountered invalid persisted state");
				const manifest = JSON.parse(await readFile(join(h.state, "threads", `${h.threadId}.json${hintFailure === "invalid-json" ? ".before-hint-failure" : ""}`), "utf8"));
				const originalCheckpoint = manifest.checkpointPath + (hintFailure === "oversize" ? ".before-hint-failure" : "");
				assert.match(await readFile(originalCheckpoint, "utf8"), /UNREAD_TOOL_RESULT_83/, "the actual production hook wrote recovery before controlled corruption");
				const transcript = await h.transcriptItems();
				assert.equal(transcript.filter((entry) => entry.type === "compacted").length, 0);
				assert.match(JSON.stringify(transcript), /OWNER_REQUEST_47/);
				assert.match(JSON.stringify(transcript), /UNREAD_TOOL_RESULT_83/);
			});
		});
	}

	for (const hookFailure of ["missing", "disabled", "untrusted", "unmatched", "async", "nonzero", "timeout", "malformed"]) {
		test(`required recovery hook ${hookFailure} stops rollover with a visible failure and intact transcript`, async (t) => {
			await usingRuntime(t, `required-hook-${hookFailure}`, { hookFailure }, async (h) => {
				const turn = await h.turn(ownerRequest, [
					{ items: [call("exec_command", { cmd: `printf '${unreadResult}\\n'`, login: false }, "required-hook-unread")], tokens: 9_500 },
				]);
				assert.notEqual(turn.status, "completed");
				assert.equal(h.requests.length, 1, "a failed required checkpoint cannot reach a continuation request");
				assert.ok(visibleFailure(h, turn), "required-hook failure must be visible to the client");
				const transcript = await h.transcriptItems();
				assert.equal(transcript.filter((entry) => entry.type === "compacted").length, 0);
				assert.match(JSON.stringify(transcript), /OWNER_REQUEST_47/);
				assert.match(JSON.stringify(transcript), /UNREAD_TOOL_RESULT_83/);
				await recordAcceptance(t, h, `required-hook-${hookFailure}`, true, "Required recovery did not complete, so the window stayed intact and the client received a failure.");
			});
		});
	}

	for (const failureFirst of [true, false]) {
		test(`failed sibling finishing ${failureFirst ? "before" : "after"} new_context cancels only that tool batch`, async (t) => {
			await usingRuntime(t, `failure-${failureFirst ? "before" : "after"}-reset`, { recordToolCompletions: true }, async (h) => {
				const failure = call("exec_command", { cmd: "printf 'ORDERED_FAILURE_31\\n' >&2; exit 7", login: false }, "ordered-failure");
				const reset = call("new_context", {}, "ordered-reset");
				await h.turn(ownerRequest, [
					{ items: failureFirst ? [failure, reset] : [reset, failure], betweenItemsMs: 250 },
					{ items: [message("handled the failed batch; start a fresh window now"), call("new_context", {}, "valid-later-reset")] },
					{ items: [message("later valid reset completed")] },
				]);
				assert.equal(h.requests.length, 3);
				assert.equal(contextWindow(h.requests[1]), contextWindow(h.requests[0]));
				const completions = (await readFile(join(h.root, "hook-fixture.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
				assert.deepEqual(completions.map((entry) => entry.tool_use_id), [...(failureFirst ? ["ordered-failure", "ordered-reset"] : ["ordered-reset", "ordered-failure"]), "valid-later-reset"], "PostToolUse timestamps prove actual completion order; transcript outputs alone are written later in call order");
				assert.notEqual(contextWindow(h.requests[2]), contextWindow(h.requests[0]), "a handled failure must not poison a later successful tool batch within the same turn");
				assert.equal((await h.transcriptItems()).filter((entry) => entry.type === "compacted").length, 1);
			});
		});
	}

	test("a canceled explicit reset at the automatic threshold shows the failure before a later reset", async (t) => {
		await usingRuntime(t, "threshold-failed-explicit", {}, async (h) => {
			await h.turn(ownerRequest, [
				{ items: [call("new_context", {}, "threshold-reset"), call("exec_command", { cmd: "printf 'THRESHOLD_FAILURE_19\\n' >&2; exit 7", login: false }, "threshold-failure")], tokens: 9_500 },
				{ items: [message("acknowledged the failure before another rollover")] },
			]);
			assert.equal(contextWindow(h.requests[1]), contextWindow(h.requests[0]), "automatic compaction must not silently commit the just-canceled reset before the model sees the failed batch");
			assert.match(requestText(h.requests[1]), /THRESHOLD_FAILURE_19/);
			assert.ok(h.requests[1].body.input.some((item) => item.type === "function_call_output" && item.call_id === "threshold-failure"), "the failed batch remains active for the immediate continuation");
		});
	});

	test("a caught nested MCP failure cancels the advertised code-mode reset without poisoning a later retry", async (t) => {
		await usingRuntime(t, "code-mode-caught-failure", { codeMode: true }, async (h) => {
			const nested = [
				'if (!ALL_TOOLS.some(tool => tool.name === "new_context")) throw new Error("new_context is missing from advertised nested tools");',
				'const results = await Promise.allSettled([tools.new_context({}), (async () => {',
				`const result = await tools.mcp__notes__notes({op:"read",threadId:${JSON.stringify(h.threadId)},path:"nested-missing-note.md"});`,
				'if (result.isError) throw new Error("actual nested MCP failure");',
				'})()]);',
				'if (results[1].status === "rejected") text("NESTED_FAILURE_CAUGHT_71");',
			].join("\n");
			const turn = await h.turn(ownerRequest, [
				{ items: [{ type: "custom_tool_call", name: "exec", namespace: "functions", call_id: "nested-caught-batch", input: nested }] },
				{ items: [message("handled the nested failure")] },
			]);
			assert.equal(turn.status, "completed");
			assert.equal(h.requests.length, 2);
			assert.match(requestText(h.requests[1]), /NESTED_FAILURE_CAUGHT_71/);
			assert.ok(h.events.some((event) => event.method === "item/completed" && event.params.item.type === "mcpToolCall" && event.params.item.status === "failed"));
			assert.equal(contextWindow(h.requests[1]), contextWindow(h.requests[0]));
			assert.equal((await h.transcriptItems()).filter((entry) => entry.type === "compacted").length, 0);
			await h.turn("The nested failure is handled. Reset through the exposed code-mode tool now.", [
				{ items: [{ type: "custom_tool_call", name: "exec", namespace: "functions", call_id: "nested-valid-reset", input: "text(await tools.new_context({}));" }] },
				{ items: [message("valid nested reset completed")] },
			]);
			assert.notEqual(contextWindow(h.requests.at(-1)), contextWindow(h.requests[0]));
			assert.equal((await h.transcriptItems()).filter((entry) => entry.type === "compacted").length, 1);
		});
	});

	test("a caught malformed nested invocation cannot commit a requested reset", async (t) => {
		await usingRuntime(t, "caught-invalid-nested-argument", { codeMode: true }, async (h) => {
			await h.turn(ownerRequest, [
				{ items: [{ type: "custom_tool_call", name: "exec", namespace: "functions", call_id: "invalid-argument-cell", input: 'await tools.new_context({}); try { await tools.exec_command("bad argument type"); } catch (error) { text("CAUGHT_INVALID_ARGUMENT_93"); }' }] },
				{ items: [message("handled the rejected invocation")] },
			]);
			assert.equal(h.requests.length, 2);
			assert.match(requestText(h.requests[1]), /CAUGHT_INVALID_ARGUMENT_93/);
			assert.equal(contextWindow(h.requests[1]), contextWindow(h.requests[0]));
			assert.equal((await h.transcriptItems()).filter((entry) => entry.type === "compacted").length, 0);
		});
	});
}

test("manual compaction: compare ordinary summary behavior with local token-budget mode", async (t) => {
	let ordinarySummaryRequests;
	await usingRuntime(t, "manual-ordinary", { tokenBudget: false }, async (h) => {
		await h.turn(ownerRequest, [{ items: [message("work before manual compaction")] }]);
		const before = h.requests.length;
		await h.compact([{ items: [message("MANUAL_SUMMARY_21: preserve the original user request.")] }]);
		ordinarySummaryRequests = h.requests.length - before;
		assert.equal(ordinarySummaryRequests, 1, "ordinary manual compaction must use the model summarizer");
		assert.ok(JSON.stringify(await h.transcriptItems()).includes("MANUAL_SUMMARY_21"));
	});
	await usingRuntime(t, "manual-token-budget", {}, async (h) => {
		await h.turn(ownerRequest, [{ items: [message("work before manual compaction")] }]);
		const initialWindow = contextWindow(h.requests[0]);
		const before = h.requests.length;
		await h.compact([{ items: [message("MANUAL_SUMMARY_21: preserve the original user request.")] }]);
		const summaryRequests = h.requests.length - before;
		// Remove a reply that stock token-budget mode never consumes, before inspecting the next turn.
		if (!summaryRequests) h.replies.shift();
		await h.turn("Continue after manual compaction.", [{ items: [message("continued")] }]);
		assert.ok(summaryRequests === ordinarySummaryRequests || contextWindow(h.requests.at(-1)) !== initialWindow, "runtime must either summarize or install a fresh window");
		await h.transcriptItems();
		await recordAcceptance(t, h, "manual-summary-parity", summaryRequests === ordinarySummaryRequests,
			`Manual /compact made ${summaryRequests} summary requests in token-budget mode versus ${ordinarySummaryRequests} normally. Posthorse requires ordinary manual summarization.`);
	});
});

test("explicit new_context with a failing command preserves recovery text but must not commit the window", async (t) => {
	await usingRuntime(t, "explicit-failing-sibling", {}, async (h) => {
		const turn = await h.turn(ownerRequest, [
			{ items: [call("new_context", {}, "explicit-rollover"), call("exec_command", {
				cmd: `printf '${failedResult}\\n' >&2; exit 7`, login: false,
			}, "failed-sibling")] },
			{ items: [message("continued after tool batch")] },
		]);
		assert.equal(turn.status, "completed");
		assert.equal(h.requests.length, 2);
		const transcript = await h.transcriptItems();
		assert.ok(JSON.stringify(transcript).includes(ownerRequest), "user request remains recoverable in original transcript");
		assert.ok(JSON.stringify(transcript).includes(failedResult), "failed tool output remains recoverable in original transcript");
		const continuation = requestText(h.requests[1]);
		assert.ok(continuation.includes("OWNER_REQUEST_47") && continuation.includes(failedResult), "the local hook must preserve recovery text even if native batch cancellation is unsupported");
		const unchanged = contextWindow(h.requests[1]) === contextWindow(h.requests[0]);
		await recordAcceptance(t, h, "explicit-failing-command", unchanged,
			`A command exited 7 beside new_context. Window unchanged: ${unchanged}. Posthorse must cancel the pending rollover when a sibling fails.`);
	});
});

test("explicit new_context with an actual MCP isError sibling records whether the window is canceled", async (t) => {
	await usingRuntime(t, "explicit-mcp-error", {}, async (h) => {
		await h.turn(ownerRequest, [
			{ items: [discoverNotes()] },
			{ items: [call("new_context", {}, "explicit-rollover"), call("notes", {
				op: "read", threadId: h.threadId, path: "missing-note-for-error-proof.md",
			}, "failed-mcp-sibling", "mcp__notes")] },
			{ items: [message("continued after failed MCP batch")] },
		]);
		assert.equal(h.requests.length, 3);
		const transcript = await h.transcriptItems();
		const failed = transcript.find((entry) => entry.type === "response_item" && entry.payload.type === "function_call_output" && entry.payload.call_id === "failed-mcp-sibling");
		assert.ok(failed, "real failing MCP output must be persisted");
		assert.match(JSON.stringify(failed), /ENOENT/);
		assert.ok(h.events.some((event) => event.method === "item/completed" && event.params.item.type === "mcpToolCall" && event.params.item.status === "failed"), "Codex must classify the real MCP tool call as failed");
		const unchanged = contextWindow(h.requests[2]) === contextWindow(h.requests[1]);
		await recordAcceptance(t, h, "explicit-mcp-error", unchanged,
			`MCP notes.read returned isError for a missing note beside new_context. Window unchanged: ${unchanged}; persisted compacted records: ${transcript.filter((entry) => entry.type === "compacted").length}.`);
	});
});
