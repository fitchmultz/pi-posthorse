import assert from "node:assert/strict";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { displayOf, displaySchema, type PosthorseDisplay } from "../src/ui/display.ts";

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
	details: Type.Optional(displaySchema),
});

export function fixtureDisplay(value: unknown): PosthorseDisplay {
	const valid = displayOf(value);
	assert.ok(valid !== undefined, "Expected valid Posthorse display metadata");
	return valid;
}

export function fixtureResult(value: unknown): Static<typeof result> {
	assert.ok(Check(result, value), "Expected a valid Posthorse tool result");
	return value;
}
