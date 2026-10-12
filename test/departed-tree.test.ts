import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { harness, provider, sandbox } from "./fixture.ts";
import { configureAcpCoordinator, shutdownAcpCoordinator } from "../src/acp/instance.ts";

const fakeAcpAgent = new URL("./acp/fixtures/fake-acp-agent.ts", import.meta.url).pathname;
const text = (content: any) => typeof content === "string" ? content : (content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
const firstUser = (request: any) => text(request.messages.find((m: any) => m.role === "user")?.content);
const lastUser = (request: any) => text(request.messages.findLast((m: any) => m.role === "user")?.content);
const toolTexts = (request: any) => request.messages.filter((m: any) => m.role === "tool").map((m: any) => text(m.content));
const until = async (what: string, predicate: () => unknown, ms = 20_000) => {
	const deadline = Date.now() + ms;
	while (!predicate()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise((resolve) => setTimeout(resolve, 25)); }
};

test("a delegating child's runs stay in the root's tree after its session closes, and a steer revives them through it", { timeout: 90_000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	configureAcpCoordinator({ stateDir: join(box.root, "acp-state"), agentOverrides: {
		fixture: [process.execPath, "--import", import.meta.resolve("tsx"), fakeAcpAgent, join(box.root, "fixture-state.json")],
	} });
	mkdirSync(join(box.cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(box.cwd, ".pi", "agents", "coordinator.md"), "---\nname: coordinator\ndescription: Starts a pi scout and an ACP worker, and joins both.\ntools: read, delegate, delegate_ctl\ncontext: fresh\n---\n\nYou coordinate.\n");
	const h = await harness(box);
	// The coordinator starts a scout, then an ACP worker, joins both, and reports.
	api.onUnscripted((request) => {
		if (firstUser(request) !== "Coordinate a departure") return { text: "ACK" };
		const tools = toolTexts(request);
		const scout = tools.map((tool: string) => /(scout-[0-9a-f-]{36}) running/.exec(tool)?.[1]).find(Boolean);
		const worker = tools.map((tool: string) => /(fixture-[0-9a-f-]{36})/.exec(tool)?.[1]).find(Boolean);
		if (!scout) return { tool: { name: "delegate", arguments: { role: "scout", context: "fresh", task: "Departing scout", model: "fixture/fixture:off" } } };
		if (!worker) return { tool: { name: "delegate", arguments: { backend: "acp", agent: "fixture", task: "Departing ACP worker" } } };
		if (tools.length === 2) return { tool: { name: "delegate_ctl", arguments: { action: "wait", runIds: [scout, worker], mode: "all" } } };
		return { text: "COORDINATOR-DONE" };
	});
	api.script("Departing scout", { text: "SCOUT-FIRST-REPORT" });
	t.after(async () => { await h.runtime.dispose(); await shutdownAcpCoordinator(); configureAcpCoordinator({}); await api.close(); });

	const started = await h.launch("Coordinate a departure", { role: "coordinator" });
	const coordinatorId = started.details.id;
	assert.equal((await h.ctl("wait", coordinatorId)).details.status, "complete");
	const root = [...h.state().owners.values()].find((o: any) => !o.parentRun && o.live);
	const rows = () => root.live.all();
	const ids = rows().map((v: any) => v.id);
	assert.equal(ids[0], coordinatorId);
	const scoutId = ids.find((id: string) => id.startsWith("scout-"));
	const workerId = ids.find((id: string) => id.startsWith("fixture-"));
	assert(scoutId && workerId, `both of the coordinator's runs are listed: ${ids.join(", ")}`);
	const state = h.state();
	const childOwnerOf = (runId: string) => [...state.owners.values()].find((o: any) => o.parentRun?.id === runId);
	assert(childOwnerOf(coordinatorId), "while its session is open, the coordinator's runs are live");

	// Cancelling the settled coordinator closes its session and its children's owner, as a retirement does.
	await h.ctl("cancel", coordinatorId);
	await until("the coordinator's session to close", () => !childOwnerOf(coordinatorId));
	const after = rows();
	assert.deepEqual(after.map((v: any) => v.id), ids, "the same rows, in the same place, after its session closed");
	for (const v of after.slice(1)) { assert.equal(v.depth, 2); assert.equal(v.parentRunId ?? coordinatorId, coordinatorId); assert.equal(v.settled, true); }
	assert.match(JSON.stringify(root.live.activity(scoutId).messages), /SCOUT-FIRST-REPORT/, "its transcript is still readable");
	assert.match(JSON.stringify(root.live.activity(workerId).messages), /READY/);

	// Steering it from the root reopens the coordinator's session first, then steers it, as a root child's revival does.
	api.script("Steered after its parent closed", { text: "SCOUT-SECOND-REPORT" });
	await root.live.steer(scoutId, "Steered after its parent closed");
	assert(childOwnerOf(coordinatorId), "the coordinator's session reopened and its children reattached");
	await until("the revived scout's new segment", () => state.runs.get(scoutId)?.segment === 2 && state.runs.get(scoutId)?.completion.settled);
	assert.equal(state.runs.get(scoutId).output, "SCOUT-SECOND-REPORT");
	assert.equal(rows().filter((v: any) => v.id === scoutId).length, 1, "listed once: live again, not also as departed");

	// The ACP worker the same way: its parent's session closes again, and a steer revives it through it.
	await h.ctl("cancel", coordinatorId);
	await until("the coordinator's session to close again", () => !childOwnerOf(coordinatorId));
	assert(rows().some((v: any) => v.id === workerId && v.depth === 2), "the ACP worker is still listed under it");
	await root.live.steer(workerId, "SET:after-departure");
	assert(childOwnerOf(coordinatorId), "steering the worker reopened the coordinator's session");
	await until("the worker's steered turn", () => rows().find((v: any) => v.id === workerId)?.turns === 2 && rows().find((v: any) => v.id === workerId)?.status !== "running");
	assert.match(rows().find((v: any) => v.id === workerId).output, /READY/, "the turn ran in the worker's own ACP session");
});
