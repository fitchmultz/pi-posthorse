import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { isRecord, type EntryLike } from "./contracts.ts";

export const NOTES_BINDING = "posthorse-notes-scope";
export const NOTES_TOUCH = "posthorse-note-touch";
const ownerSchema = Type.Object({ id: Type.String(), timestamp: Type.String() });
const scopeSchema = Type.Object({ root: Type.String(), scope: Type.String() });
const addressSchema = Type.Object({ ...scopeSchema.properties, path: Type.String() });
const identitySchema = Type.Object({
	size: Type.Number(),
	mtimeMs: Type.Number(),
	ctimeMs: Type.Number(),
	ino: Type.Number(),
	dev: Type.Number(),
});
const seedSchema = Type.Object({
	path: Type.String(),
	source: addressSchema,
	lineage: addressSchema,
	digest: Type.String(),
	identity: identitySchema,
	anchors: Type.Array(Type.String()),
});
const sharedBinding = {
	version: Type.Literal(1),
	owner: ownerSchema,
	root: Type.String(),
};
const bindingSchema = Type.Union([
	Type.Object({ ...sharedBinding, kind: Type.Literal("project"), scope: Type.Literal("") }),
	Type.Object({
		...sharedBinding,
		kind: Type.Literal("fork"),
		scope: Type.String(),
		source: Type.Union([scopeSchema, Type.Null()]),
		seeds: Type.Array(seedSchema),
		absent: Type.Array(Type.String()),
	}),
]);
const touchSchema = Type.Object({
	version: Type.Literal(1),
	owner: ownerSchema,
	scope: scopeSchema,
	rootToolCallId: Type.String(),
	toolCallId: Type.String(),
	files: Type.Array(
		Type.Object({
			...addressSchema.properties,
			seed: Type.Optional(seedSchema),
			kind: Type.Union([
				Type.Literal("read"),
				Type.Literal("write"),
				Type.Literal("clear"),
				Type.Literal("delete"),
				Type.Literal("adopt"),
			]),
		}),
	),
});
type Immutable<T> = T extends readonly (infer Item)[]
	? readonly Immutable<Item>[]
	: T extends object
		? { readonly [Key in keyof T]: Immutable<T[Key]> }
		: T;
export type NoteOwner = Immutable<Static<typeof ownerSchema>>;
export type NoteScope = Immutable<Static<typeof scopeSchema>>;
export type NoteAddress = Immutable<Static<typeof addressSchema>>;
export type NoteIdentity = Immutable<Static<typeof identitySchema>>;
export type NoteSeed = Immutable<Static<typeof seedSchema>>;
export type NoteBinding = Immutable<Static<typeof bindingSchema>>;
export type NoteTouchRecord = Immutable<Static<typeof touchSchema>>;
export type ForkBinding = Extract<NoteBinding, { readonly kind: "fork" }>;

export function sameOwner(left: NoteOwner, right: NoteOwner): boolean {
	return left.id === right.id && left.timestamp === right.timestamp;
}
export function forkScope(owner: NoteOwner): string {
	return `.forks/${new Date(owner.timestamp).toISOString().replace(/[:.]/gu, "-")}_${encodeURIComponent(owner.id)}/notes`;
}
export function scopeDirectory(scope: NoteScope): string {
	return join(scope.root, scope.scope);
}
export function sameScope(left: NoteScope, right: NoteScope): boolean {
	return left.root === right.root && left.scope === right.scope;
}
export function inside(directory: string, path: string): boolean {
	const part = relative(directory, path);
	return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}
