import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { runHealth } from "../src/health.ts";
import { deferred, harness, provider, sandbox } from "./fixture.ts";

test("live budgets count from now, and a timeout leaves a salvage (loopback provider)", { timeout: 60000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	const h = await harness(box);
	try {
		await t.test("a running child's extension ends that long from now", async () => {
			const gate = deferred(), arrived = api.script("Budget from now", { text: "WORKING", gate });
			api.script("More time", { text: "DONE-LATER" });
			const { details: { id } } = await h.launch("Budget from now", { timeoutMs: 1500 });
			await arrived;
			await sleep(400);
			const run = h.state().runs.get(id);
			assert.ok(run.lastProgressAt >= run.segmentStartedAt, "a segment start counts as progress");
			await h.ctl("steer", id, { message: "More time", timeoutMs: 60000 });
			const spent = Date.now() - run.segmentStartedAt;
			assert.ok(spent >= 400);
			const left = run.timeoutMs - spent;
			assert.ok(left > 59000 && left <= 60000, `budget left ${left}`);
			assert.ok(Math.abs(runHealth(run).budgetLeftMs! - 60000) < 1000);
			assert.equal(JSON.parse(readFileSync(run.recordPath, "utf8")).timeoutMs, run.timeoutMs);
			gate.resolve();
			const done = await h.ctl("wait", id);
			assert.equal(done.details.status, "complete", done.content[0].text);
			assert.equal(h.state().runs.get(id).turnStartedAt, undefined);
		});
		await t.test("a timeout's error carries the salvage", async () => {
			api.script("Salvage work", { text: "Looking around first.", tool: { name: "ls", arguments: { path: "." } } });
			api.onUnscripted(() => ({ text: "Still going", gate: deferred() }));
			const timedOut = await h.waitLaunch("Salvage work", { timeoutMs: 1500 });
			api.onUnscripted();
			assert.equal(timedOut.details.status, "timeout", timedOut.content[0].text);
			const error: string = timedOut.details.error;
			assert.match(error, /Stopped after its 0 min budget/);
			assert.match(error, /\nSalvage:\nlast words: /);
			assert.match(error, /last tools: ls \./);
			assert.match(error, new RegExp(`Resume: delegate_ctl steer runId=${timedOut.details.id} timeoutMs=<ms from now> message=<what remains>`));
		});
	} finally {
		await h.runtime.dispose(); await api.close(); rmSync(box.root, { recursive: true, force: true });
	}
});
