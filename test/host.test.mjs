// Both current hosts use the public compaction path; the fork adds early recovery and checkpoints.
import { AgentSession } from "@earendil-works/pi-coding-agent";
const fork = typeof AgentSession.prototype.acquireCheckpoint === "function";
const expected = process.env.PI_COMPAT_HOST;
if ((expected === "fork" || expected === "official") && (expected === "fork") !== fork) {
	throw new Error(`PI_COMPAT_HOST=${expected}, but the installed SDK is ${fork ? "the fork" : "official Pi"}`);
}
await import("./official.test.mjs");
await import("./native.test.mjs");
