/**
 * Amp extras through `delegate`/`delegate_ctl` (todo 058), with the real extension and Pi SDK
 * parent and the fake Amp CLI (test/acp/fixtures/fake-amp.mjs), which records every invocation and
 * serves `threads label`, `threads usage` and `--title`: Amp's agent mode on created threads and
 * their continued turns, the created thread's T-ID in the view and the record, one title and one
 * label per created thread (opened threads untouched), and the thread's cost on status/result.
 * No credentials, no network.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { provider, sandbox, harness } from "./fixture.ts";
import { configureAcpCoordinator } from "../src/acp/instance.ts";
import { AMP_DELEGATE_LABEL, ampRunLabel, ampThreadTitle } from "../src/acp-backend.ts";
import { AMP_LABEL, parseAmpCost } from "../src/acp/runtime/amp-cli.ts";
import { asRunView } from "../src/render.ts";

const fakeAcpAgent = new URL("./acp/fixtures/fake-acp-agent.ts", import.meta.url).pathname;
const fakeAmp = new URL("./acp/fixtures/fake-amp.mjs", import.meta.url).pathname;
const localThread = "T-00000000-0000-0000-0000-000000000001";
const orbThread = "T-00000000-0000-0000-0000-000000000002";

test("amp threads usage: the Cost line, and nothing inferred without one", () => {
	const real = "Remote connections check\nCost: $2.12\nDetails: https://ampcode.com/threads/T-01a0f0b4/usage\n\n## Orb System Metrics\n\n| CPU | Memory |\n| 4.64% / 8 cores | 297 MiB |\n";
	assert.equal(parseAmpCost(real), 2.12);
	assert.equal(parseAmpCost("Cost: $1,204.5\n"), 1204.5);
	assert.equal(parseAmpCost("\u001b[1mCost:\u001b[0m $0.00\n"), 0, "zero is a cost, and styling is ignored");
	assert.equal(parseAmpCost("no cost here\nCPU 4.64%"), undefined);
	assert.equal(parseAmpCost("Cost: unknown"), undefined);
});

test("a run's Amp label fits Amp's rules and names the run exactly; a title is the brief's first line", () => {
	const id = "amp-0f8a7c2e-1b2d-4e5f-8a9b-0c1d2e3f4a5b";
	assert.equal(ampRunLabel(id), "0f8a7c2e1b2d4e5f8a9b0c1d2e3f4a5b");
	assert.ok(AMP_LABEL.test(ampRunLabel(id)) && AMP_LABEL.test(AMP_DELEGATE_LABEL), "lowercase alphanumerics and hyphens, at most 32");
	assert.notEqual(ampRunLabel("amp-0f8a7c2e-1b2d-4e5f-8a9b-0c1d2e3f4a5c"), ampRunLabel(id));
	assert.equal(ampThreadTitle("\n  Profile the build \t now\nobjective: …"), "Profile the build now");
	assert.equal(ampThreadTitle("x".repeat(500))!.length, 120);
	assert.equal(ampThreadTitle(" \n\t\n"), undefined);
	assert.equal(ampThreadTitle("# - --dangerously-allow-all please"), "dangerously-allow-all please", "a title never reads as an option");
});

test("Amp extras through delegate: mode, native T-ID, title and labels, cost", { timeout: 120000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	const keys = ["AMP_CLI_PATH", "AMP_ACP_STATE_DIR", "AMP_FAKE_ARGS_LOG", "AMP_FAKE_THREADS", "AMP_FAKE_LABEL_FAIL"];
	const saved = new Map(keys.map((key) => [key, process.env[key]]));
	chmodSync(fakeAmp, 0o755);
	const argsLog = join(box.root, "amp-args.ndjson"), store = join(box.root, "amp-threads.json");
	process.env.AMP_CLI_PATH = fakeAmp;
	process.env.AMP_ACP_STATE_DIR = join(box.root, "amp-state");
	process.env.AMP_FAKE_ARGS_LOG = argsLog;
	process.env.AMP_FAKE_THREADS = store;
	configureAcpCoordinator({ stateDir: join(box.root, "acp-state"), agentOverrides: { fixture: [process.execPath, "--import", import.meta.resolve("tsx"), fakeAcpAgent, join(box.root, "fixture-state.json")] } });
	let h = await harness(box);
	api.onUnscripted(() => ({ text: "ACK" }));
	const delegate = (args: Record<string, unknown>) => h.launch(args.task as string, { role: undefined, context: undefined, model: undefined, ...args });
	const codeOf = (result: any) => result.details?.error?.code;
	const amp = (): string[][] => existsSync(argsLog) ? readFileSync(argsLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
	const executions = () => amp().filter((args) => args.includes("--execute"));
	const command = (name: string) => amp().filter((args) => args[0] === "threads" && args[1] === name);
	const threads = () => existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : {};
	const setThread = (id: string, fields: Record<string, unknown>) => { const all = threads(); all[id] = { v: 0, messages: [], ...all[id], ...fields }; writeFileSync(store, JSON.stringify(all)); };
	const until = async (check: () => boolean, what: string) => { const end = Date.now() + 10_000; while (!check()) { if (Date.now() > end) assert.fail(`timed out: ${what}`); await sleep(20); } };
	const parentId = h.ctx().sessionManager.getSessionId();
	const record = (id: string) => JSON.parse(readFileSync(join(realpathSync(box.cwd), ".agents", "pi", "subsessions", "owners", parentId, "acp", `${encodeURIComponent(id)}.json`), "utf8"));
	const created: Record<string, string> = {};
	try {
		await t.test("mode: fails explicitly off Amp, on pi, on an opened thread, and beside model; nothing runs", async () => {
			assert.equal(codeOf(await h.launch("x", { mode: "high" })), "FIELD_REQUIRES_ACP");
			const other = await delegate({ backend: "acp", agent: "fixture", task: "x", mode: "high" });
			assert.deepEqual([codeOf(other), other.details.error.field], ["FIELD_REQUIRES_AMP", "mode"]);
			assert.equal(codeOf(await delegate({ backend: "acp", agent: "amp", sessionId: localThread, cwd: undefined, mode: "high" })), "OPEN_OVERRIDE_FORBIDDEN");
			assert.equal(codeOf(await delegate({ backend: "acp", agent: "amp", task: "x", executionEnvironment: "local", mode: "high", model: "low" })), "INPUT_INVALID");
			assert.deepEqual(amp(), [], "no Amp command ran");
		});

		await t.test("mode reaches amp --mode on the created thread and every continued turn; a plugin mode passes through", async () => {
			const run = await delegate({ backend: "acp", agent: "amp", task: "Mode check\nobjective: say hi", executionEnvironment: "local", mode: "ultra" });
			assert.equal(run.isError, undefined, run.content[0].text);
			created.local = run.details.id;
			const done = await h.ctl("wait", created.local);
			assert.equal(done.details.status, "complete", done.content[0].text);
			assert.equal(done.details.mode, "ultra");
			assert.match(done.content[0].text, / · mode ultra · /);
			const first = executions().at(-1)!;
			assert.equal(first[0], "--execute", "a new thread");
			assert.equal(first[first.indexOf("--mode") + 1], "ultra");

			await h.ctl("steer", created.local, { message: "again" });
			await h.ctl("wait", created.local);
			const next = executions().at(-1)!;
			assert.deepEqual(next.slice(0, 3), ["threads", "continue", localThread], "the same thread continued");
			assert.equal(next[next.indexOf("--mode") + 1], "ultra", "the continued turn keeps the mode");

			const plugin = (await delegate({ backend: "acp", agent: "amp", task: "Plugin mode\n…", executionEnvironment: "orb", mode: "Deep Research" })).details;
			created.orb = plugin.id;
			assert.equal((await h.ctl("wait", plugin.id)).details.status, "complete");
			const pluginArgs = executions().at(-1)!;
			assert.equal(pluginArgs[pluginArgs.indexOf("--mode") + 1], "Deep Research", "Amp resolves plugin modes itself");
		});

		await t.test("a created thread's T-ID reaches the view and the run record once the adapter reports it", async () => {
			const status = await h.ctl("status", created.local);
			assert.equal(status.details.session.nativeSessionId, localThread);
			assert.equal(status.details.session.native.id, localThread);
			assert.equal(status.details.session.native.executionEnvironment, "local");
			assert.match(status.content[0].text, new RegExp(`\\nsession ${localThread} \\(local\\)`));
			assert.equal(record(created.local).nativeSessionId, localThread);
			assert.equal(record(created.local).last.worker.native.id, localThread);
			assert.equal(record(created.orb).nativeSessionId, orbThread);
		});

		await t.test("a created thread is titled by its first execution and labeled once for its run", async () => {
			const first = executions().find((args) => args.includes("--title") && args[args.indexOf("--title") + 1] === "Mode check")!;
			assert.ok(first, "the first execution carries --title");
			assert.equal(executions().filter((args) => args[0] === "threads" && args.includes("--title")).length, 0, "a continued turn never retitles");
			const label = ampRunLabel(created.local);
			await until(() => command("label").some((args) => args.includes(label)), "the label call");
			assert.deepEqual(command("label").filter((args) => args.includes(label)), [["threads", "label", localThread, label, AMP_DELEGATE_LABEL]], "one label call, after two turns");
			assert.deepEqual(threads()[localThread].labels.filter((l: string) => l === label || l === AMP_DELEGATE_LABEL).sort(), [label, AMP_DELEGATE_LABEL].sort());
			const status = await h.ctl("status", created.local);
			assert.deepEqual(status.details.session.labels, [label, AMP_DELEGATE_LABEL]);
			assert.match(status.content[0].text, new RegExp(`labeled ${label}, ${AMP_DELEGATE_LABEL}`));
			assert.deepEqual(record(created.local).labeled.labels, [label, AMP_DELEGATE_LABEL]);
		});

		await t.test("a failed label is a note on the run, never a failed run", async () => {
			process.env.AMP_FAKE_LABEL_FAIL = "fake label refused";
			try {
				const id = (await delegate({ backend: "acp", agent: "amp", task: "Label fails\n…", executionEnvironment: "orb" })).details.id;
				created.unlabeled = id;
				const done = await h.ctl("wait", id);
				assert.equal(done.details.status, "complete");
				await until(() => command("label").some((args) => args.includes(ampRunLabel(id))), "the failing label call");
				await until(() => record(id).notes?.length === 1, "the note is saved");
			} finally { delete process.env.AMP_FAKE_LABEL_FAIL; }
			const result = await h.ctl("result", created.unlabeled);
			assert.equal(result.isError, false, result.content[0].text);
			assert.equal(result.details.status, "complete");
			assert.equal(result.details.session.labels, undefined);
			assert.match(result.details.notes[0], new RegExp(`^labeling Amp thread ${orbThread} failed \\(amp threads label ${orbThread} \\S+ ${AMP_DELEGATE_LABEL} exited 1: fake label refused\\); the run is unaffected$`));
			assert.match(result.content[0].text, /\nnote: labeling Amp thread .* failed/);
			await h.ctl("steer", created.unlabeled, { message: "one more" });
			await h.ctl("wait", created.unlabeled);
			await sleep(200);
			assert.equal(command("label").filter((args) => args.includes(ampRunLabel(created.unlabeled))).length, 1, "labeling is tried once, not retried each turn");
		});

		const opened: Record<string, string> = {};
		await t.test("opened threads are never labeled, retitled or given a mode", async () => {
			// One binding per native thread: the created runs on the fake's shared thread let it go first.
			for (const id of Object.values(created)) await h.ctl("close", id);
			const before = amp().length;
			const labelsBefore = threads()[localThread].labels;
			const run = await delegate({ backend: "acp", agent: "amp", sessionId: localThread, cwd: undefined, task: "native words" });
			assert.equal(run.isError, undefined, run.content[0].text);
			opened.local = run.details.id;
			await h.ctl("wait", opened.local);
			await h.ctl("steer", opened.local, { message: "more native words" });
			await h.ctl("wait", opened.local);
			await h.ctl("status", opened.local);
			await h.ctl("result", opened.local);
			await sleep(300);
			const since = amp().slice(before);
			assert.ok(since.some((args) => args[1] === "continue"), "the turns ran");
			assert.deepEqual(since.filter((args) => args.includes("label") || args.includes("--title") || args.includes("rename") || args.includes("--label")), [], "no label, title or rename");
			assert.ok(since.filter((args) => args.includes("--execute")).every((args) => args[args.indexOf("--mode") + 1] === "medium"), "its native mode, unchanged");
			assert.deepEqual(threads()[localThread].labels, labelsBefore);
			assert.equal((await h.ctl("status", opened.local)).details.session.labels, undefined);
		});

		await t.test("cost: one amp threads usage per status or result, cached with its time; nothing else reads it", async () => {
			setThread(localThread, { cost: 2.12 });
			let usage = command("usage").length;
			const status = await h.ctl("status", opened.local);
			assert.equal(command("usage").length, usage + 1, "one usage call for one status");
			assert.deepEqual(command("usage").at(-1), ["threads", "usage", localThread]);
			assert.deepEqual(status.details.usage.cost, { amount: 2.12, currency: "USD" });
			assert.equal(status.details.usage.threadId, localThread);
			assert.equal(typeof status.details.usage.at, "number");
			assert.match(status.content[0].text, / · \$2\.12 \(Amp thread\)/);
			assert.equal(asRunView(status.details)!.cost, 2.12, "it fills the run's cost field");
			assert.equal(record(opened.local).usage.cost.amount, 2.12, "cached on the record");

			usage = command("usage").length;
			const result = await h.ctl("result", opened.local);
			assert.equal(command("usage").length, usage + 1, "one usage call for one result");
			assert.match(result.content[0].text, /\$2\.12 \(Amp thread\)/);

			usage = command("usage").length;
			const all = await h.ctl("status");
			assert.match(all.content[0].text, /\$2\.12 \(Amp thread\)/, "the run list shows the cached cost");
			await h.ctl("wait", opened.local);
			await h.ctl("steer", opened.local, { message: "and again" });
			await h.ctl("wait", opened.local);
			await sleep(300);
			assert.equal(command("usage").length, usage, "status without a runId, wait and steer read no usage");
		});

		await t.test("unavailable cost is unknown: it never fails or blocks a status or result", async () => {
			setThread(localThread, { usageFail: "fake usage refused" });
			const failed = await h.ctl("status", opened.local);
			assert.equal(failed.isError, undefined, failed.content[0].text);
			assert.equal(failed.details.usage.cost, undefined, "a stale cost is not reported as current");
			assert.match(failed.details.usage.error, new RegExp(`amp threads usage ${localThread} exited 1: fake usage refused`));
			assert.match(failed.content[0].text, / · cost unknown/);
			assert.equal(asRunView(failed.details)!.cost, 0);
			const result = await h.ctl("result", opened.local);
			assert.equal(result.isError, false);
			assert.match(result.content[0].text, /cost unknown/);

			setThread(localThread, { usageFail: undefined, usageText: "no cost here\n" });
			assert.match((await h.ctl("status", opened.local)).details.usage.error, /printed no Cost line/);
			setThread(localThread, { usageText: undefined });

			// A created run whose first execution never started has no T-ID: no usage call, unknown.
			process.env.AMP_CLI_PATH = join(box.root, "no-such-amp");
			let id: string;
			try { id = (await delegate({ backend: "acp", agent: "amp", task: "No thread\n…", executionEnvironment: "local" })).details.id; }
			finally { process.env.AMP_CLI_PATH = fakeAmp; }
			await h.ctl("wait", id);
			const usage = command("usage").length;
			const pending = await h.ctl("status", id);
			assert.equal(command("usage").length, usage);
			assert.equal(pending.details.session.nativeSessionId?.startsWith("T-") ?? false, false);
			assert.equal(pending.details.usage.error, "the Amp thread ID is not known yet");
			assert.match(pending.content[0].text, /cost unknown/);
			await h.ctl("close", id);
		});

		await t.test("created Amp runs report cost too; other agents read none", async () => {
			setThread(orbThread, { cost: 0.5 });
			const orb = await h.ctl("status", created.orb);
			assert.ok(orb.details.closed, "a closed run's thread still has its cost");
			assert.deepEqual(orb.details.usage.cost, { amount: 0.5, currency: "USD" });
			assert.match(orb.content[0].text, /\$0\.50 \(Amp thread\)/);

			const fixture = (await delegate({ backend: "acp", agent: "fixture", task: "hello" })).details.id;
			await h.ctl("wait", fixture);
			const usage = command("usage").length;
			const plain = await h.ctl("status", fixture);
			await h.ctl("result", fixture);
			assert.equal(command("usage").length, usage);
			assert.equal(plain.details.usage, undefined);
			assert.doesNotMatch(plain.content[0].text, /cost unknown|Amp thread/);
			await h.ctl("close", fixture);
		});

		await t.test("a parked created run keeps its T-ID and mode; its resumed turn continues the thread in that mode", async () => {
			await h.ctl("close", opened.local);
			const id = (await delegate({ backend: "acp", agent: "amp", task: "Resume check\n…", executionEnvironment: "local", mode: "low" })).details.id;
			await h.ctl("wait", id);
			await until(() => record(id).labeled !== undefined, "labeling settled");
			await h.runtime.session.agent.waitForIdle();
			const parent = h.parent;
			await h.runtime.dispose();
			h = await harness(box, parent);
			const parked = await h.ctl("status", id);
			assert.ok(parked.details.parked);
			assert.equal(parked.details.session.nativeSessionId, localThread, "from the record, with no live worker");
			assert.equal(parked.details.mode, "low");
			const labelCalls = command("label").length;
			await h.ctl("steer", id, { message: "after the restart" });
			const done = await h.ctl("wait", id);
			assert.equal(done.details.status, "complete", done.content[0].text);
			const resumed = executions().at(-1)!;
			assert.deepEqual(resumed.slice(0, 3), ["threads", "continue", localThread]);
			assert.equal(resumed[resumed.indexOf("--mode") + 1], "low", "the resumed thread keeps its mode");
			assert.equal(resumed.includes("--title"), false);
			assert.equal((await h.ctl("status", id)).details.session.nativeSessionId, localThread);
			await sleep(200);
			assert.equal(command("label").length, labelCalls, "a resumed run is not labeled again");
			await h.ctl("close", id);
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
