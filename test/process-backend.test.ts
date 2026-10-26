import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { ProcessBackend, type ProcessRunView } from "../src/process-backend.ts";
import { processOwner, RunStore } from "../src/storage.ts";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const node = (source: string) => `${JSON.stringify(process.execPath)} -e '${source.replaceAll("'", "'\\''")}'`;
function fixture(t: { after(fn: () => Promise<void>): void }) {
	const dir = mkdtempSync(join(tmpdir(), "delegate-process-"));
	const notices: ProcessRunView[] = [];
	const hooks = { ownerKey: () => dir, runDir: () => dir, changed() {}, settled: (v: ProcessRunView) => { notices.push(v); } };
	const backend = new ProcessBackend(hooks);
	t.after(async () => { await backend.closeOwner(dir); rmSync(dir, { recursive: true, force: true }); });
	const start = (command: string, extra = {}) => backend.start({ backend: "process", command, ...extra });
	const done = async (id: string) => (await backend.wait({ runIds: [id], mode: "all", timeoutMs: 5000 })).settled[0]!;
	return { dir, notices, hooks, backend, start, done };
}
function alive(pid: number): boolean {
	try { return !execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z"); }
	catch { return false; }
}

test("process start is immediate, reads are nonblocking, wait deadline detaches; output is merged and private", async (t) => {
	const f = fixture(t);
	const run = await f.start("printf early; printf err >&2; sleep 1; printf late");
	assert.match(run.id, /^process-/); assert.equal(run.status, "running"); assert.ok(run.pid);
	assert.equal((await f.backend.result(run.id)).status, "running");
	assert.equal((await f.backend.status([run.id]))[0]!.status, "running");
	assert.equal((await f.backend.wait({ runIds: [run.id], mode: "all", timeoutMs: 10 })).reason, "timeout");
	assert.equal((await f.backend.result(run.id)).status, "running");
	const end = await f.done(run.id);
	assert.equal(end.status, "done"); assert.equal(end.exitCode, 0); assert.equal(end.signal, null);
	assert.equal(end.output, "earlyerrlate"); assert.equal(end.truncated, false);
	assert.equal(readFileSync(end.outputFile, "utf8"), "earlyerrlate");
	assert.equal(statSync(end.outputFile).mode & 0o777, 0o600); assert.equal(f.notices.length, 0);
});

test("nonzero exit, launch failure and explicit execution deadline remain distinct", async (t) => {
	const f = fixture(t);
	const failed = await f.done((await f.start("exit 7")).id);
	assert.equal(failed.status, "error"); assert.equal(failed.exitCode, 7);
	const launch = await f.done((await f.start("printf unreachable", { cwd: join(f.dir, "missing") })).id);
	assert.equal(launch.status, "error"); assert.match(launch.error!, /PROCESS_LAUNCH_FAILED/);
	const deadline = await f.done((await f.start("sleep 30", { timeoutMs: 50 })).id);
	assert.equal(deadline.status, "timed_out"); assert.equal(deadline.exitCode, null); assert.equal(deadline.signal, "SIGTERM");
});

test("full output is retained while returned tail is bounded at 64KiB", async (t) => {
	const f = fixture(t);
	const end = await f.done((await f.start(node('process.stdout.write("x".repeat(200000));process.stderr.write("END")'))).id);
	assert.equal(end.status, "done"); assert.equal(end.truncated, true);
	assert.equal(Buffer.byteLength(end.output), 65536); assert.ok(end.output.endsWith("END"));
	assert.equal(readFileSync(end.outputFile).length, 200003);
});

test("wait abort leaves work alive and unjoined completion notifies exactly once", async (t) => {
	const f = fixture(t), run = await f.start("sleep 0.3; printf finished");
	const ac = new AbortController();
	const waiting = f.backend.wait({ runIds: [run.id], mode: "all" }, ac.signal); ac.abort();
	await assert.rejects(waiting, { name: "AbortError" });
	assert.equal((await f.backend.result(run.id)).status, "running");
	await pause(500);
	assert.equal(f.notices.length, 1); assert.equal(f.notices[0]!.status, "done");
	await f.done(run.id); await pause(30); assert.equal(f.notices.length, 1);
});

test("joined completion suppresses notification; aborted hold redelivers a settlement", async (t) => {
	const f = fixture(t), run = await f.start("sleep 0.1");
	const hold = f.backend.join([run.id]);
	await pause(300); assert.equal(f.notices.length, 0);
	hold.release(true); hold.release(true); assert.equal(f.notices.length, 1);
	const next = await f.start("sleep 0.1");
	await f.done(next.id); assert.equal(f.notices.length, 1);
});

test("cancellation kills owned parent and separate-group child without touching control", async (t) => {
	const f = fixture(t);
	const control = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	t.after(async () => { control.kill("SIGKILL"); });
	const worker = JSON.stringify('process.on("SIGTERM",()=>{});setInterval(()=>{},1000)');
	const run = await f.start(node(`const{spawn}=require("node:child_process"); const c=spawn(process.execPath,["-e",${worker}],{detached:true,stdio:"ignore"});console.log(c.pid);setInterval(()=>{},1000)`));
	await pause(300);
	const childPid = Number((await f.backend.result(run.id)).output.trim());
	assert.ok(childPid > 0); assert.equal(alive(childPid), true);
	t.after(async () => { if (alive(childPid)) process.kill(childPid, "SIGKILL"); });
	const cancelled = await f.backend.cancel(run.id);
	assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.signal, "SIGTERM");
	assert.equal(alive(run.pid!), false); assert.equal(alive(childPid), false); assert.equal(alive(control.pid!), true);
	assert.equal(f.notices.length, 0);
	assert.equal((await f.backend.cancel(run.id)).status, "cancelled");
});

