import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { boardLine, onBoard, type BoardRun } from "../src/render.ts";

const now = 1_700_000_000_000;
const run = (extra: Partial<BoardRun> = {}): BoardRun => ({
	id: "worker-abc", task: "RPI rerun\nbody", role: "worker", status: "running", durationMs: 14 * 60_000, changedFiles: ["a", "b", "c"],
	tokens: { input: 1, output: 52_000, cacheRead: 0, cacheWrite: 0 }, lastTool: "write",
	segmentStartedAt: now - 14 * 60_000, timeoutMs: 25 * 60_000, lastProgressAt: now - 5 * 60_000, turnStartedAt: now - 312_000, ...extra,
});

test("an active run reads as one plain line: title, verdict, budget, progress, files, tokens, last tool", () => {
	const line = boardLine(run({ lastProgressAt: now - 7 * 60_000 }), now);
	assert.doesNotMatch(line, /\n|\x1b/);
	assert.match(line, /^RPI rerun · silent · 14m\/25m \(ends \d\d:\d\d\) · last output 7m00s ago · turn 5m12s · 3 files · out 52\.0k · last: write · id worker-abc$/);
	assert.match(boardLine(run({ lastProgressAt: now - 10_000, turnStartedAt: now - 10_000 }), now), / · moving · /);
	assert.match(boardLine(run({ lastProgressAt: now - 10_000, turnStartedAt: now - 4 * 60_000 }), now), / · slow · /);
});

test("a child's extension request shows on its line", () => {
	assert.match(boardLine(run({ extendRequest: { minutes: 20, reason: "tests still running" } }), now), /asks \+20 min: tests still running/);
	assert.doesNotMatch(boardLine(run(), now), /asks/);
});

test("a settled run is terse: status, duration, files", () => {
	assert.equal(boardLine(run({ status: "complete", durationMs: 125_000 }), now), "RPI rerun · complete · 2m05s · 3 files · id worker-abc");
});

test("the board lists active and unacknowledged runs, and acknowledged ones only if settled since the last prompt", () => {
	assert.equal(onBoard({ status: "running", acknowledged: true }, now), true);
	assert.equal(onBoard({ status: "complete", acknowledged: false, endedAt: now - 1000 }, now), true, "unread result stays");
	assert.equal(onBoard({ status: "complete", acknowledged: true, endedAt: now - 1000 }, now), false, "read and older than the prompt: gone");
	assert.equal(onBoard({ status: "complete", acknowledged: true, endedAt: now + 1000 }, now), true, "settled after the prompt");
});
