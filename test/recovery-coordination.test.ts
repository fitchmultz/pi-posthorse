import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryLike, ProjectedEntry } from "../src/contracts.ts";
import { buildAutoHandoff } from "../src/recovery.ts";
import { supersededCoordinationMap } from "../src/recovery-coordination.ts";

function projectEntries(
	entries: readonly EntryLike[],
	omittedIds: ReadonlySet<string> = new Set(),
): ProjectedEntry[] {
	return entries.flatMap((sourceEntry): ProjectedEntry[] => {
		if (sourceEntry.id !== undefined && omittedIds.has(sourceEntry.id)) {
			return [{ sourceEntry, messages: [] }];
		}
		if (sourceEntry.type === "message" && sourceEntry.message !== undefined) {
			return [{ sourceEntry, messages: [sourceEntry.message] }];
		}
		if (sourceEntry.type === "custom_message") {
			return [
				{
					sourceEntry,
					messages: [
						{
							role: "custom",
							customType: sourceEntry.customType,
							content: sourceEntry.content,
							details: sourceEntry.details,
						},
					],
				},
			];
		}
		return [];
	});
}

function ownerEntry(id: string, text: string): EntryLike {
	return {
		type: "message",
		id,
		timestamp: "2026-11-16T10:00:00Z",
		message: { role: "user", content: text },
	};
}

function toolPair(
	callEntryId: string,
	resultEntryId: string,
	callId: string,
	toolName: string,
	args: Readonly<Record<string, unknown>>,
	result: {
		readonly details?: unknown;
		readonly content?: string;
		readonly isError?: boolean;
	},
): EntryLike[] {
	return [
		{
			type: "message",
			id: callEntryId,
			timestamp: "2026-11-16T10:01:00Z",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: callId, name: toolName, arguments: args }],
			},
		},
		{
			type: "message",
			id: resultEntryId,
			timestamp: "2026-11-16T10:01:01Z",
			message: {
				role: "toolResult",
				toolName,
				toolCallId: callId,
				isError: result.isError === true,
				content: result.content ?? JSON.stringify(result.details ?? {}),
				details: result.details,
			},
		},
	];
}

function bgCompleteEntry(
	id: string,
	jobs: readonly {
		readonly id: string;
		readonly status: string;
		readonly exitCode?: number;
		readonly commandPreview?: string;
		readonly tail?: string;
	}[],
): EntryLike {
	const blocks = jobs.map((job) => {
		const summary = JSON.stringify({
			id: job.id,
			status: job.status,
			exitCode: job.exitCode ?? (job.status === "succeeded" ? 0 : 1),
			commandPreview: job.commandPreview ?? "",
		});
		return job.tail === undefined ? summary : `${summary}\nOutput tail:\n${job.tail}`;
	});
	return {
		type: "custom_message",
		id,
		timestamp: "2026-11-16T10:02:00Z",
		customType: "background-command-complete",
		display: true,
		details: {
			jobIds: jobs.map((job) => job.id),
			jobs: jobs.map(({ id: jobId, status }) => ({ id: jobId, status })),
		},
		content: `Background commands finished:\n${blocks.join("\n\n")}`,
	};
}

function customEntry(
	id: string,
	customType: string,
	content: string,
	details?: unknown,
): EntryLike {
	return {
		type: "custom_message",
		id,
		timestamp: "2026-11-16T10:02:00Z",
		customType,
		display: true,
		content,
		details,
	};
}

