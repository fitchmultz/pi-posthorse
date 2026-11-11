import assert from "node:assert/strict";
import { test } from "node:test";
import { displayOf, type PosthorseDisplay } from "../src/ui/display.ts";

// The project types every display the app produces, so this list fails to compile when a producer
// shape and the saved-result schema disagree.
const displays: readonly PosthorseDisplay[] = [
	{ kind: "context" },
	{
		kind: "context",
		usage: { tokens: 1_000, contextWindow: 100_000, percent: 1 },
		rollover: "enabled",
		rolloverAt: 84_000,
	},
	{ kind: "context", usage: { tokens: null, contextWindow: 8_192, percent: null } },
	{ kind: "notes-list", count: 0 },
	{
		kind: "notes-search",
		count: 3,
		headerLength: 12,
		page: { offset: 0, end: 400, total: 900 },
		more: true,
	},
	{ kind: "note-read", headerLength: 20, offset: 0, end: 200, total: 900 },
	{ kind: "note-write" },
	{ kind: "note-append" },
	{ kind: "new-context" },
	{ kind: "history-search", entries: [] },
	{
		kind: "history-search",
		entries: [{ headerLength: 60, length: 160 }],
		footerLength: 80,
		more: true,
		skipped: 2,
	},
	{
		kind: "history-read",
		headerLength: 60,
		offset: 0,
		end: 300,
		total: 900,
		imageOffset: 0,
		imageEnd: 1,
		imageTotal: 2,
	},
];

await test("every display the app produces is accepted by the saved-result schema", () => {
	for (const display of displays) {
		assert.deepEqual(displayOf(display), display);
	}
});

await test("an incomplete or unknown display is not trusted", () => {
	for (const value of [
		undefined,
		null,
		"context",
		{},
		{ kind: "future-display" },
		{ kind: "notes-list" },
		{ kind: "notes-list", count: 1, page: { offset: "0", end: 1, total: 1 } },
		{ kind: "note-read", offset: 0, end: 1 },
		{ kind: "history-search", entries: [{}] },
		{ kind: "history-read", headerLength: 1 },
		{ kind: "context", rollover: "sideways" },
	]) {
		assert.equal(displayOf(value), undefined);
	}
});

await test("extra facts do not invalidate an otherwise known display", () => {
	assert.deepEqual(displayOf({ kind: "new-context", extra: true }), {
		kind: "new-context",
		extra: true,
	});
});
