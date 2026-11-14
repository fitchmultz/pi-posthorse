import { OWNER_QUESTION_TOOL, type EntryLike, type ProjectedEntry } from "./contracts.ts";

/** Only the session-manager members Posthorse reads; a host may omit any of them. */
export type SessionHost = {
	readonly getEntry?: (id: string) => EntryLike | undefined;
	readonly getSessionId?: () => string;
	readonly getSessionFile?: () => string | undefined;
	readonly getLeafId?: () => string | null;
	readonly getBranch?: (fromId?: string) => readonly EntryLike[];
	readonly buildSessionProjection?: () => { readonly entries: readonly ProjectedEntry[] };
};
/** Only the registry members Posthorse reads. */
export type ToolInfo = {
	readonly name: string;
	readonly namespace?: unknown;
};
export type ToolRegistry = {
	readonly getActiveTools: () => readonly string[];
	readonly getAllTools: () => readonly ToolInfo[];
};
export type SessionIdentity = {
	readonly sessionId: string;
	readonly file: string | undefined;
	readonly leaf: EntryLike | undefined;
};

/** A host that omits a member reports no data for it instead of failing the caller. */
export function sessionEntry(
	manager: SessionHost,
	id: string | null | undefined,
): EntryLike | undefined {
	return id === undefined || id === null || id === "" || manager.getEntry === undefined
		? undefined
		: manager.getEntry(id);
}
export function sessionIdentity(manager: SessionHost): SessionIdentity {
	return {
		sessionId: manager.getSessionId?.() ?? "",
		file: manager.getSessionFile?.(),
		leaf: sessionEntry(manager, manager.getLeafId?.() ?? null),
	};
}
export function sessionBranch(manager: SessionHost): readonly EntryLike[] | undefined {
	return manager.getBranch?.();
}
export function sessionProjection(manager: SessionHost): readonly ProjectedEntry[] | undefined {
	return manager.buildSessionProjection?.().entries;
}

export type ToolFacts = {
	readonly active: ReadonlySet<string>;
	/** Registered names an active tool can carry without a namespace. */
	readonly unnamespaced: ReadonlySet<string>;
	readonly activeUnnamespaced: ReadonlySet<string>;
};
/** Active tools share names with namespaced registrations, so capabilities read the intersected set. */
export function toolFacts(pi: ToolRegistry): ToolFacts {
	const tools = pi.getAllTools();
	const active = new Set(pi.getActiveTools());
	const unnamespaced = new Set(
		tools.filter((tool) => tool.namespace === undefined).map((tool) => tool.name),
	);
	return {
		active,
		unnamespaced,
		activeUnnamespaced: active.intersection(unnamespaced),
	};
}
export function ownerQuestionRegistered(pi: ToolRegistry): boolean {
	return toolFacts(pi).unnamespaced.has(OWNER_QUESTION_TOOL);
}
