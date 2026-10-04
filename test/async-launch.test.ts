import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AcpBackend } from "../src/acp-backend.ts";
import { configureAcpCoordinator, shutdownAcpCoordinator } from "../src/acp/instance.ts";
import type { Profile, RuntimePort } from "../src/acp/domain/types.ts";
import { fakeRuntime } from "./acp-fake-runtime.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

test("ACP delegate launch returns before a slow session starts, and wait joins it", { timeout: 30_000 }, async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-delegate-async-launch-"));
	const cwd = join(root, "project");
	const runDir = join(root, "runs");
	mkdirSync(cwd, { recursive: true });
	const gate = deferred();
	const fake = fakeRuntime();
	const runtimeFactory = (childCwd: string, stateDir: string, profile: Profile): RuntimePort => {
		const port = fake.factory(childCwd, stateDir, profile);
		return {
			...port,
			async ensureSession(input: any) {
				await gate.promise;
				return port.ensureSession(input);
			},
		};
	};
	const ownerKey = `owner-${root}`;
	const settled: string[] = [];
	configureAcpCoordinator({ stateDir: join(root, "acp-state"), profiles: {}, runtimeFactory });
	const backend = new AcpBackend({
		ownerKey: () => ownerKey,
		changed() {},
		settled(view) { settled.push(view.id); },
		runDir: () => runDir,
	});
	t.after(async () => {
		await backend.closeOwner(ownerKey);
		await shutdownAcpCoordinator();
		configureAcpCoordinator({});
		rmSync(root, { recursive: true, force: true });
	});

	const startedAt = Date.now();
	const started = await backend.start({ backend: "acp", origin: "created", agent: "fixture", task: "long exchange", cwd });
	assert.ok(Date.now() - startedAt < 250, "delegate returned before external startup completed");
	assert.equal(started.status, "running");
	assert.equal(started.turns.length, 0, "startup is visible without inventing a provider turn");

	const timed = await backend.wait({ runIds: [started.id], mode: "all", timeoutMs: 100 });
	assert.equal(timed.reason, "timeout");
	assert.deepEqual(timed.pending, [started.id]);
	assert.deepEqual(settled, []);

	gate.resolve();
	const done = await backend.wait({ runIds: [started.id], mode: "all", timeoutMs: 10_000 });
	assert.equal(done.reason, "settled");
	assert.equal(done.settled[0].status, "complete");
	assert.equal(done.settled[0].output, "ACK");
	await sleep(0);
});
