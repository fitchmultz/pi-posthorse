import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ownerQuestionRegistered,
	sessionBranch,
	sessionEntry,
	sessionIdentity,
	sessionProjection,
	toolFacts,
} from "../src/host.ts";

await test("a host that omits session members reports no data instead of throwing", () => {
	const partial = {};
	assert.equal(sessionEntry(partial, "entry-1"), undefined);
	assert.deepEqual(sessionIdentity(partial), { sessionId: "", file: undefined, leaf: undefined });
	assert.equal(sessionBranch(partial), undefined);
	assert.equal(sessionProjection(partial), undefined);
});

await test("session capabilities read the members the host does provide", () => {
	const entry = { type: "message", id: "entry-1" };
	const manager = {
		getEntry: (id: string) => (id === "entry-1" ? entry : undefined),
		getSessionId: () => "session-1",
		getSessionFile: () => "/tmp/session.jsonl",
		getLeafId: () => "entry-1",
		getBranch: () => [entry],
		buildSessionProjection: () => ({ entries: [{ sourceEntry: entry, messages: [] }] }),
	};
	assert.equal(sessionEntry(manager, "entry-1"), entry);
	assert.equal(sessionEntry(manager, ""), undefined);
	assert.deepEqual(sessionIdentity(manager), {
		sessionId: "session-1",
		file: "/tmp/session.jsonl",
		leaf: entry,
	});
	assert.deepEqual(sessionBranch(manager), [entry]);
	assert.deepEqual(sessionProjection(manager), [{ sourceEntry: entry, messages: [] }]);
});

await test("tool facts intersect active names with unnamespaced registrations", () => {
	const pi = {
		getActiveTools: () => ["notes", "history", "ask_question"],
		getAllTools: () => [
			{ name: "notes" },
			{ name: "notes", namespace: "plugin" },
			{ name: "history" },
			{ name: "ask_question", namespace: "other" },
			{ name: "new_context" },
		],
	};
	const facts = toolFacts(pi);
	assert.deepEqual([...facts.active], ["notes", "history", "ask_question"]);
	assert.deepEqual([...facts.unnamespaced], ["notes", "history", "new_context"]);
	assert.deepEqual([...facts.activeUnnamespaced], ["notes", "history"]);
	assert.equal(ownerQuestionRegistered(pi), false);
});
