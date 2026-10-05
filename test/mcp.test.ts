import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { provider, sandbox, harness, type Reply } from "./fixture.ts";
import { DELEGATION_TOOLS, droppedTools, EVERY_TOOL, toolAllowlist, toolList } from "../src/roles.ts";

const FIXTURE = fileURLToPath(new URL("./mcp-fixture.mjs", import.meta.url));

test("toolAllowlist: every tool is a name; a trailing * matches a prefix; a withheld name is never allowed", () => {
	const scoped = toolAllowlist(toolList("read, mcp__fake__*")!);
	assert(scoped.allows("read") && scoped.allows("mcp__fake__echo"));
	assert(!scoped.allows("write") && !scoped.allows("mcp__other__echo") && !scoped.allows("codemode"));
	const every = toolAllowlist(EVERY_TOOL, DELEGATION_TOOLS);
	assert(every.allows("web_search") && every.allows("mcp__fake__echo"));
	assert(!every.allows("delegate") && !every.allows("delegate_ctl"), "a withheld name is never allowed");
	assert(toolAllowlist(["web_*"]).allows("web_search"));
	assert.deepEqual(droppedTools(["read", "web_*", "mcp__ghost__*", "delegate", "nope"], ["read", "web_search"], DELEGATION_TOOLS), ["mcp__ghost__*", "nope"]);
	assert.deepEqual(droppedTools(EVERY_TOOL, ["read"]), []);
});

