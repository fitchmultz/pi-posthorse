import assert from "node:assert/strict";
import { objectValue, readObject } from "./quality-settings.ts";

const [candidatePath, qualificationPath, flavor] = process.argv.slice(2);
assert.ok(
	candidatePath !== undefined &&
		qualificationPath !== undefined &&
		(flavor === "official" || flavor === "fork"),
);
const candidate = readObject(candidatePath);
const qualification = readObject(qualificationPath);
assert.ok(objectValue(candidate.hosts) && objectValue(candidate.hosts[flavor]));
assert.ok(objectValue(qualification.package) && objectValue(qualification.host));

assert.equal(qualification.result, "passed", "Host qualification did not pass");
assert.equal(qualification.source, candidate.source, "Host qualification used a different source");
assert.equal(qualification.sourceDirty, false, "Host qualification used a dirty source");
assert.equal(qualification.flavor, flavor, "Host qualification used a different flavor");
for (const key of ["name", "version", "sha256"]) {
	assert.equal(qualification.package[key], candidate[key], `Qualified package differs: ${key}`);
}
for (const key of [
	"version",
	"indexSha256",
	"cliSha256",
	"runtimeLockSha256",
	"runtimeGraphSha256",
]) {
	assert.equal(
		qualification.host[key],
		candidate.hosts[flavor][key],
		`Qualified host differs: ${key}`,
	);
}
console.log(`${flavor} qualification matches the retained candidate`);
