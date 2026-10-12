import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deferred, harness, provider, sandbox } from "./fixture.ts";

const text = (content: any) => typeof content === "string" ? content : (content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
const lastUser = (request: any) => text(request.messages.findLast((m: any) => m.role === "user")?.content);
const system = (request: any) => text(request.messages.find((m: any) => m.role === "system" || m.role === "developer")?.content);
const isParent = (request: any) => /Deterministic verification parent/.test(system(request));
const toolDescription = (request: any, name: string) => (request.tools ?? []).find((t: any) => t.function?.name === name)?.function?.description ?? "";
const toolNames = (request: any): string[] => (request.tools ?? []).map((t: any) => t.function?.name);

test("delegate settings: limits, mode, model lists and completion delivery (real SDK, loopback provider)", { timeout: 90_000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	const settings = (delegate: Record<string, unknown>) => writeFileSync(join(box.agentDir, "pi-delegate.json"), JSON.stringify({ delegate }));
	mkdirSync(join(box.cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(box.cwd, ".pi", "agents", "picky.md"), "---\nname: picky\ndescription: Prefers a model that is not configured.\ntools: read\ncontext: fresh\nmodel: absent/model, fixture/fixture:off\n---\n\nYou read.\n");
	writeFileSync(join(box.cwd, ".pi", "agents", "stuck.md"), "---\nname: stuck\ndescription: Lists only models that are not configured.\ntools: read\ncontext: fresh\nmodel: absent/one, absent/two\n---\n\nYou read.\n");
	writeFileSync(join(box.cwd, ".pi", "agents", "lead.md"), "---\nname: lead\ndescription: Could delegate.\ntools: read, delegate, delegate_ctl\ncontext: fresh\n---\n\nYou lead.\n");
	const h = await harness(box, undefined, { tools: ["delegate", "delegate_ctl", "write"] });
	try {
		await t.test("a start over maxConcurrent is refused with CONCURRENCY_LIMIT and nothing is started", async () => {
			settings({ maxConcurrent: 1 });
			const gate = deferred(), arrived = api.script("Hold the slot", { text: "HELD", gate });
			const first = await h.launch("Hold the slot"); await arrived;
			const refused = await h.launch("Over the limit");
			assert.equal(refused.isError, true);
			assert.match(refused.content[0].text, /CONCURRENCY_LIMIT: 1 runs are already running, the limit set in \/delegate settings is 1/);
			assert.equal([...h.state().runs.values()].filter((r: any) => r.task === "Over the limit").length, 0, "nothing was started");
			gate.resolve();
			assert.equal((await h.ctl("wait", first.details.id)).details.status, "complete");
			api.script("After the slot frees", { text: "FREED" });
			assert.equal((await h.waitLaunch("After the slot frees")).details.status, "complete");
			// Parallel calls in one assistant message: each passes the first check before any run exists.
			const gates = [deferred(), deferred()];
			api.script("Parallel A", { text: "A", gate: gates[0] }); api.script("Parallel B", { text: "B", gate: gates[1] });
			const both = await Promise.all([h.launch("Parallel A"), h.launch("Parallel B")]);
			assert.equal(both.filter((r: any) => r.isError && /CONCURRENCY_LIMIT/.test(r.content[0].text)).length, 1, "exactly one of two parallel starts is refused");
			for (const gate of gates) gate.resolve();
			const started = both.find((r: any) => !r.isError)!;
			assert.equal((await h.ctl("wait", started.details.id)).details.status, "complete");
		});

		await t.test("maxDepth 1 launches a delegating role without delegation tools", async () => {
			settings({ maxDepth: 1 });
			api.script("Lead at the limit", { text: "LIMITED" });
			const result = await h.waitLaunch("Lead at the limit", { role: "lead" });
			assert.equal(result.details.status, "complete", result.content[0].text);
			const request = api.requests.find((r) => lastUser(r) === "Lead at the limit");
			const names = (request.tools ?? []).map((tool: any) => tool.function?.name);
			assert.deepEqual(names, ["read"], "delegate and delegate_ctl are withheld at the limit");
			assert.match(system(request), /delegation depth limit, 1/);
		});

		await t.test("a role's model list runs on the first usable entry and says why it skipped the others", async () => {
			settings({});
			api.script("Picky work", { text: "PICKED" });
			const result = await h.waitLaunch("Picky work", { role: "picky", model: undefined });
			assert.equal(result.details.status, "complete", result.content[0].text);
			assert.equal(result.details.model, "fixture/fixture");
			assert.match(result.content[0].text, /model picked: fixture\/fixture:off \(role list; skipped absent\/model: no credentials or not in the catalog\)/);
			const none = await h.launch("Stuck work", { role: "stuck", model: undefined });
			assert.equal(none.isError, true);
			assert.match(none.content[0].text, /MODEL_UNAVAILABLE: none of the role's models can be used: absent\/one: .*; absent\/two: /);
		});

		await t.test("mode off parks the delegation tools; orchestrator describes itself and refuses the parent's own writes", async () => {
			settings({ mode: "off" });
			const off = await h.launch("Refused while off");
			assert.equal(off.isError, true);
			assert.match(off.content[0].text, /DELEGATION_OFF/);
			api.script("Turn while off", { text: "OFF" });
			await h.runtime.session.prompt("Turn while off");
			assert.deepEqual(toolNames(api.requests.filter(isParent).at(-1)).filter((n) => n.startsWith("delegate")), [], "the model is not offered delegation tools");
			const parked = h.runtime.session.sessionManager.getBranch().findLast((e: any) => e.type === "custom" && e.customType === "pi-delegate.parked") as any;
			assert.deepEqual(parked?.data.tools.sort(), ["delegate", "delegate_ctl"], "what was parked is recorded on the branch, for a restart");
			settings({ mode: "orchestrator" });
			api.script("Write it yourself", { tool: { name: "write", arguments: { path: "orchestrated.txt", content: "x" } } }, { text: "UNDERSTOOD" });
			await h.runtime.session.prompt("Write it yourself");
			const parent = api.requests.filter(isParent);
			assert.match(toolDescription(parent.at(-1), "delegate"), /Delegation mode: orchestrator/);
			assert.deepEqual(toolNames(parent.at(-1)).filter((n) => n.startsWith("delegate")).sort(), ["delegate", "delegate_ctl"], "leaving off brings the parked tools back");
			const refusal = parent.at(-1).messages.findLast((m: any) => m.role === "tool");
			assert.match(text(refusal?.content), /Delegation mode is orchestrator: the main session does not write files/);
			settings({ mode: "opportunistic" });
			api.script("Back to normal", { text: "NORMAL" });
			await h.runtime.session.prompt("Back to normal");
			assert.doesNotMatch(toolDescription(api.requests.filter(isParent).at(-1), "delegate"), /Delegation mode: orchestrator/);
		});

		await t.test("a child that finishes while the parent is mid-run reaches that run at its next model request", async () => {
			settings({});
			const childGate = deferred(), arrived = api.script("Finishes mid-run", { text: "MID-RUN-REPORT", gate: childGate });
			const id = (await h.launch("Finishes mid-run")).details.id;
			await arrived;
			const busy = deferred();
			const parentStart = api.requests.filter(isParent).length;
			// The parent is in a long run: its first response is still streaming when the child settles.
			api.script("Long parent run", { tool: { name: "delegate_ctl", arguments: { action: "roles" } }, gate: busy }, { text: "SAW-THE-REPORT" });
			const turn = h.runtime.session.prompt("Long parent run");
			while (api.requests.filter(isParent).length === parentStart) await new Promise((resolve) => setTimeout(resolve, 10));
			childGate.resolve();
			const run = h.state().runs.get(id);
			while (!run.completion.settled || !h.notices.some((n: any) => n.details?.id === id)) await new Promise((resolve) => setTimeout(resolve, 10));
			busy.resolve();
			await turn;
			const inRun = api.requests.filter(isParent).slice(parentStart);
			assert.equal(inRun.length, 2, "no extra turn: the report rode the run's own next request");
			assert.match(JSON.stringify(inRun[1].messages), new RegExp(id), "the run's next request carries the report");
			const receipts = h.runtime.session.sessionManager.getEntries().filter((e: any) => e.type === "custom_message" && e.details?.id === id);
			assert.equal(receipts.length, 1, "delivered once");
		});

		await t.test("a report the person's abort cleared from Pi's queue is still recorded, without a new turn", async () => {
			const childGate = deferred(), arrived = api.script("Finishes before an abort", { text: "ABORT-REPORT", gate: childGate });
			const id = (await h.launch("Finishes before an abort")).details.id;
			await arrived;
			const parentStart = api.requests.filter(isParent).length;
			api.script("Run that gets aborted", { text: "NEVER-FINISHES", gate: deferred() });
			const turn = h.runtime.session.prompt("Run that gets aborted").catch(() => undefined);
			while (api.requests.filter(isParent).length === parentStart) await new Promise((resolve) => setTimeout(resolve, 10));
			childGate.resolve();
			const run = h.state().runs.get(id);
			while (!run.completion.settled || !h.notices.some((n: any) => n.details?.id === id)) await new Promise((resolve) => setTimeout(resolve, 10));
			// What Esc does: queued messages are cleared, then the run is aborted.
			(h.runtime.session as any).clearQueue();
			await h.runtime.session.abort();
			await turn;
			await h.runtime.session.agent.waitForIdle();
			await new Promise((resolve) => setTimeout(resolve, 50));
			const receipts = h.runtime.session.sessionManager.getEntries().filter((e: any) => e.type === "custom_message" && e.details?.id === id);
			assert.equal(receipts.length, 1, "the report is in the conversation, once");
			assert.equal(api.requests.filter(isParent).length, parentStart + 1, "no turn started after the person stopped the run");
		});
	} finally {
		await h.runtime.dispose();
		await api.close();
	}
});
