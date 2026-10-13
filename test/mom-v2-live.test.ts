import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { provider, sandbox, harness, OVEN_AVAILABLE, startOven } from "./fixture.ts";

test("v2 Mom edits the minimal map through Oven with its default decision model unavailable, repairs a rejected commit once, and saves it", { timeout: 30000, skip: OVEN_AVAILABLE ? false : "Oven checkout unavailable; set OVEN_DIR." }, async () => {
	const api = await provider(), box = sandbox(api.url);
	const daemon = await startOven(box.root, box.agentDir);
	const { SidecarStore } = await import("../src/mom/sidecar.ts");
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	const commits: unknown[] = [];
	let begun: any;
	try {
		h = await harness(box, undefined, { flags: { "mom-model": "fixture/fixture", "mom-mode": "v2", "mom-interval-ms": "0", "mom-max-wait-ms": "0", "mom-retry-ms": "100,100,100" } });
		const prompt = "Please implement semantic map labels.";
		api.script(prompt, { text: "I will implement semantic map labels." });
		api.onUnscripted(request => {
			const names: string[] = (request.tools ?? []).map((tool: any) => tool.function?.name);
			if (names.includes("mom_begin")) return { tool: { name: "mom_begin", arguments: {} } };
			assert.deepEqual(names.sort(), ["commit_v2", "inspect_evidence", "search_history"], "a v2 operation offers only its own finalizer and evidence tools");
			const last = request.messages.findLast((message: any) => message.role === "tool")?.content;
			const result = typeof last === "string" ? last : last?.map((part: any) => part.text).join("\n");
			if (!begun) begun = JSON.parse(result);
			const ref = begun.newUserDirections[0].ref;
			const node = { id: "labels", parent: null, kind: "work", state: "active", label: "Implement semantic map labels" };
			// First commit cites an invented source; the host must reject it with the defect, and the repair must land.
			const commit = commits.length ? { put: [{ ...node, sources: [ref] }], focus: "labels" } : { put: [{ ...node, sources: ["invented:1"] }], focus: "labels" };
			if (commits.length) assert.match(result, /cites unobserved source invented:1/);
			commits.push(commit);
			return { tool: { name: "commit_v2", arguments: commit } };
		});
		await h.runtime.session.prompt(prompt);
		const manager = h.runtime.session.sessionManager;
		let checkpoint: any;
		for (const deadline = Date.now() + 12000; !checkpoint && Date.now() < deadline;) {
			checkpoint = (await new SidecarStore(() => h!.parent, manager.getSessionId()).load()).findLast(record => record.type === "map" && record.data.snapshot)?.data.snapshot;
			if (!checkpoint) await new Promise(resolve => setTimeout(resolve, 25));
		}
		assert(checkpoint, `Mom did not save a map: ${JSON.stringify({ errors: api.errors, commits: commits.length, extensionErrors: h.errors })}`);
		assert.ok(begun.map && !("graph" in begun), "the model sees the map in its v2 form only");
		assert.equal(commits.length, 2);
		const user = manager.getBranch().find((entry: any) => entry.type === "message" && entry.message.role === "user" && entry.message.content?.some((part: any) => part.text === prompt));
		assert.deepEqual(checkpoint.graph.nodes, [{ id: "labels", kind: "feature", parent: null, state: "active", label: "Implement semantic map labels",
			intent: "", observed: "", actor: "", sources: [`${manager.getSessionId()}:${user?.id}`] }]);
		assert.equal(checkpoint.graph.purpose, "labels");
		assert.equal(checkpoint.graph.focus, "labels");
		assert.deepEqual(checkpoint.unfinished, []);
		assert.deepEqual(h.errors, []);
		assert.deepEqual(api.errors, []);
	} finally {
		await h?.runtime.dispose(); await daemon.stop(); await api.close(); rmSync(box.root, { recursive: true, force: true });
	}
});

