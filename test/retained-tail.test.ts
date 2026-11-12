import assert from "node:assert/strict";
import { test } from "node:test";
import {
	journalRetainedIds,
	retainedSpan,
	sameRetainedMessage,
	retainedTailEnd,
} from "../src/retained-tail.ts";

await test("the journal tail is the entries between the kept id and the latest compaction", () => {
	const branch = [
		{ type: "message", id: "a" },
		{ type: "message", id: "b" },
		{ type: "compaction", id: "c", firstKeptEntryId: "b" },
		{ type: "message", id: "d" },
	];
	assert.deepEqual([...(journalRetainedIds(branch) ?? [])], ["b"]);
});

await test("a tail that cannot be located reports no retained ids", () => {
	const message = { type: "message", id: "a" };
	assert.equal(journalRetainedIds([message]), undefined);
	assert.equal(
		journalRetainedIds([message, { type: "compaction", id: "c", firstKeptEntryId: null }]),
		undefined,
	);
	assert.equal(
		journalRetainedIds([message, { type: "compaction", id: "c", firstKeptEntryId: "" }]),
		undefined,
	);
	assert.equal(
		journalRetainedIds([message, { type: "compaction", id: "c", firstKeptEntryId: "missing" }]),
		undefined,
	);
	assert.equal(
		journalRetainedIds([{ type: "compaction", id: "c", firstKeptEntryId: "a" }, message]),
		undefined,
	);
});

await test("the span prefers retained entries that produce a message", () => {
	const branch = [
		{ type: "custom", id: "anchor" },
		{ type: "message", id: "m1" },
		{ type: "custom_message", id: "m2" },
	];
	assert.deepEqual(retainedSpan(branch, new Set(["anchor", "m1", "m2"])), {
		firstId: "m1",
		lastId: "m2",
	});
	assert.deepEqual(retainedSpan(branch, new Set(["anchor"])), {
		firstId: "anchor",
		lastId: "anchor",
	});
	assert.equal(retainedSpan(branch, new Set()), undefined);
});

await test("a retained message keeps its identity under a system-role presentation", () => {
	const user = { role: "user", content: [{ type: "text", text: "Continue." }] };
	assert.ok(sameRetainedMessage(user, user));
	assert.ok(sameRetainedMessage(user, { ...user, role: "system" }));
	assert.ok(!sameRetainedMessage(user, { ...user, content: [{ type: "text", text: "Stop." }] }));
	assert.ok(!sameRetainedMessage(user, { role: "assistant", content: user.content }));
	const reminder = {
		role: "custom",
		customType: "posthorse-reminder",
		content: "[posthorse] Routine task-note update.",
		details: { windowId: "w1" },
	};
	assert.ok(sameRetainedMessage(reminder, { ...reminder, role: "system" }));
	assert.ok(!sameRetainedMessage(reminder, { ...reminder, details: { windowId: "w2" } }));
});

await test("same-content receipts still belong to their own tool calls and outcomes", () => {
	const receipt = {
		role: "toolResult",
		toolCallId: "retained-call",
		toolName: "read",
		content: [{ type: "text", text: "same output" }],
		isError: false,
	};
	for (const changed of [
		{ toolCallId: "other-call" },
		{ toolName: "write" },
		{ namespace: "other" },
		{ isError: true },
	]) {
		assert.equal(sameRetainedMessage(receipt, { ...receipt, ...changed }), false);
	}
	assert.equal(
		retainedTailEnd(
			[
				{ role: "compactionSummary", summary: "record" },
				{ ...receipt, toolCallId: "other-call" },
				receipt,
			],
			0,
			[receipt],
		),
		3,
	);
});

await test("the tail end lands after the last certified retained message", () => {
	const record = { role: "compactionSummary", summary: "record" };
	const first = { role: "user", content: [{ type: "text", text: "First." }] };
	const second = { role: "assistant", content: [{ type: "text", text: "Second." }] };
	const retained = [first, second];
	const messages = [
		{ role: "system", content: "guidance" },
		record,
		first,
		second,
		{ role: "user", content: [{ type: "text", text: "Newer." }] },
	];
	assert.equal(retainedTailEnd(messages, 1, retained), 4);
	assert.equal(retainedTailEnd(messages, 1, []), 2);
});

await test("an interleaved message does not move the record inside the retained tail", () => {
	const record = { role: "compactionSummary", summary: "record" };
	const first = { role: "user", content: [{ type: "text", text: "First." }] };
	const second = { role: "assistant", content: [{ type: "text", text: "Second." }] };
	const foreign = { role: "custom", customType: "directory-snapshot", content: "snapshot" };
	const messages = [record, first, foreign, second, { role: "user", content: "Newer." }];
	// The interleaved snapshot stays inside the tail slice; the record still follows the tail.
	assert.equal(retainedTailEnd(messages, 0, [first, second]), 4);
	// A system presentation of a retained message matches; an appended foreign message is
	// not swallowed into the tail, which position counting alone cannot tell apart.
	const remapped = [record, { ...first, role: "system" }, second, foreign];
	assert.equal(retainedTailEnd(remapped, 0, [first, second]), 3);
});

await test("an opaque system patch preserves its timestamp and journal order", () => {
	const record = { role: "compactionSummary", summary: "record" };
	const snapshot = {
		role: "custom",
		customType: "change-working-dir:context",
		content: "notice",
		details: { cwd: "/w", notice: "notice" },
		timestamp: 123,
	};
	const user = { role: "user", content: [{ type: "text", text: "Continue." }] };
	// The presenter keeps the timestamp but replaces custom type, details, and content.
	const patch = {
		role: "system",
		content: "",
		sections: { cwd: "/w", "change-working-dir": "x" },
		timestamp: 123,
	};
	assert.ok(!sameRetainedMessage(snapshot, patch));
	// The retained tail is [snapshot, user]; a foreign system message is interleaved between
	// their presentations. The patch matches its timestamp, the foreign message is skipped,
	// and the record lands after the whole tail.
	const messages = [
		record,
		patch,
		{ role: "system", content: "foreign" },
		user,
		{ role: "user", content: "Newer." },
	];
	assert.equal(retainedTailEnd(messages, 0, [snapshot, user]), 4);
	// An unrelated system message before the final retained patch must not consume it.
	assert.equal(
		retainedTailEnd(
			[record, user, { role: "system", content: "foreign", timestamp: 123 }, patch],
			0,
			[user, snapshot],
		),
		4,
	);
	assert.equal(
		retainedTailEnd([record, { role: "system", content: "foreign" }], 0, [snapshot]),
		undefined,
	);
});

await test("a tail that cannot be certified by identity reports no end", () => {
	const record = { role: "compactionSummary", summary: "record" };
	const first = { role: "user", content: [{ type: "text", text: "First." }] };
	const edited = { role: "user", content: [{ type: "text", text: "Edited." }] };
	const missing = { role: "assistant", content: [{ type: "text", text: "Missing." }] };
	assert.equal(
		retainedTailEnd([record, edited, { role: "user", content: "Newer." }], 0, [first, missing]),
		undefined,
	);
	assert.equal(retainedTailEnd([record], 0, [first]), undefined);
});
