import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord, type EntryLike } from "./contracts.ts";
import { sessionLines } from "./session-lines.ts";
import { parseSessionLine } from "./session-files.ts";
import { sessionNoteTouches } from "./note-evidence.ts";
import { mapBatch, readManifest, snapshot, type SnapshotNote } from "./note-snapshots.ts";
import {
	addressOf,
	bindingsOf,
	canonicalPath,
	forkScope,
	notePath,
	sameOwner,
	sameScope,
	scopeDirectory,
	ownedPaths,
	seedsOf,
	type ForkBinding,
	type NoteAddress,
	type NoteBinding,
	type NoteScope,
} from "./note-scopes.ts";

type NotesManager = ExtensionContext["sessionManager"];
export type NoteSource = {
	readonly entries: readonly EntryLike[];
	readonly file: string | undefined;
};
type Candidate = SnapshotNote & { readonly cleared: boolean };
function includedJournalType(type: string | undefined, legacy: boolean): boolean {
	return legacy || type === undefined || type === "session" || type === "custom";
}
async function journalMetadata(
	file: string,
	legacy: boolean,
	signal?: AbortSignal,
): Promise<readonly EntryLike[]> {
	const entries: EntryLike[] = [];
	try {
		for await (const line of sessionLines(file, signal)) {
			const type = /^\s*\{\s*"type"\s*:\s*"([^"]+)"/u.exec(line.head)?.[1];
			if (!includedJournalType(type, legacy)) {
				continue;
			}
			const entry = parseSessionLine(await line.text());
			if (entry !== undefined && includedJournalType(entry.type, legacy)) {
				entries.push(entry);
			}
		}
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") {
			throw error;
		}
	}
	return entries;
}
/** Read only; opening a SessionManager here could migrate or create an archived source. */
export async function sourceEntries(
	file: string | undefined,
	signal?: AbortSignal,
): Promise<readonly EntryLike[]> {
	let current = file;
	const seen = new Set<string>();
	const entries: EntryLike[] = [];
	while (current !== undefined && !seen.has(current)) {
		seen.add(current);
		// Each ancestor's current ownership prevents falling through a deleted owned file.
		const metadata = await journalMetadata(current, false, signal);
		entries.push(...metadata);
		current = metadata.find((entry) => entry.type === "session")?.parentSession;
	}
	return entries;
}
function legacySource(entries: readonly EntryLike[]): NoteScope | undefined {
	const { touches, defaultDir } = sessionNoteTouches({
		branch: entries,
		allEntries: entries,
		projected: [],
		retained: new Set(),
	});
	const roots = new Set(defaultDir === undefined ? [] : [defaultDir]);
	for (const touch of touches) {
		if (touch.absPath !== undefined && touch.absPath.endsWith(`/${touch.notePath}`)) {
			roots.add(touch.absPath.slice(0, -touch.notePath.length - 1));
		}
	}
	if ([...roots].some((root) => !isAbsolute(root))) {
		return;
	}
	const canonical = new Set([...roots].map(canonicalPath));
	const [root] = canonical;
	return canonical.size === 1 && root !== undefined ? { root, scope: "" } : undefined;
}
async function sourceScope(
	manager: NotesManager,
	source: NoteSource,
): Promise<NoteScope | undefined> {
	const header = source.entries.find((entry) => entry.type === "session");
	const bindings = bindingsOf([...manager.getEntries(), ...source.entries]);
	const binding =
		header?.id === undefined || header.timestamp === undefined
			? bindings.at(-1)
			: bindings.findLast(
					(candidate) =>
						candidate.owner.id === header.id &&
						candidate.owner.timestamp === header.timestamp,
				);
	if (binding !== undefined) {
		return binding;
	}
	const legacy =
		source.file === undefined ? manager.getEntries() : await journalMetadata(source.file, true);
	return legacySource(legacy.length > 0 ? legacy : manager.getEntries());
}
export async function resolveReference(
	scope: NoteScope,
	path: string,
	entries: readonly EntryLike[],
): Promise<NoteAddress | undefined> {
	let source: NoteScope | null = scope;
	const bindings = bindingsOf(entries);
	const visited = new Set<string>();
	while (source !== null) {
		const current: NoteScope = source;
		const directory = scopeDirectory(current);
		if (visited.has(directory)) {
			throw new Error(`Cyclic note provenance at ${directory}.`);
		}
		visited.add(directory);
		if (existsSync(notePath(current, path))) {
			return { ...current, path };
		}
		// A manifest includes later adoptions; the journal includes later writes and deletions.
		const binding: NoteBinding | undefined =
			(await readManifest(directory)) ??
			bindings.findLast((candidate) => sameScope(candidate, current));
		if (
			binding === undefined ||
			binding.kind === "project" ||
			ownedPaths(binding, entries).has(path)
		) {
			return;
		}
		source = binding.source;
	}
	return;
}
function touchedCandidates(
	evidence: ReturnType<typeof sessionNoteTouches>,
	scopes: readonly NoteScope[],
	allEntries: readonly EntryLike[],
): Map<string, Candidate> {
	const bindings = bindingsOf(allEntries);
	const selected = new Map<string, Candidate>();
	for (const touch of evidence.touches) {
		const absolute =
			touch.absPath ??
			(evidence.defaultDir === undefined
				? undefined
				: join(evidence.defaultDir, touch.notePath));
		const address = absolute === undefined ? undefined : addressOf(absolute, scopes);
		if (address === undefined) {
			continue;
		}
		const owner = bindings.findLast((binding) => sameScope(binding, address));
		const lineage =
			owner === undefined
				? address
				: (seedsOf(owner, allEntries).find((seed) => seed.path === address.path)?.lineage ??
					address);
		selected.set(address.path, {
			path: address.path,
			source: address,
			lineage,
			anchors: [touch.receiptId ?? touch.entryId],
			cleared: touch.kind === "clear",
		});
	}
	return selected;
}
function seedCandidates(
	manager: NotesManager,
	source: NoteSource,
	scope: NoteScope | undefined,
): Candidate[] {
	const allEntries = [...manager.getEntries(), ...source.entries];
	const bindings = bindingsOf(allEntries);
	const scopes = scope === undefined ? bindings : [...bindings, scope];
	const evidence = sessionNoteTouches({
		branch: manager.getBranch(),
		allEntries,
		projected: manager.buildSessionProjection().entries,
		retained: new Set(),
		directories: new Set(scopes.map(scopeDirectory)),
	});
	if (scope === undefined && evidence.touches.length > 0) {
		throw new Error(
			"Incomplete notes snapshot: the source notes root is missing or ambiguous.",
		);
	}
	const selected = touchedCandidates(evidence, scopes, allEntries);
	for (const binding of bindings) {
		for (const seed of seedsOf(binding, allEntries)) {
			if (
				!selected.has(seed.path) &&
				seed.anchors.some((id) => evidence.visibleIds.has(id))
			) {
				selected.set(seed.path, {
					...seed,
					source: { root: binding.root, scope: binding.scope, path: seed.path },
					cleared: false,
				});
			}
		}
	}
	return [...selected.values()];
}
async function forkBinding(
	manager: NotesManager,
	binding: ForkBinding,
	source: NoteSource,
): Promise<ForkBinding> {
	const scope = await sourceScope(manager, source);
	const candidates = seedCandidates(manager, source, scope);
	const entries = [...manager.getEntries(), ...source.entries];
	const files: SnapshotNote[] = [];
	const absent: string[] = [];
	const addresses = await mapBatch(candidates, (candidate) =>
		resolveReference(scope ?? candidate.source, candidate.path, entries),
	);
	for (const [index, candidate] of candidates.entries()) {
		// Resolve against the immediate parent's files, not a historical ancestor's version.
		const address = addresses[index];
		if (address !== undefined) {
			files.push({
				path: candidate.path,
				source: address,
				lineage: candidate.lineage,
				anchors: candidate.anchors,
			});
		} else if (candidate.cleared) {
			absent.push(candidate.path);
		} else {
			throw new Error(
				`Incomplete notes snapshot: source note ${candidate.path} is unavailable.`,
			);
		}
	}
	return snapshot(
		{
			...binding,
			source: scope === undefined ? null : { root: scope.root, scope: scope.scope },
			absent,
		},
		files,
	);
}
export async function loadNotesBinding(
	manager: NotesManager,
	root: string,
): Promise<{
	readonly binding: NoteBinding;
	readonly source: NoteSource;
	readonly created: boolean;
}> {
	const header = manager.getHeader();
	if (header === null) {
		throw new Error("Pi did not supply the session header for notes ownership.");
	}
	const owner = { id: header.id, timestamp: header.timestamp };
	const own = bindingsOf(manager.getEntries()).findLast((binding) =>
		sameOwner(binding.owner, owner),
	);
	const source: NoteSource = {
		entries: await sourceEntries(header.parentSession),
		file: header.parentSession,
	};
	if (own !== undefined) {
		return { binding: own, source, created: false };
	}
	const inherited = bindingsOf([...manager.getEntries(), ...source.entries]);
	const fork = header.parentSession !== undefined || inherited.length > 0;
	const binding: NoteBinding = fork
		? await forkBinding(
				manager,
				{
					version: 1,
					kind: "fork",
					owner,
					root,
					scope: forkScope(owner),
					source: null,
					seeds: [],
					absent: [],
				},
				source,
			)
		: { version: 1, kind: "project", owner, root, scope: "" };
	return { binding, source, created: true };
}
