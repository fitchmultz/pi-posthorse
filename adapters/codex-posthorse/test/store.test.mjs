import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "../store.mjs";

const threadId = "test-thread";
const user = (text, kinds = ["user.text"]) => ({
	type: "response_item", payload: {
		type: "message", role: "user", content: [{ type: "input_text", text }],
		internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
	},
});
const call = (id, name = "exec_command") => ({
	type: "response_item", payload: { type: "function_call", call_id: id, name, arguments: '{"cmd":"test command"}' },
});
const output = (id, text, extra = {}) => ({
	type: "response_item", payload: { type: "function_call_output", call_id: id, output: text, ...extra },
});
const assistant = (text) => ({
	type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
});
const tokenCount = { type: "event_msg", payload: { type: "token_count", info: {} } };

async function fixture(records, { ordinals = true, firstWindowId } = {}) {
	const cache = join(homedir(), "Library", "Caches", "pi-runs");
	await mkdir(cache, { recursive: true });
	const dir = await mkdtemp(join(cache, "posthorse-store-test-"));
	const transcript = join(dir, "rollout.jsonl");
	const rows = [{ type: "session_meta", payload: { id: threadId, ...(firstWindowId ? { context_window: { window_id: firstWindowId } } : {}) } }, ...records].map((row, index) => ({
		timestamp: "2026-09-09T12:00:00Z", ...(ordinals ? { ordinal: index } : {}), ...row,
	}));
	const original = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
	await writeFile(transcript, original);
	const stateDir = join(dir, "state");
	const store = createStore(stateDir);
	await store.register({ session_id: threadId, transcript_path: transcript });
	return { dir, transcript, stateDir, store, original, rows, hook: { session_id: threadId, transcript_path: transcript, trigger: "auto", turn_id: "turn-1" } };
}

test("checkpoint keeps original requests across reset boundaries without promoting assistant progress", async () => {
	const f = await fixture([
		user("<environment_context>injected context</environment_context>", ["environments.environment_context"]),
		user("ORIGINAL_REQUEST build the approved behavior"),
		assistant("STALE_ASSISTANT_PROSE everything is done"),
		{ type: "compacted", payload: { message: "OLD_SUMMARY do something else", replacement_history: [] } },
		user("LATEST_REQUEST also keep manual compact working"),
		call("call-1"), output("call-1", "UNREAD_RESULT production check failed", { is_error: true }), tokenCount,
	]);
	const checkpoint = await f.store.checkpoint(f.hook);
	assert.match(checkpoint.recovery, /ORIGINAL_REQUEST/);
	assert.match(checkpoint.recovery, /LATEST_REQUEST/);
	assert.match(checkpoint.recovery, /UNREAD_RESULT/);
	assert.match(checkpoint.recovery, /\[tool reported failure\]/);
	assert.match(checkpoint.recovery, /Tool call ordinal:6/);
	assert.match(checkpoint.recovery, /direct user input \| ordinal:2/);
	assert.doesNotMatch(checkpoint.recovery, /STALE_ASSISTANT_PROSE|OLD_SUMMARY/);
	assert.match(checkpoint.recovery, /Previous context boundary: ordinal:4/);
	assert.match(checkpoint.recovery, /acknowledgement.*inferred/);
	assert.equal(await readFile(f.transcript, "utf8"), f.original);
	const restarted = createStore(f.stateDir);
	assert.match(await restarted.threadHint(threadId), /UNREAD_RESULT/);
	assert.match(await restarted.threadHint(threadId), /threadId: "test-thread"/);
});

test("interleaved sibling tool results survive but results followed by a new model response do not", async () => {
	const f = await fixture([
		user("Check both independent tools"),
		call("old"), output("old", "ALREADY_CONSUMED"), tokenCount,
		call("one"), output("one", "FIRST_SIBLING"), call("two"), output("two", "SECOND_SIBLING"), tokenCount,
	]);
	const checkpoint = await f.store.checkpoint(f.hook);
	assert.doesNotMatch(checkpoint.recovery, /ALREADY_CONSUMED/);
	assert.match(checkpoint.recovery, /FIRST_SIBLING/);
	assert.match(checkpoint.recovery, /SECOND_SIBLING/);
	await writeFile(f.transcript, f.original + JSON.stringify({ ...assistant("Consumed all results"), ordinal: 11 }) + "\n");
	assert.doesNotMatch((await f.store.checkpoint(f.hook)).recovery, /FIRST_SIBLING|SECOND_SIBLING|Consumed all results/);
});

