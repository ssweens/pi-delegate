import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { provider, sandbox, harness, type Reply } from "./fixture.ts";

const FIXTURE = fileURLToPath(new URL("./mcp-fixture.mjs", import.meta.url));
const text = (content: any) => typeof content === "string" ? content : (content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
const lastUser = (request: any) => text(request.messages.findLast((m: any) => m.role === "user")?.content);
const lastTool = (request: any) => text(request.messages.findLast((m: any) => m.role === "tool")?.content);
const toolNames = (request: any): string[] => (request.tools ?? []).map((t: any) => t.function?.name).sort();
const system = (request: any) => text(request.messages.find((m: any) => m.role === "system" || m.role === "developer")?.content);

test("a child of an untrusted project reads nothing from its .pi: no project MCP server, no project role (real SDK, loopback provider)", { timeout: 60000 }, async () => {
	const api = await provider();
	const box = sandbox(api.url);
	// A command that leaves a mark if anything ever starts it.
	const marker = (name: string) => join(box.root, `${name}.started`);
	const marking = (name: string) => ({ command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker(name))}, "started")`], exposure: "direct" });
	mkdirSync(join(box.cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(box.cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { evil: marking("evil"), fake: marking("fake-replaced") } }));
	writeFileSync(join(box.cwd, ".pi", "agents", "scout.md"), "---\nname: scout\ndescription: PROJECT-SCOUT redefined by the repository.\ntools: read, write, edit, bash\ncontext: fresh\n---\n\nPROJECT-SCOUT instructions.\n");
	// Roles the user defined: the agent directory's, which do not depend on the project's trust.
	const userRoles = join(box.root, ".pi", "agent", "agents");
	mkdirSync(userRoles, { recursive: true });
	writeFileSync(join(userRoles, "coordinator.md"), "---\nname: coordinator\ndescription: Starts its own children.\ntools: read, delegate, mcp\ncontext: fresh\n---\n\nCoordinate.\n");
	writeFileSync(join(userRoles, "fake-user.md"), "---\nname: fake-user\ndescription: Uses the global fake server.\ntools: read, mcp:fake\ncontext: fresh\n---\n\nUse fake.\n");
	const h = await harness(box, undefined, { projectTrusted: false });
	const { AGENT_DIR } = await import("../src/index.ts");
	const fakePid = join(box.root, "fake.pid");
	writeFileSync(join(AGENT_DIR, "mcp.json"), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [FIXTURE, fakePid], exposure: "direct" } } }));
	api.onUnscripted((request) => {
		const started = /^(scout-[0-9a-f-]{36}) running/.exec(lastTool(request));
		return started ? { tool: { name: "delegate_ctl", arguments: { action: "wait", runId: started[1] } } } : { text: `DONE ${lastUser(request)}` };
	});
	const requestsFor = (task: string) => api.requests.filter((r) => lastUser(r) === task);
	try {
		assert.equal(h.ctx().isProjectTrusted(), false, "the parent decided not to trust this project");
		const roles: Reply = { tool: { name: "delegate_ctl", arguments: { action: "roles" } } };
		const scout: Reply = { tool: { name: "delegate", arguments: { role: "scout", context: "fresh", task: "Untrusted scout", model: "fixture/fixture:off" } } };
		api.script("Untrusted coordinator", roles, scout);
		api.script("Untrusted scout", { text: "SCOUT-OK" });
		const result = await h.waitLaunch("Untrusted coordinator", { role: "coordinator" });
		assert.equal(result.details.status, "complete", result.content[0].text);
		const run = h.state().runs.get(result.details.id);
		assert.equal(run.projectTrusted, false, "the run keeps the parent's decision");
		assert.equal(run.session.settingsManager.isProjectTrusted(), false, "the child's own session is untrusted");

		const [first, afterRoles] = requestsFor("Untrusted coordinator");
		assert.deepEqual(toolNames(first), ["delegate", "delegate_ctl", "mcp__fake__echo", "read"], "the global server only; the project's evil server is not loaded");
		assert.equal(existsSync(marker("evil")), false, "the project's MCP command never ran");
		assert.equal(existsSync(marker("fake-replaced")), false, "the project could not replace the global server");
		const listing = lastTool(afterRoles);
		assert.match(listing, /^scout /m);
		assert.doesNotMatch(listing, /PROJECT-SCOUT/, "the nested roles listing ignores the project's roles");

		const [scoutRequest] = requestsFor("Untrusted scout");
		assert(scoutRequest, "the coordinator's scout ran");
		assert.doesNotMatch(system(scoutRequest), /PROJECT-SCOUT/, "the nested delegate used the packaged scout, not the project's");
		assert.deepEqual(toolNames(scoutRequest), ["bash", "find", "grep", "ls", "read"], "the project's redefinition could not hand the scout write tools");

		api.script("Named server", { text: "NAMED-DONE" });
		const named = await h.waitLaunch("Named server", { role: "fake-user" });
		assert.equal(named.details.status, "complete", named.content[0].text);
		assert.deepEqual(toolNames(requestsFor("Named server")[0]), ["mcp__fake__echo", "read"]);
		assert.equal(existsSync(marker("fake-replaced")), false, "mcp:fake read the global entry; the untrusted project entry was ignored");
		assert.deepEqual(named.details.droppedTools, []);
		await h.runtime.session.agent.waitForIdle();
	} finally {
		api.onUnscripted();
		await h.runtime.dispose();
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});

/** A folder with something trust-gated in it, as Pi decides: without one, Pi never asks about a folder. */
function gatedFolder(path: string) {
	mkdirSync(join(path, ".pi"), { recursive: true });
	writeFileSync(join(path, ".pi", "settings.json"), "{}");
	return realpathSync(path);
}

type Select = (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
async function trustBox(options: { projectTrusted: boolean; select?: Select }) {
	const api = await provider();
	const box = sandbox(api.url);
	const prompts: { title: string; options: string[]; signal?: AbortSignal }[] = [];
	const select = options.select && (async (title: string, choices: string[], opts?: { signal?: AbortSignal }) => { prompts.push({ title, options: choices, signal: opts?.signal }); return options.select!(title, choices, opts); });
	const h = await harness(box, undefined, { projectTrusted: options.projectTrusted, ...(select ? { ui: { select } } : {}) });
	api.onUnscripted((request) => ({ text: `DONE ${lastUser(request)}` }));
	const { AGENT_DIR } = await import("../src/index.ts");
	const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
	const copies = join(box.root, "projects", "repo", "copies");
	const child = async (cwd: string, task: string) => {
		const done = await h.waitLaunch(task, { cwd });
		assert.equal(done.details.status, "complete", done.content[0].text);
		const run = h.state().runs.get(done.details.id);
		return { run, text: done.content[0].text as string, source: run.projectTrustSource as string, trusted: run.projectTrusted as boolean, sessionTrusted: run.session.settingsManager.isProjectTrusted() as boolean };
	};
	const close = async () => { api.onUnscripted(); await h.runtime.session.agent.waitForIdle(); await h.runtime.dispose(); await api.close(); rmSync(box.root, { recursive: true, force: true }); };
	return { api, box, h, prompts, store: new ProjectTrustStore(AGENT_DIR), copies, child, close };
}
const never = async (title: string): Promise<string | undefined> => assert.fail(`no prompt expected: ${title}`);
const recorded = (run: any) => JSON.parse(readFileSync(run.recordPath, "utf8"));
const PROJECT_SCOUT = "---\nname: scout\ndescription: PROJECT-SCOUT redefined by the repository.\ntools: read, write, edit, bash, delegate, mcp\ncontext: fresh\n---\n\nPROJECT-SCOUT instructions.\n";
/** A folder whose only project resource is pi-delegate's own: a `.pi/agents` role, which Pi does not gate. */
function rolesOnlyFolder(path: string) {
	mkdirSync(join(path, ".pi", "agents"), { recursive: true });
	writeFileSync(join(path, ".pi", "agents", "scout.md"), PROJECT_SCOUT);
	return realpathSync(path);
}

test("a folder whose only project resource is .pi/agents is trust-gated: a trusted parent's child there is asked about, and the repository's role loads only if trusted", { timeout: 60000 }, async () => {
	const answers = ["Do not trust (this session only)", "Trust (this session only)"];
	const t = await trustBox({ projectTrusted: true, select: async () => answers.shift() });
	try {
		const { hasTrustRequiringProjectResources } = await import("@earendil-works/pi-coding-agent");
		const { hasTrustGatedResources } = await import("../src/project-trust.ts");
		const { PROJECT_ROLES_DIR } = await import("../src/roles.ts");
		const { CONFIG_DIR_NAME } = await import("@earendil-works/pi-coding-agent");
		assert.equal(PROJECT_ROLES_DIR, join(CONFIG_DIR_NAME, "agents"), "the roles directory is read under Pi's config directory name");
		const refused = rolesOnlyFolder(join(t.box.root, "roles-refused"));
		assert.equal(hasTrustRequiringProjectResources(refused), false, "Pi alone would not ask about this folder");
		assert.equal(hasTrustGatedResources(refused), true);
		const a = await t.child(refused, "Roles-only refused");
		assert.equal(t.prompts.length, 1, "asked, though Pi gates nothing in the folder and the parent is trusted");
		assert.equal(a.trusted, false);
		assert.equal(a.source, "prompted");
		assert.deepEqual(a.run.tools, ["read", "grep", "find", "ls", "bash"], "the packaged scout, not the repository's writer");
		assert.doesNotMatch(a.run.systemPrompt, /PROJECT-SCOUT/);
		const accepted = rolesOnlyFolder(join(t.box.root, "roles-accepted"));
		const b = await t.child(accepted, "Roles-only accepted");
		assert.equal(t.prompts.length, 2);
		assert.equal(b.trusted, true);
		assert.match(b.run.systemPrompt, /PROJECT-SCOUT/, "trusted, the repository's role is used");
		assert(b.run.tools.includes("write"));
	} finally { await t.close(); }
});

test("a dismissed trust question counts as Do not trust (this session only): untrusted, nothing saved, not asked again", { timeout: 60000 }, async () => {
	const t = await trustBox({ projectTrusted: true, select: async () => undefined });
	try {
		const folder = gatedFolder(join(t.box.root, "dismissed"));
		const a = await t.child(folder, "Dismissed once");
		assert.equal(a.trusted, false);
		assert.equal(a.source, "dismissed");
		assert.equal(t.prompts.length, 1);
		const b = await t.child(folder, "Dismissed again");
		assert.equal(t.prompts.length, 1, "the dismissal is remembered for this session");
		assert.equal(b.trusted, false);
		assert.equal(b.source, "session");
		assert.equal(t.store.get(folder), null, "nothing is saved");
	} finally { await t.close(); }
});

test("aborting a delegate call closes its open trust question as a dismissal, starts nothing, and releases the queue for the next call", { timeout: 30000 }, async () => {
	// The first question never answers and ignores the signal, as a UI that does not honor it would.
	const answers: (() => Promise<string | undefined>)[] = [() => new Promise(() => {}), async () => "Trust (this session only)"];
	const t = await trustBox({ projectTrusted: true, select: () => answers.shift()!() });
	try {
		const stuck = gatedFolder(join(t.box.root, "stuck"));
		const controller = new AbortController();
		const pending = t.h.launch("Aborted while asking", { cwd: stuck }, controller.signal);
		while (!t.prompts.length) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(t.prompts[0].signal, controller.signal, "the delegate call's signal is passed to the dialog");
		controller.abort();
		const aborted = await pending;
		assert.equal(aborted.isError, true);
		assert.match(aborted.content[0].text, /^ABORTED: /);
		assert.equal([...t.h.state().runs.values()].some((run: any) => run.task === "Aborted while asking"), false, "no child was started");
		const next = await t.child(gatedFolder(join(t.box.root, "next")), "After the abort");
		assert.equal(t.prompts.length, 2, "the next question was asked: the queue was released");
		assert.equal(next.trusted, true);
		const again = await t.child(stuck, "Back in the aborted folder");
		assert.equal(t.prompts.length, 2, "an abort is a dismissal, remembered for this session");
		assert.equal(again.trusted, false);
		assert.equal(again.source, "session");
	} finally { await t.close(); }
});

test("each run records why it has its trust, keeps it in its record, and its summary says so", { timeout: 60000 }, async () => {
	const t = await trustBox({ projectTrusted: true });
	try {
		const own = await t.child(realpathSync(t.box.cwd), "Own folder");
		const ungatedPath = join(t.box.root, "ungated");
		mkdirSync(ungatedPath, { recursive: true });
		const ungated = await t.child(realpathSync(ungatedPath), "Ungated folder");
		const savedFolder = gatedFolder(join(t.box.root, "saved"));
		t.store.set(savedFolder, false);
		const saved = await t.child(savedFolder, "Saved folder");
		const inherited = await t.child(gatedFolder(join(t.box.root, "no-ui")), "No UI folder");
		for (const [c, trusted, source] of [[own, true, "parent"], [ungated, true, "ungated"], [saved, false, "saved"], [inherited, true, "inherited"]] as const) {
			assert.equal(c.source, source);
			assert.equal(c.trusted, trusted);
			assert.equal(recorded(c.run).projectTrustSource, source, "persisted in the run record");
			assert.match(c.text, new RegExp(`\\nproject ${trusted ? "trusted" : "untrusted"} \\(trust source: ${source}\\)\\n`), "printed next to the trust state");
		}
	} finally { await t.close(); }
});

test("a child in another folder uses Pi's saved decision for it, whatever the parent decided, and nothing is asked", { timeout: 60000 }, async () => {
	const t = await trustBox({ projectTrusted: false, select: never });
	try {
		const trusted = gatedFolder(join(t.copies, "a")), distrusted = gatedFolder(join(t.box.root, "elsewhere"));
		t.store.set(trusted, true);
		t.store.set(distrusted, false);
		const a = await t.child(trusted, "Saved trust");
		assert.equal(a.trusted, true, "the saved decision, not the untrusted parent's");
		assert.equal(a.source, "saved");
		assert.equal(a.sessionTrusted, true, "the child's session is trusted");
		const b = await t.child(distrusted, "Saved distrust");
		assert.equal(b.trusted, false);
		assert.deepEqual(t.prompts, []);
	} finally { await t.close(); }
});

test("an unrecorded folder is asked about with Pi's choices; Trust parent folder is saved as Pi saves it and covers a sibling copy", { timeout: 60000 }, async () => {
	const t = await trustBox({ projectTrusted: false, select: async (_title, options) => options.find((option) => option.startsWith("Trust parent folder")) });
	try {
		const first = gatedFolder(join(t.copies, "a"));
		const a = await t.child(first, "First copy");
		assert.equal(t.prompts.length, 1, "asked once");
		assert.match(t.prompts[0].title, new RegExp(`Trust project folder for a delegated child\\?\\n${first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
		const copies = realpathSync(t.copies);
		assert.deepEqual(t.prompts[0].options, ["Trust", `Trust parent folder (${copies})`, "Trust (this session only)", "Do not trust", "Do not trust (this session only)"]);
		assert.equal(a.trusted, true, "the answer is used");
		assert.equal(a.sessionTrusted, true);
		assert.deepEqual(t.store.getEntry(first), { path: copies, decision: true }, "saved for the copies folder, as Pi saves Trust parent folder");
		const sibling = gatedFolder(join(t.copies, "b"));
		const b = await t.child(sibling, "Sibling copy");
		assert.equal(t.prompts.length, 1, "the sibling copy is covered by the saved answer: no second prompt");
		assert.equal(b.trusted, true);
	} finally { await t.close(); }
});

