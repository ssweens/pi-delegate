/**
 * The delegate contract (src/backend.ts, ADR 0001) as one table, through the real extension and Pi
 * SDK parent (todo 046):
 * - every capability-report entry is honored for every backend/origin/agent combination: an action
 *   the run's report marks unsupported fails ACTION_UNSUPPORTED with the report's reason, and an
 *   action it marks supported never does;
 * - every ContractErrorCode is reachable through `delegate`/`delegate_ctl`, and none starts a session;
 * - cancel never reaches a turn this run did not start;
 * - the backend's own failure paths: a run that cannot be recorded (RUN_NOT_PERSISTED), and a parked
 *   opened run whose native session changed (SESSION_IDENTITY_CHANGED).
 * The ACP runtime is an in-process fake that creates and opens sessions for any agent name, so Amp
 * and non-Amp origins share one fixture. No credentials, no network.
 */
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { NativeSessionDescription, NormalizedEvent, RuntimeHandle, RuntimePort, RuntimeTerminal, RuntimeTurn } from "../src/acp/domain/types.ts";
import { configureAcpCoordinator } from "../src/acp/instance.ts";
import { acpCapabilities, type BackendCapabilities, type ContractErrorCode, type LifecycleAction, PI_CAPABILITIES } from "../src/backend.ts";
import { provider, sandbox, harness } from "./fixture.ts";

interface Calls { ensure: string[]; open: string[]; cancel: string[]; disconnect: string[]; close: string[] }

/** Created and opened sessions for any agent. A prompt starting with WAIT runs until cancelled or disconnected. */
function nativeRuntime(natives: Map<string, NativeSessionDescription>) {
	const calls: Calls = { ensure: [], open: [], cancel: [], disconnect: [], close: [] };
	const live = new Map<string, Set<(terminal: RuntimeTerminal) => void>>();
	const turn = (handle: RuntimeHandle, prompt: string, requestId: string): RuntimeTurn => {
		let finish!: (terminal: RuntimeTerminal) => void;
		const result = new Promise<RuntimeTerminal>((resolve) => { finish = resolve; });
		const running = live.get(handle.runtimeSessionName) ?? new Set();
		live.set(handle.runtimeSessionName, running.add(finish));
		void result.then(() => running.delete(finish));
		const waits = prompt.startsWith("WAIT");
		if (!waits) setImmediate(() => finish({ status: "completed", stopReason: "end_turn" }));
		async function* events(): AsyncGenerator<NormalizedEvent> {
			if (!waits) yield { type: "text", text: "ACK", stream: "output" };
			await result;
		}
		return {
			requestId, result, events: events(),
			async cancel() { calls.cancel.push(requestId); finish({ status: "cancelled", stopReason: "cancelled" }); },
			async closeStream() {},
		};
	};
	const end = (handle: RuntimeHandle) => { for (const finish of live.get(handle.runtimeSessionName) ?? []) finish({ status: "failed", error: { message: "disconnected" } }); };
	const port = (): RuntimePort => ({
		async ensureSession(input) {
			calls.ensure.push(input.name);
			return { sessionKey: `fake:${input.name}`, backend: "fake", runtimeSessionName: input.name, backendSessionId: input.resumeSessionId ?? `sess-${input.name}` };
		},
		async resumeSession(input) { return { sessionKey: `fake:${input.name}`, backend: "fake", runtimeSessionName: input.name, backendSessionId: input.sessionId }; },
		async describeNativeSession(_agent, sessionId) {
			const native = natives.get(sessionId);
			if (!native) throw new Error(`unknown native session ${sessionId}`);
			return { ...native };
		},
		async openSession(input) {
			calls.open.push(input.name);
			return { sessionKey: `native:${input.name}`, backend: "fake", runtimeSessionName: input.name, backendSessionId: `adapter-${input.name}`, agentSessionId: input.native.id };
		},
		async disconnect(handle) { calls.disconnect.push(handle.runtimeSessionName); end(handle); },
		startTurn: (input) => turn(input.handle, input.prompt, input.requestId),
		async getStatus() { return { modelDiscoverySupported: false, availableModelIds: [] }; },
		async close(handle) { calls.close.push(handle.runtimeSessionName); end(handle); },
	});
	return { calls, factory: () => port() };
}

/** The run-level actions, each as the one tool call that performs it, in the order the table runs them. */
type RunAction = Exclude<LifecycleAction, "create" | "open">;
const RUN_ACTIONS = ["status", "result", "wait", "observe", "steer", "cancel", "close"] as const satisfies readonly RunAction[];
type Missing = Exclude<RunAction, (typeof RUN_ACTIONS)[number]>;
// A lifecycle action added to the contract without a row here fails the typecheck.
const everyRunAction: [Missing] extends [never] ? true : Missing = true;

