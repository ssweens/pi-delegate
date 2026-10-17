import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { RunCompletion } from "../src/completion.ts";
import { SILENT_MS, SLOW_TURN_MS, WRAP_UP_MIN_MS } from "../src/health.ts";
import { armTimeout, healthAlert, type Run, runs, salvage, state, trackProgress, wrapUpMessage } from "../src/pi-backend.ts";

/** A bound owner whose notices land in `sent`, and a running run it owns with a session that records steers. */
function fixture(id: string) {
	const sent: any[] = [], steers: string[] = [];
	const key = `owner-${id}`;
	state.owners.set(key, { key, dir: "", queued: new Set(), closed: false,
		binding: { pi: { sendMessage: (message: any) => sent.push(message), events: { emit() {} } }, ctx: {} } as any });
	const run = {
		id, ownerKey: key, status: "running", completion: new RunCompletion(), segment: 1, segmentStartedAt: Date.now(), timeoutMs: 20 * 60_000,
		output: "", changedFiles: [], toolCalls: [], activeTools: new Map(),
		session: { steer: async (message: string) => { steers.push(message); }, abort: async () => {} },
	} as unknown as Run;
	return { run, sent, steers, done() { state.owners.delete(key); runs.delete(id); } };
}

test("the wrap-up steer fires once, 15% of the budget or WRAP_UP_MIN_MS before the hard timeout", (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
	const { run, steers, done } = fixture("wrap-a");
	t.after(() => { run.status = "complete"; mock.timers.tick(30_000); mock.timers.reset(); done(); });
	run.segmentStartedAt = Date.now();
	run.timeoutMs = 40 * 60_000; // 15% = 6 min, more than WRAP_UP_MIN_MS.
	armTimeout(run);
	mock.timers.tick(34 * 60_000 - 1);
	assert.equal(steers.length, 0);
	mock.timers.tick(1);
	assert.equal(steers.length, 1);
	assert.equal(steers[0], wrapUpMessage(6 * 60_000));
	assert.match(steers[0], /^6 min left in your budget\. Stop starting new work.*EXTEND: <minutes> - <reason>\.$/);
	mock.timers.tick(6 * 60_000 - 1);
	assert.equal(steers.length, 1, "once per arming");
	assert.equal(run.status, "running");
	mock.timers.tick(1);
	assert.equal(run.status, "timeout", "the hard timeout stays");
	assert.equal(steers.length, 1);
});

test("a budget shorter than the wrap-up lead gets no wrap-up; a short one uses WRAP_UP_MIN_MS", (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
	const { run, steers, done } = fixture("wrap-b");
	t.after(() => { run.status = "complete"; mock.timers.tick(30_000); mock.timers.reset(); done(); });
	run.timeoutMs = WRAP_UP_MIN_MS;
	armTimeout(run);
	mock.timers.tick(WRAP_UP_MIN_MS - 1);
	assert.equal(steers.length, 0);
	run.status = "running";
	run.segmentStartedAt = Date.now();
	run.timeoutMs = 10 * 60_000; // 15% = 1.5 min, under the 3 min floor.
	armTimeout(run);
	mock.timers.tick(7 * 60_000);
	assert.deepEqual(steers, [wrapUpMessage(WRAP_UP_MIN_MS)]);
	run.completion.settle({} as any);
	armTimeout(run); // Re-armed, but a settled run is never steered.
	mock.timers.tick(3 * 60_000);
	assert.equal(steers.length, 1);
});