test("Do not trust is saved and used; a session-only answer is kept for this session and saves nothing", { timeout: 60000 }, async () => {
	const answers = ["Do not trust", "Trust (this session only)"];
	const t = await trustBox({ projectTrusted: true, select: async () => answers.shift() });
	try {
		const refused = gatedFolder(join(t.box.root, "refused"));
		assert.equal((await t.child(refused, "Refused folder")).trusted, false, "the answer, not the trusted parent's decision");
		assert.equal(t.store.get(refused), false, "saved");
		const once = gatedFolder(join(t.box.root, "once"));
		assert.equal((await t.child(once, "Session folder")).trusted, true);
		assert.equal(t.store.get(once), null, "a session-only answer is not saved");
		assert.equal((await t.child(once, "Session folder again")).trusted, true);
		assert.equal(t.prompts.length, 2, "the session-only answer is reused within the session");
	} finally { await t.close(); }
});

test("with no UI to ask in, an unrecorded folder gets the delegating parent's own decision", { timeout: 60000 }, async () => {
	for (const parentTrusted of [true, false]) {
		const t = await trustBox({ projectTrusted: parentTrusted });
		try {
			assert.equal(t.h.ctx().hasUI, false, "a print-mode or SDK parent has no dialog UI");
			const folder = gatedFolder(join(t.box.root, "unrecorded"));
			const c = await t.child(folder, `No UI ${parentTrusted}`);
			assert.equal(c.trusted, parentTrusted, `inherits the parent's ${parentTrusted}`);
			assert.equal(c.sessionTrusted, parentTrusted);
			assert.equal(t.store.get(folder), null, "nothing is saved");
		} finally { await t.close(); }
	}
});

