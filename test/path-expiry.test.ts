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
 * oven does. Path stops and retires the slice it just made and fails naming that oven, as delegate runs do.
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

/** The slice the stub made is stopped and then retired, nothing else is asked of it, and the failure names the oven. */
async function refused(attempt: Promise<unknown>) {
	calls = [];
	const error = await attempt.then(() => assert.fail("Path accepted a slice that never expires"), (e) => e);
	assert.ok(error instanceof OvenIgnoresExpiry, String(error));
	assert.equal(error.url, OLD_OVEN);
	const create = calls.findIndex((c) => c.tool === "create");
	assert.ok(create >= 0 && calls[create]!.args.expires?.idle === "1h", "the create asked for expiry");
	const slice = error.slice;
	assert.match(error.message, new RegExp(`^oven at ${OLD_OVEN} did not keep expires \\{"idle":"1h"\\} \\(it answered no expires\\): it predates slice expiry and needs updating, or its slices never expire\\. its slice ${slice} was stopped and retired\\.$`));
	assert.deepEqual(calls.slice(create + 1), [{ tool: "stop", args: { slice } }, { tool: "retire", args: { slices: [slice] } }], "stopped, retired, and nothing more");
}

test("Path's tracking slice on an oven that ignores expires is stopped, retired and refused, naming the oven", async () => {
	const client = new MomClient(context, { flags: { "mom-model": "fixture/fixture" }, changed() {}, publish() {}, notify() {} });
	try {
		await refused(client.ensure());
		assert.equal(client.slice, undefined, "Path holds no slice");
	} finally { client.close(); }
});

test("Path's rebuild slice on an oven that ignores expires is stopped, retired and refused, naming the oven", async () => {
	await refused(rebuildMap(context, identityOf(context.sessionManager, dir), { "mom-model": "fixture/fixture" }, () => {}, new AbortController().signal));
});
