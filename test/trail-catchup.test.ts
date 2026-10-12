import "./setup.ts";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { provider, sandbox, harness, OVEN_AVAILABLE, startOven } from "./fixture.ts";

const FLAGS = { "mom-model": "fixture/fixture", "mom-mode": "trail", "mom-interval-ms": "0", "mom-max-wait-ms": "0", "mom-retry-ms": "100,100,100" };
const skip = OVEN_AVAILABLE ? false : "Oven checkout unavailable; set OVEN_DIR.";

const toolText = (request: any): string => {
	const last = request.messages.findLast((message: any) => message.role === "tool")?.content;
	return typeof last === "string" ? last : (last ?? []).map((part: any) => part.text).join("\n");
};
const until = async <T>(what: string, read: () => Promise<T | undefined> | T | undefined, context: () => unknown, ms = 40000) => {
	for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 25))) { const value = await read(); if (value) return value; }
	throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(context())}`);
};

const USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const filler = (tag: string) => `${tag} reply. ${"The work proceeded through the planned steps with careful notes. ".repeat(60)}`; // about 4k chars

async function catchUp(globalMode: boolean) {
	const api = await provider(), box = sandbox(api.url);
	const daemon = await startOven(box.root, box.agentDir);
	const { SidecarStore } = await import("../src/mom/sidecar.ts");
	const { TrailStore } = await import("../src/trail/store.ts");
	const { trailFor } = await import("../src/trail/store.ts");
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	const bodies: any[] = [];
	const inspects: { ref: string; text: string; isError: boolean }[] = [];
	const results: string[] = [];
	try {
		h = await harness(box, undefined, { flags: FLAGS });
		// The client folds `.mom` on the trail track only when the mode is saved (settings) or recorded; the flag alone reaches her slice, not the client.
		if (globalMode) { const { writeMomGlobals } = await import("../src/mom/globals.ts"); await writeMomGlobals({ mode: "trail" }); }
		const manager = h.runtime.session.sessionManager, sessionId = manager.getSessionId();
		const ids: Record<string, string> = {};
		const user = (tag: string, text: string) => { ids[tag] = manager.appendMessage({ role: "user", content: [{ type: "text", text: `${tag}: ${text}` }], timestamp: Date.now() } as any); };
		const assistant = (tag: string) => { ids[`${tag}-a`] = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: filler(tag) }], api: "openai-completions", provider: "fixture", model: "fixture", usage: USAGE, stopReason: "stop", timestamp: Date.now() } as any); };
		// Chapter 1: eight user turns of long replies (well over one 24,000-char window), then a compaction.
		for (let i = 1; i <= 8; i++) { user(`C1U${i}`, i === 1 ? "Please implement semantic map labels." : `Chapter one direction ${i}.`); assistant(`C1U${i}`); }
		ids.compaction1 = manager.appendCompaction("Chapter 1 summary.", ids["C1U8-a"], 1000);
		for (let i = 1; i <= 3; i++) { user(`C2U${i}`, i === 1 ? "Now switch to the edge renderer." : `Chapter two direction ${i}.`); assistant(`C2U${i}`); }
		ids.compaction2 = manager.appendCompaction("Chapter 2 summary.", ids["C2U3-a"], 1000);
		user("C3U1", "Back to the labels: derive them from node kinds.");
		assistant("C3U1");
		const live = "C3U2: Finally, ship the labels.";
		api.script(live, { text: "Shipping the labels." });
		// A waypoint the trail already holds for a chapter-two turn: the backfill that meets it must not repeat it.
		const { TrailStore: Store } = await import("../src/trail/store.ts");
		await new Store(() => h!.parent, sessionId).appendWaypoint({ id: "pre:w0", sessionId, at: Date.now(), kind: "decided", line: "Edge renderer", refs: [`${sessionId}:${ids.C2U2}`], caption: "Existing decision.", parent: null, by: "mom" } as any);

		const ref = (tag: string) => `${sessionId}:${ids[tag]}`;
		const nodeRefs = ["node:pre:w0", "pre:w0", "node:no-such-waypoint"];
		api.onUnscripted(request => {
			const names: string[] = (request.tools ?? []).map((tool: any) => tool.function?.name);
			if (names.includes("mom_begin")) return { tool: { name: "mom_begin", arguments: {} } };
			const tools = request.messages.filter((message: any) => message.role === "tool");
			const body = JSON.parse(toolText({ messages: tools.slice(0, 1) }));
			if (tools.length === 1) bodies.push(body);
			const backfill = String(body.task).startsWith("Backfill:");
			const events: string = body.newEvents;
			if (!backfill) {
				// The live operation: exercise inspect_evidence on waypoint ids before recording.
				if (tools.length <= nodeRefs.length) {
					if (tools.length > 1) { const last = tools[tools.length - 1].content; inspects.push({ ref: nodeRefs[tools.length - 2], text: typeof last === "string" ? last : last.map((p: any) => p.text).join(""), isError: Boolean(tools[tools.length - 1].isError) }); }
					return { tool: { name: "inspect_evidence", arguments: { ref: nodeRefs[tools.length - 1], offset: 0, limit: 2000 } } };
				}
				if (tools.length === nodeRefs.length + 1) { const last = tools[tools.length - 1]; inspects.push({ ref: nodeRefs[2], text: typeof last.content === "string" ? last.content : last.content.map((p: any) => p.text).join(""), isError: Boolean(last.isError) }); }
				return { tool: { name: "record_waypoints", arguments: { waypoints: [{ kind: "set_out", line: "Label derivation", refs: [ref("C3U1")], caption: "Derive map labels from node kinds." }] } } };
			}
			if (events.includes("C1U1:"))
				return { tool: { name: "record_waypoints", arguments: { waypoints: [{ kind: "set_out", line: "Map labels", refs: [ref("C1U1")], caption: "Implement semantic map labels." }] } } };
			// Chapter two: one new detour, and a decision the trail already holds (same kind, shared ref).
			return { tool: { name: "record_waypoints", arguments: { waypoints: [
				{ kind: "detour", line: "Edge renderer work", refs: [ref("C2U1")], caption: "Switch to the edge renderer." },
				{ kind: "decided", line: "Edge renderer", refs: [ref("C2U2")], caption: "Repeats the decision already on the trail." }] } } };
		});
		await h.runtime.session.prompt(live);
		const context = () => ({ errors: api.errors, bodies: bodies.length, extensionErrors: h!.errors });
		const sidecar = () => new SidecarStore(() => h!.parent, sessionId).load();
		const maps = async () => (await sidecar()).filter(record => record.type === "map") as any[];

		// 1. The first operation reads the newest chapter only.
		await until("the first operation", () => bodies.length ? true : undefined, context);
		const first = bodies[0];
		assert.ok(!String(first.task).startsWith("Backfill:"));
		assert.match(first.newEvents, /C3U1:/);
		assert.doesNotMatch(first.newEvents, /C1U\d:/, "chapter one's user turns are not in the live operation");
		assert.doesNotMatch(first.newEvents, /C2U\d:/, "chapter two's user turns are not in the live operation");
		const firstMap = await until("the first acceptance", async () => (await maps()).find(record => record.data.backfill), context);
		const branch = manager.getBranch();
		assert.deepEqual({ next: firstMap.data.backfill.next, through: firstMap.data.backfill.through, trail: firstMap.data.trail },
			{ next: branch[0].id, through: ids.compaction2, trail: true }, "backfill starts at the first lead entry and runs through the last compaction");
		assert.ok(firstMap.data.cut, "the coverage cursor is written together with the backfill range");

		// 2. With no new lead activity, the client drains the backfill: chapter one, then chapter two.
		await until("backfill to finish", async () => (await maps()).some(record => record.data.backfill === null) ? true : undefined, () => ({ ...context(), mom: readFileSync(h!.parent.replace(/\.jsonl$/, "") + ".mom", "utf8").split("\n").map(l => l.slice(0, 400)), trail: readFileSync(h!.parent.replace(/\.jsonl$/, "") + ".trail", "utf8") }) as any);
		const backfills = bodies.filter(body => String(body.task).startsWith("Backfill:"));
		assert.equal(backfills.length, 2, `chapter one then chapter two: ${backfills.length}`);
		assert.match(backfills[0].newEvents, /C1U1:/);
		assert.doesNotMatch(backfills[0].newEvents, /C2U\d:|C3U\d:/);
		assert.match(backfills[1].newEvents, /C2U1:/);
		assert.doesNotMatch(backfills[1].newEvents, /C1U\d:|C3U\d:/);
		const all = await maps();
		assert.equal(all.at(-1)!.data.backfill, null);
		const cuts = new Set(all.filter(record => record.data.cut).map(record => record.data.cut.parent));
		assert.equal(cuts.size, 1, "backfill never moves the live coverage cut");

		// 3. Trail: anchors, transcript order, no repeated waypoint.
		const trailRecords = (await new TrailStore(() => h!.parent, sessionId).load()).filter(record => record.type === "waypoint") as any[];
		for (const record of trailRecords.filter(record => record.id !== "pre:w0")) assert.equal(typeof record.anchor, "string", `anchor on ${record.id}`);
		const written = trailRecords.filter(record => record.id !== "pre:w0");
		assert.equal(written.find(record => record.line === "Map labels")?.anchor, ids.C1U1);
		assert.equal(written.find(record => record.line === "Label derivation")?.anchor, ids.C3U1);
		assert.equal(written.find(record => record.line === "Edge renderer work")?.anchor, ids.C2U1);
		const trail = trailFor(trailRecords as any, new Set(manager.getBranch().map((entry: any) => entry.id)));
		assert.deepEqual(trail.waypoints.map(w => w.caption), ["Implement semantic map labels.", "Switch to the edge renderer.", "Existing decision.", "Derive map labels from node kinds."],
			"transcript order: chapter one's set_out first even though it was written after chapter three's");
		const withRef = trailRecords.filter(record => record.kind === "decided" && record.refs.includes(ref("C2U2")));
		assert.equal(withRef.length, 1, "the repeated decision was not written again");

		// 4. Finalizer text and inspect_evidence.
		const finalizerResults = async () => {
			const rows: { record: string }[] = await daemon.oven.storage.db.all("SELECT record FROM entries ORDER BY id");
			return rows.flatMap(row => (JSON.parse(row.record).model ?? []) as any[]).filter(m => m.role === "toolResult" && m.toolName === "record_waypoints")
				.map(m => ({ isError: m.isError, text: (m.content ?? []).map((p: any) => p.text ?? "").join("\n") }));
		};
		const finals = await until("three finalizer results", async () => { const all = await finalizerResults(); return all.length >= 3 ? all : undefined; }, context);
		assert.ok(finals.every(result => !result.isError), JSON.stringify(finals));
		assert.ok(finals.some(result => /1 already on the trail, not repeated/.test(result.text)), JSON.stringify(finals));
		assert.equal(inspects.length, 3, JSON.stringify(inspects));
		for (const found of inspects.slice(0, 2)) { assert.ok(!found.isError, JSON.stringify(found)); assert.match(found.text, /Existing decision\./); assert.match(found.text, /"id":"pre:w0"/); }
		const inspectRows: { record: string }[] = await daemon.oven.storage.db.all("SELECT record FROM entries ORDER BY id");
		const inspected = inspectRows.flatMap(row => (JSON.parse(row.record).model ?? []) as any[]).filter(m => m.role === "toolResult" && m.toolName === "inspect_evidence");
		assert.deepEqual(inspected.map(m => Boolean(m.isError)), [false, false, true], "an unknown node ref is an error tool result; the operation still completed");
		assert.match(inspects[2].text, /No trail entry no-such-waypoint/);
		assert.deepEqual(h.errors, []);
		assert.deepEqual(api.errors, []);
	} finally {
		await h?.runtime.dispose(); await daemon.stop(); await api.close(); rmSync(box.root, { recursive: true, force: true });
	}
}

test("trail catch-up indexes the latest chapter first, then the client drains older chapters behind it", { timeout: 120000, skip }, () => catchUp(true));

// Known gap: with --mom-mode alone (nothing saved), MomClient.reload() calls loadState(store, manager) without the flag's mode,
// reads the graph track, never sees `backfill`/`coverageCut`, and drain() stops after the first round (src/mom/client.ts:229, 287).
test("flag-only trail mode drains the whole backfill without a manual refresh", { timeout: 120000, skip }, () => catchUp(false));
