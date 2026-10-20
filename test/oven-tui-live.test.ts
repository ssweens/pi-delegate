import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { provider, sandbox, harness } from "./fixture.ts";

/**
 * Live: real agents as tui children through a real oven (OVEN_DIR). Off unless PI_DELEGATE_LIVE_TUI=1.
 * Pi runs on the loopback model. Claude runs when PI_DELEGATE_CLAUDE_SETTINGS names a settings file that
 * carries its provider and auth, or PI_DELEGATE_CLAUDE_CONFIG a logged-in Claude config dir (its settings.json
 * and .credentials.json); either is linked, never copied, into an isolated CLAUDE_CONFIG_DIR. It uses the
 * role's `claude:` model, haiku. Claude's workspace trust is granted once, on oven's
 * copies folder, not on each copy.
 */
const OVEN_DIR = process.env.OVEN_DIR ?? "";
const DAEMON = join(OVEN_DIR, "src", "daemon.ts");
const live = process.env.PI_DELEGATE_LIVE_TUI === "1";
const skip = !live ? "set PI_DELEGATE_LIVE_TUI=1 (and OVEN_DIR) to run real agents" : !existsSync(DAEMON) && `no oven at ${OVEN_DIR}`;

const freePort = () => new Promise<number>((resolve, reject) => {
	const server = createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => { const { port } = server.address() as { port: number }; server.close(() => resolve(port)); });
});

test("live: real Pi and Claude TUIs as delegate children answer, and a steer wakes the same session", { timeout: 600_000, skip }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	const home = process.env.HOME!;
	Object.assign(process.env, { OVEN_URL: `http://127.0.0.1:${await freePort()}`, OVEN_SERVICE: "off", OVEN_TAILSCALE: "off", OVEN_SETUP: "off",
		OVEN_LAUNCH_AGENTS_DIR: join(home, "LaunchAgents"), OVEN_ROLES_DIR: join(home, "roles"), CLAUDE_CONFIG_DIR: join(home, ".claude"), DISABLE_AUTOUPDATER: "1" });
	delete process.env.OVEN_TOKEN;
	const { startDaemon } = await import(DAEMON);
	const { dataDir } = await import(join(OVEN_DIR, "src", "paths.ts"));
	const daemon = await startDaemon({ toolHost: { tools: [], dropped: [], errors: [], async promptFor() { return ""; }, close() {} } });
	const { ovenCall } = await import("../src/oven.ts");
	const agents = join(box.cwd, ".pi", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(join(agents, "live.md"), "---\nname: live\ndescription: Answers briefly.\nmodel: fixture/fixture\nclaude: {model: haiku}\n---\n\nAnswer exactly as asked.\n");
	const h = await harness(box);
	const cleanup: string[] = [];
	const run = async (agent: "pi" | "claude", word: string) => {
		const ask = `Reply with exactly ${word} and nothing else.`;
		if (agent === "pi") api.script(ask, { text: word });
		const started = await h.launch(ask, { role: "live", tui: agent, model: undefined });
		const result = await h.ctl("wait", started.details.id);
		const slice = (await ovenCall<any[]>("list", {})).find((s) => s.kind === "tui" && s.agent === agent && !cleanup.includes(s.id));
		if (slice) cleanup.push(slice.id);
		return { id: started.details.id, result };
	};
	try {
		await t.test("pi", async () => {
			const { id, result } = await run("pi", "LIVE-PI");
			assert.equal(result.details.status, "complete", result.content[0].text);
			assert.match(result.details.output, /^LIVE-PI\n\n\(oven pi slice /);
			api.script("Reply with exactly AGAIN-PI and nothing else.", { text: "AGAIN-PI" });
			await h.ctl("steer", id, { message: "Reply with exactly AGAIN-PI and nothing else." });
			await new Promise((resolve) => setTimeout(resolve, 500));
			assert.match((await h.ctl("wait", id)).details.output, /^AGAIN-PI/);
		});
		const claudeSettings = process.env.PI_DELEGATE_CLAUDE_SETTINGS, claudeConfig = process.env.PI_DELEGATE_CLAUDE_CONFIG;
		await t.test("claude", { skip: !claudeSettings && !claudeConfig && "set PI_DELEGATE_CLAUDE_SETTINGS or PI_DELEGATE_CLAUDE_CONFIG" }, async () => {
			const config = process.env.CLAUDE_CONFIG_DIR!, copies = join(dataDir(), "tui", "copies");
			mkdirSync(config, { recursive: true }); mkdirSync(copies, { recursive: true });
			const trusted = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
			writeFileSync(join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: { [copies]: trusted, [realpathSync(copies)]: trusted } }));
			if (claudeSettings) symlinkSync(claudeSettings, join(config, "settings.json"));
			else for (const name of ["settings.json", ".credentials.json"]) if (existsSync(join(claudeConfig!, name))) symlinkSync(join(claudeConfig!, name), join(config, name));
			const { id, result } = await run("claude", "LIVE-CLAUDE");
			assert.equal(result.details.status, "complete", result.content[0].text);
			assert.match(result.details.output, /LIVE-CLAUDE/);
			await h.ctl("steer", id, { message: "Reply with exactly AGAIN-CLAUDE and nothing else." });
			await new Promise((resolve) => setTimeout(resolve, 500));
			assert.match((await h.ctl("wait", id)).details.output, /AGAIN-CLAUDE/);
		});
	} finally {
		for (const slice of cleanup) { await ovenCall("stop", { slice }).catch(() => {}); await ovenCall("retire", { slices: [slice] }).catch(() => {}); }
		await h.runtime.dispose();
		await daemon.stop();
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
