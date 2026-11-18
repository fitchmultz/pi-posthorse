import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import {
	Box,
	MouseRegion,
	truncateToWidth,
	type Component,
	type Text,
} from "@earendil-works/pi-tui";
import { clean, hint, leadingRows, textBlock, textOf } from "./src/ui/text.ts";
import { LEGACY_WINDOW_TYPE, REMINDER_TYPE } from "./src/contracts.ts";

export type { PosthorseDisplay } from "./src/ui/display.ts";
export { toolCards } from "./src/ui/cards.ts";

interface ExpansionState {
	readonly global: boolean;
	expanded: boolean;
}

function localExpansion(
	states: WeakMap<object, ExpansionState>,
	message: object,
	globalExpanded: boolean,
): ExpansionState {
	let state = states.get(message);
	if (state === undefined || state.global !== globalExpanded) {
		state = { global: globalExpanded, expanded: globalExpanded };
		states.set(message, state);
	}
	return state;
}

/** Each saved message owns its click state; global expansion resets that local choice. */
export function registerPosthorseMessages(pi: ExtensionAPI): void {
	const states = new WeakMap<object, ExpansionState>();
	const renderer: MessageRenderer = (message, options, theme) => {
		const nativeToggle = "compactView" in options && options.compactView !== undefined;
		const view = nativeToggle ? undefined : localExpansion(states, message, options.expanded);
		const window = message.customType === LEGACY_WINDOW_TYPE;
		const raw = textOf(message.content);
		const handoffLabel = "\n\nHandoff from the previous window:\n";
		const handoffAt = raw.indexOf(handoffLabel);
		const preview = window
			? raw.slice(handoffAt < 0 ? raw.length : handoffAt + handoffLabel.length)
			: raw;
		const previewRows = window ? 2 : 3;
		const previewText = leadingRows(preview, theme, "toolOutput", previewRows);
		const expandHint = options.keyHint("app.tools.expand", "to expand");
		let fullText: Text | undefined;
		let cached: { readonly width: number; readonly lines: string[] } | undefined;
		const historyText = textBlock("Earlier conversation remains in history.", theme, "muted");
		const messageLines = (inner: number, expanded: boolean): string[] => {
			const title = `${expanded ? "▾" : "▸"} ${window ? "Context window started" : "Checkpoint reminder"}`;
			const heading = truncateToWidth(
				theme.fg(window ? "customMessageLabel" : "warning", theme.bold(clean(title))),
				inner,
			);
			const body = expanded
				? (fullText ??= textBlock(raw, theme)).render(inner)
				: [
						...(window ? historyText.render(inner).slice(0, 2) : []),
						...previewText(inner).slice(0, previewRows),
						hint(theme, inner, expandHint),
					];
			return [heading, ...body];
		};
		const content: Component = {
			invalidate() {
				fullText = undefined;
				cached = undefined;
			},
			render(width) {
				if (cached?.width === width) {
					return cached.lines;
				}
				const padding = Math.min(
					options.outputPad,
					Math.max(0, Math.floor((width - 1) / 2)),
				);
				const inner = Math.max(1, width - padding * 2);
				const rows = messageLines(inner, view?.expanded ?? options.expanded);
				const box = new Box(padding, 1, (line) => theme.bg("customMessageBg", line));
				box.addChild({
					render: () => rows,
					invalidate() {
						// The parent rebuilds this stateless box for every render.
					},
				});
				const lines = box.render(width);
				cached = { width, lines };
				return lines;
			},
		};
		if (view === undefined) {
			return content;
		}
		return new MouseRegion(content, (event) => {
			if (event.type !== "click" || event.button !== "left") {
				return;
			}
			view.expanded = !view.expanded;
			content.invalidate();
			return { handled: true };
		});
	};
	for (const type of [LEGACY_WINDOW_TYPE, REMINDER_TYPE]) {
		pi.registerMessageRenderer(type, renderer);
	}
}
