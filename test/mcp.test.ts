import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deferred, provider, sandbox, harness, type Reply } from "./fixture.ts";
import { roleTools, toolList } from "../src/roles.ts";

const FIXTURE = fileURLToPath(new URL("./mcp-fixture.mjs", import.meta.url));

test("roleTools: mcp opts into every configured server, mcp:<server> into that one; neither is dropped", () => {
	assert.deepEqual(roleTools(["read", "mcp"]), { tools: ["read"], dropped: [], delegates: false, mcp: true });
	assert.deepEqual(roleTools(["read", "mcp:fake"]), { tools: ["read"], dropped: [], delegates: false, mcp: ["fake"] });
	assert.deepEqual(roleTools(toolList("read, mcp:fake, mcp:other, mcp:fake")).mcp, ["fake", "other"]);
	assert.equal(roleTools(["mcp:fake", "mcp"]).mcp, true, "mcp wins over named servers");
	assert.deepEqual(roleTools(["read", "mcp:", "mcp:a.b"]), { tools: ["read"], dropped: ["mcp:", "mcp:a.b"], delegates: false, mcp: false });
	assert.deepEqual(roleTools(["read", "bash", "delegate", "mcp"]), { tools: ["read", "bash", "delegate", "delegate_ctl"], dropped: [], delegates: true, mcp: true });
	assert.deepEqual(roleTools(["read", "bash", "delegate", "mcp"], false), { tools: ["read", "bash"], dropped: [], delegates: false, mcp: true });
});

