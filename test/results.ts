import assert from "node:assert/strict";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { PosthorseDisplay } from "../ui.ts";

const page = Type.Object({ offset: Type.Number(), end: Type.Number(), total: Type.Number() });
const span = Type.Object({ headerLength: Type.Number(), length: Type.Number() });
const display = Type.Union([
	Type.Object({
		kind: Type.Literal("context"),
		usage: Type.Optional(
			Type.Object({
				tokens: Type.Union([Type.Number(), Type.Null()]),
				contextWindow: Type.Number(),
				percent: Type.Union([Type.Number(), Type.Null()]),
			}),
		),
		rollover: Type.Optional(
			Type.Union([
				Type.Literal("enabled"),
				Type.Literal("disabled"),
				Type.Literal("unsupported"),
			]),
		),
		rolloverAt: Type.Optional(Type.Number()),
	}),
	Type.Object({
		kind: Type.Union([Type.Literal("notes-list"), Type.Literal("notes-search")]),
		count: Type.Number(),
		headerLength: Type.Optional(Type.Number()),
		page: Type.Optional(page),
	}),
	Type.Object({
		kind: Type.Literal("note-read"),
		...page.properties,
		headerLength: Type.Optional(Type.Number()),
	}),
	Type.Object({
		kind: Type.Union([
			Type.Literal("note-write"),
			Type.Literal("note-append"),
			Type.Literal("new-context"),
		]),
	}),
	Type.Object({
		kind: Type.Literal("history-search"),
		entries: Type.Array(span),
		footerLength: Type.Optional(Type.Number()),
		more: Type.Optional(Type.Boolean()),
		skipped: Type.Optional(Type.Number()),
	}),
	Type.Object({
		kind: Type.Literal("history-read"),
		...page.properties,
		headerLength: Type.Number(),
		imageOffset: Type.Optional(Type.Number()),
		imageEnd: Type.Optional(Type.Number()),
		imageTotal: Type.Optional(Type.Number()),
	}),
]);
const result = Type.Object({
	content: Type.Array(
		Type.Union([
			Type.Object({ type: Type.Literal("text"), text: Type.String() }),
			Type.Object({
				type: Type.Literal("image"),
				data: Type.String(),
				mimeType: Type.Optional(Type.String()),
			}),
		]),
	),
	details: Type.Optional(display),
});

export function fixtureDisplay(value: unknown): PosthorseDisplay {
	assert.ok(Check(display, value), "Expected valid Posthorse display metadata");
	return value;
}

export function fixtureResult(value: unknown): Static<typeof result> {
	assert.ok(Check(result, value), "Expected a valid Posthorse tool result");
	return value;
}
