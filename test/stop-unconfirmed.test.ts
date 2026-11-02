import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { deferred, harness, provider, sandbox } from "./fixture.ts";

const bounded = async <T>(promise: Promise<T>, ms = 2000): Promise<T> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`control response exceeded ${ms}ms`)), ms); })]); }
	finally { clearTimeout(timer); }
};

test("unconfirmed in-process release retains all execution fences", { timeout: 30000 }, async t => {
	const api = await provider(), box = sandbox(api.url);
	api.onUnscripted(() => ({ text: "Completion received." }));
	const childRequests = () => api.requests.filter(request => JSON.stringify(request.messages.filter((m: any) => m.role === "system" || m.role === "developer")).includes("Delegated worker contract")).length;
	mkdirSync(join(box.agentDir, "extensions"), { recursive: true });
	writeFileSync(join(box.agentDir, "extensions", "stop-tool.js"), `export default function(pi) {
		pi.registerTool({ name: "stop_tool", label: "stop_tool", description: "Externally gated tool", parameters: { type: "object", properties: {} },
		async execute(_id, _params, signal) {
			const gate = globalThis[Symbol.for("pi-delegate-test/stop-tool")];
			gate.started.resolve(); signal.addEventListener("abort", () => gate.aborted.resolve(), { once: true });
			await gate.release.promise;
			return { content: [{ type: "text", text: "Late release" }], details: undefined };
		} });
	}`);
	writeFileSync(join(box.agentDir, "pi-delegate.json"), JSON.stringify({ delegate: { maxConcurrent: 1 } }));
	mkdirSync(join(box.cwd, ".pi", "agents"), { recursive: true });
	writeFileSync(join(box.cwd, ".pi", "agents", "gated.md"), "---\nname: gated\ndescription: Stop fixture\ntools: stop_tool,write\n---\nDo work.\n");
	const h = await harness(box, undefined, { extensions: true });
	const { activeWriter, capacityError, closeOwner } = await import("../src/pi-backend.ts");
	try {
		for (const cause of ["timeout", "cancelled", "shutdown"] as const) await t.test(cause, async () => {
			const gate = { started: deferred(), aborted: deferred(), release: deferred() };
			(globalThis as any)[Symbol.for("pi-delegate-test/stop-tool")] = gate;
			const task = `Gated ${cause}`;
			api.script(task, { tool: { name: "stop_tool", arguments: {} } });
			const started = await h.launch(task, { role: "gated", timeoutMs: cause === "timeout" ? 500 : 60000 });
			const run = h.state().runs.get(started.details.id);
			const expected = cause === "timeout" ? "timeout" : "cancelled";
			let settlements = 0;
			const settle = run.completion.settle.bind(run.completion);
			run.completion.settle = (value: any) => { settlements++; settle(value); };
			try {
				await bounded(gate.started.promise);
				if (cause === "cancelled") {
					const cancel = await bounded(h.ctl("cancel", run.id));
					assert.match(cancel.content[0].text, /execution release unconfirmed/i);
				} else if (cause === "shutdown") {
					const owner = h.state().owners.get(run.ownerKey);
					await assert.rejects(bounded(closeOwner(owner)), /execution release unconfirmed/);
					assert.equal(h.state().runs.get(run.id), run, "shutdown retains unresolved handles");
					assert.equal(h.state().owners.get(run.ownerKey), owner);
				}
				await bounded(gate.aborted.promise);
				const saved = JSON.parse(readFileSync(run.recordPath, "utf8"));
				assert.equal(saved.status, expected, "stop intent must be durable before tool release");
				assert.equal(saved.stopIntent.cause, expected);
				assert.equal(saved.stopIntent.segment, run.segment);
				assert.equal(saved.ownerToken, run.ownerToken);
				assert.match(saved.haltNote, /execution release unconfirmed/);
				assert.equal(run.completion.settled, false);
				assert.equal(run.activeTools.size, 1);
				assert.equal(activeWriter(run.cwd), run);
				assert.equal(capacityError()?.code, "CONCURRENCY_LIMIT");
				const requests = childRequests();
				if (cause !== "shutdown") {
					const status = await h.ctl("status", run.id);
					assert.match(status.content[0].text, /execution release unconfirmed/i);
					assert.equal(status.details.settled, false);
					await assert.rejects(bounded(h.ctl("steer", run.id, { message: "Must not overlap", restart: true })), /still stopping|release unconfirmed/);
					if (cause === "timeout") {
						const waited = await bounded(h.ctl("wait", run.id), 4000);
						assert.match(waited.content[0].text, /execution release unconfirmed/);
						assert.equal(waited.details.settled, false);
						assert.equal(waited.details.completionReceipt, undefined);
						await bounded(h.ctl("cancel", run.id));
						assert.equal(run.stopIntent.cause, "timeout", "later cancel cannot erase timeout");
					}
				}
				assert.equal(childRequests(), requests);
				gate.release.resolve();
				// Observe settlement without joining: internal grace must not steal the parent's receipt.
				for (let i = 0; i < 100 && !run.completion.settled; i++) await delay(10);
				assert.equal(run.completion.settled, true);
				assert.equal(run.status, expected, "late normal completion cannot replace stop cause");
				assert.equal(run.haltNote, undefined);
				assert.equal(run.activeTools.size, 0);
				assert.equal(activeWriter(run.cwd), undefined);
				assert.equal(capacityError(), undefined);
				const result = run.completion.result;
				assert.equal(result.details.completionReceipt, true);
				assert.equal(result.details.stopIntent.cause, expected);
				assert.equal(result.details.settled, true);
				await delay(100);
				assert.equal(settlements, 1);
				assert.equal(childRequests(), requests, "no automatic revival after release");
				const final = JSON.parse(readFileSync(run.recordPath, "utf8"));
				assert.equal(final.status, expected);
				assert.equal(final.haltNote, undefined);
				if (cause !== "shutdown") {
					assert.equal(h.notices.filter(n => n.details?.id === run.id && n.details?.completionReceipt).length, 1);
				} else {
					for (let i = 0; i < 100 && h.state().runs.has(run.id); i++) await delay(10);
					assert.equal(h.state().runs.has(run.id), false, "actual release completes deferred shutdown");
				}
			} finally {
				gate.release.resolve();
				if (run) await bounded(run.completion.wait());
			}
		});
	} finally {
		await h.runtime.dispose(); await api.close(); rmSync(box.root, { recursive: true, force: true });
		delete (globalThis as any)[Symbol.for("pi-delegate-test/stop-tool")];
	}
});
