import { randomUUID } from "node:crypto";
import {
	createReadStream,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	symlinkSync,
} from "node:fs";
import {
	access,
	constants,
	lstat,
	open,
	readFile,
	readlink,
	realpath,
	rename,
	stat,
	unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./contracts.ts";

async function lstatOrMissing(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") {
			return;
		}
		throw error;
	}
}
/** Resolve every link before normalization, preserving path traversal constraints. */
export async function resolveFileTarget(absolutePath: string): Promise<string> {
	let target = absolutePath;
	const links = new Set<string>();
	for (;;) {
		if (target.endsWith(sep) || target.endsWith("/")) {
			// Trailing separators require an existing directory, never a new regular file.
			// Resolution follows dependent links in filesystem order.
			// oxlint-disable-next-line no-await-in-loop
			await stat(target);
			return realpath(target);
		}
		const parentInput = dirname(target);
		// stat enforces regular-file/.. traversal that macOS realpath alone accepts.
		// oxlint-disable-next-line no-await-in-loop
		if (!(await stat(parentInput)).isDirectory()) {
			throw Object.assign(new Error(`Not a directory: ${parentInput}`), { code: "ENOTDIR" });
		}
		// Each parent must resolve before its child link can be examined.
		// oxlint-disable-next-line no-await-in-loop
		const parent = await realpath(parentInput);
		target = join(parent, basename(target));
		// Link targets cannot be known before examining the current link.
		// oxlint-disable-next-line no-await-in-loop
		const info = await lstatOrMissing(target);
		if (info === undefined) {
			return target;
		}
		if (!info.isSymbolicLink()) {
			return realpath(target);
		}
		if (links.has(target)) {
			throw Object.assign(new Error(`Symlink cycle: ${absolutePath}`), { code: "ELOOP" });
		}
		links.add(target);
		// Preserve .. until the preceding directory symlink has been followed.
		// oxlint-disable-next-line no-await-in-loop
		const link = await readlink(target);
		target = isAbsolute(link) ? link : `${parent}${sep}${link}`;
	}
}
async function existingNote(target: string) {
	const previous = await lstatOrMissing(target);
	if (previous !== undefined && !previous.isFile()) {
		throw Object.assign(new Error(`Cannot publish to a non-regular file: ${target}`), {
			code: previous.isDirectory() ? "EISDIR" : "EINVAL",
			path: target,
		});
	}
	if (previous !== undefined) {
		await access(target, constants.W_OK);
	}
	return previous;
}
/** Same-directory replacement; pre-rename failures preserve the old note and its metadata. */
export async function publishFile(
	path: string,
	content: string,
	signal?: AbortSignal,
): Promise<void> {
	signal?.throwIfAborted();
	const target = await resolveFileTarget(path);
	const previous = await existingNote(target);
	const temporary = join(dirname(target), `.posthorse-${randomUUID()}.tmp`);
	const file = await open(temporary, "wx", previous === undefined ? 0o666 : 0o600);
	try {
		await file.writeFile(content, { signal });
		if (previous !== undefined) {
			const staged = await file.stat();
			if (staged.uid !== previous.uid || staged.gid !== previous.gid) {
				await file.chown(previous.uid, previous.gid);
			}
			await file.chmod(previous.mode & 0o777);
		}
		await file.close();
		signal?.throwIfAborted();
		await rename(temporary, target);
	} catch (error) {
		await file.close().catch(() => {
			/* Preserve the publication failure if closing also fails. */
		});
		await unlink(temporary).catch(() => {
			/* Cleanup must not replace the original publication failure. */
		});
		throw error;
	}
}
/** Raw LF-delimited lines; UTF-8 never encodes LF inside another character. */
export async function* lfLines(
	file: string,
	signal?: AbortSignal,
	highWaterMark = 64 * 1024,
): AsyncGenerator<Buffer> {
	const stream = createReadStream(file, { signal, highWaterMark });
	let pending: Buffer[] = [];
	for await (const chunk of stream) {
		if (!Buffer.isBuffer(chunk)) {
			throw new Error("Expected a byte stream.");
		}
		let start = 0;
		for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
			const line = chunk.subarray(start, end);
			yield pending.length === 0 ? line : Buffer.concat([...pending, line]);
			pending = [];
			start = end + 1;
		}
		if (start < chunk.length) {
			pending.push(chunk.subarray(start));
		}
	}
	if (pending.length > 0) {
		yield Buffer.concat(pending);
	}
}
/** Git's heuristic: a NUL in the first 8,000 bytes marks binary content. */
export async function isBinaryFile(path: string): Promise<boolean> {
	const file = await open(path, "r");
	try {
		const { buffer, bytesRead } = await file.read(Buffer.alloc(8_000), 0, 8_000, 0);
		return buffer.subarray(0, bytesRead).includes(0);
	} finally {
		await file.close();
	}
}
/** A whole file as UTF-8 text, or undefined when `isBinaryFile` would call it binary. */
export async function readText(path: string, signal?: AbortSignal): Promise<string | undefined> {
	const bytes = await readFile(path, { signal });
	return bytes.subarray(0, 8_000).includes(0) ? undefined : bytes.toString("utf8");
}
function gitRoot(dir: string, marker: string): string {
	let target = marker;
	if (!statSync(marker).isDirectory()) {
		const gitdir = readFileSync(marker, "utf8").match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
		if (gitdir === undefined || gitdir === "") {
			return dir;
		}
		target = resolve(dir, gitdir);
	}
	target = realpathSync(target);
	const commonFile = join(target, "commondir");
	const common = realpathSync(
		existsSync(commonFile) ? resolve(target, readFileSync(commonFile, "utf8").trim()) : target,
	);
	return basename(common) === ".git" ? dirname(common) : common;
}
/** Conventional repos share the primary checkout; separate Git directories own their shared root. */
function notesRoot(cwd: string): string {
	for (let dir = cwd; ; dir = dirname(dir)) {
		const marker = join(dir, ".git");
		if (existsSync(marker)) {
			try {
				return gitRoot(dir, marker);
			} catch {
				return dir;
			} // Orphaned worktrees retain local notes.
		}
		if (dirname(dir) === dir) {
			return cwd;
		}
	}
}
function packageRelativePath(installs: string, root: string): string | undefined {
	const path = relative(installs, root);
	return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
		? path
		: undefined;
}
function projectPackageNotes(root: string, cwd: string): string | undefined {
	let moved: string | undefined;
	let checkout = root;
	for (let dir = cwd; dirname(dir) !== dir; dir = dirname(dir)) {
		// Retain the logical checkout path when a package container or source segment is linked.
		if (existsSync(join(dir, ".git")) && realpathSync(dir) === root) {
			checkout = dir;
		}
		if (basename(dir) !== "git" || basename(dirname(dir)) !== ".pi") {
			continue;
		}
		const path = packageRelativePath(dir, checkout);
		if (path !== undefined) {
			moved = join(realpathSync(dirname(dir)), "package-notes", path, "notes");
		}
	}
	// The outermost package container also protects packages installed inside another package.
	return moved;
}
/**
 * Pi's package manager installs Git sources in <agent>/git or <project>/.pi/git and runs
 * `git clean -fdx` inside their checkouts on update. Keep notes alongside, not inside, that tree.
 * ponytail: notes a package commits under `.pi/notes` return with each update and move into
 * another `from-checkout-*` folder; skip tracked files if a package ever commits its notes.
 */
