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
		readonly namespace?: string;
	},
): EntryLike[] {
	return [
		{
			type: "message",
			id: callEntryId,
			timestamp: "2026-11-16T10:01:00Z",
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: callId,
						name: toolName,
						namespace: result.namespace,
						arguments: args,
					},
				],
			},
		},
		{
			type: "message",
			id: resultEntryId,
			timestamp: "2026-11-16T10:01:01Z",
			message: {
				role: "toolResult",
				toolName,
				namespace: result.namespace,
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
	options?: {
		readonly details?: unknown;
		readonly hasCustomDetails?: boolean;
	},
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
		details:
			options?.hasCustomDetails === true
				? options.details
				: {
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

await test("background-command-complete is superseded by later notice or targeted single-job status/cancel for the same structured job ID", () => {
	const entries: EntryLike[] = [
		ownerEntry("u1", "Track background jobs."),
		bgCompleteEntry(
			"bg-unknown",
			[{ id: "j1", status: "unknown", tail: "STALE_UNKNOWN_BODY" }],
			{ hasCustomDetails: true, details: { jobIds: ["j1"] } },
		),
		bgCompleteEntry("bg-resolved", [{ id: "j1", status: "succeeded" }], {
			hasCustomDetails: true,
			details: { jobs: [{ id: "j1", status: "succeeded" }] },
		}),
		bgCompleteEntry("bg-status-target", [
			{ id: "j2", status: "failed", tail: "STALE_STATUS_BODY" },
		]),
		...toolPair(
			"status-call",
			"status-res",
			"c2",
			"background_command",
			{ action: "status", id: "j2" },
			{ details: { id: "j2", status: "failed", exitCode: 1 } },
		),
		bgCompleteEntry("bg-cancel-target", [
			{ id: "j3", status: "timed_out", tail: "STALE_CANCEL_BODY" },
		]),
		...toolPair(
			"cancel-call",
			"cancel-res",
			"c3",
			"background_command",
			{ action: "cancel", id: "j3" },
			{ details: { id: "j3", status: "cancelled" } },
		),
	];
	const retained = new Set(["bg-resolved", "cancel-res"]);
	const projected = projectEntries(entries);
	const map = supersededCoordinationMap(entries, projected, { retained });
	assert.deepEqual(map.get("bg-unknown"), { byEntryId: "bg-resolved", inRetainedTail: true });
	assert.equal(map.get("bg-resolved"), undefined);
	assert.deepEqual(map.get("bg-status-target"), {
		byEntryId: "status-res",
		inRetainedTail: false,
	});
	assert.deepEqual(map.get("bg-cancel-target"), {
		byEntryId: "cancel-res",
		inRetainedTail: true,
	});

	const handoff = buildAutoHandoff(entries, projected, 20_000, {
		ownerQuestionRegistered: false,
		retainedEntryIds: retained,
	});
	assert.match(
		handoff,
		/\[visible background-command-complete coordination input \(not direct owner input\); superseded by entry bg-resolved in retained tail \| 2026-11-16T10:02:00Z \| entry bg-unknown\]/,
	);
	assert.match(
		handoff,
		/\[visible background-command-complete coordination input \(not direct owner input\); superseded by later entry status-res \| 2026-11-16T10:02:00Z \| entry bg-status-target\]/,
	);
	assert.match(
		handoff,
		/\[visible background-command-complete coordination input \(not direct owner input\); superseded by entry cancel-res in retained tail \| 2026-11-16T10:02:00Z \| entry bg-cancel-target\]/,
	);
	assert.doesNotMatch(handoff, /STALE_UNKNOWN_BODY|STALE_STATUS_BODY|STALE_CANCEL_BODY/);
});

await test("list-form background_command status never supersedes a failed notice while targeted single-job status or cancel does", () => {
	const base: EntryLike[] = [
		ownerEntry("u1", "Run the full test suite."),
		bgCompleteEntry("bg-fail", [
			{
				id: "j1",
				status: "failed",
				exitCode: 1,
				commandPreview: "npm test",
				tail: "FAIL_UNIT_REGRESSION_J1",
			},
		]),
		...toolPair(
			"list-status-call",
			"list-status-res",
			"c-list",
			"background_command",
			{ action: "status" },
			{ details: { jobs: [{ id: "j1", status: "failed" }], total: 1 } },
		),
	];
	const baseProjected = projectEntries(base);
	assert.equal(
		supersededCoordinationMap(base, baseProjected, { retained: new Set() }).get("bg-fail"),
		undefined,
	);
	const unSupersededHandoff = buildAutoHandoff(base, baseProjected, 20_000, {
		ownerQuestionRegistered: false,
		retainedEntryIds: new Set(["list-status-call", "list-status-res"]),
	});
	assert.match(unSupersededHandoff, /FAIL_UNIT_REGRESSION_J1/);
	assert.doesNotMatch(unSupersededHandoff, /superseded by/);

	const withSingleStatus: EntryLike[] = [
		...base,
		...toolPair(
			"single-status-call",
			"single-status-res",
			"c-single",
			"background_command",
			{ action: "status", id: "j1" },
			{ details: { id: "j1", status: "failed" } },
		),
	];
	const singleProjected = projectEntries(withSingleStatus);
	assert.deepEqual(
		supersededCoordinationMap(withSingleStatus, singleProjected, {
			retained: new Set(["single-status-res"]),
		}).get("bg-fail"),
		{ byEntryId: "single-status-res", inRetainedTail: true },
	);
	const supersededHandoff = buildAutoHandoff(withSingleStatus, singleProjected, 20_000, {
		ownerQuestionRegistered: false,
		retainedEntryIds: new Set(["single-status-call", "single-status-res"]),
	});
	assert.doesNotMatch(supersededHandoff, /FAIL_UNIT_REGRESSION_J1/);
	assert.match(
		supersededHandoff,
		/Other current-window inputs, oldest first \(recover with history read\):\n\[visible background-command-complete coordination input \(not direct owner input\); superseded by entry single-status-res in retained tail \| 2026-11-16T10:02:00Z \| entry bg-fail\]/,
	);

	const withCancel: EntryLike[] = [
		...base,
		...toolPair(
			"single-cancel-call",
			"single-cancel-res",
			"c-cancel",
			"background_command",
			{ action: "cancel", id: "j1" },
			{ details: { id: "j1", status: "cancelled" } },
		),
	];
	assert.deepEqual(
		supersededCoordinationMap(withCancel, projectEntries(withCancel), {
			retained: new Set(),
		}).get("bg-fail"),
		{ byEntryId: "single-cancel-res", inRetainedTail: false },
	);
});

await test("multi-job background batch is superseded only when every structured job ID in the batch is superseded", () => {
	const base: EntryLike[] = [
		ownerEntry("u1", "Check two background jobs."),
		bgCompleteEntry("bg-batch", [
			{ id: "j1", status: "failed", tail: "FAIL_J1" },
			{ id: "j2", status: "failed", tail: "FAIL_J2" },
		]),
		...toolPair(
			"s1-call",
			"s1-res",
			"c1",
			"background_command",
			{ action: "status", id: "j1" },
			{ details: { id: "j1", status: "failed" } },
		),
	];
	assert.equal(
		supersededCoordinationMap(base, projectEntries(base), { retained: new Set() }).get(
			"bg-batch",
		),
		undefined,
	);

	const complete: EntryLike[] = [
		...base,
		...toolPair(
			"s2-call",
			"s2-res",
			"c2",
			"background_command",
			{ action: "cancel", id: "j2" },
			{ details: { id: "j2", status: "cancelled" } },
		),
	];
	assert.deepEqual(
		supersededCoordinationMap(complete, projectEntries(complete), {
			retained: new Set(["s2-res"]),
		}).get("bg-batch"),
		{ byEntryId: "s2-res", inRetainedTail: true },
	);
});

await test("text and command scraping are never used for background supersession", () => {
	const entries: EntryLike[] = [
		ownerEntry("u1", "Verify no guessing."),
		// Notice missing structured IDs: content mentions j-missing, but details has no IDs.
		bgCompleteEntry("bg-unstructured", [{ id: "j-missing", status: "failed" }], {
			hasCustomDetails: true,
			details: {},
		}),
		...toolPair(
			"status-missing-call",
			"status-missing-res",
			"cm1",
			"background_command",
			{ action: "status", id: "j-missing" },
			{ details: { id: "j-missing", status: "failed" } },
		),
		// Notice with structured ID, followed by tool result with JSON text only (no structured details).
		bgCompleteEntry("bg-text-only-status", [{ id: "j-text", status: "failed" }]),
		...toolPair(
			"text-status-call",
			"text-status-res",
			"ct1",
			"background_command",
			{ action: "status", id: "j-text" },
			{ content: JSON.stringify({ id: "j-text", status: "failed" }) },
		),
		// Different job IDs for identical commands (including watch-pr and same start cwd/command) never supersede.
		...toolPair(
			"start-1-call",
			"start-1-res",
			"cs1",
			"background_command",
			{ action: "start", command: "node watch-pr.mjs https://github.com/o/r/pull/42" },
			{
				details: {
					id: "j-pr-1",
					status: "starting",
					command: "node watch-pr.mjs https://github.com/o/r/pull/42",
					cwd: "/repo",
				},
			},
		),
		bgCompleteEntry("bg-pr-1", [
			{
				id: "j-pr-1",
				status: "failed",
				commandPreview: "node watch-pr.mjs https://github.com/o/r/pull/42",
				tail: "pr: https://github.com/o/r/pull/42",
			},
		]),
		...toolPair(
			"start-2-call",
			"start-2-res",
			"cs2",
			"background_command",
			{ action: "start", command: "node watch-pr.mjs https://github.com/o/r/pull/42" },
			{
				details: {
					id: "j-pr-2",
					status: "starting",
					command: "node watch-pr.mjs https://github.com/o/r/pull/42",
					cwd: "/repo",
				},
			},
		),
		bgCompleteEntry("bg-pr-2", [
			{
				id: "j-pr-2",
				status: "succeeded",
				commandPreview: "node watch-pr.mjs https://github.com/o/r/pull/42",
			},
		]),
	];
	const map = supersededCoordinationMap(entries, projectEntries(entries), {
		retained: new Set(),
	});
	assert.equal(map.size, 0);
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

await test("guards reject errors, non-terminal statuses, namespaced tools, omitted entries, and non-coordination types", () => {
	const entries: EntryLike[] = [
		ownerEntry("u1", "Check guards."),
		bgCompleteEntry("bg-j1", [{ id: "j1", status: "failed" }]),
		// Error status for j1 must NOT supersede.
		...toolPair(
			"err-status-call",
			"err-status-res",
			"es1",
			"background_command",
			{ action: "status", id: "j1" },
			{ isError: true, details: { id: "j1", status: "failed" } },
		),
		// Non-terminal status for j1 must NOT supersede.
		...toolPair(
			"run-status-call",
			"run-status-res",
			"rs1",
			"background_command",
			{ action: "status", id: "j1" },
			{ details: { id: "j1", status: "running" } },
		),
		// Namespaced background_command must NOT supersede.
		...toolPair(
			"ns-status-call",
			"ns-status-res",
			"ns1",
			"background_command",
			{ action: "status", id: "j1" },
			{ namespace: "other", details: { id: "j1", status: "failed" } },
		),
		// Omitted via projection must NOT supersede.
		bgCompleteEntry("bg-j1-omitted", [{ id: "j1", status: "succeeded" }]),
		// Omitted via context_edit (replacement: null) must NOT supersede.
		...toolPair(
			"edit-omit-call",
			"edit-omit-res",
			"eo1",
			"background_command",
			{ action: "status", id: "j1" },
			{ details: { id: "j1", status: "failed" } },
		),
		{
			type: "context_edit",
			id: "omit-edit-1",
			targetId: "edit-omit-res",
			replacement: null,
		},
		// Agent escalation with error agent_runs or omitted assistant call must NOT supersede.
		customEntry("esc-err", "agent-escalation", "Paused", { id: "run-err" }),
		...toolPair(
			"err-run-call",
			"err-run-res",
			"er1",
			"agent_runs",
			{ action: "continue", id: "run-err", prompt: "Retry" },
			{ isError: true, content: "Run not found" },
		),
		...toolPair(
			"omitted-run-call",
			"omitted-run-res",
			"or1",
			"agent_runs",
			{ action: "continue", id: "run-err", prompt: "Retry" },
			{ content: "Continued" },
		),
		// Never-superseded customTypes.
		customEntry("ic-1", "intercom_message", "Hello", { id: "same" }),
		customEntry("ic-2", "intercom_message", "Hello again", { id: "same" }),
		customEntry("cm-1", "codemode-background", "Done 1", { id: "same" }),
		customEntry("cm-2", "codemode-background", "Done 2", { id: "same" }),
		customEntry("unk-1", "custom-alert", "Alert 1", { id: "same" }),
		customEntry("unk-2", "custom-alert", "Alert 2", { id: "same" }),
	];
	const projected = projectEntries(entries, new Set(["bg-j1-omitted", "omitted-run-call"]));
	const map = supersededCoordinationMap(entries, projected, { retained: new Set() });
	assert.equal(map.size, 0);
});

await test("context-edited replacements use replacement entry IDs for both superseded and superseder entries", () => {
	const entries: EntryLike[] = [
		ownerEntry("u1", "Handle edited notice."),
		bgCompleteEntry("bg-orig", [{ id: "j1", status: "failed", tail: "ORIG_FAIL" }]),
		{
			type: "context_edit",
			id: "bg-edit",
			targetId: "bg-orig",
			replacement: { content: "EDITED_FAIL" },
		},
		...toolPair(
			"status-call",
			"status-orig",
			"c1",
			"background_command",
			{ action: "status", id: "j1" },
			{ details: { id: "j1", status: "failed" } },
		),
		{
			type: "context_edit",
			id: "status-edit",
			targetId: "status-orig",
			replacement: { content: "EDITED_STATUS" },
		},
	];
	const map = supersededCoordinationMap(entries, projectEntries(entries), {
		retained: new Set(["status-orig"]),
	});
	assert.deepEqual(map.get("bg-edit"), { byEntryId: "status-edit", inRetainedTail: true });
	assert.equal(map.get("bg-orig"), undefined);
});

await test("anchors promotes still-active earlier failure to fixed when later coordination event is superseded", () => {
	const entries: EntryLike[] = [
		ownerEntry("u1", "Ship PR 1 and PR 2."),
		bgCompleteEntry("bg-active-failure", [
			{
				id: "j-active",
				status: "failed",
				exitCode: 4,
				tail: "ACTIVE_FAILURE_J1",
			},
		]),
		bgCompleteEntry("bg-stale-failure", [
			{
				id: "j-stale",
				status: "failed",
				exitCode: 3,
				tail: "STALE_FAILURE_J2",
			},
		]),
		...toolPair(
			"status-call",
			"status-res",
			"c-stale",
			"background_command",
			{ action: "status", id: "j-stale" },
			{ details: { id: "j-stale", status: "failed", exitCode: 3 } },
		),
	];
	const handoff = buildAutoHandoff(entries, projectEntries(entries), 20_000, {
		ownerQuestionRegistered: false,
		retainedEntryIds: new Set(["status-call", "status-res"]),
	});
	// Active earlier failure is promoted to fixed (full body quoted); stale later failure is demoted to others.
	assert.match(handoff, /ACTIVE_FAILURE_J1/);
	assert.doesNotMatch(handoff, /STALE_FAILURE_J2/);
	assert.match(
		handoff,
		/Other current-window inputs, oldest first \(recover with history read\):\n\[visible background-command-complete coordination input \(not direct owner input\); superseded by entry status-res in retained tail \| 2026-11-16T10:02:00Z \| entry bg-stale-failure\]/,
	);
});
