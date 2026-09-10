import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeHarness, call, message, requestText, discoverNotes } from "./runtime-harness.mjs";

const owner = "StockHooksOwner47: preserve my exact request and the unread result through ordinary compaction.";
const unread = "STOCK_UNREAD_RESULT_83";
const lossy = "LOSSY_SUMMARY_21: Continue the existing task. Original request and tool-result markers are deliberately omitted.";

async function usingRuntime(t, name, options, run) {
	const h = await RuntimeHarness.create(`stock-hooks-${name}`, { tokenBudget: false, localRecovery: false, stockRecovery: true, ...options });
	t.diagnostic(`Retained real-runtime artifacts: ${h.root}`);
	try {
		assert.match(h.config, /context_management = false/);
		assert.match(h.config, /\[features.token_budget\]\nenabled = false/);
		assert.doesNotMatch(h.config, /local_recovery_hook/);
		const account = await h.rpc("account/read", {});
		assert.equal(account.requiresOpenaiAuth, false);
		await h.thread();
		await run(h);
	} finally { await h.close(); }
}

async function receipt(h, name, facts) {
	await writeFile(join(h.root, "acceptance.json"), JSON.stringify({
		name, passed: true, runtime: process.env.POSTHORSE_CODEX_BIN ?? "codex",
		threadId: h.threadId, transcript: h.transcript, ...facts,
	}, null, 2) + "\n");
}

function automaticReplies({ codeMode = false, marker = unread, callId = "unread-shell", summary = lossy } = {}) {
	const args = { cmd: `printf '${marker}\\n'`, login: false };
	return [
		{ items: [codeMode ? { type: "custom_tool_call", name: "exec", namespace: "functions", call_id: callId, input: `text(await tools.exec_command(${JSON.stringify(args)}));` } : call("exec_command", args, callId)], tokens: 9500 },
		{ items: [message(summary)] },
		{ items: [message("ordinary recovery complete")] },
	];
}

function sourceContext(request, source) {
	return request.body.input.filter((item) => item.type === "message" && item.role === "developer" && JSON.stringify(item).includes(`source=${source}`));
}

function assertRecovery(h, requestIndex, source, markers) {
	const request = h.requests[requestIndex];
	const context = sourceContext(request, source);
	assert.equal(context.length, 1, `one ${source} hook must supply recovery before the next model request`);
	for (const marker of markers) assert.ok(JSON.stringify(context).includes(marker), `${source} recovery must include ${marker}`);
	const hook = h.events.findLast((event) => event.method === "hook/completed" && event.params.run.eventName === "sessionStart" && event.recordedAt <= request.recordedAt && event.params.run.entries.some((entry) => entry.kind === "context" && entry.text.includes(`source=${source}`)));
	assert.ok(hook, "the real runtime must report the recovery hook output");
	assert.equal(hook.params.run.status, "completed");
	for (const marker of markers) assert.ok(JSON.stringify(hook.params.run.entries).includes(marker));
	return hook;
}

async function savedCheckpoint(h) {
	const manifest = JSON.parse(await readFile(join(h.state, "threads", `${h.threadId}.json`), "utf8"));
	return { path: manifest.checkpointPath, ...JSON.parse(await readFile(manifest.checkpointPath, "utf8")) };
}