for (const action of ["cancel", "closeOwner"] as const) {
	test(`root exit retains verified workers for ${action} without another completion`, async (t) => {
		const f = fixture(t);
		const control = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
		t.after(async () => { control.kill("SIGKILL"); });
		const run = await f.start("sleep 30 & echo $!; sleep 0.8");
		await pause(300);
		const childPid = Number((await f.backend.result(run.id)).output.trim());
		assert.ok(childPid > 0);
		t.after(async () => { if (alive(childPid)) process.kill(childPid, "SIGKILL"); });
		const owned = f.backend.find(run.id, f.dir)!;
		assert.equal(owned.tree.has(childPid), true);
		await owned.closed;
		const before = await f.backend.result(run.id);
		assert.equal(before.status, "done"); assert.equal(before.exitCode, 0); assert.equal(before.signal, null);
		assert.equal(alive(childPid), true); assert.equal(f.notices.length, 1);
		const after = action === "cancel" ? await f.backend.cancel(run.id) : (await f.backend.closeOwner(f.dir)).find(v => v.id === run.id)!;
		assert.equal(alive(childPid), false); assert.equal(alive(control.pid!), true);
		assert.equal(after.status, "done"); assert.equal(after.exitCode, 0); assert.equal(after.signal, null);
		assert.equal(after.endedAt, before.endedAt); assert.equal(f.notices.length, 1);
		assert.equal((await f.done(run.id)).status, "done");
		assert.equal(f.notices.length, 1);
	});
}

test("failed post-exit cleanup retains ownership until verified workers are stopped", async (t) => {
	const f = fixture(t), run = await f.start("sleep 30 & echo $!; sleep 0.8");
	await pause(300);
	const childPid = Number((await f.backend.result(run.id)).output.trim());
	assert.ok(childPid > 0);
	t.after(async () => { if (alive(childPid)) process.kill(childPid, "SIGKILL"); });
	await f.backend.find(run.id, f.dir)!.closed;
	assert.equal(alive(childPid), true);
	const path = process.env.PATH;
	try {
		process.env.PATH = f.dir;
		const end = (await f.backend.closeOwner(f.dir))[0]!;
		assert.equal(end.status, "error"); assert.match(end.error!, /PROCESS_CLEANUP_FAILED/);
		assert.equal(end.exitCode, 0); assert.equal(end.signal, null);
	} finally { process.env.PATH = path; }
	assert.equal(alive(childPid), true);
	const record = RunStore.recordPath(f.dir, run.id);
	assert.equal(JSON.parse(readFileSync(record, "utf8")).ownerToken, processOwner().ownerToken);
	await f.backend.closeOwner(f.dir);
	assert.equal(alive(childPid), false);
	assert.equal(JSON.parse(readFileSync(record, "utf8")).ownerToken, undefined);
	assert.equal(f.notices.length, 1);
});