await test("watch-pr failed notice is superseded by later succeeded notice without output tail and demoted in handoff", () => {
	const entries: EntryLike[] = [
		ownerEntry("u1", "Fix PR 42 and wait for checks."),
		bgCompleteEntry("bg-fail", [
			{
				id: "job-1",
				status: "failed",
				exitCode: 3,
				commandPreview:
					"node /skills/watch-pr/scripts/watch-pr.mjs https://github.com/FitchMultz/Pi-Posthorse/pull/42 --interval 60",
				tail: "BLOCKED: 1 unresolved review thread\npr: https://github.com/FitchMultz/Pi-Posthorse/pull/42",
			},
		]),
		bgCompleteEntry("bg-pass", [
			{
				id: "job-2",
				status: "succeeded",
				exitCode: 0,
				commandPreview:
					"node /skills/watch-pr/scripts/watch-pr.mjs --repo fitchmultz/pi-posthorse 42 --timeout 3600",
			},
		]),
	];
	const retained = new Set(["bg-pass"]);
	const projected = projectEntries(entries);
	const map = supersededCoordinationMap(entries, projected, { retained });
	assert.deepEqual(map.get("bg-fail"), { byEntryId: "bg-pass", inRetainedTail: true });
	assert.equal(map.get("bg-pass"), undefined);

	const handoff = buildAutoHandoff(entries, projected, 20_000, {
		ownerQuestionRegistered: false,
		retainedEntryIds: retained,
	});
	assert.match(
		handoff,
		/Other current-window inputs, oldest first \(recover with history read\):\n\[visible background-command-complete coordination input \(not direct owner input\); superseded by entry bg-pass in retained tail \| 2026-11-16T10:02:00Z \| entry bg-fail\]/,
	);
	assert.doesNotMatch(handoff, /BLOCKED: 1 unresolved review thread/);
});

await test("watch-pr notice is superseded by non-error background_command start for same PR and by terminal status/cancel", () => {
	const entries: EntryLike[] = [
		ownerEntry("u1", "Watch PR 99."),
		bgCompleteEntry("bg-fail-1", [
			{
				id: "job-a",
				status: "failed",
				exitCode: 4,
				commandPreview: "node /skills/watch-pr/scripts/watch-pr.mjs 99",
				tail: "BLOCKED: checks failed\npr: https://github.com/owner/repo/pull/99",
			},
		]),
		...toolPair(
			"start-call",
			"start-res",
			"c1",
			"background_command",
			{
				action: "start",
				command:
					"node /skills/watch-pr/scripts/watch-pr.mjs --repo OWNER/REPO --interval 60 99 --timeout 3600",
			},
			{
				details: {
					id: "job-b",
					status: "starting",
					command:
						"node /skills/watch-pr/scripts/watch-pr.mjs --repo OWNER/REPO --interval 60 99 --timeout 3600",
					cwd: "/repo",
				},
			},
		),
		bgCompleteEntry("bg-other", [
			{ id: "job-c", status: "failed", exitCode: 1, commandPreview: "npm test" },
		]),
		...toolPair(
			"status-call",
			"status-res",
			"c2",
			"background_command",
			{ action: "status", id: "job-c" },
			{ details: { id: "job-c", status: "failed", exitCode: 1 } },
		),
		bgCompleteEntry("bg-cancel-target", [
			{ id: "job-d", status: "unknown", exitCode: 1, commandPreview: "npm run watch" },
		]),
		...toolPair(
			"cancel-call",
			"cancel-res",
			"c3",
			"background_command",
			{ action: "cancel", id: "job-d" },
			{ details: { id: "job-d", status: "cancelled" } },
		),
	];
	const map = supersededCoordinationMap(entries, projectEntries(entries), {
		retained: new Set(["cancel-res"]),
	});
	assert.deepEqual(map.get("bg-fail-1"), { byEntryId: "start-res", inRetainedTail: false });
	assert.deepEqual(map.get("bg-other"), { byEntryId: "status-res", inRetainedTail: false });
	assert.deepEqual(map.get("bg-cancel-target"), {
		byEntryId: "cancel-res",
		inRetainedTail: true,
	});
});

