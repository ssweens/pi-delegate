import "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { harness, provider, sandbox } from "./fixture.ts";
import { validateStartInput } from "../src/backend.ts";
import { processLine, resultView } from "../src/render.ts";

test("unused registered lifecycle and read-only status leave storage untouched", async (t) => {
	const box = sandbox("http://127.0.0.1:1/v1");
	t.after(() => rmSync(box.root, { recursive: true, force: true }));
	for (const legacy of [false, true]) {
		const storage = join(box.cwd, ".agents/pi/subsessions");
		if (legacy) mkdirSync(storage, { recursive: true });
		const h = await harness(box);
		try {
			assert.equal(existsSync(join(box.cwd, ".agents")), legacy);
			await h.ctl("status");
			await h.runtime.session.reload();
			assert.deepEqual(h.errors, []);
		} finally { await h.runtime.dispose(); }
		if (legacy) assert.deepEqual(readdirSync(storage), []);
		else assert.equal(existsSync(join(box.cwd, ".agents")), false);
	}
});

test("process input preserves command bytes and rejects agent fields", () => {
	const command = "  printf 'hello\\n'  ";
	assert.deepEqual(validateStartInput({ backend: "process", command }), { ok: true, value: { backend: "process", command } });
	for (const field of ["role", "model", "context", "agent", "sessionId", "runtime", "tui", "mode", "firstDeliverableMin", "executionEnvironment", "reason"]) {
		const result = validateStartInput({ backend: "process", command, [field]: "not allowed" });
		assert.equal(result.ok, false, field);
		if (!result.ok) assert.equal(result.error.field, field);
	}
	for (const timeoutMs of [0, -1, 1.5, Infinity]) assert.equal(validateStartInput({ backend: "process", command, timeoutMs }).ok, false);
});

test("process tools: output, waits, notifications, cancel, reload and owner exit", { timeout: 60000 }, async (t) => {
	const api = await provider(), box = sandbox(api.url);
	api.onUnscripted(() => ({ text: "ACK" }));
	let h = await harness(box);
	const start = (command: string, extra: any = {}) => h.launch("Command title", { role: undefined, model: undefined, context: undefined, backend: "process", command, ...extra });
	try {
		await t.test("immediate launch, non-cancelling timed/aborted waits, unsupported controls", async () => {
			const launch = await start("printf 'LIVE\\n'; sleep 30");
			const v = launch.details;
			assert.equal(readFileSync(join(box.cwd, ".agents/pi/subsessions/.gitignore"), "utf8"), "*\n");
			assert.match(v.id, /^process-/); assert.equal(v.status, "running"); assert.equal(typeof v.pid, "number");
			assert.match(launch.content[0].text, /PID: .*\noutputFile:/);
			for (const action of ["steer", "close", "models"]) {
				const result = await h.ctl(action, v.id, { message: "no replay" });
				assert.equal(result.details.error.code, "ACTION_UNSUPPORTED");
				assert.match(result.content[0].text, /one-shot process/);
			}
			const timed = await h.ctl("wait", v.id, { timeoutMs: 30 });
			assert.match(timed.content[0].text, /nothing was cancelled/);
			const abort = new AbortController();
			const waiting = h.ctl("wait", v.id, {}, abort.signal);
			await sleep(30); abort.abort();
			await assert.rejects(waiting, { name: "AbortError" });
			assert.equal((await h.ctl("result", v.id)).details.status, "running");
			assert.match(readFileSync(v.outputFile, "utf8"), /LIVE/);
			assert.ok((await h.ctl("status")).details.rows.some((row: any) => row.id === v.id));
			await h.runtime.session.reload();
			assert.equal((await h.ctl("status", v.id)).details.pid, v.pid);
			const cancelled = await h.ctl("cancel", v.id);
			assert.equal(cancelled.details.status, "cancelled"); assert.equal(cancelled.details.signal, "SIGTERM");
		});
		await t.test("joined completion returns exit facts with no duplicate notice", async () => {
			const v = (await start("sleep 0.2; printf 'EXIT-SEVEN\\n'; exit 7")).details;
			const done = await h.ctl("wait", v.id);
			assert.equal(done.details.status, "error"); assert.equal(done.details.exitCode, 7); assert.equal(done.isError, true);
			assert.match(done.details.output, /EXIT-SEVEN/);
			await sleep(100);
			assert.equal(h.notices.filter(n => n.details?.id === v.id).length, 0);
			const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as any;
			assert.match(processLine(done.details, theme, 110), /exit 7/);
			assert.doesNotMatch(processLine(done.details, theme, 110), /thinking|tokens|\$|model/);
			assert.match(resultView("delegate_ctl", "result", "", done, { expanded: true }, theme, 110).join("\n"), /outputFile:/);
		});
		await t.test("unjoined completion wakes once", async () => {
			const v = (await start("sleep 0.1; printf 'SUCCESS\\n'")).details;
			for (const until = Date.now() + 5000; !h.notices.some(n => n.details?.id === v.id) && Date.now() < until;) await sleep(20);
			await h.runtime.session.agent.waitForIdle();
			const notices = h.notices.filter(n => n.details?.id === v.id);
			assert.equal(notices.length, 1); assert.equal(notices[0].details.exitCode, 0); assert.match(notices[0].content, /SUCCESS/);
		});
		await t.test("parent exit stops a process and reopen reads without replay", async () => {
			const v = (await start("printf 'ONCE\\n'; sleep 30")).details;
			const parent = h.parent;
			await h.runtime.dispose();
			h = await harness(box, parent);
			const restored = (await h.ctl("result", v.id)).details;
			assert.equal(restored.status, "interrupted"); assert.equal(restored.pid, v.pid);
			assert.equal(restored.output.match(/ONCE/g)?.length, 1);
		});
	} finally { await h.runtime.dispose(); await api.close(); }
});
