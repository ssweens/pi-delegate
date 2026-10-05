import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { provider, sandbox, harness } from "./fixture.ts";

/** A scripted oven daemon on its socket: only oven is fake, pi-delegate is real. */
async function fakeOven(path: string) {
	const requests: any[] = [];
	const slices = new Map<string, { state: string; output: string; turns: number }>();
	let next = 0;
	const server = createServer((socket) => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			const req = JSON.parse(buffer.slice(0, newline));
			requests.push(req);
			const reply = (value: unknown) => socket.end(`${JSON.stringify({ ok: true, value })}\n`);
			const slice = slices.get(req.slice);
			if (req.op === "create") { const id = `s-${++next}`; slices.set(id, { state: "running", output: "", turns: 0 }); return reply({ id, state: "running", turns: 0, cwd: `/copies/${id}` }); }
			if (req.op === "send") { slice!.state = "running"; return reply({ id: req.slice, state: "running", turns: slice!.turns }); }
			if (req.op === "stop") { slice!.state = "stopped"; return reply({ id: req.slice, state: "stopped", turns: slice!.turns }); }
			if (req.op === "wait") {
				const answer = () => reply({ id: req.slice, ...slice!, cwd: `/copies/${req.slice}` });
				if (slice!.state !== "running") return answer();
				setTimeout(answer, 50);
			}
		});
	});
	await new Promise<void>((done) => server.listen(path, () => done()));
	return {
		requests,
		settle(id: string, output: string) { Object.assign(slices.get(id)!, { state: "idle", output, turns: 2 }); },
		close: () => new Promise<void>((done) => server.close(() => done())),
	};
}

test("a role with runtime: oven runs its child as an oven slice and keeps pi-delegate's surface (real SDK, scripted oven)", { timeout: 60000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	const socketPath = join(box.root, "oven.sock");
	process.env.OVEN_SOCKET = socketPath;
	const oven = await fakeOven(socketPath);
	const agents = join(box.cwd, ".pi", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(join(agents, "baker.md"), "---\nname: baker\ndescription: Runs in oven.\nruntime: oven\nextensions: pi-web-access, fixture-private\ntools: read, web_fetch\n---\n\nBake carefully.\n");
	const h = await harness(box);
	try {
		await t.test("the slice gets the role's instructions, model, extensions and tools, and the parent's cwd; wait returns its answer", async () => {
			const started = await h.launch("Bake one", { role: "baker" });
			assert.match(started.content[0].text, /running \(oven slice, fixture\/fixture\)/);
			const runId = started.details.id;
			await waitFor(() => oven.requests.some((r) => r.op === "create"));
			const create = oven.requests.find((r) => r.op === "create");
			assert.equal(create.task, "Bake one");
			assert.equal(create.cwd, realpathSync(box.cwd));
			assert.equal(create.config.model, "fixture/fixture");
			assert.deepEqual(create.config.extensions, ["pi-web-access", "fixture-private"]);
			assert.deepEqual(create.config.tools, ["read", "web_fetch"]);
			assert.match(create.config.instructions, /^Bake carefully\./);
			oven.settle("s-1", "BAKED");
			const result = await h.ctl("wait", runId);
			assert.equal(result.details.status, "complete", result.content[0].text);
			assert.match(result.details.output, /^BAKED\n\n\(oven slice s-1; its changes are in its copy, \/copies\/s-1\)$/);
			assert.equal(api.requests.length, 0, "no model call ran in this process");
		});

		await t.test("steer on a running oven run sends into its running work; on a settled one it wakes the same slice", async () => {
			const started = await h.launch("Bake two", { role: "baker" });
			const runId = started.details.id;
			await waitFor(() => oven.requests.filter((r) => r.op === "create").length === 2);
			await h.ctl("steer", runId, { message: "more sugar" });
			assert(oven.requests.some((r) => r.op === "send" && r.slice === "s-2" && r.text === "more sugar" && r.steer === true));
			oven.settle("s-2", "TWO");
			assert.equal((await h.ctl("wait", runId)).details.status, "complete");
			await h.ctl("steer", runId, { message: "again" });
			await waitFor(() => oven.requests.some((r) => r.op === "send" && r.slice === "s-2" && r.text === "again" && !r.steer));
			assert.equal(oven.requests.filter((r) => r.op === "create").length, 2, "a revival reuses the slice");
			oven.settle("s-2", "AGAIN");
			assert.match((await h.ctl("wait", runId)).details.output, /^AGAIN/);
		});

		await t.test("cancel halts the slice; a call's runtime overrides an in-process role", async () => {
			const started = await h.launch("Bake three", { role: "scout", runtime: "oven" });
			const runId = started.details.id;
			await waitFor(() => oven.requests.filter((r) => r.op === "create").length === 3);
			const cancelled = await h.ctl("cancel", runId);
			assert.equal(cancelled.isError, undefined, cancelled.content[0].text);
			await waitFor(() => oven.requests.some((r) => r.op === "stop" && r.slice === "s-3"));
			assert.equal((await h.ctl("wait", runId)).details.status, "cancelled");
		});
	} finally {
		await h.runtime.dispose();
		await oven.close();
		await api.close();
		delete process.env.OVEN_SOCKET;
		rmSync(box.root, { recursive: true, force: true });
	}
});

async function waitFor(condition: () => boolean, ms = 8000) {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) assert.fail("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