for (const codeMode of [false, true]) {
	test(`ordinary compaction restores unread output, survives restart, and preserves manual summaries (code mode ${codeMode})`, async (t) => {
		await usingRuntime(t, `auto-restart-manual-${codeMode}`, { codeMode }, async (h) => {
			const turn = await h.turn(owner, automaticReplies({ codeMode }));
			assert.equal(turn.status, "completed");
			assert.equal(h.requests.length, 3, "normal request, real summarization, then immediate continuation");
			assert.match(requestText(h.requests[1]), /StockHooksOwner47/);
			assert.match(requestText(h.requests[1]), /STOCK_UNREAD_RESULT_83/);
			assert.match(requestText(h.requests[2]), /LOSSY_SUMMARY_21/);
			assert.ok(!h.requests[2].body.input.some((item) => ["function_call_output", "custom_tool_call_output"].includes(item.type) && item.call_id === "unread-shell"));
			const hook = assertRecovery(h, 2, "compact", ["StockHooksOwner47", unread]);
			assert.ok(hook.recordedAt >= h.requests[1].recordedAt, "recovery hook runs after summarization begins");
			const checkpoint = await savedCheckpoint(h);
			assert.ok(Date.parse(checkpoint.createdAt) <= h.requests[2].recordedAt);
			assert.match(checkpoint.recovery, /StockHooksOwner47/);
			assert.match(checkpoint.recovery, /STOCK_UNREAD_RESULT_83/);
			const checkpointDir = join(h.state, "checkpoints", h.threadId);
			const checkpoints = await Promise.all((await readdir(checkpointDir)).map(async (name) => JSON.parse(await readFile(join(checkpointDir, name), "utf8"))));
			assert.ok(checkpoints.some((entry) => Date.parse(entry.createdAt) <= h.requests[1].recordedAt && entry.recovery.includes(unread)), "PreCompact preserves originals before the summary request");
			const transcript = await h.transcriptItems();
			const compactions = transcript.filter((row) => row.type === "compacted");
			assert.equal(compactions.length, 1);
			assert.match(compactions[0].payload.message, /LOSSY_SUMMARY_21/);
			assert.doesNotMatch(compactions[0].payload.message, /StockHooksOwner47|STOCK_UNREAD_RESULT_83/);
			const originalIndex = transcript.findIndex((row) => row.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(row.payload.type) && row.payload.call_id === "unread-shell");
			assert.ok(originalIndex >= 0);
			const original = transcript[originalIndex];
			const originalId = Number.isSafeInteger(original.ordinal) ? `ordinal:${original.ordinal}` : `line:${originalIndex + 1}`;
			await h.turn("Save the durable handoff note.", [
				{ items: [discoverNotes()] },
				{ items: [call("notes", { op: "write", threadId: h.threadId, path: "handoff.md", content: "STOCK_DURABLE_NOTE_14: continue the ordinary compaction proof." }, "write-note", "mcp__notes")] },
				{ items: [message("note saved")] },
			]);
			assert.match(JSON.stringify(h.requests.at(-1).body.input.find((item) => item.call_id === "write-note" && item.type === "function_call_output")), /writtenChars/);
			const launches = h.launches;
			await h.restart();
			const resumeFrom = h.requests.length;
			await h.turn("Continue after the full app-server restart.", [
				{ items: [discoverNotes()] },
				{ items: [
					call("notes", { op: "read", threadId: h.threadId, path: "handoff.md" }, "read-note", "mcp__notes"),
					call("history", { op: "read", threadId: h.threadId, id: originalId }, "read-original", "mcp__notes"),
				] },
				{ items: [message("restart proof complete")] },
			]);
			assert.equal(h.launches, launches + 1);
			assertRecovery(h, resumeFrom, "resume", ["StockHooksOwner47", unread]);
			const finalInput = h.requests.at(-1).body.input;
			assert.match(JSON.stringify(finalInput.find((item) => item.call_id === "read-note" && item.type === "function_call_output")), /STOCK_DURABLE_NOTE_14/);
			assert.match(JSON.stringify(finalInput.find((item) => item.call_id === "read-original" && item.type === "function_call_output")), /STOCK_UNREAD_RESULT_83/);
			const manualFrom = h.requests.length;
			await h.compact([{ items: [message("MANUAL_STOCK_SUMMARY_61: the same work continues.")] }]);
			assert.equal(h.requests.length, manualFrom + 1, "manual compaction summarizes exactly once");
			const manualRows = (await h.transcriptItems()).filter((row) => row.type === "compacted");
			assert.equal(manualRows.length, 2);
			assert.match(manualRows[1].payload.message, /MANUAL_STOCK_SUMMARY_61/);
			await h.turn("Continue after manual compaction.", [{ items: [message("manual continuation finished")] }]);
			assert.match(requestText(h.requests.at(-1)), /MANUAL_STOCK_SUMMARY_61/);
			assertRecovery(h, h.requests.length - 1, "compact", ["StockHooksOwner47"]);
			await receipt(h, "ordinary-automatic-restart-manual", { codeMode, automaticCompactions: 1, fullAppServerRestart: true, durableNoteRead: true, originalToolHistoryRead: true, manualCompactions: 1 });
		});
	});
}

