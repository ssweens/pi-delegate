/**
 * `delegate`/`delegate_ctl` dispatch to the acp backend (todo 042), through the real extension
 * and Pi SDK parent. ACP agents are the existing fixtures: the fake ACP agent
 * (test/acp/fixtures/fake-acp-agent.ts) for created sessions, the fake Amp CLI
 * (test/acp/fixtures/fake-amp.mjs) for opening a native T-ID. No credentials, no network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { provider, sandbox, harness } from "./fixture.ts";
import { acpCoordinator, configureAcpCoordinator, existingAcpCoordinator } from "../src/acp/instance.ts";

const fakeAcpAgent = new URL("./acp/fixtures/fake-acp-agent.ts", import.meta.url).pathname;
const fakeAmp = new URL("./acp/fixtures/fake-amp.mjs", import.meta.url).pathname;
const localThread = "T-00000000-0000-0000-0000-000000000001";
const orbThread = "T-00000000-0000-0000-0000-000000000002";
const theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text, italic: (text: string) => text, bg: (_color: string, text: string) => text };

test("delegate dispatches to the acp backend; no backend is today's pi path", { timeout: 60000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	const saved = new Map(["AMP_CLI_PATH", "AMP_ACP_STATE_DIR"].map((key) => [key, process.env[key]]));
	chmodSync(fakeAmp, 0o755);
	process.env.AMP_CLI_PATH = fakeAmp;
	process.env.AMP_ACP_STATE_DIR = join(box.root, "amp-state");
	// The ACP agent runs in the child's cwd, so the tsx loader is passed by absolute URL.
	configureAcpCoordinator({ stateDir: join(box.root, "acp-state"), agentOverrides: { fixture: [process.execPath, "--import", import.meta.resolve("tsx"), fakeAcpAgent, join(box.root, "fixture-state.json")] } });
	const h = await harness(box);
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	initTheme();
	const { resultView, runLine, acpRowView } = await import("../src/render.ts");
	// Woken parents answer; no assertion depends on what they say.
	api.onUnscripted(() => ({ text: "ACK" }));
	const delegate = (args: Record<string, unknown>) => h.launch(args.task as string, { role: undefined, context: undefined, model: undefined, ...args });
	const codeOf = (result: any) => result.details?.error?.code;
	let piRunId = "";
	try {
		await t.test("no backend: the call, its result and its side effects are today's", async () => {
			api.script("Default work", { text: "DEFAULT-OK" });
			const result = await h.launch("Default work", { sync: true });
			assert.equal(result.isError, false, result.content[0].text);
			assert.equal(result.details.status, "complete");
			assert.equal(result.details.output, "DEFAULT-OK");
			assert.equal(result.details.role, "scout");
			assert.equal("backend" in result.details || "agent" in result.details || "session" in result.details, false, "a pi run view carries no ACP fields");
			assert.match(result.content[0].text, /^complete · scout-[0-9a-f-]{36} · role scout · model fixture\/fixture:off · context fresh/);
			piRunId = result.details.id;
			api.script("Explicit pi", { text: "EXPLICIT-OK" });
			const explicit = await h.launch("Explicit pi", { backend: "pi", sync: true });
			assert.equal(explicit.details.output, "EXPLICIT-OK");
			assert.equal(existingAcpCoordinator(), undefined, "pi delegation never constructs the Coordinator");
			const closed = await h.ctl("close", piRunId);
			assert.equal(codeOf(closed), "ACTION_UNSUPPORTED");
			assert.match(closed.content[0].text, /close is not supported on the pi backend/);
		});

		await t.test("unknown backends and agents, and fields a backend does not take, fail by code", async () => {
			assert.equal(codeOf(await h.launch("x", { backend: "remote" })), "UNKNOWN_BACKEND");
			assert.equal(codeOf(await h.launch("x", { agent: "amp" })), "FIELD_REQUIRES_ACP");
			assert.equal(codeOf(await h.launch("x", { sessionId: localThread })), "FIELD_REQUIRES_ACP");
			assert.equal(codeOf(await delegate({ backend: "acp", agent: "fixture", task: "x", context: "fork" })), "FIELD_NOT_ON_ACP");
			const unknown = await delegate({ backend: "acp", agent: "no-such-agent", task: "x" });
			assert.equal(codeOf(unknown), "INPUT_INVALID");
			assert.equal(unknown.details.error.field, "agent");
			assert.match(unknown.content[0].text, /unknown agent "no-such-agent"; known agents: .*amp.*fixture.*pi/);
			assert.equal(codeOf(await delegate({ backend: "acp", agent: "fixture", task: "x", role: "scout" })), "INPUT_INVALID", "acp role is read-only|writer");
			assert.equal(codeOf(await delegate({ backend: "acp", agent: "fixture" })), "INPUT_INVALID", "creating needs a task");
			assert.equal(codeOf(await delegate({ backend: "acp", agent: "amp", sessionId: localThread, model: "high" })), "OPEN_OVERRIDE_FORBIDDEN");
			assert.equal(codeOf(await delegate({ backend: "acp", agent: "amp", sessionId: localThread, role: "writer" })), "OPEN_OVERRIDE_FORBIDDEN");
			assert.equal(codeOf(await delegate({ backend: "acp", agent: "fixture", sessionId: "s-1", executionEnvironment: "orb" })), "OPEN_OVERRIDE_FORBIDDEN", "only Amp takes an executor hint when opening");
		});

		let created = "";
		await t.test("create: first turn, wait, result, steer on the same session, status lists both backends", async () => {
			const started = await delegate({ backend: "acp", agent: "fixture", task: "hello" });
			assert.equal(started.isError, undefined, started.content[0].text);
			created = started.details.id;
			assert.match(created, /^fixture-[0-9a-f-]{36}$/);
			assert.equal(started.details.backend, "acp");
			assert.equal(started.details.session.origin, "created");
			assert.equal(started.details.turns.length, 1);
			assert.notEqual(started.details.session.worker, created, "the worker name is not the run ID");
			assert.doesNotMatch(started.content[0].text, new RegExp(started.details.session.worker), "no internal worker name in text");

			const waited = await h.ctl("wait", created);
			assert.equal(waited.details.status, "complete", waited.content[0].text);
			assert.equal(waited.details.output, "READY");
			assert.match(waited.content[0].text, /backend acp · agent fixture/);
			assert.match(waited.content[0].text, /turn req_[0-9a-f-]+: completed, delivery accepted, provider outcome completed/, "the provider completing the prompt is its acceptance");
			assert.match(waited.content[0].text, /----- fixture-[0-9a-f-]+ reported, verbatim -----\nREADY\n/);
			const result = await h.ctl("result", created);
			assert.equal(result.details.output, "READY");
			assert.equal(result.isError, false);

			const set = await h.ctl("steer", created, { message: "SET:nonce-42" });
			assert.match(set.content[0].text, /turn req_.* sent/);
			assert.equal((await h.ctl("wait", created)).details.status, "complete");
			await h.ctl("steer", created, { message: "GET" });
			const got = await h.ctl("wait", created);
			assert.equal(got.details.output, "NONCE:nonce-42", "steer is the next turn on the same session");
			assert.equal(got.details.turns.length, 3);
			assert.equal(new Set(got.details.turns.map((turn: any) => turn.requestId)).size, 3, "one request ID per turn");
			assert.equal(codeOf(await h.ctl("steer", created, { message: "again", restart: true })), "FIELD_NOT_ON_ACP");

			const listed = await h.ctl("status");
			assert.equal(listed.details.kind, "runs");
			assert.ok(listed.details.rows.some((row: any) => row.id === piRunId && !("backend" in row)));
			assert.ok(listed.details.rows.some((row: any) => row.id === created && row.backend === "acp"));
			assert.match(listed.content[0].text, new RegExp(`complete · ${created} · backend acp · agent fixture`));
			const one = await h.ctl("status", created);
			assert.match(one.content[0].text, /^complete · fixture-.* · backend acp · agent fixture · 3 turns/);
		});

		await t.test("a settled turn wakes the parent unless a wait was joined to it", async () => {
			const notices = h.notices.length;
			await h.ctl("steer", created, { message: "wake me" });
			for (let i = 0; i < 100 && h.notices.length === notices; i++) await sleep(50);
			const wake = h.notices.at(-1);
			assert.equal(wake?.details?.backend, "acp");
			assert.equal(wake?.details?.id, created);
			assert.match(wake.content, /^delegate finished\ncomplete · fixture-/);
			await h.runtime.session.agent.waitForIdle();

			const quiet = h.notices.length;
			await h.ctl("steer", created, { message: "WAIT" });
			const joined = h.ctl("wait", created);
			await sleep(200);
			await h.ctl("cancel", created);
			assert.equal((await joined).details.status, "cancelled");
			await sleep(300);
			assert.equal(h.notices.length, quiet, "the joined wait took the result instead of waking the parent");
		});

		await t.test("cancel reaches only an active turn this run started", async () => {
			await h.ctl("steer", created, { message: "WAIT" });
			const running = await h.ctl("status", created);
			assert.equal(running.details.status, "running");
			const cancelled = await h.ctl("cancel", created);
			assert.equal(cancelled.isError, undefined, cancelled.content[0].text);
			assert.equal(cancelled.details.status, "cancelled");
			assert.match(cancelled.content[0].text, /cancel requested; turn req_.* is cancelled/);
			const again = await h.ctl("cancel", created);
			assert.equal(codeOf(again), "WORKER_NOT_RUNNING");
			assert.match(again.content[0].text, new RegExp(`${created} has no active turn`));
		});

		await t.test("wait any/all across runs; a timeout ends the wait, never the run", async () => {
			const slow = (await delegate({ backend: "acp", agent: "fixture", task: "WAIT" })).details.id;
			const fast = (await delegate({ backend: "acp", agent: "fixture", task: "quick" })).details.id;
			const any = await h.ctl("wait", undefined, { runIds: [slow, fast], mode: "any" });
			assert.equal(any.details.kind, "runs");
			assert.deepEqual(any.details.wait, { reason: "settled", pending: [slow] });
			assert.deepEqual(any.details.rows.map((row: any) => [row.id, row.status]), [[fast, "complete"], [slow, "running"]]);
			const timedOut = await h.ctl("wait", undefined, { runIds: [slow], mode: "all", timeoutMs: 300 });
			assert.match(timedOut.content[0].text, /^wait timed out after 300 ms; nothing was cancelled\. Still running: /);
			assert.equal(timedOut.details.status, "running");
			assert.equal((await h.ctl("status", slow)).details.status, "running", "the run kept going");
			const mixed = await h.ctl("wait", undefined, { runIds: [slow, piRunId], mode: "any" });
			assert.deepEqual(mixed.details.wait, { reason: "settled", pending: [slow] }, "several-run wait spans both backends");
			assert.deepEqual(mixed.details.rows.map((row: any) => [row.id, row.status]), [[piRunId, "complete"], [slow, "running"]]);
			const all = h.ctl("wait", undefined, { runIds: [slow, fast], mode: "all" });
			await sleep(200);
			await h.ctl("cancel", slow);
			const both = await all;
			assert.deepEqual(both.details.wait, { reason: "settled", pending: [] });
			assert.deepEqual(both.details.rows.map((row: any) => row.status).sort(), ["cancelled", "complete"]);
			for (const id of [slow, fast]) assert.equal((await h.ctl("close", id)).isError, undefined);
		});

		await t.test("close disposes a created session; an active turn needs force", async () => {
			await h.ctl("steer", created, { message: "WAIT" });
			const busy = await h.ctl("close", created);
			assert.equal(codeOf(busy), "WORKER_BUSY");
			const closed = await h.ctl("close", created, { force: true });
			assert.equal(closed.isError, undefined, closed.content[0].text);
			assert.equal(closed.details.closed, true);
			assert.equal(closed.details.status, "cancelled");
			assert.match(closed.content[0].text, /closed; its session was disposed/);
			assert.equal((await h.ctl("close", created)).details.closed, true, "closing a closed run is a no-op");
			assert.equal(codeOf(await h.ctl("steer", created, { message: "more" })), "RUN_CLOSED");
			const status = await h.ctl("status", created);
			assert.match(status.content[0].text, /closed: session disposed/);
			assert.equal(status.details.turns.length, 7, "a closed run keeps its turns");
		});

		await t.test("open: an exact Amp T-ID, idle without a task, native send by steer, close only disconnects", async () => {
			const opened = await delegate({ backend: "acp", agent: "amp", sessionId: localThread, cwd: undefined });
			assert.equal(opened.isError, undefined, opened.content[0].text);
			const id = opened.details.id;
			assert.equal(opened.details.status, "idle");
			assert.equal(opened.details.turns.length, 0);
			assert.equal(opened.details.session.origin, "opened");
			assert.equal(opened.details.session.nativeSessionId, localThread);
			assert.equal(opened.details.session.executionEnvironment, "local");
			assert.equal(opened.details.capabilities.close.effect, "disconnect");
			assert.match(opened.content[0].text, new RegExp(`^${id} idle \\(acp amp, opened native session ${localThread}\\); no turn sent`));

			const shown = resultView("delegate", undefined, "", opened, { expanded: true }, theme, 120).join("\n");
			assert.match(shown, /○ acp amp/);
			assert.match(shown, /backend acp {2}agent amp/);
			assert.match(shown, new RegExp(`opened session ${localThread} \\(local\\)`));
			assert.match(shown, /idle: attached without sending a turn/);
			assert.doesNotMatch(shown, /w-[0-9a-f]{8}|runtimeSessionName|acpx|eventPath/, "no transport detail on screen");
			assert.match(runLine(acpRowView(opened.details), theme, 200), new RegExp(`○ acp amp .*idle.*acp amp.*${localThread}`));

			assert.equal(codeOf(await h.ctl("steer", id, { message: "exact", model: "high" })), "OPEN_OVERRIDE_FORBIDDEN");
			await h.ctl("steer", id, { message: "exact" });
			const sent = await h.ctl("wait", id);
			assert.equal(sent.details.output, "AMP_LOCAL_OK");
			assert.deepEqual(sent.details.turns.map((turn: any) => [turn.delivery, turn.providerOutcome]), [["accepted", "completed"]]);
			assert.match(sent.content[0].text, /delivery accepted, provider outcome completed/);
			assert.equal(codeOf(await h.ctl("close", id, { discardPersistentState: true })), "OPEN_OVERRIDE_FORBIDDEN");
			const closed = await h.ctl("close", id);
			assert.match(closed.content[0].text, /closed; disconnected, and the native session is unchanged/);

			const withTask = await delegate({ backend: "acp", agent: "amp", sessionId: orbThread, executionEnvironment: "orb", task: "orb exact", cwd: undefined });
			assert.equal(withTask.details.session.executionEnvironment, "orb");
			const orb = await h.ctl("wait", withTask.details.id);
			assert.equal(orb.details.output, "AMP_ORB_OK");
			await h.ctl("close", withTask.details.id);
		});

		await t.test("one Coordinator per process, shared with delegate; the bridge actions are gone", async () => {
			const coordinator = await acpCoordinator();
			assert.equal(existingAcpCoordinator(), coordinator);
			const listed: any = await coordinator.execute({ action: "list" });
			assert.equal(listed.ok, true);
			assert.ok(listed.details.requests.length >= 7, "list sees the turns delegate sent: the same Coordinator");
			assert.equal("controls" in listed.details, false);
			for (const action of ["observe", "append", "steer", "cancel_remote"]) {
				const response = await coordinator.execute({ action, name: "anything" });
				assert.equal(response.ok, false);
				if (!response.ok) assert.equal(response.error.code, "ACTION_INVALID", action);
			}
		});

		await h.runtime.session.agent.waitForIdle();
		await h.runtime.dispose();
		assert.equal(existingAcpCoordinator(), undefined, "parent exit shuts the Coordinator down");
		assert.deepEqual(h.errors, []); assert.deepEqual(api.errors, []);
	} finally {
		await h.runtime.dispose();
		configureAcpCoordinator({});
		for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});

test("the Agents frame shows an ACP run's backend, agent and native session", async () => {
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	initTheme();
	const { AgentsPanel } = await import("../src/inspector.ts");
	const { acpRowView } = await import("../src/render.ts");
	const { acpCapabilities } = await import("../src/backend.ts");
	const running = acpRowView({
		backend: "acp", id: "amp-1", status: "running", task: "Port the parser\nmore", cwd: "/repo", startedAt: Date.now(),
		session: { agent: "amp", origin: "opened", worker: "w-1", nativeSessionId: localThread, handle: { runtimeSessionName: "pi-strings:w-1" } },
		turns: [{ requestId: "req_1", delivery: "unknown", status: "running", startedAt: new Date().toISOString(), truncated: false }],
		output: "", truncated: false, capabilities: acpCapabilities({ origin: "opened", agent: "amp" }),
	});
	const tui: any = { addInputListener: () => () => {}, requestRender: () => {}, hasOverlay: () => false, terminal: { rows: 40 } };
	const panel = new AgentsPanel({ all: () => [running], activity: () => ({ messages: [], activeTools: new Map() }), subscribe: () => () => {}, steer: async () => {}, cancel: async () => {} }, theme, tui, async () => {});
	try {
		const frame = panel.render(120).join("\n");
		assert.match(frame, /Agents · 1 active/);
		assert.match(frame, /Port the parser/);
		assert.match(frame, /acp amp/);
		assert.match(frame, new RegExp(`session ${localThread}`));
		assert.doesNotMatch(frame, /Thinking…|w-1|pi-strings:/);
	} finally { panel.dispose(); }
});

test("the Agents frame shows each child's provider and model, and drops the column when narrow", async () => {
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	initTheme();
	const { AgentsPanel } = await import("../src/inspector.ts");
	const { acpRowView } = await import("../src/render.ts");
	const { acpCapabilities } = await import("../src/backend.ts");
	const pi: any = {
		id: "pi-1", status: "running", settled: false, stopped: false, role: "scout",
		model: "anthropic/claude-sonnet-5", task: "Map the parser", cwd: "/repo", thinking: "high",
		context: "fresh", segment: 1, output: "", turns: 1, durationMs: 4000,
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0,
		changedFiles: [], droppedTools: [], toolCalls: [], revision: 1,
	};
	const acp = acpRowView({
		backend: "acp", id: "amp-1", status: "running", model: "gpt-5.6", task: "Port the parser", cwd: "/repo", startedAt: Date.now(),
		session: { agent: "amp", origin: "created", worker: "w-1", handle: { runtimeSessionName: "pi-strings:w-1" } },
		turns: [{ requestId: "req_1", delivery: "unknown", status: "running", startedAt: new Date().toISOString(), truncated: false }],
		output: "", truncated: false, capabilities: acpCapabilities({ origin: "created", agent: "amp" }),
	});
	const { model: _dropped, ...noModel } = acp;
	const opened = { ...noModel, id: "amp-2", model: "", task: "Read the docs", nativeSessionId: localThread };
	const tui: any = { addInputListener: () => () => {}, requestRender: () => {}, hasOverlay: () => false, terminal: { rows: 40 } };
	const panel = new AgentsPanel({ all: () => [pi, acp, opened], activity: () => ({ messages: [], activeTools: new Map() }), subscribe: () => () => {}, steer: async () => {}, cancel: async () => {} }, theme, tui, async () => {});
	try {
		const wide = panel.render(140).join("\n");
		assert.match(wide, /anthropic\/claude-sonnet-5/, "a pi row shows provider/id");
		assert.doesNotMatch(wide, /claude-sonnet-5:high/, "thinking stays out of the frame");
		assert.match(wide, /gpt-5\.6/, "an ACP row shows the agent's model");
		const blank = wide.split("\n").find((l) => l.includes("Read the docs")) ?? "";
		assert.doesNotMatch(blank, /gpt-5\.6/, "an opened session with no model leaves the column blank");
		assert.equal(blank.indexOf("session"), wide.split("\n").find((l) => l.includes("Port the parser"))!.indexOf("session"), "the blank column still holds its width, so activity lines up");
		const narrow = panel.render(80).join("\n");
		assert.doesNotMatch(narrow, /anthropic\/claude-sonnet-5|gpt-5\.6/, "the column drops before it crowds the activity");
		assert.match(narrow, /Map the parser/);
	} finally { panel.dispose(); }
});