test("an aborted response with reasoning alone does not acknowledge prior tool results", async () => {
	const f = await fixture([
		user("Continue until verified"), call("pending"), output("pending", "KEEP_AFTER_FAILURE"), tokenCount,
		{ type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "unfinished reasoning" }] } },
		{ type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } },
	]);
	assert.match((await f.store.checkpoint(f.hook)).recovery, /KEEP_AFTER_FAILURE/);
});

test("bounded checkpoints point back to complete paged originals and retain old checkpoints", async () => {
	const f = await fixture([
		user("FIRST_REQUEST_" + "a".repeat(12_000)),
		...Array.from({ length: 20 }, (_, i) => user(`REQUEST_${i}_` + "b".repeat(12_000))),
		call("tail"), output("tail", "LAST_TOOL_RESULT_" + "c".repeat(12_000)), tokenCount,
	]);
	const a = await f.store.checkpoint(f.hook);
	assert.ok(a.recovery.length <= 20_000);
	assert.ok((await f.store.threadHint(threadId)).length <= 20_000);
	assert.match(a.recovery, /FIRST_REQUEST_|omitted; use history/);
	assert.match(a.recovery, /REQUEST_19_/);
	assert.match(a.recovery, /LAST_TOOL_RESULT_/);
	assert.match(a.recovery, /other original input or trailing tool record\(s\) omitted/);
	let original = "";
	let offset = 0;
	do {
		const page = await f.store.history({ threadId, op: "read", id: "ordinal:1", offset, limit: 997 });
		original += page.content;
		offset = page.nextOffset;
	} while (offset !== null);
	assert.deepEqual(JSON.parse(original), f.rows[1]);
	await f.store.checkpoint(f.hook);
	assert.equal((await readdir(join(f.stateDir, "checkpoints", threadId))).filter((name) => name.endsWith(".json")).length, 2);
});

test("Unicode recovery fits the native byte limit without breaking characters or original history", async () => {
	const original = "FIRST_UNICODE_REQUEST " + "漢字😀".repeat(12_000);
	const f = await fixture([
		user(original),
		...Array.from({ length: 6 }, (_, index) => user(`OTHER_REQUEST_${index} ` + "漢字😀".repeat(4_000))),
		user("LATEST_UNICODE_REQUEST " + "漢字😀".repeat(4_000)),
		call("unicode-output"), output("unicode-output", "UNREAD_UNICODE_RESULT " + "漢字😀".repeat(4_000)),
	]);
	await f.store.checkpoint(f.hook);
	const hint = await createStore(f.stateDir).threadHint(threadId);
	assert.ok(Buffer.byteLength(hint) <= 32_000);
	assert.ok(hint.length <= 20_000);
	assert.ok(hint.isWellFormed());
	for (const marker of ["FIRST_UNICODE_REQUEST", "LATEST_UNICODE_REQUEST", "UNREAD_UNICODE_RESULT"]) assert.ok(hint.includes(marker));
	const read = await f.store.history({ threadId, op: "read", id: "ordinal:1", limit: 200_000 });
	assert.equal(JSON.parse(read.content).payload.content[0].text, original);
	assert.equal(await readFile(f.transcript, "utf8"), f.original);
});

test("history pages, searches, window labels, and image records survive restart exactly", async () => {
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCBkAAAAASUVORK5CYII=";
	const image = { type: "input_image", image_url: `data:image/png;base64,${png}`, detail: "original" };
	const imageUser = user("IMAGE_REQUEST");
	imageUser.payload.content.push(image);
	const f = await fixture([
		user("needle before reset"), imageUser,
		{ type: "compacted", payload: { message: "boundary", window_id: "native-window-1", replacement_history: [] } },
		user("needle after reset"),
		{ type: "turn_context", payload: { turn_id: "turn-after", cwd: "/scratch" } },
	], { firstWindowId: "native-window-0" });
	const restarted = createStore(f.stateDir);
	const first = await restarted.history({ threadId, op: "list", limit: 2 });
	assert.equal(first.items.length, 2);
	assert.equal(first.nextOffset, 2);
	const second = await restarted.history({ threadId, op: "list", offset: first.nextOffset, limit: 20 });
	assert.equal(second.nextOffset, null);
	assert.equal(first.items.length + second.items.length, f.rows.length);
	const hit = await restarted.history({ threadId, op: "search", query: "needle", limit: 1 });
	assert.equal(hit.total, 2);
	assert.equal(hit.items[0].windowId, "native-window-0");
	const before = await restarted.history({ threadId, op: "list", windowId: "native-window-0" });
	assert.deepEqual(before.items.map((item) => item.id), ["ordinal:0", "ordinal:1", "ordinal:2"]);
	const nextHit = await restarted.history({ threadId, op: "search", query: "needle", offset: hit.nextOffset, limit: 1 });
	assert.equal(nextHit.items[0].windowId, "native-window-1");
	const after = await restarted.history({ threadId, op: "list", windowId: "native-window-1" });
	assert.deepEqual(after.items.map((item) => item.id), ["ordinal:3", "ordinal:4", "ordinal:5"]);
	const read = await restarted.history({ threadId, op: "read", id: "ordinal:2", limit: 20_000 });
	assert.deepEqual(JSON.parse(read.content).payload.content[1], image);
	assert.deepEqual(read.images, [{ type: "image", mimeType: "image/png", data: png }]);
	assert.deepEqual((await restarted.history({ threadId, op: "read", id: "ordinal:2", offset: 1 })).images, []);
	const toolImage = { type: "image", mimeType: "image/png", data: png };
	const row = { ...output("image-result", [toolImage]), ordinal: 6 };
	await writeFile(f.transcript, f.original + JSON.stringify(row) + "\n");
	assert.deepEqual((await restarted.history({ threadId, op: "read", id: "ordinal:6" })).images, [toolImage]);
});

