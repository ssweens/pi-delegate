import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { CHILD_SETTLED_PROMPT, FORK_BRIDGE, isDelegationCall, stripDelegation } from "../src/index.ts";
import { deferred, provider, sandbox, harness, type Reply } from "./fixture.ts";

const text = (content: any) => typeof content === "string" ? content : (content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
const lastUser = (request: any) => text(request.messages.findLast((m: any) => m.role === "user")?.content);
const lastTool = (request: any) => text(request.messages.findLast((m: any) => m.role === "tool")?.content);
const delegateCall = (task: string): Reply => ({ tool: { name: "delegate", arguments: { role: "scout", context: "fresh", task, model: "fixture/fixture:off" } } });
async function until(condition: () => boolean, what: string, ms = 8000) {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) assert.fail(`timed out waiting: ${what}`);
		await sleep(25);
	}
}

test("stripDelegation drops the revival prompt and codemode scripts that delegate", () => {
	const user = (value: string) => ({ role: "user", content: [{ type: "text", text: value }] });
	const call = (id: string, name: string, args: Record<string, unknown>) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });
	const result = (id: string) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: `result ${id}` }] });
	const kept = stripDelegation([
		user("The brief"),
		call("a", "codemode", { code: "return await tools.delegate({ role: 'scout', task: 'x' });" }), result("a"),
		call("b", "codemode", { code: "const r = await tools['delegate_ctl']({ action: 'wait', runId: 'x' }); return r;" }), result("b"),
		call("c", "codemode", { code: "return await tools.mcp__docs__search({ q: 'delegation' });" }), result("c"),
		user(CHILD_SETTLED_PROMPT),
		{ role: "assistant", content: [{ type: "text", text: "Continuing." }] },
	]);
	assert.deepEqual(kept.map((m: any) => m.role === "toolResult" ? `result ${m.toolCallId}` : m.role === "user" ? text(m.content) : m.content[0].type === "toolCall" ? `call ${m.content[0].id}` : text(m.content)),
		["The brief", "call c", "result c", "Continuing."], "the brief, a script that only mentions delegation in prose, and the work are inherited");
});

test("a codemode script delegates only when it calls delegate or delegate_ctl; mentioning the word is not a call", () => {
	const script = (code: string) => isDelegationCall({ type: "toolCall", name: "codemode", arguments: { code } });
	for (const code of [
		"return await tools.delegate({ role: 'scout', task: 'x' });",
		"return await tools.delegate_ctl({ action: 'wait', runId: 'x' });",
		"return await tools . delegate_ctl ({ action: 'status' });",
		'const r = await tools["delegate"]({ role: "scout", task: "x" }); return r;',
		"const r = await tools['delegate_ctl']({ action: 'wait', runId: 'x' }); return r;",
		"const r = await tools[ `delegate` ]({ role: 'scout', task: 'x' }); return r;",
	]) assert.equal(script(code), true, code);
	for (const code of [
		'return await searchTools("delegate");',
		"return await tools.read({ path: 'src/delegate.ts' });",
		"// we no longer delegate here\nreturn await tools.grep({ pattern: 'delegate_ctl' });",
		"return await tools.delegateReport({ text: 'x' });",
		'return tools["delegate-notes"];',
	]) assert.equal(script(code), false, code);
});

test("stripping keeps user and assistant turns alternating where removed turns sat between two assistant messages", () => {
	const user = (value: string) => ({ role: "user", content: [{ type: "text", text: value }], timestamp: 1 });
	const assistant = (value: string, ...calls: any[]) => ({ role: "assistant", content: [{ type: "text", text: value }, ...calls], timestamp: 2 });
	const notice = { role: "custom", customType: "delegate", content: "delegate finished", display: true, timestamp: 3 };
	const delegateCall = { type: "toolCall", id: "d", name: "delegate", arguments: { role: "scout", task: "x" } };
	const kept = stripDelegation([
		user("The brief"),
		assistant("FIRST-REPORT"), notice, user(CHILD_SETTLED_PROMPT),
		assistant("AFTER-REVIVAL"), notice,
		assistant("AFTER-NOTICE", delegateCall), { role: "toolResult", toolCallId: "d", content: [{ type: "text", text: "started" }] },
		assistant("AFTER-RESULT"),
	]);
	assert.deepEqual(kept.map((m: any) => `${m.role}:${text(m.content)}`), [
		"user:The brief",
		"assistant:FIRST-REPORT", `user:${FORK_BRIDGE}`,
		"assistant:AFTER-REVIVAL", `user:${FORK_BRIDGE}`,
		"assistant:AFTER-NOTICE", `user:${FORK_BRIDGE}`,
		"assistant:AFTER-RESULT",
	]);
	for (let i = 1; i < kept.length; i++) assert.notEqual(`${kept[i - 1].role}${kept[i].role}`, "assistantassistant", `turns ${i - 1} and ${i}`);
	assert.deepEqual(stripDelegation([user("a"), assistant("b"), assistant("c")]).map((m: any) => m.role), ["user", "assistant", "assistant"], "a pair stripping did not create is left as it was");
});

