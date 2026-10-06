import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { provider, sandbox, harness } from "./fixture.ts";

/**
 * A scripted oven on HTTP: only oven is fake, pi-delegate is real. `watch` streams Server-Sent Events and
 * sends `settled` when the test settles the slice; `breakWatch` makes the next watch stream fail instead.
 */
async function fakeOven() {
	const requests: any[] = [];
	const slices = new Map<string, { state: string; output: string; turns: number }>();
	const waiting = new Map<string, Set<() => void>>();
	let next = 0, brokenWatches = 0;
	const view = (id: string) => ({ id, ...slices.get(id)!, cwd: `/copies/${id}` });
	const server = createServer(async (req, res) => {
		if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ oven: true, ready: true, protocol: 1, version: "fake", pid: 1 })); }
		let body = "";
		for await (const chunk of req) body += chunk;
		const op = req.url!.replace("/api/", "");
		const params = JSON.parse(body || "{}");
		requests.push({ op, ...params, token: req.headers.authorization });
		const reply = (value: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, value })); };
		const slice = slices.get(params.slice);
		if (op === "create") { const id = `s-${++next}`; slices.set(id, { state: "running", output: "", turns: 0 }); return reply(view(id)); }
		if (op === "send") { slice!.state = "running"; return reply(view(params.slice)); }
		if (op === "stop") { slice!.state = "stopped"; for (const wake of waiting.get(params.slice) ?? []) wake(); return reply(view(params.slice)); }
		if (op === "wait") {
			if (slice!.state !== "running") return reply(view(params.slice));
			return setTimeout(() => reply(view(params.slice)), 50);
		}
		if (op === "watch") {
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (brokenWatches > 0) { brokenWatches--; res.write(`data: ${JSON.stringify({ type: "snapshot", slice: view(params.slice), messages: [], tools: [] })}\n\n`); return res.destroy(); }
			res.write(`data: ${JSON.stringify({ type: "snapshot", slice: view(params.slice), messages: [], tools: [] })}\n\n`);
			const settle = () => { res.write(`data: ${JSON.stringify({ type: "settled", slice: view(params.slice), output: slices.get(params.slice)!.output })}\n\nevent: end\ndata: {}\n\n`); res.end(); };
			if (slice!.state !== "running") return settle();
			const set = waiting.get(params.slice) ?? new Set();
			waiting.set(params.slice, set);
			const wake = () => { set.delete(wake); settle(); };
			set.add(wake);
			req.on("close", () => set.delete(wake));
			return;
		}
		res.writeHead(404); res.end(JSON.stringify({ ok: false, error: "unknown op" }));
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
	return {
		requests, url: `http://127.0.0.1:${(server.address() as any).port}`,
		breakWatch(times = 1) { brokenWatches = times; },
		settle(id: string, output: string) { Object.assign(slices.get(id)!, { state: "idle", output, turns: 2 }); for (const wake of waiting.get(id) ?? []) wake(); },
		close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }),
	};
}

test("a role with runtime: oven runs its child as an oven slice and keeps pi-delegate's surface (real SDK, scripted oven)", { timeout: 60000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	const oven = await fakeOven();
	process.env.OVEN_URL = oven.url;
	process.env.OVEN_TOKEN = "test-token";
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
			assert(oven.requests.some((r) => r.op === "watch" && r.slice === "s-1" && r.untilSettled === true), "it followed the slice's watch stream");
			assert(!oven.requests.some((r) => r.op === "wait"), "no polling while the stream works");
			assert(oven.requests.every((r) => r.token === "Bearer test-token"), "every request carries the token");
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

		await t.test("when the watch stream keeps breaking, the run falls back to long-polling wait and still settles", async () => {
			oven.breakWatch(3);
			const started = await h.launch("Bake fallback", { role: "baker" });
			const runId = started.details.id;
			await waitFor(() => oven.requests.filter((r) => r.op === "watch").length >= 4);
			await waitFor(() => oven.requests.some((r) => r.op === "wait" && r.slice === "s-3"), 15_000);
			oven.settle("s-3", "FALLBACK");
			const result = await h.ctl("wait", runId);
			assert.equal(result.details.status, "complete");
			assert.match(result.details.output, /^FALLBACK/);
		});

		await t.test("cancel halts the slice; a call's runtime overrides an in-process role", async () => {
			const started = await h.launch("Bake three", { role: "scout", runtime: "oven" });
			const runId = started.details.id;
			await waitFor(() => oven.requests.filter((r) => r.op === "create").length === 4);
			const cancelled = await h.ctl("cancel", runId);
			assert.equal(cancelled.isError, undefined, cancelled.content[0].text);
			await waitFor(() => oven.requests.some((r) => r.op === "stop" && r.slice === "s-4"));
			assert.equal((await h.ctl("wait", runId)).details.status, "cancelled");
		});
	} finally {
		await h.runtime.dispose();
		await oven.close();
		await api.close();
		delete process.env.OVEN_URL; delete process.env.OVEN_TOKEN;
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
