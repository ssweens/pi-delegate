import "./setup.ts"; // First: isolates this file from the real home even when run on its own.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deferred, harness, provider, sandbox } from "./fixture.ts";
import { configureAcpCoordinator, shutdownAcpCoordinator } from "../src/acp/instance.ts";

const fakeAcpAgent = new URL("./acp/fixtures/fake-acp-agent.ts", import.meta.url).pathname;
const text = (content: any) => typeof content === "string" ? content : (content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
const lastUser = (request: any) => text(request.messages.findLast((m: any) => m.role === "user")?.content);
const lastTool = (request: any) => text(request.messages.findLast((m: any) => m.role === "tool")?.content);
const until = async (what: string, predicate: () => unknown, ms = 15_000) => {
	const deadline = Date.now() + ms;
	while (!predicate()) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`); await new Promise((resolve) => setTimeout(resolve, 25)); }
};

test("a delegating child's ACP run is in the root's Agents tree, and the root's UI reads, stops and steers it", { timeout: 90_000 }, async (t) => {
	const api = await provider();
	const box = sandbox(api.url);
	configureAcpCoordinator({ stateDir: join(box.root, "acp-state"), agentOverrides: {
		fixture: [process.execPath, "--import", import.meta.resolve("tsx"), fakeAcpAgent, join(box.root, "fixture-state.json")],
	} });
	mkdirSync(join(box.cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(box.cwd, ".pi", "agents", "coordinator.md"), "---\nname: coordinator\ndescription: Starts an ACP worker of its own.\ntools: read, delegate, delegate_ctl\ncontext: fresh\n---\n\nYou coordinate.\n");
	const h = await harness(box);
	const hold = deferred();
	api.script("Coordinate an ACP worker", { tool: { name: "delegate", arguments: { backend: "acp", agent: "fixture", task: "Nested ACP WAIT" } } });
	// The coordinator stays mid-turn, so its session, and the ACP backend that owns its worker, stay open.
	api.onUnscripted((request) => /acp|running/.test(lastTool(request)) && lastUser(request) === "Coordinate an ACP worker" ? { text: "COORDINATOR-DONE", gate: hold } : { text: "ACK" });
	t.after(async () => { hold.resolve(); await h.runtime.dispose(); await shutdownAcpCoordinator(); configureAcpCoordinator({}); await api.close(); });

	const coordinator = await h.launch("Coordinate an ACP worker", { role: "coordinator" });
	assert.notEqual(coordinator.isError, true, coordinator.content[0].text);
	const root = [...h.state().owners.values()].find((o: any) => !o.parentRun && o.live);
	assert(root, "the root parent's owner carries its live view");
	const nestedRow = () => root.live.all().find((v: any) => v.backend === "acp");
	await until("the nested ACP row", () => nestedRow()?.status === "running" && nestedRow()?.turns >= 1);
	const row = nestedRow();
	assert.equal(row.depth, 2, "drawn one level under the coordinator");
	assert.equal(row.parentRunId, coordinator.details.id);
	assert.deepEqual(root.live.all().map((v: any) => v.id), [coordinator.details.id, row.id], "tree order: the coordinator, then what it started");
	assert.ok(Array.isArray(root.live.activity(row.id).messages), "its transcript is readable from the root");

	await root.live.cancel(row.id);
	await until("the cancel to settle", () => nestedRow()?.status !== "running");
	assert.notEqual(nestedRow().status, "running");
	await root.live.steer(row.id, "SET:from-root");
	await until("the steered turn to settle", () => nestedRow()?.turns === 2 && nestedRow()?.status !== "running");
	assert.match(nestedRow().output, /READY/, "the steered turn ran in the same ACP session");
});
