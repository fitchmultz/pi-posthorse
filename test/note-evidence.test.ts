import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryLike } from "../src/contracts.ts";
import { sessionNoteTouches } from "../src/note-evidence.ts";
import { renderSessionNotes } from "../src/recovery-notes.ts";
import { NOTES_TOUCH, type NoteTouchRecord } from "../src/note-scopes.ts";

const scope = { root: "/workspace/.pi/notes", scope: "" };
const owner = { id: "child", timestamp: "2026-11-12T00:00:00Z" };
function record(id: string, toolCallId: string, files: NoteTouchRecord["files"]): EntryLike {
	return {
		type: "custom",
		id,
		customType: NOTES_TOUCH,
		data: { version: 1, owner, scope, rootToolCallId: "batch", toolCallId, files },
	};
}
function evidence(entries: readonly EntryLike[]) {
	return {
		branch: entries,
		allEntries: entries,
		projected: entries.map((sourceEntry) => ({
			sourceEntry,
			messages: sourceEntry.message === undefined ? [] : [sourceEntry.message],
		})),
		retained: new Set<string>(),
	};
}

for (const withArguments of [false, true]) {
	await test(`completed clear/delete effects replace adoption without losing other files (arguments=${withArguments})`, () => {
		const entries: EntryLike[] = [
			record("adopt-clear", "edit", [{ ...scope, path: "clear.md", kind: "adopt" }]),
			record("adopt-delete", "edit", [{ ...scope, path: "delete.md", kind: "adopt" }]),
			record("separate-adoption", "edit", [{ ...scope, path: "keep.md", kind: "adopt" }]),
			record("finished", "edit", [
				{ ...scope, path: "clear.md", kind: "clear" },
				{ ...scope, path: "delete.md", kind: "delete" },
			]),
			{
				type: "message",
				id: "receipt",
				message: {
					role: "toolResult",
					toolName: "codemode",
					toolCallId: "batch",
					content: "Finished",
					nestedCalls: {
						calls: [
							{
								id: "edit",
								name: "replace_text",
								status: "ok",
								...(withArguments
									? {
											arguments: {
												files: [
													{
														path: "/workspace/.pi/notes/clear.md",
														edits: [
															{
																oldText: "small existing note",
																newText: "",
															},
														],
													},
												],
											},
										}
									: {}),
							},
						],
					},
				},
			},
		];
		const input = evidence(entries);
		const touches = sessionNoteTouches(input).touches;
		assert.deepEqual(
			touches.map(({ notePath, kind }) => [notePath, kind]),
			[
				["keep.md", "observed-write"],
				["clear.md", "clear"],
				["delete.md", "clear"],
			],
		);
		const rendered = renderSessionNotes(entries, entries, input.projected, {
			retained: input.retained,
			span: undefined,
			maxChars: 10_000,
		});
		assert.doesNotMatch(rendered ?? "", /clear\.md|delete\.md/u);
		assert.match(rendered ?? "", /keep\.md/u);
	});
}

await test("same-receipt calls replay a clear before a later write", () => {
	const entries: EntryLike[] = [
		record("clear", "first", [{ ...scope, path: "task.md", kind: "clear" }]),
		record("write", "second", [{ ...scope, path: "task.md", kind: "write" }]),
		{
			type: "message",
			id: "receipt",
			message: {
				role: "toolResult",
				toolName: "codemode",
				toolCallId: "batch",
				content: "Finished",
				nestedCalls: {
					calls: [
						{
							id: "first",
							name: "notes",
							status: "ok",
							arguments: { op: "write", path: "task.md", content: "" },
							result: "Wrote /workspace/.pi/notes/task.md",
						},
						{
							id: "second",
							name: "notes",
							status: "ok",
							arguments: { op: "write", path: "task.md", content: "restored" },
							result: "Wrote /workspace/.pi/notes/task.md",
						},
					],
				},
			},
		},
	];
	const input = evidence(entries);
	const touches = sessionNoteTouches(input).touches;
	assert.deepEqual(
		touches.map(({ kind }) => kind),
		["clear", "observed-write"],
	);
	assert.match(
		renderSessionNotes(entries, entries, input.projected, {
			retained: input.retained,
			span: undefined,
			maxChars: 10_000,
		}) ?? "",
		/Active note \(written\): task\.md/u,
	);
});
