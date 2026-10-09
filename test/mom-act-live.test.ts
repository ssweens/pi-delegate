import "./setup.ts";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { provider, sandbox, harness, OVEN_AVAILABLE, startOven } from "./fixture.ts";

test("Mom commits a model-written label through Oven without native tools", { timeout: 30000, skip: OVEN_AVAILABLE ? false : "Oven checkout unavailable; set OVEN_DIR." }, async () => {
	const api = await provider(), box = sandbox(api.url);
	const daemon = await startOven(box.root, box.agentDir);
	const { SidecarStore } = await import("../src/mom/sidecar.ts");
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	const momRequests: any[] = [];
	try {
		h = await harness(box, undefined, { flags: {
			"mom-model": "fixture/fixture", "mom-mode": "act_labels", "mom-interval-ms": "0", "mom-max-wait-ms": "0", "mom-retry-ms": "100,100,100",
		} });
		const prompt = "Please implement semantic map labels.";
		api.script(prompt, { text: "I will implement semantic map labels." });
		api.onUnscripted(request => {
			const names = (request.tools ?? []).map((tool: any) => tool.function?.name);
			momRequests.push(request);
			assert(!names.some((name: string) => ["read", "write", "edit", "bash", "codemode"].includes(name)), "Mom must see only bounded domain tools");
			if (names.includes("mom_begin")) return { tool: { name: "mom_begin", arguments: {} } };
			assert(names.includes("commit_acts"), `Expected the act-label finalizer, got ${names.join(", ")}`);
			const text = request.messages.findLast((message: any) => message.role === "tool")?.content;
			const result = typeof text === "string" ? text : text?.map((part: any) => part.text).join("\n");
			const input = JSON.parse(result);
			return { tool: { name: "commit_acts", arguments: { acts: input.fragments.map((fragment: any) => ({ id: fragment.id,
				act: fragment.role === "user" ? "request" : "other", ...(fragment.role === "user" ? { label: "Implement semantic map labels" } : {}) })) } } };
		});
		await h.runtime.session.prompt(prompt);
		const manager = h.runtime.session.sessionManager;
		const sidecar = () => new SidecarStore(() => h!.parent, manager.getSessionId()).load();
		let checkpoint: any;
		const deadline = Date.now() + 12000;
		while (!checkpoint && Date.now() < deadline) {
			checkpoint = (await sidecar()).findLast(record => record.type === "map" && record.data.snapshot)?.data.snapshot;
			if (!checkpoint) await new Promise(resolve => setTimeout(resolve, 25));
		}
		assert(checkpoint, `Mom did not save a map: ${JSON.stringify({ errors: api.errors, momRequests: momRequests.length, extensionErrors: h.errors })}`);
		const user = manager.getBranch().find((entry: any) => entry.type === "message" && entry.message.role === "user" && entry.message.content?.some((part: any) => part.text === prompt));
		const work = checkpoint.graph.nodes.find((node: any) => node.id === checkpoint.graph.purpose);
		assert.equal(work.label, "Implement semantic map labels");
		assert.deepEqual(work.sources, [`${manager.getSessionId()}:${user?.id}`]);
		assert.ok(momRequests.some(request => request.tools?.some((tool: any) => tool.function?.name === "commit_acts")));
		assert.deepEqual(h.errors, []);
		assert.deepEqual(api.errors, []);
	} finally {
		await h?.runtime.dispose(); await daemon.stop(); await api.close(); rmSync(box.root, { recursive: true, force: true });
	}
});
