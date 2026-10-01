/**
 * ACP runs whose Pi process died, restored by a fresh process (todo 043). The crashed process is
 * real (a forked child, SIGKILLed), so the Coordinator's state file still holds its workers as a
 * crash leaves them; nothing in either file is edited by hand. The runtime is the in-process fake.
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acpCoordinator, configureAcpCoordinator, shutdownAcpCoordinator } from "../src/acp/instance.ts";
import { AcpBackend, DelegateError } from "../src/acp-backend.ts";
import { fakeRuntime } from "./acp-fake-runtime.ts";

const crashOwner = new URL("./acp-crash-owner.ts", import.meta.url);

/** A crashed process's runs, and a fresh process's backend over the same records and state. */
async function afterCrash(t: { after(fn: () => unknown): void }) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-delegate-acp-crash-")));
	const stateDir = join(root, "acp-state"), runDir = join(root, "runs"), cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	const ownerKey = `owner-${root}`;
	const child = fork(crashOwner, [stateDir, runDir, cwd, ownerKey], { execArgv: ["--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"] });
	const ids = await new Promise<{ busy: string; idle: string }>((resolve, reject) => {
		child.once("message", (message) => resolve(message as { busy: string; idle: string }));
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`crash owner exited ${code}`)));
	});
	child.kill("SIGKILL");
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	// The dead process's lease goes stale as it would after 30 s.
	const stale = new Date(Date.now() - 60_000);
	utimesSync(`${stateDir}.lock`, stale, stale);

	const fake = fakeRuntime();
	configureAcpCoordinator({ stateDir, profiles: {}, runtimeFactory: fake.factory });
	const backend = new AcpBackend({ ownerKey: () => ownerKey, changed() {}, settled() {}, runDir: () => runDir });
	backend.restore(ownerKey);
	t.after(async () => {
		await backend.closeOwner(ownerKey);
		await shutdownAcpCoordinator();
		configureAcpCoordinator({});
		rmSync(root, { recursive: true, force: true });
	});
	const workers = async () => {
		const listed = await (await acpCoordinator()).execute({ action: "list" });
		assert.ok(listed.ok);
		return (listed.details.workers as { name: string }[]).map((worker) => worker.name);
	};
	return { ids, fake, backend, ownerKey, runDir, workers };
}

const codeOf = async (work: Promise<unknown>) => work.then(() => undefined, (error) => error instanceof DelegateError ? error.code : String(error));

test("after a crash, steer reopens a run whose worker the Coordinator still holds", async (t) => {
	const { ids, backend } = await afterCrash(t);
	const [busy, idle] = await backend.status([ids.busy, ids.idle]);
	assert.equal(busy!.status, "error", "the turn running at the crash is lost");
	assert.ok(busy!.parked && idle!.parked);

	assert.equal(await codeOf(backend.steer(ids.busy, { message: "again" })), undefined, "the crashed worker is released, then the session resumed");
	assert.equal(await codeOf(backend.steer(ids.idle, { message: "again" })), undefined, "the reconnected idle worker is the session itself");
	const done = await backend.wait({ runIds: [ids.busy, ids.idle], mode: "all" });
	assert.deepEqual(done.settled.map((v) => [v.status, v.turns.length, v.parked]), [["complete", 2, undefined], ["complete", 2, undefined]]);
});

test("after a crash, close releases the worker the Coordinator still holds", async (t) => {
	const { ids, backend, workers } = await afterCrash(t);
	for (const id of [ids.busy, ids.idle]) {
		const closed = await backend.close(id, {});
		assert.equal(closed.closed, true);
	}
	assert.deepEqual(await workers(), [], "no closed run's session is left for the next ACP use to reconnect");
});

test("a run parked while its turn could not be released is restored as lost, not running", async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-delegate-acp-park-")));
	const runDir = join(root, "runs"), cwd = join(root, "project"), ownerKey = `owner-${root}`;
	mkdirSync(cwd, { recursive: true });
	const fake = fakeRuntime();
	configureAcpCoordinator({ stateDir: join(root, "acp-state"), profiles: {}, runtimeFactory: fake.factory });
	const backend = new AcpBackend({ ownerKey: () => ownerKey, changed() {}, settled() {}, runDir: () => runDir });
	t.after(async () => {
		await backend.closeOwner(ownerKey);
		await shutdownAcpCoordinator();
		configureAcpCoordinator({});
		rmSync(root, { recursive: true, force: true });
	});
	const run = await backend.start({ backend: "acp", origin: "created", agent: "fake", task: "WAIT", cwd });
	assert.equal(run.status, "running");
	// The Coordinator goes away before this parent parks its run, so the release cannot happen here.
	await shutdownAcpCoordinator();
	await backend.closeOwner(ownerKey);
	const saved = JSON.parse(readFileSync(join(runDir, `${encodeURIComponent(run.id)}.json`), "utf8"));
	assert.equal(typeof saved.parkedAt, "number");

	backend.restore(ownerKey);
	const [restored] = await backend.status([run.id]);
	assert.notEqual(restored!.status, "running", "no process holds the turn of a restored run");
	assert.equal(restored!.turns[0]!.failure?.code, "PARENT_PROCESS_LOST");
	assert.equal(restored!.parked?.interruptedTurn, restored!.turns[0]!.requestId);
	assert.equal(await codeOf(backend.steer(run.id, { message: "again" })), undefined, "steer releases the worker left behind and resumes the session");
	assert.equal((await backend.wait({ runIds: [run.id], mode: "all" })).settled[0]!.status, "complete");
});
