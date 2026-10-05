/** Real Pi transport, sessions, tools, and extension. Only the remote model is scripted. */
import { REAL_HOME, TEST_AGENT_DIR, underRealPi } from "./setup.ts";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

export function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
export interface Reply {
	text?: string;
	after?: string;
	tool?: { name: string; arguments: Record<string, unknown> };
	tools?: { name: string; arguments: Record<string, unknown> }[];
	gate?: ReturnType<typeof deferred<void>>;
	error?: number;
}
export async function provider() {
	const scripts = new Map<string, Reply[]>();
	const arrivals = new Map<string, ReturnType<typeof deferred<any>>>();
	const requests: any[] = [];
	let onUnscripted: ((request: any) => Reply) | undefined;
	const errors: string[] = [];
	const sockets = new Set<ServerResponse>();
	const server = createServer(async (req, res) => {
		sockets.add(res); res.on("close", () => sockets.delete(res));
		try {
			assert.equal(req.url, "/v1/chat/completions");
			let body = "";
			for await (const chunk of req) body += chunk;
			const request = JSON.parse(body); requests.push(request);
			const user = request.messages.findLast((m: any) => m.role === "user");
			const text = typeof user?.content === "string" ? user.content : user?.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
			const reply = scripts.get(text)?.shift() ?? onUnscripted?.(request);
			assert(reply, `Unscripted model request: ${text}`);
			arrivals.get(text)?.resolve(request);
			if (reply.error) { res.writeHead(reply.error); res.end(JSON.stringify({ error: { message: "Fixture provider failure" } })); return; }
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
			chunk({ role: "assistant", content: reply.text ?? "" });
			if (reply.gate) await Promise.race([reply.gate.promise, once(res, "close")]);
			if (res.destroyed) return;
			if (reply.after) chunk({ content: reply.after });
			const tools = reply.tools ?? (reply.tool ? [reply.tool] : []);
			if (tools.length) chunk({ tool_calls: tools.map((tool, index) => ({ index, id: `call-${requests.length}${index ? `-${index}` : ""}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } })) });
			chunk({}, tools.length ? "tool_calls" : "stop");
			res.end("data: [DONE]\n\n");
		} catch (error) { errors.push(String(error)); res.writeHead(500); res.end(String(error)); }
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const address = server.address(); assert(address && typeof address !== "string");
	return {
		url: `http://127.0.0.1:${address.port}/v1`, requests, errors,
		onUnscripted(handler?: (request: any) => Reply) { onUnscripted = handler; },
		script(text: string, ...replies: Reply[]) { scripts.set(text, replies); const arrival = deferred<any>(); arrivals.set(text, arrival); return arrival.promise; },
		async close() { for (const res of sockets) res.destroy(); server.close(); await once(server, "close"); },
	};
}
/**
 * A fresh project, home and agent configuration for one test. src/index.ts resolves its agent
 * directory once per process, and its children read settings from there, so every sandbox in this
 * process uses that one directory (the preload's), emptied and rewritten here. A sandbox for another
 * process (`ownAgentDir`, which that process passes to harness) keeps its own under its root.
 */
export function sandbox(url: string, root = mkdtempSync(join(tmpdir(), "pi-delegate-qc-")), options: { retry?: Record<string, unknown>; ownAgentDir?: boolean } = {}) {
	const cwd = join(root, "project"), agentDir = options.ownAgentDir ? join(root, "agent") : TEST_AGENT_DIR;
	if (!options.ownAgentDir) rmSync(agentDir, { recursive: true, force: true });
	mkdirSync(cwd, { recursive: true }); mkdirSync(agentDir, { recursive: true });
	// Pi 0.99 sends strict tool schemas only to endpoints that advertise support; the loopback accepts them, as real strict-capable providers do.
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { api: "openai-completions", baseUrl: url, apiKey: "loopback-only", models: [{ id: "fixture", name: "Deterministic fixture", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096, compat: { supportsStrictMode: true }, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture", defaultThinkingLevel: "off", retry: options.retry ?? { enabled: false }, compaction: { enabled: false }, defaultProjectTrust: "full", quietStartup: true, hideThinkingBlock: true }));
	return { root, cwd, agentDir, env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", DO_NOT_TRACK: "1" } };
}
export type Sandbox = ReturnType<typeof sandbox>;

/**
 * Fails the test, and then the whole test process: the test that called harness has a provider
 * listening that it never reaches its cleanup to close, which would keep the process alive forever.
 */
function refuse(message: string): never {
	console.error(`${message} Refusing to run.`);
	setTimeout(() => process.exit(1), 2000).unref();
	throw new Error(`${message} Refusing to run.`);
}

/** A dialog-capable UI for the parent, as Pi's TUI and RPC modes bind one. Only what a test passes does anything. */
function uiContext(ui: { select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined> }) {
	const nothing = () => undefined;
	return {
		select: ui.select ?? (async () => undefined), confirm: async () => false, input: async () => undefined, editor: async () => undefined, custom: async () => undefined,
		notify: nothing, onTerminalInput: () => nothing, setStatus: nothing, setWorkingMessage: nothing, setWorkingVisible: nothing, setWorkingIndicator: nothing,
		setHiddenThinkingLabel: nothing, setWidget: nothing, setFooter: nothing, setHeader: nothing, setTitle: nothing, pasteToEditor: nothing, setEditorText: nothing,
		getEditorText: () => "", addAutocompleteProvider: nothing, setEditorComponent: nothing, getEditorComponent: nothing, theme: undefined,
		getAllThemes: () => [], getTheme: nothing, setTheme: () => ({ success: false, error: "UI not available" }), getToolsExpanded: () => false, setToolsExpanded: nothing,
	};
}

export async function harness(box: Sandbox, parent?: string, hooks: { beforeNotice?: (message: any) => void; register?: (pi: any) => void; tools?: string[]; projectTrusted?: boolean; extensions?: boolean; mcp?: boolean; ui?: { select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined> } } = {}) {
	// Import after isolation: Pi and the extension resolve configuration paths on first load.
	process.env.HOME = box.root;
	process.env.PI_CODING_AGENT_DIR = box.agentDir;
	process.env.PI_OFFLINE = "1";
	process.env.DO_NOT_TRACK = "1";
	process.env.PI_TELEMETRY = "0";
	const sdk = await import("@earendil-works/pi-coding-agent");
	const { default: extension, AGENT_DIR } = await import("../src/index.ts");
	// Before anything launches: src/index.ts resolved its agent directory once, when first loaded. A
	// test file that loaded it before test/setup.ts would point it at the real home.
	if (homedir() === REAL_HOME || underRealPi(AGENT_DIR)) refuse(`harness: pi-delegate's agent directory ${AGENT_DIR} is the real home's ~/.pi; import "./setup.ts" first in the test file. Refusing to run.`);
	if (AGENT_DIR !== box.agentDir) refuse(`harness: pi-delegate's agent directory is ${AGENT_DIR}, not this sandbox's ${box.agentDir}; its children would read another sandbox's settings.`);
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	let ctx: any;
	let extensionApi: any;
	const notices: any[] = [], errors: any[] = [];
	const notice = deferred<any>();
	const factory = (pi: any) => {
		extensionApi = pi;
		extension(new Proxy(pi, { get(target, key) {
			if (key === "registerTool") return (tool: any) => { tools.set(tool.name, tool); target.registerTool(tool); };
			if (key === "registerCommand") return (name: string, options: any) => { commands.set(name, options); target.registerCommand(name, options); };
			if (key === "sendMessage") return (message: any, options: any) => { hooks.beforeNotice?.(message); notices.push(message); notice.resolve(message); return target.sendMessage(message, options); };
			return target[key];
		} }));
		pi.on("session_start", (_event: any, context: any) => { ctx = context; });
		hooks.register?.(pi);
	};
	let manager = parent ? sdk.SessionManager.open(parent) : sdk.SessionManager.create(box.cwd, join(box.root, "parents"));
	if (!parent) {
		mkdirSync(join(box.root, "parents"), { recursive: true });
		writeFileSync(manager.getSessionFile()!, JSON.stringify(manager.getHeader()) + "\n");
		manager = sdk.SessionManager.open(manager.getSessionFile()!);
	}
	const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(box.agentDir, "auth.json"), modelsPath: join(box.agentDir, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
	const model = modelRuntime.getModel("fixture", "fixture"); assert(model);
	const runtime = await sdk.createAgentSessionRuntime(async (options) => {
		// The parent's own trust decision, as Pi's startup makes it; children inherit it for its cwd.
		const settingsManager = hooks.projectTrusted === undefined ? undefined : sdk.SettingsManager.create(options.cwd, box.agentDir, { projectTrusted: hooks.projectTrusted });
		const services = await sdk.createAgentSessionServices({ cwd: options.cwd, agentDir: box.agentDir, modelRuntime, ...(settingsManager ? { settingsManager } : {}), resourceLoaderOptions: {
			// `extensions`: the parent also loads the extensions Pi finds in the sandbox's agent directory, as a child does.
			noExtensions: !hooks.extensions, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			systemPrompt: "Deterministic verification parent.", extensionFactories: [factory, ...(hooks.mcp ? [sdk.createMcpExtension()] : [])],
		} });
		const result = await sdk.createAgentSessionFromServices({ services, sessionManager: options.sessionManager, sessionStartEvent: options.sessionStartEvent, model, thinkingLevel: "off", tools: hooks.tools ?? ["delegate", "delegate_ctl"] });
		return { ...result, services, diagnostics: services.diagnostics };
	}, { cwd: box.cwd, agentDir: box.agentDir, sessionManager: manager });
	await runtime.session.bindExtensions({ onError: (error) => errors.push(error), ...(hooks.ui ? { uiContext: uiContext(hooks.ui) as any, mode: "rpc" as const } : {}) });
	const raw = async (name: string, args: any, signal?: AbortSignal) => {
		// A tool's context, as Pi's agent loop passes it: the extension context plus the session's live `tools`.
		const toolCtx = hooks.mcp ? runtime.session.extensionRunner?.createToolContext?.("fixture", signal) ?? ctx : ctx;
		const result = await tools.get(name).execute("fixture", args, signal, undefined, toolCtx);
		// Direct test calls bypass the parent's agent loop. Seed its durable receipt at
		// the return boundary; async sendMessage delivery itself remains unmodified.
		if (result.details?.completionReceipt) runtime.session.sessionManager.appendCustomMessageEntry("delegate", result.content[0].text, true, result.details);
		return result;
	};
	const ctl = (action: string, runId?: string, extra: any = {}, signal?: AbortSignal) => raw("delegate_ctl", { action, runId, ...extra }, signal);
	const launch = (task: string, extra: any = {}, signal?: AbortSignal) => raw("delegate", { role: "scout", context: "fresh", task, cwd: box.cwd, model: "fixture/fixture:off", ...extra }, signal);
	const waitReady = async (id: string) => {
		for (;;) {
			const current = await ctl("status", id);
			if (current.details?.backend !== "acp" || current.details.turns?.length || current.details.status !== "running") return current;
			await new Promise((resolve) => setImmediate(resolve));
		}
	};
	const launchReady = async (task: string, extra: any = {}) => {
		const started = await launch(task, extra);
		if (!started.details?.backend || !started.details.id) return started;
		const ready = await waitReady(started.details.id);
		if (ready.details.status === "error" && typeof ready.details.error === "string") {
			const separator = ready.details.error.indexOf(":");
			const code = separator < 0 ? ready.details.error : ready.details.error.slice(0, separator);
			const message = separator < 0 ? ready.details.error : ready.details.error.slice(separator + 1).trim();
			return { ...started, isError: true, content: [{ type: "text", text: `${code}: ${message}` }], details: { ...ready.details, error: { code, message } } };
		}
		return { ...started, details: ready.details };
	};
	const waitLaunch = async (task: string, extra: any = {}) => {
		const started = await launch(task, extra);
		return started.details?.id ? ctl("wait", started.details.id) : started;
	};
	return { sdk, runtime, errors, notices, notice, commands, parent: manager.getSessionFile()!, ctl, ctx: () => ctx, sendMessage: (message: any, options: any) => extensionApi.sendMessage(message, options), launch, launchReady, waitReady, waitLaunch,
		state: () => (globalThis as any)[Symbol.for("@ssweens/pi-delegate/runtime/1")],
	};
}
