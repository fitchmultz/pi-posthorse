import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryLike, PolicyContext } from "../src/contracts.ts";
import type { ToolInfo } from "../src/host.ts";
import {
	WINDOW_GUIDANCE_TYPE,
	createWindowGuidance,
	type GuidanceRegistry,
} from "../src/guidance.ts";

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
