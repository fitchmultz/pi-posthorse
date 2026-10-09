import { relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolCards } from "../ui.ts";
import { requireValue, type PolicyContext, type WindowedEntry } from "./contracts.ts";
import { toWindowedEntry, windowProjection } from "./history-entries.ts";
import { historyReadPage, searchPage } from "./history-pages.ts";
import { historyMatches, type HistorySource } from "./history-search.ts";
import type { PageAccess } from "./paging.ts";
import { filesContaining, scopedSessionFiles, sessionWindowEntries } from "./session-files.ts";

type LocatedEntry = { readonly item: WindowedEntry; readonly source: string };
function entryReference(id: string): { readonly entryId: string; readonly fileKey?: string } {
	const separator = id.indexOf("@");
	return {
		entryId: separator < 0 ? id : id.slice(0, separator),
		fileKey: separator < 0 ? undefined : id.slice(separator + 1),
	};
}
function branchEntry(source: HistorySource, id: string): WindowedEntry | undefined {
	const project = windowProjection();
	for (const entry of source.branch()) {
		const windowId = project(entry);
		const item = entry.id === id ? toWindowedEntry(entry, windowId) : undefined;
		if (item !== undefined) {
			return item;
		}
	}
	return undefined;
}
async function findEntry(
	source: HistorySource,
	id: string,
	signal?: AbortSignal,
): Promise<LocatedEntry> {
	const { entryId, fileKey } = entryReference(id);
	const current = fileKey === undefined ? branchEntry(source, entryId) : undefined;
	if (current !== undefined) {
		return { item: current, source: "" };
	}
	const candidates =
		fileKey === undefined && /^[\w-]+$/.test(entryId)
			? await filesContaining(source.dir, [`"id":"${entryId}"`], signal)
			: undefined;
	for await (const file of scopedSessionFiles({
		dir: source.dir,
		cwd: source.cwd,
		currentFile: source.currentFile,
		signal,
		fileKey,
		candidates: candidates === undefined ? undefined : (candidate) => candidates.has(candidate),
	})) {
		for await (const item of sessionWindowEntries(file, signal, entryId)) {
			return { item, source: relative(source.dir, file) };
		}
	}
	throw new Error(
		`No history entry "${id}" in this session or this project's other sessions. Pass an id exactly as history search prints it, such as 1a2f07de, or 1a2f07de@Ab3dE5fG7h from another session; search first when you only have text or a timestamp.`,
	);
}
function historySource(ctx: ExtensionContext): HistorySource {
	const manager = ctx.sessionManager;
	return {
		dir: manager.getSessionDir(),
		cwd: resolve(ctx.cwd),
		currentFile: manager.getSessionFile(),
		branch: () => manager.getBranch(),
		projection: () => manager.buildSessionProjection().entries,
	};
}
export function registerHistory(
	pi: ExtensionAPI,
	policy: (ctx: ExtensionContext) => PolicyContext,
	pages: PageAccess,
): void {
	pi.registerTool({
		name: "history",
		label: "History",
		...toolCards("history"),
		description:
			"Search or read earlier session entries, including previous context windows. search skips entries still in your active context and lists original content before recovery echoes, newest first; all=true also searches this project's other sessions and subagent runs. read takes an entry id exactly as search printed it and pages text and images.",
		promptSnippet: "recover earlier conversation that left the active context window",
		promptGuidelines: [
			"Use history search first, then history read with the entry id exactly as printed",
		],
		parameters: Type.Object({
			op: Type.Union([Type.Literal("search"), Type.Literal("read")], {
				description: "Operation to perform",
			}),
			query: Type.Optional(
				Type.String({ description: "Case-insensitive text to find (search)" }),
			),
			id: Type.Optional(
				Type.String({ description: "Entry id exactly as search printed it (read)" }),
			),
			all: Type.Optional(
				Type.Boolean({
					description: "Also search this project's other sessions and subagent runs",
				}),
			),
			limit: Type.Optional(
				Type.Integer({
					description: "Maximum search results per page (default 10, max 50)",
					minimum: 1,
					maximum: 50,
				}),
			),
			cursor: Type.Optional(
				Type.String({
					description:
						"Continuation from the previous search page; keep query and all unchanged",
					maxLength: 512,
				}),
			),
			offset: Type.Optional(
				Type.Integer({ description: "Character offset for read (default 0)", minimum: 0 }),
			),
			imageOffset: Type.Optional(
				Type.Integer({
					description:
						"First image to return (read); use the value from the continuation",
					minimum: 0,
				}),
			),
		}),
		// Pi's fixed tool contract supplies id, params, signal, updates, and context.
		// oxlint-disable-next-line max-params
		async execute(_id, params, signal, _onUpdate, ctx) {
			const source = historySource(ctx);
			if (params.op === "search") {
				const fail = (message: string): never =>
					pages.error(policy(ctx), message, params.cursor);
				const matches = await historyMatches(source, params, signal, fail);
				return searchPage(matches, params, policy(ctx), pages);
			}
			const id = requireValue(params.id, "id", params.op);
			const located = await findEntry(source, id, signal);
			return historyReadPage(
				located.item,
				params,
				{ host: policy(ctx), pages },
				located.source,
			);
		},
	});
}
