import assert from "node:assert/strict";
import { test } from "node:test";
import { type Join, joinRuns, WAIT_POLL_MS, waitCancelled } from "../src/wait.ts";

interface Fake { id: string; settled: boolean; stranded?: boolean }

/** A join over fake runs: settle() wakes its next(), as a backend's settlement does. */
function fakeJoin(runs: Fake[], options: { lost?: boolean; fail?: Error } = {}) {
	let wake: (() => void) | undefined;
	const events: string[] = [];
	const join: Join<Fake> = {
		views: () => runs.map((run) => ({ id: run.id, settled: run.settled, view: { ...run } })),
		next: (_pending, ms) => {
			if (options.fail) return Promise.reject(options.fail);
			if (options.lost) return Promise.resolve(false);
			return new Promise((resolve) => { const timer = setTimeout(() => resolve(true), ms); wake = () => { clearTimeout(timer); resolve(true); }; });
		},
		stranded: () => runs.find((run) => run.stranded)?.id,
		claim: (settled) => { events.push(`claim:${settled.map((run) => run.id).join(",")}`); return settled.map((run) => ({ ...run, id: run.id, claimed: true } as Fake)); },
		release: (aborted) => { events.push(`release:${aborted}`); },
	};
	return { join, events, settle: (id: string) => { runs.find((run) => run.id === id)!.settled = true; wake?.(); } };
}

test("any returns on the first settled run, all waits for every one; views come back in the order asked, claimed", async () => {
	const a = { id: "a", settled: false }, b = { id: "b", settled: false };
	const first = fakeJoin([a, b]);
	setTimeout(() => first.settle("b"), 20);
	const any = await joinRuns([first.join], ["a", "b"], "any", { lost: "x" });
	assert.equal(any.reason, "settled");
	assert.deepEqual(any.settled.map((run) => [run.id, (run as any).claimed]), [["b", true]]);
	assert.deepEqual(any.pending.map((run) => run.id), ["a"]);
	assert.deepEqual(first.events, ["claim:b", "release:false"]);

	const other = { id: "c", settled: false };
	const second = fakeJoin([{ id: "a", settled: false }]), third = fakeJoin([other]);
	setTimeout(() => second.settle("a"), 10);
	setTimeout(() => third.settle("c"), 40);
	const all = await joinRuns([second.join, third.join], ["c", "a"], "all", { lost: "x" });
	assert.deepEqual(all.settled.map((run) => run.id), ["c", "a"], "several joins: one wait, in the order asked");
	assert.deepEqual(all.pending, []);
});

test("a timeout, queued messages and an abort end the wait only", async () => {
	const run = { id: "a", settled: false };
	const timed = fakeJoin([run]);
	const started = Date.now();
	const timeout = await joinRuns([timed.join], ["a"], "all", { timeoutMs: 50, lost: "x" });
	assert.equal(timeout.reason, "timeout");
	assert.ok(Date.now() - started < WAIT_POLL_MS, "a short timeout is not rounded up to a poll");
	assert.deepEqual(timed.events, ["release:false"]);

	let queued = false;
	setTimeout(() => { queued = true; }, 10);
	const interrupted = await joinRuns([fakeJoin([run]).join], ["a"], "all", { interrupted: () => queued, lost: "x" });
	assert.equal(interrupted.reason, "interrupted");

	const controller = new AbortController();
	const aborting = fakeJoin([run]);
	setTimeout(() => controller.abort(), 20);
	await assert.rejects(joinRuns([aborting.join], ["a"], "all", { signal: controller.signal, lost: "x" }), { name: "AbortError", message: "Wait cancelled; the child is unaffected." });
	assert.deepEqual(aborting.events, ["release:true"], "an aborted wait reports nothing, so its join redelivers");
	const early = fakeJoin([run]);
	await assert.rejects(joinRuns([early.join], ["a", "b"], "all", { signal: AbortSignal.abort(), lost: "x" }), { message: waitCancelled("runs").message });
	assert.deepEqual(early.events, ["release:true"]);
	assert.equal(run.settled, false, "nothing settled or cancelled the run");
});

test("a lost join, a stranded run and a failing join end the wait", async () => {
	const lost = await joinRuns([fakeJoin([{ id: "a", settled: false }], { lost: true }).join], ["a"], "all", { lost: "the coordinator" });
	assert.deepEqual([lost.reason, lost.lost, lost.stranded], ["lost", "the coordinator", undefined]);
	const stranded = await joinRuns([fakeJoin([{ id: "a", settled: false, stranded: true }]).join], ["a"], "all", { lost: "x" });
	assert.deepEqual([stranded.reason, stranded.lost, stranded.stranded], ["lost", undefined, "a"]);
	const failing = fakeJoin([{ id: "a", settled: false }], { fail: new Error("coordinator refused") });
	await assert.rejects(joinRuns([failing.join], ["a"], "all", { lost: "x" }), /coordinator refused/);
	assert.deepEqual(failing.events, ["release:false"]);
	// A settled run still wins over a join that lost the others.
	const mixed = await joinRuns([fakeJoin([{ id: "a", settled: true }]).join, fakeJoin([{ id: "b", settled: false }], { lost: true }).join], ["a", "b"], "any", { lost: "x" });
	assert.equal(mixed.reason, "settled");
});
