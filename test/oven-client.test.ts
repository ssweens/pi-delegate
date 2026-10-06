import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const env = (vars: Record<string, string | undefined>) => {
	const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
	for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
	return () => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
};
/** A fresh copy of the client, so its once-per-process protocol check starts over. */
const client = async () => import(`../src/oven.ts?fresh=${Math.random()}`) as Promise<typeof import("../src/oven.ts")>;

async function server(protocol = 1) {
	const seen: any[] = [];
	const http = createServer(async (req, res) => {
		let body = ""; for await (const chunk of req) body += chunk;
		seen.push({ url: req.url, token: req.headers.authorization, body });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(req.url === "/health" ? JSON.stringify({ oven: true, ready: true, protocol, version: "t", pid: 1 }) : JSON.stringify({ ok: true, value: { pong: true } }));
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	return { seen, port: (http.address() as any).port as number, close: () => new Promise<void>((resolve) => http.close(() => resolve())) };
}

test("pi-delegate has no oven dependency: oven's URL is OVEN_URL, else oven.json's port on 127.0.0.1, else 6836", async () => {
	const config = mkdtempSync(join(tmpdir(), "pd-oven-"));
	const restore = env({ OVEN_URL: undefined, XDG_CONFIG_HOME: config });
	try {
		const { ovenUrl } = await client();
		assert.equal(ovenUrl(), "http://127.0.0.1:6836");
		mkdirSync(join(config, "oven"), { recursive: true });
		writeFileSync(join(config, "oven", "oven.json"), JSON.stringify({ port: 7001 }));
		assert.equal(ovenUrl(), "http://127.0.0.1:7001");
		process.env.OVEN_URL = "http://100.64.0.1:6836/";
		assert.equal(ovenUrl(), "http://100.64.0.1:6836");
	} finally { restore(); rmSync(config, { recursive: true, force: true }); }
	const pkg = JSON.parse((await import("node:fs")).readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert(!("oven" in { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }));
});

test("a running oven is reached with the local token from oven's XDG config dir, after a protocol check", async () => {
	const config = mkdtempSync(join(tmpdir(), "pd-oven-"));
	const oven = await server();
	const restore = env({ OVEN_URL: `http://127.0.0.1:${oven.port}`, OVEN_TOKEN: undefined, XDG_CONFIG_HOME: config });
	try {
		mkdirSync(join(config, "oven"), { recursive: true });
		writeFileSync(join(config, "oven", "token"), "local-secret\n");
		const { ovenRequest } = await client();
		assert.deepEqual(await ovenRequest("list", {}), { pong: true });
		assert.equal(oven.seen[0].url, "/health", "the protocol is checked first");
		assert.equal(oven.seen[1].url, "/api/list");
		assert.equal(oven.seen[1].token, "Bearer local-secret");
	} finally { restore(); await oven.close(); rmSync(config, { recursive: true, force: true }); }
});

test("an oven on another protocol is refused with a message naming both versions", async () => {
	const oven = await server(99);
	const restore = env({ OVEN_URL: `http://127.0.0.1:${oven.port}` });
	try {
		const { ovenRequest } = await client();
		await assert.rejects(ovenRequest("list", {}), /speaks protocol 99; pi-delegate speaks 1/);
		assert.equal(oven.seen.filter((r) => r.url !== "/health").length, 0, "no op was sent");
	} finally { restore(); await oven.close(); }
});

test("with no oven running, runtime oven fails with a message naming what's needed", async () => {
	const restore = env({ OVEN_URL: "http://127.0.0.1:9" });
	try {
		const { ovenRequest } = await client();
		await assert.rejects(ovenRequest("create", {}), /runtime "oven" needs oven, and nothing answers at http:\/\/127\.0\.0\.1:9\. Start it with `oven start`/);
	} finally { restore(); }
});
