import assert from "node:assert/strict";
import test from "node:test";
import { calculateCost, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { shouldCompact } from "@earendil-works/pi-coding-agent";
import { budgetFor } from "../src/budget.ts";

const WINDOW = 335_000;
const scenarios = [
	{ reserve: 64_000, usable: 271_000, line: 271_001, headroom: 63_999 },
	{ reserve: 32_000, usable: 303_000, line: 303_001, headroom: 31_999 },
	{ reserve: 24_000, usable: 311_000, line: 311_001, headroom: 23_999 },
] as const;

for (const scenario of scenarios) {
	test(`reserve scenario ${scenario.reserve} agrees with the native threshold`, () => {
		const settings = {
			enabled: true,
			reserveTokens: scenario.reserve,
			keepRecentTokens: 20_000,
		};
		const budget = budgetFor({
			getCompactionSettings: () => settings,
			getContextUsage: () => ({ tokens: null, contextWindow: WINDOW, percent: null }),
			getSystemPrompt: () => "Synthetic reserve arithmetic",
		});
		assert.equal(budget?.supported, true);
		assert.equal(budget.usable, scenario.usable);
		assert.equal(budget.rolloverAt, scenario.line);
		assert.equal(shouldCompact(scenario.usable, WINDOW, settings), false);
		assert.equal(shouldCompact(scenario.line, WINDOW, settings), true);
		assert.equal(WINDOW - scenario.line, scenario.headroom);
	});
}

test("reserve frequency arithmetic separates capacity gain from cycle reduction", () => {
	const baseline = 271_001;
	assert.equal((303_001 - baseline) / WINDOW, 32_000 / WINDOW);
	assert.equal((311_001 - baseline) / WINDOW, 40_000 / WINDOW);
	for (const freshTokens of [0, 30_000]) {
		for (const line of [303_001, 311_001]) {
			const oldGrowth = baseline - freshTokens;
			const newGrowth = line - freshTokens;
			assert.ok(newGrowth > oldGrowth);
			assert.equal(newGrowth - oldGrowth, line - baseline);
		}
	}
});

test("synthetic prices distinguish a cache read, fresh input, and both write lifetimes", () => {
	const model = {
		...fauxProvider().getModel(),
		cost: { input: 10, output: 30, cacheRead: 1, cacheWrite: 12.5 },
	};
	const price = (
		tokens: Readonly<{
			input: number;
			cacheRead: number;
			cacheWrite: number;
			cacheWrite1h?: number;
		}>,
	) => calculateCost(model, { ...fauxAssistantMessage("").usage, ...tokens }).total;
	const read = price({ input: 0, cacheRead: 1_000_000, cacheWrite: 0 });
	assert.equal(read, 1);
	assert.equal(price({ input: 1_000_000, cacheRead: 0, cacheWrite: 0 }) - read, 9);
	assert.equal(price({ input: 0, cacheRead: 0, cacheWrite: 1_000_000 }) - read, 11.5);
	assert.equal(
		price({ input: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 }) - read,
		19,
	);
});
