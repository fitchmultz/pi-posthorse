import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryLike, PolicyContext } from "../src/contracts.ts";
import {
	SUPPRESSED_REMINDER_TYPE,
	createReminderLookup,
	persistSuppressedReminders,
	reminderFilter,
	reminderFingerprint,
	staleReminderPredicate,
	type ContextMessage,
	type ReminderLookup,
} from "../src/reminders.ts";

const fingerprint = { windowId: "window-1", contextWindow: 100_000, reserveTokens: 16_384 };
function reminder(details: unknown): ContextMessage {
	return { role: "custom", customType: "posthorse-reminder", details };
}
function host(options: { readonly enabled?: boolean; readonly usage?: boolean } = {}) {
	const policy: PolicyContext = {
		getCompactionSettings: () => ({ enabled: options.enabled ?? true, reserveTokens: 16_384 }),
		getContextUsage: () =>
			options.usage === false
				? undefined
				: { tokens: 10_000, contextWindow: 100_000, percent: 10 },
		getSystemPrompt: () => "Synthetic reminder policy",
	};
	return policy;
}
function lookup(windowId: string): ReminderLookup {
	return {
		read: () => ({ windowId, reminders: [], suppressedIds: new Set() }),
		reset: () => {
			// The fake cache holds no state to drop.
		},
	};
}
const ctx = { sessionManager: {} };

await test("a context without reminders never filters a message", () => {
	const stale = staleReminderPredicate([{ role: "user" }], ctx, host(), lookup("window-1"));
	assert.equal(stale(reminder({ windowId: "old" })), false);
});

await test("a reminder for the current window and budget survives; another window's does not", () => {
	const current = reminder(fingerprint);
	const other = reminder({ ...fingerprint, windowId: "window-0" });
	const stale = staleReminderPredicate([current, other], ctx, host(), lookup("window-1"));
	assert.equal(stale(current), false);
	assert.equal(stale(other), true);
	assert.equal(stale({ role: "user" }), false);
});

await test("a projected display marker names the window ahead of the journal scan", () => {
	const marker: ContextMessage = {
		role: "custom",
		customType: "context-window",
		details: { windowId: "window-2" },
	};
	const current = reminder({ ...fingerprint, windowId: "window-2" });
	const previous = reminder(fingerprint);
	const stale = staleReminderPredicate([marker, current], ctx, host(), lookup("window-1"));
	assert.equal(stale(current), false);
	assert.equal(stale(previous), true);
});

await test("a marker without a usable window id leaves every reminder alone", () => {
	const marker: ContextMessage = { role: "custom", customType: "context-window" };
	const stale = staleReminderPredicate(
		[marker, reminder(fingerprint)],
		ctx,
		host(),
		lookup("window-1"),
	);
	assert.equal(stale(reminder({ ...fingerprint, windowId: "window-0" })), false);
	assert.equal(reminderFingerprint(ctx, host(), lookup("window-1"), [marker]), undefined);
});

await test("disabled compaction makes every reminder stale", () => {
	for (const usage of [true, false]) {
		const stale = staleReminderPredicate(
			[reminder(fingerprint)],
			ctx,
			host({ enabled: false, usage }),
			lookup("window-1"),
		);
		assert.equal(stale(reminder(fingerprint)), true);
		assert.equal(stale(reminder({ ...fingerprint, windowId: "window-0" })), true);
	}
});

await test("already-sent current-window reminders stay in place across budget or setting changes", () => {
	const earlier = reminder({ ...fingerprint, contextWindow: 272_000 });
	const trailing = reminder({ ...fingerprint, contextWindow: 272_000 });
	const messages: ContextMessage[] = [
		{ role: "system" },
		{ role: "user" },
		earlier,
		{ role: "assistant" },
		trailing,
		{ role: "user" },
	];
	for (const policy of [host(), host({ enabled: false })]) {
		const { stale, removable } = reminderFilter(messages, ctx, policy, lookup("window-1"));
		assert.equal(stale(earlier), true);
		assert.equal(stale(trailing), true);
		assert.equal(
			removable(earlier, 2),
			false,
			"a current-window reminder before an assistant reply is part of the sent prefix",
		);
		assert.equal(
			removable(trailing, 4),
			true,
			"a stale reminder in the trailing unsent tail after the last assistant reply is removable",
		);
	}
});

await test("ended-window reminders are removable without a provider summary block and held with one", () => {
	const old = reminder({ ...fingerprint, windowId: "window-0" });
	const withoutBlock: ContextMessage[] = [
		{ role: "system" },
		{ role: "compactionSummary" },
		old,
		{ role: "assistant" },
		{ role: "user" },
	];
	const unheld = reminderFilter(withoutBlock, ctx, host(), lookup("window-1"));
	assert.equal(unheld.stale(old), true);
	assert.equal(
		unheld.removable(old, 2),
		true,
		"an ended-window reminder was never part of the new window's prefix",
	);

	const withBlock = [
		{
			role: "system",
			providerSummary: {
				provider: "faux",
				api: "faux",
				model: "faux-1",
				block: { text: "one line" },
			},
		},
		old,
		{ role: "assistant" },
		{ role: "compactionSummary" },
		{ role: "user" },
	];
	const held = reminderFilter(withBlock, ctx, host(), lookup("window-1"));
	assert.equal(held.stale(old), true);
	assert.equal(
		held.removable(old, 1),
		false,
		"a provider summary block holds every message before the recovery record",
	);
});

