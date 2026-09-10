import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RuntimeHarness, call, message, requestText, discoverNotes } from "./runtime-harness.mjs";

const owner = "StockV2Owner47: preserve my exact request and unread output through ordinary remote compaction.";
const unread = "STOCK_V2_UNREAD_RESULT_83";
const automaticSummary = "SCRIPTED_V2_SUMMARY_21";
const manualSummary = "SCRIPTED_V2_MANUAL_SUMMARY_61";
const compaction = (encrypted_content) => ({ type: "compaction", encrypted_content });
const sourceContext = (request, source) => request.body.input.filter((item) =>
	item.type === "message" && item.role === "developer" && JSON.stringify(item).includes(`source=${source}`));
const sessionHooks = (h, source) => h.events.filter((event) => event.method === "hook/completed" &&
	event.params.run.eventName === "sessionStart" && event.params.run.entries.some((entry) => entry.text.includes(`source=${source}`)));

async function checkpoint(h) {
	const manifest = JSON.parse(await readFile(join(h.state, "threads", `${h.threadId}.json`), "utf8"));
	return { path: manifest.checkpointPath, ...JSON.parse(await readFile(manifest.checkpointPath, "utf8")) };
}

async function checkpoints(h) {
	const directory = join(h.state, "checkpoints", h.threadId);
	return Promise.all((await readdir(directory)).map(async (file) => JSON.parse(await readFile(join(directory, file), "utf8"))));
}

async function usingV2Runtime(t, name, options, run) {
	const h = await RuntimeHarness.create(name, { tokenBudget: false, localRecovery: false, stockRecovery: true, ...options });
	t.diagnostic(`Retained V2 artifacts: ${h.root}`);
	try {
		await h.stop();
		assert.match(h.config, /name = "Posthorse local test"/);
		assert.match(h.config, /\[features.token_budget\]\nenabled = false/);
		// This selects the stock V2 client path, while all requests remain on the loopback fixture.
		h.config = h.config.replace('name = "Posthorse local test"', 'name = "OpenAI"')
			.replace("[features]\n", "[features]\nremote_compaction_v2 = true\n");
		assert.match(h.config, /base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/);
		assert.match(h.config, /requires_openai_auth = false/);
		assert.doesNotMatch(h.config, /local_recovery_hook|env_key|experimental_bearer_token/);
		await writeFile(join(h.home, "config.toml"), h.config);
		await h.start();
		const account = await h.rpc("account/read", {});
		assert.equal(account.requiresOpenaiAuth, false);
		await writeFile(join(h.root, "account-read.json"), JSON.stringify(account, null, 2));
		await h.thread();
		const result = await run(h);
		assert.ok(h.requests.every((request) => request.path === "/v1/responses"));
		assert.equal(h.replies.length, 0);
		assert.equal(h.providerError, undefined);
		await writeFile(join(h.root, "acceptance.json"), JSON.stringify({
			passed: true, runtime: process.env.POSTHORSE_CODEX_BIN ?? "codex", threadId: h.threadId,
			transcript: h.transcript, source: "scripted loopback V2 provider; not live OpenAI",
			codeMode: h.codeMode, modelRequests: h.requests.length, ...result,
		}, null, 2) + "\n");
	} finally {
		await h.close();
	}
}

