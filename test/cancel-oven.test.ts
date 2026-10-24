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

const TUI_HALT = { kind: "tui", state: "running", status: { state: "working" }, process: { state: "running", pid: 1 } };
const TUI_STOP = { kind: "tui", state: "stopped", status: { state: "" }, process: { state: "exited" } };

test("cancel of a durable slice halted to idle sends oven_halt with its slice id and says stopped", async (t) => {
	const oven = await stubOven((tool) => tool === "halt" ? { id: "s-idle", state: "idle", stage: "idle" } : {});
	t.after(() => { oven.close(); runs.delete("idle"); });
	const run = ovenRun("idle", { sliceId: "s-idle" });
	await cancelRun(run);
	assert.deepEqual(oven.calls.map((c) => c.tool), ["halt"]);
	assert.deepEqual(oven.calls[0].args, { slice: "s-idle" });
	assert.equal(run.status, "cancelled");
	assert.match(cancelText(run), /idle stopped; automatic revival is disabled/);
});

test("a tui cancel counts the halt as sent (its answer reads running) and says stopped on oven_stop's answer", async (t) => {
	const oven = await stubOven((tool) => tool === "halt" ? TUI_HALT : tool === "stop" ? TUI_STOP : {});
	t.after(() => { oven.close(); runs.delete("tui"); });
	const run = ovenRun("tui", { sliceId: "s-tui", tui: "claude" } as unknown as Partial<Run>);
	await cancelRun(run);
	assert.deepEqual(oven.calls.map((c) => c.tool), ["halt", "stop"]);
	assert.match(cancelText(run), /tui stopped; automatic revival is disabled/);
});

test("a tui cancel whose stop leaves the process running is not confirmed", async (t) => {
	const oven = await stubOven((tool) => tool === "halt" ? TUI_HALT : { ...TUI_STOP, state: "running", process: { state: "running", pid: 1 } });
	t.after(() => { oven.close(); runs.delete("tuib"); });
	const run = ovenRun("tuib", { sliceId: "s-tui", tui: "claude" } as unknown as Partial<Run>);
	await cancelRun(run);
	assert.match(cancelText(run), /did not confirm the halt: oven answered the stop of slice s-tui with state running, process running/);
});

test("a preparing durable slice (halt answers running at copying) is followed by oven_stop, and confirmed only by its answer", async (t) => {
	const oven = await stubOven((tool) => tool === "halt" ? { id: "s-prep", state: "running", stage: "copying" } : tool === "stop" ? { id: "s-prep", state: "stopped", stage: "copying" } : {});
	t.after(() => { oven.close(); runs.delete("prep"); });
	const run = ovenRun("prep", { sliceId: "s-prep" });
	await cancelRun(run);
	assert.deepEqual(oven.calls.map((c) => [c.tool, c.args.slice]), [["halt", "s-prep"], ["stop", "s-prep"]]);
	assert.match(cancelText(run), /prep stopped;/);
});

test("a preparing slice whose stop fails is reported, not hidden", async (t) => {
	const oven = await stubOven((tool) => { if (tool === "stop") throw new Error("no such slice"); return { id: "s-prep", state: "running", stage: "starting" }; });
	t.after(() => { oven.close(); runs.delete("prepf"); });
	const run = ovenRun("prepf", { sliceId: "s-prep" });
	await cancelRun(run);
	assert.match(cancelText(run), /did not confirm the halt: stop failed: oven: no such slice/);
});

test("a durable halt answered running mid-turn is read again once; still running is unconfirmed, idle is confirmed", async (t) => {
	let after = "running";
	const oven = await stubOven((tool) => tool === "halt" ? { id: "s-r", state: "running", stage: "working" } : tool === "status" ? { id: "s-r", state: after, stage: after } : {});
	t.after(() => { oven.close(); runs.delete("race"); });
	const run = ovenRun("race", { sliceId: "s-r" });
	await cancelRun(run);
	assert.deepEqual(oven.calls.map((c) => c.tool), ["halt", "status"]);
	assert.match(cancelText(run), /did not confirm the halt: oven answered the halt but still reports slice s-r running/);
	after = "idle";
	await cancelRun(run);
	assert.match(cancelText(run), /race stopped;/);
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

test("a cancel while oven_create has not answered halts the slice the moment its id arrives", async (t) => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => { release = resolve; });
	const oven = await stubOven(async (tool) => {
		if (tool === "create") { await held; return { id: "s-late", state: "running", stage: "copying", turns: 0 }; }
		if (tool === "halt") return { id: "s-late", state: "running", stage: "copying" };
		if (tool === "stop") return { id: "s-late", state: "stopped", stage: "copying" };
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
	assert.deepEqual(oven.calls.filter((c) => c.tool === "halt" || c.tool === "stop").map((c) => [c.tool, c.args.slice]), [["halt", "s-late"], ["stop", "s-late"]], "halt and stop, each once");
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