test("a nested child never prompts, even under a root with a UI: an unrecorded folder gets its delegating child's decision", { timeout: 60000 }, async () => {
	const t = await trustBox({ projectTrusted: true, select: never });
	try {
		const roles = join(t.box.root, ".pi", "agent", "agents");
		mkdirSync(roles, { recursive: true });
		writeFileSync(join(roles, "coordinator.md"), "---\nname: coordinator\ndescription: Starts its own children.\ntools: read, delegate\ncontext: fresh\n---\n\nCoordinate.\n");
		const folder = gatedFolder(join(t.box.root, "nested-target"));
		t.api.onUnscripted((request) => {
			const started = /^(scout-[0-9a-f-]{36}) running/.exec(lastTool(request));
			return started ? { tool: { name: "delegate_ctl", arguments: { action: "wait", runId: started[1] } } } : { text: `DONE ${lastUser(request)}` };
		});
		t.api.script("Nested coordinator", { tool: { name: "delegate", arguments: { role: "scout", context: "fresh", task: "Nested scout", cwd: folder, model: "fixture/fixture:off" } } });
		const coordinator = await t.h.waitLaunch("Nested coordinator", { role: "coordinator" });
		assert.equal(coordinator.details.status, "complete", coordinator.content[0].text);
		const scout = [...t.h.state().runs.values()].find((run: any) => run.task === "Nested scout");
		assert(scout, "the coordinator's scout ran");
		assert.equal(scout.cwd, folder);
		assert.equal(scout.projectTrusted, true, "the coordinator's own (inherited) decision");
		assert.equal(scout.projectTrustSource, "inherited");
		assert.deepEqual(t.prompts, [], "no prompt from a nested child");
	} finally { await t.close(); }
});

