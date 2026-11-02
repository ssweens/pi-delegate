import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { validateSteer } from "../src/backend.ts";
import { boardLine } from "../src/render.ts";
import { deferred, harness, provider, sandbox } from "./fixture.ts";

test("validateSteer: interrupt is a pi-only boolean", () => {
	const acp = validateSteer({ backend: "acp", origin: "created", agent: "codex" }, { message: "x", interrupt: true });
	assert.equal(acp.ok, false);
	assert.equal(!acp.ok && acp.error.code, "FIELD_NOT_ON_ACP");
	const bad = validateSteer({ backend: "pi" }, { message: "x", interrupt: "yes" });
	assert.equal(!bad.ok && bad.error.code, "INPUT_INVALID");
	const ok = validateSteer({ backend: "pi" }, { message: "x", interrupt: true });
	assert.deepEqual(ok.ok && ok.value, { message: "x", interrupt: true });
});

test("steer interrupt and read receipts (loopback provider)", { timeout: 60000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	const toolState = Symbol.for("pi-delegate-test/interrupt-tool");
	const stalled = { started: deferred(), aborted: deferred(), release: deferred() };
	(globalThis as any)[toolState] = stalled;
	mkdirSync(join(box.agentDir, "extensions"), { recursive: true });
	writeFileSync(join(box.agentDir, "extensions", "stalled-tool.js"), `export default function (pi) {
	pi.registerTool({ name: "stalled_tool", label: "stalled_tool", description: "Tool that observes abort but remains pending.",
		parameters: { type: "object", properties: {} },
		async execute(_id, _params, signal) {
			const state = globalThis[Symbol.for("pi-delegate-test/interrupt-tool")];
			state.started.resolve();
			signal.addEventListener("abort", () => state.aborted.resolve(), { once: true });
			await state.release.promise;
			return { content: [{ type: "text", text: "Released" }], details: undefined };
		}
	});
}
`);
	const agents = join(box.cwd, ".pi", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(join(agents, "stalled.md"), "---\nname: stalled\ndescription: Interrupt fixture.\ntools: stalled_tool\n---\nDo the work.\n");
	const h = await harness(box, undefined, { extensions: true });
	try {
		await t.test("an interrupt aborts the turn and the same run goes on to complete", async () => {
			const gate = deferred(), arrived = api.script("Long think", { text: "THINKING", gate });
			api.script("Stop and report now", { text: "REPORTED" });
			const { details: { id } } = await h.launch("Long think", { timeoutMs: 60000 });
			await arrived;
			const run = h.state().runs.get(id);
			const { segmentStartedAt, timeoutMs } = run;
			const steered = await h.ctl("steer", id, { message: "Stop and report now", interrupt: true });
			assert.match(steered.content[0].text, /interrupt requested/);
			const done = await h.ctl("wait", id);
			assert.equal(done.details.status, "complete", done.content[0].text);
			assert.equal(done.details.segment, 1);
			assert.match(done.details.output, /REPORTED/);
			assert.equal(run.error, undefined);
			assert.equal(run.stopped, false);
			assert.equal(run.segmentStartedAt, segmentStartedAt, "the budget is untouched");
			assert.equal(run.timeoutMs, timeoutMs);
			assert.equal(run.steers.length, 1);
			assert.equal(run.steers[0].interrupt, true);
			assert.ok(run.steers[0].readAt >= run.steers[0].queuedAt);
			assert.equal(run.activeTools.size, 0);

			// Settled: nothing to interrupt; a plain steer resumes it. The refused steer leaves no receipt.
			await assert.rejects(h.ctl("steer", id, { message: "Again", interrupt: true }), /no turn to interrupt/);
			assert.equal(run.steers.length, 1);
		});

		await t.test("interrupt returns while an aborted tool is pending, without overlapping prompts", async () => {
			api.script("Stalled tool", { tool: { name: "stalled_tool", arguments: {} } });
			api.script("Report after the tool settles", { text: "TOOL-REPORTED" });
			const { details: { id } } = await h.launch("Stalled tool", { role: "stalled", timeoutMs: 60000 });
			await stalled.started.promise;
			const run = h.state().runs.get(id);
			const requests = api.requests.length;
			const steering = h.ctl("steer", id, { message: "Report after the tool settles", interrupt: true });
			try {
				await stalled.aborted.promise;
				const returned = await Promise.race([steering.then(() => true), delay(1000).then(() => false)]);
				assert.equal(returned, true, "interrupt must not await a tool's abort cleanup");
				assert.equal((await h.ctl("status", id)).details.status, "running");
				assert.equal(run.completion.settled, false);
				assert.equal(run.steers.at(-1).readAt, undefined);
				assert.equal(run.activeTools.size, 1);
				assert.equal(api.requests.length, requests, "the replacement prompt waits for the old tool");
			} finally {
				stalled.release.resolve();
				await steering;
			}
			const done = await h.ctl("wait", id);
			assert.equal(done.details.status, "complete", done.content[0].text);
			assert.match(done.details.output, /TOOL-REPORTED/);
			assert.equal(done.details.segment, 1);
			assert.ok(run.steers.at(-1).readAt >= run.steers.at(-1).queuedAt);
		});

		await t.test("a plain steer is queued, pending until the turn boundary, then read", async () => {
			const gate = deferred(), arrived = api.script("Queued work", { text: "WORKING", gate });
			api.script("Note this", { text: "ACK" });
			const { details: { id } } = await h.launch("Queued work", { timeoutMs: 60000 });
			await arrived;
			const run = h.state().runs.get(id);
			const steered = await h.ctl("steer", id, { message: "Note this" });
			assert.match(steered.content[0].text, /steer queued; read at the child's next turn boundary/);
			assert.equal(run.steers.at(-1).readAt, undefined);
			assert.match(boardLine(run), / · steer pending 0m · /);
			assert.match(boardLine(run, run.steers.at(-1).queuedAt + 4 * 60_000), /steer pending 4m/);

			// An oven run has no turn here to abort.
			run.runtime = "oven";
			await assert.rejects(h.ctl("steer", id, { message: "Now", interrupt: true }), /oven slice/);
			delete run.runtime;

			gate.resolve();
			const done = await h.ctl("wait", id);
			assert.equal(done.details.status, "complete", done.content[0].text);
			assert.match(done.details.output, /ACK/);
			const receipt = run.steers.at(-1);
			assert.ok(receipt.readAt >= receipt.queuedAt);
			assert.equal(receipt.interrupt, undefined);
			assert.match(boardLine({ ...run, status: "running" }), /steer read \d\d:\d\d/);
		});
	} finally {
		stalled.release.resolve();
		await h.runtime.dispose(); await api.close(); rmSync(box.root, { recursive: true, force: true });
		delete (globalThis as any)[toolState];
	}
});
