import "./setup.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { deferred, provider, sandbox } from "./fixture.ts";

const api = await provider(), box = sandbox(api.url), socket = `branch-qc-${process.pid}`;
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", timeout: 10000 });
const capture = () => tmux("capture-pane", "-p", "-t", "pi");
const save = (name: string) => {
	writeFileSync(join(box.root, `${name}.txt`), capture());
	writeFileSync(join(box.root, `${name}.ansi`), tmux("capture-pane", "-e", "-p", "-t", "pi"));
};
const command = (value: string) => {
	writeFileSync(join(box.root, "commands.txt"), `${value}\n`, { flag: "a" });
	tmux("send-keys", "-t", "pi", "-l", value); tmux("send-keys", "-t", "pi", "Enter");
};
const until = async (check: () => boolean) => {
	for (const end = Date.now() + 15000; !check();) {
		if (Date.now() > end) throw new Error(`TUI condition timed out\n${capture()}`);
		await sleep(50);
	}
};
const records = () => {
	const dir = join(box.cwd, ".agents/pi/subsessions");
	try { return readdirSync(dir).filter(f => /^(worker|scout)-.*\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(dir, f), "utf8"))); }
	catch { return []; }
};
const gate = deferred(), childGate = deferred();
let child: any, managed = false;
try {
	writeFileSync(join(box.agentDir, "keybindings.json"), JSON.stringify({ "tui.input.newLine": ["shift+enter"] }));
	const parentRequest = api.script("TUI current conversation", { text: "TUI-MAIN-ACTIVE", gate });
	const childRequest = api.script("TUI bare task", { text: "TUI-TASK-RESULT", gate: childGate });
	api.onUnscripted(() => {
		if (!managed) { managed = true; return { tool: { name: "delegate_ctl", arguments: { action: "status", runId: child.id } } }; }
		return { text: "TUI-MAIN-VERIFIED-AND-INTEGRATED" };
	});
	const args = [process.execPath, cli, "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", resolve(import.meta.dirname, "terminal-fixture.ts"), "--model", "fixture/fixture", "--thinking", "off", "--tui-mode", "regular", "--session-dir", join(box.root, "parents")];
	const launcher = join(box.root, "launch.sh");
	writeFileSync(launcher, `#!/bin/sh\ncd ${quote(box.cwd)}\nexec env HOME=${quote(box.root)} PI_CODING_AGENT_DIR=${quote(box.agentDir)} PI_OFFLINE=1 PI_TELEMETRY=0 DELEGATE_SMOKE_ROOT=${quote(box.root)} DELEGATE_SMOKE_MANAGEMENT=1 ${args.map(quote).join(" ")}\n`, { mode: 0o700 });
	tmux("new-session", "-d", "-s", "pi", "-x", "140", "-y", "40", `sh ${quote(launcher)}`);
	await until(() => /FIXTURE-READY/.test(capture()));
	assert.doesNotMatch(capture(), /\[Extension issues\]|shortcut conflict/);
	command("TUI current conversation"); await parentRequest;
	save("main-active-before-delegate");
	command("/delegate TUI bare task"); const request = await childRequest;
	await until(() => records().some(r => r.task === "TUI bare task"));
	child = records().find(r => r.task === "TUI bare task");
	assert.equal(child.role, "worker"); assert.equal(child.context, "fork");
	assert.equal(child.parentRunId, undefined); assert.equal(child.depth, 1); assert.equal(child.userStarted, true);
	assert.match(JSON.stringify(request.messages), /TUI current conversation/);
	const trace = () => readFileSync(join(box.root, "trace.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
	await until(() => trace().some(e => e.details?.kind === "user-start"));
	const start = trace().find(e => e.details?.kind === "user-start");
	assert.equal(start.details.id, child.id); assert.equal(start.options.deliverAs, "followUp"); assert.equal(start.options.triggerTurn, true);
	assert.match(start.content, /own and must manage/);
	assert.equal(api.requests.length, 2, "ownership queued; main response is not interrupted");
	save("bare-task-started-ownership-queued");
	childGate.resolve();
	await until(() => records().some(r => r.id === child.id && r.status === "complete"));
	await until(() => trace().some(e => e.details?.id === child.id && e.details?.kind !== "user-start"));
	assert.equal(api.requests.length, 2, "completion also waits for busy main to settle");
	save("task-complete-main-still-active");
	gate.resolve();
	await until(() => api.requests.some(r => /TUI-TASK-RESULT/.test(JSON.stringify(r.messages)) && /Verify the result/.test(JSON.stringify(r.messages))));
	await until(() => /TUI-MAIN-VERIFIED-AND-INTEGRATED/.test(capture()));
	assert(managed, "main automatically supervised the run with delegate_ctl");
	assert(api.requests.some(r => r.messages.some((m: any) => m.tool_calls?.some((call: any) => call.function.name === "delegate_ctl" && JSON.parse(call.function.arguments).runId === child.id))));
	const parentFile = JSON.parse(readFileSync(join(box.root, "parent.json"), "utf8")).file;
	await until(() => /own and must manage/.test(readFileSync(parentFile, "utf8")) && /TUI-TASK-RESULT/.test(readFileSync(parentFile, "utf8")));
	save("main-owned-managed-and-handled-completion");
	writeFileSync(join(box.root, "requests.json"), JSON.stringify(api.requests, null, 2));
	assert.deepEqual(api.errors, []);
	console.log(`PASS bare /delegate task: worker/fork root ownership, immediate start, busy-main non-interruption, mandatory ownership follow-up and automatic completion management in real Pi TUI. Evidence: ${box.root}`);
} finally {
	gate.resolve(); childGate.resolve();
	try { tmux("kill-server"); } catch { /* startup may have failed */ }
	await api.close();
}
