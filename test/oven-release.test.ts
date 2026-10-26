import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deferred, harness, provider, sandbox } from "./fixture.ts";

// Independent client proof: delayed/failed archive replies are not successful completion or permission to send.
test("captured results precede release; completion and steer wait for confirmed archive", { timeout: 30_000 }, async (t) => {
	const api = await provider(), box = sandbox(api.url);
	const fetch = globalThis.fetch;
	process.env.OVEN_URL = "http://release-fixture.test";
	process.env.OVEN_TOKEN = "fixture";
	const agents = join(box.cwd, ".pi", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(join(agents, "baker.md"), "---\nname: baker\ndescription: finite\nruntime: oven\n---\nBake.\n");
	writeFileSync(join(box.agentDir, "pi-delegate.json"), JSON.stringify({ path: { enabled: false } }));
	const h = await harness(box);
	api.onUnscripted(() => ({ text: "ACK" }));
	let created = 0, sends = 0, fail = false;
	let release = deferred<void>(), arrived = deferred<void>();
	globalThis.fetch = (async (url, init) => {
		if (!String(url).startsWith(process.env.OVEN_URL!)) return fetch(url, init);
		const { id, params } = JSON.parse(String(init?.body)), args = params.arguments;
		const tool = params.name.replace(/^oven_/, "");
		const view = { id: args.slice ?? `s-${created + 1}`, state: "idle", cwd: box.cwd, turns: 1, expires: { idle: "1h" }, expiryAction: "archive" };
		let answer: unknown = view;
		if (tool === "create") { created++; assert.equal(args.expiryAction, "archive"); }
		if (tool === "send") sends++;
		if (tool === "list") answer = [];
		if (tool === "watch") answer = { type: "settled", slice: view, output: "CAPTURED" };
		if (tool === "archive") {
			const run: any = [...h.state().runs.values()].find((r: any) => r.sliceId === args.slice);
			assert.match(JSON.parse(readFileSync(run.recordPath, "utf8")).output, /^CAPTURED/, "result is already durable when release is sent");
			arrived.resolve();
			await release.promise;
			if (fail) return new Response("uncertain release", { status: 503 });
			answer = { ...view, archived: true };
		}
		return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(answer) }] } }), { headers: { "content-type": "application/json" } });
	}) as typeof globalThis.fetch;
	try {
		await t.test("a concurrent steer cannot race pending release", async () => {
			const started = await h.launch("first", { role: "baker" });
			const waiting = h.ctl("wait", started.details.id);
			await arrived.promise;
			assert.equal(h.state().runs.get(started.details.id).completion.settled, false);
			const steer = h.ctl("steer", started.details.id, { message: "continue" });
			await new Promise(resolve => setTimeout(resolve, 50));
			assert.equal(sends, 0);
			release.resolve();
			assert.equal((await waiting).details.status, "complete");
			await steer;
			assert.equal((await h.ctl("wait", started.details.id)).details.status, "complete");
			assert.equal(created, 1);
			assert.equal(sends, 1);
		});
		await t.test("failed release is an error with the captured result, not cleanup success", async () => {
			release = deferred<void>(); arrived = deferred<void>(); fail = true;
			const started = await h.launch("uncertain", { role: "baker" });
			const waiting = h.ctl("wait", started.details.id);
			await arrived.promise; release.resolve();
			const result = await waiting;
			assert.equal(result.details.status, "error");
			assert.match(result.details.error, /execution release unconfirmed/);
			assert.match(result.details.output, /^CAPTURED/);
			const before = sends;
			await assert.rejects(h.ctl("steer", started.details.id, { message: "must not send" }), /503: uncertain release/);
			assert.equal(sends, before);
		});
		await t.test("missing saved mapping refuses a replacement create or workspace clone", async () => {
			fail = false;
			const result = await h.waitLaunch("missing history", { role: "baker" });
			assert.equal(result.details.status, "complete");
			h.state().runs.get(result.details.id).sliceId = undefined;
			const before = created;
			const refused = await h.ctl("steer", result.details.id, { message: "cannot replace history" });
			assert.equal(refused.details.error.code, "RUN_EXPIRED");
			assert.match(refused.content[0].text, /mapping is missing/);
			assert.equal(created, before);
		});
	} finally {
		release.resolve(); fail = false;
		await h.runtime.dispose();
		globalThis.fetch = fetch;
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
