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
	try { return readdirSync(dir).filter(f => /^(coordinator|scout)-.*\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(dir, f), "utf8"))); }
	catch { return []; }
};
const gate = deferred(), childGate = deferred();
try {
	mkdirSync(join(box.agentDir, "agents"), { recursive: true });
	writeFileSync(join(box.agentDir, "agents/coordinator.md"), "---\nname: coordinator\ndescription: TUI branch lead\ntools: read, delegate, delegate_ctl\nmodel: fixture/fixture:off\n---\nCoordinate.\n");
	writeFileSync(join(box.agentDir, "keybindings.json"), JSON.stringify({ "tui.input.newLine": ["shift+enter"] }));
	const leadRequest = api.script("TUI lead", { text: "TUI-LEAD-ACTIVE", gate });
	const childRequest = api.script("TUI branch", { text: "TUI-BRANCH-RESULT", gate: childGate });
	api.onUnscripted(() => ({ text: "TUI-LEAD-SAW-BRANCH" }));
	const args = [process.execPath, cli, "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", resolve(import.meta.dirname, "terminal-fixture.ts"), "--model", "fixture/fixture", "--thinking", "off", "--tui-mode", "regular", "--session-dir", join(box.root, "parents")];
	const launcher = join(box.root, "launch.sh");
	writeFileSync(launcher, `#!/bin/sh\ncd ${quote(box.cwd)}\nexec env HOME=${quote(box.root)} PI_CODING_AGENT_DIR=${quote(box.agentDir)} PI_OFFLINE=1 PI_TELEMETRY=0 DELEGATE_SMOKE_ROOT=${quote(box.root)} ${args.map(quote).join(" ")}\n`, { mode: 0o700 });
	tmux("new-session", "-d", "-s", "pi", "-x", "140", "-y", "40", `sh ${quote(launcher)}`);
	await until(() => /FIXTURE-READY/.test(capture()));
	assert.doesNotMatch(capture(), /\[Extension issues\]|shortcut conflict/);
	command("/delegate fresh:coordinator TUI lead"); await leadRequest;
	await until(() => records().some(r => r.task === "TUI lead"));
	const lead = records().find(r => r.task === "TUI lead");
	save("before-branch");
	command(`/delegate under:${lead.id} fresh:scout TUI branch`); await childRequest;
	await until(() => /started under/.test(capture()));
	const child = records().find(r => r.task === "TUI branch");
	assert.equal(child.parentRunId, lead.id); assert.equal(child.depth, 2); assert.notEqual(child.ownerKey, lead.ownerKey);
	save("branch-started");
	command(`/delegate under:${lead.id} process printf 'TUI-PROCESS-RESULT'; sleep 30`);
	await until(() => /Processes.*1\/1/.test(capture()));
	const processFile = readdirSync(join(box.cwd, ".agents/pi/subsessions"), { recursive: true })
		.map(String).find(f => /\/process\/process-.*\.json$/.test(f));
	assert(processFile);
	const processRun = JSON.parse(readFileSync(join(box.cwd, ".agents/pi/subsessions", processFile), "utf8"));
	assert.equal(processRun.parentRunId, lead.id); assert.equal(processRun.depth, 2);
	save("process-branch-started");
	// Open the new branch process row through the real Agents panel, not a fixture control.
	tmux("send-keys", "-t", "pi", "Left", "Down", "Down", "Enter");
	await until(() => /╭─ Process ─/.test(capture()) && /outputFile:/.test(capture()));
	assert.match(capture(), /under: coordinator-/);
	save("process-branch-detail");
	tmux("send-keys", "-t", "pi", "C-x");
	await until(() => JSON.parse(readFileSync(join(box.cwd, ".agents/pi/subsessions", processFile), "utf8")).status === "cancelled");
	save("process-branch-cancelled");
	tmux("send-keys", "-t", "pi", "Escape");
	await until(() => !/╭─ Process ─/.test(capture()));
	tmux("send-keys", "-t", "pi", "Escape");
	childGate.resolve();
	await until(() => records().some(r => r.id === child.id && r.status === "complete"));
	assert.equal(api.requests.length, 2, "child completion waits while lead response is active");
	gate.resolve();
	await until(() => records().some(r => r.id === lead.id && r.output.includes("TUI-LEAD-SAW-BRANCH")));
	save("lead-received-branch");
	assert(api.requests.some(r => JSON.stringify(r.messages).includes("TUI-BRANCH-RESULT")));
	console.log(`PASS direct Pi/process branch commands in real Pi TUI, root process cancel, owner lineage, and deferred lead completion. Evidence: ${box.root}`);
} finally {
	gate.resolve(); childGate.resolve();
	try { tmux("kill-server"); } catch { /* startup may have failed */ }
	await api.close();
}
