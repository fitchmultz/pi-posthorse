import assert from "node:assert/strict";
import { test } from "node:test";
import { createEpochCache } from "../src/epoch-cache.ts";
import type { EntryLike } from "../src/contracts.ts";
import type { SessionHost } from "../src/host.ts";

/** A session whose leaf moves when a caller appends, without reusing entry objects. */
function session(entries: readonly EntryLike[], sessionId = "session-1") {
	const host = {
		getSessionId: () => sessionId,
		getSessionFile: () => "/tmp/session.jsonl",
		getLeafId: () => entries.at(-1)?.id ?? null,
		getEntry: (id: string) => entries.find((entry) => entry.id === id),
	};
	return { sessionManager: host };
}

await test("an unchanged leaf reuses the cached value", () => {
	let computed = 0;
	const cache = createEpochCache<number>(() => {
		computed += 1;
		return computed;
	});
	const ctx = session([{ type: "message", id: "a" }]);
	assert.equal(cache.read(ctx), 1);
	assert.equal(cache.read(ctx), 1);
	assert.equal(computed, 1);
});

await test("a new leaf recomputes and can extend the previous value by entry identity", () => {
	const first: EntryLike = { type: "message", id: "a" };
	const appended: EntryLike = { type: "message", id: "b", parentId: "a" };
	const entries: EntryLike[] = [first];
	const ctx = session(entries);
	const cache = createEpochCache<readonly string[]>((_ctx, identity, previous) =>
		previous === undefined || previous.identity.leaf !== first
			? [`fresh:${identity.leaf?.id ?? "none"}`]
			: [...previous.value, `extended:${identity.leaf?.id ?? "none"}`],
	);
	assert.deepEqual(cache.read(ctx), ["fresh:a"]);
	entries.push(appended);
	assert.deepEqual(cache.read(ctx), ["fresh:a", "extended:b"]);
	assert.deepEqual(cache.read(ctx), ["fresh:a", "extended:b"]);
});

await test("a different session or manager resets the cached value", () => {
	let computed = 0;
	const cache = createEpochCache<number>(() => {
		computed += 1;
		return computed;
	});
	const entries = [{ type: "message", id: "a" }];
	assert.equal(cache.read(session(entries)), 1);
	assert.equal(cache.read(session(entries, "session-2")), 2);
	const replacement: { sessionManager: SessionHost } = {
		sessionManager: { getSessionId: () => "session-2", getLeafId: () => "a" },
	};
	assert.equal(cache.read(replacement), 3);
	cache.reset();
	assert.equal(cache.read(replacement), 4);
});
