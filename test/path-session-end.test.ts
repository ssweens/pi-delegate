import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { MomClient } from "../src/mom/client.ts";
import { sessionFromFile } from "../src/mom/session-file.ts";
import { ovenHeartbeat } from "../src/oven.ts";
import { deferred } from "./capture.ts";

/**
 * Path's slice and the session that made it: a stub oven (fetch) records every call. A live session renews its own
 * slice; a session that ends stops its own slice at once and touches no other; a heartbeat stops with its client.
 */
const realFetch = globalThis.fetch;
let calls: { tool: string; args: any }[] = [];
let others: any[] = [];
let dir = "";
let context: any;
let creation: { arrived: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined;
let archiveFails = false;

before(async () => {
	Object.assign(process.env, { OVEN_URL: "http://stub-oven.test", OVEN_TOKEN: "stand-in" });
	ovenHeartbeat.everyMs = 25;
	globalThis.fetch = ((_url: string, init: RequestInit) => {
		const { id, params } = JSON.parse(String(init.body));
		const tool = String(params.name).replace(/^oven_/, "");
		calls.push({ tool, args: params.arguments });
		const reply = (answer: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(answer) }] } }), { headers: { "content-type": "application/json" } });
		if (tool === "watch") return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
		if (tool === "list") return Promise.resolve(reply(others));
		if (tool === "archive" && archiveFails) return Promise.resolve(new Response("release uncertain", { status: 503 }));
		const answer = tool === "create" ? { id: "s-mine", state: "idle", turns: 0, expires: { idle: "1h" }, expiryAction: "archive" } : tool === "archive" ? { id: params.arguments.slice, state: "stopped", archived: true } : {};
		if (tool === "create" && creation) { creation.arrived.resolve(); return creation.release.promise.then(() => reply(answer)); }
		return Promise.resolve(reply(answer));
	}) as typeof fetch;
	dir = await mkdtemp(join(tmpdir(), "path-end-"));
	const file = join(dir, "session.jsonl");
	await writeFile(file, [JSON.stringify({ type: "session", id: "path-end", cwd: dir }),
		JSON.stringify({ type: "message", id: "first", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "Map this" }] } }), ""].join("\n"));
	context = { cwd: dir, sessionManager: sessionFromFile(file, "first") };
});
after(async () => { globalThis.fetch = realFetch; await rm(dir, { recursive: true, force: true }); });

const client = () => new MomClient(context, { flags: { "mom-model": "fixture/fixture" }, changed() {}, publish() {}, notify() {} });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const beats = () => calls.filter((c) => c.tool === "expires");

test("a live session renews its own Path slice, and only that one", async () => {
	calls = []; others = [{ id: "s-other", key: "someone-else", stopped: false }];
	const path = client();
	try {
		await path.connect();
		await pause(120);
		assert.ok(beats().length >= 2, "the slice is renewed while the session lives");
		assert.ok(beats().every((c) => c.args.slice === "s-mine" && Object.keys(c.args).length === 1), "its own slice, renewed without a new expiry");
	} finally { path.close(); }
});

test("a session that ends archives its own Path slice, and leaves another session's alone", async () => {
	calls = []; others = [{ id: "s-other", key: "someone-else", stopped: false }];
	const path = client();
	await path.connect();
	calls = [];
	await path.end();
	const ended = calls.filter((c) => c.tool !== "expires");
	assert.deepEqual(ended, [{ tool: "archive", args: { slice: "s-mine" } }]);
	assert.ok(!calls.some((c) => JSON.stringify(c.args).includes("s-other")), "another session's slice is never named");
});

test("end joins a late create and releases it instead of detaching accidentally", async () => {
	calls = [];
	creation = { arrived: deferred<void>(), release: deferred<void>() };
	const path = client();
	try {
		const connecting = path.connect();
		await creation.arrived.promise;
		const ending = path.end();
		creation.release.resolve();
		await connecting; await ending;
		assert.equal(path.slice, undefined);
		assert.equal(calls.filter(c => c.tool === "archive" && c.args.slice === "s-mine").length, 1);
	} finally { creation.release.resolve(); creation = undefined; path.close(); }
});

test("end reports failed release, never successful cleanup", async () => {
	const path = client(); await path.connect();
	archiveFails = true;
	try { await assert.rejects(path.end(), /503/); }
	finally { archiveFails = false; path.close(); }
});

test("the heartbeat stops with its client", async () => {
	const path = client();
	await path.connect();
	path.close();
	await pause(40);
	calls = [];
	await pause(120);
	assert.equal(beats().length, 0, "a closed client renews nothing");
});
