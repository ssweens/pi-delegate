import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RunCompletion } from "../src/completion.ts";
import { BROWSE_CALLS, clock, findLoop, FIRST_DELIVERABLE_MS, firstDeliverableAt, type HealthInput, runHealth, SILENT_MS } from "../src/health.ts";
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

test("first deliverable: a writer's default is 25% of its budget, within 6-15 min and half the budget; a reader has none", () => {
	const min = 60_000;
	assert.equal(firstDeliverableAt({ segmentStartedAt: start, timeoutMs: 20 * min, writer: true }), start + 6 * min, "25% of 20 min is under the 6 min floor");
	assert.equal(firstDeliverableAt({ segmentStartedAt: start, timeoutMs: 15 * min, writer: true }), start + 6 * min, "the default 15 min budget: 6 min, not 3.75");
	assert.equal(firstDeliverableAt({ segmentStartedAt: start, timeoutMs: 8 * min, writer: true }), start + 4 * min, "never later than half the budget");
	assert.equal(firstDeliverableAt({ segmentStartedAt: start, timeoutMs: 40 * min, writer: true }), start + 10 * min, "25% of 40 min");
	assert.equal(firstDeliverableAt({ segmentStartedAt: start, timeoutMs: 60 * min, writer: true }), start + 15 * min, "the 25% cap hits 15 min exactly");
	assert.equal(firstDeliverableAt({ segmentStartedAt: start, timeoutMs: 180 * min, writer: true }), start + FIRST_DELIVERABLE_MS, "15 min on a long budget");
	assert.equal(firstDeliverableAt({ segmentStartedAt: start, timeoutMs: 180 * min, writer: false }), undefined);
	assert.equal(firstDeliverableAt({ segmentStartedAt: start, timeoutMs: 180 * min, writer: true, firstDeliverableMin: 40 }), start + 40 * min, "the call's value wins");
	assert.equal(firstDeliverableAt({ segmentStartedAt: start, timeoutMs: 180 * min }), undefined);
	assert.equal(firstDeliverableAt({ segmentStartedAt: start + 7 * min, timeoutMs: 180 * min, firstDeliverableMin: 2 }), start + 9 * min, "a reader with one set, from its segment's start");
});

test("no-artifact: a writer with no files and no edit/write once its first deliverable is due", () => {
	const due = start + 6 * 60_000; // the 6 min floor of a 20 min budget
	const writer = input({ writer: true, changedFiles: [], toolCalls: calls(read("a"), read("b")), lastProgressAt: due - 1000 });
	assert.equal(runHealth(writer, due - 1).verdict, "moving");
	assert.equal(runHealth(writer, due - 1).dueAt, due, "the deadline shows while it is pending");
	assert.equal(runHealth(writer, due).verdict, "no-artifact");
	assert.equal(runHealth({ ...writer, writer: false }, due).verdict, "moving", "a reader owes no files");
	assert.equal(runHealth({ ...writer, writer: false, firstDeliverableMin: 1 }, due).verdict, "moving", "nor with a deadline set");
	assert.equal(runHealth({ ...writer, changedFiles: ["a"] }, due).verdict, "moving");
	assert.equal(runHealth({ ...writer, changedFiles: ["a"] }, due).dueAt, undefined, "nothing is due once it wrote");
	assert.equal(runHealth({ ...writer, toolCalls: calls(["write", { path: "a" }]) }, due).verdict, "moving");
	// An explicit deadline moves it either way.
	assert.equal(runHealth({ ...writer, firstDeliverableMin: 10, lastProgressAt: due + 3 * 60_000 }, due + 3 * 60_000).verdict, "moving");
	assert.equal(runHealth({ ...writer, firstDeliverableMin: 10, lastProgressAt: due + 3 * 60_000 }, due + 4 * 60_000).verdict, "no-artifact");
	assert.equal(runHealth({ ...writer, firstDeliverableMin: 2, lastProgressAt: start + 2 * 60_000 }, start + 2 * 60_000).verdict, "no-artifact");
});

/** `n` reads of different files, after `first`, one second apart, so none of them loops. */
const reads = (n: number, ...first: [string, Record<string, unknown>][]) => calls(...first, ...Array.from({ length: n }, (_, i) => read(`f${i}.ts`)));
const edit = ["edit", { path: "a.ts", oldText: "x", newText: "y" }] as [string, Record<string, unknown>];

