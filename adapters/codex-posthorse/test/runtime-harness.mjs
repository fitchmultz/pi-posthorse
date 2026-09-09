import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, writeFile, appendFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const adapter = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = 30_000;
const quote = (value) => JSON.stringify(value);
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export const message = (text) => ({
	type: "message", role: "assistant", content: [{ type: "output_text", text }],
});

export const call = (name, args, callId = name, namespace) => ({
	type: "function_call", name, call_id: callId, arguments: JSON.stringify(args), ...(namespace ? { namespace } : {}),
});

export const discoverNotes = () => ({
	type: "tool_search_call", call_id: "discover-notes", execution: "client",
	arguments: { query: "notes thread notes history", limit: 3 },
});

export const requestText = (request) => JSON.stringify(request.body.input);

export function contextWindow(request) {
	return requestText(request).match(/Current context window id: ([0-9a-f-]+)/)?.[1];
}

export class RuntimeHarness {
	static async create(name, { tokenBudget = true, failCheckpoint = false } = {}) {
		const cache = join(homedir(), "Library", "Caches", "pi-runs");
		await mkdir(cache, { recursive: true });
		const root = await mkdtemp(join(cache, `posthorse-codex-${name}-`));
		const harness = new RuntimeHarness(root);
		harness.tokenBudget = tokenBudget;
		harness.failCheckpoint = failCheckpoint;
		try {
			await harness.initialize();
			return harness;
		} catch (error) {
			await harness.close();
			throw error;
		}
	}

	constructor(root) {
		this.root = root;
		this.home = join(root, "codex-home");
		this.cwd = join(root, "workspace");
		this.state = join(root, "posthorse");
		this.requests = [];
		this.events = [];
		this.replies = [];
		this.pending = new Map();
		this.waiters = new Set();
		this.sequence = 0;
		this.launches = 0;
		this.logWrites = Promise.resolve();
	}

