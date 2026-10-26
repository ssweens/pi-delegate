import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { ovenToken } from "../src/oven.ts";
import { join } from "node:path";
import { deferred, provider, sandbox, harness } from "./fixture.ts";

/**
 * runtime "oven" against a real oven: its daemon from an oven checkout (OVEN_DIR, else the sibling copy),
 * in this process's isolated home on a free port. Only the model is scripted; the same loopback provider
 * answers the slice's requests (oven brings the sandbox's models.json in from Pi's dir).
 */
const OVEN_DIR = process.env.OVEN_DIR ?? join(process.env.npm_config_local_prefix ?? process.cwd(), "..", "..", "..", "Users-ssweens-src-oven", "copies", "agents-only");
const DAEMON = join(OVEN_DIR, "src", "daemon.ts");

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
	});
}

async function startOven() {
	Object.assign(process.env, { OVEN_URL: `http://127.0.0.1:${await freePort()}`, OVEN_SERVICE: "off", OVEN_TAILSCALE: "off", OVEN_SETUP: "off",
		OVEN_LAUNCH_AGENTS_DIR: join(process.env.HOME!, "LaunchAgents"), OVEN_ROLES_DIR: join(process.env.HOME!, "roles") });
	delete process.env.OVEN_TOKEN;
	const { startDaemon } = await import(DAEMON);
	// No Pi packages: only oven's core tools.
	const toolHost = { tools: [], dropped: [], errors: [], async promptFor() { return ""; }, close() {} };
	return startDaemon({ toolHost });
}

