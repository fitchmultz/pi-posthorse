import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
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
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
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
/** Split on LF only; Unicode line separators are valid inside JSONL strings and notes. */
export async function* lfLines(file: string, signal?: AbortSignal): AsyncGenerator<string> {
	const stream = createReadStream(file, { encoding: "utf8", signal });
	let pending: string[] = [];
	for await (const chunk of stream) {
		if (typeof chunk !== "string") {
			throw new Error("Expected a UTF-8 text stream.");
		}
		const lines = chunk.split("\n");
		pending.push(lines[0] ?? "");
		if (lines.length > 1) {
			yield pending.join("");
			yield* lines.slice(1, -1);
			pending = [lines.at(-1) ?? ""];
		}
	}
	const last = pending.join("");
	if (last !== "") {
		yield last;
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
export function notesRoot(cwd: string): string {
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
