/**
 * delegate_ctl lifecycle on the acp backend (todo 043), through the real extension and Pi SDK
 * parent: timeout, provider failure, ambiguous delivery, cancellation and output bounds; wait
 * across both backends; and durability across a parent restart (park, restore, reopen, resume).
 * ACP agents are the existing fixtures: the fake ACP agent (created sessions; "fixture-noload" is
 * the same agent without session/load) and the fake Amp CLI (opened native T-IDs).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { deferred, provider, sandbox, harness } from "./fixture.ts";
import { acpCoordinator, configureAcpCoordinator, existingAcpCoordinator } from "../src/acp/instance.ts";

const fakeAcpAgent = new URL("./acp/fixtures/fake-acp-agent.ts", import.meta.url).pathname;
const fakeAmp = new URL("./acp/fixtures/fake-amp.mjs", import.meta.url).pathname;
const localThread = "T-00000000-0000-0000-0000-000000000001";

test("acp lifecycle: outcomes, mixed-backend wait, and runs that survive a parent restart", { timeout: 120000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	const saved = new Map(["AMP_CLI_PATH", "AMP_ACP_STATE_DIR"].map((key) => [key, process.env[key]]));
	chmodSync(fakeAmp, 0o755);
	process.env.AMP_CLI_PATH = fakeAmp;
	process.env.AMP_ACP_STATE_DIR = join(box.root, "amp-state");
	const agent = (...extra: string[]) => [process.execPath, "--import", import.meta.resolve("tsx"), fakeAcpAgent, join(box.root, "fixture-state.json"), ...extra];
	configureAcpCoordinator({ stateDir: join(box.root, "acp-state"), agentOverrides: { fixture: agent(), "fixture-noload": agent("no-load") } });
	let h = await harness(box);
	api.onUnscripted(() => ({ text: "ACK" }));
	const delegate = (args: Record<string, unknown>) => h.launch(args.task as string, { role: undefined, context: undefined, model: undefined, ...args });
	const codeOf = (result: any) => result.details?.error?.code;
	const parentId = h.ctx().sessionManager.getSessionId();
	const recordDir = () => join(realpathSync(box.cwd), ".agents", "pi", "subsessions", "owners", parentId, "acp");
	const record = (id: string) => join(recordDir(), `${encodeURIComponent(id)}.json`);
	/** Parent exit, then a new extension instance on the same parent. `between` runs while nothing holds the records. */
	const reopenParent = async (between: () => void = () => {}) => {
		await h.runtime.session.agent.waitForIdle();
		const parent = h.parent;
		await h.runtime.dispose();
		between();
		h = await harness(box, parent);
	};
	try {
		await t.test("success: a created turn the provider completes is accepted, with its outcome", async () => {
			const id = (await delegate({ backend: "acp", agent: "fixture", task: "hello" })).details.id;
			const done = await h.ctl("wait", id);
			assert.equal(done.isError, false);
			assert.deepEqual(done.details.turns.map((turn: any) => [turn.status, turn.delivery, turn.providerOutcome]), [["completed", "accepted", "completed"]]);
			assert.match(done.content[0].text, /delivery accepted, provider outcome completed/);
			await h.ctl("close", id);
		});

		await t.test("timeout: the turn budget ends the turn with its cause; delivery stays unknown", async () => {
			const id = (await delegate({ backend: "acp", agent: "fixture", task: "WAIT", timeoutMs: 300 })).details.id;
			const out = await h.ctl("wait", id);
			assert.equal(out.details.status, "timeout", out.content[0].text);
			assert.equal(out.isError, true);
			const turn = out.details.turns[0];
			assert.equal(turn.failure.code, "TURN_TIMEOUT");
			assert.equal(turn.delivery, "unknown", "a turn that never completed is never claimed accepted");
			assert.match(out.content[0].text, /turn req_.*: timed_out, delivery unknown, cause TURN_TIMEOUT/);
			assert.match(out.content[0].text, /error: TURN_TIMEOUT: /);
			await h.ctl("close", id, { force: true });
		});

		await t.test("provider failure: created and opened turns report the provider's failure, delivery unknown", async () => {
			const created = (await delegate({ backend: "acp", agent: "fixture", task: "FAIL here" })).details.id;
			const failed = await h.ctl("wait", created);
			assert.equal(failed.details.status, "error", failed.content[0].text);
			assert.equal(failed.isError, true);
			assert.deepEqual([failed.details.turns[0].delivery, failed.details.turns[0].providerOutcome], ["unknown", "failed"]);
			assert.ok(failed.details.turns[0].failure?.code, "the terminal cause is kept");
			assert.match(failed.content[0].text, /provider outcome failed, cause /);
			await h.ctl("close", created);

			const opened = (await delegate({ backend: "acp", agent: "amp", sessionId: localThread, cwd: undefined })).details.id;
			await h.ctl("steer", opened, { message: "please FAIL" });
			const native = await h.ctl("wait", opened);
			assert.equal(native.details.status, "error", native.content[0].text);
			assert.deepEqual([native.details.turns[0].delivery, native.details.turns[0].providerOutcome], ["unknown", "failed"]);
			await h.ctl("close", opened);
		});

		await t.test("ambiguous delivery and cancellation: a running or cancelled turn is never accepted", async () => {
			const id = (await delegate({ backend: "acp", agent: "fixture", task: "WAIT" })).details.id;
			const running = await h.ctl("status", id);
			assert.deepEqual([running.details.status, running.details.turns[0].delivery], ["running", "unknown"], "accepted is not claimed before the provider answers");
			assert.equal(running.details.capabilities.cancel.scope, "own-turns");
			const cancelled = await h.ctl("cancel", id);
			assert.equal(cancelled.details.status, "cancelled", cancelled.content[0].text);
			assert.equal(cancelled.details.turns[0].delivery, "unknown");
			assert.equal(codeOf(await h.ctl("cancel", id)), "WORKER_NOT_RUNNING", "cancel needs an active turn of this run");
			const after = await h.ctl("steer", id, { message: "quick" });
			assert.equal(after.isError, undefined, "cancel stopped the turn, not the run");
			assert.equal((await h.ctl("wait", id)).details.status, "complete");
			await h.ctl("close", id);
		});

		await t.test("output bounds: the Coordinator's cap and truncated flag reach wait and result", async () => {
			const id = (await delegate({ backend: "acp", agent: "fixture", task: "BIG" })).details.id;
			const out = await h.ctl("wait", id);
			assert.equal(out.details.truncated, true);
			assert.equal(out.details.turns[0].truncated, true);
			assert.ok(Buffer.byteLength(out.details.output) <= 256_000, "output stays within the profile bound");
			assert.match(out.content[0].text, /output truncated/);
			assert.equal((await h.ctl("result", id)).details.truncated, true);
			await h.ctl("close", id);
		});

		await t.test("wait across pi and acp runs: any, all, timeout and abort never cancel", async () => {
			const gate = deferred();
			const arrived = api.script("Mixed pi child", { text: "PI-MIXED-OK", gate });
			const pi = (await h.launch("Mixed pi child")).details.id;
			await arrived;
			const acp = (await delegate({ backend: "acp", agent: "fixture", task: "WAIT" })).details.id;
			const quick = (await delegate({ backend: "acp", agent: "fixture", task: "quick" })).details.id;
			const any = await h.ctl("wait", undefined, { runIds: [pi, acp, quick], mode: "any" });
			assert.equal(any.details.kind, "runs");
			assert.deepEqual(any.details.wait, { reason: "settled", pending: [pi, acp] });
			assert.deepEqual(any.details.rows.map((row: any) => [row.id, row.status]), [[quick, "complete"], [pi, "running"], [acp, "running"]]);

			const timedOut = await h.ctl("wait", undefined, { runIds: [pi, acp], mode: "all", timeoutMs: 300 });
			assert.match(timedOut.content[0].text, /^wait timed out after 300 ms; nothing was cancelled\. Still running: /);
			assert.deepEqual(timedOut.details.wait, { reason: "timeout", pending: [pi, acp] });

			const controller = new AbortController();
			const aborted = h.ctl("wait", undefined, { runIds: [pi, acp], mode: "all" }, controller.signal);
			await sleep(150);
			controller.abort();
			await assert.rejects(aborted, { name: "AbortError" });
			assert.equal((await h.ctl("status", pi)).details.status, "running", "the pi child kept going");
			assert.equal((await h.ctl("status", acp)).details.status, "running", "the acp turn kept going");

			const notices = h.notices.length;
			const all = h.ctl("wait", undefined, { runIds: [pi, acp], mode: "all" });
			await sleep(150);
			gate.resolve();
			await sleep(300);
			await h.ctl("cancel", acp);
			const both = await all;
			assert.deepEqual(both.details.wait, { reason: "settled", pending: [] });
			const rows = new Map(both.details.rows.map((row: any) => [row.id, row]));
			assert.equal((rows.get(pi) as any).status, "complete");
			assert.equal((rows.get(pi) as any).completionReceipt, true, "the pi row is the run's own receipt");
			assert.equal((rows.get(acp) as any).status, "cancelled");
			assert.match(both.content[0].text, /PI-MIXED-OK/);
			await sleep(300);
			assert.equal(h.notices.slice(notices).filter((n: any) => n.details?.id === pi || n.details?.id === acp).length, 0, "the joined wait took both results instead of waking the parent");
			await h.runtime.session.agent.waitForIdle();
			for (const id of [acp, quick]) await h.ctl("close", id);
		});

		const ids: Record<string, string> = {};
		await t.test("parent exit parks acp runs: sessions released, records kept", async () => {
			ids.created = (await delegate({ backend: "acp", agent: "fixture", task: "SET:nonce-7" })).details.id;
			await h.ctl("wait", ids.created);
			ids.noload = (await delegate({ backend: "acp", agent: "fixture-noload", task: "hello" })).details.id;
			await h.ctl("wait", ids.noload);
			ids.opened = (await delegate({ backend: "acp", agent: "amp", sessionId: localThread, cwd: undefined })).details.id;
			await h.ctl("steer", ids.opened, { message: "exact" });
			await h.ctl("wait", ids.opened);
			ids.busy = (await delegate({ backend: "acp", agent: "fixture", task: "WAIT" })).details.id;
			ids.closed = (await delegate({ backend: "acp", agent: "fixture", task: "hello" })).details.id;
			await h.ctl("wait", ids.closed);
			await h.ctl("close", ids.closed);
			const before = await h.ctl("result", ids.created);
			ids.createdTurn = before.details.turns[0].requestId;
			ids.createdSession = before.details.session.nativeSessionId;

			await reopenParent(() => {
				assert.equal(existingAcpCoordinator(), undefined, "parent exit shut the Coordinator down");
				const files = readdirSync(recordDir());
				for (const key of ["created", "noload", "opened", "busy", "closed"]) assert.ok(files.includes(`${encodeURIComponent(ids[key]!)}.json`), `${key} has a record`);
				const parked = JSON.parse(readFileSync(record(ids.created!), "utf8"));
				assert.equal(typeof parked.parkedAt, "number");
				assert.equal(parked.closedAt, undefined);
				assert.equal(parked.ownerToken, undefined, "parking releases ownership for the next process");
			});
		});

		await t.test("after the restart: status and result read the records without starting anything", async () => {
			const listed = await h.ctl("status");
			for (const key of ["created", "noload", "opened", "busy", "closed"]) assert.ok(listed.details.rows.some((row: any) => row.id === ids[key] && row.backend === "acp"), key);
			const created = await h.ctl("result", ids.created);
			assert.equal(created.details.output, "READY");
			assert.deepEqual(created.details.turns.map((turn: any) => [turn.requestId, turn.delivery, turn.providerOutcome]), [[ids.createdTurn, "accepted", "completed"]]);
			assert.equal(created.details.session.nativeSessionId, ids.createdSession);
			assert.ok(created.details.parked, "parked, not closed");
			assert.equal(created.details.closed, undefined);
			assert.match(created.content[0].text, /parked: the parent exited, its session closed and kept resumable; steer resumes it/);
			const busy = await h.ctl("status", ids.busy);
			assert.equal(busy.details.status, "cancelled", "a created turn still running at exit was stopped with its session");
			assert.equal(busy.details.parked.interruptedTurn, busy.details.turns[0].requestId);
			assert.match(busy.content[0].text, /Turn req_.* was still running then/);
			const opened = await h.ctl("status", ids.opened);
			assert.equal(opened.details.session.nativeSessionId, localThread);
			assert.match(opened.content[0].text, /parked: the parent exited, disconnected, the native session unchanged; steer reopens the same native session/);
			assert.equal((await h.ctl("status", ids.closed)).details.closed, true);
			assert.equal((await h.ctl("wait", ids.created)).details.status, "complete", "wait on a parked run returns its last outcome");
			assert.equal(existingAcpCoordinator(), undefined, "reading a parked run never constructs the Coordinator");
		});

		await t.test("steer reopens: a created run resumes its own session, an opened run its native ID", async () => {
			const resumed = await h.ctl("steer", ids.created, { message: "GET" });
			assert.equal(resumed.isError, undefined, resumed.content[0].text);
			const got = await h.ctl("wait", ids.created);
			assert.equal(got.details.output, "NONCE:nonce-7", "the same ACP session, with its state, not a new one");
			assert.equal(got.details.parked, undefined);
			assert.equal(got.details.turns.length, 2);
			assert.equal(got.details.turns[0].requestId, ids.createdTurn, "earlier request IDs are kept");
			assert.equal(got.details.session.nativeSessionId, ids.createdSession);

			await h.ctl("steer", ids.opened, { message: "exact again" });
			const native = await h.ctl("wait", ids.opened);
			assert.equal(native.details.output, "AMP_LOCAL_OK", native.content[0].text);
			assert.equal(native.details.session.nativeSessionId, localThread);
			assert.deepEqual(native.details.turns.map((turn: any) => turn.delivery), ["accepted", "accepted"]);

			const coordinator = await acpCoordinator();
			const listed = await coordinator.execute({ action: "list" });
			assert.ok(listed.ok);
			const live = (listed.details.workers as any[]).map((worker) => worker.name).sort();
			assert.deepEqual(live, [got.details.session.worker, native.details.session.worker].sort(), "only reopened runs hold a session; nothing was revived eagerly");
		});

		await t.test("a parked run whose adapter cannot resume fails RUN_NOT_RESUMABLE; close is final", async () => {
			const refused = await h.ctl("steer", ids.noload, { message: "more" });
			assert.equal(codeOf(refused), "RUN_NOT_RESUMABLE", refused.content[0].text);
			assert.match(refused.content[0].text, /RESUME_UNSUPPORTED/);
			const still = await h.ctl("status", ids.noload);
			assert.ok(still.details.parked, "a refused reopen leaves the run parked and readable");
			assert.equal(still.details.output, "READY");
			const closed = await h.ctl("close", ids.noload);
			assert.equal(closed.details.closed, true);
			assert.equal(closed.details.parked, undefined);
			assert.equal(codeOf(await h.ctl("steer", ids.noload, { message: "more" })), "RUN_CLOSED");
			assert.equal(codeOf(await h.ctl("steer", ids.closed, { message: "more" })), "RUN_CLOSED", "a run closed before the restart stays closed");
		});

		await t.test("a run whose process died is adopted parked; one a live process owns is read-only", async () => {
			const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
			let foreign = "";
			await reopenParent(() => {
				// As a process killed mid-turn leaves it: unparked, still running, owned by a dead pid.
				const crashed = JSON.parse(readFileSync(record(ids.busy!), "utf8"));
				delete crashed.parkedAt; delete crashed.interruptedTurn;
				crashed.last.requests[0] = { ...crashed.last.requests[0], status: "running", finishedAt: undefined, failure: undefined, providerOutcome: undefined };
				writeFileSync(record(ids.busy!), JSON.stringify({ ...crashed, ownerPid: dead, ownerHost: hostname(), ownerToken: "dead-process" }));
				const theirs = JSON.parse(readFileSync(record(ids.opened!), "utf8"));
				foreign = JSON.stringify({ ...theirs, ownerPid: process.ppid, ownerHost: hostname(), ownerToken: "live-process" });
				writeFileSync(record(ids.opened!), foreign);
			});

			const lost = await h.ctl("status", ids.busy);
			assert.equal(lost.details.status, "error");
			assert.equal(lost.details.turns[0].failure.code, "PARENT_PROCESS_LOST");
			assert.equal(lost.details.parked.interruptedTurn, lost.details.turns[0].requestId);

			const readOnly = await h.ctl("status", ids.opened);
			assert.deepEqual(readOnly.details.foreign, { ownerPid: process.ppid, ownerHost: hostname() });
			assert.equal(readOnly.details.output, "AMP_LOCAL_OK");
			assert.equal(codeOf(await h.ctl("steer", ids.opened, { message: "not mine" })), "RUN_OWNED_ELSEWHERE");
			assert.equal(codeOf(await h.ctl("close", ids.opened)), "RUN_OWNED_ELSEWHERE");
			await reopenParent();
			assert.equal(readFileSync(record(ids.opened), "utf8"), foreign, "a run another live process owns is never written");
		});

		await h.runtime.session.agent.waitForIdle();
		await h.runtime.dispose();
		assert.equal(existingAcpCoordinator(), undefined);
		assert.deepEqual(h.errors, []); assert.deepEqual(api.errors, []);
	} finally {
		await h.runtime.dispose();
		configureAcpCoordinator({});
		for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
