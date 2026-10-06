import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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

test("runtime oven runs a child as an oven slice over MCP: create with the role's configuration, watch to settle, steer, cancel by halt, one slice per run", { timeout: 120_000, skip: !existsSync(DAEMON) && `no oven checkout at ${OVEN_DIR} (set OVEN_DIR)` }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	const daemon = await startOven();
	const { ovenCall } = await import("../src/oven.ts");
	const agents = join(box.cwd, ".pi", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(join(agents, "baker.md"), "---\nname: baker\ndescription: Runs in oven.\nruntime: oven\ntools: read, bash\n---\n\nBake carefully.\n");
	writeFileSync(join(box.cwd, "recipe.txt"), "flour\n");
	const h = await harness(box);
	try {
		await t.test("the slice gets the role's configuration in a copy of the cwd; wait returns its answer", async () => {
			const gate = deferred<void>();
			const arrived = api.script("Bake one", { gate, text: "BAKED" });
			const started = await h.launch("Bake one", { role: "baker" });
			assert.match(started.content[0].text, /running \(oven slice, fixture\/fixture\)/);
			const request = await arrived;
			const system = request.messages.find((m: any) => m.role === "system")?.content ?? "";
			assert.match(system, /^<instructions>\nBake carefully\./, "the role's body leads the instructions");
			assert.deepEqual(request.tools.map((tool: any) => tool.function.name).sort(), ["bash", "read"], "the role's tools narrow the slice's");
			const slice = (await ovenCall<any[]>("list", {})).find((s) => s.task === "Bake one");
			assert.equal(slice.sender, realpathSync(box.cwd));
			assert.notEqual(slice.cwd, slice.sender, "it works in a copy");
			assert.equal(slice.requestId, `pi-delegate:${started.details.id}`);
			gate.resolve();
			const result = await h.ctl("wait", started.details.id);
			assert.equal(result.details.status, "complete", result.content[0].text);
			assert.match(result.details.output, new RegExp(`^BAKED\\n\\n\\(oven slice ${slice.id}; its changes are in its copy, `));
			// A retry of the same create (a reconnect, an oven restart) never makes a second slice.
			const again = await ovenCall("create", { config: { name: "baker", instructions: "x", model: "fixture/fixture" }, task: "Bake one", cwd: box.cwd, requestId: slice.requestId });
			assert.equal(again.id, slice.id);
			assert.equal((await ovenCall<any[]>("list", {})).filter((s) => s.task === "Bake one").length, 1);
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
			assert.equal((await ovenCall<any[]>("list", {})).filter((s) => s.task === "Bake two").length, 1, "a revival reuses the slice");
		});

		await t.test("cancel halts the slice: its work ends, and it is not stopped", async () => {
			const gate = deferred<void>();
			const arrived = api.script("Bake three", { gate, text: "never" });
			const started = await h.launch("Bake three", { role: "baker" });
			await arrived;
			const cancelled = await h.ctl("cancel", started.details.id);
			assert.equal(cancelled.isError, undefined, cancelled.content[0].text);
			assert.equal((await h.ctl("wait", started.details.id)).details.status, "cancelled");
			await waitFor(async () => !["running", undefined].includes((await ovenCall<any[]>("list", {})).find((s) => s.task === "Bake three")?.state));
			const halted = (await ovenCall<any[]>("list", {})).find((s) => s.task === "Bake three");
			assert.notEqual(halted.state, "stopped", "halted, not stopped: a steer can wake it");
			gate.resolve();
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