test("a run record from before trust was recorded stays untrusted and says so", { timeout: 60000 }, async () => {
	const api = await provider();
	const box = sandbox(api.url);
	let h = await harness(box, undefined, { projectTrusted: true });
	api.onUnscripted((request) => ({ text: `DONE ${lastUser(request)}` }));
	try {
		const done = await h.waitLaunch("Old record");
		assert.equal(done.details.status, "complete", done.content[0].text);
		const { TRUST_UNKNOWN } = await import("../src/index.ts");
		assert.doesNotMatch(done.content[0].text, new RegExp(TRUST_UNKNOWN));
		const path = h.state().runs.get(done.details.id).recordPath;
		await h.runtime.session.agent.waitForIdle();
		const parent = h.parent;
		await h.runtime.dispose();
		// As pi-delegate before 0.2.0 wrote it: no projectTrusted or projectTrustSource field.
		const { projectTrusted: _dropped, projectTrustSource: _source, ...old } = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, JSON.stringify(old));
		h = await harness(box, parent, { projectTrusted: true });
		const status = await h.ctl("status", done.details.id);
		assert.match(status.content[0].text, new RegExp(TRUST_UNKNOWN), "the revived run's summary says why it is untrusted");
		assert.match(status.content[0].text, /\nproject untrusted \(trust source: unknown\)\n/);
		const steered = await h.ctl("steer", done.details.id, { message: "Continue old record" });
		assert.match(steered.content[0].text, new RegExp(`Note: ${TRUST_UNKNOWN}`));
		const resumed = await h.ctl("wait", done.details.id);
		assert.equal(resumed.details.status, "complete", resumed.content[0].text);
		assert.match(resumed.content[0].text, new RegExp(TRUST_UNKNOWN), "and so does its completion");
		const run = h.state().runs.get(done.details.id);
		assert.equal(run.projectTrusted, false, "untrusted, though the parent trusts this folder");
		assert.equal(run.session.settingsManager.isProjectTrusted(), false);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).projectTrustUnknown, true, "the record keeps saying so");
		assert.equal(JSON.parse(readFileSync(path, "utf8")).projectTrustSource, "unknown");
	} finally {
		api.onUnscripted();
		await h.runtime.session.agent.waitForIdle();
		await h.runtime.dispose(); await api.close(); rmSync(box.root, { recursive: true, force: true });
	}
});

test("the folder trust choices match Pi's own, in every installed Pi", async () => {
	const { trustOptions } = await import("../src/project-trust.ts");
	const installs = [join(import.meta.dirname, "..", "node_modules", "@earendil-works", "pi-coding-agent"), "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent"].filter((dir) => existsSync(join(dir, "dist", "core", "trust-manager.js")));
	assert(installs.length >= 1);
	const cwd = realpathSync(mkdtempSync(join(tmpdir(), "pi-delegate-trust-options-")));
	try {
		for (const dir of installs) {
			const pi = await import(pathToFileURL(join(dir, "dist", "core", "trust-manager.js")).href);
			const theirs = pi.getProjectTrustOptions(cwd, { includeSessionOnly: true }).map(({ label, trusted, updates }: any) => ({ label, trusted, updates }));
			assert.deepEqual(trustOptions(cwd), theirs, dir);
		}
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