test("two user turns that stripping made adjacent are merged into one, in order; nothing is invented", () => {
	const user = (value: string) => ({ role: "user", content: [{ type: "text", text: value }], timestamp: 1 });
	const assistant = (value: string, ...calls: any[]) => ({ role: "assistant", content: [...(value ? [{ type: "text", text: value }] : []), ...calls], timestamp: 2 });
	const call = (id: string) => ({ type: "toolCall", id, name: "delegate", arguments: { role: "scout", task: "x" } });
	const result = (id: string) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "started" }] });
	const notice = { role: "custom", customType: "delegate", content: "delegate finished", display: true, timestamp: 3 };
	const other = { role: "custom", customType: "other", content: "OTHER-EXTENSION", display: true, timestamp: 4 };
	const kept = stripDelegation([
		user("FIRST"), assistant("", call("a")), result("a"),
		user("SECOND"), assistant("REPLY"),
		other, assistant("", call("b")), result("b"), notice, user("THIRD"),
		assistant("DONE"),
	]);
	assert.deepEqual(convertToLlm(kept).map((m: any) => m.role), ["user", "assistant", "user", "assistant"], "user and assistant turns alternate");
	assert.deepEqual(kept.map((m: any) => `${m.role}:${text(m.content)}`), [
		"user:FIRST\nSECOND", "assistant:REPLY", "user:OTHER-EXTENSION\nTHIRD", "assistant:DONE",
	], "both user turns survive, merged in order; no assistant turn is invented");
	assert.equal(kept[0].timestamp, 1);
	assert.deepEqual(stripDelegation([user("a"), notice, user("b")]).map((m: any) => text(m.content)), ["a", "b"], "user turns that were adjacent before stripping are left as they were");
});

