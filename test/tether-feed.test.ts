import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deferred, provider, sandbox, harness } from "./fixture.ts";

// Real parent/child tool protocol, sessions, reload and event bus. Only HTTP model replies are scripted.
test("automatic Mom waits for a worker to settle, then observes its whole run without bookkeeping or an extra lead turn", { timeout: 30000 }, async () => {
	const api = await provider(), box = sandbox(api.url);
	const { default: tether } = await import("../../pi-tether/src/index.ts");
	const { SidecarStore } = await import("../../pi-tether/src/sidecar.ts");
	const { LiveFeed } = await import("../../pi-tether/src/feed.ts");
	const h = await harness(box, undefined, { register: (pi: any) => {
		tether(new Proxy(pi, { get(target, key) {
			if (key === "getFlag") return (name: string) => name === "mom-model" ? "fixture/fixture" : name === "mom-interval-ms" ? "0" : target.getFlag(name);
			return target[key];
		} }));
	} });
	const gate = deferred<void>(), firstGate = deferred<void>();
	writeFileSync(join(box.cwd, "seed.txt"), "seed");
	const motherRequests: any[] = [];
	const until = async (predicate: () => unknown) => {
		const deadline = Date.now() + 8000;
		while (!(await predicate())) { if (Date.now() > deadline) throw new Error(`Mom did not capture the worker narrative: ${JSON.stringify({ motherRequests, extensionErrors: h.errors, providerErrors: api.errors })}`); await new Promise((resolve) => setTimeout(resolve, 20)); }
	};
	try {
		const prompt = "Keep user work anchored while the scout traces the route.";
		api.script(prompt,
			{ tool: { name: "delegate", arguments: { role: "scout", context: "fresh", task: "Trace route", cwd: box.cwd, model: "fixture/fixture:off" } } },
			{ text: "Scout launched. I am continuing the main purpose." });
		const arrived = api.script("Trace route", { text: "Exploring the boundary before changing code.", tool: { name: "read", arguments: { path: "seed.txt" } }, gate: firstGate }, { text: "Worker result: the route is understood.", gate });
		api.onUnscripted((request) => {
			if (!request.tools?.some((t: any) => t.function?.name === "commit_graph")) return { text: "Lead received the worker's completion." };
			const user = request.messages.findLast((m: any) => m.role === "user");
			const input = JSON.parse(typeof user.content === "string" ? user.content : user.content.map((b: any) => b.text).join("\n"));
			motherRequests.push(input);
			const ref = /\[src:([^\]]+)\]/.exec(input.newEvents)?.[1] ?? input.original.ref;
			return { tool: { name: "commit_graph", arguments: { revision: input.graph.revision, purpose: "main", focus: "main", note: null,
				upsertNodes: [{ id: "main", kind: "try", parent: null, state: "active", label: "Main purpose", intent: "Keep the main purpose.", observed: "Scout progress received.", actor: "lead", sources: [ref] }],
				unfinished: [], upsertEdges: [], removeEdges: [], merges: [], folds: [], removeNodes: [], supersessions: [] } } };
		});
		await h.runtime.session.prompt(prompt);
		await arrived;
		const manager = h.runtime.session.sessionManager;
		const launch = manager.getBranch().find((e: any) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "delegate") as any;
		assert(launch?.message.details?.id, "worker must be linked through an actual launch call/result");
		const id = launch.message.details.id;
		const recordedLaunch = JSON.stringify(launch);
		await h.runtime.session.reload();
		const callsBeforeProgress = motherRequests.length;
		firstGate.resolve();
		await until(() => h.state().runs.get(id)?.toolCalls.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(motherRequests.length, callsBeforeProgress, "worker progress must not wake Mom mid-run");
		assert.equal(JSON.stringify(launch), recordedLaunch, "worker progress must not mutate a recorded launch result");
		const feed = new LiveFeed(manager);
		await feed.capture();
		const cold = new LiveFeed(h.sdk.SessionManager.open(h.parent));
		await cold.restore(feed.cut());
		assert.equal((await h.ctl("status", id)).details.status, "running");
		assert.equal(h.notices.length, 0);
		assert.equal(api.requests.filter((r: any) => r.tools?.some((t: any) => t.function?.name === "delegate")).length, 2, "only the original parent tool round and reply ran");
		// Nothing publishes while the worker is still running.
		const sidecar = () => new SidecarStore(() => h.parent, manager.getSessionId()).load();
		assert(!(await sidecar()).some((r) => r.type === "checkpoint"));
		gate.resolve();
		assert.equal((await h.ctl("wait", id)).details.status, "complete");
		await until(() => motherRequests.some((input) => input.newEvents.includes("Exploring the boundary before changing code.") && input.newEvents.includes("Worker result: the route is understood.")));
		await until(async () => (await sidecar()).some((r) => r.type === "checkpoint" && r.data.cut.workers.length === 1));
		const checkpoint = (await sidecar()).findLast((r) => r.type === "checkpoint")!;
		assert.equal(checkpoint.data.cut.workers[0].runId, id);
		assert(!manager.getEntries().some((e: any) => typeof e.customType === "string" && e.customType.startsWith("pi-tether.mom.")), "no Mom checkpoint in the session file");
		assert.deepEqual(h.errors, []); assert.deepEqual(api.errors, []);
	} finally { firstGate.resolve(); gate.resolve(); await h.runtime.dispose(); await api.close(); rmSync(box.root, { recursive: true, force: true }); }
});