await test("suppressing a trailing stale reminder stays durable across later replies, re-enabling, and branch changes", () => {
	const entries: EntryLike[] = [];
	const append = (entry: EntryLike, parentId: string | null = entries.at(-1)?.id ?? null) => {
		const owned: EntryLike = { ...entry, parentId };
		entries.push(owned);
		return owned;
	};
	let leafId: string | null = null;
	const appendAtLeaf = (entry: EntryLike) => {
		const added = append(entry, leafId);
		leafId = added.id ?? null;
		return added;
	};
	const journalCtx = {
		sessionManager: {
			getSessionId: () => "session-suppressed",
			getSessionFile: () => "/tmp/suppressed.jsonl",
			getLeafId: () => leafId,
			getEntry: (id: string) => entries.find((entry) => entry.id === id),
		},
	};
	const recorded: { readonly type: string; readonly data: unknown }[] = [];
	const pi = {
		appendEntry(type: string, data: unknown) {
			recorded.push({ type, data });
			appendAtLeaf({
				type: "custom",
				id: `c${entries.length + 1}`,
				customType: type,
				data,
			});
		},
	};
	const reminders = createReminderLookup();
	const currentFingerprint = {
		windowId: "initial",
		contextWindow: 100_000,
		reserveTokens: 16_384,
	};
	const earlierReminder: ContextMessage = {
		role: "custom",
		customType: "posthorse-reminder",
		content: "EARLIER_SENT",
		details: currentFingerprint,
	};
	const trailingReminder: ContextMessage = {
		role: "custom",
		customType: "posthorse-reminder",
		content: "TRAILING_UNSENT",
		details: currentFingerprint,
	};
	appendAtLeaf({ type: "message", id: "u1", message: { role: "user", content: "one" } });
	appendAtLeaf({
		type: "custom_message",
		id: "r1",
		customType: "posthorse-reminder",
		content: "EARLIER_SENT",
		details: currentFingerprint,
	});
	appendAtLeaf({ type: "message", id: "a1", message: { role: "assistant", content: "reply 1" } });
	const beforeSuppressLeaf = appendAtLeaf({
		type: "custom_message",
		id: "r2",
		customType: "posthorse-reminder",
		content: "TRAILING_UNSENT",
		details: currentFingerprint,
	}).id;
	appendAtLeaf({ type: "message", id: "u2", message: { role: "user", content: "two" } });

	const req1Messages: ContextMessage[] = [
		{ role: "system" },
		{ role: "user" },
		earlierReminder,
		{ role: "assistant" },
		trailingReminder,
		{ role: "user" },
	];
	const first = reminderFilter(req1Messages, journalCtx, host({ enabled: false }), reminders);
	assert.equal(first.removable(earlierReminder, 2), false, "already-sent earlier reminder stays");
	assert.equal(first.removable(trailingReminder, 4), true, "trailing stale reminder is dropped");
	assert.deepEqual(first.newlySuppressedIds, ["r2"]);
	persistSuppressedReminders(pi, journalCtx, reminders, first.newlySuppressedIds);
	assert.equal(recorded.length, 1);
	assert.equal(recorded[0]?.type, SUPPRESSED_REMINDER_TYPE);

	// After the model replies to request 1, r2 is no longer in the trailing tail (index 4 < lastAssistant 6).
	appendAtLeaf({ type: "message", id: "a2", message: { role: "assistant", content: "reply 2" } });
	appendAtLeaf({ type: "message", id: "u3", message: { role: "user", content: "three" } });
	const req2Messages: ContextMessage[] = [
		...req1Messages,
		{ role: "assistant" },
		{ role: "user" },
	];
	for (const enabled of [false, true]) {
		const next = reminderFilter(req2Messages, journalCtx, host({ enabled }), reminders);
		assert.equal(next.removable(earlierReminder, 2), false, "r1 remains kept");
		assert.equal(
			next.removable(trailingReminder, 4),
			true,
			`r2 stays suppressed after a2 even when enabled=${enabled}`,
		);
		assert.deepEqual(
			next.newlySuppressedIds,
			[],
			"already-suppressed r2 writes no duplicate marker",
		);
	}
	assert.equal(recorded.length, 1);

	// Navigating via /tree to a sibling branch before suppression leaves r2 unsuppressed there.
	leafId = beforeSuppressLeaf ?? null;
	reminders.reset();
	appendAtLeaf({ type: "message", id: "a2-alt", message: { role: "assistant", content: "alt" } });
	const sibling = reminderFilter(
		[
			{ role: "system" },
			{ role: "user" },
			earlierReminder,
			{ role: "assistant" },
			trailingReminder,
			{ role: "assistant" },
		],
		journalCtx,
		host({ enabled: false }),
		reminders,
	);
	assert.equal(sibling.removable(trailingReminder, 4), false);
});
