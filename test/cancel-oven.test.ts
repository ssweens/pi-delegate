import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RunCompletion } from "../src/completion.ts";
import { type Run, cancelRun, cancelText, launchOven, PiBackend, runs } from "../src/pi-backend.ts";

/** A stub oven: records each oven_* call, answers by tool, and can hold or fail chosen ones. */
async function stubOven(answer: (tool: string, args: any) => unknown | Promise<unknown>) {
	const calls: { tool: string; args: any }[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", async () => {
			const rpc = JSON.parse(Buffer.concat(chunks).toString());
			const tool = String(rpc.params?.name).replace(/^oven_/, "");
			calls.push({ tool, args: rpc.params?.arguments });
			let result: any;
			try { result = { content: [{ type: "text", text: JSON.stringify(await answer(tool, rpc.params?.arguments)) }] }; }
			catch (error) { result = { isError: true, content: [{ type: "text", text: String((error as Error).message) }] }; }
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	process.env.OVEN_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	return { calls, close: () => { delete process.env.OVEN_URL; server.close(); } };
}

function ovenRun(id: string, extra: Partial<Run> = {}) {
	const run = { id, ownerKey: `owner-${id}`, runtime: "oven", status: "running", completion: new RunCompletion(), segment: 1, segmentStartedAt: Date.now(), timeoutMs: 60_000,
		lastProgressAt: Date.now(), turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, revision: 0, output: "", changedFiles: [], droppedTools: [], toolCalls: [], activeTools: new Map(), writer: true,
		recordPath: join(mkdtempSync(join(tmpdir(), "cancel-oven-")), "run.json"), tools: ["*"], role: "scout", model: "m", cwd: "/tmp", systemPrompt: "", ...extra } as unknown as Run;
	runs.set(id, run);
	return run;
}

test("cancel of a preparing oven run sends oven_halt with its slice id, and says stopped only on oven's confirmation", async (t) => {
	const oven = await stubOven((tool) => tool === "halt" ? { id: "s-prep", state: "stopped" } : {});
	t.after(() => { oven.close(); runs.delete("prep"); });
	const run = ovenRun("prep", { sliceId: "s-prep" });
	await cancelRun(run);
	assert.deepEqual(oven.calls.filter((c) => c.tool === "halt"), [{ tool: "halt", args: { slice: "s-prep" } }]);
	assert.equal(run.status, "cancelled");
	assert.match(cancelText(run), /prep stopped; automatic revival is disabled/);
});

test("a failing halt is reported by the cancel, not hidden", async (t) => {
	const oven = await stubOven((tool) => { if (tool === "halt") throw new Error("copy in progress"); return {}; });
	t.after(() => { oven.close(); runs.delete("failing"); });
	const run = ovenRun("failing", { sliceId: "s-fail" });
	await cancelRun(run);
	assert.equal(run.status, "cancelled");
	assert.match(cancelText(run), /cancel sent; oven did not confirm the halt: oven: copy in progress/);
	assert.doesNotMatch(cancelText(run), /stopped;/);
});

test("a halt answered with the slice still running is not confirmed", async (t) => {
	const oven = await stubOven((tool) => tool === "halt" ? { id: "s-run", state: "running", stage: "copying" } : {});
	t.after(() => { oven.close(); runs.delete("still"); });
	const run = ovenRun("still", { sliceId: "s-run" });
	await cancelRun(run);
	assert.match(cancelText(run), /did not confirm the halt: .*still reports slice s-run running \(stage copying\)/);
});

test("a cancel while oven_create has not answered halts the slice the moment its id arrives", async (t) => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	const oven = await stubOven(async (tool) => {
		if (tool === "create") { await held; return { id: "s-late", state: "running", stage: "copying", turns: 0 }; }
		if (tool === "halt") return { id: "s-late", state: "stopped" };
		return {};
	});
	t.after(() => { oven.close(); runs.delete("late"); });
	const run = ovenRun("late");
	const launched = launchOven(run, "task");
	while (!oven.calls.some((c) => c.tool === "create")) await new Promise((r) => setTimeout(r, 10));
	await cancelRun(run);
	assert.match(cancelText(run), /did not confirm the halt: oven has not yet returned this run's slice id/, "the caller is told, not given a false stopped");
	assert.equal(oven.calls.some((c) => c.tool === "halt"), false, "no id yet, so no halt could be sent");
	release();
	await launched;
	assert.deepEqual(oven.calls.filter((c) => c.tool === "halt"), [{ tool: "halt", args: { slice: "s-late" } }]);
	assert.equal(run.status, "cancelled");
	assert.equal(run.haltNote, undefined, "the late halt was confirmed");
});

test("close is refused with ACTION_UNSUPPORTED for both runtimes, in words that fit each, and points to cancel", async (t) => {
	t.after(() => { runs.delete("c-oven"); runs.delete("c-pi"); });
	const backend = new PiBackend({ owner: () => ({ key: "owner-x" }) } as any);
	ovenRun("c-oven", { ownerKey: "owner-x", sliceId: "s1" });
	ovenRun("c-pi", { ownerKey: "owner-x", runtime: "in-process" } as unknown as Partial<Run>);
	const oven = await backend.close("c-oven", {}).then(() => assert.fail("close succeeded"), (e) => e);
	const local = await backend.close("c-pi", {}).then(() => assert.fail("close succeeded"), (e) => e);
	for (const e of [oven, local]) { assert.equal(e.code, "ACTION_UNSUPPORTED"); assert.match(e.message, /use cancel|with cancel/); }
	assert.doesNotMatch(oven.message, /in-process/);
	assert.match(oven.message, /oven run's slice/);
	assert.match(local.message, /in-process run holds no external process or session/);
});
