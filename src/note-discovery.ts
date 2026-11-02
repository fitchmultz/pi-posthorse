import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { isRecord } from "./contracts.ts";
import { sessionNoteTouches } from "./note-evidence.ts";
import { notesUnder, type NoteFile } from "./note-inventory.ts";
import {
	fileDigest,
	fileIdentity,
	mapBatch,
	readManifest,
	sameIdentity,
} from "./note-snapshots.ts";
import {
	sameScope,
	scopeDirectory,
	type ForkBinding,
	type NoteAddress,
	type NoteIdentity,
	type NoteScope,
	type NoteSeed,
} from "./note-scopes.ts";
import type { SessionNotes } from "./note-store.ts";

export type DiscoveredNote = NoteFile & {
	readonly address: NoteAddress;
	readonly lineage: NoteAddress;
	readonly seed: NoteSeed | undefined;
	readonly copies: readonly NoteAddress[];
};
type ScopeInventory = { readonly scope: NoteScope; readonly manifest: ForkBinding | undefined };
type DiscoveryOptions = {
	readonly path?: string | undefined;
	readonly scope?: string | undefined;
	readonly signal: AbortSignal | undefined;
};
type ComparisonOptions = DiscoveryOptions & { readonly notice: (message: string) => void };
type DigestCache = {
	readonly identity: NoteIdentity;
	readonly digest: string;
	readonly revision: number;
};
async function projectScopes(
	session: SessionNotes,
	notice: (message: string) => void,
): Promise<ScopeInventory[]> {
	const scopes: ScopeInventory[] = [
		{ scope: { root: session.binding.root, scope: "" }, manifest: undefined },
	];
	const directory = join(session.binding.root, ".forks");
	const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
		if (isRecord(error) && error.code === "ENOENT") {
			return [];
		}
		throw error;
	});
	const candidates = entries.filter((entry) => !entry.name.startsWith(".staging-"));
	const manifests = await mapBatch(candidates, async (entry) =>
		entry.isDirectory() ? readManifest(join(directory, entry.name, "notes")) : undefined,
	);
	for (const [index, entry] of candidates.entries()) {
		const path = join(directory, entry.name);
		const manifest = manifests[index];
		if (manifest === undefined || manifest.root !== session.binding.root) {
			notice(`Not indexed: unmanaged or incomplete notes data at ${path}.`);
		} else {
			scopes.push({ scope: manifest, manifest });
		}
	}
	if (!scopes.some(({ scope }) => sameScope(scope, session.binding))) {
		scopes.push({
			scope: session.binding,
			manifest: session.binding.kind === "fork" ? session.binding : undefined,
		});
	}
	return scopes;
}
async function scopedFiles(
	inventory: ScopeInventory,
	options: DiscoveryOptions,
	notice: (message: string) => void,
): Promise<DiscoveredNote[]> {
	const files = await notesUnder(inventory.scope, options.path, {
		signal: options.signal,
		notice,
	});
	const seeds = new Map(inventory.manifest?.seeds.map((seed) => [seed.path, seed]));
	return files.map((file) => {
		const path = relative(scopeDirectory(inventory.scope), file.path);
		const address = { root: inventory.scope.root, scope: inventory.scope.scope, path };
		const seed = seeds.get(path);
		return Object.assign({}, file, {
			address,
			seed,
			lineage: seed?.lineage ?? address,
			copies: [],
		});
	});
}
function noteKey(address: NoteAddress): string {
	return JSON.stringify([address.root, address.scope, address.path]);
}
export function noteReadTarget(note: DiscoveredNote): string {
	return JSON.stringify({ scope: scopeDirectory(note.address), path: note.address.path });
}
export function noteLabel(note: DiscoveredNote, session: SessionNotes, labeled: boolean): string {
	if (!labeled) {
		return note.address.path;
	}
	const mode = sameScope(note.address, session.binding) ? "current" : "read-only";
	const copies =
		note.copies.length === 0
			? ""
			: `; identical copies: ${note.copies.map((copy) => JSON.stringify({ scope: scopeDirectory(copy), path: copy.path })).join(", ")}`;
	return `${note.address.path} [${mode}; read ${noteReadTarget(note)}${copies}]`;
}
async function readReference(
	session: SessionNotes,
	path: string,
	signal: AbortSignal | undefined,
): Promise<DiscoveredNote | undefined> {
	const target = await session.read(path, { signal });
	if (target.writable) {
		return;
	}
	const info = await stat(target.path).catch((error: unknown) => {
		if (isRecord(error) && error.code === "ENOENT") {
			return;
		}
		throw error;
	});
	if (info?.isFile() !== true) {
		return;
	}
	return {
		...fileIdentity(info),
		path: target.path,
		address: target.address,
		lineage: target.address,
		seed: undefined,
		copies: [],
	};
}
export class NoteDiscovery {
	readonly #digests = new Map<string, DigestCache>();
	#knownDigest(note: DiscoveredNote, revision: number): string | undefined {
		const cached = this.#digests.get(note.path);
		if (
			cached !== undefined &&
			cached.revision === revision &&
			sameIdentity(cached.identity, note)
		) {
			return cached.digest;
		}
		if (revision === 0 && note.seed !== undefined && sameIdentity(note.seed.identity, note)) {
			return note.seed.digest;
		}
		return;
	}
	async #digest(
		note: DiscoveredNote,
		session: SessionNotes,
		options: ComparisonOptions,
	): Promise<string | undefined> {
		const { signal } = options;
		const revision = session.revision(note.path);
		const known = this.#knownDigest(note, revision);
		if (known !== undefined) {
			return known;
		}
		try {
			const digest = await fileDigest(note.path, signal);
			if (!sameIdentity(note, await stat(note.path))) {
				return;
			}
			this.#digests.set(note.path, { identity: note, digest, revision });
			return digest;
		} catch (error) {
			signal?.throwIfAborted();
			options.notice(
				`Duplicate comparison unavailable for ${noteReadTarget(note)}: ${error instanceof Error ? error.message : String(error)}. Copies remain separate.`,
			);
			return;
		}
	}
	async #collapse(
		files: readonly DiscoveredNote[],
		session: SessionNotes,
		options: ComparisonOptions,
	): Promise<DiscoveredNote[]> {
		const groups = new Map<string, DiscoveredNote[]>();
		for (const file of files) {
			const key = `${noteKey(file.lineage)}\0${file.size}`;
			const group = groups.get(key) ?? [];
			group.push(file);
			groups.set(key, group);
		}
		const selected: DiscoveredNote[] = [];
		for (const group of groups.values()) {
			if (group.length === 1) {
				selected.push(...group);
				continue;
			}
			const matches = new Map<string, DiscoveredNote>();
			group.sort(
				(a, b) =>
					Number(sameScope(b.address, session.binding)) -
					Number(sameScope(a.address, session.binding)),
			);
			const results = await mapBatch(group, async (file) => {
				const fileNotices: string[] = [];
				const digest = await this.#digest(file, session, {
					...options,
					notice: (text) => {
						fileNotices.push(text);
					},
				});
				return { file, digest, fileNotices };
			});
			for (const { file, digest, fileNotices } of results) {
				fileNotices.forEach(options.notice);
				// Only same-lineage, same-size candidates need content comparison.
				const previous = digest === undefined ? undefined : matches.get(digest);
				if (previous === undefined || digest === undefined) {
					matches.set(digest ?? noteKey(file.address), file);
				} else {
					matches.set(digest, {
						...previous,
						copies: [...previous.copies, file.address],
					});
				}
			}
			selected.push(...matches.values());
		}
		return selected;
	}
	async #references(session: SessionNotes, options: DiscoveryOptions): Promise<DiscoveredNote[]> {
		if (session.binding.kind !== "fork" || options.scope !== undefined) {
			return [];
		}
		const recovery = session.recovery;
		const { touches } = sessionNoteTouches({
			branch: session.branch,
			allEntries: recovery.entries,
			projected: session.projection,
			retained: new Set(),
			directories: new Set(session.scopes.map(scopeDirectory)),
		});
		const paths = new Set(touches.map((touch) => touch.notePath));
		const candidates = [...paths].filter(
			(path) =>
				!session.owns(path) &&
				(options.path === undefined ||
					path === options.path ||
					path.startsWith(`${options.path}/`)),
		);
		const resolved = await mapBatch(candidates, (path) =>
			readReference(session, path, options.signal),
		);
		return resolved.filter((file): file is DiscoveredNote => file !== undefined);
	}
	async list(
		session: SessionNotes,
		options: DiscoveryOptions,
	): Promise<{
		readonly files: readonly DiscoveredNote[];
		readonly notices: readonly string[];
		readonly labeled: boolean;
	}> {
		const notices: string[] = [];
		const notice = (text: string) => {
			notices.push(text);
		};
		const requestedScope = options.scope;
		const [scopes, references] = await Promise.all([
			requestedScope === undefined
				? projectScopes(session, notice)
				: (async () => [
						{
							scope: await session.selectScope(requestedScope),
							manifest: await readManifest(requestedScope),
						},
					])(),
			this.#references(session, options),
		]);
		const scoped = await mapBatch(scopes, async (scope) => {
			const scopeNotices: string[] = [];
			const scopeFiles = await scopedFiles(scope, options, (text) => {
				scopeNotices.push(text);
			});
			return { scopeFiles, scopeNotices };
		});
		const files: DiscoveredNote[] = [];
		for (const { scopeFiles, scopeNotices } of scoped) {
			// Preserve native listing order while walking each scope independently.
			notices.push(...scopeNotices);
			files.push(...scopeFiles);
		}
		for (const reference of references) {
			if (!files.some((file) => noteKey(file.address) === noteKey(reference.address))) {
				files.push(reference);
			}
		}
		const selected =
			options.scope === undefined
				? await this.#collapse(files, session, { ...options, notice })
				: files;
		return {
			files: selected.sort((a, b) => b.mtimeMs - a.mtimeMs),
			notices,
			labeled:
				scopes.length > 1 || scopes.some(({ scope }) => !sameScope(scope, session.binding)),
		};
	}
}
