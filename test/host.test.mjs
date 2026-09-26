// Real-SDK suite for the installed host: native context windows on the fork, compaction rollover on official Pi.
import { SessionManager } from "@earendil-works/pi-coding-agent";

const fork = typeof SessionManager.prototype.appendContextWindow === "function";
const expected = process.env.PI_COMPAT_HOST;
if ((expected === "fork" || expected === "official") && (expected === "fork") !== fork) {
	throw new Error(`PI_COMPAT_HOST=${expected}, but the installed SDK is ${fork ? "the fork" : "official Pi"}`);
}
await import(fork ? "./native.test.mjs" : "./official.test.mjs");
