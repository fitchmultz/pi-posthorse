import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../", import.meta.url));

async function fixture(t) {
  const cache = join(homedir(), "Library", "Caches", "pi-runs");
  await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(join(cache, "posthorse-codex-mcp-"));
  t.diagnostic(`Retained artifacts: ${dir}`);
  const sessionId = randomUUID();
  const transcript = join(dir, "rollout.jsonl");
  const records = [
    { ordinal: 0, type: "session_meta", payload: { id: sessionId, cwd: dir } },
    { ordinal: 1, type: "turn_context", payload: { turn_id: "turn-1", model: "fixture-model" } },
    { ordinal: 2, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Keep unique-input in the recovery record." }] } },
  ];
  await writeFile(transcript, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return { dir, sessionId, transcript, stateDir: join(dir, "state") };
}

async function hook(script, data, stateDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "scripts", script)], {
      env: { ...process.env, POSTHORSE_STATE_DIR: stateDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(data));
  });
}

test("real MCP server shares task notes, original history, and hook recovery across processes", async (t) => {
  const f = await fixture(t);
  const input = { session_id: f.sessionId, transcript_path: f.transcript, turn_id: "turn-1", trigger: "auto" };
  const registered = await hook("session-start.mjs", { ...input, hook_event_name: "SessionStart" }, f.stateDir);
  assert.equal(registered.code, 0, registered.stderr);
  assert.equal(JSON.parse(registered.stdout).continue, true);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "server.mjs")],
    env: { ...process.env, POSTHORSE_STATE_DIR: f.stateDir },
    stderr: "pipe",
  });
  const client = new Client({ name: "posthorse-integration-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ["history", "notes", "thread_hint"]);

  const written = await client.callTool({ name: "notes", arguments: { op: "write", threadId: f.sessionId, path: "checkpoint.md", content: "Continue the pending verification." } });
  assert.notEqual(written.isError, true, JSON.stringify(written));
  const read = await client.callTool({ name: "notes", arguments: { op: "read", threadId: f.sessionId, path: "checkpoint.md" } });
  assert.match(JSON.stringify(read), /Continue the pending verification/);
  const history = await client.callTool({ name: "history", arguments: { op: "search", threadId: f.sessionId, query: "unique-input" } });
  assert.notEqual(history.isError, true, JSON.stringify(history));
  assert.match(JSON.stringify(history), /unique-input/);

  const checkpointed = await hook("precompact.mjs", { ...input, hook_event_name: "PreCompact" }, f.stateDir);
  assert.equal(checkpointed.code, 0, checkpointed.stderr);
  assert.equal(JSON.parse(checkpointed.stdout).continue, true);
  const hint = await client.callTool({ name: "thread_hint", arguments: {}, _meta: { threadId: f.sessionId } });
  assert.notEqual(hint.isError, true, JSON.stringify(hint));
  assert.match(JSON.stringify(hint), /unique-input/);
  assert.match(JSON.stringify(hint), /notes list\/read/);
  const recovered = await client.callTool({ name: "notes", arguments: { op: "read", threadId: f.sessionId, path: "checkpoint.md" } });
  assert.match(JSON.stringify(recovered), /Continue the pending verification/);
});

test("checkpoint storage failure emits Codex's explicit stop response", async (t) => {
  const f = await fixture(t);
  await writeFile(f.stateDir, "not a directory");
  const result = await hook("precompact.mjs", { session_id: f.sessionId, transcript_path: f.transcript, turn_id: "turn-1", trigger: "auto" }, f.stateDir);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.continue, false);
  assert.match(output.stopReason, /could not save recovery state/);
});
