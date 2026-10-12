import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import {
	Box,
	MouseRegion,
	truncateToWidth,
	type Component,
	type Text,
} from "@earendil-works/pi-tui";
import { clean, hint, leadingRows, textBlock, textOf } from "./src/ui/text.ts";

export type { PosthorseDisplay } from "./src/ui/display.ts";
export { toolCards } from "./src/ui/cards.ts";

interface ExpansionState {
	readonly global: boolean;
	expanded: boolean;
}

/** Each saved message owns its click state; global expansion resets that local choice. */
export function registerPosthorseMessages(pi: ExtensionAPI): void {
	const states = new WeakMap<object, ExpansionState>();
	const renderer: MessageRenderer = (message, options, theme) => {
		let state = states.get(message);
		if (state === undefined || state.global !== options.expanded) {
			state = { global: options.expanded, expanded: options.expanded };
			states.set(message, state);
		}
		const view = state;
		const window = message.customType === "context-window";
		const raw = textOf(message.content);
		const handoffLabel = "\n\nHandoff from the previous window:\n";
		const handoffAt = raw.indexOf(handoffLabel);
		const preview = window
			? raw.slice(handoffAt < 0 ? raw.length : handoffAt + handoffLabel.length)
			: raw;
		const previewRows = window ? 2 : 3;
		const previewText = leadingRows(preview, theme, "toolOutput", previewRows);
		let fullText: Text | undefined;
		const historyText = textBlock("Earlier conversation remains in history.", theme, "muted");
		const content: Component = {
			invalidate() {
				// Pi calls the renderer again on invalidation, so cached rows never outlive a theme.
			},
			render(width) {
				const padding = Math.min(
					options.outputPad,
					Math.max(0, Math.floor((width - 1) / 2)),
				);
				const inner = Math.max(1, width - padding * 2);
				const title = `${view.expanded ? "▾" : "▸"} ${window ? "Context window started" : "Checkpoint reminder"}`;
				const heading = truncateToWidth(
					theme.fg(window ? "customMessageLabel" : "warning", theme.bold(clean(title))),
					inner,
				);
				const body = view.expanded
					? (fullText ??= textBlock(raw, theme)).render(inner)
					: [
							...(window ? historyText.render(inner).slice(0, 2) : []),
							...previewText(inner).slice(0, previewRows),
							hint(theme, inner),
						];
				const box = new Box(padding, 1, (line) => theme.bg("customMessageBg", line));
				box.addChild({
					render: () => [heading, ...body],
					invalidate() {
						// The parent rebuilds this stateless box for every render.
					},
				});
				return box.render(width);
			},
		};
		return new MouseRegion(content, (event) => {
			if (event.type !== "click" || event.button !== "left") {
				return;
			}
			view.expanded = !view.expanded;
			return { handled: true };
		});
	};
	for (const type of ["context-window", "posthorse-reminder"]) {
		pi.registerMessageRenderer(type, renderer);
	}
}
