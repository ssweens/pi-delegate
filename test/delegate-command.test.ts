import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { deferred, harness, provider, sandbox } from "./fixture.ts";
import { inFlight, notify, redeliver } from "../src/pi-backend.ts";

const until = async (check: () => boolean) => {
	for (const end = Date.now() + 8000; !check();) {
		assert(Date.now() < end, "condition did not become true");
		await sleep(20);
	}
};

test("bare command starts immediately; main owns and automatically manages start/result only after active work", { timeout: 30000 }, async () => {
	const api = await provider(), box = sandbox(api.url);
	mkdirSync(join(box.agentDir, "agents"), { recursive: true });
	writeFileSync(join(box.agentDir, "agents", "coordinator.md"), "---\nname: coordinator\ntools: read, delegate, delegate_ctl\nmodel: fixture/fixture:off\n---\nCoordinate.\n");
	const h = await harness(box), gates = Array.from({ length: 4 }, () => deferred());
	const [leadGate, mainGate, nextGate, childGate] = gates;
	const leadRequest = api.script("Existing lead", { text: "LEAD-ACTIVE", gate: leadGate });
	const mainRequest = api.script("Current conversation context", { text: "MAIN-ACTIVE", gate: mainGate, tool: { name: "delegate_ctl", arguments: { action: "status" } } }, { text: "MAIN-WORK-DONE", gate: nextGate });
	const childRequest = api.script("Handle this task", { text: "USER-TASK-RESULT", gate: childGate });
	let child: any, managed = false;
	api.onUnscripted(() => {
		if (!managed) { managed = true; return { tool: { name: "delegate_ctl", arguments: { action: "status", runId: child.id } } }; }
		return { text: "MAIN-VERIFIED-AND-INTEGRATED" };
	});
	try {
		const lead = await h.launch("Existing lead", { role: "coordinator" }); await leadRequest;
		const parent = h.runtime.session.prompt("Current conversation context"); await mainRequest;
		await h.commands.get("delegate").handler("Handle this task", h.ctx());
		const request = await childRequest;
		child = [...h.state().runs.values()].find((r: any) => r.task === "Handle this task");
		assert.equal(child.role, "worker"); assert.equal(child.context, "fork");
		assert.equal(child.depth, 1); assert.equal(child.parentRunId, undefined);
		assert.equal(child.ownerKey, h.state().runs.get(lead.details.id).ownerKey, "the main, never the active delegated lead, owns it");
		assert.match(JSON.stringify(request.messages), /Current conversation context/);
		const stored = JSON.parse(readFileSync(child.recordPath, "utf8"));
		assert.equal(stored.userStarted, true, "ownership/task/run ID recorded before main can handle it");
		assert.equal(stored.id, child.id); assert.equal(stored.task, "Handle this task"); assert.equal(stored.ownerKey, child.ownerKey);
		const start = h.notices.find(n => n.details?.kind === "user-start");
		assert.equal(start.details.id, child.id);
		assert.match(start.content, /own and must manage/); assert.match(start.content, /Handle this task/);
		assert(!managed, "main is still doing its original work");
		childGate.resolve(); await until(() => child.completion.settled);
		await until(() => h.notices.some(n => n.details?.id === child.id && n.details?.kind !== "user-start"));
		assert.equal(api.requests.length, 3, "start and completion never abort or interject into active response");
		assert.equal(inFlight(h.state().owners.get(child.ownerKey)).size, 2, "start/completion have independent tracked delivery receipts");
		mainGate.resolve();
		await until(() => api.requests.filter(r => JSON.stringify(r.messages).includes("MAIN-ACTIVE")).length > 0);
		const continued = api.requests.find(r => JSON.stringify(r.messages).includes("MAIN-ACTIVE"));
		assert.doesNotMatch(JSON.stringify(continued.messages), /own and must manage|USER-TASK-RESULT/, "follow-ups wait through tool work, not just one model response");
		nextGate.resolve(); await parent;
		await until(() => managed);
		await h.runtime.session.agent.waitForIdle();
		const management = api.requests.filter(r => JSON.stringify(r.messages).includes("own and must manage"));
		assert(management.length > 0, "automatic management turn, no further user prompt");
		assert.match(JSON.stringify(management[0].messages), /MAIN-WORK-DONE/);
		assert(management.some(r => /USER-TASK-RESULT/.test(JSON.stringify(r.messages))), "automatic completion handling after the queued ownership turn");
		assert(management.some(r => /Verify the result/.test(JSON.stringify(r.messages))));
		assert(management.some(r => r.messages.some((m: any) => m.tool_calls?.some((call: any) => call.function.name === "delegate_ctl" && JSON.parse(call.function.arguments).runId === child.id))), "main supervised this run with delegate_ctl after receiving ownership");
		assert.equal(inFlight(h.state().owners.get(child.ownerKey)).size, 0, "main acknowledged both notices");
		assert.deepEqual(h.errors, []); assert.deepEqual(api.errors, []);
	} finally {
		for (const gate of gates) gate.resolve();
		await h.runtime.dispose(); await api.close();
	}
});

