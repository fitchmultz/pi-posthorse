import { readdir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { isRecord, presentText } from "./contracts.ts";
import { isPublicationTemporaryName } from "./files.ts";
import {
	canonicalPath,
	inside,
	notePath,
	scopeDirectory,
	type NoteIdentity,
	type NoteScope,
} from "./note-scopes.ts";
import { fileIdentity } from "./note-snapshots.ts";

export type NoteFile = NoteIdentity & { readonly path: string };
/** Maximum overlapped stats; 16, 64 and 256 were equivalent on the measured 212,751-note tree. */
const WALK_BATCH = 64;
async function statIfPresent(path: string) {
	try {
		return await stat(path);
	} catch (error) {
		if (isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
			return;
		}
		throw error;
	}
}
/** Preserve depth-first listing order and recheck later entries after visiting each folder. */
async function* folderEntries(directory: string, signal: AbortSignal | undefined) {
	const entries = (await readdir(directory, { withFileTypes: true })).filter(
		(entry) => !isPublicationTemporaryName(entry.name),
	);
	let start = 0;
	while (start < entries.length) {
		signal?.throwIfAborted();
		const batch = entries.slice(start, start + WALK_BATCH);
		const firstFolder = batch.findIndex(
			(entry) => entry.isDirectory() || entry.isSymbolicLink(),
		);
		const listed = await Promise.all(
			batch
				.slice(0, firstFolder === -1 ? batch.length : firstFolder + 1)
				.map(async (entry) => {
					const path = join(directory, entry.name);
					return { path, info: await statIfPresent(path), alias: entry.isSymbolicLink() };
				}),
		);
		for (const { path, info, alias } of listed) {
			start += 1;
			if (info !== undefined) {
				yield { path, info, alias };
			}
			if (info?.isDirectory() === true) {
				break;
			}
		}
	}
}
type WalkState = {
	readonly ancestors: readonly string[];
	readonly scope: NoteScope;
	readonly notice: (text: string) => void;
};
function allowedTarget(path: string, state: WalkState): boolean {
	const scopeRoot = canonicalPath(scopeDirectory(state.scope));
	if (state.scope.scope === "") {
		return !inside(canonicalPath(join(state.scope.root, ".forks")), path);
	}
	if (inside(scopeRoot, path)) {
		return true;
	}
	state.notice(`Not indexed: alias outside private notes scope (${path}).`);
	return false;
}
async function walk(
	directory: string,
	signal: AbortSignal | undefined,
	state: WalkState,
): Promise<NoteFile[]> {
	signal?.throwIfAborted();
	const root = await realpath(directory);
	if (state.ancestors.includes(root) || !allowedTarget(root, state)) {
		return [];
	}
	const next: WalkState = { ...state, ancestors: [...state.ancestors, root] };
	const files: NoteFile[] = [];
	for await (const { path, info, alias } of folderEntries(directory, signal)) {
		if (info.isDirectory()) {
			for (const file of await walk(path, signal, next)) {
				files.push(file);
			}
		} else if (!alias || allowedTarget(canonicalPath(path), state)) {
			files.push({ path, ...fileIdentity(info) });
		}
	}
	return files;
}
export async function notesUnder(
	scope: NoteScope,
	folder: string | undefined,
	options: { readonly signal: AbortSignal | undefined; readonly notice: (text: string) => void },
): Promise<NoteFile[]> {
	const requested = presentText(folder);
	const target =
		requested === undefined || requested === "."
			? scopeDirectory(scope)
			: notePath(scope, requested);
	if (isPublicationTemporaryName(basename(target))) {
		return [];
	}
	const info = await statIfPresent(target);
	options.signal?.throwIfAborted();
	if (info === undefined) {
		return [];
	}
	const files = info.isDirectory()
		? await walk(target, options.signal, { scope, ancestors: [], notice: options.notice })
		: [{ path: target, ...fileIdentity(info) }];
	options.signal?.throwIfAborted();
	return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
