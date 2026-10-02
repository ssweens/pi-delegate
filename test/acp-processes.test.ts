/**
 * One Coordinator per Pi process (ADR 0001). Each Pi here is a real child process
 * (test/acp-process-owner.ts) configured only by its agent dir, as Pi is, so each gets the state
 * dir it would get in use. Between processes, only the machine-wide claims and adoption from
 * another process's state dir connect them. The runtimes are the in-process fake and ACPX with the
 * fixture ACP agent and the fake Amp CLI. No credentials, no network.
 */
import assert from "node:assert/strict";
import { execFileSync, fork, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadProfiles } from "../src/acp/domain/config.ts";
import { StringsError } from "../src/acp/domain/errors.ts";
import { Coordinator } from "../src/acp/orchestration/coordinator.ts";
import { Claims, writerClaims } from "../src/acp/persistence/claims.ts";
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
	const inputLog = join(root, "amp-input.ndjson");
	const env = { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agent, PI_AGENT_DIR: agent, AMP_CLI_PATH: fakeAmp, AMP_ACP_STATE_DIR: join(root, "amp-state"), AMP_FAKE_INPUT_LOG: inputLog };
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
	return { root, agent, home: join(agent, "pi-strings"), cwd, pi, record, inputLog };
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

test("multiple processes observe one native session and serialize its turns", { timeout: 90000 }, async (t) => {
	const m = machine(t);
	const [a, b] = await Promise.all([m.pi("acpx"), m.pi("acpx")]);
	const [openedA, openedB] = await Promise.all([
		a.call("start", { origin: "opened", agent: "amp", sessionId: localThread }),
		b.call("start", { origin: "opened", agent: "amp", sessionId: localThread }),
	]);
	assert.equal(openedA.session.nativeSessionId, localThread);
	assert.equal(openedB.session.nativeSessionId, localThread);
	await b.call("restore");
	const foreign = (await b.call("status", { ids: [openedA.id] }))[0];
	assert.equal(foreign.foreign.ownerPid, a.pid, "a second process can inspect the other attachment");

	await a.call("steer", { id: openedA.id, message: "SLOW first process turn" });
	await new Promise(resolve => setTimeout(resolve, 50));
	const beforeSecond = existsSync(m.inputLog) ? readFileSync(m.inputLog, "utf8").trim().split("\n").filter(Boolean).length : 0;
	await b.call("steer", { id: openedB.id, message: "second process turn" });
	const duringFirst = existsSync(m.inputLog) ? readFileSync(m.inputLog, "utf8").trim().split("\n").filter(Boolean).length : 0;
	assert.equal(duringFirst, beforeSecond, "the second process is queued while the first native turn runs");

	const [first, second] = await Promise.all([
		a.call("wait", { ids: [openedA.id] }),
		b.call("wait", { ids: [openedB.id] }),
	]);
	assert.equal(first.settled[0].status, "complete");
	assert.equal(second.settled[0].status, "complete");
	const inputs = readFileSync(m.inputLog, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).input);
	assert.deepEqual(inputs.slice(-2), ["SLOW first process turn", "second process turn"], "native turns execute in injection order");

	await a.call("close", { id: openedA.id });
	await b.call("close", { id: openedB.id });
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

test("the agent dir agrees with Pi's getAgentDir(); PI_AGENT_DIR overrides it", () => {
	const saved = { coding: process.env.PI_CODING_AGENT_DIR, agent: process.env.PI_AGENT_DIR };
	try {
		for (const coding of [undefined, "", "~/pi-agent", "~", "/a", "relative/dir", "file:///tmp/pi-agent-url"]) {
			if (coding === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = coding;
			delete process.env.PI_AGENT_DIR;
			assert.equal(agentDir(), getAgentDir(), `PI_CODING_AGENT_DIR=${coding}`);
			process.env.PI_AGENT_DIR = "/b";
			assert.equal(agentDir(), "/b");
		}
		delete process.env.PI_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = "~/pi-agent";
		assert.equal(agentDir(), join(homedir(), "pi-agent"));
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-agent-dir-test";
		assert.match(new Coordinator(process.cwd(), {}).stateDir, new RegExp(`^/tmp/pi-agent-dir-test/pi-strings/proc/${process.pid}-[0-9a-f]+$`));
	} finally {
		if (saved.coding === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.coding;
		if (saved.agent === undefined) delete process.env.PI_AGENT_DIR; else process.env.PI_AGENT_DIR = saved.agent;
	}
});

const writerProfile = (isolation: "shared" | "worktree") => ({ agent: "fake", role: "writer" as const, tools: ["read", "write"], isolation, timeoutMs: 60_000, cancellationGraceMs: 1_000, maxOutputBytes: 100_000 });
function gitWorktree(root: string, repo: string): string {
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { stdio: "ignore" });
	git("init", "-q");
	git("commit", "-q", "--allow-empty", "-m", "init");
	const wt = join(root, "wt");
	git("worktree", "add", "-q", wt);
	return realpathSync(wt);
}

test("two workers in one process that share a writer claim keep it until the last one closes", { timeout: 60000 }, async (t) => {
	const m = machine(t);
	const wt = gitWorktree(m.root, m.cwd);
	const here = new Coordinator(m.cwd, { home: m.home, stateDir: join(m.root, "here"), profiles: { shared: writerProfile("shared"), isolated: writerProfile("worktree") }, runtimeFactory: fakeRuntime().factory });
	// A shared writer in the linked worktree takes cwd:wt; a worktree writer there needs cwd:wt too, and the worktree.
	for (const [name, profile] of [["w1", "shared"], ["w2", "isolated"]]) {
		const spawned = await here.execute({ action: "spawn", name, profile, cwd: wt });
		assert.ok(spawned.ok, JSON.stringify(spawned));
	}
	assert.ok((await here.execute({ action: "close", name: "w1" })).ok);
	const b = await m.pi();
	const refused = await b.ask("start", created(wt, "WAIT", { role: "writer" }));
	assert.equal(refused.code, "WRITER_CWD_OWNED", `w2 still writes in ${wt}: ${refused.code}: ${refused.message}`);
	assert.match(refused.message!, new RegExp(`held by Pi process ${process.pid} `));
	assert.ok((await here.execute({ action: "close", name: "w2" })).ok);
	assert.ok((await b.ask("start", created(wt, "WAIT", { role: "writer" }))).ok, "the last holder's close releases it");
	await here.shutdown();
});

test("closing a parked run whose worker another live process still holds is refused with its PID; allowed once it is gone", { timeout: 60000 }, async (t) => {
	const m = machine(t);
	const a = await m.pi();
	const run = await a.call("start", created(m.cwd, "NOCLOSE", { role: "writer" }));
	await a.call("wait", { ids: [run.id] });
	// A replaced this parent's session but lives on: its close failed, so the run parked unreleased.
	await a.call("release");
	assert.equal(m.record(run.id).unreleased, true);

	const b = await m.pi();
	await b.call("restore");
	const refused = await b.ask("close", { id: run.id });
	assert.equal(refused.code, "RUN_OWNED_ELSEWHERE", `${refused.code}: ${refused.message}`);
	assert.match(refused.message!, new RegExp(`Pi process ${a.pid} `));
	assert.equal(m.record(run.id).closedAt, undefined, "not marked closed while another process holds its session and claims");

	await a.kill();
	assert.ok((await b.ask("close", { id: run.id })).ok, "its holder is gone");
	assert.ok((await b.ask("start", created(m.cwd, "WAIT", { role: "writer" }))).ok, "a dead holder's claims do not block");
});

test("the legacy state dir is where the old Coordinator kept it: PI_AGENT_DIR, else ~/.pi/agent, never PI_CODING_AGENT_DIR", { timeout: 30000 }, async (t) => {
	const m = machine(t);
	const saved = { home: process.env.HOME, coding: process.env.PI_CODING_AGENT_DIR, agent: process.env.PI_AGENT_DIR };
	t.after(() => { for (const [key, value] of [["HOME", saved.home], ["PI_CODING_AGENT_DIR", saved.coding], ["PI_AGENT_DIR", saved.agent]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	process.env.HOME = m.root;
	process.env.PI_CODING_AGENT_DIR = m.agent;
	delete process.env.PI_AGENT_DIR;
	const legacy = join(m.root, ".pi", "agent", "pi-strings");
	mkdirSync(legacy, { recursive: true });
	writeFileSync(join(legacy, "state.json"), JSON.stringify({ version: 2, workers: [], requests: [], sessions: [{ sessionId: "sess-old", agent: "fake", profileName: "direct:fake", role: "read-only", cwd: m.cwd }] }));
	const here = new Coordinator(m.cwd, { profiles: {}, runtimeFactory: fakeRuntime().factory });
	assert.match(here.stateDir, new RegExp(`^${m.agent}/pi-strings/proc/`), "new state follows Pi's agent dir");
	const adopted = await here.execute({ action: "adopt", name: "w-old", agent: "fake", sessionId: "sess-old" });
	assert.ok(adopted.ok && adopted.details.sessions === 1, JSON.stringify(adopted));
	await here.shutdown();
});

test("user profiles: Pi's agent dir first, the old ~/.pi/agent/pi-strings.json when it has none", { timeout: 30000 }, async (t) => {
	const m = machine(t);
	const saved = { home: process.env.HOME, coding: process.env.PI_CODING_AGENT_DIR, agent: process.env.PI_AGENT_DIR };
	t.after(() => { for (const [key, value] of [["HOME", saved.home], ["PI_CODING_AGENT_DIR", saved.coding], ["PI_AGENT_DIR", saved.agent]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
	process.env.HOME = m.root;
	process.env.PI_CODING_AGENT_DIR = m.agent;
	delete process.env.PI_AGENT_DIR;
	const profile = (agent: string) => JSON.stringify({ profiles: { mine: { agent, role: "read-only", tools: ["read"] } } });
	mkdirSync(join(m.root, ".pi", "agent"), { recursive: true });
	writeFileSync(join(m.root, ".pi", "agent", "pi-strings.json"), profile("old"));
	assert.equal((await loadProfiles(m.cwd)).mine?.agent, "old", "a profile kept where it always was still loads");
	mkdirSync(m.agent, { recursive: true });
	writeFileSync(join(m.agent, "pi-strings.json"), profile("new"));
	assert.equal((await loadProfiles(m.cwd)).mine?.agent, "new", "one in Pi's agent dir wins");
});

test("a claim error that is not another live holder does not fail a restored worker for good", { timeout: 30000 }, async (t) => {
	const m = machine(t);
	const options = { home: m.home, stateDir: join(m.root, "here"), profiles: {}, runtimeFactory: fakeRuntime().factory };
	const first = new Coordinator(m.cwd, options);
	assert.ok((await first.execute({ action: "spawn", name: "w-busy", agent: "fake", cwd: m.cwd })).ok);
	await first.shutdown();
	for (const [code, status] of [["CLAIM_BUSY", "idle"], ["SESSION_IN_USE", "failed"]] as const) {
		const next = new Coordinator(m.cwd, options);
		const claims = (next as unknown as { claims: { acquireAll(claims: unknown[]): Promise<string[]> } }).claims;
		const acquireAll = claims.acquireAll.bind(claims);
		let failures = 1;
		claims.acquireAll = async (wanted) => { if (failures-- > 0) throw new StringsError(code, `${code} once`, code === "CLAIM_BUSY"); return acquireAll(wanted); };
		const listed = await next.execute({ action: "list" });
		assert.ok(listed.ok, JSON.stringify(listed));
		assert.equal((listed.details.workers as { status: string }[])[0]?.status, status, `after ${code}`);
		await next.shutdown();
	}
});

test("a process killed inside a claim's read-check-write blocks that claim only briefly", { timeout: 30000 }, async (t) => {
	const m = machine(t);
	const locks = join(m.home, "locks");
	mkdirSync(locks, { recursive: true });
	const [claim] = writerClaims(m.cwd);
	const path = join(locks, `${createHash("sha256").update(claim!.key).digest("hex").slice(0, 40)}.json`);
	const holder = spawn(process.execPath, ["-e", `require("proper-lockfile").lock(${JSON.stringify(path)}, { realpath: false }).then(() => { console.log("locked"); setInterval(() => {}, 1000); })`], { cwd: new URL("..", import.meta.url).pathname, stdio: ["ignore", "pipe", "inherit"] });
	await new Promise<void>((resolve) => holder.stdout!.once("data", () => resolve()));
	holder.kill("SIGKILL");
	await new Promise((resolve) => holder.once("exit", resolve));
	assert.ok(existsSync(`${path}.lock`), "the dead process left its mutex behind");
	const claims = new Claims(locks, join(m.root, "here"));
	const started = Date.now();
	await claims.acquire(claim!);
	assert.ok(Date.now() - started < 8_000);
	await claims.releaseAll();
});

test("an opened run revives in another process even when the dead process's state is unreadable", { timeout: 120000 }, async (t) => {
	const m = machine(t);
	const a = await m.pi("acpx");
	const opened = await a.call("start", { origin: "opened", agent: "amp", sessionId: localThread });
	const dirA = await a.call("stateDir");
	await a.call("park");
	await a.exit();
	// An opened run takes nothing from the dir that held it.
	writeFileSync(join(dirA, "state.json"), "{ not json");

	const b = await m.pi("acpx");
	await b.call("restore");
	const steered = await b.ask("steer", { id: opened.id, message: "hello" });
	assert.ok(steered.ok, `${steered.code}: ${steered.message}`);
	assert.equal((await b.call("wait", { ids: [opened.id] })).settled[0].output, "AMP_LOCAL_OK");
});