test("idle main wakes on start and completion; context/role selectors remain optional", { timeout: 30000 }, async () => {
	const api = await provider(), box = sandbox(api.url), h = await harness(box), gates: { resolve(): void }[] = [];
	api.onUnscripted(() => ({ text: "MAIN-MANAGING" }));
	try {
		for (const [text, role, context, task] of [
			["Bare idle work", "worker", "fork", "Bare idle work"],
			["fresh Fresh work", "worker", "fresh", "Fresh work"],
			["role:scout Scout work", "scout", "fork", "Scout work"],
			["fresh:scout Legacy fresh", "scout", "fresh", "Legacy fresh"],
			["fork:scout Legacy fork", "scout", "fork", "Legacy fork"],
			["role:scout fresh Combined overrides", "scout", "fresh", "Combined overrides"],
		] as const) {
			const gate = deferred(); gates.push(gate);
			const arrival = api.script(task, { text: `${task}-RESULT`, gate });
			await h.commands.get("delegate").handler(text, h.ctx()); await arrival;
			const run: any = [...h.state().runs.values()].find((r: any) => r.task === task);
			assert.equal(run.role, role); assert.equal(run.context, context); assert.equal(run.depth, 1);
			await until(() => api.requests.some(r => JSON.stringify(r.messages).includes(`delegate ${run.id} directly`)));
			await h.runtime.session.agent.waitForIdle();
			assert.equal(run.completion.settled, false, "main start management did not join the child");
			const before = api.requests.length;
			gate.resolve(); await until(() => run.completion.settled);
			await until(() => api.requests.length > before);
			await h.runtime.session.agent.waitForIdle();
			assert.match(JSON.stringify(api.requests.at(-1).messages), new RegExp(`${task}-RESULT`));
			assert.equal(run.userStarted, true, "management never depends on the main steering it");
		}
		await h.commands.get("delegate").handler("process printf 'ROOT-PROCESS-RESULT'", h.ctx());
		await until(() => h.notices.some(n => n.content.includes("ROOT-PROCESS-RESULT") && n.content.includes("finished")));
		await h.runtime.session.agent.waitForIdle();
		const process = h.notices.find(n => n.details?.backend === "process");
		assert.equal(process.details.depth, 1); assert.equal(process.details.parentRunId, undefined);
		assert.equal(process.details.userStarted, true);
		assert(!h.commands.get("delegate").getArgumentCompletions("").some((i: any) => i.value.startsWith("under:")));
		assert.deepEqual(h.errors, []); assert.deepEqual(api.errors, []);
	} finally {
		for (const gate of gates) gate.resolve();
		await h.runtime.dispose(); await api.close();
	}
});


test("queued user-command handoff/results retain automatic activation after an aborted main turn", () => {
	const sent: any[] = [];
	const owner: any = { closed: false, binding: { pi: { sendMessage: (message: any, options: any) => sent.push({ message, options }) }, ctx: { sessionManager: { getEntries: () => [] } } } };
	for (const kind of ["user-start", undefined]) notify(owner, {
		customType: "delegate", display: true, content: "Manage this user-started work",
		details: { id: "worker-pending", segment: 1, kind, userStarted: true },
	});
	assert.equal(inFlight(owner).size, 2);
	// Pi cleared the queued follow-ups on abort; the settled-turn handler retries both.
	sent.length = 0;
	redeliver(owner, true);
	assert.equal(sent.length, 2);
	assert(sent.every(({ options }) => options.triggerTurn === true && options.deliverAs === "followUp"));
	assert.equal(inFlight(owner).size, 2, "neither start nor completion is silently lost before receipt");
});
