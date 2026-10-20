import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { provider, sandbox, harness } from "./fixture.ts";
import { tuiTemplate } from "../src/tui-template.ts";
import type { Role } from "../src/roles.ts";
import { validateStartInput } from "../src/backend.ts";

/**
 * tui children against a real oven (OVEN_DIR, as test/oven-runtime.test.ts), with oven's stand-in agent
 * (its test/fixtures/fake-agent.py) as `pi` on PATH: it reports OSC 7501 and records Pi-shaped sessions,
 * so the whole route runs without inference. Real agents are covered by oven's `agents prove`.
 */
const OVEN_DIR = process.env.OVEN_DIR ?? join(process.env.npm_config_local_prefix ?? process.cwd(), "..", "..", "..", "Users-ssweens-src-oven", "copies", "agents-only");
const DAEMON = join(OVEN_DIR, "src", "daemon.ts");
const FAKE_AGENT = join(OVEN_DIR, "test", "fixtures", "fake-agent.py");
const tmux = (() => { try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = !existsSync(FAKE_AGENT) ? `no oven checkout with tui slices at ${OVEN_DIR} (set OVEN_DIR)` : !tmux && "tmux is not installed";

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
	});
}

async function waitFor(condition: () => boolean | Promise<boolean>, ms = 20_000) {
	const end = Date.now() + ms;
	while (!(await condition())) {
		if (Date.now() > end) assert.fail("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

const role = (fields: Partial<Role>, frontmatter: string): Role => {
	const file = join(process.env.HOME!, `${fields.name ?? "r"}-${Math.random().toString(36).slice(2)}.md`);
	writeFileSync(file, `---\n${frontmatter}\n---\nBody.\n`);
	return { name: "r", description: "", systemPrompt: "Body.", source: file, file, ...fields };
};

test("a role becomes the agent's template: Pi gets the top-level fields, Claude and Amp only their own sections; Amp's instructions lead the task", () => {
	const fm = "name: r\nmodel: fixture/fixture\ntools: read, bash\nenv: {MODE: x}\nclaude: {model: haiku, thinking: low}\namp: {mode: low}";
	const r = role({ name: "r", model: "fixture/fixture", tools: ["read", "bash"] }, fm);
	assert.deepEqual(tuiTemplate(r, "pi", "Do it."), { template: { name: "r", env: { MODE: "x" }, body: "Do it.", model: "fixture/fixture", tools: ["read", "bash"] } });
	assert.deepEqual(tuiTemplate(r, "claude", "Do it."), { template: { name: "r", env: { MODE: "x" }, body: "Do it.", claude: { model: "haiku", thinking: "low" } } });
	assert.deepEqual(tuiTemplate(r, "amp", "Do it."), { template: { name: "r", env: { MODE: "x" }, amp: { mode: "low" } }, taskPrefix: "Do it." });
	assert.equal(validateStartInput({ backend: "pi", role: "r", task: "t", tui: "codex" }).ok, false);
	assert.equal(validateStartInput({ backend: "pi", role: "r", task: "t", tui: "claude", runtime: "in-process" }).ok, false);
	const ok = validateStartInput({ backend: "pi", role: "r", task: "t", tui: "claude" });
	assert.ok(ok.ok && ok.value.backend === "pi" && ok.value.tui === "claude");
});

test("a tui child runs the agent's own TUI in oven: created from the role in a copy, answered from the agent's record, stopped between segments, woken by steer, halted by cancel", { timeout: 180_000, skip }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	Object.assign(process.env, { OVEN_URL: `http://127.0.0.1:${await freePort()}`, OVEN_SERVICE: "off", OVEN_TAILSCALE: "off", OVEN_SETUP: "off",
		OVEN_LAUNCH_AGENTS_DIR: join(process.env.HOME!, "LaunchAgents"), OVEN_ROLES_DIR: join(process.env.HOME!, "roles") });
	delete process.env.OVEN_TOKEN;
	const bin = join(box.root, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "pi"), `#!/bin/sh\nexec python3 -I ${FAKE_AGENT} "$@"\n`);
	chmodSync(join(bin, "pi"), 0o755);
	process.env.PATH = `${bin}:${process.env.PATH}`;
	const { startDaemon } = await import(DAEMON);
	const daemon = await startDaemon({ toolHost: { tools: [], dropped: [], errors: [], async promptFor() { return ""; }, close() {} } });
	const { ovenCall } = await import("../src/oven.ts");
	const agents = join(box.cwd, ".pi", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(join(agents, "tui-baker.md"), "---\nname: tui-baker\ndescription: Bakes in its own TUI.\ntui: pi\nmodel: fixture/fixture\n---\n\nBake carefully.\n");
	writeFileSync(join(agents, "tui-keeper.md"), "---\nname: tui-keeper\ndescription: Needs a secret.\ntui: pi\nmodel: fixture/fixture\nsecrets: [FAKE_AGENT_SECRET]\n---\n\nKeep it.\n");
	const h = await harness(box);
	const tuiSlices = async () => (await ovenCall<any[]>("list", {})).filter((s) => s.kind === "tui");
	const sliceOf = async (output: string) => { const id = /oven pi slice (t-[\w-]+)/.exec(output)?.[1]; assert.ok(id, output); return (await tuiSlices()).find((s) => s.id === id)!; };
	try {
		let runId = "";
		await t.test("create from the role, in a copy; the answer is the agent's; the agent stops when the segment settles", async () => {
			const started = await h.launch("Bake one", { role: "tui-baker" });
			runId = started.details.id;
			const result = await h.ctl("wait", runId);
			assert.equal(result.details.status, "complete", result.content[0].text);
			const [slice] = await tuiSlices();
			assert.match(result.details.output, new RegExp(`^answer to: Bake one\\n\\n\\(oven pi slice ${slice.id}; its changes are in its copy, `));
			assert.notEqual(slice.cwd, realpathSync(box.cwd), "it works in a copy");
			const argv = JSON.parse(readFileSync(join(process.env.HOME!, "fake-agent.argv"), "utf8").trim().split("\n")[0]);
			assert.equal(argv[argv.indexOf("--model") + 1], "fixture/fixture:off", "the call's model overrides the template's (the harness passes one)");
			assert.match(argv[argv.indexOf("--append-system-prompt") + 1], /Bake carefully\./, "the role's instructions");
			await waitFor(async () => (await tuiSlices())[0].state === "stopped");
		});

		await t.test("steer on a settled tui run wakes the same agent session", async () => {
			await h.ctl("steer", runId, { message: "Bake again" });
			await waitFor(async () => (await h.ctl("status", runId)).details.status !== "running");
			const result = await h.ctl("wait", runId);
			assert.match(result.details.output, /^answer to: Bake again/);
			const slices = await tuiSlices();
			assert.equal(slices.length, 1, "the same slice");
			assert.equal(slices[0].launches, 2, "relaunched on its session");
		});

		await t.test("cancel halts a running tui child and stops it", async () => {
			const started = await h.launch("Bake slow", { role: "tui-baker" });
			await waitFor(async () => (await tuiSlices()).some((s) => s.status?.state === "working"));
			const cancelled = await h.ctl("cancel", started.details.id);
			assert.equal(cancelled.isError, undefined, cancelled.content[0].text);
			assert.equal((await h.ctl("wait", started.details.id)).details.status, "cancelled");
			// Well inside the stand-in's 6 s slow turn, which would otherwise end by itself.
			await waitFor(async () => (await tuiSlices()).every((s) => s.status?.state !== "working"), 3000);
			await waitFor(async () => (await tuiSlices()).every((s) => s.state === "stopped"), 3000);
		});

		await t.test("steer on a running tui child interrupts its turn and answers the steer, in the same session", async () => {
			const before = new Set((await tuiSlices()).map((s) => s.id));
			const started = await h.launch("Bake slow", { role: "tui-baker" });
			await waitFor(async () => (await tuiSlices()).some((s) => !before.has(s.id) && s.status?.state === "working"));
			const steered = await h.ctl("steer", started.details.id, { message: "Bake now instead" });
			assert.equal(steered.isError, undefined, steered.content[0].text);
			const result = await h.ctl("wait", started.details.id);
			assert.equal(result.details.status, "complete", result.content[0].text);
			assert.match(result.details.output, /^answer to: Bake now instead/);
			const slice = await sliceOf(result.details.output);
			assert.equal(slice.launches, 1, "the running agent took the steer; nothing relaunched");
		});

		await t.test("a role's secrets reach the agent from this session's environment, not its argv or the run record; a missing one fails the run before oven", async () => {
			delete process.env.FAKE_AGENT_SECRET;
			const before = (await tuiSlices()).length;
			const missing = await h.ctl("wait", (await h.launch("Keep one", { role: "tui-keeper" })).details.id);
			assert.equal(missing.details.status, "error");
			assert.match(missing.content[0].text, /FAKE_AGENT_SECRET/);
			assert.equal((await tuiSlices()).length, before, "no slice was made");
			const value = `s3cret-${Math.random().toString(36).slice(2)}`;
			process.env.FAKE_AGENT_SECRET = value;
			try {
				const run = await h.launch("Keep two", { role: "tui-keeper" });
				const result = await h.ctl("wait", run.details.id);
				assert.equal(result.details.status, "complete", result.content[0].text);
				assert.equal(readFileSync(join(process.env.HOME!, "fake-agent.secret"), "utf8"), value, "the agent has the value");
				assert.ok(!readFileSync(join(process.env.HOME!, "fake-agent.argv"), "utf8").includes(value), "never in an argv");
				assert.ok(!JSON.stringify(await h.ctl("status", run.details.id)).includes(value), "never in the run record");
				rmSync(join(process.env.HOME!, "fake-agent.secret"));
				delete process.env.FAKE_AGENT_SECRET;
				await h.ctl("steer", run.details.id, { message: "Keep again" });
				await waitFor(async () => (await h.ctl("status", run.details.id)).details.status !== "running");
				assert.match((await h.ctl("wait", run.details.id)).details.output, /^answer to: Keep again/);
				assert.equal(readFileSync(join(process.env.HOME!, "fake-agent.secret"), "utf8"), value, "a relaunch keeps the value oven was given");
			} finally { delete process.env.FAKE_AGENT_SECRET; }
		});
	} finally {
		for (const slice of await tuiSlices().catch(() => [])) { await ovenCall("stop", { slice: slice.id }).catch(() => {}); await ovenCall("retire", { slices: [slice.id] }).catch(() => {}); }
		await h.runtime.dispose();
		await daemon.stop();
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
