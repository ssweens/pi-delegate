/**
 * One Coordinator per Pi process (ADR 0001). Each Pi here is a real child process
 * (test/acp-process-owner.ts) configured only by its agent dir, as Pi is, so each gets the state
 * dir it would get in use. Between processes, only the machine-wide claims and adoption from
 * another process's state dir connect them. The runtimes are the in-process fake and ACPX with the
 * fixture ACP agent and the fake Amp CLI. No credentials, no network.
 */
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { Coordinator } from "../src/acp/orchestration/coordinator.ts";
import { agentDir } from "../src/acp/persistence/home.ts";
import { fakeRuntime } from "./acp-fake-runtime.ts";

const driver = new URL("./acp-process-owner.ts", import.meta.url);
const fakeAmp = new URL("./acp/fixtures/fake-amp.mjs", import.meta.url).pathname;
const localThread = "T-00000000-0000-0000-0000-000000000001";

interface Reply { ok: boolean; value?: any; code?: string; message?: string }
interface Pi { pid: number; ask(op: string, args?: unknown): Promise<Reply>; call(op: string, args?: unknown): Promise<any>; kill(): Promise<void>; exit(): Promise<void> }

/** A sandbox several Pi processes share: one agent dir, one project, one parent session's run records. */
function machine(t: { after(fn: () => unknown): void }) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-delegate-acp-procs-")));
	const agent = join(root, "agent"), cwd = join(root, "project"), runDir = join(root, "runs"), fixtureState = join(root, "fixture-state.json");
	mkdirSync(cwd, { recursive: true });
	chmodSync(fakeAmp, 0o755);
	// PI_AGENT_DIR too, so a Coordinator that reads only it (before per-process state) stays in the sandbox.
	const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, AMP_CLI_PATH: fakeAmp, AMP_ACP_STATE_DIR: join(root, "amp-state") };
	const children: ChildProcess[] = [];
	t.after(() => {
		for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	});
	const pi = async (runtime: "fake" | "acpx" = "fake", ownerKey = "parent-1"): Promise<Pi> => {
		const child = fork(driver, [runDir, ownerKey, runtime, fixtureState], { cwd, env, execArgv: ["--import", import.meta.resolve("tsx")], stdio: ["ignore", "inherit", "inherit", "ipc"] });
		children.push(child);
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		await new Promise<void>((resolve, reject) => {
			child.once("message", () => resolve());
			child.once("error", reject);
			child.once("exit", (code) => reject(new Error(`Pi process exited ${code} before it was ready`)));
		});
		let next = 0;
		const pending = new Map<number, (reply: Reply) => void>();
		child.on("message", (message: Reply & { id?: number }) => { if (message.id !== undefined) { pending.get(message.id)?.(message); pending.delete(message.id); } });
		const ask = (op: string, args?: unknown) => new Promise<Reply>((resolve) => { const id = next++; pending.set(id, resolve); child.send({ id, op, args }); });
		return {
			pid: child.pid!,
			ask,
			call: async (op, args) => { const reply = await ask(op, args); if (!reply.ok) throw new Error(`${op}: ${reply.code}: ${reply.message}`); return reply.value; },
			kill: async () => { child.kill("SIGKILL"); await exited; },
			exit: async () => { await ask("exit"); await exited; },
		};
	};
	const record = (id: string) => JSON.parse(readFileSync(join(runDir, `${encodeURIComponent(id)}.json`), "utf8"));
	return { root, agent, home: join(agent, "pi-strings"), cwd, pi, record };
}

const created = (cwd: string, task: string, extra: Record<string, unknown> = {}) => ({ origin: "created", agent: "fake", task, cwd, ...extra });

test("two Pi processes run ACP work at the same time, each with its own state dir", { timeout: 60000 }, async (t) => {
	const m = machine(t);
	const [a, b] = await Promise.all([m.pi(), m.pi()]);
	const busy = await a.call("start", created(m.cwd, "WAIT"));
	assert.equal(busy.status, "running");
	const reply = await b.ask("start", created(m.cwd, "hello"));
	assert.ok(reply.ok, `the second process runs ACP while the first holds a turn: ${reply.code}: ${reply.message}`);
	const done = await b.call("wait", { ids: [reply.value.id] });
	assert.equal(done.settled[0].status, "complete");
	assert.equal(done.settled[0].output, "ACK");

	const [dirA, dirB] = await Promise.all([a.call("stateDir"), b.call("stateDir")]);
	assert.notEqual(dirA, dirB);
	for (const [dir, pid] of [[dirA, a.pid], [dirB, b.pid]] as const) assert.match(dir, new RegExp(`^${m.home}/proc/${pid}-[0-9a-f]+$`));
	assert.equal(m.record(busy.id).stateDir, dirA, "each run records the state dir that holds its worker");
	assert.equal(m.record(reply.value.id).stateDir, dirB);
	assert.deepEqual(readdirSync(join(m.home, "proc")).filter((name) => !name.endsWith(".lock")).sort(), [basename(dirA), basename(dirB)].sort());
	assert.equal(existsSync(join(m.home, "state.json")), false, "nothing uses the legacy single state dir");
});

