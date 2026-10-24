import { constants, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

interface FixtureSession {
	readonly getSessionFile: () => string | undefined;
	readonly getHeader: () => unknown;
	readonly getEntries: () => readonly unknown[];
}

function fixtureEvidence(root: string): string | undefined {
	const evidence = process.env.PI_COMPAT_EVIDENCE_DIR;
	if (evidence === undefined || evidence === "") {
		return undefined;
	}
	const dir = join(evidence, basename(root));
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function retainFile(root: string, file: string, phase: string): void {
	const dir = fixtureEvidence(root);
	if (dir !== undefined) {
		copyFileSync(file, join(dir, `${phase}-${basename(file)}`), constants.COPYFILE_EXCL);
	}
}

export function retainSession(root: string, session: FixtureSession, phase: string): void {
	const dir = fixtureEvidence(root);
	if (dir === undefined) {
		return;
	}
	const file = session.getSessionFile();
	if (file !== undefined && existsSync(file)) {
		copyFileSync(file, join(dir, `${phase}-${basename(file)}`), constants.COPYFILE_EXCL);
		return;
	}
	writeFileSync(
		join(dir, `${phase}.native-session.snapshot.json`),
		JSON.stringify({
			kind: "native session snapshot (no on-disk journal)",
			persistence: file === undefined ? "in-memory" : "journal not yet on disk",
			sessionFile: file ?? null,
			header: session.getHeader(),
			entries: session.getEntries(),
		}) + "\n",
		{ flag: "wx" },
	);
}