await test("exact (cwd, trimmedCommand) from earlier start receipts supersedes across windows but never on different cwd/command or without start receipt", () => {
	const earlierCompaction: EntryLike = {
		type: "compaction",
		id: "comp-1",
		summary: "Automatic context rollover recovery record.",
		firstKeptEntryId: null,
		details: { posthorse: 1, reason: "threshold" },
	};
	const entries: EntryLike[] = [
		...toolPair(
			"s1-call",
			"s1-res",
			"s1",
			"background_command",
			{ action: "start", command: "npm test" },
			{ details: { id: "j1", status: "starting", command: "  npm test  ", cwd: "/repo/a" } },
		),
		earlierCompaction,
		ownerEntry("u1", "Run tests."),
		bgCompleteEntry("bg-1", [{ id: "j1", status: "failed", commandPreview: "npm test" }]),
		...toolPair(
			"s2-call",
			"s2-res",
			"s2",
			"background_command",
			{ action: "start", command: "npm test" },
			{ details: { id: "j2", status: "starting", command: "npm test", cwd: "/repo/b" } },
		),
		bgCompleteEntry("bg-diff-cwd", [
			{ id: "j2", status: "succeeded", commandPreview: "npm test" },
		]),
		...toolPair(
			"s3-call",
			"s3-res",
			"s3",
			"background_command",
			{ action: "start", command: "npm run lint" },
			{ details: { id: "j3", status: "starting", command: "npm run lint", cwd: "/repo/a" } },
		),
		bgCompleteEntry("bg-diff-cmd", [
			{ id: "j3", status: "succeeded", commandPreview: "npm run lint" },
		]),
		bgCompleteEntry("bg-no-start-1", [
			{ id: "j-nostart-1", status: "failed", commandPreview: "npm run verify" },
		]),
		bgCompleteEntry("bg-no-start-2", [
			{ id: "j-nostart-2", status: "succeeded", commandPreview: "npm run verify" },
		]),
	];
	// Before matching (cwd, command) completes, bg-1 is NOT superseded by different cwd or command.
	const beforeMatch = supersededCoordinationMap(entries, projectEntries(entries), {
		retained: new Set(),
	});
	assert.equal(beforeMatch.get("bg-1"), undefined);
	assert.equal(beforeMatch.get("bg-no-start-1"), undefined);

	// Starting the exact same (cwd, command) alone does NOT supersede bg-1 until it completes.
	const withSameStart: EntryLike[] = [
		...entries,
		...toolPair(
			"s4-call",
			"s4-res",
			"s4",
			"background_command",
			{ action: "start", command: "npm test" },
			{ details: { id: "j4", status: "starting", command: "npm test", cwd: "/repo/a" } },
		),
	];
	assert.equal(
		supersededCoordinationMap(withSameStart, projectEntries(withSameStart), {
			retained: new Set(),
		}).get("bg-1"),
		undefined,
	);

	// Once j4 completes, bg-1 IS superseded by bg-match.
	const withCompletion: EntryLike[] = [
		...withSameStart,
		bgCompleteEntry("bg-match", [
			{ id: "j4", status: "succeeded", commandPreview: "npm test" },
		]),
	];
	assert.deepEqual(
		supersededCoordinationMap(withCompletion, projectEntries(withCompletion), {
			retained: new Set(["bg-match"]),
		}).get("bg-1"),
		{ byEntryId: "bg-match", inRetainedTail: true },
	);
});

await test("multi-job background batch is superseded only when every job in the batch is superseded", () => {
	const base: EntryLike[] = [
		ownerEntry("u1", "Watch two PRs."),
		bgCompleteEntry("bg-batch", [
			{
				id: "j-pr1",
				status: "failed",
				commandPreview: "node .../watch-pr.mjs https://github.com/o/r/pull/1",
				tail: "pr: https://github.com/o/r/pull/1",
			},
			{
				id: "j-pr2",
				status: "failed",
				commandPreview: "node .../watch-pr.mjs https://github.com/o/r/pull/2",
				tail: "pr: https://github.com/o/r/pull/2",
			},
		]),
		bgCompleteEntry("bg-pr1-ok", [
			{
				id: "j-pr1-new",
				status: "succeeded",
				commandPreview: "node .../watch-pr.mjs https://github.com/o/r/pull/1",
			},
		]),
	];
	assert.equal(
		supersededCoordinationMap(base, projectEntries(base), { retained: new Set() }).get(
			"bg-batch",
		),
		undefined,
	);

	const complete: EntryLike[] = [
		...base,
		bgCompleteEntry("bg-pr2-ok", [
			{
				id: "j-pr2-new",
				status: "succeeded",
				commandPreview: "node .../watch-pr.mjs https://github.com/o/r/pull/2",
			},
		]),
	];
	assert.deepEqual(
		supersededCoordinationMap(complete, projectEntries(complete), {
			retained: new Set(["bg-pr2-ok"]),
		}).get("bg-batch"),
		{ byEntryId: "bg-pr2-ok", inRetainedTail: true },
	);
});