test("handled checkpoint write failure stops before ordinary summarization and retains originals", async (t) => {
	await usingRuntime(t, "handled-write-failure", { failCheckpoint: true }, async (h) => {
		await h.turn(owner, [automaticReplies()[0]]);
		assert.equal(h.requests.length, 1);
		const transcript = await h.transcriptItems();
		assert.equal(transcript.filter((row) => row.type === "compacted").length, 0);
		assert.match(JSON.stringify(transcript), /StockHooksOwner47/);
		assert.match(JSON.stringify(transcript), /STOCK_UNREAD_RESULT_83/);
		const stoppedHook = h.events.find((event) => event.method === "hook/completed" && event.params.run.eventName === "preCompact" && event.params.run.status === "stopped");
		assert.ok(stoppedHook, "continue:false must be visible as a stopped hook");
		assert.match(JSON.stringify(stoppedHook), /could not save recovery state/);
		await receipt(h, "handled-checkpoint-write-failure", { modelRequests: 1, compactions: 0, originalsPreserved: true });
	});
});

for (const hookFailure of ["nonzero", "disabled", "malformed", "timeout"]) {
	test(`ordinary recovery reconstructs originals after a ${hookFailure} PreCompact hook`, async (t) => {
		await usingRuntime(t, `recover-${hookFailure}`, { hookFailure }, async (h) => {
			const turn = await h.turn(owner, automaticReplies());
			assert.equal(turn.status, "completed");
			assert.equal(h.requests.length, 3);
			assertRecovery(h, 2, "compact", ["StockHooksOwner47", unread]);
			const checkpoint = await savedCheckpoint(h);
			assert.ok(Date.parse(checkpoint.createdAt) >= h.requests[1].recordedAt, "replacement checkpoint is made after the summary request");
			assert.ok(Date.parse(checkpoint.createdAt) <= h.requests[2].recordedAt);
			assert.match(checkpoint.recovery, /STOCK_UNREAD_RESULT_83/);
			const transcript = await h.transcriptItems();
			assert.equal(transcript.filter((row) => row.type === "compacted").length, 1);
			assert.match(JSON.stringify(transcript), /STOCK_UNREAD_RESULT_83/);
			const precompact = h.events.filter((event) => event.method === "hook/completed" && event.params.run.eventName === "preCompact");
			if (hookFailure === "disabled") assert.equal(precompact.length, 0);
			else assert.ok(precompact.some((event) => event.params.run.status === "failed"));
			assert.ok(!h.events.some((event) => event.method === "hook/completed" && event.params.run.eventName === "sessionStart" && event.params.run.status === "stopped"));
			await receipt(h, `recovered-${hookFailure}-checkpoint`, { compactions: 1, immediateOriginalRecovery: true, replacementCheckpoint: checkpoint.path });
		});
	});
}

