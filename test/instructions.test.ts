import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { harness, provider, sandbox } from "./fixture.ts";
import { validateStartInput } from "../src/backend.ts";
import { loadRoles } from "../src/roles.ts";

const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };
const text = (request: any, role?: string) => JSON.stringify(request.messages.filter((m: any) => !role || m.role === role));
const includes = (request: any, markers: string[], expected = true) => {
	for (const marker of markers) assert.equal(text(request).includes(marker), expected, `${marker}: expected ${expected ? "included" : "omitted"}`);
};

test("launch validation preserves boolean false and rejects omission on other backends", () => {
	for (const omitAgentsMd of [true, false]) {
		const input = validateStartInput({ role: "scout", task: "look", omitAgentsMd });
		assert.ok(input.ok);
		assert.equal((input.value as any).omitAgentsMd, omitAgentsMd);
		assert.equal(validateStartInput({ backend: "acp", agent: "pi", task: "look", omitAgentsMd }).ok, false);
		assert.equal(validateStartInput({ backend: "process", command: "true", omitAgentsMd }).ok, false);
	}
	assert.equal(validateStartInput({ role: "scout", task: "look", omitAgentsMd: "false" }).ok, false);
});

test("real Pi requests: startup omission, nested discovery, fresh/fork isolation and reopen", { timeout: 60000 }, async () => {
	const api = await provider();
	const box = sandbox(api.url);
	put(join(box.root, ".agents", "AGENTS.md"), "MARK-GLOBAL");
	put(join(box.root, ".agents", "rules", "global.md"), "MARK-GLOBAL-RULE");
	put(join(box.root, ".agents", "skills", "example", "SKILL.md"), "Example skill");
	put(join(box.cwd, "AGENTS.md"), "MARK-ROOT");
	put(join(box.cwd, ".agents", "rules", "always.md"), "MARK-ALWAYS");
	put(join(box.cwd, ".agents", "rules", "typescript.md"), '---\npaths: ["src/**/*.ts"]\n---\nMARK-SCOPED');
	put(join(box.cwd, "src", "AGENTS.md"), "MARK-NESTED");
	put(join(box.cwd, "src", "ok.ts"), "export const ok = true;");
	put(join(box.agentDir, "agents", "reader.md"), "---\nname: reader\ntools: read\n---\nROLE-READER");
	put(join(box.agentDir, "agents", "supervisor.md"), "---\nname: supervisor\ntools: read, delegate, delegate_ctl\n---\nROLE-SUPERVISOR");
	put(join(box.agentDir, "agents", "omitter.md"), "---\nname: omitter\ntools: read\nomitAgentsMd: true\n---\nROLE-OMITTER");
	api.onUnscripted(() => ({ text: "ok" }));
	let h = await harness(box, undefined, { register: (pi) => {
		pi.on("before_agent_start", (event: any) => {
			event.systemPromptOptions.appendSystemPrompt = "PARENT-APPEND";
			event.systemPromptOptions.contextFiles = [{ path: join(box.cwd, "parent-only", "AGENTS.md"), content: "PARENT-DISCOVERY" }];
		});
	} });
	try {
		const roles = loadRoles(box.cwd, true, box.agentDir);
		assert.equal(roles.get("scout")!.omitAgentsMd, true);
		assert.equal(roles.get("reader")!.omitAgentsMd, undefined);
		assert.equal(roles.get("omitter")!.omitAgentsMd, true);
		await h.runtime.session.prompt("PARENT-CONVERSATION");
		let n = 0;
		const startup = ["MARK-GLOBAL", "MARK-ROOT", "MARK-ALWAYS", "MARK-GLOBAL-RULE"];
		const requestsFor = (task: string) => api.requests.filter((request) => {
			const last = request.messages.findLast((m: any) => m.role === "user");
			return typeof last?.content === "string" ? last.content === task : last?.content?.some((p: any) => p.text === task);
		});
		const launch = async (options: any = {}, read?: string) => {
			const task = `TASK-${++n}`;
			if (read) api.script(task, { tool: { name: "read", arguments: { path: read } } }, { text: "done" });
			else api.script(task, { text: "done" });
			const started = await h.launch(task, { role: "reader", context: undefined, ...options });
			assert.equal(started.isError, undefined, started.content[0].text);
			const result = await h.ctl("wait", started.details.id);
			assert.equal(result.details.status, "complete", result.content[0].text);
			const requests = requestsFor(task);
			assert.ok(requests.length, "captured outbound HTTP request");
			return { id: started.details.id, first: requests[0], last: requests.at(-1) };
		};
		const normal = await launch();
		includes(normal.first, startup);
		includes(normal.first, ["PARENT-CONVERSATION", "PARENT-APPEND", "PARENT-DISCOVERY"], false);
		assert.match(text(normal.first, "system"), /ROLE-READER/);
		assert.doesNotMatch(text(normal.first, "system"), /MARK-/);
		assert.match(text(normal.first, "user"), /<system-reminder>/);
		assert.equal(h.state().runs.get(normal.id).context, "fresh");
		for (const options of [{ role: "scout" }, { role: "omitter" }, { omitAgentsMd: true }]) {
			const omitted = await launch(options, "src/ok.ts");
			includes(omitted.first, [...startup, "MARK-NESTED", "MARK-SCOPED"], false);
			includes(omitted.last, startup, false);
			includes(omitted.last, ["MARK-NESTED", "MARK-SCOPED"]);
			assert.equal(text(omitted.last).split("MARK-NESTED").length - 1, 1);
		}
		const globalRead = await launch({ omitAgentsMd: true }, join(box.root, ".agents", "skills", "example", "SKILL.md"));
		includes(globalRead.last, startup, false);
		const failed = await launch({ omitAgentsMd: true }, "src/missing.ts");
		includes(failed.last, [...startup, "MARK-NESTED", "MARK-SCOPED"], false);
		includes((await launch({ role: "scout", omitAgentsMd: false })).first, startup);
		const fork = await launch({ context: "fork", omitAgentsMd: true });
		includes(fork.first, ["PARENT-CONVERSATION", "PARENT-APPEND", "PARENT-DISCOVERY"]);
		includes(fork.first, startup, false);
		includes((await launch({ context: "fork", omitAgentsMd: false })).first, startup);
		const nestedArrival = api.script("NESTED-FORK", { text: "nested done" });
		api.script("SUPERVISOR", { tool: { name: "read", arguments: { path: "src/ok.ts" } } }, { tool: { name: "delegate", arguments: { role: "reader", task: "NESTED-FORK", model: "fixture/fixture:off", context: "fork", omitAgentsMd: true } } }, { text: "supervisor done" });
		const supervisor = await h.launch("SUPERVISOR", { role: "supervisor", omitAgentsMd: true });
		const nested = await nestedArrival;
		includes(nested, ["MARK-NESTED", "MARK-SCOPED"]);
		includes(nested, startup, false);
		assert.equal(text(nested).split("MARK-NESTED").length - 1, 1);
		await h.ctl("wait", supervisor.details.id);
		const omitted = await launch({ omitAgentsMd: true }, "src/ok.ts");
		const saved = JSON.parse(readFileSync(h.state().runs.get(omitted.id).recordPath, "utf8"));
		assert.equal(saved.omitAgentsMd, true);
		assert.equal(saved.discoveredContextFiles.length, 2);
		const parent = h.parent;
		await h.runtime.dispose();
		h = await harness(box, parent);
		api.script("resume omitted", { tool: { name: "read", arguments: { path: "src/ok.ts" } } }, { text: "done" });
		await h.ctl("steer", omitted.id, { message: "resume omitted" });
		assert.equal((await h.ctl("wait", omitted.id)).details.status, "complete");
		const resumed = requestsFor("resume omitted").at(-1)!;
		includes(resumed, startup, false);
		includes(resumed, ["MARK-NESTED", "MARK-SCOPED"]);
		assert.equal(text(resumed).split("MARK-NESTED").length - 1, 1);
		for (const options of [{ runtime: "oven", omitAgentsMd: false }, { runtime: "oven", role: "scout" }, { tui: "pi", omitAgentsMd: true }]) {
			const rejected = await h.launch("unsupported", { role: "reader", ...options });
			assert.equal(rejected.isError, true);
			assert.match(rejected.content[0].text, /in-process Pi children/);
		}
		assert.deepEqual(api.errors, []);
		assert.deepEqual(h.errors, []);
		console.log("HTTP request markers: default, omitted, scout override, nested reads, parent isolation, fork and reopen verified");
	} finally { await h.runtime.dispose(); await api.close(); rmSync(box.root, { recursive: true, force: true }); }
});