test("two processes cannot both hold a writer in one cwd; the refusal names the holder's PID", { timeout: 60000 }, async (t) => {
	const m = machine(t);
	const [a, b] = await Promise.all([m.pi(), m.pi()]);
	const writer = await a.call("start", created(m.cwd, "WAIT", { role: "writer" }));
	const refused = await b.ask("start", created(m.cwd, "WAIT", { role: "writer" }));
	assert.equal(refused.code, "WRITER_CWD_OWNED", refused.message);
	assert.match(refused.message!, new RegExp(`held by Pi process ${a.pid} `));
	assert.ok((await b.ask("start", created(m.cwd, "hello"))).ok, "a read-only run in the same cwd is not a writer");

	await a.call("close", { id: writer.id, force: true });
	assert.ok((await b.ask("start", created(m.cwd, "WAIT", { role: "writer" }))).ok, "close releases the claim");
});

test("a claim whose holder died is reclaimed at once; parking releases one", { timeout: 60000 }, async (t) => {
	const m = machine(t);
	const a = await m.pi();
	await a.call("start", created(m.cwd, "WAIT", { role: "writer" }));
	await a.kill();
	const b = await m.pi();
	const taken = await b.ask("start", created(m.cwd, "WAIT", { role: "writer" }));
	assert.ok(taken.ok, `a dead process's writer claim does not block: ${taken.code}: ${taken.message}`);

	await b.call("park");
	const c = await m.pi("fake", "parent-2");
	assert.ok((await c.ask("start", created(m.cwd, "WAIT", { role: "writer" }))).ok, "a parked run holds no claim");
});

test("two processes cannot both open one native session; the refusal names the holder's PID", { timeout: 90000 }, async (t) => {
	const m = machine(t);
	const [a, b] = await Promise.all([m.pi("acpx"), m.pi("acpx")]);
	const opened = await a.call("start", { origin: "opened", agent: "amp", sessionId: localThread });
	const refused = await b.ask("start", { origin: "opened", agent: "amp", sessionId: localThread });
	assert.equal(refused.code, "SESSION_IN_USE", refused.message);
	assert.match(refused.message!, new RegExp(`held by Pi process ${a.pid} `));

	await a.call("close", { id: opened.id });
	assert.ok((await b.ask("start", { origin: "opened", agent: "amp", sessionId: localThread })).ok, "disconnect releases the binding");
});

test("park in one process, exit, and revive in another: created and opened runs", { timeout: 120000 }, async (t) => {
	const m = machine(t);
	const a = await m.pi("acpx");
	const made = await a.call("start", { origin: "created", agent: "fixture", task: "SET:nonce-a", cwd: m.cwd });
	const opened = await a.call("start", { origin: "opened", agent: "amp", sessionId: localThread });
	await a.call("wait", { ids: [made.id] });
	const dirA = await a.call("stateDir");
	await a.call("park");
	await a.exit();

	const b = await m.pi("acpx");
	await b.call("restore");
	const dirB = await b.call("stateDir");
	assert.notEqual(dirA, dirB);
	assert.equal(m.record(made.id).stateDir, dirA, "the record names the dir that held the worker");
	await b.call("steer", { id: made.id, message: "GET" });
	const got = (await b.call("wait", { ids: [made.id] })).settled[0];
	assert.equal(got.output, "NONCE:nonce-a", "the same ACP session, resumed from the other process's provenance");
	assert.equal(m.record(made.id).stateDir, dirB, "now held here");

	await b.call("steer", { id: opened.id, message: "hello" });
	const said = (await b.call("wait", { ids: [opened.id] })).settled[0];
	assert.equal(said.output, "AMP_LOCAL_OK");
	assert.equal(said.session.nativeSessionId, localThread);
});

