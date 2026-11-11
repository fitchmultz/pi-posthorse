import { sessionIdentity, type SessionHost, type SessionIdentity } from "./host.ts";

/** A cached value with the session state it was computed from. */
export type EpochValue<Value> = {
	readonly identity: SessionIdentity;
	readonly value: Value;
};
export type EpochCache<Value> = {
	readonly read: (ctx: SessionContext) => Value;
	readonly reset: () => void;
};
export type SessionContext = { readonly sessionManager: SessionHost };

function sameSession(left: SessionIdentity, right: SessionIdentity): boolean {
	return left.sessionId === right.sessionId && left.file === right.file;
}
/**
 * Caches one session fact for the current leaf. A new leaf recomputes unless its walk reaches the
 * cached leaf entry itself: entry identity, not a reusable id, certifies an append-only extension.
 */
export function createEpochCache<Value>(
	compute: (
		ctx: SessionContext,
		identity: SessionIdentity,
		previous: EpochValue<Value> | undefined,
	) => Value,
): EpochCache<Value> {
	let cached: (EpochValue<Value> & { readonly manager: object }) | undefined;
	return {
		reset: () => {
			cached = undefined;
		},
		read: (ctx) => {
			const manager: object = ctx.sessionManager;
			const identity = sessionIdentity(ctx.sessionManager);
			const previous =
				cached !== undefined &&
				cached.manager === manager &&
				sameSession(cached.identity, identity)
					? cached
					: undefined;
			if (previous !== undefined && previous.identity.leaf === identity.leaf) {
				return previous.value;
			}
			const value = compute(ctx, identity, previous);
			cached = { manager, identity, value };
			return value;
		},
	};
}