await test("agent-escalation and agent-completion follow exact supersession rules", () => {
	const entries: EntryLike[] = [
		ownerEntry("u1", "Coordinate subagents."),
		customEntry("esc-1", "agent-escalation", "Paused run-1", { id: "run-1" }),
		customEntry("esc-2", "agent-escalation", "Paused run-2", { id: "run-2" }),
		customEntry("esc-3", "agent-escalation", "Paused run-3", { id: "run-3" }),
		customEntry("esc-4", "agent-escalation", "Paused run-4", { id: "run-4" }),
		customEntry("esc-no-id", "agent-escalation", "Missing id", {}),
		customEntry("comp-1", "agent-completion", "Done run-1", { id: "run-1" }),
		customEntry("comp-5", "agent-completion", "Done run-5", { id: "run-5" }),
		customEntry("comp-6", "agent-completion", "Done run-6", { id: "run-6" }),
		customEntry("comp-7", "agent-completion", "Done run-7", { id: "run-7" }),
		// run-2 superseded by later escalation; run-3 by review(approved); run-4 by stop.
		customEntry("esc-2b", "agent-escalation", "Paused run-2 again", { id: "run-2" }),
		...toolPair(
			"rev3-call",
			"rev3-res",
			"r3",
			"agent_runs",
			{ action: "review", id: "run-3", verdict: "approved", summary: "ok" },
			{ content: "Approved" },
		),
		...toolPair(
			"stop4-call",
			"stop4-res",
			"r4",
			"agent_runs",
			{ action: "stop", id: "run-4" },
			{ content: "Stopped" },
		),
		// run-1 completion superseded by continue; run-5 by review(changes_requested).
		...toolPair(
			"cont1-call",
			"cont1-res",
			"r1",
			"agent_runs",
			{ action: "continue", id: "run-1", prompt: "Fix tests" },
			{ content: "Continued" },
		),
		...toolPair(
			"rev5-call",
			"rev5-res",
			"r5",
			"agent_runs",
			{ action: "review", id: "run-5", verdict: "changes_requested", summary: "Fix" },
			{ content: "Requested changes" },
		),
		// Negative checks: approved review and stop do NOT supersede agent-completion; inspect does NOT supersede escalation.
		...toolPair(
			"rev6-call",
			"rev6-res",
			"r6",
			"agent_runs",
			{ action: "review", id: "run-6", verdict: "approved", summary: "LGTM" },
			{ content: "Approved" },
		),
		...toolPair(
			"stop7-call",
			"stop7-res",
			"r7",
			"agent_runs",
			{ action: "stop", id: "run-7" },
			{ content: "Stopped" },
		),
		...toolPair(
			"insp2-call",
			"insp2-res",
			"r2i",
			"agent_runs",
			{ action: "inspect", id: "run-2" },
			{ content: "Inspected" },
		),
	];
	const map = supersededCoordinationMap(entries, projectEntries(entries), {
		retained: new Set(["rev5-res"]),
	});
	// esc-1 is superseded by both comp-1 and cont1-res; latest wins (cont1-res).
	assert.deepEqual(map.get("esc-1"), { byEntryId: "cont1-res", inRetainedTail: false });
	assert.deepEqual(map.get("esc-2"), { byEntryId: "esc-2b", inRetainedTail: false });
	assert.equal(map.get("esc-2b"), undefined);
	assert.deepEqual(map.get("esc-3"), { byEntryId: "rev3-res", inRetainedTail: false });
	assert.deepEqual(map.get("esc-4"), { byEntryId: "stop4-res", inRetainedTail: false });
	assert.equal(map.get("esc-no-id"), undefined);
	assert.deepEqual(map.get("comp-1"), { byEntryId: "cont1-res", inRetainedTail: false });
	assert.deepEqual(map.get("comp-5"), { byEntryId: "rev5-res", inRetainedTail: true });
	assert.equal(map.get("comp-6"), undefined);
	assert.equal(map.get("comp-7"), undefined);
});

