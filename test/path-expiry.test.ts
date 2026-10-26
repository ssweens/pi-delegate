import "./setup.ts";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { MomClient } from "../src/mom/client.ts";
import { rebuildMap } from "../src/mom/rebuild.ts";
import { sessionFromFile } from "../src/mom/session-file.ts";
import { identityOf } from "../src/mom/slice.ts";
import { OvenIgnoresExpiry } from "../src/oven.ts";

/**
 * Path's slices on an oven older than slice expiry: a stub oven (fetch) answers every create without `expires`, as such an
 * oven does. Path refuses the provider without deleting the only saved history, as delegate runs do.
 */
const OLD_OVEN = "http://old-oven.test";
const realFetch = globalThis.fetch;
let calls: { tool: string; args: any }[] = [];
let dir = "";
let context: any;

before(async () => {
	Object.assign(process.env, { OVEN_URL: OLD_OVEN, OVEN_TOKEN: "stand-in" });
	globalThis.fetch = (async (_url: string, init: RequestInit) => {
		const { id, params } = JSON.parse(String(init.body));
		const tool = String(params.name).replace(/^oven_/, "");
		calls.push({ tool, args: params.arguments });
		const answer = tool === "list" ? [] : tool === "create" ? { id: `s-old-${calls.length}`, state: "idle", turns: 0 } : {};
		return new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(answer) }] } }), { headers: { "content-type": "application/json" } });
	}) as typeof fetch;
	dir = await mkdtemp(join(tmpdir(), "path-expiry-"));
	const file = join(dir, "session.jsonl");
	await writeFile(file, [JSON.stringify({ type: "session", id: "path-expiry", cwd: dir }),
		JSON.stringify({ type: "message", id: "first", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "Map this" }] } }), ""].join("\n"));
	context = { cwd: dir, sessionManager: sessionFromFile(file, "first") };
});
after(async () => { globalThis.fetch = realFetch; await rm(dir, { recursive: true, force: true }); });

/** Refusal names the provider and requests archive, never destructive retirement. */
async function refused(attempt: Promise<unknown>) {
	calls = [];
	const error = await attempt.then(() => assert.fail("Path accepted a slice that never expires"), (e) => e);
	assert.ok(error instanceof OvenIgnoresExpiry, String(error));
	assert.equal(error.url, OLD_OVEN);
	const create = calls.findIndex((c) => c.tool === "create");
	assert.ok(create >= 0 && calls[create]!.args.expires?.idle === "1h", "the create asked for expiry");
	assert.deepEqual(calls[create]!.args.owner, { client: "pi-delegate", session: "path-expiry" }, "tracking and rebuild attribute the actual parent session");
	const slice = error.slice;
	assert.match(error.message, /did not keep expires .* with expiryAction "archive"/);
	assert.equal(calls[create]!.args.expiryAction, "archive");
	assert.deepEqual(calls.slice(create + 1), [{ tool: "archive", args: { slice } }], "no retirement or deletion");
}

test("Path's tracking slice refuses an unsafe lease without retiring history", async () => {
	const client = new MomClient(context, { flags: { "mom-model": "fixture/fixture" }, changed() {}, publish() {}, notify() {} });
	try {
		await refused(client.ensure());
		assert.equal(client.slice, undefined, "Path holds no slice");
	} finally { client.close(); }
});

test("Path's rebuild refuses an unsafe lease without retiring history", async () => {
	await refused(rebuildMap(context, identityOf(context.sessionManager, dir), { "mom-model": "fixture/fixture" }, () => {}, new AbortController().signal));
});