const text = (content: any) => typeof content === "string" ? content : (content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
const lastUser = (request: any) => text(request.messages.findLast((m: any) => m.role === "user")?.content);
const lastTool = (request: any) => text(request.messages.findLast((m: any) => m.role === "tool")?.content);
const toolNames = (request: any): string[] => (request.tools ?? []).map((t: any) => t.function?.name).sort();
const call = (name: string, args: Record<string, unknown> = {}): Reply => ({ tool: { name, arguments: args } });
const delegateCall = (role: string, task: string): Reply => call("delegate", { role, context: "fresh", task, model: "fixture/fixture:off" });

test("a child reuses its parent's extension factories and calls its parent's MCP tools; no module re-import, no new server (real SDK, stdio fixture)", { timeout: 120000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	const loads = Symbol.for("pi-delegate-test/counted-loads");
	// A module-level counter: it counts how often Pi evaluated the extension module.
	mkdirSync(join(box.agentDir, "extensions"), { recursive: true });
	writeFileSync(join(box.agentDir, "extensions", "counted.js"), `globalThis[Symbol.for("pi-delegate-test/counted-loads")] = (globalThis[Symbol.for("pi-delegate-test/counted-loads")] ?? 0) + 1;
export default function (pi) {
	pi.registerTool({
		name: "counted_tool", label: "counted_tool", description: "Fixture tool.",
		parameters: { type: "object", properties: { text: { type: "string" } } },
		async execute(_id, params) { return { content: [{ type: "text", text: "counted_tool: " + (params.text ?? "") }], details: undefined }; },
	});
}
`);
	const pidFile = join(box.root, "fake.pid");
	const starts = () => existsSync(`${pidFile}.starts`) ? readFileSync(`${pidFile}.starts`, "utf8").trim().split("\n").filter(Boolean).length : 0;
	writeFileSync(join(box.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { fake: { command: process.execPath, args: [FIXTURE, pidFile], exposure: "direct" } } }));
	const agents = join(box.cwd, ".pi", "agents");
	mkdirSync(agents, { recursive: true });
	// A child in another folder: Pi's factory cache is per folder, so this is where a re-import would show.
	const elsewhere = join(box.root, "elsewhere");
	mkdirSync(join(elsewhere, ".pi", "agents"), { recursive: true });
	const role = (name: string, tools: string) => { for (const dir of [agents, join(elsewhere, ".pi", "agents")]) writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: Test role ${name}.\ntools: ${tools}\ncontext: fresh\n---\n\nDo the work.\n`); };
	role("user", "read, counted_tool, mcp__fake__*");
	role("narrow", "read");
	role("coordinator", "read, delegate, delegate_ctl, counted_tool, mcp__*");
	const h = await harness(box, undefined, { extensions: true, mcp: true, tools: ["delegate", "delegate_ctl", "counted_tool", "mcp__fake__echo"] });
	api.onUnscripted((request) => {
		const started = /^((?:user|narrow|coordinator)-[0-9a-f-]{36}) running/.exec(lastTool(request));
		if (started) return call("delegate_ctl", { action: "wait", runId: started[1] });
		return { text: `DONE ${lastUser(request)}: ${lastTool(request)}` };
	});
	const requestsFor = (task: string) => api.requests.filter((r) => lastUser(r) === task);
	const counted = () => (globalThis as any)[loads];
	try {
		await (async () => { const end = Date.now() + 8000; while (!h.runtime.session.getAllTools().some((tool: any) => tool.name === "mcp__fake__echo")) { if (Date.now() > end) assert.fail("parent MCP server never connected"); await new Promise((r) => setTimeout(r, 25)); } })();
		assert.equal(counted(), 1, "the parent evaluated the extension module once");
		assert.equal(starts(), 1, "the parent started its one server");

		await t.test("a child gets the extension's tool and the parent's MCP tool; neither re-imports nor starts anything", async () => {
			api.script("Use both", call("counted_tool", { text: "a" }), call("mcp__fake__echo", { text: "b" }), { text: "BOTH-DONE" });
			const result = await h.waitLaunch("Use both", { role: "user", cwd: elsewhere });
			assert.equal(result.details.status, "complete", result.content[0].text);
			const [first, afterCounted, afterEcho] = requestsFor("Use both");
			assert.deepEqual(toolNames(first), ["counted_tool", "mcp__fake__echo", "read"]);
			assert.match(lastTool(afterCounted), /^counted_tool: a$/);
			assert.match(lastTool(afterEcho), /echo: b/);
			assert.equal(counted(), 1, "the child re-bound the parent's factory; the module was not evaluated again");
			assert.equal(starts(), 1, "the child started no MCP server");
		});

		await t.test("the allowlist restricts: write, extension and MCP tools are absent unless listed", async () => {
			api.script("Narrow", { text: "NARROW-DONE" });
			const result = await h.waitLaunch("Narrow", { role: "narrow" });
			assert.equal(result.details.status, "complete", result.content[0].text);
			assert.deepEqual(toolNames(requestsFor("Narrow")[0]), ["read"]);
			const registry = h.state().runs.get(result.details.id).session.getAllTools().map((tool: any) => tool.name).sort();
			assert.deepEqual(registry, ["read"], "write, counted_tool and mcp__fake__echo are not registered");
		});

		await t.test("a nested child (depth 2) gets the same tools through the same path", async () => {
			api.script("Coordinate", delegateCall("user", "Grandchild work"));
			api.script("Grandchild work", call("counted_tool", { text: "g" }), call("mcp__fake__echo", { text: "deep" }), { text: "GRANDCHILD-DONE" });
			const result = await h.waitLaunch("Coordinate", { role: "coordinator" });
			assert.equal(result.details.status, "complete", result.content[0].text);
			const [first, afterCounted, afterEcho] = requestsFor("Grandchild work");
			assert.deepEqual(toolNames(first), ["counted_tool", "mcp__fake__echo", "read"]);
			assert.match(lastTool(afterCounted), /^counted_tool: g$/);
			assert.match(lastTool(afterEcho), /echo: deep/);
			assert.match(result.details.output, /GRANDCHILD-DONE/);
			assert.equal(counted(), 1, "no level re-evaluated the module");
			assert.equal(starts(), 1, "no level started an MCP server");
		});
	} finally {
		await h.runtime.dispose();
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
