import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { deferred, harness, provider, sandbox } from "./fixture.ts";

test("adopt a completed coordinator cancelled with subtree-only uncertainty", { timeout: 25000 }, async () => {
	const api = await provider(), box = sandbox(api.url);
	const gate = { started: deferred(), release: deferred() };
	(globalThis as any)[Symbol.for("subtree-recovery-gate")] = gate;
	mkdirSync(join(box.agentDir, "extensions"), { recursive: true });
	writeFileSync(join(box.agentDir, "extensions", "gate.js"), `export default function(pi) {
		pi.registerTool({ name: "recovery_gate", label: "recovery_gate", description: "Gated writer", parameters: { type: "object", properties: {} },
		async execute() { const g = globalThis[Symbol.for("subtree-recovery-gate")]; g.started.resolve(); await g.release.promise; return { content: [{ type: "text", text: "released" }] }; } });
	}`);
	mkdirSync(join(box.cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(box.cwd, ".pi", "agents", "lead.md"), "---\nname: lead\ndescription: Coordinator\ntools: delegate,delegate_ctl\n---\nCoordinate.\n");
	writeFileSync(join(box.cwd, ".pi", "agents", "gated.md"), "---\nname: gated\ndescription: Gated writer\ntools: recovery_gate,write\n---\nWork.\n");
	let h = await harness(box, undefined, { extensions: true });
	const backend = await import("../src/pi-backend.ts");
	api.onUnscripted(() => ({ text: "Receipt read" }));
	try {
		api.script("Complete before child", { tool: { name: "delegate", arguments: { role: "gated", context: "fresh", task: "Gated descendant", model: "fixture/fixture:off" } } }, { text: "COORDINATOR COMPLETE" });
		api.script("Gated descendant", { tool: { name: "recovery_gate", arguments: {} } });
		const started = await h.launch("Complete before child", { role: "lead" });
		await gate.started.promise;
		await h.ctl("wait", started.details.id);
		const run = h.state().runs.get(started.details.id), root = h.state().owners.get(run.ownerKey);
		await h.ctl("cancel", run.id);
		const saved = JSON.parse(readFileSync(run.recordPath, "utf8"));
		assert.equal(saved.status, "complete");
		assert.equal(saved.stopped, true);
		assert.equal(saved.stopIntent, undefined);
		assert.match(saved.haltNote, /execution release unconfirmed/);
		await assert.rejects(h.ctl("steer", run.id, { message: "Not yet", restart: true }), /release unconfirmed/);

		// Release the actual local execution before simulating an unowned crash snapshot.
		gate.release.resolve();
		for (let i = 0; i < 200 && backend.childOwner(run); i++) await delay(25);
		assert.equal(backend.childOwner(run), undefined);
		await backend.closeOwner(root);
		await h.runtime.dispose();
		assert.equal(h.state().runs.has(run.id), false);
		const unowned = { ...saved, ownerPid: undefined, ownerHost: undefined, ownerToken: undefined };
		writeFileSync(run.recordPath, JSON.stringify(unowned));
		h = await harness(box, h.parent, { extensions: true });
		const adopted = h.state().runs.get(run.id);
		assert.equal(adopted.status, "complete", "own completed segment is not relabelled cancelled");
		assert.equal(adopted.stopped, true);
		assert.equal(adopted.stopIntent, undefined, "recovery must not invent an execution stop cause");
		assert.equal(adopted.haltNote, undefined, "cleared in-process ownership must reconcile subtree-only uncertainty");
		const result = await h.ctl("result", run.id);
		assert.equal(result.details.settled, true);
		assert.equal(result.details.completionReceipt, true);
		assert.doesNotMatch(result.content[0].text, /execution release unconfirmed/);
		assert.match(result.content[0].text, /previous owning process/);
		const persisted = JSON.parse(readFileSync(run.recordPath, "utf8"));
		assert.equal(persisted.haltNote, undefined);
		assert.equal(persisted.status, "complete");

		// The same historical shape on an external runtime must retain its release fence.
		const externalPath = join(box.root, "external.json");
		writeFileSync(externalPath, JSON.stringify({ ...unowned, runtime: "oven", sliceId: "unconfirmed-external" }));
		const external = backend.restoreRun(externalPath, h.state().owners.get(adopted.ownerKey));
		assert.equal(external.haltNote, saved.haltNote);
		assert.equal(JSON.parse(readFileSync(externalPath, "utf8")).haltNote, saved.haltNote);

		await assert.rejects(h.ctl("steer", run.id, { message: "Requires consent" }), /explicitly stopped/);
		// Restored descendant receipts may add a later user turn to the same restart.
		api.onUnscripted(() => ({ text: "RESTARTED" }));
		api.script("Explicit restart after adoption", { text: "RESTARTED" });
		await h.ctl("steer", run.id, { message: "Explicit restart after adoption", restart: true });
		const done = await h.ctl("wait", run.id);
		assert.equal(done.details.status, "complete");
		assert.equal(done.details.segment, saved.segment + 1);
		assert.match(done.details.output, /RESTARTED/);
	} finally {
		gate.release.resolve(); await h.runtime.dispose(); await api.close(); rmSync(box.root, { recursive: true, force: true });
		delete (globalThis as any)[Symbol.for("subtree-recovery-gate")];
	}
});
