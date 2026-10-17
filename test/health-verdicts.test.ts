import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RunCompletion } from "../src/completion.ts";
import { findLoop, type HealthInput, runHealth, SILENT_MS } from "../src/health.ts";
import { healthAlert, type Run, runs, state } from "../src/pi-backend.ts";
import { boardLine } from "../src/render.ts";

const start = 1_700_000_000_000;
const calls = (...list: [string, Record<string, unknown>][]) => list.map(([name, args], i) => ({ name, args, at: start + i * 1000 }));
const input = (extra: Partial<HealthInput> = {}): HealthInput => ({ status: "running", segmentStartedAt: start, timeoutMs: 20 * 60_000, lastProgressAt: start, ...extra });
const read = (path = "a.ts") => ["read", { path }] as [string, Record<string, unknown>];

test("looping: the same tool and arguments 4x among the last calls, argument order aside", () => {
	const loop = calls(read(), ["read", { path: "b.ts" }], read(), ["bash", { command: "ls" }], read(), read());
	assert.deepEqual(findLoop(loop, start), { name: "read", count: 4 });
	assert.equal(runHealth(input({ toolCalls: loop }), start + 10_000).verdict, "looping");
	const reordered = calls(["grep", { pattern: "x", path: "." }], ["grep", { path: ".", pattern: "x" }], ["grep", { pattern: "x", path: "." }], ["grep", { path: ".", pattern: "x" }]);
	assert.equal(findLoop(reordered, start)?.count, 4);
});

test("not looping: 3 repeats, other arguments, calls from an earlier segment, or a write in the window", () => {
	assert.equal(findLoop(calls(read(), read(), read()), start), undefined);
	assert.equal(findLoop(calls(read("a"), read("b"), read("c"), read("d")), start), undefined);
	assert.equal(findLoop(calls(read(), read(), read(), read()), start + 1500), undefined, "two of them before the segment");
	assert.equal(findLoop(calls(read(), read(), ["edit", { path: "a.ts", oldText: "x", newText: "y" }], read(), read()), start), undefined, "files grew");
	// Only the last 8 calls count: the old repeats roll out.
	assert.equal(findLoop(calls(read(), read(), read(), read(), ...Array.from({ length: 8 }, (_, i) => read(`f${i}`))), start), undefined);
});

test("no-artifact: a writer with no files and no edit/write after 40% of its budget", () => {
	const at40 = start + 8 * 60_000;
	const writer = input({ writer: true, changedFiles: [], toolCalls: calls(read("a"), read("b")), lastProgressAt: at40 - 1000 });
	assert.equal(runHealth(writer, at40 - 1).verdict, "moving");
	assert.equal(runHealth(writer, at40).verdict, "no-artifact");
	assert.equal(runHealth({ ...writer, writer: false }, at40).verdict, "moving", "a reader owes no files");
	assert.equal(runHealth({ ...writer, changedFiles: ["a"] }, at40).verdict, "moving");
	assert.equal(runHealth({ ...writer, toolCalls: calls(["write", { path: "a" }]) }, at40).verdict, "moving");
});

test("priority: retrying > looping > silent > no-artifact > slow > moving", () => {
	const loop = calls(read(), read(), read(), read());
	const late = start + 10 * 60_000; // silent (no progress since start), past 40% of the budget
	const all = input({ writer: true, changedFiles: [], toolCalls: loop, turnStartedAt: start, providerRetry: { attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "x", startedAt: start } });
	assert.equal(runHealth(all, late).verdict, "retrying");
	assert.equal(runHealth({ ...all, providerRetry: undefined }, late).verdict, "looping");
	assert.equal(runHealth({ ...all, providerRetry: undefined, toolCalls: [] }, late).verdict, "silent");
	assert.equal(runHealth({ ...all, providerRetry: undefined, toolCalls: [], lastProgressAt: late - 1000 }, late).verdict, "no-artifact");
	assert.equal(runHealth({ ...all, providerRetry: undefined, toolCalls: [], lastProgressAt: late - 1000, writer: false }, late).verdict, "slow");
	assert.ok(SILENT_MS < 10 * 60_000);
});

test("the board shows the new verdicts, oven runs included", () => {
	const base = { id: "w", task: "T", role: "worker", status: "running", durationMs: 0, changedFiles: [] as string[], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		segmentStartedAt: start, timeoutMs: 20 * 60_000, lastProgressAt: start + 9 * 60_000 };
	assert.match(boardLine({ ...base, toolCalls: calls(read(), read(), read(), read()) } as any, start + 9 * 60_000), / · looping · /);
	assert.match(boardLine({ ...base, writer: true, runtime: "oven" } as any, start + 9 * 60_000), / · no-artifact · /);
	assert.match(boardLine({ ...base, runtime: "oven", lastProgressAt: start } as any, start + 9 * 60_000), / · silent · /, "an oven run gets a verdict");
});

function fixture(id: string) {
	const sent: any[] = [];
	const key = `owner-${id}`;
	state.owners.set(key, { key, dir: "", queued: new Set(), closed: false,
		binding: { pi: { sendMessage: (message: any) => sent.push(message), events: { emit() {} } }, ctx: {} } as any });
	const run = { id, ownerKey: key, status: "running", completion: new RunCompletion(), segment: 1, segmentStartedAt: start, timeoutMs: 20 * 60_000, lastProgressAt: start,
		output: "", changedFiles: [], toolCalls: [], activeTools: new Map(), writer: false } as unknown as Run;
	return { run, sent, done() { state.owners.delete(key); runs.delete(id); } };
}

test("the watchdog says looping and no-artifact once each, then nothing until the run moves", (t) => {
	const { run, sent, done } = fixture("verdict-a");
	t.after(done);
	run.toolCalls = calls(read(), read(), read(), read());
	healthAlert(run, start + 10_000);
	healthAlert(run, start + 40_000);
	assert.equal(sent.length, 1);
	assert.match(sent[0].content, /^delegate alert: verdict-a looping: same `read` call 4x, ends \d\d:\d\d \(20 min left\)\. Check it or steer\.$/);
	run.toolCalls = [];
	run.writer = true;
	run.lastProgressAt = start + 8 * 60_000;
	healthAlert(run, start + 8 * 60_000);
	assert.equal(sent.length, 2, "a new verdict is a new transition");
	assert.match(sent[1].content, /^delegate alert: verdict-a no-artifact: no files written after 40% of budget, ends \d\d:\d\d \(12 min left\)\. Check it or steer\.$/);
	healthAlert(run, start + 8 * 60_000 + 30_000);
	assert.equal(sent.length, 2, "no repeat while it holds");
	run.toolCalls = calls(read(), read(), read(), read());
	healthAlert(run, start + 8 * 60_000 + 60_000);
	run.toolCalls = [];
	healthAlert(run, start + 8 * 60_000 + 90_000);
	assert.equal(sent.length, 2, "back to a verdict already told: no repeat");
	run.changedFiles = ["a.ts"];
	healthAlert(run, start + 8 * 60_000 + 120_000);
	assert.equal(run.alerted, undefined, "moving again resets");
});
