import type {
	ExtensionAPI,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

type RequestState =
	| { readonly kind: "pending"; readonly handoff?: string }
	| { readonly kind: "settled"; readonly handoff?: string }
	| { readonly kind: "failed" };
type ForegroundCall = {
	readonly id: string;
	state: RequestState;
};
/** One turn's batch outcome: the settled request to honor, or why the turn keeps its context. */
export type ResetOutcome =
	| { readonly kind: "no-reset"; readonly reason: "absent" | "failed" | "aborted" }
	| { readonly kind: "reset"; readonly handoff: string };

/** Native call ancestry joins nested requests to the foreground receipt that settles them. */
export class ResetRequests {
	readonly #active = new Map<string, ForegroundCall>();
	readonly #roots = new Map<string, ForegroundCall>();
	constructor(pi: ExtensionAPI) {
		pi.on("tool_execution_start", (event) => {
			this.#start(event);
		});
		pi.on("tool_execution_end", (event) => {
			this.#finish(event);
		});
	}
	clear(): void {
		this.#active.clear();
		this.#roots.clear();
	}
	#start(event: ToolExecutionStartEvent): void {
		const parent = event.parentToolCallId;
		const root: ForegroundCall | undefined =
			parent === undefined
				? { id: event.toolCallId, state: { kind: "pending" } }
				: this.#active.get(parent);
		if (root === undefined || (parent !== undefined && !this.#active.has(root.id))) {
			return;
		}
		this.#active.set(event.toolCallId, root);
		if (parent === undefined) {
			this.#roots.set(root.id, root);
		}
	}
	#finish(event: ToolExecutionEndEvent): void {
		const root = this.#active.get(event.toolCallId);
		this.#active.delete(event.toolCallId);
		if (root === undefined) {
			return;
		}
		if (root.state.kind !== "pending") {
			return;
		}
		if (event.isError) {
			root.state = { kind: "failed" };
		} else if (event.toolCallId === root.id) {
			root.state = { ...root.state, kind: "settled" };
		}
	}
	request(id: string, handoff: string): void {
		const root = this.#active.get(id);
		if (root === undefined || !this.#active.has(root.id)) {
			throw new Error("Request new_context from the current foreground tool batch.");
		}
		if (root.state.kind === "pending" && root.state.handoff === undefined) {
			root.state = { kind: "pending", handoff };
		}
	}
	/**
	 * Settles the whole foreground batch. Any failed receipt cancels the reset, an aborted turn
	 * keeps its context, and the first settled receipt that carries a handoff is honored.
	 */
	settle(
		results: TurnEndEvent["toolResults"],
		options: { readonly aborted: boolean },
	): ResetOutcome {
		const states = results.map((result) =>
			result.isError
				? { kind: "failed" as const }
				: this.#roots.get(result.toolCallId)?.state,
		);
		this.clear();
		if (states.some((state) => state?.kind === "failed")) {
			return { kind: "no-reset", reason: "failed" };
		}
		const settled = states.find(
			(state): state is { readonly kind: "settled"; readonly handoff: string } =>
				state?.kind === "settled" && state.handoff !== undefined,
		);
		if (settled === undefined) {
			return { kind: "no-reset", reason: "absent" };
		}
		return options.aborted
			? { kind: "no-reset", reason: "aborted" }
			: { kind: "reset", handoff: settled.handoff };
	}
}