test("cleanup failure retains a live root handle for a later explicit shutdown", async (t) => {
	const f = fixture(t), run = await f.start(`exec ${node("setInterval(()=>{},1000)")}`);
	const path = process.env.PATH;
	try {
		process.env.PATH = f.dir;
		assert.equal((await f.backend.closeOwner(f.dir))[0]!.status, "error");
	} finally { process.env.PATH = path; }
	assert.equal(alive(run.pid!), true);
	const record = RunStore.recordPath(f.dir, run.id);
	assert.equal(JSON.parse(readFileSync(record, "utf8")).ownerToken, processOwner().ownerToken);
	const end = (await f.backend.closeOwner(f.dir))[0]!;
	assert.equal(alive(run.pid!), false); assert.equal(end.exitCode, null); assert.equal(end.signal, "SIGTERM");
	assert.equal(JSON.parse(readFileSync(record, "utf8")).ownerToken, undefined);
	assert.equal(f.notices.length, 0);
});

test("unverifiable cleanup reports failure instead of cancelled-and-clean", async (t) => {
	const f = fixture(t), run = await f.start(`exec ${node("setInterval(()=>{},1000)")}`);
	const handle = f.backend.find(run.id, f.dir)!.child!;
	const path = process.env.PATH;
	try {
		process.env.PATH = f.dir;
		const end = await f.backend.cancel(run.id);
		assert.equal(end.status, "error"); assert.match(end.error!, /PROCESS_CLEANUP_FAILED/);
	} finally {
		process.env.PATH = path;
		handle.kill("SIGKILL");
		await new Promise((resolve) => handle.once("close", resolve));
	}
});

test("owner shutdown interrupts; rebinding retains actual process and uses new hooks", async (t) => {
	const f = fixture(t), run = await f.start("sleep 30");
	let notifications = 0;
	const reload = new ProcessBackend({ ...f.hooks, settled() { notifications++; } });
	reload.restore(f.dir);
	assert.equal((await reload.result(run.id)).pid, run.pid);
	const views = await reload.closeOwner(f.dir);
	assert.equal(views[0]!.status, "interrupted"); assert.equal(views[0]!.signal, "SIGTERM");
	assert.equal(alive(run.pid!), false); assert.equal(notifications, 0);
	assert.equal((await reload.closeOwner(f.dir))[0]!.status, "interrupted");
});

test("restore never adopts recorded command PID or replays command; live foreign owner is read-only", async (t) => {
	const f = fixture(t), me = processOwner();
	const record = (id: string, owner: object) => {
		writeFileSync(RunStore.recordPath(f.dir, id), JSON.stringify({ version: 1, backend: "process", savedAt: 10, id, ownerKey: f.dir, ...owner,
			command: `touch ${join(f.dir, "replayed")}`, cwd: f.dir, status: "running", pid: process.pid, startedAt: 1, output: "", outputFile: join(f.dir, "output"), truncated: false }));
	};
	record("process-lost", { ownerPid: process.pid, ownerHost: hostname(), ownerToken: "old-token" });
	record("process-foreign", { ownerPid: process.ppid, ownerHost: me.ownerHost, ownerToken: "another-token" });
	const before = readFileSync(RunStore.recordPath(f.dir, "process-foreign"), "utf8");
	f.backend.restore(f.dir);
	const lost = await f.backend.result("process-lost");
	assert.equal(lost.status, "interrupted"); assert.match(lost.error!, /PARENT_PROCESS_LOST/);
	assert.equal((await f.done(lost.id)).status, "interrupted");
	assert.equal((await f.backend.result("process-foreign")).foreign?.ownerPid, process.ppid);
	await assert.rejects(f.backend.cancel("process-foreign"), { code: "RUN_OWNED_ELSEWHERE" });
	assert.equal((await f.backend.wait({runIds:["process-foreign"],mode:"all"})).reason, "lost");
	assert.equal(readFileSync(RunStore.recordPath(f.dir, "process-foreign"), "utf8"), before);
	assert.throws(() => statSync(join(f.dir, "replayed")), { code: "ENOENT" });
});

test("failed admission persistence starts nothing and input guards reject invalid deadlines", async (t) => {
	const f = fixture(t);
	writeFileSync(join(f.dir, "file"), "not a directory");
	const backend = new ProcessBackend({ ...f.hooks, runDir: () => join(f.dir, "file") });
	await assert.rejects(backend.start({ backend: "process", command: `touch ${join(f.dir, "started")}` }), { code: "RUN_NOT_PERSISTED" });
	assert.throws(() => statSync(join(f.dir, "started")), { code: "ENOENT" });
	for (const timeoutMs of [0, -1, Infinity, 1.5]) await assert.rejects(f.start("true", { timeoutMs }), { code: "INPUT_INVALID" });
	const caps = f.backend.capabilities();
	assert.equal(caps.open.supported, false); assert.equal(caps.steer.supported, false); assert.equal(caps.close.supported, false);
});