test("v2's decision-model gate skips her model for a batch that changes nothing, and runs it when a change is possible", { timeout: 45000, skip: OVEN_AVAILABLE ? false : "Oven checkout unavailable; set OVEN_DIR." }, async () => {
	const api = await provider(), box = sandbox(api.url);
	const daemon = await startOven(box.root, box.agentDir);
	const { SidecarStore } = await import("../src/mom/sidecar.ts");
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	let commits = 0;
	try {
		h = await harness(box, undefined, { flags: { "mom-model": "fixture/fixture", "mom-mode": "v2", "mom-decider": "fixture-classifier/fixture-decider",
			"mom-interval-ms": "0", "mom-max-wait-ms": "0", "mom-retry-ms": "100,100,100" } });
		const first = "Please implement semantic map labels.", second = "Run the linter once more.", third = "Also add a dark mode toggle.", fourth = "Keep a note about the decision on the labels.";
		api.script(first, { text: "I will implement semantic map labels." });
		api.script(second, { text: "Ran the linter; nothing new." });
		api.script(third, { text: "I will add the toggle." });
		api.script(fourth, { text: "I will keep the decision with the labels." });
		api.onUnscripted(request => {
			const names: string[] = (request.tools ?? []).map((tool: any) => tool.function?.name);
			if (names.includes("mom_begin")) return { tool: { name: "mom_begin", arguments: {} } };
			commits++;
			const last = request.messages.findLast((message: any) => message.role === "tool")?.content;
			const body = JSON.parse(typeof last === "string" ? last : last.map((part: any) => part.text).join("\n"));
			const direction = (text: string) => body.newUserDirections?.find((d: any) => d.text === text)?.ref;
			if (!body.map.nodes.length) return { tool: { name: "commit_v2", arguments: { put: [{ id: "labels", parent: null, kind: "work", state: "active", label: "Implement semantic map labels", sources: [direction(first)] }], focus: "labels" } } };
			if (direction(third) && !body.map.nodes.some((node: any) => node.id === "dark")) return { tool: { name: "commit_v2", arguments: { put: [{ id: "dark", parent: "labels", kind: "work", state: "active", label: "Add a dark mode toggle", sources: [direction(third)] }], focus: "dark" } } };
			return { tool: { name: "commit_v2", arguments: {} } };
		});
		const manager = h.runtime.session.sessionManager;
		const records = () => new SidecarStore(() => h!.parent, manager.getSessionId()).load();
		const until = async <T>(what: string, read: () => Promise<T | undefined>) => {
			for (const deadline = Date.now() + 12000; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 25))) { const value = await read(); if (value) return value; }
			throw new Error(`Timed out waiting for ${what}: ${JSON.stringify({ errors: api.errors, commits, extensionErrors: h!.errors })}`);
		};
		const covered = () => until("Mom to cover the lead's latest entry", async () => (await records()).some(record => record.type === "map" && (record.data.cut ?? record.data.snapshot?.cut)?.parent === manager.getLeafId()) || undefined);
		const specLog = () => { try { return readFileSync(h!.parent.replace(/\.jsonl$/, "") + ".mom-decider", "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.kind === "v2-spec"); } catch { return []; } };

		// A first map is never gated: there is nothing to compare against.
		await h.runtime.session.prompt(first);
		await covered();
		assert.ok(commits >= 1);
		assert.deepEqual(specLog().map(({ skipped, ops, ran }) => ({ skipped, ops, ran })),
			[{ skipped: "no-checkpoint", ops: [], ran: true }], "a first map has no spec read and records why it bypassed one");

		// The fixture classifier answers every gate question 0.01: her model is not called for this batch.
		const before = commits;
		await h.runtime.session.prompt(second);
		await covered();
		assert.equal(commits, before, `a batch the decision model decides nothing about never reaches her model; spec log: ${JSON.stringify(specLog())}`);
		const reads = specLog().filter(entry => !entry.skipped && !entry.failOpen);
		assert.ok(reads.length >= 1 && reads.every(entry => entry.ran === false && Array.isArray(entry.ops) && entry.ops.length === 0),
			`spec log: ${JSON.stringify(specLog())}`);
		const snapshots = (await records()).filter(record => record.type === "map" && record.data.snapshot);
		assert.equal(snapshots.at(-1)!.data.snapshot.graph.nodes.length, 1, "a skipped batch saves coverage, not a new map");

		// A possible new work item runs her model, which records it.
		api.classify(request => request.questions?.new_work ? { new_work: { new_only: 0.9, new_and_existing: 0.05, existing_only: 0.03, report_only: 0.01, nothing: 0.01 } } : undefined);
		await h.runtime.session.prompt(third);
		await covered();
		const map = (await records()).findLast(record => record.type === "map" && record.data.snapshot)!.data.snapshot.graph;
		assert.deepEqual(map.nodes.map((node: any) => node.label), ["Implement semantic map labels", "Add a dark mode toggle"]);
		// The spec log line is written as the commit is finalized, after the map record that `covered` sees.
		const ranNew = () => specLog().filter(entry => entry.ran).some(entry => entry.changed === true && entry.ops.some((op: { kind: string }) => op.kind === "new_work"));
		await until("the spec read's log line", async () => ranNew() || undefined).catch(() => undefined);
		assert.ok(ranNew(), JSON.stringify(specLog().filter(entry => entry.ran)));

		// A permitted note that Mom's model omits must remain visible in the decision log.
		api.classify(request => ({
			...(request.questions?.new_work ? { new_work: { existing_only: 0.9 } } : {}),
			...(request.questions?.["attach__labels"] ? { attach__labels: { note: 0.9 } } : {}),
		}));
		await h.runtime.session.prompt(fourth);
		await covered();
		await until("the unmet note in the spec log", async () => specLog().at(-1)?.unmet || undefined).catch(() => undefined);
		assert.deepEqual(specLog().at(-1)?.unmet, ["labels: the spec asks for a note here, but the commit adds none"]);
		assert.deepEqual(h.errors, []);
		assert.deepEqual(api.errors, []);
	} finally {
		await h?.runtime.dispose(); await daemon.stop(); await api.close(); rmSync(box.root, { recursive: true, force: true });
	}
});