function packageNotes(root: string, cwd: string): string | undefined {
	// Pi cleans only the checkouts; folders that hold several of them keep their own notes.
	if (!existsSync(join(root, ".git"))) {
		return;
	}
	const agentDir = getAgentDir();
	const installs = join(agentDir, "git");
	const path = packageRelativePath(
		existsSync(installs) ? realpathSync(installs) : installs,
		root,
	);
	return path === undefined
		? (projectPackageNotes(root, cwd) ?? projectPackageNotes(root, root))
		: join(agentDir, "notes", path);
}
/** Preserve every existing entry, including empty directories and dangling links. */
function migrationTarget(moved: string): string {
	if (lstatSync(moved, { throwIfNoEntry: false }) === undefined) {
		return moved;
	}
	const base = join(moved, `from-checkout-${Date.now()}`);
	let target = base;
	for (let suffix = 1; lstatSync(target, { throwIfNoEntry: false }) !== undefined; suffix++) {
		target = `${base}-${suffix}`;
	}
	return target;
}
/** The notes directory for `cwd`, moving any notes found inside a Pi package checkout. */
export function notesDir(cwd: string): string {
	const root = notesRoot(cwd);
	const local = join(root, ".pi", "notes");
	const moved = packageNotes(root, cwd);
	if (moved === undefined) {
		return local;
	}
	if (lstatSync(local, { throwIfNoEntry: false })?.isDirectory() === true) {
		mkdirSync(dirname(moved), { recursive: true });
		// Notes an older Posthorse wrote here after an earlier move keep a folder of their own.
		const target = migrationTarget(moved);
		try {
			renameSync(local, target);
			// Sessions still running an older Posthorse keep reaching the notes until they reload.
			symlinkSync(moved, local, "junction");
		} catch (error) {
			if (lstatSync(local, { throwIfNoEntry: false })?.isDirectory() === true) {
				throw error;
			}
			// Another session moved them first, or only the compatibility link failed.
		}
	}
	return moved;
}