test("stock V2 hooks recover unread output before continuation, survive restart, and retain manual summarization", async (t) => {
	await usingV2Runtime(t, "stock-v2-auto-restart-manual", {}, async (h) => {
		const turn = await h.turn(owner, [
			{ items: [call("exec_command", { cmd: `printf '${unread}\\n'`, login: false }, "v2-unread-shell")], tokens: 9_500 },
			{ items: [compaction(automaticSummary)] },
			{ items: [message("V2 recovery continuation complete")] },
		]);
		assert.equal(turn.status, "completed");
		assert.equal(h.requests.length, 3);
		const summaryRequest = h.requests[1];
		assert.equal(summaryRequest.body.input.filter((item) => item.type === "compaction_trigger").length, 1);
		assert.match(requestText(summaryRequest), /STOCK_V2_UNREAD_RESULT_83/);
		const continued = h.requests[2];
		assert.equal(continued.body.input.find((item) => item.type === "compaction")?.encrypted_content, automaticSummary);
		assert.ok(!continued.body.input.some((item) => item.type === "function_call_output" && item.call_id === "v2-unread-shell"));
		const restored = sourceContext(continued, "compact");
		assert.equal(restored.length, 1);
		assert.match(JSON.stringify(restored), /StockV2Owner47/);
		assert.match(JSON.stringify(restored), /STOCK_V2_UNREAD_RESULT_83/);
		const compactHook = sessionHooks(h, "compact")[0];
		assert.equal(compactHook.params.run.status, "completed");
		assert.ok(compactHook.recordedAt >= summaryRequest.recordedAt);
		assert.ok(compactHook.recordedAt <= continued.recordedAt);
		const automaticCheckpoint = await checkpoint(h);
		assert.equal(automaticCheckpoint.source, "compact");
		const preCompactCheckpoint = (await checkpoints(h)).find((entry) => entry.trigger === "auto");
		assert.ok(preCompactCheckpoint);
		assert.ok(Date.parse(preCompactCheckpoint.createdAt) <= summaryRequest.recordedAt);
		assert.match(automaticCheckpoint.recovery, /STOCK_V2_UNREAD_RESULT_83/);
		const transcript = await h.transcriptItems();
		const compacted = transcript.filter((row) => row.type === "compacted");
		assert.equal(compacted.length, 1);
		assert.match(JSON.stringify(compacted[0]), /SCRIPTED_V2_SUMMARY_21/);
		assert.doesNotMatch(JSON.stringify(compacted[0].payload.replacement_history), /STOCK_V2_UNREAD_RESULT_83/);
		assert.ok(continued.body.input.filter((item) => JSON.stringify(item).includes(unread)).every((item) =>
			item.type === "message" && item.role === "developer" && item.internal_chat_message_metadata_passthrough?.content_item_kinds?.includes("hooks.additional_context")));
		const outputIndex = transcript.findIndex((row) => row.type === "response_item" && row.payload.type === "function_call_output" && row.payload.call_id === "v2-unread-shell");
		assert.ok(outputIndex >= 0);
		const original = transcript[outputIndex];
		const originalId = Number.isSafeInteger(original.ordinal) ? `ordinal:${original.ordinal}` : `line:${outputIndex + 1}`;
		assert.match(automaticCheckpoint.recovery, new RegExp(originalId));
		const launchesBeforeRestart = h.launches;
		await h.restart();
		assert.equal(h.launches, launchesBeforeRestart + 1);
		const resumeFrom = h.requests.length;
		const resumed = await h.turn("Resume the same V2 task and retrieve the original output by its record ID.", [
			{ items: [discoverNotes()] },
			{ items: [call("history", { op: "read", threadId: h.threadId, id: originalId }, "v2-read-original", "mcp__notes")] },
			{ items: [message("V2 restart proof complete")] },
		]);
		assert.equal(resumed.status, "completed");
		const resumedContext = sourceContext(h.requests[resumeFrom], "resume");
		assert.equal(resumedContext.length, 1);
		assert.match(JSON.stringify(resumedContext), /StockV2Owner47/);
		assert.match(JSON.stringify(resumedContext), /STOCK_V2_UNREAD_RESULT_83/);
		assert.equal(sessionHooks(h, "resume").at(-1).params.run.status, "completed");
		const originalRead = h.requests.at(-1).body.input.find((item) => item.type === "function_call_output" && item.call_id === "v2-read-original");
		assert.ok(originalRead);
		assert.match(JSON.stringify(originalRead), /STOCK_V2_UNREAD_RESULT_83/);
		assert.match(JSON.stringify(originalRead), new RegExp(originalId));
		const manualFrom = h.requests.length;
		await h.compact([{ items: [compaction(manualSummary)] }]);
		assert.equal(h.requests.length, manualFrom + 1);
		assert.equal(h.requests[manualFrom].body.input.filter((item) => item.type === "compaction_trigger").length, 1);
		assert.equal((await h.transcriptItems()).filter((row) => row.type === "compacted").length, 2);
		const manualTurn = await h.turn("Continue after manual V2 compaction.", [{ items: [message("V2 manual continuation complete")] }]);
		assert.equal(manualTurn.status, "completed");
		const manualContinuation = h.requests.at(-1);
		assert.equal(manualContinuation.body.input.find((item) => item.type === "compaction")?.encrypted_content, manualSummary);
		assert.equal(sourceContext(manualContinuation, "compact").length, 1);
		assert.equal(sessionHooks(h, "compact").length, 2);
		const manualCheckpoint = await checkpoint(h);
		assert.equal(manualCheckpoint.source, "compact");
		assert.ok((await checkpoints(h)).some((entry) => entry.trigger === "manual"));
		assert.notEqual(manualCheckpoint.id, automaticCheckpoint.id);
		assert.notEqual(manualCheckpoint.compactionId, automaticCheckpoint.compactionId);
		return {
			automaticV2Compactions: 1, manualV2Compactions: 1,
			immediateSessionStartRecovery: true, unreadOutputOnlyRecoveredByHook: true,
			originalRecordId: originalId, originalToolHistoryRead: true, fullAppServerRestart: true,
			sameThreadResume: true, preservedCheckpoint: automaticCheckpoint.path,
		};
	});
});