test("legacy direct-user events deduplicate their response copies and support line IDs", async () => {
	const f = await fixture([
		{ type: "event_msg", payload: { type: "user_message", message: "DIRECT_EVENT_REQUEST", images: [] } },
		user("DIRECT_EVENT_REQUEST"),
	], { ordinals: false });
	const checkpoint = await f.store.checkpoint(f.hook);
	assert.equal(checkpoint.recovery.match(/DIRECT_EVENT_REQUEST/g)?.length, 1);
	assert.match(checkpoint.recovery, /direct user input \| line:2/);
	const read = await f.store.history({ threadId, op: "read", id: "line:2" });
	assert.equal(JSON.parse(read.content).payload.message, "DIRECT_EVENT_REQUEST");
});

test("notes list, exact append, search, and character paging persist independently per task", async () => {
	const f = await fixture([user("Keep durable notes")]);
	await f.store.notes({ threadId, op: "write", path: "work/current.md", content: "First needle.\n" });
	await f.store.notes({ threadId, op: "append", path: "work/current.md", content: "Second needle." });
	await f.store.notes({ threadId: "another-thread", op: "write", path: "work/current.md", content: "Other task" });
	const restarted = createStore(f.stateDir);
	assert.deepEqual((await restarted.notes({ threadId, op: "list" })).items, ["work/current.md"]);
	const read = await restarted.notes({ threadId, op: "read", path: "work/current.md", limit: 14 });
	assert.equal(read.content, "First needle.\n");
	assert.equal((await restarted.notes({ threadId, op: "read", path: "work/current.md", offset: read.nextOffset })).content, "Second needle.\n");
	const search = await restarted.notes({ threadId, op: "search", query: "needle", limit: 1 });
	assert.equal(search.total, 2);
	assert.equal(search.nextOffset, 1);
	assert.equal((await restarted.notes({ threadId: "another-thread", op: "read", path: "work/current.md" })).content, "Other task");
	assert.match(await restarted.threadHint("task-without-checkpoint"), /Posthorse task ID: task-without-checkpoint/);
});

test("parallel note appends preserve complete records through independent store instances", async () => {
	const f = await fixture([user("Append all worker observations")]);
	await f.store.notes({ threadId, op: "write", path: "workers.md", content: "Existing unterminated line" });
	const records = Array.from({ length: 30 }, (_, index) => `Worker ${index}: ${"result ".repeat(500)}`);
	await Promise.all(records.map((content) => createStore(f.stateDir).notes({ threadId, op: "append", path: "workers.md", content })));
	const read = await f.store.notes({ threadId, op: "read", path: "workers.md", limit: 200_000 });
	assert.ok(read.content.endsWith("\n"));
	assert.deepEqual(new Set(read.content.split("\n").filter(Boolean)), new Set(["Existing unterminated line", ...records]));
	assert.equal(read.content.split("\n").filter(Boolean).length, records.length + 1);
});

test("path escape, malformed pages, and missing records fail without hiding errors", async () => {
	const f = await fixture([user("Keep notes in scope")]);
	await assert.rejects(f.store.notes({ threadId: "../other", op: "write", path: "x", content: "x" }), /single path component/);
	for (const path of ["../escape.md", "/tmp/escape.md", "nested/../../escape.md", "."]) {
		await assert.rejects(f.store.notes({ threadId, op: "write", path, content: "escape" }), /inside this task/);
	}
	await f.store.notes({ threadId, op: "write", path: "safe.md", content: "safe" });
	await symlink(f.dir, join(f.stateDir, "notes", threadId, "link"));
	await assert.rejects(f.store.notes({ threadId, op: "write", path: "link/escape.md", content: "escape" }), /symbolic links/);
	await assert.rejects(f.store.history({ threadId, op: "list", offset: -1 }), /nonnegative/);
	await assert.rejects(f.store.history({ threadId, op: "list", limit: 0 }), /positive/);
	await assert.rejects(f.store.history({ threadId, op: "read", id: "ordinal:999" }), /not found/);
	await assert.rejects(f.store.notes({ threadId, op: "read", path: "missing.md" }), { code: "ENOENT" });
	await assert.rejects(f.store.history({ threadId: "unregistered", op: "list" }), /No transcript registered/);
});