test("a later hook crash refreshes the stale checkpoint with the newest unread result", async (t) => {
	await usingRuntime(t, "later-hook-crash", { hookFailure: "crash-after-checkpoint" }, async (h) => {
		assert.equal((await h.turn(owner, automaticReplies())).status, "completed");
		assertRecovery(h, 2, "compact", ["StockHooksOwner47", unread]);
		const firstCheckpoint = await savedCheckpoint(h);
		const secondFrom = h.requests.length;
		const newest = "STOCK_SECOND_UNREAD_RESULT_96";
		const second = await h.turn("StockSecondOwnerRequest96: preserve this later output too.", automaticReplies({ marker: newest, callId: "second-unread-shell", summary: "SECOND_LOSSY_SUMMARY_82: Keep working on the existing task." }));
		assert.equal(second.status, "completed");
		assert.equal(h.requests.length, secondFrom + 3);
		assert.match(requestText(h.requests[secondFrom + 1]), /STOCK_SECOND_UNREAD_RESULT_96/);
		assertRecovery(h, secondFrom + 2, "compact", ["StockSecondOwnerRequest96", newest]);
		assert.ok(!h.requests[secondFrom + 2].body.input.some((item) => item.call_id === "second-unread-shell" && item.type === "function_call_output"));
		const latest = await savedCheckpoint(h);
		assert.notEqual(latest.path, firstCheckpoint.path);
		assert.match(latest.recovery, /STOCK_SECOND_UNREAD_RESULT_96/);
		assert.ok(Date.parse(latest.createdAt) >= h.requests[secondFrom + 1].recordedAt);
		const transcript = await h.transcriptItems();
		assert.equal(transcript.filter((row) => row.type === "compacted").length, 2);
		assert.match(JSON.stringify(transcript), /STOCK_SECOND_UNREAD_RESULT_96/);
		const originalIndex = transcript.findIndex((row) => row.type === "response_item" && row.payload.type === "function_call_output" && row.payload.call_id === "second-unread-shell");
		assert.ok(originalIndex >= 0);
		const original = transcript[originalIndex];
		const originalId = Number.isSafeInteger(original.ordinal) ? `ordinal:${original.ordinal}` : `line:${originalIndex + 1}`;
		assert.ok(h.events.some((event) => event.method === "hook/completed" && event.params.run.eventName === "preCompact" && event.params.run.status === "failed"));
		const launches = h.launches;
		await h.restart();
		await h.turn("Continue after restarting the recovered task.", [{ items: [message("restarted after recovery")] }]);
		assert.equal(h.launches, launches + 1);
		assertRecovery(h, h.requests.length - 1, "resume", ["StockSecondOwnerRequest96", newest]);
		const manualFrom = h.requests.length;
		await h.compact([{ items: [message("MANUAL_AFTER_CRASH_SUMMARY_32: Continue the same task.")] }]);
		assert.equal(h.requests.length, manualFrom + 1);
		const manualContinuation = h.requests.length;
		await h.turn("Read the original result after manual compaction of the recovered task.", [
			{ items: [discoverNotes()] },
			{ items: [call("history", { op: "read", threadId: h.threadId, id: originalId }, "read-latest-original", "mcp__notes")] },
			{ items: [message("manual recovery complete")] },
		]);
		assertRecovery(h, manualContinuation, "compact", ["StockSecondOwnerRequest96"]);
		assert.match(requestText(h.requests[manualContinuation]), /MANUAL_AFTER_CRASH_SUMMARY_32/);
		assert.match(JSON.stringify(h.requests.at(-1).body.input.find((item) => item.call_id === "read-latest-original" && item.type === "function_call_output")), /STOCK_SECOND_UNREAD_RESULT_96/);
		assert.equal((await h.transcriptItems()).filter((row) => row.type === "compacted").length, 3);
		await receipt(h, "later-hook-crash-recovered", { newestResultRecovered: true, previousCheckpoint: firstCheckpoint.path, refreshedCheckpoint: latest.path, fullAppServerRestart: true, manualSummaryPreserved: true, originalsPreserved: true });
	});
});

test("multiple summarizer messages do not mark the original trailing tool result as consumed", async (t) => {
	await usingRuntime(t, "multi-message-summary", { hookFailure: "nonzero" }, async (h) => {
		const replies = automaticReplies();
		replies[1].items = [message("SUMMARY_PART_ONE: Continue this task."), message("SUMMARY_PART_TWO: Specific original records are omitted.")];
		assert.equal((await h.turn(owner, replies)).status, "completed");
		assert.equal(h.requests.length, 3);
		assertRecovery(h, 2, "compact", ["StockHooksOwner47", unread]);
		assert.ok(!h.requests[2].body.input.some((item) => item.call_id === "unread-shell" && item.type === "function_call_output"));
		const transcript = await h.transcriptItems();
		const summaries = transcript.filter((row) => row.type === "response_item" && row.payload.role === "assistant" && /SUMMARY_PART_ONE|SUMMARY_PART_TWO/.test(JSON.stringify(row.payload)));
		assert.equal(summaries.length, 2, "both real summarizer outputs must be recorded");
		assert.equal(transcript.filter((row) => row.type === "compacted").length, 1);
		assert.match((await savedCheckpoint(h)).recovery, /STOCK_UNREAD_RESULT_83/);
		await receipt(h, "multi-message-summary-recovery", { summaryMessages: 2, immediateUnreadRecovery: true });
	});
});
