/**
 * Amp extras at the edges (todo 058 review): a park while a label call is in flight, two turns
 * settling around one label call, model beside a created thread's mode, a stalled status at turn
 * settlement, a failed cost read after a good one, and when a cost is read at all. AcpBackend and
 * the Coordinator are real; the ACP runtime is the in-process fake with Amp's mode option, and the
 * Amp CLI is a small script whose label and usage calls the test holds or fails. One test uses the
 * vendored Amp adapter with the fake Amp CLI.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { acpCoordinator, configureAcpCoordinator, shutdownAcpCoordinator } from "../src/acp/instance.ts";
import { AcpBackend, DelegateError, acpSummary } from "../src/acp-backend.ts";
import { Coordinator } from "../src/acp/orchestration/coordinator.ts";
import { AcpxRuntimePort } from "../src/acp/runtime/acpx-runtime.ts";
import type { NativeSessionDescription, Profile, RuntimeHandle, RuntimePort, RuntimeStatus } from "../src/acp/domain/types.ts";
import type { AcpRunView } from "../src/backend.ts";
import { fakeRuntime } from "./acp-fake-runtime.ts";

const THREAD = "T-00000000-0000-0000-0000-0000000000a1";
const AMP_MODES = ["low", "medium", "high", "ultra"];

/** An Amp CLI for these tests. `hold-label`/`hold-usage`: those calls wait for `release-label`/`release-usage`. `usage-fail`: usage exits 1. `cost`: the Cost line. */
const AMP_SCRIPT = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.AMP_RACE_DIR;
const args = process.argv.slice(2);
const log = (entry) => appendFileSync(join(dir, "log.ndjson"), JSON.stringify(entry) + "\\n");
log({ args, phase: "start" });
const has = (name) => existsSync(join(dir, name));
if (args[0] === "threads" && args[1] === "label") {
  const end = Date.now() + 20000;
  while (has("hold-label") && !has("release-label") && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  log({ args, phase: "done" });
  process.exit(0);
}
if (args[0] === "threads" && args[1] === "usage") {
  const end = Date.now() + 20000;
  while (has("hold-usage") && !has("release-usage") && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  log({ args, phase: "done" });
  if (has("usage-fail")) { process.stderr.write("fake usage refused"); process.exit(1); }
  process.stdout.write("Cost: $" + (has("cost") ? readFileSync(join(dir, "cost"), "utf8").trim() : "0") + "\\n");
  process.exit(0);
}
process.exit(2);
`;

/** The in-process fake runtime with Amp's shape: the model option is amp-mode, and status reports the thread's T-ID. */
function ampRuntime(native: () => NativeSessionDescription | undefined, getStatus?: () => Promise<RuntimeStatus>) {
	const fake = fakeRuntime();
	const modes = new Map<string, string>();
	const factory = (cwd: string, stateDir: string, profile: Profile): RuntimePort => {
		const port = fake.factory(cwd, stateDir, profile);
		return {
			...port,
			async ensureSession(input: { name: string; cwd: string; profile: Profile; mode?: string; resumeSessionId?: string }) {
				const handle = await port.ensureSession(input as never);
				const mode = input.mode ?? input.profile.model;
				if (mode) modes.set(handle.runtimeSessionName, mode);
				return handle;
			},
			getStatus: getStatus ?? (async (handle: RuntimeHandle) => {
				const current = modes.get(handle.runtimeSessionName);
				const id = native();
				return { modelDiscoverySupported: true, modelConfigId: "amp-mode", availableModelIds: AMP_MODES, ...(current ? { currentModelId: current } : {}), ...(id ? { native: id } : {}) };
			}),
			async setConfigOption(input: { handle: RuntimeHandle; key: string; value: string }) {
				if (input.key === "amp-mode") modes.set(input.handle.runtimeSessionName, input.value);
			},
		};
	};
	return { calls: fake.calls, modes, factory };
}

function nativeThread(cwd: string): NativeSessionDescription {
	return { id: THREAD, scope: "amp://account/test", cwd, executionEnvironment: "local", attachment: "stored-session", disconnectEffect: "stops-local-executor", concurrentNativeClients: "unknown", activity: "idle" };
}

/** A backend over a fresh Coordinator, the fake Amp runtime and the scripted Amp CLI. */
function setup(t: { after(fn: () => unknown): void }, options: { getStatus?: () => Promise<RuntimeStatus> } = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-delegate-amp-races-")));
	const runDir = join(root, "runs"), cwd = join(root, "project"), ampDir = join(root, "amp");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(ampDir, { recursive: true });
	const script = join(root, "amp.mjs");
	writeFileSync(script, AMP_SCRIPT);
	chmodSync(script, 0o755);
	const saved = { path: process.env.AMP_CLI_PATH, dir: process.env.AMP_RACE_DIR };
	process.env.AMP_CLI_PATH = script;
	process.env.AMP_RACE_DIR = ampDir;
	const ownerKey = `owner-${root}`;
	const runtime = ampRuntime(() => nativeThread(cwd), options.getStatus);
	configureAcpCoordinator({ stateDir: join(root, "acp-state"), profiles: {}, runtimeFactory: runtime.factory });
	const hooks = { changed: 0, settled: [] as { id: string; ownerKey: string; view: AcpRunView }[] };
	const backend = new AcpBackend({ ownerKey: () => ownerKey, changed() { hooks.changed += 1; }, settled(v, key) { hooks.settled.push({ id: v.id, ownerKey: key, view: v }); }, runDir: () => runDir });
	t.after(async () => {
		await backend.closeOwner(ownerKey);
		await shutdownAcpCoordinator();
		configureAcpCoordinator({});
		for (const [key, value] of [["AMP_CLI_PATH", saved.path], ["AMP_RACE_DIR", saved.dir]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(root, { recursive: true, force: true });
	});
	const amp = (): { args: string[]; phase: string }[] => existsSync(join(ampDir, "log.ndjson")) ? readFileSync(join(ampDir, "log.ndjson"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
	const calls = (name: string, phase = "start") => amp().filter((entry) => entry.args[1] === name && entry.phase === phase);
	const flag = (name: string, on = true) => { const path = join(ampDir, name); if (on) writeFileSync(path, ""); else rmSync(path, { force: true }); };
	const recordPath = (id: string) => join(runDir, `${encodeURIComponent(id)}.json`);
	const until = async (check: () => boolean, what: string, ms = 10_000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) assert.fail(`timed out: ${what}`); await sleep(10); } };
	const start = (extra: Record<string, unknown> = {}) => backend.start({ backend: "acp", origin: "created", agent: "amp", task: "Race check\n…", cwd, executionEnvironment: "local", ...extra } as never) as Promise<AcpRunView>;
	return { root, cwd, ampDir, ownerKey, backend, hooks, runtime, amp, calls, flag, recordPath, until, start, write: (name: string, text: string) => writeFileSync(join(ampDir, name), text) };
}

const codeOf = async (work: Promise<unknown>) => work.then(() => undefined, (error) => error instanceof DelegateError ? error.code : String(error));

test("a run parked while its label and cost calls are in flight is not rewritten, and wakes no one", async (t) => {
	const s = setup(t);
	s.flag("hold-label");
	s.flag("hold-usage");
	const run = await s.start();
	await s.until(() => s.calls("label").length === 1 && s.calls("usage").length === 1, "the label and cost calls started");
	await s.backend.closeOwner(s.ownerKey);
	const parked = readFileSync(s.recordPath(run.id), "utf8");
	assert.equal(typeof JSON.parse(parked).parkedAt, "number");
	s.flag("release-usage");
	await s.until(() => s.calls("usage", "done").length === 1, "the cost call ended");
	s.flag("release-label");
	await s.until(() => s.calls("label", "done").length === 1, "the label call ended");
	await sleep(200);
	assert.equal(readFileSync(s.recordPath(run.id), "utf8"), parked, "the parked record is the one the park wrote");
	assert.deepEqual(s.hooks.settled, [], "a parked run's turn wakes no parent");
});

test("two turns settling around one label call label the thread once", async (t) => {
	const s = setup(t);
	s.flag("hold-label");
	const run = await s.start();
	await s.until(() => s.calls("label").length === 1, "the first label call started");
	await s.backend.steer(run.id, { message: "again" });
	await s.backend.wait({ runIds: [run.id], mode: "all" });
	// The second turn's watcher reaches labeling as its turn settles; give it time to start a second call.
	await sleep(500);
	s.flag("release-label");
	await s.until(() => s.calls("label", "done").length >= 1, "the label call ended");
	await s.until(() => JSON.parse(readFileSync(s.recordPath(run.id), "utf8")).labeled !== undefined, "labeling recorded");
	await sleep(200);
	assert.equal(s.calls("label").length, 1, "one label call for the run");
	const [v] = await s.backend.status([run.id]);
	assert.equal(v!.notes, undefined);
	assert.equal(v!.session.labels?.length, 2);
});

test("steer refuses model on a created Amp run that has a mode, as creation does", async (t) => {
	const s = setup(t);
	const run = await s.start({ mode: "high" });
	await s.backend.wait({ runIds: [run.id], mode: "all" });
	const turns = (await s.backend.status([run.id]))[0]!.turns.length;
	assert.equal(await codeOf(s.backend.steer(run.id, { message: "again", model: "low" })), "INPUT_INVALID");
	const [v] = await s.backend.status([run.id]);
	assert.equal(v!.turns.length, turns, "no turn was sent");
	assert.equal(s.runtime.modes.get(v!.session.worker), "high", "the thread keeps its mode");
	assert.equal(v!.mode, "high");
	assert.equal(v!.model, undefined);
	// The Coordinator keeps the same rule for its own callers.
	const sent = await (await acpCoordinator()).execute({ action: "send", name: v!.session.worker, prompt: "again", model: "low" });
	assert.equal(sent.ok ? "ok" : sent.error.code, "INPUT_INVALID");
	assert.equal(s.runtime.modes.get(v!.session.worker), "high");
	// A created Amp run without a mode still selects its mode by model.
	const plain = await s.start();
	await s.backend.wait({ runIds: [plain.id], mode: "all" });
	assert.equal(await codeOf(s.backend.steer(plain.id, { message: "again", model: "low" })), undefined);
});

test("a stalled status call at turn settlement is bounded: the turn settles", async (t) => {
	const stateDir = mkdtempSync(join(tmpdir(), "pi-delegate-amp-stall-"));
	const fake = fakeRuntime();
	const profile: Profile = { agent: "amp", role: "read-only", tools: ["read"], timeoutMs: 60_000, cancellationGraceMs: 200, maxOutputBytes: 64_000 };
	const coordinator = new Coordinator(process.cwd(), {
		stateDir, profiles: { "amp-quick": profile },
		runtimeFactory: (cwd, dir, p) => ({ ...fake.factory(cwd, dir, p), getStatus: () => new Promise<RuntimeStatus>(() => undefined) }),
	});
	t.after(async () => { await coordinator.shutdown(); rmSync(stateDir, { recursive: true, force: true }); });
	assert.ok((await coordinator.execute({ action: "spawn", name: "stall", profile: "amp-quick" })).ok);
	const sent = await coordinator.execute({ action: "send", name: "stall", prompt: "hello" });
	assert.ok(sent.ok);
	const waited = await coordinator.execute({ action: "wait", requestId: sent.details.requestId, waitTimeoutMs: 3_000 });
	assert.ok(waited.ok);
	assert.equal(waited.details.timedOut, false, "the turn settled though the status call never returned");
	const listed = await coordinator.execute({ action: "list", names: ["stall"] });
	assert.ok(listed.ok);
	assert.equal((listed.details.requests as { status: string }[])[0]!.status, "completed");
});

test("a failed cost read keeps the last known cost, marked with when it was read", async (t) => {
	const s = setup(t);
	s.write("cost", "2.12");
	const run = await s.start();
	await s.backend.wait({ runIds: [run.id], mode: "all" });
	await s.backend.refreshUsage(run.id);
	const good = (await s.backend.status([run.id]))[0]!.usage!;
	assert.deepEqual(good.cost, { amount: 2.12, currency: "USD" });
	// The next turn's cost read fails, and so does the status read after it.
	s.flag("usage-fail");
	await s.backend.steer(run.id, { message: "again" });
	await s.backend.wait({ runIds: [run.id], mode: "all" });
	await s.backend.refreshUsage(run.id);
	const [v] = await s.backend.status([run.id]);
	assert.deepEqual(v!.usage!.cost, { amount: 2.12, currency: "USD" }, "a failed read does not wipe a known cost");
	assert.equal(v!.usage!.at, good.at, "at is when that cost was read");
	assert.match(v!.usage!.error ?? "", /amp threads usage T-\S+ exited 1: fake usage refused/);
	assert.match(acpSummary(v!), new RegExp(`\\$2\\.12 \\(Amp thread, last read at ${new Date(good.at).toISOString().replace(/[.]/g, "\\.")}; the latest read failed\\)`));
	// A failed read is not a current cost: the next status reads again, and a good read is current.
	s.flag("usage-fail", false);
	s.write("cost", "3.00");
	await s.backend.refreshUsage(run.id);
	const [fresh] = await s.backend.status([run.id]);
	assert.deepEqual(fresh!.usage!.cost, { amount: 3, currency: "USD" });
	assert.equal(fresh!.usage!.error, undefined);
	assert.match(acpSummary(fresh!), / · \$3\.00 \(Amp thread\)$/m);
});

test("a cost read is skipped while the cached cost is newer than the last turn, and once the run is closed", async (t) => {
	const s = setup(t);
	s.write("cost", "1.00");
	const run = await s.start();
	await s.backend.wait({ runIds: [run.id], mode: "all" });
	const reads = s.calls("usage").length;
	await s.backend.refreshUsage(run.id);
	await s.backend.refreshUsage(run.id);
	assert.equal(s.calls("usage").length, reads, "no turn since the last read: the cache stands");
	s.write("cost", "1.50");
	await s.backend.steer(run.id, { message: "again" });
	await s.backend.wait({ runIds: [run.id], mode: "all" });
	assert.equal(s.calls("usage").length, reads + 1, "the new turn's cost is read once");
	await s.backend.refreshUsage(run.id);
	assert.equal(s.calls("usage").length, reads + 1);
	assert.equal((await s.backend.status([run.id]))[0]!.usage!.cost!.amount, 1.5);
	await s.backend.close(run.id, {});
	await s.backend.refreshUsage(run.id);
	assert.equal(s.calls("usage").length, reads + 1, "a closed run's cached cost is final");

	// A closed run whose last read failed is read again, then stands.
	s.flag("usage-fail");
	const other = await s.start();
	await s.backend.wait({ runIds: [other.id], mode: "all" });
	await s.backend.close(other.id, {});
	s.flag("usage-fail", false);
	const before = s.calls("usage").length;
	await s.backend.refreshUsage(other.id);
	assert.equal(s.calls("usage").length, before + 1);
	assert.equal((await s.backend.status([other.id]))[0]!.usage!.cost!.amount, 1.5);
	await s.backend.refreshUsage(other.id);
	assert.equal(s.calls("usage").length, before + 1);
});

test("a settled turn's thread cost reaches its wait result and its wake-up", async (t) => {
	const s = setup(t);
	s.write("cost", "2.12");
	const run = await s.start();
	const waited = await s.backend.wait({ runIds: [run.id], mode: "all" });
	assert.deepEqual(waited.settled[0]!.usage?.cost, { amount: 2.12, currency: "USD" }, "the wait reports the turn's cost");
	assert.match(acpSummary(waited.settled[0]!), / · \$2\.12 \(Amp thread\)/);
	s.write("cost", "3.40");
	await s.backend.steer(run.id, { message: "again" });
	await s.until(() => s.hooks.settled.length === 1, "the wake-up");
	assert.deepEqual(s.hooks.settled[0]!.view.usage?.cost, { amount: 3.4, currency: "USD" }, "the wake-up reports the new turn's cost");
	assert.equal(s.calls("usage").length, 2, "one read per settled turn");
});

test("a profile's Amp model gives way to a caller's mode: creation succeeds and the thread runs in that mode", { timeout: 60_000 }, async (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-delegate-amp-profile-")));
	const fakeAmp = new URL("./acp/fixtures/fake-amp.mjs", import.meta.url).pathname;
	chmodSync(fakeAmp, 0o755);
	const keys = ["AMP_CLI_PATH", "AMP_ACP_STATE_DIR", "AMP_FAKE_ARGS_LOG"] as const;
	const saved = new Map(keys.map((key) => [key, process.env[key]]));
	const argsLog = join(root, "amp-args.ndjson");
	process.env.AMP_CLI_PATH = fakeAmp;
	process.env.AMP_ACP_STATE_DIR = join(root, "amp-state");
	process.env.AMP_FAKE_ARGS_LOG = argsLog;
	const profile: Profile = { agent: "amp", role: "read-only", tools: ["read", "grep", "find", "ls"], model: "low", timeoutMs: 60_000, cancellationGraceMs: 5_000, maxOutputBytes: 64_000 };
	const coordinator = new Coordinator(root, {
		stateDir: join(root, "acp-state"), profiles: { "amp-low": profile },
		runtimeFactory: (cwd, stateDir, p, origin) => new AcpxRuntimePort(cwd, stateDir, p, origin),
	});
	t.after(async () => {
		await coordinator.shutdown();
		for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(root, { recursive: true, force: true });
	});
	const spawned = await coordinator.execute({ action: "spawn", name: "moded", profile: "amp-low", executionEnvironment: "local", mode: "ultra" });
	if (!spawned.ok) assert.fail(`${spawned.error.code}: ${spawned.error.message}`);
	assert.equal((spawned.details as { mode?: string }).mode, "ultra");
	assert.equal((spawned.details as { model?: string }).model, undefined, "the mode decides; no model is recorded beside it");
	const sent = await coordinator.execute({ action: "send", name: "moded", prompt: "hello" });
	assert.equal(sent.ok ? "ok" : `${sent.error.code}: ${sent.error.message}`, "ok");
	const waited = await coordinator.execute({ action: "wait", requestId: sent.ok ? sent.details.requestId : "", waitTimeoutMs: 30_000 });
	assert.ok(waited.ok && !waited.details.timedOut);
	const executions = readFileSync(argsLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]).filter((args) => args.includes("--execute"));
	const last = executions.at(-1)!;
	assert.equal(last[last.indexOf("--mode") + 1], "ultra", "the thread runs in the caller's mode");
});