test("browsing: a writer's last 25 calls without an edit, once it has edited or its deadline passed", () => {
	const early = start + 60_000; // before the 6 min deadline
	const late = start + 6 * 60_000;
	const after = (toolCalls: HealthInput["toolCalls"], now: number, extra: Partial<HealthInput> = {}) =>
		runHealth(input({ writer: true, changedFiles: [], toolCalls, lastProgressAt: now - 1000, ...extra }), now).verdict;
	assert.equal(BROWSE_CALLS, 25);
	assert.equal(after(reads(BROWSE_CALLS, edit), early), "browsing", "edited, then 25 calls without another");
	assert.equal(after(reads(BROWSE_CALLS - 1, edit), early), "moving", "24 is under the threshold");
	assert.equal(after([...reads(BROWSE_CALLS, edit), ...calls(edit).map((c) => ({ ...c, at: start + 30_000 }))], early), "moving", "an edit among the last 25");
	assert.equal(after(reads(40), early), "moving", "before its first edit and its deadline it is expected to read");
	assert.equal(after(reads(40), late), "no-artifact", "past the deadline with nothing written is no-artifact, ahead of browsing");
	assert.equal(after(reads(40), early, { changedFiles: ["a.ts"] }), "moving", "files from an earlier segment do not end this segment's reading time");
	assert.equal(after(reads(40), late, { changedFiles: ["a.ts"] }), "browsing", "past the deadline it is");
	assert.equal(after(reads(40, edit), late, { writer: false }), "moving", "a reader is never browsing");
	assert.equal(after(reads(BROWSE_CALLS, edit).map((c) => ({ ...c, at: c.at - 60_000 })), early), "moving", "calls from an earlier segment do not count");
});

test("priority: retrying > looping > silent > no-artifact > browsing > slow > moving", () => {
	const loop = calls(read(), read(), read(), read());
	const late = start + 10 * 60_000; // silent (no progress since start), past the 6 min deadline
	const all = input({ writer: true, changedFiles: [], toolCalls: loop, turnStartedAt: start, providerRetry: { attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "x", startedAt: start } });
	assert.equal(runHealth(all, late).verdict, "retrying");
	assert.equal(runHealth({ ...all, providerRetry: undefined }, late).verdict, "looping");
	assert.equal(runHealth({ ...all, providerRetry: undefined, toolCalls: [] }, late).verdict, "silent");
	const fresh = { ...all, providerRetry: undefined, lastProgressAt: late - 1000 };
	assert.equal(runHealth({ ...fresh, toolCalls: reads(30) }, late).verdict, "no-artifact");
	assert.equal(runHealth({ ...fresh, toolCalls: reads(30, edit) }, late).verdict, "browsing");
	assert.equal(runHealth({ ...fresh, toolCalls: reads(3, edit) }, late).verdict, "slow");
	assert.equal(runHealth({ ...fresh, toolCalls: [], writer: false }, late).verdict, "slow");
	assert.equal(runHealth({ ...fresh, toolCalls: [], writer: false, turnStartedAt: undefined }, late).verdict, "moving");
	assert.ok(SILENT_MS < 10 * 60_000);
});

test("the board shows the new verdicts, oven runs included", () => {
	const base = { id: "w", task: "T", role: "worker", status: "running", durationMs: 0, changedFiles: [] as string[], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		segmentStartedAt: start, timeoutMs: 20 * 60_000, lastProgressAt: start + 9 * 60_000 };
	assert.match(boardLine({ ...base, toolCalls: calls(read(), read(), read(), read()) } as any, start + 9 * 60_000), / · looping · /);
	assert.match(boardLine({ ...base, writer: true, runtime: "oven" } as any, start + 9 * 60_000), new RegExp(` · no-artifact · 9m/20m \\(ends \\d\\d:\\d\\d\\) · first deliverable was due ${clock(start + 6 * 60_000)} · `));
	assert.match(boardLine({ ...base, writer: true } as any, start + 4 * 60_000), new RegExp(` · moving · .* · first deliverable due ${clock(start + 6 * 60_000)} · `), "pending, it shows when");
	assert.doesNotMatch(boardLine({ ...base } as any, start + 4 * 60_000), /first deliverable/, "a reader has none");
	assert.match(boardLine({ ...base, writer: true, toolCalls: reads(25, edit), lastProgressAt: start + 60_000 } as any, start + 60_000), / · browsing · .* · 25 calls without an edit · /);
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
	assert.equal(sent[1].content.replace(/ends \d\d:\d\d/, "ends HH:MM"), `delegate alert: verdict-a no-artifact: no files written; first deliverable was due ${clock(start + 6 * 60_000)}, ends HH:MM (12 min left). Check it or steer.`);
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

test("the watchdog says browsing once, naming the cause and the action", (t) => {
	const { run, sent, done } = fixture("verdict-b");
	t.after(done);
	run.writer = true;
	run.toolCalls = reads(BROWSE_CALLS, edit);
	run.lastProgressAt = start + 60_000;
	healthAlert(run, start + 60_000);
	healthAlert(run, start + 90_000);
	assert.equal(sent.length, 1);
	assert.match(sent[0].content, /^delegate alert: verdict-b browsing: 25 calls without an edit; send it the fact it is missing or ask for the deliverable now\. Run ends \d\d:\d\d \(19 min left\)\.$/);
	run.toolCalls = [...run.toolCalls, { ...run.toolCalls[0]!, at: start + 100_000 }];
	healthAlert(run, start + 100_000);
	assert.equal(run.alerted, undefined, "an edit moves it again");
});