	async initialize() {
		await Promise.all([mkdir(this.home), mkdir(this.cwd)]);
		this.server = createServer(async (req, res) => {
			try {
				const chunks = [];
				for await (const chunk of req) chunks.push(chunk);
				const raw = Buffer.concat(chunks).toString();
				const request = { path: req.url, body: raw ? JSON.parse(raw) : null };
				this.requests.push(request);
				await appendFile(join(this.root, "model-requests.jsonl"), `${JSON.stringify(request)}\n`);
				if (this.failCheckpoint && this.requests.length === 1) {
					await rename(this.state, `${this.state}-before-failure`);
					await writeFile(this.state, "Deliberately blocks checkpoint-directory creation after SessionStart.\n");
				}
				if (req.url !== "/v1/responses") throw new Error(`Unexpected model endpoint: ${req.url}`);
				const reply = this.replies.shift();
				if (!reply) throw new Error("Unexpected model request: no controlled reply remains");
				const id = `fixture-response-${this.requests.length}`;
				const events = [
					{ type: "response.created", response: { id } },
					...(reply.items ?? [message("fixture complete")]).map((item, index) => ({
						type: "response.output_item.done", item: { id: `${id}-item-${index}`, ...item },
					})),
					{ type: "response.completed", response: { id, usage: {
						input_tokens: reply.tokens ?? 100, input_tokens_details: null,
						output_tokens: 0, output_tokens_details: null, total_tokens: reply.tokens ?? 100,
					} } },
				];
				res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
				for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
				res.end();
			} catch (error) {
				this.providerError = error;
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { message: error.message, type: "fixture_error" } }));
			}
		});
		this.server.listen(0, "127.0.0.1");
		await once(this.server, "listening");
		const hookCommand = `${shellQuote(process.execPath)} ${shellQuote(join(adapter, "scripts", "precompact.mjs"))}`;
		const sessionCommand = `${shellQuote(process.execPath)} ${shellQuote(join(adapter, "scripts", "session-start.mjs"))}`;
		this.config = [
			'model = "gpt-6-astra"', 'model_provider = "posthorse_fixture"',
			'model_context_window = 50000', 'model_auto_compact_token_limit = 9000',
			'approval_policy = "never"', 'sandbox_mode = "danger-full-access"',
			'web_search = "disabled"',
			'[features]', 'context_management = false', 'apps = false', 'remote_plugin = false',
			'memories = false', 'multi_agent = false', 'shell_snapshot = false', 'hooks = true',
			'code_mode_host = false',
			'[features.token_budget]', `enabled = ${this.tokenBudget}`, 'use_history_notes_extension = false',
			'guidance_message = "Use the local notes and history tools to recover durable Posthorse state."',
			'[model_providers.posthorse_fixture]', 'name = "Posthorse local test"',
			`base_url = "http://127.0.0.1:${this.server.address().port}/v1"`,
			'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false',
			'request_max_retries = 0', 'stream_max_retries = 0',
			'[mcp_servers.notes]', `command = ${quote(process.execPath)}`,
			`args = [${quote(join(adapter, "server.mjs"))}]`,
			'[mcp_servers.notes.env]', `POSTHORSE_STATE_DIR = ${quote(this.state)}`,
			'[[hooks.PreCompact]]',
			'[[hooks.PreCompact.hooks]]', 'type = "command"', `command = ${quote(hookCommand)}`,
			'[[hooks.SessionStart]]',
			'[[hooks.SessionStart.hooks]]', 'type = "command"', `command = ${quote(sessionCommand)}`,
			`[projects.${quote(this.cwd)}]`, 'trust_level = "trusted"',
		].join("\n") + "\n";
		await writeFile(join(this.home, "config.toml"), this.config);
		await this.start();
		const listed = await this.rpc("hooks/list", { cwds: [this.cwd] });
		await writeFile(join(this.root, "hooks-list.json"), JSON.stringify(listed, null, 2));
		const hooks = listed.data.flatMap((entry) => entry.hooks ?? []);
		if (!hooks.length) throw new Error(`No hooks discovered: ${JSON.stringify(listed)}`);
		await this.stop();
		for (const hook of hooks) this.config += `\n[hooks.state.${quote(hook.key)}]\ntrusted_hash = ${quote(hook.currentHash)}\n`;
		await writeFile(join(this.home, "config.toml"), this.config);
		await this.start();
	}

	async start() {
		this.launches++;
		this.child = spawn(process.env.POSTHORSE_CODEX_BIN ?? "codex", ["app-server", "--stdio", "--strict-config"], {
			cwd: this.cwd,
			env: {
				PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR,
				CODEX_HOME: this.home, POSTHORSE_STATE_DIR: this.state, NO_COLOR: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.stderr.on("data", (chunk) => {
			this.logWrites = this.logWrites.then(() => appendFile(join(this.root, `runtime-${this.launches}.stderr.log`), chunk));
		});
		this.child.on("error", (error) => this.rejectPending(error));
		this.child.on("exit", (code, signal) => this.rejectPending(new Error(`Codex exited (${code ?? signal}); artifacts: ${this.root}`)));
		this.lines = createInterface({ input: this.child.stdout });
		this.lines.on("line", (line) => {
			this.logWrites = this.logWrites.then(() => appendFile(join(this.root, "app-server.jsonl"), `${line}\n`));
			let event;
			try { event = JSON.parse(line); }
			catch {
				this.protocolError = new Error(`Codex emitted invalid JSON; artifacts: ${this.root}`);
				this.rejectPending(this.protocolError);
				return;
			}
			if (event.id !== undefined && !event.method) {
				const pending = this.pending.get(event.id);
				if (pending) {
					this.pending.delete(event.id);
					clearTimeout(pending.timer);
					if (event.error) pending.reject(new Error(JSON.stringify(event.error)));
					else pending.resolve(event.result);
				}
			} else {
				this.events.push(event);
				for (const waiter of [...this.waiters]) if (waiter.predicate(event)) {
					clearTimeout(waiter.timer);
					this.waiters.delete(waiter);
					waiter.resolve(event);
				}
			}
		});
		await this.rpc("initialize", { clientInfo: { name: "posthorse-runtime-test", version: "0.1.0" }, capabilities: { experimentalApi: true } });
		this.child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
	}

	rejectPending(error) {
		for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
		this.pending.clear();
		for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
		this.waiters.clear();
	}

	rpc(method, params) {
		if (this.protocolError) return Promise.reject(this.protocolError);
		const id = ++this.sequence;
		return new Promise((resolveResult, reject) => {
			const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out: ${method}; artifacts: ${this.root}`)); }, timeoutMs);
			this.pending.set(id, { resolve: resolveResult, reject, timer });
			this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	}

	waitFor(predicate, from = 0) {
		if (this.protocolError) return Promise.reject(this.protocolError);
		const found = this.events.slice(from).find(predicate);
		if (found) return Promise.resolve(found);
		return new Promise((resolveResult, reject) => {
			const waiter = { predicate, resolve: resolveResult, reject };
			waiter.timer = setTimeout(() => { this.waiters.delete(waiter); reject(new Error(`Timed out waiting for runtime event; artifacts: ${this.root}`)); }, timeoutMs);
			this.waiters.add(waiter);
		});
	}

	async thread() {
		const result = await this.rpc("thread/start", {
			cwd: this.cwd, model: "gpt-6-astra", modelProvider: "posthorse_fixture",
			approvalPolicy: "never", sandbox: "danger-full-access",
			baseInstructions: "You are a controlled local integration fixture. Follow the exact tool sequence supplied by the fixture provider.",
		});
		this.threadId = result.thread.id;
		this.transcript = result.thread.path;
		return result;
	}

	async turn(text, replies) {
		this.replies.push(...replies);
		const from = this.events.length;
		const result = await this.rpc("turn/start", { threadId: this.threadId, input: [{ type: "text", text }] });
		const completed = await this.waitFor((event) => event.method === "turn/completed" && event.params.turn.id === result.turn.id, from);
		if (this.providerError) throw this.providerError;
		return completed.params.turn;
	}

	async compact(replies = []) {
		this.replies.push(...replies);
		const from = this.events.length;
		await this.rpc("thread/compact/start", { threadId: this.threadId });
		await this.waitFor((event) => event.method === "turn/completed", from);
		if (this.providerError) throw this.providerError;
	}

	async restart() {
		await this.stop();
		await this.start();
		await this.rpc("thread/resume", { threadId: this.threadId, cwd: this.cwd });
	}

	async transcriptItems() {
		const thread = await this.rpc("thread/read", { threadId: this.threadId, includeTurns: false });
		this.transcript = thread.thread.path;
		return (await readFile(this.transcript, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
	}

	async stop() {
		if (!this.child?.pid || this.child.exitCode !== null) return;
		const child = this.child;
		const stopped = once(child, "exit");
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGTERM"), 1500);
		await stopped;
		clearTimeout(timer);
		this.lines?.close();
		await this.logWrites;
	}

	async close() {
		await this.stop();
		if (this.server?.listening) await new Promise((resolveClosed) => this.server.close(resolveClosed));
		await this.logWrites;
	}
}
