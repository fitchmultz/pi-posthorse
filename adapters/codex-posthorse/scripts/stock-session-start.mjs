import { createStore } from "../store.mjs";

try {
	let raw = "";
	for await (const chunk of process.stdin) raw += chunk;
	const input = JSON.parse(raw);
	const hint = await createStore(process.env.POSTHORSE_STATE_DIR).stockHint(input);
	const additionalContext = `Posthorse recovery from SessionStart source=${input.source}. This supplements ordinary compaction; it does not replace the summary.\n\n${hint}`;
	if (Buffer.byteLength(additionalContext) > 32_000) throw new Error("Recovery hint exceeds 32,000 bytes.");
	process.stdout.write(`${JSON.stringify({
		continue: true, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
	})}\n`);
} catch (error) {
	process.stdout.write(`${JSON.stringify({ continue: false, stopReason: `Posthorse recovery hook failed: ${error.message}` })}\n`);
}
