import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.mjs";

const stateDir = process.env.POSTHORSE_STATE_DIR ?? join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "posthorse");
const store = createStore(stateDir);
const server = new Server(
  { name: "codex-posthorse", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions: "Posthorse stores local task notes and original transcript history. Save current work and outstanding user requests in notes before new_context. After a context reset, read notes and recover details from history; verify live state before continuing actions. Recovery text records inputs, not proof of completed work. Use the threadId from the context-window hint.",
  },
);

const properties = {
  threadId: { type: "string", description: "Current Codex task ID from the context-window hint." },
  path: { type: "string", description: "Relative note path within this task's notes." },
  content: { type: "string" },
  query: { type: "string" },
  offset: { type: "integer", minimum: 0 },
  limit: { type: "integer", minimum: 1 },
};
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "thread_hint",
      description: "Restore Posthorse task identity, recovery text, and note pointers. Codex calls this automatically for a fresh context window.",
      inputSchema: { type: "object", properties: { threadId: properties.threadId } },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: "notes",
      description: "List, read, write, append, or search durable notes for the current task. Read pages use character offsets; list/search pages use entry offsets. Notes do not establish that actions succeeded.",
      inputSchema: {
        type: "object",
        properties: { op: { type: "string", enum: ["list", "read", "write", "append", "search"] }, ...properties },
        required: ["op", "threadId"],
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    {
      name: "history",
      description: "List, search, or read original Codex transcript records, including earlier context windows. Use returned record IDs and next offsets for full recovery. Read records can include stored images.",
      inputSchema: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["list", "search", "read"] },
          threadId: properties.threadId,
          query: properties.query,
          id: { type: "string" },
          windowId: { type: "string" },
          offset: properties.offset,
          limit: properties.limit,
        },
        required: ["op", "threadId"],
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const params = request.params.arguments ?? {};
    const threadId = request.params._meta?.threadId ?? params.threadId;
    let result;
    switch (request.params.name) {
      case "thread_hint":
        return { content: [{ type: "text", text: await store.threadHint(threadId) }] };
      case "notes":
        result = await store.notes({ ...params, threadId });
        break;
      case "history":
        result = await store.history({ ...params, threadId });
        break;
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
    const { images = [], ...text } = result;
    return { content: [{ type: "text", text: JSON.stringify(text) }, ...images] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
});

await server.connect(new StdioServerTransport());
