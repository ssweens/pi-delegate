/**
 * What an ACP run reports, as the live smoke on Codex showed it (todo 058 review): a created
 * session's native ID once the runtime holds it, a report without adapter status lines, a clear
 * failure for a steer on a session a timeout left unusable, and a cancel that does not also wake
 * the parent. AcpBackend and the Coordinator are real; the runtime is the in-process fake.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { configureAcpCoordinator, shutdownAcpCoordinator } from "../src/acp/instance.ts";
import { AcpBackend, DelegateError, acpResultText, acpSummary } from "../src/acp-backend.ts";
import { Coordinator } from "../src/acp/orchestration/coordinator.ts";
import type { NormalizedEvent, Profile, RuntimeHandle, RuntimePort, RuntimeTerminal } from "../src/acp/domain/types.ts";
import { fakeRuntime } from "./acp-fake-runtime.ts";

function setup(t: { after(fn: () => unknown): void }, factory = fakeRuntime().factory) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-delegate-acp-report-")));
	const runDir = join(root, "runs"), cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	const ownerKey = `owner-${root}`;
	configureAcpCoordinator({ stateDir: join(root, "acp-state"), profiles: {}, runtimeFactory: factory });
	const settled: string[] = [];
	const backend = new AcpBackend({ ownerKey: () => ownerKey, changed() {}, settled(v) { settled.push(v.id); }, runDir: () => runDir });
	t.after(async () => {
		await backend.closeOwner(ownerKey);
		await shutdownAcpCoordinator();
		configureAcpCoordinator({});
		rmSync(root, { recursive: true, force: true });
	});
	const record = (id: string) => JSON.parse(readFileSync(join(runDir, `${encodeURIComponent(id)}.json`), "utf8"));
	return { backend, cwd, settled, record, start: (agent: string, task: string, extra: Record<string, unknown> = {}) => backend.start({ backend: "acp", origin: "created", agent, task, cwd, ...extra } as never) };
}

const codeOf = async (work: Promise<unknown>) => work.then(() => undefined, (error) => error instanceof DelegateError ? error.code : String(error));

test("a created non-Amp session shows its session ID as its native ID once the runtime holds it", async (t) => {
	const s = setup(t);
	const run = await s.start("codex", "hello");
	const [done] = (await s.backend.wait({ runIds: [run.id], mode: "all" })).settled;
	const sessionId = done!.session.handle.backendSessionId!;
	assert.ok(sessionId);
	assert.equal(done!.session.nativeSessionId, sessionId);
	assert.match(acpSummary(done!), new RegExp(`\\nsession ${sessionId}\\n`));
	assert.equal(s.record(run.id).nativeSessionId, sessionId, "the record keeps it");
});

test("a created Amp session's ACP session ID is never its native ID", async (t) => {
	const s = setup(t);
	const run = await s.start("amp", "hello", { executionEnvironment: "local" });
	const [done] = (await s.backend.wait({ runIds: [run.id], mode: "all" })).settled;
	assert.ok(done!.session.handle.backendSessionId);
	assert.equal(done!.session.nativeSessionId, undefined, "an Amp thread is named by its T-ID only");
	assert.match(acpSummary(done!), /\nsession pending \(local\)\n/);
});

test("adapter status lines stay out of a turn's output and in its event log", async () => {
	const stateDir = mkdtempSync(join(tmpdir(), "pi-delegate-acp-status-"));
	const events: NormalizedEvent[] = [
		{ type: "status", text: "session updated" },
		{ type: "text", text: "the reply", stream: "output" },
		{ type: "status", text: "usage updated: 18271/258400" },
		{ type: "tool", text: "read package.json", status: "completed" },
		{ type: "status", text: "available commands updated (88)" },
	];
	const runtime: RuntimePort = {
		async ensureSession(input: { name: string }) { return { sessionKey: input.name, backend: "fake", runtimeSessionName: input.name, backendSessionId: `s-${input.name}` } as RuntimeHandle; },
		startTurn: (input: { requestId: string }) => {
			let finish!: (terminal: RuntimeTerminal) => void;
			const result = new Promise<RuntimeTerminal>((resolve) => { finish = resolve; });
			return {
				requestId: input.requestId, result,
				events: (async function* () { for (const event of events) yield event; finish({ status: "completed", stopReason: "end_turn" }); })(),
				async cancel() {}, async closeStream() {},
			};
		},
		async close() {},
	};
	const coordinator = new Coordinator(process.cwd(), { stateDir, runtimeFactory: (_cwd: string, _dir: string, _profile: Profile) => runtime });
	try {
		assert.ok((await coordinator.execute({ action: "spawn", name: "codexish", agent: "codex" })).ok);
		const sent = await coordinator.execute({ action: "send", name: "codexish", prompt: "hello" });
		assert.ok(sent.ok);
		await coordinator.execute({ action: "wait", requestId: sent.details.requestId, waitTimeoutMs: 5_000 });
		const result = await coordinator.execute({ action: "result", requestId: sent.details.requestId });
		assert.ok(result.ok);
		assert.equal(result.details.output, "the reply\n[tool] read package.json\n");
		const logged = readFileSync(String(result.details.eventPath), "utf8").trim().split("\n").map((line) => JSON.parse(line).event.type);
		assert.deepEqual(logged, ["status", "text", "status", "tool", "status"], "the event log keeps every event");
	} finally {
		await coordinator.shutdown();
		rmSync(stateDir, { recursive: true, force: true });
	}
});

test("a steer on a created session a turn timeout left unusable fails RUN_UNUSABLE and says to close it", async (t) => {
	const s = setup(t);
	const run = await s.start("codex", "WAIT", { timeoutMs: 100 });
	const [timedOut] = (await s.backend.wait({ runIds: [run.id], mode: "all" })).settled;
	assert.equal(timedOut!.status, "timeout", acpSummary(timedOut!));
	const steered = s.backend.steer(run.id, { message: "again" });
	assert.equal(await codeOf(steered), "RUN_UNUSABLE");
	await assert.rejects(steered, /close it and start a new run with delegate/);
	assert.equal((await s.backend.status([run.id]))[0]!.turns.length, 1, "no turn was sent");
	assert.equal((await s.backend.close(run.id, {})).closed, true, "close still releases it");
});

test("a cancel this parent asked for is reported by the cancel, never also as a wake-up", async (t) => {
	const s = setup(t);
	const run = await s.start("codex", "WAIT");
	const cancelled = await s.backend.cancel(run.id, {});
	assert.equal(cancelled.status, "cancelled", acpResultText(cancelled));
	await sleep(300);
	assert.deepEqual(s.settled, [], "the cancelled turn wakes no one");
	// A turn that settles on its own still wakes the parent.
	await s.backend.steer(run.id, { message: "hello" });
	const end = Date.now() + 5_000;
	while (!s.settled.length && Date.now() < end) await sleep(10);
	assert.deepEqual(s.settled, [run.id]);
});
