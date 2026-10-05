import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deferred, provider, sandbox, harness, type Reply } from "./fixture.ts";

const MCP_FIXTURE = fileURLToPath(new URL("./mcp-fixture.mjs", import.meta.url));
const INDEX = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const text = (content: any) => typeof content === "string" ? content : (content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
const lastUser = (request: any) => text(request.messages.findLast((m: any) => m.role === "user")?.content);
const lastTool = (request: any) => text(request.messages.findLast((m: any) => m.role === "tool")?.content);
const toolNames = (request: any): string[] => (request.tools ?? []).map((t: any) => t.function?.name).sort();
const call = (name: string, args: Record<string, unknown> = {}): Reply => ({ tool: { name, arguments: args } });
const codemode = (code: string): Reply => call("codemode", { code });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(condition: () => boolean, what: string, ms = 8000) {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) assert.fail(`timed out waiting: ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

/** An extension file that registers each named tool; each returns `<name>: <text>`. */
const toolExtension = (...names: string[]) => `export default function (pi) {
	for (const name of ${JSON.stringify(names)}) pi.registerTool({
		name, label: name, description: "Fixture tool " + name + ".",
		parameters: { type: "object", properties: { text: { type: "string" } } },
		async execute(_id, params) { return { content: [{ type: "text", text: name + ": " + (params.text ?? "") }], details: undefined }; },
	});
}
`;

test("a child loads its parent's extensions; its role's tools line is a plain allowlist over their tools (real SDK, loopback provider)", { timeout: 120000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	// What Pi finds in the agent directory: one extension with two tools, and two MCP servers.
	mkdirSync(join(box.agentDir, "extensions"), { recursive: true });
	writeFileSync(join(box.agentDir, "extensions", "fixture-tools.js"), toolExtension("fixture_tool", "other_tool"));
	// A project extension: the parent trusts this project, so its children load it too.
	mkdirSync(join(box.cwd, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(box.cwd, ".pi", "extensions", "project-tools.js"), toolExtension("project_tool"));
	const agents = join(box.cwd, ".pi", "agents");
	mkdirSync(agents, { recursive: true });
	const role = (name: string, tools?: string) => writeFileSync(join(agents, `${name}.md`), `---\nname: ${name}\ndescription: Test role ${name}.\n${tools ? `tools: ${tools}\n` : ""}context: fresh\n---\n\nDo the work.\n`);
	role("everything");
	role("narrow", "read, fixture_tool");
	role("missing", "read, no_such_tool, todo, web_*");
	const h = await harness(box, undefined, { extensions: true, tools: ["delegate", "delegate_ctl", "fixture_tool", "other_tool", "project_tool"] });
	const requestsFor = (task: string) => api.requests.filter((r) => lastUser(r) === task);
	const run = (id: string) => h.state().runs.get(id);
	const registry = (id: string) => run(id).session.getAllTools().map((tool: any) => tool.name).sort();
	const gates: ReturnType<typeof deferred<void>>[] = [];
	try {
		assert(h.runtime.session.getAllTools().some((tool: any) => tool.name === "fixture_tool"), "the parent loaded the fixture extension");

		await t.test("no tools line: every tool the parent's extensions provide, and pi-delegate loads once", async () => {
			// An installed pi-delegate, as a user's settings would load it. The child keeps only its own nested instance.
			const copyMarker = join(box.root, "copy.loaded");
			const copy = join(box.agentDir, "extensions", "pi-delegate-copy.ts");
			writeFileSync(copy, `import { writeFileSync } from "node:fs";\nimport delegate from ${JSON.stringify(INDEX)};\nexport default function (pi) { writeFileSync(${JSON.stringify(copyMarker)}, "loaded"); delegate(pi); }\n`);
			try {
				const gate = deferred<void>(); gates.push(gate);
				const arrived = api.script("Everything", { ...call("fixture_tool", { text: "a" }), gate }, call("project_tool", { text: "c" }), { text: "EVERYTHING-DONE" });
				const started = await h.launch("Everything", { role: "everything" });
				const first = await arrived;
				const declared = toolNames(first);
				for (const name of ["read", "bash", "edit", "write", "fixture_tool", "other_tool", "project_tool", "delegate", "delegate_ctl"]) assert(declared.includes(name), `${name} is declared: ${declared}`);
				assert(!declared.includes("todo"), "the todo tool stays with the root parent");
				gate.resolve();
				const result = await h.ctl("wait", started.details.id);
				assert.equal(result.details.status, "complete", result.content[0].text);
				const [, afterFixture, afterProject] = requestsFor("Everything");
				assert.match(lastTool(afterFixture), /^fixture_tool: a$/);
				assert.match(lastTool(afterProject), /^project_tool: c$/);
				assert.deepEqual(result.details.droppedTools, []);
				assert(existsSync(copyMarker), "the installed copy was loaded");
				const child = run(started.details.id);
				const tools = child.session.getAllTools();
				assert.equal(tools.find((tool: any) => tool.name === "delegate").sourceInfo.path, "<inline:pi-delegate>", "delegate is the child's own nested instance's");
				assert(!tools.some((tool: any) => tool.name === "todo"), "the copy's tools are not in the child");
				assert.equal(child.offered.has("todo"), false, "the copy was left out before its tools were offered");
				assert.deepEqual(child.extensionErrors, [], "no conflict is reported: the copy is gone");
			} finally { rmSync(copy, { force: true }); }
		});

		await t.test("tools: read, fixture_tool gets exactly those; no other tool is registered", async () => {
			api.script("Narrow", call("fixture_tool", { text: "n" }), { text: "NARROW-DONE" });
			const result = await h.waitLaunch("Narrow", { role: "narrow" });
			assert.equal(result.details.status, "complete", result.content[0].text);
			const [first, second] = requestsFor("Narrow");
			assert.deepEqual(toolNames(first), ["fixture_tool", "read"]);
			assert.match(lastTool(second), /^fixture_tool: n$/);
			assert.deepEqual(registry(result.details.id), ["fixture_tool", "read"], "write, other_tool, codemode and the rest are not registered at all");
			assert(run(result.details.id).offered.has("other_tool") && run(result.details.id).offered.has("write"), "they were offered and refused");
			assert.deepEqual(result.details.droppedTools, []);
			assert.equal(run(result.details.id).writer, false);
		});

		await t.test("a listed tool no extension provides is reported as dropped; todo is one", async () => {
			api.script("Missing", { text: "MISSING-DONE" });
			const result = await h.waitLaunch("Missing", { role: "missing" });
			assert.equal(result.details.status, "complete", result.content[0].text);
			assert.deepEqual(result.details.droppedTools, ["no_such_tool", "todo", "web_*"]);
			assert.match(result.content[0].text, /tools the child could not have .*: no_such_tool, todo, web_\*/);
		});

		await t.test("an extension that throws on load does not stop the child and is reported; extensions' session_start never runs in a child", async () => {
			const boom = join(box.agentDir, "extensions", "boom.js");
			const badStart = join(box.agentDir, "extensions", "bad-start.js");
			writeFileSync(boom, `throw new Error("BOOM-ON-LOAD");\n`);
			writeFileSync(badStart, `export default function (pi) { pi.on("session_start", () => { throw new Error("BOOM-ON-START"); }); }\n`);
			try {
				api.script("Survives", call("fixture_tool", { text: "s" }), { text: "SURVIVES-DONE" });
				const result = await h.waitLaunch("Survives", { role: "narrow" });
				assert.equal(result.details.status, "complete", result.content[0].text);
				assert.equal(result.details.output, "SURVIVES-DONE");
				assert.match(lastTool(requestsFor("Survives")[1]), /^fixture_tool: s$/, "the other extensions still work");
				const errors = run(result.details.id).extensionErrors.join("\n");
				assert.match(errors, /boom\.js: .*BOOM-ON-LOAD/);
				assert.doesNotMatch(errors, /BOOM-ON-START/, "a child does not run extensions' session_start handlers");
				assert.match(result.content[0].text, /extensions that failed in the child \(it ran without them\):\n  .*boom\.js/);
			} finally { rmSync(boom, { force: true }); rmSync(badStart, { force: true }); }
		});
	} finally {
		for (const gate of gates) gate.resolve();
		await h.runtime.dispose();
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
