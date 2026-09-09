import { homedir } from "node:os";
import { join } from "node:path";
import { createStore } from "../store.mjs";

try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const stateDir = process.env.POSTHORSE_STATE_DIR ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "posthorse");
  await createStore(stateDir).checkpoint(JSON.parse(input));
  process.stdout.write(`${JSON.stringify({ continue: true })}\n`);
} catch (error) {
  // Codex continues after a bare nonzero hook exit. A handled failure must explicitly stop it.
  process.stdout.write(`${JSON.stringify({ continue: false, stopReason: `Posthorse could not save recovery state: ${error.message}` })}\n`);
}
