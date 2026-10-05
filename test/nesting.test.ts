import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deferred, provider, sandbox, harness, type Reply } from "./fixture.ts";
import { DELEGATION_TOOLS, EVERY_TOOL, toolAllowlist, toolList } from "../src/roles.ts";

test("delegate and delegate_ctl are ordinary tool names, allowed by a list that names them or by no list, and withheld at the cap", () => {
	assert(toolAllowlist(EVERY_TOOL).allows("delegate") && toolAllowlist(EVERY_TOOL).allows("delegate_ctl"), "no tools line: every tool, delegation included");
	assert(toolAllowlist(toolList("read, bash, delegate, delegate_ctl")!).allows("delegate"));
	assert(!toolAllowlist(toolList("read, grep, find, ls, bash")!).allows("delegate"), "a list without it cannot delegate");
	assert(!toolAllowlist(toolList("read, delegate")!).allows("delegate_ctl"), "listing delegate does not bring delegate_ctl");
	assert(!toolAllowlist(toolList("read, delegate, delegate_ctl")!, DELEGATION_TOOLS).allows("delegate"), "at the depth cap the pair is withheld");
});

const text = (content: any) => typeof content === "string" ? content : (content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
const lastUser = (request: any) => text(request.messages.findLast((m: any) => m.role === "user")?.content);
const lastTool = (request: any) => text(request.messages.findLast((m: any) => m.role === "tool")?.content);
const toolNames = (request: any): string[] => (request.tools ?? []).map((t: any) => t.function?.name);
const system = (request: any) => text(request.messages.find((m: any) => m.role === "system" || m.role === "developer")?.content);
const delegateCall = (role: string, task: string, context: "fork" | "fresh" = "fresh"): Reply => ({ tool: { name: "delegate", arguments: { role, context, task, model: "fixture/fixture:off" } } });

test("nested delegation follows the role's tools and is capped in depth (real SDK, loopback provider)", { timeout: 60000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	mkdirSync(join(box.cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(box.cwd, ".pi", "agents", "coordinator.md"), "---\nname: coordinator\ndescription: Test coordinator that starts its own children.\ntools: read, grep, delegate, delegate_ctl\ncontext: fresh\n---\n\nYou coordinate a piece of work.\n");
	const h = await harness(box);
	// A coordinator that started a child joins it; replies queued here follow that child's report.
	const after = new Map<string, Reply[]>();
	api.onUnscripted((request) => {
		const started = /^((?:scout|coordinator)-[0-9a-f-]{36}) running/.exec(lastTool(request));
		if (started) return { tool: { name: "delegate_ctl", arguments: { action: "wait", runId: started[1] } } };
		return after.get(lastUser(request))?.shift() ?? { text: `DONE ${lastUser(request)}: ${lastTool(request)}` };
	});
	const requestFor = (task: string) => api.requests.find((r) => lastUser(r) === task);
	const logRows = () => readFileSync(join(box.agentDir, "delegate-runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
	try {
		await t.test("a role whose tools line lacks delegate gets exactly its listed tools and cannot delegate", async () => {
			api.script("Plain scout work", { text: "PLAIN-OK" });
			const result = await h.waitLaunch("Plain scout work");
			assert.equal(result.details.status, "complete", result.content[0].text);
			const request = requestFor("Plain scout work");
			assert.deepEqual(toolNames(request).sort(), ["bash", "find", "grep", "ls", "read"]);
			assert.match(system(request), /no delegation tools and cannot start another agent/);
			assert.doesNotMatch(system(request), /Your own children/);
			const run = h.state().runs.get(result.details.id);
			assert.equal(run.depth, 1);
			assert.equal(run.parentRunId, undefined);
			assert(![...h.state().owners.values()].some((owner: any) => owner.parentRun === run), "a plain child has no delegation runtime of its own");
		});

		await t.test("a role that lists delegate and delegate_ctl gets them; its child is logged with its parent", async () => {
			api.script("Coordinate review", delegateCall("scout", "Nested scout"));
			api.script("Nested scout", { text: "NESTED-SCOUT-REPORT" });
			const result = await h.waitLaunch("Coordinate review", { role: "coordinator" });
			assert.equal(result.details.status, "complete", result.content[0].text);
			assert.match(result.details.output, /NESTED-SCOUT-REPORT/, "the coordinator joined its own child and saw its report");
			const coordinator = requestFor("Coordinate review");
			assert.deepEqual(toolNames(coordinator).sort(), ["delegate", "delegate_ctl", "grep", "read"]);
			assert.match(system(coordinator), /Your own children/);
			assert.match(system(coordinator), /You run at delegation depth 1\. A delegate call that would start a child deeper than 3 fails, so a child at depth 3 gets neither `delegate` nor `delegate_ctl`\./);
			assert.doesNotMatch(system(coordinator), /no delegation tools/);
			const nested = requestFor("Nested scout");
			assert.deepEqual(toolNames(nested).sort(), ["bash", "find", "grep", "ls", "read"], "the coordinator's scout gets no delegation tools");
			const rows = logRows();
			const parentRow = rows.find((row) => row.task === "Coordinate review");
			const childRow = rows.find((row) => row.task === "Nested scout");
			assert.equal(parentRow.depth, 1);
			assert.equal(parentRow.parentRunId, undefined);
			assert.equal(childRow.depth, 2);
			assert.equal(childRow.parentRunId, result.details.id);
			assert.equal(childRow.status, "complete");
			assert.deepEqual(childRow.tools.sort(), ["bash", "find", "grep", "ls", "read"]);
			assert.deepEqual(parentRow.tools.sort(), ["delegate", "delegate_ctl", "grep", "read"]);
			assert.deepEqual(parentRow.droppedTools, []);
			assert.equal(h.notices.length, 0, "joined runs wake no one");
		});

		await t.test("a child at the depth cap gets no delegation tools, and forks still drop delegation records", async () => {
			// Chain 1 delegates and joins a side scout first, so the fork it hands Chain 2 has real delegation records to strip.
			api.script("Chain 1", delegateCall("scout", "Side scout"));
			after.set("Chain 1", [delegateCall("coordinator", "Chain 2", "fork")]);
			api.script("Side scout", { text: "SIDE-SCOUT-REPORT" });
			api.script("Chain 2", delegateCall("coordinator", "Chain 3"));
			// Chain 3 runs at the cap. Its model calls delegate anyway; no such tool exists in its session.
			api.script("Chain 3", delegateCall("coordinator", "Chain 4"));
			const result = await h.waitLaunch("Chain 1", { role: "coordinator" });
			assert.equal(result.details.status, "complete", result.content[0].text);
			assert.equal(requestFor("Chain 4"), undefined, "no child ever ran past the cap");
			assert.deepEqual(toolNames(requestFor("Chain 2")).sort(), ["delegate", "delegate_ctl", "grep", "read"], "below the cap the opted-in role keeps the pair");
			const capped = requestFor("Chain 3");
			assert.deepEqual(toolNames(capped).sort(), ["grep", "read"], "the depth-3 coordinator's request declares no delegate or delegate_ctl");
			assert.match(system(capped), /no delegation tools and cannot start another agent, so a delegation call is not available to you\. You run at the delegation depth limit, 3\./);
			assert.doesNotMatch(system(capped), /Your own children|delegate_ctl/);
			const answered = api.requests.find((r) => lastUser(r) === "Chain 3" && r.messages.some((m: any) => m.role === "tool"));
			assert(answered, "the stray delegate call was answered");
			assert.doesNotMatch(lastTool(answered), /DEPTH_EXCEEDED|running/, "it reached no delegate tool");
			const rows = logRows();
			const id = (task: string) => rows.find((row) => row.task === task)?.id;
			assert.deepEqual(["Chain 1", "Chain 2", "Chain 3"].map((task) => rows.find((row) => row.task === task)?.depth), [1, 2, 3]);
			assert.equal(rows.find((row) => row.task === "Chain 2").parentRunId, id("Chain 1"));
			assert.equal(rows.find((row) => row.task === "Chain 3").parentRunId, id("Chain 2"));
			assert.equal(rows.find((row) => row.task === "Side scout").parentRunId, id("Chain 1"));
			assert(!rows.some((row) => row.task === "Chain 4"));
			assert.deepEqual(rows.find((row) => row.task === "Chain 3").withheld, DELEGATION_TOOLS, "the pair is withheld at the cap whatever the role lists");
			assert.deepEqual(rows.find((row) => row.task === "Chain 3").droppedTools, []);
			// Chain 2 forked Chain 1's conversation: the brief is inherited, the delegation records are not.
			const forked = requestFor("Chain 2");
			const inherited = JSON.stringify(forked.messages);
			assert.match(inherited, /Chain 1/);
			assert.doesNotMatch(inherited, /SIDE-SCOUT-REPORT/);
			assert(!forked.messages.some((m: any) => m.tool_calls?.some((c: any) => c.function?.name === "delegate" || c.function?.name === "delegate_ctl")));
		});

		await t.test("backstop: a session that still has delegation tools at the cap has its delegate call refused", async () => {
			// No launch path gives a depth-3 session the pair. Raise this run's depth before its session
			// binds its extensions, so its delegation tools install at the cap and only the guard stops it.
			api.script("Backstop", delegateCall("scout", "Past the cap"));
			// After the harness: src/index.ts resolves its agent directory once, on first import, and this
			// file reads the run log from the sandbox's. test/setup.ts keeps any import away from the real ~/.pi.
			const { MAX_DELEGATION_DEPTH } = await import("../src/index.ts");
			const started = await h.launch("Backstop", { role: "coordinator" });
			h.state().runs.get(started.details.id).depth = MAX_DELEGATION_DEPTH;
			const result = await h.ctl("wait", started.details.id);
			assert.equal(result.details.status, "complete", result.content[0].text);
			assert.deepEqual(toolNames(requestFor("Backstop")).sort(), ["delegate", "delegate_ctl", "grep", "read"]);
			const refused = api.requests.find((r) => lastUser(r) === "Backstop" && /DEPTH_EXCEEDED/.test(lastTool(r)));
			assert(refused, "the guard refused the call");
			assert.match(lastTool(refused), /^DEPTH_EXCEEDED: delegation depth cap is 3: you run at depth 3, so a child would run at depth 4\./);
			assert.equal(requestFor("Past the cap"), undefined);
		});

		await t.test("a child that settles after its delegating parent reported revives that parent", async () => {
			const gate = deferred();
			api.script("Revive coordinator", delegateCall("scout", "Gated scout"), { text: "FIRST-REPORT" });
			api.script("Gated scout", { text: "GATED-SCOUT-REPORT", gate });
			const first = await h.waitLaunch("Revive coordinator", { role: "coordinator" });
			assert.equal(first.details.status, "complete", first.content[0].text);
			assert.equal(first.details.output, "FIRST-REPORT");
			assert.equal(first.details.segment, 1);
			const revivalGate = deferred();
			const { CHILD_SETTLED_PROMPT } = await import("../src/index.ts");
			const revived = api.script(CHILD_SETTLED_PROMPT, { text: "SECOND-REPORT", gate: revivalGate });
			gate.resolve();
			const request = await revived;
			assert.match(JSON.stringify(request.messages), /GATED-SCOUT-REPORT/, "the child's report is in its parent's context when it revives");
			const second = h.ctl("wait", first.details.id);
			revivalGate.resolve();
			const settled = await second;
			assert.equal(settled.details.status, "complete", settled.content[0].text);
			assert.equal(settled.details.segment, 2);
			assert.equal(settled.details.output, "SECOND-REPORT");
			await h.runtime.session.agent.waitForIdle();
		});
	} finally {
		api.onUnscripted();
		await h.runtime.dispose();
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