export function noteRelative(path: string): string {
	if (path === "" || isAbsolute(path) || path.includes("\0")) {
		throw new Error(`Invalid note path ${JSON.stringify(path)}: use a relative path.`);
	}
	const normalized = relative(resolve("/"), resolve("/", path));
	if (
		path.split(/[/\\]/u).includes("..") ||
		normalized === "" ||
		normalized.split(sep)[0] === ".forks"
	) {
		throw new Error(
			`Invalid note path ${JSON.stringify(path)}: must stay outside managed .forks paths and inside its scope.`,
		);
	}
	return normalized;
}
/** Resolve existing ancestors too, so aliases to files not created yet have one owner. */
export function canonicalPath(path: string): string {
	const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
	try {
		return realpathSync(absolute);
	} catch (error) {
		if (!isRecord(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
			throw error;
		}
		const parent = dirname(absolute);
		return parent === absolute
			? absolute
			: join(canonicalPath(parent), relative(parent, absolute));
	}
}
export function notePath(scope: NoteScope, path: string): string {
	const directory = scopeDirectory(scope);
	const target = join(directory, noteRelative(path));
	const canonical = canonicalPath(target);
	const escapesPrivate = scope.scope !== "" && !inside(canonicalPath(directory), canonical);
	const entersManaged =
		scope.scope === "" && inside(canonicalPath(join(scope.root, ".forks")), canonical);
	if (escapesPrivate || entersManaged) {
		throw new Error(`Note path leaves its scope through a filesystem alias: ${target}`);
	}
	return target;
}
function validScope(scope: NoteScope): boolean {
	return (
		isAbsolute(scope.root) &&
		(scope.scope === "" || /^\.forks\/[^/\\]+\/notes$/u.test(scope.scope))
	);
}
function validSeed(seed: NoteSeed): boolean {
	try {
		return (
			noteRelative(seed.path) === seed.path &&
			validScope(seed.source) &&
			validScope(seed.lineage) &&
			noteRelative(seed.source.path) === seed.source.path &&
			noteRelative(seed.lineage.path) === seed.lineage.path
		);
	} catch {
		return false;
	}
}
function validNoteName(path: string): boolean {
	try {
		return noteRelative(path) === path;
	} catch {
		return false;
	}
}
function validFork(binding: ForkBinding): boolean {
	return (
		binding.scope === forkScope(binding.owner) &&
		(binding.source === null || validScope(binding.source)) &&
		binding.seeds.every(validSeed) &&
		binding.absent.every(validNoteName)
	);
}
export function parseBinding(value: unknown): NoteBinding | undefined {
	if (
		!Check(bindingSchema, value) ||
		!validScope(value) ||
		value.owner.id === "" ||
		!Number.isFinite(Date.parse(value.owner.timestamp))
	) {
		return;
	}
	if (value.kind === "fork" && !validFork(value)) {
		return;
	}
	return value;
}
export function bindingsOf(entries: readonly EntryLike[]): NoteBinding[] {
	return entries.flatMap((entry) => {
		const binding =
			entry.type === "custom" && entry.customType === NOTES_BINDING
				? parseBinding(entry.data)
				: undefined;
		return binding === undefined ? [] : [binding];
	});
}
export function touchRecords(entries: readonly EntryLike[]): NoteTouchRecord[] {
	return entries.flatMap((entry) => {
		if (
			entry.type !== "custom" ||
			entry.customType !== NOTES_TOUCH ||
			!Check(touchSchema, entry.data) ||
			!validScope(entry.data.scope)
		) {
			return [];
		}
		try {
			return entry.data.files.every(
				(file) =>
					validScope(file) &&
					noteRelative(file.path) === file.path &&
					(file.seed === undefined || validSeed(file.seed)),
			)
				? [entry.data]
				: [];
		} catch {
			return [];
		}
	});
}
export function seedsOf(binding: NoteBinding, entries: readonly EntryLike[]): readonly NoteSeed[] {
	const seeds = new Map(
		binding.kind === "fork" ? binding.seeds.map((seed) => [seed.path, seed]) : [],
	);
	for (const record of touchRecords(entries)) {
		if (!sameOwner(record.owner, binding.owner)) {
			continue;
		}
		for (const file of record.files) {
			if (file.seed !== undefined && sameScope(file, binding)) {
				seeds.set(file.path, file.seed);
			}
		}
	}
	return [...seeds.values()];
}
export function ownedPaths(binding: NoteBinding, entries: readonly EntryLike[]): Set<string> {
	const paths = new Set(
		binding.kind === "fork"
			? [...binding.absent, ...binding.seeds.map((seed) => seed.path)]
			: [],
	);
	for (const record of touchRecords(entries)) {
		if (!sameOwner(record.owner, binding.owner)) {
			continue;
		}
		for (const file of record.files) {
			if (file.kind !== "read" && sameScope(binding, file)) {
				paths.add(file.path);
			}
		}
	}
	return paths;
}
/** Pure longest-prefix matching is also used for historical paths on unavailable filesystems. */
export function matchNoteDirectory(
	path: string,
	directories: readonly string[],
): { readonly directory: string; readonly path: string } | undefined {
	const slash = path.replaceAll("\\", "/");
	for (const directory of directories.toSorted((a, b) => b.length - a.length)) {
		const normalized = directory.replaceAll("\\", "/").replace(/\/+$/u, "");
		const part = slash.startsWith(`${normalized}/`) ? slash.slice(normalized.length + 1) : "";
		if (part !== "" && part !== ".forks" && !part.startsWith(".forks/")) {
			return { directory, path: part };
		}
	}
	return;
}
export function addressOf(path: string, scopes: readonly NoteScope[]): NoteAddress | undefined {
	const candidates = scopes.map((scope) => ({
		scope,
		directory: canonicalPath(scopeDirectory(scope)),
	}));
	for (const target of [canonicalPath(path), resolve(path)]) {
		const match = matchNoteDirectory(
			target,
			candidates.map((candidate) => candidate.directory),
		);
		const candidate =
			match === undefined
				? undefined
				: candidates.find((item) => item.directory === match.directory);
		if (match !== undefined && candidate !== undefined) {
			return { ...candidate.scope, path: match.path };
		}
		if (
			scopes.some(
				(scope) =>
					scope.scope === "" && inside(canonicalPath(join(scope.root, ".forks")), target),
			)
		) {
			return;
		}
	}
	return;
}