async function waitFor(condition: () => boolean | Promise<boolean>, ms = 15_000) {
	const end = Date.now() + ms;
	while (!(await condition())) {
		if (Date.now() > end) assert.fail("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("runtime oven runs a child as an oven slice over MCP: create with the role's configuration, watch to settle, archive, steer, cancel, one slice per run", { timeout: 120_000, skip: !existsSync(DAEMON) && `no oven checkout at ${OVEN_DIR} (set OVEN_DIR)` }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	let daemon = await startOven();
	const { ovenCall } = await import("../src/oven.ts");
	const agents = join(box.cwd, ".pi", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(join(agents, "baker.md"), "---\nname: baker\ndescription: Runs in oven.\nruntime: oven\ntools: read, bash\n---\n\nBake carefully.\n");
	writeFileSync(join(box.cwd, "recipe.txt"), "flour\n");
	let h = await harness(box);
	try {
		await t.test("the slice gets the role's configuration in a copy of the cwd; wait returns its answer", async (t) => {
			const gate = deferred<void>();
			t.after(() => gate.resolve());
			const arrived = api.script("Bake one", { gate, text: "BAKED" });
			const started = await h.launch("Bake one", { role: "baker" });
			assert.match(started.content[0].text, /running \(oven slice, fixture\/fixture\)/);
			const request = await arrived;
			const system = request.messages.find((m: any) => m.role === "system")?.content ?? "";
			assert.match(system, /^<instructions>\n## Plan conflicts come first[\s\S]*\n\nBake carefully\./, "the plan-conflict rule precedes the role's instructions");
			assert.deepEqual(request.tools.map((tool: any) => tool.function.name).sort(), ["bash", "read"], "the role's tools narrow the slice's");
			const slice = (await ovenCall<any[]>("list", {})).find((s) => s.task === "Bake one");
			assert.equal(slice.sender, realpathSync(box.cwd));
			assert.notEqual(slice.cwd, slice.sender, "it works in a copy");
			assert.equal(slice.requestId, `pi-delegate:${started.details.id}`);
			assert.deepEqual(slice.owner, { client: "pi-delegate", session: h.ctx().sessionManager.getSessionId() });
			gate.resolve();
			const result = await h.ctl("wait", started.details.id);
			assert.equal(result.details.status, "complete", result.content[0].text);
			assert.match(result.details.output, new RegExp(`^BAKED\\n\\n\\(oven slice ${slice.id}; its changes are in its copy, `));
			// A retry of the same create (a reconnect, an oven restart) never makes a second slice.
			const again = await ovenCall("create", { config: { name: "baker", instructions: "x", model: "fixture/fixture" }, task: "Bake one", cwd: box.cwd, requestId: slice.requestId });
			assert.equal(again.id, slice.id);
			assert.equal(again.archived, true, "duplicate create does not wake history");
			assert.equal((await ovenCall<any[]>("list", {})).filter((s) => s.task === "Bake one").length, 0);
			assert.equal((await ovenCall<any[]>("list", { includeArchived: true })).filter((s) => s.task === "Bake one").length, 1);
		});

		await t.test("steer on a running oven run joins its running work; on a settled one it wakes the same slice", async () => {
			const gate = deferred<void>();
			const arrived = api.script("Bake two", { gate, text: "first" });
			api.script("more sugar", { text: "TWO" });
			const started = await h.launch("Bake two", { role: "baker" });
			const runId = started.details.id;
			await arrived;
			await h.ctl("steer", runId, { message: "more sugar" });
			gate.resolve();
			const result = await h.ctl("wait", runId);
			assert.equal(result.details.status, "complete", result.content[0].text);
			assert.match(result.details.output, /^TWO/, "the steer joined the running work");
			api.script("again", { text: "AGAIN" });
			await h.ctl("steer", runId, { message: "again" });
			await waitFor(async () => (await h.ctl("status", runId)).details.status !== "running");
			assert.match((await h.ctl("wait", runId)).details.output, /^AGAIN/);
			assert.equal((await ovenCall<any[]>("list", { includeArchived: true })).filter((s) => s.task === "Bake two").length, 1, "a revival reuses the slice");
		});

		await t.test("cancel archives the exact slice and fences late completion", async () => {
			const gate = deferred<void>();
			const arrived = api.script("Bake three", { gate, text: "never" });
			const started = await h.launch("Bake three", { role: "baker" });
			await arrived;
			const cancelled = await h.ctl("cancel", started.details.id);
			assert.equal(cancelled.isError, undefined, cancelled.content[0].text);
			assert.equal((await h.ctl("wait", started.details.id)).details.status, "cancelled");
			const halted = (await ovenCall<any[]>("list", { includeArchived: true })).find((s) => s.task === "Bake three");
			assert.equal(halted.archived, true);
			gate.resolve();
			assert.equal((await h.ctl("wait", started.details.id)).details.status, "cancelled");
		});

		await t.test("archived result, conversation and copy survive parent and daemon restart without replay", async () => {
			writeFileSync(join(agents, "writer.md"), "---\nname: writer\ndescription: Saves a result.\nruntime: oven\ntools: read, write\n---\n\nWrite carefully.\n");
			api.script("Remember durable marker", { tool: { name: "write", arguments: { path: "saved.txt", content: "copy survives" } } }, { text: "SAVED MARKER" });
			const started = await h.launch("Remember durable marker", { role: "writer" });
			const result = await h.ctl("wait", started.details.id);
			assert.equal(result.details.status, "complete", result.content[0].text);
			const before = (await ovenCall<any[]>("list", { includeArchived: true })).find(s => s.requestId === `pi-delegate:${started.details.id}`);
			assert.equal(before.archived, true);
			assert.equal(readFileSync(join(before.cwd, "saved.txt"), "utf8"), "copy survives");
			const requests = api.requests.length, parent = h.parent;
			await h.runtime.dispose();
			await daemon.stop();
			daemon = await startOven();
			const cold = spawn(process.execPath, ["--import", "tsx", "test/reopen.ts", box.root, parent, "cold", box.agentDir], { env: { ...box.env, OVEN_URL: process.env.OVEN_URL!, OVEN_TOKEN: ovenToken() }, stdio: ["ignore", "pipe", "pipe"] });
			let output = ""; cold.stdout.on("data", part => output += part); cold.stderr.on("data", part => output += part);
			const [code] = await once(cold, "exit");
			assert.equal(code, 0, output); assert.match(output, /COLD-READ-ONLY/);
			h = await harness(box, parent);
			assert.equal(api.requests.length, requests, "restart never replays the task");
			assert.match((await h.ctl("result", started.details.id)).details.output, /^SAVED MARKER/);
			assert.equal(await ovenCall("result", { slice: before.id }), "SAVED MARKER");
			const arrived = api.script("Continue durable marker", { text: "CONTINUED" });
			await h.ctl("steer", started.details.id, { message: "Continue durable marker" });
			const request = await arrived;
			assert.match(JSON.stringify(request.messages), /Remember durable marker/);
			assert.match(JSON.stringify(request.messages), /SAVED MARKER/);
			assert.match((await h.ctl("wait", started.details.id)).details.output, /^CONTINUED/);
			const after = await ovenCall<any>("status", { slice: before.id });
			assert.equal(after.conversation, before.conversation);
			assert.equal(after.cwd, before.cwd);
			assert.equal(after.archived, true);
			assert.equal(readFileSync(join(after.cwd, "saved.txt"), "utf8"), "copy survives");
		});
	} finally {
		await h.runtime.dispose();
		await daemon.stop();
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});

test("an unreachable oven fails the run with a message naming the URL and how to start oven", { timeout: 60_000 }, async () => {
	const api = await provider();
	const box = sandbox(api.url);
	process.env.OVEN_URL = `http://127.0.0.1:${await freePort()}`;
	const agents = join(box.cwd, ".pi", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(join(agents, "baker.md"), "---\nname: baker\ndescription: Runs in oven.\nruntime: oven\n---\n\nBake.\n");
	const h = await harness(box);
	try {
		const started = await h.launch("Bake nothing", { role: "baker" });
		const result = await h.ctl("wait", started.details.id);
		assert.equal(result.details.status, "error");
		assert.match(JSON.stringify(result), new RegExp(`nothing answers at ${process.env.OVEN_URL}. Start it with \`oven start\` or the oven tray app`));
		assert.doesNotMatch(JSON.stringify(result), /    at /, "no stack");
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		assert(!("oven" in { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }), "no oven dependency");
	} finally {
		await h.runtime.dispose();
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
