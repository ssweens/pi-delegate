import "./setup.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { deferred, harness, provider, sandbox } from "./fixture.ts";

const until = async (check: () => boolean) => {
	for (const end = Date.now() + 8000; !check();) {
		assert(Date.now() < end, "condition did not become true");
		await sleep(20);
	}
};

test("internal branch binding preserves Pi/process ownership and delivery", { timeout: 60000 }, async () => {
	const api = await provider(), box = sandbox(api.url);
	mkdirSync(join(box.agentDir, "agents"), { recursive: true });
	writeFileSync(join(box.agentDir, "agents", "coordinator.md"), "---\nname: coordinator\ndescription: Read-only lead\ntools: read, delegate, delegate_ctl\nmodel: fixture/fixture:off\ncontext: fresh\n---\nCoordinate the assignment.\n");
	const h = await harness(box);
	const all = () => [...h.state().runs.values()] as any[];
	const leadGate = deferred(), childGate = deferred();
	const leadRequest = api.script("Lead assignment", { text: "LEAD-ACTIVE", gate: leadGate });
	api.onUnscripted(() => ({ text: "LEAD-SAW-RESULT" }));
	try {
		await h.launch("Lead assignment", { role: "coordinator" });
		await leadRequest;
		const lead = all().find(r => r.task === "Lead assignment");
		let leadOwner = [...h.state().owners.values()].find((o: any) => o.parentRun === lead) as any;
		assert(leadOwner?.binding);
		const childRequest = api.script("Branch assignment", { text: "BRANCH-RESULT", gate: childGate });
		const requestCount = api.requests.length;
		await leadOwner.startBranch({ role: "scout", context: "fresh", task: "Branch assignment" });
		await childRequest;
		const child = all().find(r => r.task === "Branch assignment");
		assert.equal(child.parentRunId, lead.id);
		assert.equal(child.depth, 2);
		assert.equal(child.ownerKey, leadOwner.key);
		assert.equal(child.userStarted, undefined, "branch completion must wake its lead, not be root-only display");
		assert.equal((await h.ctl("status", child.id)).details.id, child.id, "root reads branch");
		assert.equal((await leadOwner.control({ action: "status", runId: child.id })).details.id, child.id, "lead reads branch");
		assert.match((await h.ctl("approve", child.id)).content[0].text, /approve requires role and model/, "incidental runId does not forward a root-only action");
		childGate.resolve();
		await until(() => child.completion.settled);
		await sleep(80);
		assert.equal(api.requests.length, requestCount + 1, "completion did not interrupt the active lead response");
		assert.equal(lead.completion.settled, false);
		leadGate.resolve();
		await until(() => lead.completion.settled);
		assert.match(lead.output, /LEAD-SAW-RESULT/);
		assert(api.requests.some(r => JSON.stringify(r.messages).includes("BRANCH-RESULT")), "lead saw the branch completion at its follow-up");
		assert(!h.notices.some(n => n.details?.id === child.id), "branch report was not delivered to root");
		await h.runtime.session.reload();
		assert.equal((await h.ctl("status", child.id)).details.id, child.id, "root reload preserves branch ownership");

		// A second segment proves forks copy this lead's conversation, never a referenced old session.
		const gate2 = deferred();
		const nextRequest = api.script("Continue lead", { text: "LEAD-AGAIN", gate: gate2 });
		await h.ctl("steer", lead.id, { message: "Continue lead" });
		await nextRequest;
		leadOwner = [...h.state().owners.values()].find((o: any) => o.parentRun === lead) as any;
		const forkGate = deferred();
		const forkRequest = api.script("Forked assignment", { text: "FORK-RESULT", gate: forkGate });
		await leadOwner.startBranch({ role: "scout", context: "fork", task: "Forked assignment" });
		const forked = await forkRequest;
		assert.match(JSON.stringify(forked.messages), /Lead assignment/);
		const fork = all().find(r => r.task === "Forked assignment");
		assert.equal(fork.parentRunId, lead.id);
		assert.equal((await h.ctl("cancel", fork.id)).details.status, "cancelled");
		forkGate.resolve();

		await leadOwner.startBranch({ backend: "process", command: "printf 'PROCESS-BRANCH'; sleep 30" });
		const process = leadOwner.processes.owned(leadOwner.key)[0];
		assert.equal(process.parentRunId, lead.id);
		assert.equal(process.depth, 2);
		assert.equal((await h.ctl("status", process.id)).details.id, process.id);
		assert(h.state().owners.get(lead.ownerKey).live.processes().some((v: any) => v.id === process.id), "root Processes view includes branch");
		const record = JSON.parse(readFileSync(join(leadOwner.dir, "process", `${process.id}.json`), "utf8"));
		assert.equal(record.parentRunId, lead.id, "lineage survives persistence");
		assert.equal((await h.ctl("cancel", process.id)).details.status, "cancelled");
		const joined = await h.ctl("wait", undefined, { runIds: [fork.id, process.id], mode: "all" });
		assert.equal(joined.details.rows.length, 2, "ancestor multi-wait joins both branch backends");
		gate2.resolve();
		await until(() => lead.completion.settled);

		const stopGate = deferred();
		const stopRequest = api.script("Stop lead", { text: "STOP-ACTIVE", gate: stopGate });
		await h.ctl("steer", lead.id, { message: "Stop lead" }); await stopRequest;
		leadOwner = [...h.state().owners.values()].find((o: any) => o.parentRun === lead) as any;
		await assert.rejects(leadOwner.startBranch({ backend: "acp", agent: "pi", task: "No ACP" }), /in-process Pi and process only/);
		await assert.rejects(leadOwner.startBranch({ backend: "pi", role: "scout", task: "No hosted session", runtime: "oven" }), /in-process Pi and process only/);
		await leadOwner.startBranch({ backend: "process", command: "sleep 30" });
		const stoppedProcess = leadOwner.processes.owned(leadOwner.key).find((v: any) => v.id !== process.id);
		assert(stoppedProcess);
		assert.equal((await h.ctl("cancel", lead.id)).details.status, "cancelled");
		stopGate.resolve();
		const stoppedRecord = JSON.parse(readFileSync(join(leadOwner.dir, "process", `${stoppedProcess.id}.json`), "utf8"));
		assert.equal(stoppedRecord.status, "interrupted", "stopping lead releases its process branch");
		assert(h.state().owners.get(lead.ownerKey).live.processes().some((v: any) => v.id === stoppedProcess.id), "departed process remains root-visible");
		assert.equal((await h.ctl("wait", "ignored-runId", { runIds: [stoppedProcess.id] })).details.status, "interrupted", "runIds takes precedence and restores departed process ownership without replay");
		assert.equal((await h.ctl("result", stoppedProcess.id)).details.status, "interrupted", "root reads process after its lead session closes, without replay");
		assert.equal(lead.status, "cancelled", "reading a departed process does not restart its stopped lead");
		assert.deepEqual(h.errors, []);
	} finally {
		leadGate.resolve(); childGate.resolve();
		await h.runtime.dispose(); await api.close();
	}
});