test("stock V2 rebuilds a later missed checkpoint from original history and keeps that recovery after restart", async (t) => {
	await usingV2Runtime(t, "stock-v2-stale-checkpoint", { hookFailure: "crash-after-checkpoint" }, async (h) => {
		const first = await h.turn(owner, [
			{ items: [call("exec_command", { cmd: `printf '${unread}\\n'`, login: false }, "first-v2-output")], tokens: 9_500 },
			{ items: [compaction(automaticSummary)] },
			{ items: [message("First V2 continuation complete")] },
		]);
		assert.equal(first.status, "completed");
		const priorCheckpoint = await checkpoint(h);
		const priorContents = await readFile(priorCheckpoint.path, "utf8");
		const latestUnread = "STOCK_V2_LATEST_UNREAD_94";
		const secondFrom = h.requests.length;
		const eventsFrom = h.events.length;
		const second = await h.turn("StockV2LatestOwner92: preserve this newer request and unread result.", [
			{ items: [call("exec_command", { cmd: `printf '${latestUnread}\\n'`, login: false }, "latest-v2-output")], tokens: 9_500 },
			{ items: [compaction("SCRIPTED_V2_SECOND_SUMMARY_52")] },
			{ items: [message("Second V2 continuation complete")] },
		]);
		assert.equal(second.status, "completed");
		assert.equal(h.requests.length, secondFrom + 3);
		assert.equal(h.requests[secondFrom + 1].body.input.filter((item) => item.type === "compaction_trigger").length, 1);
		const preCompactFailure = h.events.slice(eventsFrom).filter((event) => event.method === "hook/completed" &&
			event.params.run.eventName === "preCompact" && event.params.run.status === "failed");
		assert.equal(preCompactFailure.length, 1);
		assert.match(JSON.stringify(preCompactFailure), /CONTROLLED_SECOND_CHECKPOINT_PROCESS_FAILURE/);
		const continued = h.requests.at(-1);
		const restored = sourceContext(continued, "compact");
		assert.equal(restored.length, 1);
		assert.match(JSON.stringify(restored), /StockV2LatestOwner92/);
		assert.match(JSON.stringify(restored), /STOCK_V2_LATEST_UNREAD_94/);
		assert.ok(!continued.body.input.some((item) => item.type === "function_call_output" && item.call_id === "latest-v2-output"));
		assert.ok(continued.body.input.filter((item) => JSON.stringify(item).includes(latestUnread)).every((item) =>
			item.type === "message" && item.role === "developer" && item.internal_chat_message_metadata_passthrough?.content_item_kinds?.includes("hooks.additional_context")));
		const repaired = await checkpoint(h);
		assert.equal(repaired.source, "compact");
		assert.notEqual(repaired.compactionId, priorCheckpoint.compactionId);
		assert.match(repaired.recovery, /STOCK_V2_LATEST_UNREAD_94/);
		assert.equal(await readFile(priorCheckpoint.path, "utf8"), priorContents);
		const transcript = await h.transcriptItems();
		const compacted = transcript.filter((row) => row.type === "compacted");
		assert.equal(compacted.length, 2);
		assert.doesNotMatch(JSON.stringify(compacted.at(-1).payload.replacement_history), /STOCK_V2_LATEST_UNREAD_94/);
		const outputIndex = transcript.findIndex((row) => row.type === "response_item" && row.payload.type === "function_call_output" && row.payload.call_id === "latest-v2-output");
		assert.ok(outputIndex >= 0);
		const original = transcript[outputIndex];
		const originalId = Number.isSafeInteger(original.ordinal) ? `ordinal:${original.ordinal}` : `line:${outputIndex + 1}`;
		assert.match(repaired.recovery, new RegExp(originalId));
		const resumeFrom = h.requests.length;
		await h.restart();
		const resumed = await h.turn("Read the latest original result after restarting this V2 task.", [
			{ items: [discoverNotes()] },
			{ items: [call("history", { op: "read", threadId: h.threadId, id: originalId }, "v2-read-latest", "mcp__notes")] },
			{ items: [message("Latest V2 recovery survived restart")] },
		]);
		assert.equal(resumed.status, "completed");
		const resumedContext = sourceContext(h.requests[resumeFrom], "resume");
		assert.equal(resumedContext.length, 1);
		assert.match(JSON.stringify(resumedContext), /StockV2LatestOwner92/);
		assert.match(JSON.stringify(resumedContext), /STOCK_V2_LATEST_UNREAD_94/);
		const originalRead = h.requests.at(-1).body.input.find((item) => item.type === "function_call_output" && item.call_id === "v2-read-latest");
		assert.ok(originalRead);
		assert.match(JSON.stringify(originalRead), /STOCK_V2_LATEST_UNREAD_94/);
		return {
			automaticV2Compactions: 2, laterCheckpointProcessFailure: true,
			latestUnreadOutputOnlyRecoveredByHook: true, staleCheckpointRebuilt: true,
			originalCheckpointUnchanged: true, originalToolHistoryRead: true, sameThreadRestartRecovery: true,
		};
	});
});
