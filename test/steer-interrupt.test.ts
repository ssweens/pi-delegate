import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { rmSync } from "node:fs";
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
	const h = await harness(box);
	try {
		await t.test("an interrupt aborts the turn and the same run goes on to complete", async () => {
			const gate = deferred(), arrived = api.script("Long think", { text: "THINKING", gate });
			api.script("Stop and report now", { text: "REPORTED" });
			const { details: { id } } = await h.launch("Long think", { timeoutMs: 60000 });
			await arrived;
			const run = h.state().runs.get(id);
			const { segmentStartedAt, timeoutMs } = run;
			const steered = await h.ctl("steer", id, { message: "Stop and report now", interrupt: true });
			assert.match(steered.content[0].text, /interrupted the current turn/);
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
		await h.runtime.dispose(); await api.close(); rmSync(box.root, { recursive: true, force: true });
	}
});
