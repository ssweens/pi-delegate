/**
 * The Coordinator is process-wide; parents are not. Two SDK parents in one process (as an
 * embedder runs them) share it, and a mixed pi/acp wait keeps its own Coordinator waits in check.
 * Real extension and Pi SDK parents; the ACP runtime is the in-process fake.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { deferred, provider, sandbox, harness } from "./fixture.ts";
import { acpCoordinator, configureAcpCoordinator, existingAcpCoordinator } from "../src/acp/instance.ts";
import { fakeRuntime } from "./acp-fake-runtime.ts";

const acpArgs = { backend: "acp", agent: "fake", role: undefined, context: undefined, model: undefined };

test("acp runs with two parents in one process, and a mixed wait", { timeout: 60000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	const fake = fakeRuntime();
	configureAcpCoordinator({ stateDir: join(box.root, "acp-state"), profiles: {}, runtimeFactory: fake.factory });
	api.onUnscripted(() => ({ text: "ACK" }));
	const a = await harness(box);
	try {
		await t.test("one parent's exit leaves the other parent's ACP runs running", async () => {
			const b = await harness(box);
			const mine = (await a.launch("WAIT", acpArgs)).details.id;
			const theirs = (await b.launch("hello", acpArgs)).details.id;
			assert.equal((await b.ctl("wait", theirs)).details.status, "complete");
			await b.runtime.session.agent.waitForIdle();
			await b.runtime.dispose();
			assert.deepEqual(fake.calls.cancel, [], "parent A's turn was not stopped by parent B's exit");
			assert.ok(existingAcpCoordinator(), "the Coordinator stays while a parent remains");
			const status = await a.ctl("status", mine);
			assert.equal(status.details.status, "running", status.content[0].text);
			const cancelled = await a.ctl("cancel", mine);
			assert.equal(cancelled.details.status, "cancelled", cancelled.content[0].text);
			await a.ctl("close", mine);
		});

		await t.test("a mixed wait holds one Coordinator wait at a time while pi runs settle around it", async () => {
			const coordinator = await acpCoordinator();
			const execute = coordinator.execute.bind(coordinator);
			let outstanding = 0, most = 0;
			coordinator.execute = async (input) => {
				if (input.action !== "wait" || !Array.isArray(input.names)) return execute(input);
				most = Math.max(most, ++outstanding);
				try { return await execute(input); } finally { outstanding -= 1; }
			};
			try {
				const gates = [deferred(), deferred()];
				const arrived = gates.map((gate, i) => api.script(`Mixed child ${i}`, { text: `PI-${i}`, gate }));
				const pis = [(await a.launch("Mixed child 0")).details.id, (await a.launch("Mixed child 1")).details.id];
				await Promise.all(arrived);
				const acp = (await a.launch("WAIT", acpArgs)).details.id;
				const waiting = a.ctl("wait", undefined, { runIds: [...pis, acp], mode: "all", timeoutMs: 900 });
				await sleep(100);
				gates[0]!.resolve();
				await sleep(150);
				gates[1]!.resolve();
				const out = await waiting;
				assert.deepEqual(out.details.wait, { reason: "timeout", pending: [acp] }, out.content[0].text);
				assert.equal(most, 1, "each loop pass reuses the outstanding Coordinator wait instead of starting another");
				await a.ctl("cancel", acp);
				await a.ctl("close", acp);
			} finally { coordinator.execute = execute; }
		});

		await a.runtime.session.agent.waitForIdle();
		await a.runtime.dispose();
		assert.equal(existingAcpCoordinator(), undefined, "the last parent's exit shuts the Coordinator down");
		assert.deepEqual(a.errors, []); assert.deepEqual(api.errors, []);
	} finally {
		await a.runtime.dispose();
		configureAcpCoordinator({});
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