test("the delegate contract, by backend, origin and agent, through delegate and delegate_ctl", { timeout: 120000 }, async (t) => {
	assert.ok(everyRunAction);
	const api = await provider();
	const box = sandbox(api.url);
	const cwd = realpathSync(box.cwd);
	const native = (id: string, executionEnvironment: "local" | "orb" = "local"): NativeSessionDescription => ({
		id, scope: "fake://account-a", cwd, executionEnvironment, attachment: "stored-session", disconnectEffect: "stops-local-executor", concurrentNativeClients: "unsupported", activity: "unknown",
	} as NativeSessionDescription);
	const natives = new Map(["T-matrix-amp", "pi-matrix", "pi-idle", "pi-moves", "T-codes"].map((id) => [id, native(id)]));
	const fake = nativeRuntime(natives);
	const saved = process.env.AMP_CLI_PATH;
	// Observation runs `amp threads export`; a missing binary makes it an unknown observation, never a real Amp call.
	process.env.AMP_CLI_PATH = join(box.root, "no-amp-here");
	configureAcpCoordinator({ stateDir: join(box.root, "acp-state"), profiles: {}, runtimeFactory: fake.factory });
	api.onUnscripted(() => ({ text: "ACK" }));
	let h = await harness(box);
	const delegate = (args: Record<string, unknown>) => h.launch("", { role: undefined, context: undefined, model: undefined, cwd: undefined, task: undefined, ...args });
	const codeOf = (result: any): string | undefined => result.details?.error?.code;
	const invoke: Record<RunAction, (id: string) => Promise<any>> = {
		status: (id) => h.ctl("status", id),
		result: (id) => h.ctl("result", id),
		wait: (id) => h.ctl("wait", id),
		observe: (id) => h.ctl("status", id, { observe: true }),
		steer: (id) => h.ctl("steer", id, { message: "WAIT hold" }),
		cancel: (id) => h.ctl("cancel", id),
		close: (id) => h.ctl("close", id, { force: true }),
	};
	try {
		const rows: { name: string; start: () => Promise<any>; report: (details: any) => BackendCapabilities }[] = [
			{ name: "pi", start: () => h.launch("pi matrix", { sync: true }), report: () => PI_CAPABILITIES },
			{ name: "acp created (pi)", start: () => delegate({ backend: "acp", agent: "pi", task: "hello", cwd }), report: () => acpCapabilities({ origin: "created", agent: "pi" }) },
			{ name: "acp created (amp)", start: () => delegate({ backend: "acp", agent: "amp", task: "hello", cwd, executionEnvironment: "local" }), report: () => acpCapabilities({ origin: "created", agent: "amp" }) },
			{ name: "acp opened (pi)", start: () => delegate({ backend: "acp", agent: "pi", sessionId: "pi-matrix", task: "hello" }), report: () => acpCapabilities({ origin: "opened", agent: "pi" }) },
			{ name: "acp opened (amp)", start: () => delegate({ backend: "acp", agent: "amp", sessionId: "T-matrix-amp", task: "hello" }), report: () => acpCapabilities({ origin: "opened", agent: "amp" }) },
		];
		for (const row of rows) {
			await t.test(`${row.name}: every action its capability report lists is honored`, async () => {
				const started = await row.start();
				assert.notEqual(started.isError, true, started.content[0].text);
				const id = started.details.id;
				const report = row.report(started.details);
				if (started.details.backend === "acp") assert.deepEqual(started.details.capabilities, report, "the run reports the contract's capabilities for its origin and agent");
				else assert.equal("capabilities" in started.details, false, "a pi run view carries no ACP fields; PI_CAPABILITIES decides");
				for (const action of RUN_ACTIONS) {
					const capability = report[action];
					const result = await invoke[action](id);
					if (capability.supported) {
						assert.notEqual(codeOf(result), "ACTION_UNSUPPORTED", `${row.name} ${action} is supported: ${result.content[0].text}`);
					} else {
						assert.equal(codeOf(result), "ACTION_UNSUPPORTED", `${row.name} ${action} is unsupported: ${result.content[0].text}`);
						assert.equal(result.content[0].text, `ACTION_UNSUPPORTED: ${action} is not supported on the ${report.backend} backend: ${capability.reason}`);
					}
					if (action === "observe" && capability.supported) assert.equal(result.details.observation?.state, "unknown", "the export could not run, so nothing is inferred");
					if (action === "cancel" && report.backend === "acp") assert.equal(result.details.status, "cancelled", "cancel stopped the turn this run's steer started");
				}
				// open is a start action: on pi, a sessionId fails before any action is chosen.
				if (report.backend === "pi") {
					assert.equal(report.open.supported, false);
					assert.equal(codeOf(await h.launch("x", { sessionId: "T-matrix-amp" })), "FIELD_REQUIRES_ACP");
				} else {
					assert.equal(report.create.supported && report.open.supported, true, "create and open both start runs on acp, as the rows above did");
				}
				await h.runtime.session.agent.waitForIdle();
			});
		}

		await t.test("every contract error code is reachable through the tools, and none starts a session", async () => {
			const before = JSON.stringify(fake.calls);
			const reach: Record<ContractErrorCode, () => Promise<any>> = {
				UNKNOWN_BACKEND: () => h.launch("x", { backend: "remote" }),
				FIELD_REQUIRES_ACP: () => h.launch("x", { agent: "amp" }),
				FIELD_NOT_ON_ACP: () => delegate({ backend: "acp", agent: "pi", task: "x", context: "fork" }),
				OPEN_OVERRIDE_FORBIDDEN: () => delegate({ backend: "acp", agent: "amp", sessionId: "T-codes", model: "high" }),
				INPUT_INVALID: () => delegate({ backend: "acp", task: "x" }),
				ACTION_UNSUPPORTED: async () => h.ctl("close", (await h.launch("pi codes", { sync: true })).details.id),
			};
			for (const [code, call] of Object.entries(reach)) {
				const result = await call();
				assert.equal(codeOf(result), code, result.content[0].text);
				assert.equal(result.isError, true);
			}
			assert.equal(JSON.stringify(fake.calls), before, "a rejected call creates, opens, cancels and closes nothing");
			await h.runtime.session.agent.waitForIdle();
		});

		await t.test("cancel never reaches a turn this run did not start", async () => {
			const opened = await delegate({ backend: "acp", agent: "pi", sessionId: "pi-idle" });
			assert.equal(opened.details.status, "idle");
			assert.equal(opened.details.capabilities.cancel.scope, "own-turns");
			const cancels = fake.calls.cancel.length;
			const refused = await h.ctl("cancel", opened.details.id);
			assert.equal(codeOf(refused), "WORKER_NOT_RUNNING", "the native session may be busy with someone else's turn; this run has none");
			assert.equal(fake.calls.cancel.length, cancels, "nothing was cancelled");
			await h.ctl("close", opened.details.id);
		});

		await t.test("a run that cannot be recorded is released and fails RUN_NOT_PERSISTED", async () => {
			const other = await harness(box);
			try {
				// The run directory cannot be created: a file stands where it would go.
				const owners = join(cwd, ".agents", "pi", "subsessions", "owners", other.ctx().sessionManager.getSessionId());
				mkdirSync(owners, { recursive: true });
				writeFileSync(join(owners, "acp"), "not a directory");
				const closes = fake.calls.close.length;
				const refused = await other.launch("hello", { backend: "acp", agent: "pi", role: undefined, context: undefined, model: undefined, cwd });
				assert.equal(codeOf(refused), "RUN_NOT_PERSISTED", refused.content[0].text);
				assert.equal(fake.calls.close.length, closes + 1, "its session was released, not left running untracked");
				const listed = await other.ctl("status");
				assert.equal(listed.details.rows.some((row: any) => row.backend === "acp"), false, "nothing to find again after a restart");
			} finally { await other.runtime.dispose(); }
		});

		await t.test("a parked opened run whose native session changed fails SESSION_IDENTITY_CHANGED on steer", async () => {
			const opened = await delegate({ backend: "acp", agent: "pi", sessionId: "pi-moves", task: "hello" });
			const id = opened.details.id;
			assert.equal((await h.ctl("wait", id)).details.status, "complete");
			await h.runtime.session.agent.waitForIdle();
			const parent = h.parent;
			await h.runtime.dispose();
			natives.set("pi-moves", { ...native("pi-moves"), scope: "fake://account-b" });
			h = await harness(box, parent);
			const parked = await h.ctl("status", id);
			assert.ok(parked.details.parked, parked.content[0].text);
			const disconnects = fake.calls.disconnect.length;
			const refused = await h.ctl("steer", id, { message: "more" });
			assert.equal(codeOf(refused), "SESSION_IDENTITY_CHANGED", refused.content[0].text);
			assert.equal(fake.calls.disconnect.length, disconnects + 1, "the reopened session was disconnected, not used");
			const still = await h.ctl("result", id);
			assert.equal(still.details.output, "ACK", "the record stays readable");
			assert.equal(still.details.turns.length, 1, "no turn was sent to the changed session");
			await h.ctl("close", id);
		});

		await h.runtime.session.agent.waitForIdle();
		await h.runtime.dispose();
		assert.deepEqual(h.errors, []); assert.deepEqual(api.errors, []);
	} finally {
		await h.runtime.dispose();
		configureAcpCoordinator({});
		if (saved === undefined) delete process.env.AMP_CLI_PATH; else process.env.AMP_CLI_PATH = saved;
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
