import assert from "node:assert/strict";
import { test } from "node:test";
import { journalRetainedIds, retainedSpan } from "../src/retained-tail.ts";

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
