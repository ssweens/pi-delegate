/**
 * An ACP run's own model IDs in delegate_ctl status/result for one run: one bounded Coordinator
 * status per call, never on render or in the list. Through the real extension and Pi SDK parent;
 * the ACP runtime is an in-process fake whose model discovery depends on the agent name.
 */
import assert from "node:assert/strict";
import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { NativeSessionDescription, NormalizedEvent, RuntimePort, RuntimeStatus, RuntimeTerminal } from "../src/acp/domain/types.ts";
import { configureAcpCoordinator } from "../src/acp/instance.ts";
import { acpRowView, resultLines, runLine } from "../src/render.ts";
import { provider, sandbox, harness } from "./fixture.ts";

const CODEX_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
const CLAUDE_FALLBACK_MODELS = ["default", "best", "fable", "opus", "opus[1m]", "sonnet", "sonnet[1m]", "haiku", "opusplan"];
const NATIVE_OPTIONS = CODEX_MODELS.map((id) => ({ id, name: id === "gpt-5.5" ? "GPT-5.5" : id, description: `native ${id}` }));
const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text, bg: (_color: string, text: string) => text };

/** codex: native discovery on gpt-5.5. claude: fallback catalog. slow: answers after the bound. Opened sessions report their current model. */
function modelRuntime(native: NativeSessionDescription) {
	const calls = { status: [] as string[] };
	const port = (agent: string, opened: boolean): RuntimePort => {
		let current: string | undefined = agent === "claude" ? undefined : "gpt-5.5";
		return {
			async ensureSession(input) { return { sessionKey: `fake:${input.name}`, backend: "fake", runtimeSessionName: input.name, backendSessionId: `sess-${input.name}` }; },
			async describeNativeSession() { return { ...native }; },
			async openSession(input) { return { sessionKey: `native:${input.name}`, backend: "fake", runtimeSessionName: input.name, backendSessionId: `adapter-${input.name}`, agentSessionId: input.native.id }; },
			async disconnect() {},
			startTurn: (input) => {
				let finish!: (terminal: RuntimeTerminal) => void;
				const result = new Promise<RuntimeTerminal>((resolve) => { finish = resolve; });
				setImmediate(() => finish({ status: "completed", stopReason: "end_turn" }));
				async function* events(): AsyncGenerator<NormalizedEvent> { yield { type: "text", text: "ACK", stream: "output" }; await result; }
				return { requestId: input.requestId, result, events: events(), async cancel() {}, async closeStream() {} };
			},
			async getStatus(): Promise<RuntimeStatus> {
				calls.status.push(agent);
				if (opened) return { modelDiscoverySupported: false, currentModelId: "high", availableModelIds: [] };
				if (agent === "claude") return { modelDiscoverySupported: false, ...(current ? { currentModelId: current } : {}), availableModelIds: [] };
				if (agent === "native") return { modelDiscoverySupported: true, currentModelId: current, availableModelIds: CODEX_MODELS, modelSource: "native", modelOptions: NATIVE_OPTIONS };
				if (agent === "slow") await new Promise((resolve) => setTimeout(resolve, 4_000));
				return { modelDiscoverySupported: true, currentModelId: current, availableModelIds: CODEX_MODELS };
			},
			async setConfigOption(input) { current = input.value; },
			async close() {},
		};
	};
	return { calls, factory: (_cwd: string, _stateDir: string, profile: { agent: string }, origin?: string) => port(profile.agent, origin === "opened") };
}