test("a process that crashed holding a created run: another adopts it from the dead dir and resumes it", { timeout: 120000 }, async (t) => {
	const m = machine(t);
	const a = await m.pi("acpx");
	const made = await a.call("start", { origin: "created", agent: "fixture", task: "SET:nonce-crash", cwd: m.cwd });
	await a.call("wait", { ids: [made.id] });
	await a.kill();

	const b = await m.pi("acpx");
	await b.call("restore");
	await b.call("steer", { id: made.id, message: "GET" });
	assert.equal((await b.call("wait", { ids: [made.id] })).settled[0].output, "NONCE:nonce-crash");
});

test("adoption is refused while the other process still holds the worker, with its PID; allowed once it is gone", { timeout: 60000 }, async (t) => {
	const m = machine(t);
	const a = await m.pi();
	const run = await a.call("start", created(m.cwd, "hello"));
	await a.call("wait", { ids: [run.id] });
	const dirA = await a.call("stateDir");
	const fake = fakeRuntime();
	const here = new Coordinator(m.cwd, { home: m.home, stateDir: join(m.root, "here"), profiles: {}, runtimeFactory: fake.factory });
	const name = run.session.worker, sessionId = run.session.handle.backendSessionId;
	const refused = await here.execute({ action: "adopt", name, stateDir: dirA, agent: "fake", sessionId });
	assert.ok(!refused.ok && refused.error.code === "RUN_OWNED_ELSEWHERE", JSON.stringify(refused));
	assert.match(refused.error.message, new RegExp(`Pi process ${a.pid} `));

	await a.kill();
	const adopted = await here.execute({ action: "adopt", name, stateDir: dirA, agent: "fake", sessionId });
	assert.ok(adopted.ok && adopted.details.adopted === true && adopted.details.sessions === 1, JSON.stringify(adopted));
	const resumed = await here.execute({ action: "resume", name, agent: "fake", sessionId, cwd: m.cwd });
	assert.ok(resumed.ok, JSON.stringify(resumed));
	await here.shutdown();
});

test("the legacy single state dir is adopted from like a dead process's dir", { timeout: 30000 }, async (t) => {
	const m = machine(t);
	const sessionId = "sess-legacy";
	mkdirSync(m.home, { recursive: true });
	// As a Coordinator before per-process state left it: state.json directly in <agentDir>/pi-strings, no owner file.
	writeFileSync(join(m.home, "state.json"), JSON.stringify({ version: 2, workers: [], requests: [], sessions: [{ sessionId, agent: "fake", profileName: "direct:fake", role: "read-only", cwd: m.cwd }] }));
	const fake = fakeRuntime();
	const here = new Coordinator(m.cwd, { home: m.home, profiles: {}, runtimeFactory: fake.factory });
	const resume = { action: "resume", name: "w-legacy", agent: "fake", sessionId, cwd: m.cwd };
	const unknown = await here.execute(resume);
	assert.ok(!unknown.ok && unknown.error.code === "RESUME_PROVENANCE_UNKNOWN", "its own state has no record of the session");
	const adopted = await here.execute({ action: "adopt", name: "w-legacy", agent: "fake", sessionId });
	assert.ok(adopted.ok && adopted.details.sessions === 1, JSON.stringify(adopted));
	assert.ok((await here.execute(resume)).ok);
	assert.match(here.stateDir, new RegExp(`^${m.home}/proc/${process.pid}-`), "its own state is still its process's dir");
	await here.shutdown();
});

test("the agent dir is Pi's: PI_CODING_AGENT_DIR with ~ expanded; PI_AGENT_DIR overrides it", () => {
	assert.equal(agentDir({}), join(homedir(), ".pi", "agent"));
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/pi-agent" }), join(homedir(), "pi-agent"));
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/a" }), "/a");
	assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/a", PI_AGENT_DIR: "/b" }), "/b");
	const saved = { coding: process.env.PI_CODING_AGENT_DIR, agent: process.env.PI_AGENT_DIR };
	try {
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent-dir-test";
		delete process.env.PI_AGENT_DIR;
		assert.match(new Coordinator(process.cwd(), {}).stateDir, new RegExp(`^/tmp/pi-agent-dir-test/pi-strings/proc/${process.pid}-[0-9a-f]+$`));
	} finally {
		if (saved.coding === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.coding;
		if (saved.agent === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = saved.agent;
	}
});