await test("zero-false-positive guards: different PR, error toolResult, context-edited superseder, and non-coordination types", () => {
	const entries: EntryLike[] = [
		ownerEntry("u1", "Check guards."),
		bgCompleteEntry("bg-pr42", [
			{
				id: "j42",
				status: "failed",
				commandPreview: "node .../watch-pr.mjs https://github.com/o/r/pull/42",
				tail: "pr: https://github.com/o/r/pull/42",
			},
		]),
		// Different PR number
		bgCompleteEntry("bg-pr43", [
			{
				id: "j43",
				status: "succeeded",
				commandPreview: "node .../watch-pr.mjs https://github.com/o/r/pull/43",
			},
		]),
		// Error start for PR 42 must NOT supersede
		...toolPair(
			"err-start-call",
			"err-start-res",
			"es1",
			"background_command",
			{
				action: "start",
				command: "node .../watch-pr.mjs https://github.com/o/r/pull/42",
			},
			{ isError: true, content: "Failed to start" },
		),
		// Non-terminal status for j42 must NOT supersede
		...toolPair(
			"run-status-call",
			"run-status-res",
			"rs1",
			"background_command",
			{ action: "status", id: "j42" },
			{ details: { id: "j42", status: "running" } },
		),
		// Context-edited (omitted) later completion for PR 42 must NOT supersede
		bgCompleteEntry("bg-pr42-omitted", [
			{
				id: "j42-later",
				status: "succeeded",
				commandPreview: "node .../watch-pr.mjs https://github.com/o/r/pull/42",
			},
		]),
		// Non-watch-pr command mentioning PR 42 URL must NOT supersede
		bgCompleteEntry("bg-non-watch", [
			{
				id: "j-echo",
				status: "succeeded",
				commandPreview: "echo https://github.com/o/r/pull/42",
			},
		]),
		// Agent escalation with error agent_runs must NOT supersede
		customEntry("esc-err", "agent-escalation", "Paused", { id: "run-err" }),
		...toolPair(
			"err-run-call",
			"err-run-res",
			"er1",
			"agent_runs",
			{ action: "continue", id: "run-err", prompt: "Retry" },
			{ isError: true, content: "Run not found" },
		),
		// Never-superseded customTypes
		customEntry("ic-1", "intercom_message", "Hello", { id: "same" }),
		customEntry("ic-2", "intercom_message", "Hello again", { id: "same" }),
		customEntry("cm-1", "codemode-background", "Done 1", { id: "same" }),
		customEntry("cm-2", "codemode-background", "Done 2", { id: "same" }),
		customEntry("unk-1", "custom-alert", "Alert 1", { id: "same" }),
		customEntry("unk-2", "custom-alert", "Alert 2", { id: "same" }),
	];
	const projected = projectEntries(entries, new Set(["bg-pr42-omitted"]));
	const map = supersededCoordinationMap(entries, projected, { retained: new Set() });
	assert.equal(map.size, 0);
});

await test("anchors promotes still-active earlier failure to fixed when later coordination event is superseded", () => {
	const entries: EntryLike[] = [
		ownerEntry("u1", "Ship PR 1 and PR 2."),
		bgCompleteEntry("bg-active-failure", [
			{
				id: "j-active",
				status: "failed",
				exitCode: 4,
				commandPreview: "node .../watch-pr.mjs https://github.com/o/r/pull/1",
				tail: "ACTIVE_FAILURE_PR1\npr: https://github.com/o/r/pull/1",
			},
		]),
		bgCompleteEntry("bg-stale-failure", [
			{
				id: "j-stale",
				status: "failed",
				exitCode: 3,
				commandPreview: "node .../watch-pr.mjs https://github.com/o/r/pull/2",
				tail: "STALE_FAILURE_PR2\npr: https://github.com/o/r/pull/2",
			},
		]),
		bgCompleteEntry("bg-pr2-pass", [
			{
				id: "j-pr2-pass",
				status: "succeeded",
				exitCode: 0,
				commandPreview: "node .../watch-pr.mjs https://github.com/o/r/pull/2",
			},
		]),
	];
	const handoff = buildAutoHandoff(entries, projectEntries(entries), 20_000, {
		ownerQuestionRegistered: false,
		retainedEntryIds: new Set(["bg-pr2-pass"]),
	});
	// Active earlier failure is promoted to fixed (full body quoted); stale later failure is demoted to others.
	assert.match(handoff, /ACTIVE_FAILURE_PR1/);
	assert.doesNotMatch(handoff, /STALE_FAILURE_PR2/);
	assert.match(
		handoff,
		/Other current-window inputs, oldest first \(recover with history read\):\n\[visible background-command-complete coordination input \(not direct owner input\); superseded by entry bg-pr2-pass in retained tail \| 2026-11-16T10:02:00Z \| entry bg-stale-failure\]/,
	);
});
