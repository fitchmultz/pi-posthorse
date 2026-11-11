import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_HANDOFF_PREFIX } from "../src/contracts.ts";
import {
	activeBoundaryIndex,
	chainsAncestry,
	classifyBoundary,
	contextStart,
	isWindow,
	startsFreshGuidanceEpoch,
} from "../src/boundary.ts";

const automaticSummary = `${AUTO_HANDOFF_PREFIX}\nRecovered inputs.`;
const block = { providerSummary: { block: { text: "one line" } } };

await test("a fork context window is a window and chains only with an automatic record", () => {
	const opened = classifyBoundary({
		type: "context_window",
		id: "w1",
		handoff: automaticSummary,
	});
	assert.deepEqual(opened, {
		kind: "fork",
		window: true,
		chainsAncestry: true,
		freshGuidance: true,
	});
	assert.equal(
		classifyBoundary({ type: "context_window", id: "w2", handoff: "Manual handoff" })
			?.chainsAncestry,
		false,
	);
});

await test("a native compaction is not a Posthorse window but starts a guidance epoch", () => {
	const plain = classifyBoundary({ type: "compaction", id: "c1", summary: "Native summary" });
	assert.deepEqual(plain, {
		kind: "native",
		window: false,
		chainsAncestry: false,
		freshGuidance: true,
	});
	assert.equal(isWindow({ type: "compaction", id: "c1" }), false);
	const blocked = classifyBoundary({
		type: "compaction",
		id: "c2",
		summary: "Native summary",
		...block,
	});
	assert.equal(blocked?.freshGuidance, false);
});

await test("automatic, explicit, and unrecognized Posthorse compactions stay distinct", () => {
	const automatic = classifyBoundary({
		type: "compaction",
		id: "c1",
		summary: automaticSummary,
		details: { posthorse: 1, reason: "threshold" },
	});
	assert.deepEqual(automatic, {
		kind: "automatic",
		window: true,
		chainsAncestry: true,
		freshGuidance: true,
	});
	const unmarked = classifyBoundary({
		type: "compaction",
		id: "c2",
		summary: "Handoff",
		details: { posthorse: 1, reason: "threshold" },
	});
	assert.equal(unmarked?.chainsAncestry, false);
	assert.deepEqual(
		classifyBoundary({
			type: "compaction",
			id: "c3",
			summary: automaticSummary,
			details: { posthorse: 1, reason: "explicit" },
		}),
		{ kind: "explicit", window: true, chainsAncestry: false, freshGuidance: true },
	);
	assert.deepEqual(
		classifyBoundary({
			type: "compaction",
			id: "c4",
			summary: "Future reason",
			details: { posthorse: 1, reason: "schedule" },
		}),
		{ kind: "posthorse", window: true, chainsAncestry: false, freshGuidance: true },
	);
});

await test("ordinary entries are not boundaries", () => {
	const message = { type: "message", id: "m1" };
	assert.equal(classifyBoundary(message), undefined);
	assert.equal(classifyBoundary(), undefined);
	assert.equal(isWindow(message), false);
	assert.equal(chainsAncestry(), false);
	assert.equal(startsFreshGuidanceEpoch(message), false);
});

await test("the applied boundary is the compaction with a visible tail", () => {
	const message = { type: "message", id: "m1" };
	const empty = { type: "compaction", id: "c1" };
	const applied = { type: "compaction", id: "c2" };
	assert.equal(
		activeBoundaryIndex([
			{ sourceEntry: message, messages: [{ role: "user" }] },
			{ sourceEntry: empty, messages: [] },
			{ sourceEntry: applied, messages: [{ role: "assistant" }] },
		]),
		2,
	);
	assert.equal(activeBoundaryIndex([{ sourceEntry: message, messages: [] }]), -1);
});

await test("the active window starts after its boundary or at its retained tail", () => {
	const entries = [
		{ type: "message", id: "m1" },
		{ type: "compaction", id: "c1", firstKeptEntryId: "m3" },
		{ type: "message", id: "m2" },
		{ type: "message", id: "m3" },
	];
	assert.deepEqual(contextStart(entries), { start: 3, boundary: entries[1] });
	assert.equal(contextStart([{ type: "message", id: "m1" }]).start, 0);
	const fork = [
		{ type: "message", id: "m1" },
		{ type: "context_window", id: "w1" },
	];
	assert.deepEqual(contextStart(fork), { start: 2, boundary: fork[1] });
});
