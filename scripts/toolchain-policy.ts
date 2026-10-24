import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "../src/contracts.ts";

function manifest(file: string): Readonly<Record<string, unknown>> {
	const value: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (!isRecord(value)) {
		throw new Error(`${file}: expected a package manifest`);
	}
	return value;
}
function npmIdentity(): string {
	const cli = process.env.npm_execpath;
	if (cli === undefined || cli === "") {
		throw new Error(
			"Toolchain policy: npm provenance is missing; invoke acceptance with npm run verify.",
		);
	}
	const file = findPackageJSON(pathToFileURL(cli));
	if (file === undefined) {
		throw new Error(`Toolchain policy: cannot resolve the invoking npm package from ${cli}.`);
	}
	const actual = manifest(file);
	if (actual.name !== "npm" || typeof actual.version !== "string") {
		throw new Error(`Toolchain policy: ${file} is not an identifiable npm installation.`);
	}
	return `npm@${actual.version}`;
}
function verifyToolchain(root: string): void {
	const expected = manifest(resolve(root, "package.json")).packageManager;
	if (typeof expected !== "string") {
		throw new Error(
			"Toolchain policy: package.json packageManager must declare the repository's npm version.",
		);
	}
	const actual = npmIdentity();
	if (expected !== actual) {
		throw new Error(
			`Toolchain policy: package.json packageManager requires ${expected}, but the invoking CLI is ${actual}. Select the declared npm before npm run verify; do not change global npm for this check.`,
		);
	}
	if (process.versions.node.split(".")[0] !== "24") {
		throw new Error(
			`Toolchain policy: repository verification requires Node 24, got ${process.versions.node}. Runtime support in package.json engines is unchanged.`,
		);
	}
	console.log(
		`Toolchain policy: Node ${process.versions.node}, ${actual}; declared verification tools selected.`,
	);
}

if (import.meta.main) {
	verifyToolchain(resolve(process.argv[2] ?? "."));
}
