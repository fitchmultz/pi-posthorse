import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { EntryLike, ProjectedEntry } from "./contracts.ts";
import { notesDir } from "./files.ts";
import { adoptNote, ensureManifest, readManifest, saveAdoption } from "./note-snapshots.ts";
import {
	loadNotesBinding,
	resolveReference,
	sourceEntries,
	type NoteSource,
} from "./note-provenance.ts";
import {
	NOTES_BINDING,
	NOTES_TOUCH,
	bindingsOf,
	canonicalPath,
	inside,
	notePath,
	noteRelative,
	ownedPaths,
	sameOwner,
	sameScope,
	scopeDirectory,
	type NoteAddress,
	type NoteBinding,
	type NoteScope,
	type NoteTouchRecord,
} from "./note-scopes.ts";
import type { NotesRecovery } from "./note-evidence.ts";

type NotesManager = ExtensionContext["sessionManager"];
export type NoteCall = { readonly id: string; readonly rootId: string };
type Adoption = "owned" | "unavailable" | "adopted";
export type NoteRead = {
	readonly address: NoteAddress;
	readonly path: string;
	readonly writable: boolean;
};
export class SessionNotes {
	readonly #pi: ExtensionAPI;
	readonly binding: NoteBinding;
	readonly #manager: NotesManager;
	readonly #source: NoteSource;
	readonly #owned: Set<string>;
	readonly scopes: readonly NoteScope[];
	readonly #calls = new Map<string, string>();
	readonly #revisions = new Map<string, number>();
	constructor(pi: ExtensionAPI, binding: NoteBinding, manager: NotesManager, source: NoteSource) {
		this.#pi = pi;
		this.binding = binding;
		this.#manager = manager;
		this.#source = source;
		this.#owned = ownedPaths(binding, manager.getEntries());
		this.scopes = [
			binding,
			{ root: binding.root, scope: "" },
			...(binding.kind === "fork" && binding.source !== null ? [binding.source] : []),
			...bindingsOf([...manager.getEntries(), ...source.entries]),
		];
	}
	get directory(): string {
		return scopeDirectory(this.binding);
	}
	get branch(): readonly EntryLike[] {
		return this.#manager.getBranch();
	}
	get projection(): readonly ProjectedEntry[] {
		return this.#manager.buildSessionProjection().entries;
	}
	revision(path: string): number {
		return this.#revisions.get(canonicalPath(path)) ?? 0;
	}
	get recovery(): NotesRecovery {
		return { binding: this.binding, entries: this.#manager.getEntries() };
	}
	startCall(id: string, parent: string | undefined): NoteCall {
		const rootId = parent === undefined ? id : (this.#calls.get(parent) ?? parent);
		this.#calls.set(id, rootId);
		return { id, rootId };
	}
	finishCall(id: string): void {
		this.#calls.delete(id);
	}
	call(id: string): NoteCall {
		return { id, rootId: this.#calls.get(id) ?? id };
	}
	owns(path: string): boolean {
		return (
			this.binding.kind === "project" ||
			this.#owned.has(path) ||
			existsSync(notePath(this.binding, path))
		);
	}
	record(files: NoteTouchRecord["files"], call: NoteCall): void {
		if (files.length === 0) {
			return;
		}
		for (const file of files) {
			if (file.kind !== "read" && sameScope(file, this.binding)) {
				this.#owned.add(file.path);
				const path = canonicalPath(notePath(file, file.path));
				this.#revisions.set(path, this.revision(path) + 1);
			}
		}
		this.#pi.appendEntry(NOTES_TOUCH, {
			version: 1,
			owner: this.binding.owner,
			scope: { root: this.binding.root, scope: this.binding.scope },
			rootToolCallId: call.rootId,
			toolCallId: call.id,
			files,
		} satisfies NoteTouchRecord);
	}
	async selectScope(selector: string): Promise<NoteScope> {
		const directory = canonicalPath(selector);
		const known = this.scopes.find(
			(scope) => canonicalPath(scopeDirectory(scope)) === directory,
		);
		if (known !== undefined) {
			return known;
		}
		const manifest = await readManifest(directory);
		if (
			manifest !== undefined &&
			manifest.root === this.binding.root &&
			inside(join(this.binding.root, ".forks"), directory)
		) {
			return manifest;
		}
		throw new Error(
			`Unknown notes scope ${selector}. Copy a scope selector from notes list/search.`,
		);
	}
	async #reference(path: string, signal?: AbortSignal): Promise<NoteAddress | undefined> {
		if (this.binding.kind !== "fork" || this.binding.source === null) {
			return;
		}
		const entries = [
			...this.#manager.getEntries(),
			...this.#source.entries,
			...(await sourceEntries(this.#source.file, signal)),
		];
		return resolveReference(this.binding.source, path, entries);
	}
	async read(
		path: string,
		options: {
			readonly scope?: string | undefined;
			readonly signal?: AbortSignal | undefined;
		} = {},
	): Promise<NoteRead> {
		const relative = noteRelative(path);
		if (options.scope !== undefined) {
			const scope = await this.selectScope(options.scope);
			return {
				address: { ...scope, path: relative },
				path: notePath(scope, relative),
				writable: sameScope(scope, this.binding),
			};
		}
		const reference = this.owns(relative)
			? undefined
			: await this.#reference(relative, options.signal);
		const address = reference ?? {
			root: this.binding.root,
			scope: this.binding.scope,
			path: relative,
		};
		return { address, path: notePath(address, relative), writable: reference === undefined };
	}
	async adopt(path: string, call: NoteCall): Promise<Adoption> {
		const relative = noteRelative(path);
		if (this.owns(relative)) {
			return "owned";
		}
		const source = await this.#reference(relative);
		if (source === undefined) {
			return "unavailable";
		}
		const result = await adoptNote(this.binding, {
			path: relative,
			source,
			lineage: source,
			anchors: [],
		});
		this.record(
			[
				{
					root: this.binding.root,
					scope: this.binding.scope,
					path: relative,
					kind: "adopt",
					...(result.kind === "verified" ? { seed: result.seed } : {}),
				},
			],
			call,
		);
		if (result.kind === "unverified") {
			throw new Error(
				`Private copy created at ${notePath(this.binding, relative)}; source not edited, but copy verification failed. Read the private copy before retrying.`,
				{ cause: result.error },
			);
		}
		try {
			await saveAdoption(this.binding, result.seed);
		} catch (error) {
			throw new Error(
				`Private copy created at ${notePath(this.binding, relative)}; source not edited, but its adoption manifest could not be saved. Read the private copy before retrying.`,
				{ cause: error },
			);
		}
		return "adopted";
	}
	async prepareWrite(): Promise<void> {
		await ensureManifest(this.binding);
	}
	async guardReference(path: string, call: NoteCall): Promise<string> {
		const destination = notePath(this.binding, path);
		const copied = await withFileMutationQueue(destination, () => this.adopt(path, call));
		return copied === "adopted"
			? `Private copy created at ${destination}; the source was not edited. Read the private copy, then retry the edit on that path.`
			: `This session writes only ${this.directory}. Read ${destination}, then retry there; the foreign path was not edited.`;
	}
}
function sessionKey(ctx: ExtensionContext): string {
	const header = ctx.sessionManager.getHeader();
	if (header === null) {
		throw new Error("Pi session header is required for notes.");
	}
	return `${header.id}\0${header.timestamp}`;
}
export type NotesStore = {
	readonly get: (ctx: ExtensionContext) => Promise<SessionNotes>;
	readonly roots: () => readonly string[];
	readonly recovery: (ctx: ExtensionContext) => NotesRecovery | undefined;
};
type SessionState =
	| { readonly kind: "initializing"; readonly value: Promise<SessionNotes> }
	| { readonly kind: "ready"; readonly value: SessionNotes };
export function createNotesStore(pi: ExtensionAPI): NotesStore {
	const sessions = new Map<string, SessionState>();
	const roots = new Set<string>();
	const get = (ctx: ExtensionContext): Promise<SessionNotes> => {
		const key = sessionKey(ctx);
		const existing = sessions.get(key);
		if (existing !== undefined) {
			return existing.kind === "initializing"
				? existing.value
				: Promise.resolve(existing.value);
		}
		const bindings = bindingsOf(ctx.sessionManager.getEntries());
		const header = ctx.sessionManager.getHeader();
		const root =
			bindings.findLast((binding) => header !== null && sameOwner(binding.owner, header))
				?.root ?? canonicalPath(notesDir(ctx.cwd));
		roots.add(root);
		for (const binding of bindings) {
			roots.add(binding.root);
		}
		const initialized = loadNotesBinding(ctx.sessionManager, root)
			.then(({ binding, source, created }) => {
				if (created) {
					pi.appendEntry(NOTES_BINDING, binding);
				}
				const session = new SessionNotes(pi, binding, ctx.sessionManager, source);
				for (const scope of session.scopes) {
					roots.add(scope.root);
				}
				sessions.set(key, { kind: "ready", value: session });
				return session;
			})
			.catch((error: unknown) => {
				sessions.delete(key);
				throw error;
			});
		sessions.set(key, { kind: "initializing", value: initialized });
		return initialized;
	};
	return {
		get,
		roots: () => [...roots],
		recovery: (ctx: ExtensionContext) => {
			const state = sessions.get(sessionKey(ctx));
			return state?.kind === "ready" ? state.value.recovery : undefined;
		},
	};
}
