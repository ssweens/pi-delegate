import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { provider, sandbox, harness, OVEN_AVAILABLE, startOven } from "./fixture.ts";
import { MomClient } from "../src/mom/client.ts";
import { oven } from "../src/mom/oven.ts";
import { writeMomGlobals } from "../src/mom/globals.ts";

const flags = { "mom-model": "fixture/fixture", "mom-mode": "trail", "mom-retry-ms": "100", "mom-interval-ms": "0" };
async function until(check: () => Promise<boolean>) {
	for (const end = Date.now() + 15_000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 30))) if (await check()) return;
	assert.fail("Path lifecycle transition timed out");
}

test("real Path watcher: reload rebinds; explicit end archives; detached is deliberate; pause still releases", { timeout: 90_000, skip: !OVEN_AVAILABLE && "set OVEN_DIR" }, async (t) => {
	const api = await provider(), box = sandbox(api.url);
	const modelFile = join(box.agentDir, "models.json"), models = JSON.parse(readFileSync(modelFile, "utf8"));
	models.providers.fixture.models.push({ ...models.providers.fixture.models[0], id: "fixture-b" });
	writeFileSync(modelFile, JSON.stringify(models));
	const daemon = await startOven(box.root, box.agentDir);
	const { SessionManager } = await import("@earendil-works/pi-coding-agent");
	mkdirSync(join(box.root, "parents"), { recursive: true });
	let manager = SessionManager.create(box.cwd, join(box.root, "parents"));
	writeFileSync(manager.getSessionFile()!, JSON.stringify(manager.getHeader()) + "\n");
	manager = SessionManager.open(manager.getSessionFile()!);
	api.onUnscripted(() => ({ tool: { name: "record_waypoints", arguments: { waypoints: [] } } }));
	const options = { flags, changed() {}, publish() {}, notify() {} };
	const make = () => new MomClient({ cwd: box.cwd, sessionManager: manager } as never, options);
	let path = make();
	const status = () => oven<any>("status", { slice: path.slice!.id });
	try {
		const other = await oven<any>("create", { owner: { client: "other", session: "not-this-parent" }, config: { name: "other", instructions: "Idle", model: "fixture/fixture" }, cwd: box.cwd, copy: "none", expires: "never" });
		writeFileSync(join(box.cwd, "borrowed-marker"), "not disposable");
		await path.connect();
		await until(async () => (await status()).stage === "idle");
		const original = await status();
		assert.equal(original.expiryAction, "archive");
		assert.deepEqual(original.expires, { idle: "1h" });
		await t.test("transport close/reload never archives or replays the task", async () => {
			const requests = api.requests.length;
			path.close();
			assert.equal((await status()).archived, false);
			path = make(); await path.connect();
			assert.equal(path.slice.id, original.id);
			assert.equal((await status()).conversation, original.conversation);
			assert.equal(api.requests.length, requests);
		});
		await t.test("explicit end archives only owned work, preserving the borrowed workspace", async () => {
			await path.end();
			assert.equal((await oven<any>("status", { slice: original.id })).archived, true);
			assert.equal((await oven<any>("status", { slice: other.id })).archived, false);
			assert.equal(readFileSync(join(box.cwd, "borrowed-marker"), "utf8"), "not disposable");
			path = make(); await path.connect();
			await until(async () => (await status()).stage === "idle");
			assert.equal(path.slice.id, original.id);
		});
		await t.test("explicit detached setting selects never; work follows after parent end; pause archives it", async () => {
			await path.controls({ detached: true });
			await until(async () => (await status()).expires === "never");
			const id = path.slice.id;
			await path.end();
			assert.equal((await oven<any>("status", { slice: id })).archived, false);
			const requests = api.requests.length;
			manager.appendMessage({ role: "user", content: "A new direction after detached parent end", timestamp: Date.now() });
			await until(async () => api.requests.length > requests);
			path = make(); await path.connect();
			assert.equal(path.slice.id, id);
			await path.controls({ enabled: false });
			await until(async () => (await oven<any>("status", { slice: id })).archived);
			await path.controls({ detached: false });
			await path.controls({ model: "fixture/fixture-b" });
			await path.controls({ enabled: true });
			await until(async () => !!path.slice && (await status()).stage === "idle" && !(await status()).archived);
			assert.equal(path.slice.id, id);
			assert.deepEqual((await status()).expires, { idle: "1h" });
			assert.equal((await status()).model, "fixture/fixture-b", "settings saved while archived must apply without replacing history");
		});
		await path.end();
		await t.test("actual extension shutdown wiring distinguishes reload from quit", async () => {
			await writeMomGlobals({ enabled: true, detached: false });
			const h = await harness(box, undefined, { flags });
			const parentId = h.ctx().sessionManager.getSessionId();
			const mine = async () => (await oven<any[]>("list", { includeArchived: true })).find(s => s.owner?.session === parentId);
			try {
				await until(async () => (await mine())?.stage === "idle");
				const before = await mine(), requests = api.requests.length;
				await h.runtime.session.reload();
				await until(async () => !!(await mine()));
				assert.equal((await mine()).id, before.id);
				assert.equal((await mine()).archived, false);
				assert.equal(api.requests.length, requests);
			} finally { await h.runtime.dispose(); }
			assert.equal((await mine()).archived, true);
			assert.deepEqual(h.errors, []);
		});
	} finally {
		await path.end();
		await daemon.stop(); await api.close(); rmSync(box.root, { recursive: true, force: true });
	}
});
