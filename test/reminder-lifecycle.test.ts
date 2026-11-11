import assert from "node:assert/strict";
import { test } from "node:test";
import type { PolicyContext } from "../src/contracts.ts";
import {
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
		read: () => ({ windowId, reminders: [] }),
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
