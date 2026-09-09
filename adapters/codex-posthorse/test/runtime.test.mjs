import assert from "node:assert/strict";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeHarness, call, message, contextWindow, requestText, discoverNotes } from "./runtime-harness.mjs";

const acceptance = process.env.POSTHORSE_ACCEPTANCE === "1";
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
	if (acceptance) assert.ok(passed, detail);
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
		await recordAcceptance(t, h, "checkpoint-failure", true, "A real filesystem checkpoint failure stops rollover without removing original history.");
	});
});

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
