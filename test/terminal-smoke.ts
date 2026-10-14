import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { provider, sandbox, deferred } from "./fixture.ts";
import { textOf } from "../src/util/text.ts";

const api = await provider(), box = sandbox(api.url);
const socket = `delegate-qc-${process.pid}`;
const cli = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle/cli.js");
const fixture = resolve(import.meta.dirname, "terminal-fixture.ts");
const tmux = (...args: string[]) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8", timeout: 10000 });
const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const capture = () => tmux("capture-pane", "-p", "-t", "pi");
const save = (name: string) => {
	const file = join(box.root, `${name}.txt`);
	writeFileSync(file, capture());
	writeFileSync(join(box.root, `${name}.ansi`), tmux("capture-pane", "-e", "-p", "-t", "pi"));
};
async function expect(pattern: RegExp, absent = false) {
	const deadline = Date.now() + 15000;
	let screen = "";
	while (Date.now() < deadline) {
		screen = capture();
		if (pattern.test(screen) !== absent) return screen;
		await sleep(50);
	}
	throw new Error(`Terminal ${absent ? "still contains" : "missing"} ${pattern}\n${screen}`);
}
const key = (...keys: string[]) => tmux("send-keys", "-t", "pi", ...keys);
const text = (value: string) => tmux("send-keys", "-t", "pi", "-l", value);
const mouse = (button: number, row: number) => text(`\x1b[<${button};3;${row}M${button === 0 ? `\x1b[<0;3;${row}m` : ""}`);
async function command(value: string) { text(value); key("Enter"); }
try {
	writeFileSync(join(box.cwd, "sample.ts"), Array.from({ length: 36 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join("\n"));
	// The setup the README documents: Ctrl+J belongs to the Agents frame, the newline keeps Shift+Enter.
	writeFileSync(join(box.agentDir, "keybindings.json"), JSON.stringify({ "tui.input.newLine": ["shift+enter"] }));
	for (const mode of ["regular", "fullscreen"]) {
		const release = join(box.root, `${mode}.release`);
		const finalGate = deferred();
		api.script("Native detail", {
			text: "# Inspecting the child\n\n**Native formatting** with `inline code`.\n\n```ts\nconst answer = 42;\n```",
			tool: { name: "read", arguments: { path: "sample.ts" } },
		}, {
			tool: { name: "bash", arguments: { command: `printf '%s\\n' ${Array.from({ length: 30 }, (_, i) => `'OUTPUT-${i + 1}'`).join(" ")}; while [ ! -f ${quote(release)} ]; do sleep 0.05; done; printf 'TOOL-LIVE-END\\n'` } },
		}, { text: Array.from({ length: 35 }, (_, i) => `Streaming line ${i + 1}`).join("\n"), gate: finalGate, after: "\n\n**LATEST-END**" });
		const args = [process.execPath, cli, "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", fixture, "--model", "fixture/fixture", "--thinking", "off", "--tui-mode", mode, "--session-dir", join(box.root, `parents-${mode}`)];
		const launch = join(box.root, `launch-${mode}.sh`);
		// Only environment overrides; avoid recording inherited credentials in the launcher.
		writeFileSync(launch, `#!/bin/sh\ncd ${quote(box.cwd)}\nexec env HOME=${quote(box.root)} PI_CODING_AGENT_DIR=${quote(box.agentDir)} PI_OFFLINE=1 PI_TELEMETRY=0 DELEGATE_SMOKE_ROOT=${quote(box.root)} ${args.map(quote).join(" ")}\n`, { mode: 0o700 });
		tmux("new-session", "-d", "-s", "pi", "-x", "110", "-y", "36", `sh ${quote(launch)}`);
		await expect(/FIXTURE-READY/);
		// Startup diagnostics are failures. An [Extension issues] banner sat in every capture
		// one evening while this suite kept passing; never again.
		assert.doesNotMatch(capture(), /\[Extension issues\]/);
		assert.doesNotMatch(capture(), /shortcut conflict/);
		const opening = "RECAP-OPEN: build persistent background agent management.";
		api.script(opening, { text: "RECAP-OPEN-ACK. Preserve native session references." });
		await command(opening); await expect(/RECAP-OPEN-ACK/);
		for (let i = 0; i < 12; i++) {
			const prompt = `RECAP-MIDDLE-${i}: retain the session tree. ${"older detail ".repeat(80)}`.trimEnd();
			api.script(prompt, { text: `RECAP-ACK-${i}. ${"recorded outcome ".repeat(20)}` });
			await command(prompt); await expect(new RegExp(`RECAP-ACK-${i}\\.`));
		}
		const current = "RECAP-CURRENT: recap uses a task anchor and recent dialogue. Next, verify cancellation.";
		api.script(current, { text: "RECAP-CURRENT-ACK. Keep the five-minute default." });
		await command(current); await expect(/RECAP-CURRENT-ACK/);
		let heldRecap: ReturnType<typeof deferred<void>> | undefined;
		api.onUnscripted(request => {
			const system = textOf(request.messages.find((message: any) => message.role === "system")?.content);
			assert.match(system, /The user stepped away/);
			const packet = textOf(request.messages.at(-1).content);
			assert.ok(system.length + packet.length <= 8000, "recap input stays bounded in the real provider request");
			assert.match(packet, /RECAP-OPEN/);
			assert.match(packet, /RECAP-CURRENT/);
			assert.doesNotMatch(packet, /RECAP-MIDDLE-0:/);
			return heldRecap ? { text: "STALE-LIVE-RECAP", gate: heldRecap }
				: { text: "Building persistent agent management with bounded away recaps. Next, verify cancellation when you return." };
		});
		await command("/recap test");
		await expect(/※ recap: Building persistent agent/);
		save(`${mode}-recap-bounded`);
		heldRecap = deferred<void>();
		const requested = api.requests.length;
		await command("/recap test");
		for (const deadline = Date.now() + 15000; api.requests.length === requested && Date.now() < deadline; await sleep(25)) {}
		assert.equal(api.requests.length, requested + 1);
		text("RECAP-RETURN-DRAFT"); await expect(/RECAP-RETURN-DRAFT/);
		await expect(/FAILED: Recap (?:snapshot became stale|was cancelled)/);
		heldRecap.resolve();
		assert.doesNotMatch(capture(), /※ recap: STALE-LIVE-RECAP/);
		save(`${mode}-recap-cancelled`);
		key("C-u");
		api.onUnscripted(undefined);
		await command("/fixture-mom-settings");
		await expect(/Path settings/);
		assert.match(capture(), /Background tracking/);
		assert.match(capture(), /work map in the background/);
		save(`${mode}-mom-settings`);
		key("Down"); await expect(/eligible findings from Path's map/);
		save(`${mode}-mom-settings-suggestions`);
		// A chooser takes the screen: the list and the setting's help give way to it.
		key("Down"); key("Down"); key("Down"); key("Enter"); await expect(/Enter to select/);
		assert.doesNotMatch(capture(), /Choose how Path keeps its notes|Background tracking/);
		save(`${mode}-mom-settings-chooser`);
		key("Escape"); await expect(/Choose how Path keeps its notes/);
		key("Escape"); await expect(/Path settings/, true);
		await command("/fixture-spawn Native detail");
		await expect(/Agents.*1 active/);
		text("PARENT-DRAFT"); key("C-j"); key("Enter");
		await expect(/^\s+OUTPUT-30\s*$/m); save(`${mode}-collapsed-live`);
		assert.doesNotMatch(capture(), /"command":|"path":/);
		assert.match(capture(), /earlier lines|more lines/);
		// Like Pi itself, regular mode leaves mouse handling to the terminal emulator.
		if (mode === "fullscreen") {
			mouse(0, capture().split("\n").findIndex((line) => /^\s+OUTPUT-30\s*$/.test(line)) + 1);
			await expect(/earlier lines/, true); save(`${mode}-mouse-expanded`);
		}
		key("C-o"); key("PPage"); await expect(/^\s+OUTPUT-(?:1|2)\s*$/m); save(`${mode}-expanded`);
		key("C-o"); key("C-End");
		// Esc leaves the child for the Agents list; ← returns to the editor, and ← at the start of the draft re-enters the list.
		text("CHILD-DRAFT"); key("Escape"); await expect(/PARENT-DRAFT/); await expect(/→ open · ← editor/);
		key("Left"); await expect(/← agents · /);
		// Ctrl+A, not Home: fullscreen mode gives Home to the transcript.
		key("C-a"); key("Left"); await expect(/→ open · ← editor/);
		key("Right"); await expect(/CHILD-DRAFT/); key("C-u");
		writeFileSync(release, "release");
		await expect(/Streaming line 35/); save(`${mode}-streaming-latest`);
		key("PPage"); await expect(/scroll paused/);
		finalGate.resolve(); await expect(/complete ·/);
		assert.doesNotMatch(capture(), /LATEST-END/); save(`${mode}-paused-after-complete`);
		key("C-End"); await expect(/LATEST-END/); save(`${mode}-latest`);
		key("NPage"); assert.match(capture(), /LATEST-END/);
		if (mode === "fullscreen") { mouse(64, 6); await expect(/scroll paused/); key("C-End"); }
		tmux("resize-window", "-t", "pi", "-x", "54", "-y", "20");
		await expect(/LATEST-END/); save(`${mode}-narrow`);
		// The settled child stays listed (dimmed) until the next prompt; ← returns to the editor.
		key("Escape"); await expect(/PARENT-DRAFT/); await expect(/Agents.*active/, true); await expect(/Agents · 1 done/);
		key("Left"); await expect(/← agents · /); key("C-e");
		// A launch must hand off before the child finishes; it must never freeze the parent turn.
		tmux("resize-window", "-t", "pi", "-x", "110", "-y", "36");
		const joinGate = deferred();
		api.script("Join a child", { tool: { name: "delegate", arguments: { role: "scout", context: "fresh", model: "fixture/fixture:off", cwd: box.cwd, task: "Joined child\nReply JOINED-DONE." } } }, { text: "PARENT-SAW-RESULT" });
		api.script("Joined child\nReply JOINED-DONE.", { text: "JOINED-DONE", gate: joinGate });
		api.onUnscripted(() => ({ text: "COMPLETION-ACK" }));
		key("C-u"); await command("Join a child");
		await expect(/PARENT-SAW-RESULT/);
		await expect(/Waiting for a new scout/, true);
		await expect(/parent blocked in wait/, true); save(`${mode}-background`);
		joinGate.resolve(); await expect(/✓ Joined child/);
		// The Agents frame lists the settled run too; the transcript records its outcome once.
		assert.equal(capture().split("\n").filter((line) => /✓ Joined child/.test(line) && !line.startsWith("│")).length, 1, "the outcome is recorded once, not reprinted");
		// Control-tool output uses Pi's own tool shape: titled line, clipped preview, expandable.
		api.script("Show the roles", { tool: { name: "delegate_ctl", arguments: { action: "roles" } } }, { text: "ROLES-SEEN" });
		key("C-u"); await command("Show the roles");
		await expect(/ROLES-SEEN/);
		const listed = capture();
		assert.match(listed, /delegate_ctl roles 3/);
		// One aligned row per role, no wrapped wall of paths.
		for (const role of ["reviewer", "scout", "worker"]) assert.match(listed, new RegExp(`\\n\\s+${role} +(fresh|fork)`));
		assert.match(listed, /scout +fresh:low +needs approval +read-only · 5 tools/);
		assert.match(listed, /worker +fork:medium +needs approval +writes · 7 tools/);
		// Prose written for the model does not survive a column; no row ends mid-word.
		assert.doesNotMatch(listed, /Read-only recon of code/);
		assert.doesNotMatch(listed, /roles\/scout\.md/, "sources belong behind the expand, not in the collapsed row");
		save(`${mode}-control-collapsed`);
		key("C-o");
		await expect(/roles\/scout\.md/);
		assert.match(capture(), /Read-only recon of code the parent has not seen/, "the full purpose is what the expand is for");
		save(`${mode}-control-expanded`); key("C-o");
		// A long text report previews its head — what it leads with — not its tail.
		api.script("Show all runs", { tool: { name: "delegate_ctl", arguments: { action: "status" } } }, { text: "STATUS-SEEN" });
		key("C-u"); await command("Show all runs");
		await expect(/STATUS-SEEN/);
		const statusView = capture();
		assert.match(statusView, /delegate_ctl status/);
		assert.match(statusView, /delegate_ctl status 2 children/);
		assert.match(statusView, /✓ Native detail\s+scout · /, "one styled row per child, not a summary wall");
		save(`${mode}-control-status`);
		// A child's full report stays one line until ctrl+o, however long the report is.
		const lastLaunch = JSON.parse(readFileSync(join(box.root, "trace.jsonl"), "utf8").trim().split("\n").filter((l) => l.includes('"launch"')).pop()!).details.id;
		api.script("Show that report", { tool: { name: "delegate_ctl", arguments: { action: "result", runId: lastLaunch } } }, { text: "REPORT-SEEN" });
		key("C-u"); await command("Show that report");
		await expect(/REPORT-SEEN/);
		assert.doesNotMatch(capture(), /LATEST-END/, "the report is collapsed to its outcome line");
		save(`${mode}-control-report`);
		key("C-o"); await expect(/LATEST-END/); save(`${mode}-control-report-expanded`); key("C-o");
		key("C-u"); await command("/agents"); await expect(/Finished agents/); key("Enter"); await expect(/LATEST-END/);
		api.script("Resume detail", { text: "**RESUMED-SAME-CHILD**" });
		await command("Resume detail"); await expect(/RESUMED-SAME-CHILD/); save(`${mode}-resumed`);
		api.script("Stop detail", { text: "STOP-LIVE", gate: deferred() });
		await command("Stop detail"); await expect(/STOP-LIVE/); key("C-x"); await expect(/Enter restart/);
		api.script("Restart detail", { text: "RESTARTED-SAME-CHILD" });
		await command("Restart detail"); await expect(/RESTARTED-SAME-CHILD/); save(`${mode}-restarted`);
		key("Escape"); await expect(/FIXTURE-READY/);
		await command("/reload");
		await expect(/Reloaded .*extensions/); // the real completion line; a persisting footer proves nothing
		await expect(/Agents.*active/, true);
		assert.doesNotMatch(capture(), /\[Extension issues\]/);
		// Ctrl+J is taken, so a multiline draft must still work through the remaining newline key.
		// tmux cannot send Shift+Enter without extended-keys; send its modifyOtherKeys encoding.
		text("MULTI-A"); text("\x1b[27;2;13~"); text("MULTI-B");
		await expect(/MULTI-A[^\n]*\n[^\n]*MULTI-B/); // two lines, not one submitted or joined draft
		save(`${mode}-multiline`);
		key("C-c"); await expect(/MULTI-B/, true);
		tmux("kill-session", "-t", "pi");
	}
	const events = readFileSync(join(box.root, "trace.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	for (const launch of events.filter((e) => e.event === "launch")) {
		const outcomes = events.filter((e) => e.event === "complete" && e.details.id === launch.details.id);
		assert.deepEqual(outcomes.map((e) => e.details.segment), [1, 2, 3, 4]);
		assert.deepEqual(outcomes.map((e) => e.details.status), ["complete", "complete", "cancelled", "complete"]);
		assert.equal(new Set(outcomes.map((e) => e.details.sessionFile)).size, 1);
	}
	assert.deepEqual(api.errors, []);
	console.log(`PASS real Pi regular/fullscreen: bounded recap input, visible recap, cancellation on return, clean startup, native collapsed/expanded tools, streaming latest, paused scrolling, narrow resize, drafts, same-ID revival, hidden finished frame.\nEvidence: ${box.root}`);
} catch (error) {
	try { save("failure"); } catch { /* process may already have exited */ }
	console.error(`Evidence: ${box.root}`); throw error;
} finally {
	try { execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore", timeout: 10000 }); } catch { /* no remaining fixture */ }
	await api.close();
}