test("failed checkpoint leaves the prior recovery intact and never modifies the transcript", async () => {
	const f = await fixture([user("KEEP_VALID_CHECKPOINT")]);
	await f.store.checkpoint(f.hook);
	const previous = await f.store.threadHint(threadId);
	await writeFile(f.transcript, f.original + '{"type":"response_item","payload":');
	await assert.rejects(f.store.checkpoint(f.hook), /incomplete or invalid JSON/);
	assert.equal(await f.store.threadHint(threadId), previous);
	const partial = await readFile(f.transcript, "utf8");
	assert.equal(partial, f.original + '{"type":"response_item","payload":');
	await writeFile(f.transcript, f.original);
	const invalidState = join(f.dir, "not-a-directory");
	await writeFile(invalidState, "occupied");
	await assert.rejects(createStore(invalidState).checkpoint(f.hook));
	assert.equal(await readFile(f.transcript, "utf8"), f.original);
	assert.equal(await readFile(invalidState, "utf8"), "occupied");
	await assert.rejects(f.store.checkpoint({ ...f.hook, session_id: "wrong-thread" }), /session ID does not match/);
});

test("child hooks use agent_id while preserving the root task's checkpoint and notes", async () => {
	const f = await fixture([user("PARENT_REQUEST keep parent work intact")]);
	await f.store.checkpoint(f.hook);
	await f.store.notes({ threadId, op: "write", path: "current.md", content: "Parent notes" });
	const parentHint = await f.store.threadHint(threadId);
	const childId = "child-thread";
	const childTranscript = join(f.dir, "child-rollout.jsonl");
	const childRows = [
		{ type: "session_meta", payload: { id: childId, session_id: threadId, parent_thread_id: threadId } },
		user("CHILD_REQUEST complete the delegated check"),
		call("child-call"), output("child-call", "CHILD_UNREAD_RESULT"), tokenCount,
	].map((row, ordinal) => ({ ordinal, ...row }));
	await writeFile(childTranscript, childRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	const childHook = { ...f.hook, agent_id: childId, transcript_path: childTranscript };
	await f.store.register(childHook);
	const childCheckpoint = await f.store.checkpoint(childHook);
	assert.equal(childCheckpoint.threadId, childId);
	assert.equal(childCheckpoint.rootThreadId, threadId);
	assert.match(childCheckpoint.recovery, /CHILD_REQUEST/);
	assert.match(childCheckpoint.recovery, /CHILD_UNREAD_RESULT/);
	assert.match(childCheckpoint.recovery, /original delegated task input/);
	assert.match(childCheckpoint.recovery, /not direct user authorization/);
	assert.doesNotMatch(childCheckpoint.recovery, /direct user input/);
	assert.doesNotMatch(childCheckpoint.recovery, /PARENT_REQUEST/);
	await f.store.notes({ threadId: childId, op: "write", path: "current.md", content: "Child notes" });
	const restarted = createStore(f.stateDir);
	assert.equal(await restarted.threadHint(threadId), parentHint);
	assert.match(await restarted.threadHint(childId), /CHILD_UNREAD_RESULT/);
	assert.equal((await restarted.notes({ threadId, op: "read", path: "current.md" })).content, "Parent notes");
	assert.equal((await restarted.notes({ threadId: childId, op: "read", path: "current.md" })).content, "Child notes");
	const parentManifest = JSON.parse(await readFile(join(f.stateDir, "threads", `${threadId}.json`), "utf8"));
	const childManifest = JSON.parse(await readFile(join(f.stateDir, "threads", `${childId}.json`), "utf8"));
	assert.equal(parentManifest.transcriptPath, f.transcript);
	assert.equal(childManifest.transcriptPath, childTranscript);
	assert.equal(childManifest.rootThreadId, threadId);
	assert.notEqual(parentManifest.checkpointPath, childManifest.checkpointPath);
	assert.match((await restarted.history({ threadId: childId, op: "read", id: "ordinal:1" })).content, /CHILD_REQUEST/);
	await assert.rejects(restarted.checkpoint({ ...childHook, agent_id: "wrong-child" }), /session ID does not match/);
});
