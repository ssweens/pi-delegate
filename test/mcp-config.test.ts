import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadChildMcpConfig } from "../src/mcp-config.ts";
import { provider, sandbox, harness } from "./fixture.ts";

const stdio = { command: "node", args: ["server.js"] };

test("a child's mcp.json is validated as Pi validates it; an invalid entry is refused with its reason", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-delegate-mcp-config-"));
	const agentDir = join(root, "agent"), cwd = join(root, "project");
	mkdirSync(agentDir, { recursive: true }); mkdirSync(join(cwd, ".pi"), { recursive: true });
	try {
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
			good: stdio,
			args: { command: "node", args: [1] },
			env: { command: "node", env: { TOKEN: 1 } },
			exposure: { ...stdio, exposure: "sometimes" },
			headers: { url: "https://example.com/mcp", headers: { Authorization: 1 } },
			plainAuth: { url: "http://example.com/mcp", auth: { provider: "github" } },
			loopAuth: { url: "http://127.0.0.1:9/mcp", auth: { provider: "github" } },
			sse: { url: "https://example.com/sse", type: "sse" },
			"a-b": stdio,
			a_b: stdio,
			"bad.name": stdio,
			legacy: { ...stdio, exposure: "codemode-deferred" },
		} }));
		writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: {
			good: { exposure: "direct" },
			projectAuth: { url: "https://example.com/mcp", auth: { provider: "github" } },
		} }));
		const all = loadChildMcpConfig(agentDir, cwd, true);
		assert.deepEqual(all.servers.map((server) => server.name).sort(), ["a-b", "good", "legacy", "loopAuth"]);
		const error = (pattern: RegExp) => assert(all.errors.some((message) => pattern.test(message)), `expected an error matching ${pattern}: ${all.errors.join(" | ")}`);
		error(/server "args": args must be an array of strings/);
		error(/server "env": env must map names to strings/);
		error(/server "exposure": exposure must be one of/);
		error(/server "headers": headers must map names to strings/);
		error(/server "plainAuth": auth requires an https URL, or http on localhost/);
		error(/server "sse": legacy SSE transport is not supported/);
		error(/server "a_b" conflicts with "a-b"/);
		error(/invalid server name "bad\.name"/);
		error(/server "projectAuth": auth is only allowed in the global mcp\.json/);
		assert.equal(all.servers.find((server) => server.name === "good")!.config.exposure, "direct", "a project override sets exposure only");
		assert.equal(all.servers.find((server) => server.name === "legacy")!.config.exposure, "codemode", "an exposure alias is resolved");

		const named = loadChildMcpConfig(agentDir, cwd, true, ["args", "good"]);
		assert.deepEqual(named.servers.map((server) => server.name), ["good"], "mcp:<server> and mcp share the validation: an invalid named entry is not returned");
		assert.deepEqual(named.errors.map((message) => message.replace(/^.*?: /, "")), ['server "args": args must be an array of strings'], "only the named servers' problems are reported");
		assert.deepEqual(loadChildMcpConfig(agentDir, cwd, false).servers.find((server) => server.name === "good")!.config.exposure, undefined, "an untrusted project's override is not read");
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("an invalid named MCP entry never starts in a child, and the run reports why (real SDK, loopback provider)", { timeout: 60000 }, async () => {
	const api = await provider();
	const box = sandbox(api.url);
	const marker = join(box.root, "bad.started");
	mkdirSync(join(box.cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(box.cwd, ".pi", "agents", "bad-mcp.md"), "---\nname: bad-mcp\ndescription: Names an invalid server.\ntools: read, mcp:bad\ncontext: fresh\n---\n\nWork.\n");
	const h = await harness(box);
	const { AGENT_DIR } = await import("../src/index.ts");
	// Pi refuses a non-string env value; the command would leave a mark if it ever ran.
	writeFileSync(join(AGENT_DIR, "mcp.json"), JSON.stringify({ mcpServers: { bad: { command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "started")`], env: { TOKEN: 1 }, exposure: "direct" } } }));
	try {
		api.script("Invalid named server", { text: "BAD-DONE" });
		const result = await h.waitLaunch("Invalid named server", { role: "bad-mcp" });
		assert.equal(result.details.status, "complete", result.content[0].text);
		assert.deepEqual(result.details.droppedTools, ["mcp:bad"]);
		assert.match(result.content[0].text, /mcp\.json entries refused, as Pi refuses them \(not started\):\n  .*mcp\.json: server "bad": env must map names to strings/);
		const request = api.requests.find((r) => JSON.stringify(r.messages).includes("Invalid named server"));
		assert.deepEqual((request.tools ?? []).map((t: any) => t.function?.name), ["read"]);
		assert.equal(existsSync(marker), false, "the refused server was never started");
	} finally {
		await h.runtime.dispose();
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