test("ACP model IDs: status/result for one run read them, bounded; nothing else does", { timeout: 60000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	const cwd = realpathSync(box.cwd);
	const native = { id: "T-models", scope: "fake://account", cwd, executionEnvironment: "local", attachment: "stored-session", disconnectEffect: "stops-local-executor", concurrentNativeClients: "unsupported", activity: "unknown" } as NativeSessionDescription;
	const fake = modelRuntime(native);
	const saved = process.env.AMP_CLI_PATH;
	process.env.AMP_CLI_PATH = join(box.root, "no-amp-here");
	configureAcpCoordinator({ stateDir: join(box.root, "acp-state"), profiles: {}, runtimeFactory: fake.factory as never });
	api.onUnscripted(() => ({ text: "ACK" }));
	const h = await harness(box);
	const delegate = (args: Record<string, unknown>) => h.launch("", { role: undefined, context: undefined, model: undefined, cwd: undefined, task: undefined, ...args });
	try {
		await t.test("a created run shows its current and available model IDs, and steer switches", async () => {
			const reads = fake.calls.status.length;
			const id = (await delegate({ backend: "acp", agent: "codex", task: "hello", cwd })).details.id;
			await h.ctl("wait", id);
			await h.ctl("status");
			assert.equal(fake.calls.status.length, reads, "launch, wait and the run list read no models");
			const status = await h.ctl("status", id);
			assert.match(status.content[0].text, /\nmodels: current gpt-5\.5; available gpt-5\.5, gpt-5\.4, gpt-5\.4-mini(\n|$)/);
			assert.deepEqual(status.details.models, { current: "gpt-5.5", available: CODEX_MODELS });
			assert.equal(fake.calls.status.length, reads + 1, "one read per status call");
			// Rendering the result is not a read.
			const row = acpRowView(status.details);
			runLine(row, theme, 120);
			resultLines(row, true, theme, 120);
			assert.equal(fake.calls.status.length, reads + 1, "rendering reads no models");
			await h.ctl("steer", id, { message: "again", model: "gpt-5.4" });
			await h.ctl("wait", id);
			const result = await h.ctl("result", id);
			assert.match(result.content[0].text, /\nmodels: current gpt-5\.4; available /);
			await h.ctl("close", id);
			const closed = await h.ctl("status", id);
			assert.doesNotMatch(closed.content[0].text, /models:/, "a closed run has no session to ask");
		});

		await t.test("native metadata keeps labels and descriptions in the ACP catalog", async () => {
			const id = (await delegate({ backend: "acp", agent: "native", task: "hello", cwd })).details.id;
			await h.ctl("wait", id);
			const catalog = await h.ctl("models", id);
			assert.equal(catalog.details.source, "native");
			assert.match(catalog.content[0].text, /gpt-5\.5  GPT-5\.5 — native gpt-5\.5/);
			await h.ctl("close", id);
		});

		await t.test("an adapter without model discovery uses the maintained fallback catalog", async () => {
			const id = (await delegate({ backend: "acp", agent: "claude", task: "hello", cwd })).details.id;
			await h.ctl("wait", id);
			const status = await h.ctl("status", id);
			assert.notEqual(status.isError, true, status.content[0].text);
			assert.match(status.content[0].text, /\nmodels: current unknown; available default \(Default\)/);
			assert.match(status.content[0].text, /source fallback/);
			assert.deepEqual(status.details.models.available, CLAUDE_FALLBACK_MODELS);
			assert.equal(status.details.models.source, "fallback");
			assert.equal(status.details.models.options[2].id, "fable");
			const catalog = await h.ctl("models", id);
			assert.equal(catalog.details.kind, "acp-models");
			assert.match(catalog.content[0].text, /fable  Fable — Claude's long-running reasoning alias/);
			await h.ctl("steer", id, { message: "switch", model: "opus" });
			await h.ctl("wait", id);
			const switched = await h.ctl("status", id);
			assert.match(switched.content[0].text, /models: current opus;/);
			await h.ctl("close", id);
		});

		await t.test("a slow adapter makes the models unknown within the bound, not the status late", async () => {
			const id = (await delegate({ backend: "acp", agent: "slow", task: "hello", cwd })).details.id;
			await h.ctl("wait", id);
			const started = Date.now();
			const status = await h.ctl("status", id);
			assert.ok(Date.now() - started < 3_900, `status took ${Date.now() - started}ms`);
			assert.notEqual(status.isError, true, status.content[0].text);
			assert.match(status.content[0].text, /\nmodels: unknown(\n|$)/);
			assert.match(status.details.models.error, /did not answer within 3s/);
			await h.ctl("close", id);
		});

		await t.test("an opened session shows only its current model and refuses a switch", async () => {
			const id = (await delegate({ backend: "acp", agent: "amp", sessionId: "T-models" })).details.id;
			const status = await h.ctl("status", id);
			assert.match(status.content[0].text, /\nmodels: current high(\n|$)/);
			assert.doesNotMatch(status.content[0].text, /available/);
			assert.deepEqual(status.details.models, { current: "high", options: [
				{ id: "low", name: "Low", description: "Amp's low-effort mode." },
				{ id: "medium", name: "Medium", description: "Amp's medium-effort mode." },
				{ id: "high", name: "High", description: "Amp's high-effort mode." },
				{ id: "ultra", name: "Ultra", description: "Amp's ultra-effort mode." },
			], source: "fallback" });
			assert.equal((await h.ctl("steer", id, { message: "x", model: "low" })).details?.error?.code, "OPEN_OVERRIDE_FORBIDDEN");
			await h.ctl("close", id);
		});

		await t.test("a pi provider/id as a Codex model fails before any session starts", async () => {
			const reads = fake.calls.status.length;
			const refused = await delegate({ backend: "acp", agent: "codex", task: "hello", cwd, model: "openai/gpt-5.5" });
			assert.equal(refused.details?.error?.code, "INPUT_INVALID", refused.content[0].text);
			assert.match(refused.content[0].text, /looks like a pi provider\/id — use backend pi for pi offerings/);
			assert.equal(fake.calls.status.length, reads);
		});

		await h.runtime.session.agent.waitForIdle();
		assert.deepEqual(h.errors, []); assert.deepEqual(api.errors, []);
	} finally {
		await h.runtime.dispose();
		configureAcpCoordinator({});
		if (saved === undefined) delete process.env.AMP_CLI_PATH; else process.env.AMP_CLI_PATH = saved;
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
