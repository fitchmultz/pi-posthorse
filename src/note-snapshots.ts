import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./contracts.ts";
import { publishFile } from "./files.ts";
import {
	notePath,
	parseBinding,
	sameOwner,
	scopeDirectory,
	type ForkBinding,
	type NoteAddress,
	type NoteBinding,
	type NoteIdentity,
	type NoteSeed,
} from "./note-scopes.ts";

export function fileIdentity(info: NoteIdentity): NoteIdentity {
	return {
		size: info.size,
		mtimeMs: info.mtimeMs,
		ctimeMs: info.ctimeMs,
		ino: info.ino,
		dev: info.dev,
	};
}
export function sameIdentity(left: NoteIdentity, right: NoteIdentity): boolean {
	return (
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.ino === right.ino &&
		left.dev === right.dev
	);
}
export async function fileDigest(path: string, signal?: AbortSignal): Promise<string> {
	const file = await open(path, "r");
	try {
		const hash = createHash("sha256");
		for await (const chunk of file.createReadStream({ autoClose: false })) {
			signal?.throwIfAborted();
			const bytes: unknown = chunk;
			if (!(bytes instanceof Uint8Array)) {
				throw new TypeError("Expected binary file data.");
			}
			hash.update(bytes);
		}
		return hash.digest("hex");
	} finally {
		await file.close();
	}
}
export async function readManifest(directory: string): Promise<ForkBinding | undefined> {
	try {
		const raw: unknown = JSON.parse(
			await readFile(join(dirname(directory), "manifest.json"), "utf8"),
		);
		const binding = parseBinding(raw);
		return binding?.kind === "fork" && scopeDirectory(binding) === directory
			? binding
			: undefined;
	} catch (error) {
		if (
			error instanceof SyntaxError ||
			(isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR"))
		) {
			return;
		}
		throw error;
	}
}
export type SnapshotNote = {
	readonly path: string;
	readonly source: NoteAddress;
	readonly lineage: NoteAddress;
	readonly anchors: readonly string[];
};
const NOTE_IO_BATCH = 16;
export async function mapBatch<Input, Output>(
	items: readonly Input[],
	fn: (item: Input) => Promise<Output>,
): Promise<Output[]> {
	const results: Output[] = [];
	for (let start = 0; start < items.length; start += NOTE_IO_BATCH) {
		const settled = await Promise.allSettled(
			items.slice(start, start + NOTE_IO_BATCH).map((item) => fn(item)),
		);
		for (const item of settled) {
			if (item.status === "rejected") {
				throw item.reason instanceof Error ? item.reason : new Error(String(item.reason));
			}
			results.push(item.value);
		}
	}
	return results;
}
type CopyResult =
	| { readonly kind: "verified"; readonly seed: NoteSeed }
	| { readonly kind: "unverified"; readonly error: Error };
async function copyNote(note: SnapshotNote, destination: string): Promise<CopyResult> {
	const source = notePath(note.source, note.source.path);
	const [before] = await Promise.all([
		stat(source),
		mkdir(dirname(destination), { recursive: true }),
	]);
	await copyFile(source, destination, constants.COPYFILE_EXCL);
	try {
		const after = await stat(source);
		if (!sameIdentity(before, after)) {
			throw new Error(
				`Source note changed during snapshot: ${source}. Retry initialization.`,
			);
		}
		await utimes(destination, before.atimeMs / 1000, before.mtimeMs / 1000);
		const [digest, destInfo] = await Promise.all([fileDigest(destination), stat(destination)]);
		return { kind: "verified", seed: { ...note, digest, identity: fileIdentity(destInfo) } };
	} catch (error) {
		return {
			kind: "unverified",
			error: error instanceof Error ? error : new Error(String(error)),
		};
	}
}
type SnapshotPreparation =
	| { readonly kind: "existing"; readonly binding: ForkBinding }
	| { readonly kind: "empty" }
	| { readonly kind: "staging"; readonly stage: string; readonly container: string };
async function prepareSnapshot(
	binding: ForkBinding,
	notes: readonly SnapshotNote[],
): Promise<SnapshotPreparation> {
	const directory = scopeDirectory(binding);
	const existing = await readManifest(directory);
	if (existing !== undefined && sameOwner(existing.owner, binding.owner)) {
		return { kind: "existing", binding: existing };
	}
	const container = dirname(directory);
	if (
		await lstat(container).catch((error: unknown) => {
			if (isRecord(error) && error.code === "ENOENT") {
				return;
			}
			throw error;
		})
	) {
		throw new Error(`Incomplete notes snapshot: preserving unexpected data at ${container}.`);
	}
	if (notes.length === 0) {
		return { kind: "empty" };
	}
	await mkdir(dirname(container), { recursive: true });
	const stage = await mkdtemp(join(dirname(container), ".staging-"));
	return { kind: "staging", stage, container };
}
/** Publication is the ownership boundary. An existing unrelated directory is never overwritten. */
export async function snapshot(
	binding: ForkBinding,
	notes: readonly SnapshotNote[],
): Promise<ForkBinding> {
	const preparation = await prepareSnapshot(binding, notes);
	if (preparation.kind !== "staging") {
		return preparation.kind === "existing" ? preparation.binding : binding;
	}
	const { stage, container } = preparation;
	try {
		// Keep each file's identity and digest paired with the bytes actually copied.
		const seeds = await mapBatch(notes, async (note) => {
			const result = await copyNote(
				note,
				notePath({ root: stage, scope: "notes" }, note.path),
			);
			if (result.kind === "unverified") {
				throw result.error;
			}
			return result.seed;
		});
		const complete: ForkBinding = { ...binding, seeds };
		await writeFile(join(stage, "manifest.json"), JSON.stringify(complete), { flag: "wx" });
		await rename(stage, container);
		return complete;
	} catch (error) {
		throw new Error(
			`Incomplete notes snapshot for ${scopeDirectory(binding)}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	} finally {
		await rm(stage, { recursive: true, force: true });
	}
}
/** Called inside the destination's native mutation queue, never queues that path recursively. */
export async function adoptNote(binding: NoteBinding, note: SnapshotNote): Promise<CopyResult> {
	return copyNote(note, notePath(binding, note.path));
}
/** Empty initialized scopes publish their manifest when the first note is created. */
export async function ensureManifest(binding: NoteBinding): Promise<void> {
	if (binding.kind !== "fork") {
		return;
	}
	const path = join(dirname(scopeDirectory(binding)), "manifest.json");
	await mkdir(dirname(path), { recursive: true });
	try {
		await writeFile(path, JSON.stringify(binding), { flag: "wx" });
	} catch (error) {
		if (!isRecord(error) || error.code !== "EEXIST") {
			throw error;
		}
		const existing = await readManifest(scopeDirectory(binding));
		if (existing === undefined || !sameOwner(existing.owner, binding.owner)) {
			throw new Error(`Preserving unexpected notes manifest at ${path}.`, { cause: error });
		}
	}
}

export async function saveAdoption(binding: NoteBinding, seed: NoteSeed): Promise<void> {
	if (binding.kind !== "fork") {
		return;
	}
	const path = join(dirname(scopeDirectory(binding)), "manifest.json");
	await withFileMutationQueue(path, async () => {
		await ensureManifest(binding);
		const previous = (await readManifest(scopeDirectory(binding))) ?? binding;
		const seeds = [...previous.seeds.filter((item) => item.path !== seed.path), seed];
		await publishFile(path, JSON.stringify({ ...previous, seeds }));
	});
}