const text = (content: any) => typeof content === "string" ? content : (content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
const lastUser = (request: any) => text(request.messages.findLast((m: any) => m.role === "user")?.content);
const lastTool = (request: any) => text(request.messages.findLast((m: any) => m.role === "tool")?.content);
const toolNames = (request: any): string[] => (request.tools ?? []).map((t: any) => t.function?.name).sort();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidIn = (file: string) => existsSync(file) ? Number(readFileSync(file, "utf8")) : undefined;
async function until(condition: () => boolean, what: string, ms = 8000) {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) assert.fail(`timed out waiting: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
const echo = (value: string): Reply => ({ tool: { name: "mcp__fake__echo", arguments: { text: value } } });
const codemode = (code: string): Reply => ({ tool: { name: "codemode", arguments: { code } } });

test("MCP in a child is opt-in per role, scoped by server, and closed when the run settles (real SDK, stdio fixture)", { timeout: 120000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	const agents = join(box.cwd, ".pi", "agents");
	mkdirSync(agents, { recursive: true });
	const role = (name: string, tools: string) => writeFileSync(join(agents, `${name}.md`), `---\nname: ${name}\ndescription: Test role ${name}.\ntools: ${tools}\ncontext: fresh\n---\n\nDo the work.\n`);
	role("mcp-reader", "read, mcp");
	role("mcp-scoped", "read, mcp:fake");
	role("mcp-ghost", "read, mcp:ghost");
	role("mcp-coordinator", "read, delegate, mcp");
	const pids = { fake: join(box.root, "fake.pid"), other: join(box.root, "other.pid") };
	// The child reads the sandbox's agent directory only; the real ~/.pi is never touched.
	const configure = (servers: Record<string, Record<string, unknown>>) => writeFileSync(join(box.agentDir, "mcp.json"), JSON.stringify({
		mcpServers: Object.fromEntries(Object.entries(servers).map(([name, extra]) => [name, { command: process.execPath, args: [FIXTURE, pids[name as keyof typeof pids]], ...extra }])),
	}));
	const h = await harness(box);
	const requestsFor = (task: string) => api.requests.filter((r) => lastUser(r) === task);
	const noProcess = (name: keyof typeof pids, pid: number) => until(() => !alive(pid) && !existsSync(pids[name]), `${name} server ${pid} to exit`);
	let disposed = false;
	// A run that fails before its scripted request would leave that request's wait pending forever.
	const reaches = <T>(request: Promise<T>, id: string) => Promise.race([request,
		h.ctl("wait", id).then((result: any): never => assert.fail(`${id} settled before its request arrived: ${result.content[0].text}`))]);
	const gates: ReturnType<typeof deferred<void>>[] = [];
	const gated = () => { const gate = deferred<void>(); gates.push(gate); return gate; };
	try {
		await t.test("a role without mcp reaches no MCP server", async () => {
			configure({ fake: { exposure: "direct" } });
			api.script("Plain scout", { text: "PLAIN" });
			const result = await h.waitLaunch("Plain scout");
			assert.equal(result.details.status, "complete", result.content[0].text);
			const [request] = requestsFor("Plain scout");
			assert.deepEqual(toolNames(request), ["bash", "find", "grep", "ls", "read"]);
			assert.equal(existsSync(pids.fake), false, "no server was started");
			assert.equal(h.state().runs.get(result.details.id).mcp, undefined);
		});

		let directId = "";
		await t.test("mcp with direct exposure declares the server's tools and nothing the role lacks; settling closes the server; a steer reconnects it", async () => {
			configure({ fake: { exposure: "direct" } });
			const gate = gated();
			const arrived = api.script("Direct MCP", { ...echo("hi"), gate }, { text: "DIRECT-DONE" });
			const started = await h.launch("Direct MCP", { role: "mcp-reader" });
			directId = started.details.id;
			const first = await reaches(arrived, directId);
			const pid = pidIn(pids.fake);
			assert(pid && alive(pid), "the server runs while the child does");
			assert.deepEqual(toolNames(first), ["mcp__fake__echo", "read"], "write, bash and the rest stay withheld");
			gate.resolve();
			const result = await h.ctl("wait", directId);
			assert.equal(result.details.status, "complete", result.content[0].text);
			assert.equal(result.details.output, "DIRECT-DONE");
			assert.match(lastTool(requestsFor("Direct MCP")[1]), /echo: hi/);
			assert.match(result.content[0].text, /mcp: every configured server/);
			await noProcess("fake", pid);
			assert(h.state().runs.get(directId).session, "the settled child keeps its session for steering");

			const again = gated();
			const revived = api.script("Direct again", { ...echo("again"), gate: again }, { text: "AGAIN-DONE" });
			await h.ctl("steer", directId, { message: "Direct again" });
			const request = await reaches(revived, directId);
			const second = pidIn(pids.fake);
			assert(second && second !== pid && alive(second), "the revived segment reconnected with a new server process");
			assert(toolNames(request).includes("mcp__fake__echo"));
			again.resolve();
			const settled = await h.ctl("wait", directId);
			assert.equal(settled.details.status, "complete", settled.content[0].text);
			assert.equal(settled.details.segment, 2);
			assert.match(lastTool(requestsFor("Direct again")[1]), /echo: again/);
			await noProcess("fake", second);
		});

		await t.test("default codemode exposure reaches the MCP tool through codemode, and codemode cannot reach a withheld built-in", async () => {
			configure({ fake: {} });
			api.script("Codemode MCP",
				codemode("return await tools.mcp__fake__echo({ text: 'cm' });"),
				codemode("return await tools.write({ path: 'leak.txt', content: 'x' });"),
				{ text: "CM-DONE" });
			const result = await h.waitLaunch("Codemode MCP", { role: "mcp-reader" });
			assert.equal(result.details.status, "complete", result.content[0].text);
			const [first, second, third] = requestsFor("Codemode MCP");
			const declared = toolNames(first);
			assert(declared.includes("codemode"), `codemode is declared: ${declared}`);
			assert(!declared.some((name) => name.startsWith("mcp__")), "codemode exposure declares no MCP tool");
			assert(!declared.includes("write") && !declared.includes("bash"));
			assert.match(lastTool(second), /echo: cm/);
			// Pi 0.99 reports "not a function"; 1.0 names the tools a script can call, and write is not one.
			assert.match(lastTool(third), /^Script failed[\s\S]*TypeError[\s\S]*No tool calls were made\./);
			assert.equal(existsSync(join(box.cwd, "leak.txt")), false, "the script could not write");
			// Not merely inactive: a built-in the role lacks is not in the child's registry at all.
			const registered = h.state().runs.get(result.details.id).session.getAllTools().map((tool: any) => tool.name);
			for (const name of ["write", "edit", "bash", "powershell", "grep", "find", "ls"]) assert(!registered.includes(name), `${name} is not registered`);
			assert(registered.includes("read") && registered.includes("codemode"));
			await until(() => !existsSync(pids.fake), "fake server to exit");
		});

		await t.test("mcp:<server> connects only the servers the role names", async () => {
			configure({ fake: { exposure: "direct" }, other: { exposure: "direct" } });
			const gate = gated();
			const arrived = api.script("Scoped MCP", { text: "SCOPED-DONE", gate });
			const started = await h.launch("Scoped MCP", { role: "mcp-scoped" });
			const request = await reaches(arrived, started.details.id);
			const pid = pidIn(pids.fake);
			assert(pid && alive(pid));
			assert.deepEqual(toolNames(request), ["mcp__fake__echo", "read"]);
			gate.resolve();
			const result = await h.ctl("wait", started.details.id);
			assert.equal(result.details.status, "complete", result.content[0].text);
			assert.deepEqual(h.state().runs.get(started.details.id).mcp, ["fake"]);
			assert.match(result.content[0].text, /mcp: fake;/);
			await noProcess("fake", pid);
			assert.equal(existsSync(pids.other), false, "the server the role did not name never started");

			api.script("Ghost MCP", { text: "GHOST-DONE" });
			const ghost = await h.waitLaunch("Ghost MCP", { role: "mcp-ghost" });
			assert.equal(ghost.details.status, "complete", ghost.content[0].text);
			assert.deepEqual(ghost.details.droppedTools, ["mcp:ghost"], "a named server no mcp.json defines is reported");
		});

		await t.test("an evicted MCP child leaves no process, and its revival connects from a new session", async () => {
			configure({ fake: { exposure: "direct" } });
			const run = h.state().runs.get(directId);
			for (let i = 0; run.session && i < 10; i++) {
				api.script(`Evictor ${i}`, { text: "EVICT" });
				const result = await h.waitLaunch(`Evictor ${i}`);
				assert.equal(result.details.status, "complete", result.content[0].text);
			}
			assert.equal(run.session, undefined, "the MCP child's session was retired");
			assert.equal(existsSync(pids.fake), false);
			const revived = api.script("After eviction", echo("evicted"), { text: "EVICTED-DONE" });
			await h.ctl("steer", directId, { message: "After eviction" });
			assert(toolNames(await reaches(revived, directId)).includes("mcp__fake__echo"));
			const settled = await h.ctl("wait", directId);
			assert.equal(settled.details.status, "complete", settled.content[0].text);
			assert.match(lastTool(requestsFor("After eviction")[1]), /echo: evicted/);
			await until(() => !existsSync(pids.fake), "fake server to exit");
		});

		await t.test("a delegating MCP child closes its servers at settle but keeps its session; a late child's report revives it and reconnects them", async () => {
			configure({ fake: { exposure: "direct" } });
			const scoutGate = gated();
			api.script("MCP coordinator", { tool: { name: "delegate", arguments: { role: "scout", context: "fresh", task: "Late scout", model: "fixture/fixture:off" } } }, { text: "FIRST-REPORT" });
			api.script("Late scout", { text: "LATE-SCOUT-REPORT", gate: scoutGate });
			const first = await h.waitLaunch("MCP coordinator", { role: "mcp-coordinator" });
			assert.equal(first.details.status, "complete", first.content[0].text);
			assert.deepEqual(toolNames(requestsFor("MCP coordinator")[0]), ["delegate", "delegate_ctl", "mcp__fake__echo", "read"]);
			await until(() => !existsSync(pids.fake), "the coordinator's server to close at settle");
			const run = h.state().runs.get(first.details.id);
			assert(run.session, "its session stays: its child reports into it");
			assert([...h.state().owners.values()].some((owner: any) => owner.parentRun === run), "its child is still bound to it");
			const { CHILD_SETTLED_PROMPT } = await import("../src/index.ts");
			const revivalGate = gated();
			const revived = api.script(CHILD_SETTLED_PROMPT, { ...echo("revived"), gate: revivalGate }, { text: "SECOND-REPORT" });
			scoutGate.resolve();
			// It is settled until the revival starts, so a wait would return the first report at once.
			const request = await Promise.race([revived, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the coordinator was not revived")), 8000))]);
			assert.match(JSON.stringify(request.messages), /LATE-SCOUT-REPORT/);
			assert(toolNames(request).includes("mcp__fake__echo"));
			const pid = pidIn(pids.fake);
			assert(pid && alive(pid), "the revival reconnected the coordinator's server");
			revivalGate.resolve();
			const second = await h.ctl("wait", first.details.id);
			assert.equal(second.details.status, "complete", second.content[0].text);
			assert.equal(second.details.output, "SECOND-REPORT");
			assert.match(lastTool(requestsFor(CHILD_SETTLED_PROMPT)[1]), /echo: revived/);
			await noProcess("fake", pid);
			await h.runtime.session.agent.waitForIdle();
		});

		await t.test("a delegating MCP role at the depth cap keeps its MCP tools and gets no delegation tools", async () => {
			configure({ fake: { exposure: "direct" } });
			const chain = (task: string): Reply => ({ tool: { name: "delegate", arguments: { role: "mcp-coordinator", context: "fresh", task, model: "fixture/fixture:off" } } });
			// Each coordinator joins the child it started, then reports.
			api.onUnscripted((request) => {
				const started = /^(mcp-coordinator-[0-9a-f-]{36}) running/.exec(lastTool(request));
				return started ? { tool: { name: "delegate_ctl", arguments: { action: "wait", runId: started[1] } } } : { text: `DONE ${lastUser(request)}` };
			});
			api.script("MCP chain 1", chain("MCP chain 2"));
			api.script("MCP chain 2", chain("MCP chain 3"));
			api.script("MCP chain 3", echo("capped"), { text: "CAPPED-DONE" });
			try {
				const result = await h.waitLaunch("MCP chain 1", { role: "mcp-coordinator" });
				assert.equal(result.details.status, "complete", result.content[0].text);
				assert.deepEqual(toolNames(requestsFor("MCP chain 2")[0]), ["delegate", "delegate_ctl", "mcp__fake__echo", "read"]);
				const [capped, answered] = requestsFor("MCP chain 3");
				assert.deepEqual(toolNames(capped), ["mcp__fake__echo", "read"], "the depth-3 MCP coordinator keeps MCP and loses the delegation pair");
				assert.match(lastTool(answered), /echo: capped/);
				const run = [...h.state().runs.values()].find((r: any) => r.task === "MCP chain 3");
				assert.equal(run.depth, 3);
				assert.deepEqual(run.tools, ["read"]);
				assert.equal(run.mcp, true);
				assert(![...h.state().owners.values()].some((owner: any) => owner.parentRun === run), "it has no delegation runtime of its own");
				await until(() => !existsSync(pids.fake), "every coordinator's server to close at settle");
			} finally { api.onUnscripted(); }
		});

		await t.test("closing the owner while an MCP child runs leaves no process", async () => {
			configure({ fake: { exposure: "direct" } });
			const arrived = api.script("Owner close", { text: "NEVER", gate: deferred() });
			const started = await h.launch("Owner close", { role: "mcp-reader" });
			await reaches(arrived, started.details.id);
			const pid = pidIn(pids.fake);
			assert(pid && alive(pid));
			disposed = true;
			await h.runtime.dispose();
			await noProcess("fake", pid);
		});
	} finally {
		for (const gate of gates) gate.resolve();
		api.onUnscripted();
		if (!disposed) await h.runtime.dispose();
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
