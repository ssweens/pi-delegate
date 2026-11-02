import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { deferred, harness, provider, sandbox } from "./fixture.ts";

async function until(check: () => boolean, label: string) {
	for (let i = 0; i < 200; i++) { if (check()) return; await delay(25); }
	assert.fail(`timed out: ${label}`);
}

test("review regressions: subtree release and adopted stop records", { timeout: 40000 }, async t => {
	const api = await provider(), box = sandbox(api.url);
	let gate = { started: deferred(), aborted: deferred(), release: deferred() };
	(globalThis as any)[Symbol.for("stop-review-gate")] = gate;
	mkdirSync(join(box.agentDir, "extensions"), { recursive: true });
	writeFileSync(join(box.agentDir, "extensions", "gate.js"), `export default function(pi) {
		pi.registerTool({ name: "review_gate", label: "review_gate", description: "Externally gated writer", parameters: { type: "object", properties: {} },
		async execute(_id, _p, signal) { const g = globalThis[Symbol.for("stop-review-gate")]; g.started.resolve(); signal.addEventListener("abort", () => g.aborted.resolve(), { once: true }); await g.release.promise; return { content: [{ type: "text", text: "released" }] }; } });
	}`);
	mkdirSync(join(box.cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(box.cwd, ".pi", "agents", "lead.md"), "---\nname: lead\ndescription: Coordinator\ntools: delegate,delegate_ctl\n---\nCoordinate.\n");
	writeFileSync(join(box.cwd, ".pi", "agents", "gated.md"), "---\nname: gated\ndescription: Gated writer\ntools: review_gate,write\n---\nWork.\n");
	const h = await harness(box, undefined, { extensions: true });
	const backend = await import("../src/pi-backend.ts");
	api.onUnscripted(() => ({ text: "Receipt read" }));
	try {
		await t.test("adopted stop keeps cause and reconciles uncertainty, including missing transcript", async sub => {
			api.script("Recovery seed", { text: "SAVED" });
			const seed = await h.launch("Recovery seed");
			await h.ctl("wait", seed.details.id);
			const live = h.state().runs.get(seed.details.id), owner = h.state().owners.get(live.ownerKey);
			const record = JSON.parse(readFileSync(live.recordPath, "utf8"));
			for (const cause of ["timeout", "cancelled"] as const) for (const missing of [false, true]) await sub.test(`adopt ${cause}, transcript ${missing ? "missing" : "present"}`, async () => {
				const copy = { ...record, status: cause, endedAt: undefined, error: undefined,
					stopIntent: { cause, at: Date.now() - 1000, segment: record.segment },
					haltNote: "execution release unconfirmed; waiting for idle", ownerPid: undefined, ownerHost: undefined, ownerToken: undefined,
					...(missing ? { sessionFile: join(box.root, "missing.jsonl") } : {}) };
				const path = join(box.root, `adopt-${cause}-${missing}.json`);
				writeFileSync(path, JSON.stringify(copy));
				const recovered = backend.restoreRun(path, owner);
				assert.equal(recovered.status, cause, "harvest failure must not replace durable stop cause");
				assert.equal(recovered.haltNote, undefined, "adopted in-process execution is no longer live");
				assert.ok(recovered.endedAt);
				const result = recovered.completion.result;
				assert.equal(result.details.settled, true);
				assert.equal(result.details.completionReceipt, true);
				assert.doesNotMatch(result.content[0].text, /execution release unconfirmed/);
				assert.match(result.content[0].text, /previous process|previous owning process/i);
				if (missing) assert.match(result.content[0].text, /transcript is missing/);
				const saved = JSON.parse(readFileSync(path, "utf8"));
				assert.equal(saved.status, cause);
				assert.equal(saved.haltNote, undefined);
				assert.equal(saved.stopIntent.cause, cause);
				const reopened = backend.restoreRun(path, owner);
				assert.equal(reopened.status, cause);
				assert.equal(reopened.endedAt, recovered.endedAt);
				assert.equal(reopened.error, recovered.error, "recovery diagnostics do not duplicate on reopen");
				assert.equal(reopened.completion.result.details.stopIntent?.cause, cause);
			});
		});

		for (const mode of ["cancel", "shutdown"] as const) await t.test(`${mode} retains unresolved grandchild ownership until late release`, async () => {
			gate = { started: deferred(), aborted: deferred(), release: deferred() };
			(globalThis as any)[Symbol.for("stop-review-gate")] = gate;
			const think = deferred();
			api.script("Coordinate gated writer", { tool: { name: "delegate", arguments: { role: "gated", context: "fresh", task: "Grandchild gate", model: "fixture/fixture:off", timeoutMs: 60000 } } }, { text: "Waiting", gate: think });
			api.script("Grandchild gate", { tool: { name: "review_gate", arguments: {} } });
			const started = await h.launch("Coordinate gated writer", { role: "lead", timeoutMs: 60000 });
			const parent = h.state().runs.get(started.details.id), root = h.state().owners.get(parent.ownerKey);
			try {
				await gate.started.promise;
				const child = [...h.state().runs.values()].find((r: any) => r.parentRunId === parent.id) as any;
				const nested = backend.childOwner(parent), token = parent.ownerToken;
				let parentSettles = 0, childSettles = 0;
				const parentSettle = parent.completion.settle.bind(parent.completion), childSettle = child.completion.settle.bind(child.completion);
				parent.completion.settle = (value: any) => { parentSettles++; parentSettle(value); };
				child.completion.settle = (value: any) => { childSettles++; childSettle(value); };
				if (mode === "cancel") {
					const cancel = await h.ctl("cancel", parent.id);
					assert.match(cancel.content[0].text, /execution release unconfirmed/, "parent cancel must report unresolved subtree");
					await assert.rejects(h.ctl("steer", parent.id, { message: "No overlap", restart: true }), /release unconfirmed|still stopping/);
				} else await assert.rejects(backend.closeOwner(root), /execution release unconfirmed/);
				await gate.aborted.promise;
				assert.equal(h.state().owners.has(root.key), true);
				assert.equal(h.state().owners.has(nested!.key), true);
				assert.equal(h.state().runs.has(parent.id), true);
				assert.equal(parent.ownerToken, token);
				assert.equal(child.completion.settled, false);
				assert.equal(backend.activeWriter(child.cwd)?.id, child.id);
				gate.release.resolve();
				await until(() => !h.state().owners.has(nested!.key), "deferred subtree cleanup");
				assert.equal(parent.haltNote, undefined, "late descendant release clears parent uncertainty");
				if (mode === "shutdown") {
					await until(() => !h.state().owners.has(root.key), "deferred root cleanup");
					assert.equal(h.state().runs.has(parent.id), false);
				} else assert.equal(h.state().owners.has(root.key), true);
				assert.equal(h.state().runs.has(child.id), false);
				assert.equal(backend.activeWriter(child.cwd), undefined);
				assert.equal(JSON.parse(readFileSync(child.recordPath, "utf8")).status, "cancelled");
				assert.equal(JSON.parse(readFileSync(parent.recordPath, "utf8")).status, "cancelled");
				assert.equal(parentSettles, 1);
				assert.equal(childSettles, 1);
				assert.ok(h.notices.filter(n => n.details?.id === child.id && n.details?.completionReceipt).length <= 1);
			} finally { gate.release.resolve(); think.resolve(); }
		});
	} finally {
		gate.release.resolve(); await h.runtime.dispose(); await api.close(); rmSync(box.root, { recursive: true, force: true });
		delete (globalThis as any)[Symbol.for("stop-review-gate")];
	}
});
