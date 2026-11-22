import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryLike, PolicyContext } from "../src/contracts.ts";
import type { ToolInfo } from "../src/host.ts";
import {
	WINDOW_GUIDANCE_TYPE,
	createWindowGuidance,
	type GuidanceRegistry,
} from "../src/guidance.ts";
import { resolveGuidancePlacement } from "../src/guidance-placement.ts";

type Recorded = { readonly type: string; readonly data: unknown };

/** A session whose journal grows when entries are appended, without reusing entry objects. */
function session() {
	const entries: EntryLike[] = [];
	const append = (entry: EntryLike): void => {
		entries.push({ ...entry, parentId: entries.at(-1)?.id ?? null });
	};
	const ctx = {
		sessionManager: {
			getSessionId: () => "session-1",
			getSessionFile: () => "/tmp/session.jsonl",
			getLeafId: () => entries.at(-1)?.id ?? null,
			getEntry: (id: string) => entries.find((entry) => entry.id === id),
		},
	};
	return { entries, append, ctx };
}

/** The registry and journal members guidance borrows; appends persist into the journal. */
function piStub(recorded: Recorded[], journal: ReturnType<typeof session>): GuidanceRegistry {
	return {
		appendEntry: (type: string, data: unknown): void => {
			recorded.push({ type, data });
			journal.append({
				type: "custom",
				id: `e${journal.entries.length + 1}`,
				customType: type,
				data,
			});
		},
		getAllTools: (): ToolInfo[] => [],
		getActiveTools: (): string[] => [],
	};
}

function host(contextWindow: number): PolicyContext {
	return {
		getCompactionSettings: () => ({ enabled: true, reserveTokens: 16_384 }),
		getContextUsage: () => ({ tokens: 10_000, contextWindow, percent: 10 }),
		getSystemPrompt: () => "Synthetic guidance policy",
	};
}

await test("a request after delivery reuses the window's text and writes nothing", () => {
	const journal = session();
	const recorded: Recorded[] = [];
	const guidance = createWindowGuidance(piStub(recorded, journal));
	const first = guidance.deliver(journal.ctx, host(100_000));
	assert.equal(recorded.length, 1);
	assert.equal(recorded[0]?.type, WINDOW_GUIDANCE_TYPE);
	// The fork's provider-summary request runs the delivery hook mid-compaction, after the
	// request that reached the rollover threshold already delivered this budget's text. It
	// must reuse that text without another journal write.
	const again = guidance.deliver(journal.ctx, host(100_000));
	assert.equal(again, first);
	assert.equal(recorded.length, 1);
});

await test("a summary-block compaction carries the epoch a mid-compaction delivery wrote", () => {
	const journal = session();
	const recorded: Recorded[] = [];
	const guidance = createWindowGuidance(piStub(recorded, journal));
	const budgetA = host(100_000);
	const budgetB = host(200_000);
	const first = guidance.deliver(journal.ctx, budgetA);
	assert.equal(recorded.length, 1);
	// The model switched budgets mid-compaction: the provider-summary request delivers new text
	// while the boundary is still uncommitted, so the append lands inside the current epoch.
	const switched = guidance.deliver(journal.ctx, budgetB);
	assert.equal(recorded.length, 2);
	// The compaction commits with a provider summary block, which keeps the previous guidance
	// epoch: the next window must reuse the exact bytes both budgets already saw.
	journal.append({
		type: "compaction",
		id: "c1",
		summary: "record",
		firstKeptEntryId: null,
		providerSummary: { block: { text: "one line" } },
	});
	assert.equal(guidance.deliver(journal.ctx, budgetB), switched);
	assert.equal(recorded.length, 2);
	assert.equal(guidance.resolve(journal.ctx, budgetA), first);
});

await test("a compaction without a summary block starts a fresh epoch that re-delivers", () => {
	const journal = session();
	const recorded: Recorded[] = [];
	const guidance = createWindowGuidance(piStub(recorded, journal));
	const budget = host(100_000);
	guidance.deliver(journal.ctx, budget);
	journal.append({ type: "compaction", id: "c1", summary: "record", firstKeptEntryId: null });
	// The rendered text is deterministic, so the bytes may repeat; the fresh epoch carries no
	// saved record and must deliver again by appending a new window-guidance entry.
	const fresh = guidance.deliver(journal.ctx, budget);
	assert.equal(recorded.length, 2);
	assert.equal(guidance.resolve(journal.ctx, budget), fresh);
});

