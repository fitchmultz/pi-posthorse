import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const args: readonly (string | undefined)[] = process.argv.slice(2);
const [candidatePath, qualificationPath, flavor] = args;
assert.ok(
	candidatePath !== undefined &&
		qualificationPath !== undefined &&
		(flavor === "official" || flavor === "fork"),
);
const candidate: unknown = JSON.parse(readFileSync(candidatePath, "utf8"));
const qualification: unknown = JSON.parse(readFileSync(qualificationPath, "utf8"));
function object(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function equal(actual: unknown, expected: unknown, message: string): void {
	if (actual !== expected) {
		throw new Error(message);
	}
}
assert.ok(object(candidate) && object(qualification));
assert.ok(object(candidate.hosts) && object(candidate.hosts[flavor]));
assert.ok(object(qualification.package) && object(qualification.host));

equal(qualification.result, "passed", "Host qualification did not pass");
equal(qualification.source, candidate.source, "Host qualification used a different source");
equal(qualification.sourceDirty, false, "Host qualification used a dirty source");
equal(qualification.flavor, flavor, "Host qualification used a different flavor");
for (const key of ["name", "version", "sha256"]) {
	equal(qualification.package[key], candidate[key], `Qualified package differs: ${key}`);
}
for (const key of [
	"version",
	"indexSha256",
	"cliSha256",
	"runtimeLockSha256",
	"runtimeGraphSha256",
]) {
	equal(qualification.host[key], candidate.hosts[flavor][key], `Qualified host differs: ${key}`);
}
console.log(`${flavor} qualification matches the retained candidate`);
