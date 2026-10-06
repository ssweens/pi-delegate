import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultOvenSocket, ovenCli, ovenRequest } from "../src/oven.ts";

const env = (vars: Record<string, string | undefined>) => {
	const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
	for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
	return () => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
};

test("oven's CLI is OVEN_CLI, else `oven` on PATH; pi-delegate has no oven dependency", () => {
	const restore = env({ OVEN_CLI: undefined });
	try {
		assert.deepEqual(ovenCli(), { command: "oven", args: [] });
		process.env.OVEN_CLI = "/somewhere/oven";
		assert.deepEqual(ovenCli(), { command: "/somewhere/oven", args: [] });
	} finally { restore(); }
});

test("with no oven CLI, a running oven is reached at oven's own default socket", async () => {
	const state = mkdtempSync(join(tmpdir(), "pd-oven-"));
	const restore = env({ OVEN_CLI: join(state, "no-such-oven"), OVEN_SOCKET: undefined, XDG_RUNTIME_DIR: undefined, XDG_STATE_HOME: state });
	const server = createServer((conn) => conn.on("data", () => conn.end(`${JSON.stringify({ ok: true, value: { pong: true } })}\n`)));
	try {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(state, "oven"), { recursive: true });
		await new Promise<void>((resolve) => server.listen(defaultOvenSocket(), resolve));
		assert.deepEqual(await ovenRequest({ op: "status" }), { pong: true });
	} finally { server.close(); restore(); rmSync(state, { recursive: true, force: true }); }
});

test("with no oven running and no CLI, runtime oven fails with a message naming what's needed", async () => {
	const state = mkdtempSync(join(tmpdir(), "pd-oven-"));
	const restore = env({ OVEN_CLI: join(state, "no-such-oven"), OVEN_SOCKET: undefined, XDG_RUNTIME_DIR: undefined, XDG_STATE_HOME: state });
	try {
		await assert.rejects(ovenRequest({ op: "status" }), /runtime "oven" needs oven: it is not running and its CLI is not installed/);
	} finally { restore(); rmSync(state, { recursive: true, force: true }); }
});