await test("once an assistant reply locks the leading prompt, budget switches become anchored updates", () => {
	const journal = session();
	const recorded: Recorded[] = [];
	const guidance = createWindowGuidance(piStub(recorded, journal));
	const budget272k = host(272_000);
	const budget500k = host(500_000);

	journal.append({ type: "message", id: "u1", message: { role: "user", content: "first" } });
	const initial = guidance.plan(journal.ctx, budget272k);
	assert.equal(initial.leading, initial.current);
	assert.deepEqual(initial.updates, []);
	assert.equal(recorded.length, 1);

	journal.append({
		type: "message",
		id: "a1",
		message: { role: "assistant", content: "reply 1", stopReason: "stop" },
	});
	journal.append({ type: "message", id: "u2", message: { role: "user", content: "second" } });
	const switched = guidance.plan(journal.ctx, budget500k);
	assert.equal(
		switched.leading,
		initial.leading,
		"leading guidance stays locked to the first reply",
	);
	assert.notEqual(switched.current, initial.leading);
	assert.equal(switched.updates.length, 1);
	assert.equal(switched.updates[0]?.text, switched.current);
	assert.equal(recorded.length, 2);

	journal.append({
		type: "message",
		id: "a2",
		message: { role: "assistant", content: "reply 2", stopReason: "stop" },
	});
	journal.append({ type: "message", id: "u3", message: { role: "user", content: "third" } });
	const stayed = guidance.plan(journal.ctx, budget500k);
	assert.equal(stayed.leading, initial.leading);
	assert.equal(stayed.current, switched.current);
	assert.deepEqual(stayed.updates, switched.updates);
	assert.equal(recorded.length, 2, "staying on the switched budget writes no new entry");

	const returned = guidance.plan(journal.ctx, budget272k);
	assert.equal(returned.leading, initial.leading);
	assert.equal(returned.current, initial.leading, "switching back reuses the saved budget bytes");
	assert.equal(returned.updates.length, 2);
	assert.equal(returned.updates[0]?.text, switched.current);
	assert.equal(returned.updates[1]?.text, initial.leading);
	assert.equal(recorded.length, 3);

	journal.append({ type: "compaction", id: "c1", summary: "record", firstKeptEntryId: null });
	journal.append({ type: "message", id: "u4", message: { role: "user", content: "fresh" } });
	const fresh = guidance.plan(journal.ctx, budget500k);
	assert.equal(fresh.leading, fresh.current);
	assert.deepEqual(fresh.updates, []);
	assert.equal(recorded.length, 4);
});

await test("budget switches without an intervening message collapse at the same anchor", () => {
	const journal = session();
	const recorded: Recorded[] = [];
	const guidance = createWindowGuidance(piStub(recorded, journal));
	const budgetA = host(100_000);
	const budgetB = host(272_000);
	const budgetC = host(500_000);

	journal.append({ type: "message", id: "u1", message: { role: "user", content: "first" } });
	const initial = guidance.plan(journal.ctx, budgetA);
	journal.append({
		type: "message",
		id: "a1",
		message: { role: "assistant", content: "reply 1", stopReason: "stop" },
	});
	journal.append({ type: "message", id: "u2", message: { role: "user", content: "second" } });
	const firstSwitch = guidance.plan(journal.ctx, budgetB);
	assert.equal(firstSwitch.updates.length, 1);

	const secondSwitch = guidance.plan(journal.ctx, budgetC);
	assert.equal(secondSwitch.leading, initial.leading);
	assert.equal(secondSwitch.updates.length, 1);
	assert.equal(secondSwitch.updates[0]?.text, secondSwitch.current);

	const reverted = guidance.plan(journal.ctx, budgetA);
	assert.equal(reverted.leading, initial.leading);
	assert.deepEqual(reverted.updates, []);
});

await test("carried guidance under a provider summary block lands after the last compaction summary", () => {
	const lead = {
		role: "system" as const,
		content: "",
		providerSummary: { block: { text: "one line" } },
		timestamp: 1,
	};
	const keptReply = {
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "kept" }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: 2,
	};
	const earlierRecord = {
		role: "compactionSummary" as const,
		summary: "earlier record",
		tokensBefore: 100,
		timestamp: 3,
	};
	const latestRecord = {
		role: "compactionSummary" as const,
		summary: "latest record",
		tokensBefore: 200,
		timestamp: 4,
	};
	const nextUser = { role: "user" as const, content: "continue", timestamp: 5 };
	const messages = [lead, keptReply, earlierRecord, latestRecord, nextUser];
	const projection = [
		{ sourceEntry: { type: "compaction", id: "c2" }, messages: [lead] },
		{ sourceEntry: { type: "message", id: "a1" }, messages: [keptReply] },
		{ sourceEntry: { type: "compaction", id: "c1" }, messages: [earlierRecord] },
		{ sourceEntry: { type: "compaction", id: "c2" }, messages: [latestRecord] },
		{ sourceEntry: { type: "message", id: "u2" }, messages: [nextUser] },
	];
	const placement = resolveGuidancePlacement(
		messages,
		{ sessionManager: { buildSessionProjection: () => ({ entries: projection }) } },
		{
			anchorId: undefined,
			firstPostAnchorId: "u1",
			leading: "guidance A",
			current: "guidance B",
			updates: [{ entryId: "summarized-switch", text: "guidance B" }],
		},
	);
	assert.equal(placement.leading, "guidance A");
	assert.deepEqual(placement.insertions, [{ at: 4, text: "guidance B" }]);
});
