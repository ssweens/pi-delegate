import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { deferred, provider, sandbox, harness } from "./fixture.ts";
import { callOven } from "../src/oven-client.ts";
import { ovenToken, ovenHeartbeat } from "../src/oven.ts";
import { textOf } from "../src/util/text.ts";

const OVEN_DIR = process.env.OVEN_DIR ?? join(process.cwd(), "..", "..", "oven");
const DAEMON = join(OVEN_DIR, "src", "daemon.ts"), FAKE_AGENT = join(OVEN_DIR, "test", "fixtures", "fake-agent.py");
const tmux = (() => { try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = !existsSync(FAKE_AGENT) ? "set OVEN_DIR to Oven checkout" : !tmux && "tmux unavailable";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 15_000) {
	for (const end = Date.now() + ms; Date.now() < end; await pause(30)) if (await check()) return;
	assert.fail("execution lease transition timed out");
}
const freePort = () => new Promise<number>(resolve => {
	const server = createServer().listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
});

// Only isolated daemon ports; a recording proxy observes the client's calls without renewing them itself.
test("execution leases archive abandoned work; completed history has no heartbeat or expiry and remains resumable", { timeout: 120_000, skip }, async (t) => {
	ovenHeartbeat.everyMs = 100;
	const api = await provider(), box = sandbox(api.url);
	const url = `http://127.0.0.1:${await freePort()}`;
	Object.assign(process.env, { OVEN_URL: url, OVEN_SERVICE: "off", OVEN_TAILSCALE: "off", OVEN_SETUP: "off", OVEN_LAUNCH_AGENTS_DIR: join(box.root, "LaunchAgents"), OVEN_ROLES_DIR: join(box.root, "roles") });
	delete process.env.OVEN_TOKEN;
	const bin = join(box.root, "bin"); mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec python3 -I ${FAKE_AGENT} "$@"\n`); chmodSync(join(bin, "pi"), 0o755);
	process.env.PATH = `${bin}:${process.env.PATH}`;
	let skew = 0;
	const { startDaemon } = await import(DAEMON);
	const daemon = await startDaemon({ clock: () => Date.now() + skew, toolHost: { tools: [], dropped: [], errors: [], async promptFor() { return ""; }, close() {} } });
	const oven = <T = any>(tool: string, args: Record<string, unknown>) => callOven<T>({ url, token: ovenToken(), tool, args });
	const calls: { tool: string; args: any }[] = [];
	let createReply: ReturnType<typeof deferred<void>> | undefined;
	const upstream = new URL(url);
	const proxy = createHttpServer((req, res) => {
		const parts: Buffer[] = [];
		req.on("data", part => parts.push(part));
		req.on("end", () => {
			const body = Buffer.concat(parts);
			let call: (typeof calls)[number] | undefined;
			try { const rpc = JSON.parse(body.toString()); if (rpc.method === "tools/call") calls.push(call = { tool: rpc.params.name, args: rpc.params.arguments }); } catch { /* not a tool call */ }
			const forward = httpRequest({ host: upstream.hostname, port: upstream.port, path: req.url, method: req.method, headers: req.headers }, answer => {
				const respond = () => { if (!res.destroyed) { res.writeHead(answer.statusCode!, answer.headers); answer.pipe(res); } };
				if (createReply && call?.tool === "oven_create" && call.args.task === "Crash lease work") void createReply.promise.then(respond);
				else respond();
			});
			res.on("close", () => forward.destroy()); // A killed client must release the upstream watch hold too.
			forward.on("error", () => res.destroy()); forward.end(body);
		});
	});
	await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
	process.env.OVEN_URL = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
	const agents = join(box.cwd, ".pi", "agents"); mkdirSync(agents, { recursive: true });
	writeFileSync(join(agents, "baker.md"), "---\nname: baker\ndescription: finite\nruntime: oven\n---\nBake.\n");
	writeFileSync(join(agents, "tui-baker.md"), "---\nname: tui-baker\ndescription: finite TUI\ntui: pi\nmodel: fixture/fixture\n---\nBake.\n");
	let h = await harness(box);
	const beats = (slice: string) => calls.filter(c => c.tool === "oven_expires" && c.args.slice === slice && c.args.expires === undefined).length;
	const sliceFor = async (id: string) => (await oven<any[]>("list", { includeArchived: true })).find(s => s.id === h.state().runs.get(id)?.sliceId);
	const gates: ReturnType<typeof deferred<void>>[] = [];
	try {
		await t.test("active execution renews; completion immediately stops renewal; reload never replays", async () => {
			const gate = deferred<void>(); gates.push(gate);
			const arrived = api.script("Working lease", { text: "CAPTURED", gate });
			const run = await h.launch("Working lease", { role: "baker" }); await arrived;
			const slice = await sliceFor(run.details.id);
			assert.deepEqual(slice.expires, { idle: "1h" }); assert.equal(slice.expiryAction, "archive");
			await until(() => beats(slice.id) >= 2);
			const requests = api.requests.length;
			await h.runtime.session.reload();
			assert.equal(api.requests.length, requests);
			assert.equal((await oven("status", { slice: slice.id })).archived, false);
			gate.resolve(); assert.equal((await h.ctl("wait", run.details.id)).details.status, "complete");
			await pause(200); const stopped = beats(slice.id); await pause(400);
			assert.equal(beats(slice.id), stopped);
			assert.equal((await oven("status", { slice: slice.id })).archived, true);
			skew += 3 * 60 * 60_000; await pause(300);
			assert.equal(await oven("result", { slice: slice.id }), "CAPTURED");
			const parent = h.parent; await h.runtime.dispose(); h = await harness(box, parent);
			await pause(300); assert.equal(beats(slice.id), stopped, "restored history is not heartbeated");
			assert.match((await h.ctl("result", run.details.id)).details.output, /^CAPTURED/);
		});
		for (const role of ["baker", "tui-baker"]) await t.test(`${role}: execution lease end archives, and steer resumes the retained history`, async () => {
			let gate: ReturnType<typeof deferred<void>> | undefined;
			if (role === "baker") { gate = deferred<void>(); gates.push(gate); api.script("Lease ending", { text: "partial", gate }); }
			const run = await h.launch(role === "baker" ? "Lease ending" : "Bake slow", { role });
			let slice: any;
			await until(async () => !!(slice = await sliceFor(run.details.id)) && (role === "baker" ? slice.state === "running" : slice.status?.state === "working"));
			await oven("expires", { slice: slice.id, expires: { in: "1s" } });
			const result = await h.ctl("wait", run.details.id);
			assert.equal(result.details.status, "interrupted", result.content[0].text);
			assert.match(result.details.error, /saved history remains resumable/);
			assert.equal((await oven("status", { slice: slice.id })).archived, true);
			gate?.resolve();
			if (role === "baker") api.script("Resume lease", { text: "RESUMED" });
			await h.ctl("steer", run.details.id, { message: "Resume lease" });
			const resumed = await h.ctl("wait", run.details.id);
			assert.equal(resumed.details.status, "complete", resumed.content[0].text);
			const after = await sliceFor(run.details.id);
			assert.equal(after.id, slice.id); assert.equal(after.cwd, slice.cwd);
			assert.equal(after.conversation ?? after.session, slice.conversation ?? slice.session);
		});
		await t.test("a killed parent loses its execution lease, not its only saved conversation", async () => {
			createReply = deferred<void>(); // Execution starts, but its create ID can never reach the parent's record.
			const gate = deferred<void>(); gates.push(gate);
			const arrived = api.script("Crash lease work", { text: "interrupted crash answer", gate });
			const child = spawn(process.execPath, ["--import", "tsx", "test/reopen.ts", box.root, h.parent, "oven-crash", box.agentDir], { env: { ...box.env, OVEN_URL: process.env.OVEN_URL!, OVEN_TOKEN: ovenToken() }, stdio: ["ignore", "pipe", "pipe"] });
			let output = ""; child.stdout.on("data", part => output += part); child.stderr.on("data", part => output += part);
			try {
				await until(() => /OVEN_CRASH_RUN ([\w-]+)/.test(output));
				const id = /OVEN_CRASH_RUN ([\w-]+)/.exec(output)![1]!;
				await arrived;
				const before = (await oven<any[]>("list", {})).find(s => s.requestId === `pi-delegate:${id}`);
				assert.ok(before);
				const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
				createReply.resolve();
				await pause(200); skew += 61 * 60_000;
				await until(async () => (await oven("status", { slice: before.id })).archived);
				const parent = h.parent; await h.runtime.dispose();
				// Restoring an unacknowledged interruption may notify the lead; it must not replay the child's task.
				api.onUnscripted(() => ({ text: "ACK" }));
				const tasks = () => api.requests.filter(r => textOf(r.messages.findLast((m: any) => m.role === "user")?.content) === "Crash lease work").length;
				const requests = tasks(); assert.equal(requests, 1); h = await harness(box, parent);
				await pause(100); await h.runtime.session.agent.waitForIdle();
				assert.equal((await h.ctl("status", id)).details.status, "interrupted");
				assert.equal(h.state().runs.get(id).sliceId, undefined, "crash preceded create's answer");
				assert.equal(tasks(), requests, "cold restore does not replay abandoned input");
				gate.resolve(); api.script("Resume after crash", { text: "CRASH RESUMED" });
				const steered = await h.ctl("steer", id, { message: "Resume after crash" });
				assert.equal(steered.isError, undefined, steered.content[0].text);
				assert.equal(h.state().runs.get(id).sliceId, before.id, "recover the unreturned create by key, never a replacement");
				const resumed = await h.ctl("wait", id);
				assert.equal(resumed.details.status, "complete", resumed.content[0].text);
				assert.match(resumed.details.output, /^CRASH RESUMED/);
				api.onUnscripted();
				const after = await oven<any>("status", { slice: before.id });
				assert.equal(after.conversation, before.conversation); assert.equal(after.cwd, before.cwd);
			} finally { createReply.resolve(); createReply = undefined; if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; } }
		});
		await t.test("explicit parent end cancels/releases active work and fences a late result", async () => {
			const gate = deferred<void>(); gates.push(gate);
			const arrived = api.script("End parent", { text: "never complete", gate });
			const run = await h.launch("End parent", { role: "baker" }); await arrived;
			const slice = await sliceFor(run.details.id), parent = h.parent;
			await h.runtime.dispose(); gate.resolve();
			assert.equal((await oven("status", { slice: slice.id })).archived, true);
			h = await harness(box, parent);
			assert.equal((await h.ctl("wait", run.details.id)).details.status, "cancelled");
			await assert.rejects(h.ctl("steer", run.details.id, { message: "not authorized" }), /explicitly stopped/);
		});
	} finally {
		for (const gate of gates) gate.resolve();
		await h.runtime.dispose(); await daemon.stop();
		await new Promise(resolve => proxy.close(resolve));
		await api.close(); rmSync(box.root, { recursive: true, force: true });
	}
});
