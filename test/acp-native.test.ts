/**
 * Native Amp sessions through `delegate`/`delegate_ctl` (todo 044), with the real extension and Pi
 * SDK parent and the fake Amp CLI (test/acp/fixtures/fake-amp.mjs), which serves `threads export`
 * from a thread store with messages and versions. The cases of test/acp/native-amp.test.ts, which
 * drive the Coordinator directly, are mirrored here through the delegate surface: create local and
 * Orb, open exact T-IDs only with verified identity and settings, native sends, disconnect-only
 * close. Then on-demand observation of an opened thread. No credentials, no network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { provider, sandbox, harness } from "./fixture.ts";
import { configureAcpCoordinator, existingAcpCoordinator } from "../src/acp/instance.ts";

const fakeAcpAgent = new URL("./acp/fixtures/fake-acp-agent.ts", import.meta.url).pathname;
const fakeAmp = new URL("./acp/fixtures/fake-amp.mjs", import.meta.url).pathname;
const localThread = "T-00000000-0000-0000-0000-000000000001";
const orbThread = "T-00000000-0000-0000-0000-000000000002";
const noCwdThread = "T-00000000-0000-0000-0000-000000000003";
const noExecutorThread = "T-00000000-0000-0000-0000-000000000004";

test("native Amp sessions and observation through delegate", { timeout: 120000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	const keys = ["AMP_CLI_PATH", "AMP_ACP_STATE_DIR", "AMP_FAKE_ARGS_LOG", "AMP_FAKE_INPUT_LOG", "AMP_FAKE_THREADS"];
	const saved = new Map(keys.map((key) => [key, process.env[key]]));
	chmodSync(fakeAmp, 0o755);
	const argsLog = join(box.root, "amp-args.ndjson"), inputLog = join(box.root, "amp-input.ndjson"), store = join(box.root, "amp-threads.json");
	process.env.AMP_CLI_PATH = fakeAmp;
	process.env.AMP_ACP_STATE_DIR = join(box.root, "amp-state");
	process.env.AMP_FAKE_ARGS_LOG = argsLog;
	process.env.AMP_FAKE_INPUT_LOG = inputLog;
	process.env.AMP_FAKE_THREADS = store;
	configureAcpCoordinator({ stateDir: join(box.root, "acp-state"), agentOverrides: { fixture: [process.execPath, "--import", import.meta.resolve("tsx"), fakeAcpAgent, join(box.root, "fixture-state.json")] } });
	let h = await harness(box);
	api.onUnscripted(() => ({ text: "ACK" }));
	const delegate = (args: Record<string, unknown>) => h.launch(args.task as string, { role: undefined, context: undefined, model: undefined, ...args });
	const codeOf = (result: any) => result.details?.error?.code;
	const lines = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
	const amp = () => lines(argsLog) as string[][];
	const executions = () => amp().filter((args) => args.includes("--execute"));
	const exportsOf = (id: string) => amp().filter((args) => args[0] === "threads" && args[1] === "export" && args[2] === id).length;
	const threads = () => existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {};
	const writeThreads = (value: unknown) => writeFileSync(store, JSON.stringify(value));
	const message = (messageId: number, role: string, text: string) => ({ messageId, role, content: [{ type: "text", text }], createdAt: 1_790_000_000_000 + messageId, meta: { sentAt: 1 } });
	const parentId = h.ctx().sessionManager.getSessionId();
	const record = (id: string) => JSON.parse(readFileSync(join(realpathSync(box.cwd), ".agents", "pi", "subsessions", "owners", parentId, "acp", `${encodeURIComponent(id)}.json`), "utf8"));
	try {
		await t.test("create: a new Amp run names local or Orb execution; there is no adapter default", async () => {
			const unnamed = await delegate({ backend: "acp", agent: "amp", task: "where?" });
			assert.equal(codeOf(unnamed), "INPUT_INVALID");
			assert.equal(unnamed.details.error.field, "executionEnvironment");
			assert.equal(executions().length, 0, "nothing ran");

			const local = (await delegate({ backend: "acp", agent: "amp", task: "local", executionEnvironment: "local" })).details;
			assert.equal(local.session.executionEnvironment, "local");
			const localDone = await h.ctl("wait", local.id);
			assert.equal(localDone.details.output, "AMP_LOCAL_OK", localDone.content[0].text);
			assert.equal(executions().at(-1)!.includes("--orb-execute"), false);

			const modeled = (await delegate({ backend: "acp", agent: "amp", task: "modeled", executionEnvironment: "local", model: "high" })).details;
			await h.ctl("wait", modeled.id);
			assert.equal((await h.ctl("status", modeled.id)).details.model, "high");
			const modeledArgs = executions().at(-1)!;
			assert.equal(modeledArgs[modeledArgs.indexOf("--mode") + 1], "high");

			const orb = (await delegate({ backend: "acp", agent: "amp", task: "orb", executionEnvironment: "orb" })).details;
			assert.equal(orb.session.executionEnvironment, "orb");
			const orbDone = await h.ctl("wait", orb.id);
			assert.equal(orbDone.details.output, "AMP_ORB_OK");
			assert.equal(executions().at(-1)!.includes("--orb-execute"), true);

			// A created session is a Coordinator worker: its prompt carries the worker contract.
			const createdInput = lines(inputLog).at(-1);
			assert.notEqual(createdInput.input, "orb", "created prompts are decorated");
			assert.ok(createdInput.input.startsWith("orb"));
			for (const id of [local.id, modeled.id, orb.id]) await h.ctl("close", id);
		});

		const opened: Record<string, string> = {};
		await t.test("open: exact T-IDs only with verified identity and settings, and an executor hint where Amp has none", async () => {
			writeThreads({}); // The created runs above wrote to the fake's default threads; start them empty.
			const local = await delegate({ backend: "acp", agent: "amp", sessionId: localThread, cwd: undefined });
			assert.equal(local.isError, undefined, local.content[0].text);
			opened.local = local.details.id;
			assert.equal(local.details.session.nativeSessionId, localThread);
			assert.equal(local.details.session.native.scope, "amp://account/fake-account", "the account the export names");
			assert.equal(local.details.session.executionEnvironment, "local");
			assert.equal(local.details.status, "idle");

			assert.equal(codeOf(await delegate({ backend: "acp", agent: "amp", sessionId: localThread, cwd: undefined, executionEnvironment: "local" })), "SESSION_IN_USE", "one binding per native thread");
			const mismatch = await delegate({ backend: "acp", agent: "amp", sessionId: orbThread, cwd: undefined, executionEnvironment: "local" });
			assert.equal(codeOf(mismatch), "NATIVE_LOOKUP_FAILED", "a hint never overrides the executor Amp reports");
			assert.match(mismatch.content[0].text, /executor does not match/);
			assert.equal(codeOf(await delegate({ backend: "acp", agent: "amp", sessionId: noCwdThread, cwd: undefined })), "NATIVE_LOOKUP_FAILED", "a local thread without workspace metadata cannot be verified");
			assert.equal(codeOf(await delegate({ backend: "acp", agent: "amp", sessionId: "T-not-a-thread", cwd: undefined })), "NATIVE_LOOKUP_FAILED");

			const unhinted = await delegate({ backend: "acp", agent: "amp", sessionId: noExecutorThread, cwd: undefined });
			assert.equal(codeOf(unhinted), "NATIVE_OPEN_UNSUPPORTED", "without executor metadata the caller must name the executor");
			const hinted = await delegate({ backend: "acp", agent: "amp", sessionId: noExecutorThread, cwd: undefined, executionEnvironment: "local" });
			assert.equal(hinted.isError, undefined, hinted.content[0].text);
			assert.equal(hinted.details.session.executionEnvironment, "local");
			opened.hinted = hinted.details.id;

			const orb = await delegate({ backend: "acp", agent: "amp", sessionId: orbThread, cwd: undefined, executionEnvironment: "orb" });
			assert.equal(orb.isError, undefined, orb.content[0].text);
			assert.equal(orb.details.session.native.disconnectEffect, "unknown");
			opened.orb = orb.details.id;
		});

		await t.test("native sends through steer are undecorated, user-attributed and never retried", async () => {
			const before = executions().length;
			await h.ctl("steer", opened.local, { message: "exact words, as typed" });
			const sent = await h.ctl("wait", opened.local);
			assert.equal(sent.details.output, "AMP_LOCAL_OK", sent.content[0].text);
			assert.deepEqual(lines(inputLog).at(-1), { threadId: localThread, input: "exact words, as typed" }, "the prompt Amp received is the message, byte for byte");
			const turn = executions().slice(before);
			assert.equal(turn.length, 1, "one execution per steer");
			assert.deepEqual(turn[0]!.slice(0, 3), ["threads", "continue", localThread], "a native continuation of the exact thread, as the CLI's own user");
			assert.equal(turn[0]!.includes("--dangerously-allow-all"), false);
			const posted = threads()[localThread].messages.at(-2);
			assert.deepEqual([posted.role, posted.content[0].text], ["user", "exact words, as typed"], "the thread shows it as a user message, not automation");

			await h.ctl("steer", opened.hinted, { message: "please FAIL" });
			const failed = await h.ctl("wait", opened.hinted);
			assert.equal(failed.details.status, "error", "is_error is never reported as success");
			assert.equal(executions().length, before + 2, "a failed native send is not retried");

			await h.ctl("steer", opened.orb, { message: "orb exact" });
			assert.equal((await h.ctl("wait", opened.orb)).details.output, "AMP_ORB_OK");
			const orbArgs = executions().at(-1)!;
			assert.deepEqual(orbArgs.slice(0, 3), ["threads", "continue", orbThread]);
			assert.equal(orbArgs.includes("--orb-execute"), true, "the Orb thread keeps its remote executor");
			assert.equal(orbArgs[orbArgs.indexOf("--mode") + 1], "high", "and its native mode");
			assert.equal(codeOf(await h.ctl("steer", opened.orb, { message: "x", model: "low" })), "OPEN_OVERRIDE_FORBIDDEN");
		});

		await t.test("close only disconnects: nothing is archived, deleted or cancelled", async () => {
			const before = amp().length;
			assert.equal(codeOf(await h.ctl("close", opened.orb, { discardPersistentState: true })), "OPEN_OVERRIDE_FORBIDDEN");
			for (const id of [opened.orb, opened.hinted]) {
				const closed = await h.ctl("close", id);
				assert.match(closed.content[0].text, /closed; disconnected, and the native session is unchanged/);
			}
			assert.deepEqual(amp().slice(before), [], "disconnecting runs no Amp command at all");
			assert.equal(amp().some((args) => args.some((arg) => /archive|delete|cancel/.test(arg) && arg !== "--no-archive-after-execute")), false);
			assert.equal(executions().every((args) => args.includes("--no-archive-after-execute")), true, "every execution keeps the thread unarchived");
			assert.ok(threads()[orbThread], "the thread is still there");
		});

		await t.test("observe: one export on demand, only messages after the last returned, v/updatedAt for no change", async () => {
			const thread = threads()[localThread];
			const others = [message(101, "user", "a teammate asks: status?"), message(102, "assistant", "Amp answers the teammate")];
			thread.messages.push(...others); thread.v += 1; thread.updatedAt = "2026-09-30T12:00:00.000Z";
			writeThreads({ ...threads(), [localThread]: thread });
			const total = thread.messages.length;

			const exportsBefore = exportsOf(localThread);
			await h.ctl("status", opened.local);
			await sleep(300);
			assert.equal(exportsOf(localThread), exportsBefore, "status without observe reads nothing; nothing polls in the background");

			const first = await h.ctl("status", opened.local, { observe: true });
			assert.equal(first.isError, undefined, first.content[0].text);
			assert.equal(exportsOf(localThread), exportsBefore + 1, "one export per request");
			const o1 = first.details.observation;
			assert.equal(o1.state, "changed");
			assert.equal(o1.messages.length, total, "the first observation returns the whole thread");
			assert.deepEqual([o1.remaining, o1.truncated, o1.version, o1.updatedAt], [0, false, thread.v, "2026-09-30T12:00:00.000Z"]);
			assert.deepEqual(o1.messages.slice(-2).map((m: any) => [m.messageId, m.role, m.author, m.text]), [["101", "user", "unknown", "a teammate asks: status?"], ["102", "assistant", "unknown", "Amp answers the teammate"]], "other participants' messages, with role and an unknown author");
			assert.equal(o1.messages.slice(-2)[0].createdAt, new Date(1_790_000_000_101).toISOString());
			assert.match(first.content[0].text, new RegExp(`observed Amp thread ${localThread} at .*: ${total} messages since the last observation\\.`));
			assert.match(first.content[0].text, /----- T-0+-0+-0+-0+-0+1 messages, verbatim -----\n#1 user · author unknown · .*\nexact words, as typed\n/);
			assert.equal(first.details.status, "complete", "the run's own status is unchanged by observing");

			const second = await h.ctl("status", opened.local, { observe: true });
			assert.equal(second.details.observation.state, "unchanged");
			assert.deepEqual(second.details.observation.messages, []);
			assert.match(second.content[0].text, /: no change since the last observation\.$/);

			const grown = threads();
			grown[localThread].messages.push(message(103, "user", "the teammate again"));
			grown[localThread].v += 1; grown[localThread].updatedAt = "2026-09-30T12:05:00.000Z";
			writeThreads(grown);
			const third = await h.ctl("result", opened.local, { observe: true });
			assert.deepEqual(third.details.observation.messages.map((m: any) => m.text), ["the teammate again"], "only what is new since the last observation");
			assert.match(third.content[0].text, /----- amp-.* reported, verbatim -----/, "result keeps the run's own report");
			assert.match(third.content[0].text, /#103 user · author unknown · .*\nthe teammate again\n----- end of messages -----$/);

			await h.ctl("steer", opened.local, { message: "my own turn" });
			await h.ctl("wait", opened.local);
			const own = await h.ctl("status", opened.local, { observe: true });
			assert.deepEqual(own.details.observation.messages.map((m: any) => [m.role, m.text]), [["user", "my own turn"], ["assistant", "AMP_LOCAL_OK"]]);
		});

		await t.test("observe holds the session's output bound; what it leaves out comes next, never skipped", async () => {
			const grown = threads();
			grown[localThread].messages.push(message(201, "assistant", "x".repeat(300_000)), message(202, "user", "after the big one"));
			grown[localThread].v += 1;
			writeThreads(grown);
			const big = await h.ctl("status", opened.local, { observe: true });
			const o = big.details.observation;
			assert.deepEqual([o.messages.length, o.remaining, o.truncated, o.maxBytes], [1, 1, true, 256_000]);
			assert.equal(o.messages[0].truncated, true);
			assert.ok(Buffer.byteLength(JSON.stringify(o.messages)) <= 256_000 + 1_000, "the observed text stays within the bound");
			assert.match(big.content[0].text, /1 more after these were left out by the 256000-byte bound; observe again to read them/);
			const rest = await h.ctl("status", opened.local, { observe: true });
			assert.equal(rest.details.observation.state, "unchanged", "the thread did not change; what the bound left follows");
			const [more, after] = rest.details.observation.messages;
			assert.deepEqual([more.messageId, more.continued, after.text], ["201", true, "after the big one"]);
			assert.equal(o.messages[0].text + more.text, "x".repeat(300_000), "the saved cursor resumes the cut message where it was cut");
			assert.equal((await h.ctl("status", opened.local, { observe: true })).details.observation.state, "unchanged");
		});

		await t.test("a failed export is an unknown observation, not a failed status; the cursor stays", async () => {
			writeThreads({ ...threads(), [localThread]: { ...threads()[localThread], fail: "fake export refused" } });
			const failed = await h.ctl("status", opened.local, { observe: true });
			assert.equal(failed.isError, undefined, "status still answers");
			assert.equal(failed.details.id, opened.local);
			assert.equal(failed.details.observation.state, "unknown");
			assert.match(failed.details.observation.error, /amp threads export exited 1: fake export refused/);
			assert.match(failed.content[0].text, /: unknown, amp threads export exited 1: fake export refused\. The observation cursor did not move\./);
			const asResult = await h.ctl("result", opened.local, { observe: true });
			assert.equal(asResult.details.observation.state, "unknown");

			const restored = threads();
			delete restored[localThread].fail;
			restored[localThread].messages.push(message(301, "user", "sent while the export failed"));
			restored[localThread].v += 1;
			writeThreads(restored);
			const after = await h.ctl("status", opened.local, { observe: true });
			assert.deepEqual(after.details.observation.messages.map((m: any) => m.text), ["sent while the export failed"], "nothing was lost or repeated");
		});

		await t.test("the cursor is saved with the run and survives park and restart", async () => {
			assert.equal(record(opened.local).observed.messageId, "301");
			await h.runtime.session.agent.waitForIdle();
			const parent = h.parent;
			await h.runtime.dispose();
			const parkedArgs = amp().length;
			const grown = threads();
			grown[localThread].messages.push(message(401, "user", "while Pi was away"));
			grown[localThread].v += 1;
			writeThreads(grown);
			h = await harness(box, parent);
			assert.deepEqual(amp().slice(parkedArgs), [], "parking and restoring run no Amp command");

			const back = await h.ctl("status", opened.local, { observe: true });
			assert.ok(back.details.parked, "observed while parked, without reopening");
			assert.equal(existingAcpCoordinator(), undefined, "observation needs no ACP session");
			assert.deepEqual(back.details.observation.messages.map((m: any) => m.text), ["while Pi was away"], "only what came after the saved cursor");
			assert.equal((await h.ctl("status", opened.local, { observe: true })).details.observation.state, "unchanged");
		});

		await t.test("observe is only for opened Amp runs and only on status or result", async () => {
			const created = (await delegate({ backend: "acp", agent: "fixture", task: "hello" })).details.id;
			await h.ctl("wait", created);
			const notOpened = await h.ctl("status", created, { observe: true });
			assert.equal(codeOf(notOpened), "ACTION_UNSUPPORTED");
			assert.match(notOpened.content[0].text, /observe is not supported on the acp backend: a created session has no other participants/);
			assert.equal(codeOf(await h.ctl("result", created, { observe: true })), "ACTION_UNSUPPORTED");
			const createdAmp = (await delegate({ backend: "acp", agent: "amp", task: "hi", executionEnvironment: "local" })).details.id;
			await h.ctl("wait", createdAmp);
			assert.equal(codeOf(await h.ctl("status", createdAmp, { observe: true })), "ACTION_UNSUPPORTED", "a created Amp run has no other participants");
			api.script("Pi child", { text: "PI-OK" });
			const pi = (await h.launch("Pi child", { sync: true })).details.id;
			const piObserve = await h.ctl("status", pi, { observe: true });
			assert.equal(codeOf(piObserve), "ACTION_UNSUPPORTED");
			assert.match(piObserve.content[0].text, /observe is not supported on the pi backend/);
			assert.equal(codeOf(await h.ctl("status", undefined, { observe: true })), "INPUT_INVALID", "one export per request: observe needs one runId");
			assert.equal(codeOf(await h.ctl("wait", opened.local, { observe: true })), "INPUT_INVALID");
			await h.ctl("close", opened.local);
			assert.equal(codeOf(await h.ctl("status", opened.local, { observe: true })), "RUN_CLOSED", "close ends the observation with the run");
			for (const id of [created, createdAmp]) await h.ctl("close", id);
		});

		await h.runtime.session.agent.waitForIdle();
		await h.runtime.dispose();
		assert.deepEqual(h.errors, []); assert.deepEqual(api.errors, []);
	} finally {
		await h.runtime.dispose();
		configureAcpCoordinator({});
		for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
