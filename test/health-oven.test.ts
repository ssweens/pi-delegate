import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RunCompletion } from "../src/completion.ts";
import { runHealth } from "../src/health.ts";
import { type Run, runs, state, trackOven } from "../src/pi-backend.ts";

const start = 1_700_000_000_000;

function fixture(id: string) {
	const sent: any[] = [];
	const key = `owner-${id}`;
	state.owners.set(key, { key, dir: "", queued: new Set(), closed: false,
		binding: { pi: { sendMessage: (message: any) => sent.push(message), events: { emit() {} } }, ctx: {} } as any });
	const run = { id, ownerKey: key, runtime: "oven", sliceId: "s1", status: "running", completion: new RunCompletion(), segment: 1, segmentStartedAt: start, timeoutMs: 20 * 60_000,
		lastProgressAt: start, turns: 0, revision: 0, output: "", changedFiles: [], toolCalls: [], activeTools: new Map(), writer: true } as unknown as Run;
	return { run, sent, done() { state.owners.delete(key); runs.delete(id); } };
}

const tool = (callId: string, name: string, args: unknown, status: "running" | "done", extra = {}) => ({ type: "tool", tool: { callId, name, args, output: "", status, ...extra } });

test("oven_watch events feed an oven run's progress: turns, tool calls, last tool, changed files", (t) => {
	const { run, done } = fixture("oven-a");
	t.after(done);
	trackOven(run, { type: "snapshot", slice: { id: "s1", state: "running", turns: 2 }, messages: [], tools: [] }, start + 1000);
	assert.equal(run.turns, 2);
	trackOven(run, { type: "partial", message: { role: "assistant", content: [] } }, start + 2000);
	assert.equal(run.turnStartedAt, start + 2000);
	trackOven(run, { type: "partial", message: { role: "assistant", content: [{ type: "text", text: "more" }] } }, start + 3000);
	assert.equal(run.turnStartedAt, start + 2000, "the answer streaming on keeps the turn's start");
	trackOven(run, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "going" }] } }, start + 4000);
	assert.equal(run.turnStartedAt, undefined);
	assert.equal(run.lastProgressAt, start + 4000);
	assert.equal(run.turns, 3);

	trackOven(run, tool("c1", "write", { path: "src/a.ts", content: "x" }, "running"), start + 5000);
	trackOven(run, tool("c1", "write", { path: "src/a.ts", content: "x" }, "running", { output: "..." }), start + 5500);
	assert.deepEqual(run.toolCalls, [{ name: "write", args: { path: "src/a.ts", content: "x" }, at: start + 5000 }], "output updates are not new calls");
	assert.equal(run.lastTool, "write");
	trackOven(run, tool("c1", "write", {}, "done"), start + 6000);
	assert.equal(run.lastProgressAt, start + 6000);
	assert.deepEqual(run.changedFiles, ["src/a.ts"]);
	assert.equal(run.activeTools.size, 0);
	trackOven(run, tool("c2", "edit", { path: "src/b.ts" }, "running"), start + 7000);
	trackOven(run, tool("c2", "edit", { path: "src/b.ts" }, "done", { isError: true }), start + 8000);
	assert.deepEqual(run.changedFiles, ["src/a.ts"], "a failed edit wrote nothing");
	trackOven(run, { type: "state", slice: { id: "s1", state: "running", turns: 7 } }, start + 9000);
	assert.equal(run.turns, 7);
});

test("an oven run gets real verdicts: moving while events arrive, silent and looping from them", (t) => {
	const { run, done } = fixture("oven-b");
	t.after(done);
	run.writer = false;
	assert.equal(runHealth(run, start + 7 * 60_000).verdict, "silent", "no events");
	trackOven(run, tool("r1", "read", { path: "a" }, "running"), start + 7 * 60_000);
	assert.equal(runHealth(run, start + 7 * 60_000 + 1).verdict, "moving");
	for (let i = 2; i <= 4; i++) trackOven(run, tool(`r${i}`, "read", { path: "a" }, "running"), start + 7 * 60_000 + i);
	assert.equal(runHealth(run, start + 7 * 60_000 + 10).verdict, "looping");
});

test("an EXTEND line in an oven slice's answer reaches its owner", (t) => {
	const { run, sent, done } = fixture("oven-c");
	t.after(done);
	trackOven(run, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Nearly there.\nEXTEND: 10 - tests" }] } }, start + 1000);
	assert.deepEqual(run.extendRequest, { minutes: 10, reason: "tests", at: start + 1000 });
	assert.equal(sent.length, 1);
});

test("a settled oven run ignores late events", (t) => {
	const { run, done } = fixture("oven-d");
	t.after(done);
	run.status = "complete";
	trackOven(run, tool("x", "read", {}, "running"), start + 1000);
	assert.equal(run.toolCalls.length, 0);
});
