import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DELEGATE_MILESTONE_EVENT, type DelegateMilestone } from "../src/index.ts";
import { deferred, provider, sandbox, harness } from "./fixture.ts";

test("worker milestones reach only the parent event bus while the worker continues", { timeout: 30000 }, async () => {
	const api = await provider(), box = sandbox(api.url);
	const seen: DelegateMilestone[] = [];
	const h = await harness(box, undefined, { register: (pi) => {
		pi.events.on(DELEGATE_MILESTONE_EVENT, (data: unknown) => seen.push(data as DelegateMilestone));
	} });
	writeFileSync(join(box.cwd, "seed.txt"), "seed");
	const gate = deferred<void>(), firstGate = deferred<void>();
	try {
		const arrived = api.script("Investigate boundary", { text: "I found a narrow path; reading seed.txt next.", tool: { name: "read", arguments: { path: "seed.txt" } }, gate: firstGate }, { text: "Verified the path.", gate });
		const launch = await h.launch("Investigate boundary");
		const id = launch.details.id;
		await arrived;
		assert.equal(seen[0]?.kind, "started");
		await h.runtime.session.reload(); // a live child retains its session but the parent extension binding changes
		firstGate.resolve();
		for (let i = 0; i < 100 && (api.requests.length < 2 || !seen.some((e) => e.kind === "note")); i++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(launch.details.status, "running");
		assert.deepEqual(seen.slice(0, 2).map((e) => e.kind), ["started", "note"]);
		assert.equal(seen[0].runId, id);
		assert.equal(seen[0].task, "Investigate boundary");
		assert.equal(seen[1].text, "I found a narrow path; reading seed.txt next.");
		assert.equal(seen.some((e) => e.kind === "settled"), false, "note arrived before the child finished");
		assert.equal(h.notices.length, 0, "milestones must not trigger a parent model turn");
		api.onUnscripted(() => ({ text: "Parent saw completion" }));
		gate.resolve();
		const result = await h.ctl("wait", id);
		assert.equal(result.details.status, "complete");
		assert.equal(seen.filter((e) => e.kind === "settled" && e.runId === id).length, 1);
		assert.equal(seen.findLast((e) => e.runId === id)?.status, "complete");
		assert(seen.every((e) => e.version === 1 && e.segment === 1 && e.role === "scout"));
	} finally { firstGate.resolve(); gate.resolve(); await h.runtime.dispose(); await api.close(); rmSync(box.root, { recursive: true, force: true }); }
});