test("an EXTEND line is recorded, capped, and alerts the owner once", (t) => {
	const { run, sent, done } = fixture("extend-a");
	t.after(done);
	const message = (text: string) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
	trackProgress(run, { type: "message_start", message: { role: "assistant" } }, 100);
	assert.equal(run.turnStartedAt, 100);
	trackProgress(run, { type: "message_update", message: { role: "assistant" } }, 150);
	trackProgress(run, message("Report so far.\nEXTEND: 10 - the suite needs one more run"), 200);
	assert.equal(run.turnStartedAt, undefined);
	assert.equal(run.lastProgressAt, 200);
	assert.deepEqual(run.extendRequest, { minutes: 10, reason: "the suite needs one more run", at: 200 });
	assert.equal(sent.length, 1);
	assert.equal(sent[0].content, `delegate alert: extend-a asks +10 min: the suite needs one more run. Grant with delegate_ctl steer runId=extend-a timeoutMs=600000 (time from now), or let it end.`);
	assert.deepEqual(sent[0].details, { kind: "extend-request", runId: "extend-a" });
	trackProgress(run, message("No request here."), 300);
	assert.equal(sent.length, 1);
	trackProgress(run, message("EXTEND: 500 — huge"), 400);
	assert.equal(run.extendRequest?.minutes, 60);
	trackProgress(run, { type: "tool_execution_start" }, 500);
	assert.equal(run.lastProgressAt, 500);
	run.status = "timeout";
	trackProgress(run, message("EXTEND: 5 - too late"), 600);
	assert.equal(sent.length, 2, "a run no longer running asks nobody");
});

test("the watchdog alerts once per transition out of moving, never for moving", (t) => {
	const { run, sent, done } = fixture("watch-a");
	t.after(done);
	const start = run.segmentStartedAt;
	run.lastProgressAt = start;
	healthAlert(run, start + 60_000);
	assert.equal(sent.length, 0);
	healthAlert(run, start + SILENT_MS + 1);
	healthAlert(run, start + SILENT_MS + 30_000);
	assert.equal(sent.length, 1);
	assert.match(sent[0].content, /^delegate alert: watch-a silent: no output for 6m, ends \d\d:\d\d \(14 min left\)\. Check it or steer\.$/);
	run.turnStartedAt = start + SILENT_MS + 30_000;
	healthAlert(run, start + SILENT_MS + 60_000);
	assert.equal(sent.length, 1, "still not moving: no second alert");
	run.lastProgressAt = start + 7 * 60_000;
	healthAlert(run, start + 7 * 60_000 + 1);
	assert.equal(sent.length, 1, "moving again resets, silently");
	healthAlert(run, run.turnStartedAt + SLOW_TURN_MS + 1);
	assert.equal(sent.length, 2);
	assert.match(sent[1].content, /watch-a slow: no output for \dm, turn open 3m, ends/);
	run.turnStartedAt = undefined;
	run.lastProgressAt = Date.now() + 10 * 60_000;
	healthAlert(run, run.lastProgressAt);
	run.providerRetry = { attempt: 2, maxAttempts: 3, delayMs: 1000, errorMessage: "overloaded", startedAt: 0 };
	healthAlert(run, run.lastProgressAt + 1);
	assert.match(sent[2].content, /watch-a retrying: .*provider retry 2\/3 \(overloaded\)/);
});

test("the watchdog interval finds running runs and stops when none is left", (t) => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
	const { run, sent, done } = fixture("watch-b");
	t.after(() => { mock.timers.reset(); done(); });
	runs.set(run.id, run);
	run.timeoutMs = 60 * 60_000;
	armTimeout(run);
	mock.timers.tick(SILENT_MS + 30_000);
	assert.equal(sent.filter((m) => m.details.kind === "watchdog").length, 1);
	mock.timers.tick(5 * 30_000);
	assert.equal(sent.filter((m) => m.details.kind === "watchdog").length, 1);
	run.status = "complete";
	mock.timers.tick(30_000); // Nothing running: the interval clears itself.
});

test("salvage reads last words, changes, last five tools, and how to resume", () => {
	const { run, done } = fixture("salvage-a");
	done();
	run.output = "x".repeat(700);
	run.changedFiles = ["src/a.ts", "src/b.ts"];
	run.toolCalls = ["one", "two", "three", "four", "five", "six"].map((name, i) => ({ name: i % 2 ? "bash" : "read", args: i % 2 ? { command: `echo ${name}` } : { path: `${name}.ts` }, at: i }));
	const text = salvage(run);
	assert.match(text, new RegExp(`last words: x{600}\\n`));
	assert.match(text, /changed: src\/a\.ts, src\/b\.ts/);
	assert.match(text, /last tools: bash echo two; read three\.ts; bash echo four; read five\.ts; bash echo six/);
	assert.match(text, /Resume: delegate_ctl steer runId=salvage-a timeoutMs=<ms from now> message=<what remains>$/);
});