test("a delegating child's subtree ends with it, and a late report is never dropped (real SDK, loopback provider)", { timeout: 120000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	const agents = join(box.cwd, ".pi", "agents");
	mkdirSync(agents, { recursive: true });
	writeFileSync(join(agents, "coordinator.md"), "---\nname: coordinator\ndescription: Starts its own children.\ntools: read, grep, delegate, delegate_ctl\ncontext: fresh\n---\n\nCoordinate.\n");
	writeFileSync(join(agents, "writer-coordinator.md"), "---\nname: writer-coordinator\ndescription: Writes and starts its own children.\ntools: read, write, delegate, delegate_ctl\ncontext: fresh\n---\n\nCoordinate and write.\n");
	const h = await harness(box);
	api.onUnscripted((request) => {
		const started = /^(scout-[0-9a-f-]{36}) running/.exec(lastTool(request));
		return started ? { tool: { name: "delegate_ctl", arguments: { action: "wait", runId: started[1] } } } : { text: `DONE ${lastUser(request).slice(0, 40)}` };
	});
	const requestsFor = (task: string) => api.requests.filter((r) => lastUser(r) === task);
	const runFor = (task: string) => [...h.state().runs.values()].find((r: any) => r.task === task);
	const hasChildOwner = (run: any) => [...h.state().owners.values()].some((owner: any) => owner.parentRun === run);
	const lateNotice = (runId: string) => h.notices.find((n: any) => n.details?.kind === "late-report" && n.details.runId === runId);
	const gates: ReturnType<typeof deferred<void>>[] = [];
	const gated = () => { const gate = deferred<void>(); gates.push(gate); return gate; };
	try {
		await t.test("cancel stops a coordinator's children with it, and nothing revives it", async () => {
			const scoutGate = gated();
			const scoutArrived = api.script("Cancel scout", { text: "CANCEL-SCOUT", gate: scoutGate });
			api.script("Cancel coordinator", delegateCall("Cancel scout"), { text: "NEVER", gate: gated() });
			const started = await h.launch("Cancel coordinator", { role: "coordinator" });
			await scoutArrived;
			await until(() => requestsFor("Cancel coordinator").length === 2, "the coordinator to keep working");
			const run = h.state().runs.get(started.details.id), scout = runFor("Cancel scout");
			const revivals = requestsFor(CHILD_SETTLED_PROMPT).length;
			await h.ctl("cancel", run.id);
			await until(() => run.completion.settled, "the coordinator to settle");
			assert.equal(run.status, "cancelled");
			assert.equal(scout.completion.settled, true, "its scout settled with it");
			assert.equal(scout.status, "cancelled");
			assert.equal(scout.stopped, true, "and cannot be revived without a restart");
			assert.equal(hasChildOwner(run), false, "its children's owner closed");
			await until(() => run.session === undefined, "its session to close; a restart reopens it from records");
			scoutGate.resolve();
			await sleep(300);
			assert.equal(requestsFor(CHILD_SETTLED_PROMPT).length, revivals);
			assert.equal(run.segment, 1);
		});

		await t.test("a timeout stops a coordinator's children with it, and a late child cannot revive it with a fresh budget", async () => {
			const scoutGate = gated();
			const scoutArrived = api.script("Timeout scout", { text: "TIMEOUT-SCOUT", gate: scoutGate });
			api.script("Timeout coordinator", delegateCall("Timeout scout"), { text: "NEVER", gate: gated() });
			const started = await h.launch("Timeout coordinator", { role: "coordinator", timeoutMs: 1500 });
			await scoutArrived;
			const scout = runFor("Timeout scout");
			const revivals = requestsFor(CHILD_SETTLED_PROMPT).length;
			const result = await h.ctl("wait", started.details.id);
			assert.equal(result.details.status, "timeout", result.content[0].text);
			await until(() => scout.completion.settled, "the scout to stop with its coordinator");
			assert.equal(scout.status, "cancelled");
			scoutGate.resolve();
			await sleep(300);
			assert.equal(requestsFor(CHILD_SETTLED_PROMPT).length, revivals, "no revival");
			const run = h.state().runs.get(started.details.id);
			assert.equal(run.segment, 1);
			assert.equal(run.status, "timeout");
		});

		await t.test("a late report to a run whose last segment timed out is delivered to its owner instead of reviving it", async () => {
			const scoutGate = gated();
			api.script("Guard coordinator", delegateCall("Guard scout"), { text: "GUARD-FIRST" });
			api.script("Guard scout", { text: "GUARD-SCOUT-REPORT", gate: scoutGate });
			const first = await h.waitLaunch("Guard coordinator", { role: "coordinator" });
			assert.equal(first.details.status, "complete", first.content[0].text);
			const run = h.state().runs.get(first.details.id);
			run.status = "timeout"; // As if its last segment had run out of time while the scout kept going.
			const revivals = requestsFor(CHILD_SETTLED_PROMPT).length;
			scoutGate.resolve();
			await until(() => Boolean(lateNotice(run.id)), "a late-report notice to the root parent");
			const notice = lateNotice(run.id);
			assert.match(notice.content, /settled after .* reported, and .* was not revived to act on it: its last segment ran out of its time budget/);
			assert.match(notice.content, /GUARD-SCOUT-REPORT/, "the notice carries the report");
			assert.equal(requestsFor(CHILD_SETTLED_PROMPT).length, revivals, "no revival");
			assert.equal(run.segment, 1);
		});

		await t.test("a refused revival delivers the late report to the delegating child's owner", async () => {
			const scoutGate = gated();
			api.script("Writer coordinator", delegateCall("Writer scout"), { text: "WRITER-FIRST" });
			api.script("Writer scout", { text: "WRITER-SCOUT-REPORT", gate: scoutGate });
			const first = await h.waitLaunch("Writer coordinator", { role: "writer-coordinator" });
			assert.equal(first.details.status, "complete", first.content[0].text);
			// Another writer now holds the same directory, so the coordinator's revival is refused.
			const holdGate = gated();
			const held = api.script("Holding writer", { text: "HOLD", gate: holdGate });
			const holder = await h.launch("Holding writer", { role: "writer-coordinator" });
			await held;
			scoutGate.resolve();
			await until(() => Boolean(lateNotice(first.details.id)), "a late-report notice to the root parent");
			const notice = lateNotice(first.details.id);
			assert.match(notice.content, new RegExp(`was not revived to act on it: ${holder.details.id} is already writing in`));
			assert.match(notice.content, /WRITER-SCOUT-REPORT/);
			assert.equal(notice.details.childRunId, runFor("Writer scout").id);
			holdGate.resolve();
			assert.equal((await h.ctl("wait", holder.details.id)).details.status, "complete");
		});

		await t.test("an idle delegating child is retired like any other, and its revival restores its children from records", async () => {
			api.script("Retire coordinator", delegateCall("Retire scout"));
			api.script("Retire scout", { text: "RETIRE-SCOUT" });
			const first = await h.waitLaunch("Retire coordinator", { role: "coordinator" });
			assert.equal(first.details.status, "complete", first.content[0].text);
			const run = h.state().runs.get(first.details.id);
			const scoutId = runFor("Retire scout").id;
			assert(run.session && hasChildOwner(run));
			for (let i = 0; run.session && i < 10; i++) {
				const filler = await h.waitLaunch(`Retire filler ${i}`);
				assert.equal(filler.details.status, "complete", filler.content[0].text);
			}
			await until(() => run.session === undefined, "the coordinator's session to be retired");
			assert.equal(hasChildOwner(run), false, "its children's owner closed first");
			assert.equal(h.state().runs.has(scoutId), false);
			api.script("Resume after retire", { tool: { name: "delegate_ctl", arguments: { action: "status" } } }, { text: "RESUMED" });
			await h.ctl("steer", run.id, { message: "Resume after retire" });
			const second = await h.ctl("wait", run.id);
			assert.equal(second.details.status, "complete", second.content[0].text);
			assert.equal(second.details.segment, 2);
			assert.equal(second.details.output, "RESUMED");
			assert.match(lastTool(requestsFor("Resume after retire")[1]), new RegExp(scoutId), "the revived coordinator sees its restored child");
			assert(hasChildOwner(run), "its children's owner re-attached");
		});
		await h.runtime.session.agent.waitForIdle();
	} finally {
		for (const gate of gates) gate.resolve();
		api.onUnscripted();
		await h.runtime.dispose();
		await api.close();
		rmSync(box.root, { recursive: true, force: true });
	}
});
