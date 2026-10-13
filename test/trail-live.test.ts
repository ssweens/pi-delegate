import "./setup.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { provider, sandbox, harness, OVEN_AVAILABLE, startOven } from "./fixture.ts";

const FLAGS = { "mom-model": "fixture/fixture", "mom-mode": "trail", "mom-interval-ms": "0", "mom-max-wait-ms": "0", "mom-retry-ms": "100,100,100" };
const skip = OVEN_AVAILABLE ? false : "Oven checkout unavailable; set OVEN_DIR.";

/** The body of the last tool result her model was shown (mom_begin's body on the first slice request, a rejection after one). */
function lastToolText(request: any): string {
	const last = request.messages.findLast((message: any) => message.role === "tool")?.content;
	return typeof last === "string" ? last : last.map((part: any) => part.text).join("\n");
}

/** Her finalizer's results as her slice recorded them, oldest first: the entries table is where readStep reads them. */
async function finalizerResults(oven: any): Promise<{ text: string; isError?: boolean }[]> {
	const rows: { record: string }[] = await oven.storage.db.all("SELECT record FROM entries ORDER BY id");
	return rows.flatMap(row => (JSON.parse(row.record).model ?? []) as any[])
		.filter(message => message.role === "toolResult" && message.toolName === "record_waypoints")
		.map(message => ({ text: (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n"), isError: message.isError }));
}

const until = async <T>(what: string, read: () => Promise<T | undefined>, context: () => unknown, ms = 12000) => {
	for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise(resolve => setTimeout(resolve, 25))) { const value = await read(); if (value) return value; }
	throw new Error(`Timed out waiting for ${what}: ${JSON.stringify(context())}`);
};

test("trail Mom records a waypoint through Oven, repairs a rejected call once, and advances coverage without a graph", { timeout: 30000, skip }, async () => {
	const api = await provider(), box = sandbox(api.url);
	const daemon = await startOven(box.root, box.agentDir);
	const { SidecarStore } = await import("../src/mom/sidecar.ts");
	const { TrailStore, trailFile } = await import("../src/trail/store.ts");
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	const calls: unknown[] = [];
	let begun: any;
	try {
		h = await harness(box, undefined, { flags: FLAGS });
		const prompt = "Please implement semantic map labels.";
		api.script(prompt, { text: "I will implement semantic map labels." });
		api.onUnscripted(request => {
			const names: string[] = (request.tools ?? []).map((tool: any) => tool.function?.name);
			if (names.includes("mom_begin")) return { tool: { name: "mom_begin", arguments: {} } };
			// Trail mode hides commit_graph and commit_v2: only its own finalizer and the evidence tools are offered.
			assert.deepEqual(names.sort(), ["inspect_evidence", "record_waypoints"], "a trail operation offers only record_waypoints and evidence inspection: no history search");
			const result = lastToolText(request);
			if (!begun) begun = JSON.parse(result);
			const ref = begun.newUserDirections[0].ref;
			const waypoint = { kind: "set_out", line: "Semantic labels", title: " Semantic map labels ", caption: "The user asked for semantic labels on the map; work on them begins here." };
			// First call cites an invented source; the host must reject it naming the defect, and the repair must land.
			if (calls.length) { assert.match(result, /cites unobserved source invented:1/); assert.match(result, /resubmit once/); }
			const call = calls.length ? { waypoints: [{ ...waypoint, refs: [ref] }] } : { waypoints: [{ ...waypoint, refs: ["invented:1"] }] };
			calls.push(call);
			return { tool: { name: "record_waypoints", arguments: call } };
		});
		await h.runtime.session.prompt(prompt);
		const manager = h.runtime.session.sessionManager;
		const sessionId = manager.getSessionId();
		const context = () => ({ errors: api.errors, calls: calls.length, extensionErrors: h!.errors });
		const trail = () => new TrailStore(() => h!.parent, sessionId).load();
		const waypoints = await until("Mom to record a waypoint", async () => { const records = (await trail()).filter(record => record.type === "waypoint"); return records.length ? records : undefined; }, context);

		// The body her model read: the trail's own vocabulary, nothing of the graph's.
		assert.ok(typeof begun.task === "string" && begun.task.length > 0);
		assert.deepEqual(begun.trail, { lines: [], recent: [], open: [] }, "the first operation sees an empty trail");
		assert.ok(typeof begun.newUserDirections[0].ref === "string");
		assert.ok(!("map" in begun) && !("graph" in begun), "the trail body carries no map or graph");
		assert.equal(calls.length, 2);

		// Exactly one waypoint, pointing at the user's turn, on the lead's branch.
		const user = manager.getBranch().find((entry: any) => entry.type === "message" && entry.message.role === "user" && entry.message.content?.some((part: any) => part.text === prompt));
		assert.ok(user, "the lead's user entry is on its branch");
		assert.equal(waypoints.length, 1);
		const [recorded] = waypoints as any[];
		assert.equal(recorded.kind, "set_out");
		assert.equal(recorded.line, "Semantic labels");
		assert.equal(recorded.by, "mom");
		assert.deepEqual(recorded.refs, [`${sessionId}:${user!.id}`]);
		assert.match(recorded.id, /^[0-9a-f-]+:w0$/);
		assert.equal(typeof recorded.parent, "string");
		assert.equal(recorded.sessionId, sessionId);
		assert.equal(recorded.title, "Semantic map labels", "the title is kept, trimmed");
		assert.equal(recorded.at, Date.parse((user as any).timestamp), "a waypoint is timed by the user turn it cites, not by when it was indexed");
		assert.ok(existsSync(trailFile(h.parent)), "the trail lives beside the session file");

		// Coverage advanced in `.mom` as the graph-less cursor: a cut, no failure, and no snapshot.
		const records = await until("the coverage cursor", async () => { const all = await new SidecarStore(() => h!.parent, sessionId).load(); return all.some(record => record.type === "map") ? all : undefined; }, context);
		const maps = records.filter(record => record.type === "map");
		assert.ok(maps.length >= 1);
		const cursor = maps.find(record => record.data.cut && record.data.failure === null);
		assert.ok(cursor, `a map record carries the cut and no failure: ${JSON.stringify(maps)}`);
		assert.ok(!("snapshot" in cursor!.data), "coverage advanced without a graph snapshot");
		assert.ok(maps.every(record => !("snapshot" in record.data)), "no trail operation ever saves a graph snapshot");
		assert.equal(cursor!.data.cut.parent, manager.getLeafId(), "the cut covers the lead's latest entry");

		// Her finalizer's results, as her slice recorded them: one rejection, then the acceptance.
		const results = await until("the slice to record the acceptance", async () => { const all = await finalizerResults(daemon.oven); return all.some(result => !result.isError) ? all : undefined; }, context);
		assert.equal(results.length, 2, JSON.stringify(results));
		assert.ok(results[0].isError && /cites unobserved source invented:1/.test(results[0].text));
		assert.ok(!results[1].isError);
		assert.ok(results[1].text.startsWith("Trail saved."), results[1].text);
		assert.deepEqual(h.errors, []);
		assert.deepEqual(api.errors, []);
	} finally {
		await h?.runtime.dispose(); await daemon.stop(); await api.close(); rmSync(box.root, { recursive: true, force: true });
	}
});

test("an empty record_waypoints still advances trail coverage and writes no waypoint", { timeout: 30000, skip }, async () => {
	const api = await provider(), box = sandbox(api.url);
	const daemon = await startOven(box.root, box.agentDir);
	const { SidecarStore } = await import("../src/mom/sidecar.ts");
	const { TrailStore, trailFile } = await import("../src/trail/store.ts");
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	let calls = 0;
	try {
		h = await harness(box, undefined, { flags: FLAGS });
		const prompt = "Please implement semantic map labels.";
		api.script(prompt, { text: "I will implement semantic map labels." });
		api.onUnscripted(request => {
			const names: string[] = (request.tools ?? []).map((tool: any) => tool.function?.name);
			if (names.includes("mom_begin")) return { tool: { name: "mom_begin", arguments: {} } };
			assert.deepEqual(names.sort(), ["inspect_evidence", "record_waypoints"]);
			calls++;
			return { tool: { name: "record_waypoints", arguments: { waypoints: [] } } };
		});
		await h.runtime.session.prompt(prompt);
		const manager = h.runtime.session.sessionManager;
		const sessionId = manager.getSessionId();
		const context = () => ({ errors: api.errors, calls, extensionErrors: h!.errors });
		const cursor = await until("the coverage cursor", async () => (await new SidecarStore(() => h!.parent, sessionId).load())
			.find(record => record.type === "map" && record.data.cut && record.data.failure === null), context);
		assert.ok(!("snapshot" in cursor!.data), "coverage advanced without a graph snapshot");
		assert.equal(calls, 1, "an empty record is accepted first time");
		// Nothing worth finding again: no waypoint was written, whether or not the file exists.
		const waypoints = (await new TrailStore(() => h!.parent, sessionId).load()).filter(record => record.type === "waypoint");
		assert.deepEqual(waypoints, []);
		if (existsSync(trailFile(h.parent))) assert.equal(readFileSync(trailFile(h.parent), "utf8").trim(), "", "an existing trail file holds no records");
		const results = await until("the slice to record the acceptance", async () => { const all = await finalizerResults(daemon.oven); return all.length ? all : undefined; }, context);
		assert.deepEqual(results.map(result => ({ ok: !result.isError, saved: result.text.startsWith("Trail saved.") })), [{ ok: true, saved: true }]);
		assert.deepEqual(h.errors, []);
		assert.deepEqual(api.errors, []);
	} finally {
		await h?.runtime.dispose(); await daemon.stop(); await api.close(); rmSync(box.root, { recursive: true, force: true });
	}
});

test("a second trail batch is shown the first waypoint and links a learned to its line", { timeout: 45000, skip }, async () => {
	const api = await provider(), box = sandbox(api.url);
	const daemon = await startOven(box.root, box.agentDir);
	const { TrailStore } = await import("../src/trail/store.ts");
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	const bodies: any[] = [];
	let firstId: string | undefined;
	try {
		h = await harness(box, undefined, { flags: FLAGS });
		const first = "Please implement semantic map labels.", second = "The labels come from the node kinds, not the captions.";
		api.script(first, { text: "I will implement semantic map labels." });
		api.script(second, { text: "Noted: labels derive from node kinds." });
		api.onUnscripted(request => {
			const names: string[] = (request.tools ?? []).map((tool: any) => tool.function?.name);
			if (names.includes("mom_begin")) return { tool: { name: "mom_begin", arguments: {} } };
			assert.deepEqual(names.sort(), ["inspect_evidence", "record_waypoints"]);
			const body = JSON.parse(lastToolText(request));
			bodies.push(body);
			const direction = (text: string) => body.newUserDirections?.find((d: any) => d.text === text)?.ref;
			if (direction(first) && !body.trail.recent.length)
				return { tool: { name: "record_waypoints", arguments: { waypoints: [{ kind: "set_out", line: "Semantic labels", refs: [direction(first)], caption: "The user asked for semantic labels on the map." }] } } };
			if (direction(second)) {
				// The second batch is shown what the first wrote, so it can reuse the line and link to the id.
				assert.ok(firstId, "the first waypoint was recorded before the second batch");
				assert.equal(body.trail.recent[0]?.id, firstId, "the second batch sees the first waypoint");
				assert.equal(body.trail.lines[0]?.name, "Semantic labels");
				assert.equal(body.trail.lines[0]?.goal, "The user asked for semantic labels on the map.");
				return { tool: { name: "record_waypoints", arguments: { waypoints: [{ kind: "learned", line: "Semantic labels", refs: [direction(second)], caption: "Labels derive from node kinds rather than captions." }] } } };
			}
			// A batch of assistant chatter alone: nothing worth finding again.
			return { tool: { name: "record_waypoints", arguments: { waypoints: [] } } };
		});
		const manager = h.runtime.session.sessionManager;
		const sessionId = manager.getSessionId();
		const context = () => ({ errors: api.errors, bodies: bodies.length, extensionErrors: h!.errors });
		const waypoints = async () => (await new TrailStore(() => h!.parent, sessionId).load()).filter(record => record.type === "waypoint") as any[];
		const recorded = (count: number) => until(`${count} waypoint(s)`, async () => { const all = await waypoints(); return all.length >= count ? all : undefined; }, context);

		await h.runtime.session.prompt(first);
		const [opening] = await recorded(1);
		firstId = opening.id;
		assert.equal(opening.kind, "set_out");

		await h.runtime.session.prompt(second);
		const both = await recorded(2);
		assert.equal(both.length, 2);
		assert.equal(both[1].kind, "learned");
		assert.equal(both[1].line, "Semantic labels");
		assert.match(both[1].id, /^[0-9a-f-]+:w0$/);
		assert.notEqual(both[1].id.split(":")[0], firstId!.split(":")[0], "each batch's ids carry its own job");
		assert.ok(bodies.some(body => body.trail.recent[0]?.id === firstId), "a later batch was shown the first waypoint");
		assert.deepEqual(h.errors, []);
		assert.deepEqual(api.errors, []);
	} finally {
		await h?.runtime.dispose(); await daemon.stop(); await api.close(); rmSync(box.root, { recursive: true, force: true });
	}
});

test("caught up, untitled entries get a titling pass of their own; a detour carries what led to it", { timeout: 45000, skip }, async () => {
	const api = await provider(), box = sandbox(api.url);
	const daemon = await startOven(box.root, box.agentDir);
	const { TrailStore, trailFor } = await import("../src/trail/store.ts");
	const { glance } = await import("../src/trail/projection.ts");
	const { trailRows } = await import("../src/ui/trail-view.ts");
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	const bodies: any[] = [];
	try {
		h = await harness(box, undefined, { flags: FLAGS });
		const prompt = "Convert Hop to Werkit; OpenCode needs a receiver first.";
		api.script(prompt, { text: "Starting on the OpenCode receiver." });
		api.onUnscripted(request => {
			const names: string[] = (request.tools ?? []).map((tool: any) => tool.function?.name);
			if (names.includes("mom_begin")) return { tool: { name: "mom_begin", arguments: {} } };
			const body = JSON.parse(lastToolText(request));
			bodies.push(body);
			if (String(body.task).startsWith("Titling pass")) {
				assert.deepEqual(names.sort(), ["inspect_evidence", "record_waypoints"], "a titling pass finishes like any trail operation");
				assert.doesNotMatch(JSON.stringify((request.messages ?? []).filter((message: any) => message.role === "system")), /commit_labels/, "a titling pass keeps the trail's instructions, not the graph relabel's");
				// Sent as a JSON string, as mimo sends nested lists; the host decodes it like waypoints.
				return { tool: { name: "record_waypoints", arguments: { waypoints: [], titles: JSON.stringify(body.trail.untitled.map((entry: any) => ({ id: entry.id, title: entry.kind === "detour" ? "OpenCode receiver" : "Convert Hop to Werkit" }))) } } };
			}
			const ref = body.newUserDirections[0].ref;
			// Recorded the old way, with no titles; the detour names the finding that led to it by its index in this call.
			return { tool: { name: "record_waypoints", arguments: { waypoints: [
				{ kind: "set_out", line: "Werkit conversion", refs: [ref], caption: "Use Werkit as Hop's workflow, converting the repo to it." },
				{ kind: "learned", line: "Werkit conversion", refs: [ref], title: "OpenCode can't receive", caption: "OpenCode has no inbound delivery for message_thread." },
				{ kind: "detour", line: "opencode receiver", refs: [ref], from: "#1", caption: "Build an OpenCode receiver before the conversion goes on." },
			] } } };
		});
		await h.runtime.session.prompt(prompt);
		const manager = h.runtime.session.sessionManager, sessionId = manager.getSessionId();
		const context = () => ({ errors: api.errors, bodies: bodies.map(body => body.task), extensionErrors: h!.errors });
		const read = async () => trailFor(await new TrailStore(() => h!.parent, sessionId).load(), new Set(manager.getBranch().map((entry: any) => entry.id)));
		const trail = await until("the titling pass", async () => { const t = await read(); return t.waypoints.length === 2 && t.waypoints.every(w => w.title) ? t : undefined; }, context, 30000);
		const titling = bodies.find(body => String(body.task).startsWith("Titling pass"));
		assert.equal(titling.newEvents, "", "a titling pass reads no evidence");
		assert.deepEqual(titling.trail.untitled.map((entry: any) => entry.kind).sort(), ["detour", "set_out"], "the widget's untitled entries are offered; the titled finding is not");
		const [goal, detour] = trail.waypoints;
		const finding = (trail.entries ?? []).find(entry => entry.kind === "learned")!;
		assert.equal(detour!.from, finding.id, "#1 named the finding written in the same call");
		assert.deepEqual(trail.waypoints.map(w => w.title), ["Convert Hop to Werkit", "OpenCode receiver"]);
		assert.equal(goal!.caption, "Use Werkit as Hop's workflow, converting the repo to it.", "titling leaves the record itself unchanged");
		const plain = { fg: (_c: string, text: string) => text, bold: (text: string) => `*${text}*` } as any;
		assert.deepEqual(trailRows(glance(trail), plain, 100), ["◎ Convert Hop to Werkit", "  ↳ *OpenCode receiver*  ‹ OpenCode can't receive"], "tasks, and what led to the detour");
		assert.deepEqual(h.errors, []);
		assert.deepEqual(api.errors, []);
	} finally {
		await h?.runtime.dispose(); await daemon.stop(); await api.close(); rmSync(box.root, { recursive: true, force: true });
	}
});

test("/path reindex repairs the trail in one operation from its own entries, without re-reading the transcript", { timeout: 45000, skip }, async () => {
	const api = await provider(), box = sandbox(api.url);
	const daemon = await startOven(box.root, box.agentDir);
	const { TrailStore, trailFor } = await import("../src/trail/store.ts");
	const { glance } = await import("../src/trail/projection.ts");
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	const bodies: any[] = [];
	try {
		h = await harness(box, undefined, { flags: FLAGS });
		const prompt = "Run Werkit from Hop. Also agent rows must keep spawn order.";
		api.script(prompt, { text: "On it." });
		api.onUnscripted(request => {
			const names: string[] = (request.tools ?? []).map((tool: any) => tool.function?.name);
			if (names.includes("mom_begin")) return { tool: { name: "mom_begin", arguments: {} } };
			const body = JSON.parse(lastToolText(request));
			bodies.push(body);
			if (String(body.task).startsWith("Repair pass")) {
				const goalChange = body.trail.entries.find((entry: any) => entry.kind === "reframed");
				return { tool: { name: "record_waypoints", arguments: { waypoints: [], revise: JSON.stringify([{ id: goalChange.id, kind: "decided", title: "Spawn-order agent rows" }]) } } };
			}
			const ref = body.newUserDirections[0].ref;
			// Recorded under the old rules: a feature request filed as a goal change.
			return { tool: { name: "record_waypoints", arguments: { waypoints: [
				{ kind: "set_out", line: "Hop integration", refs: [ref], title: "Run Werkit from Hop", caption: "Run Werkit from Hop." },
				{ kind: "reframed", line: "Hop integration", refs: [ref], title: "Agent rows keep spawn order", caption: "Agent rows must keep spawn order." },
			] } } };
		});
		await h.runtime.session.prompt(prompt);
		const manager = h.runtime.session.sessionManager, sessionId = manager.getSessionId();
		const context = () => ({ errors: api.errors, bodies: bodies.map(body => body.task), extensionErrors: h!.errors });
		const read = async () => trailFor(await new TrailStore(() => h!.parent, sessionId).load(), new Set(manager.getBranch().map((entry: any) => entry.id)));
		await until("the first index", async () => (await read()).waypoints.length === 2 ? true : undefined, context, 20000);
		let notifications: string[] = [];
		const interactive = { ...h.ctx(), ui: { ...h.ctx().ui, notify: (text: string) => { notifications.push(text); } } };
		// Path may still be finishing the first index: the repair waits behind it rather than being refused.
		await h.commands.get("path").handler("reindex", interactive);
		assert.match(notifications[0]!, /^Path: repairing the trail/, "the command says at once that it started");
		assert.match(notifications.at(-1)!, /^Path: trail repaired/, "and how its run ended");
		notifications = [];
		await h.commands.get("path").handler("refresh", interactive);
		assert.deepEqual(notifications, ["Path: catching up on new activity…", "Path: caught up — nothing new for the trail."], "a refresh acknowledges and reports too");
		const repairs = bodies.filter(body => String(body.task).startsWith("Repair pass"));
		assert.equal(repairs.length, 1, "one operation");
		assert.equal(repairs[0].newEvents, "", "no transcript is read");
		assert.deepEqual(repairs[0].trail.entries.map((entry: any) => entry.kind), ["set_out", "reframed"], "the whole trail is shown");
		const trail = await read();
		assert.deepEqual(trail.waypoints.map(w => [w.kind, w.title]), [["set_out", "Run Werkit from Hop"], ["decided", "Spawn-order agent rows"]]);
		assert.equal(trail.struck.length, 1, "the replaced entry stays in the file, struck");
		assert.equal(glance(trail).tree!.goal.title, "Run Werkit from Hop", "the real goal is current again");
		assert.deepEqual(h.errors, []);
		assert.deepEqual(api.errors, []);
	} finally {
		await h?.runtime.dispose(); await daemon.stop(); await api.close(); rmSync(box.root, { recursive: true, force: true });
	}
});

test("with a decision model, a batch whose user turns do not steer skips the update model; one that steers runs it", { timeout: 60000, skip }, async () => {
	const api = await provider(), box = sandbox(api.url);
	const daemon = await startOven(box.root, box.agentDir);
	const { SidecarStore } = await import("../src/mom/sidecar.ts");
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	const bodies: any[] = [], asked: string[] = [];
	try {
		h = await harness(box, undefined, { flags: { ...FLAGS, "mom-decider": "fixture-classifier/fixture-decider" } });
		api.classify(request => {
			if (!request.questions?.steers) return undefined;
			const sent = String(request.state).split("The user then sent: ")[1] ?? "";
			asked.push(sent);
			return { steers: /switch to/i.test(sent) ? 2.7 : 0.1 };
		});
		const status = "How is it going so far?", steer = "Switch to the edge renderer now.";
		api.script(status, { text: "Going well." });
		api.script(steer, { text: "Switching." });
		api.onUnscripted(request => {
			const names: string[] = (request.tools ?? []).map((tool: any) => tool.function?.name);
			if (names.includes("mom_begin")) return { tool: { name: "mom_begin", arguments: {} } };
			const body = JSON.parse(lastToolText(request));
			bodies.push(body);
			const ref = body.newUserDirections.at(-1).ref;
			return { tool: { name: "record_waypoints", arguments: { waypoints: [{ kind: "set_out", line: "Edge renderer", refs: [ref], title: "Edge renderer", caption: "Switch to the edge renderer." }] } } };
		});
		const manager = h.runtime.session.sessionManager, sessionId = manager.getSessionId();
		const context = () => ({ errors: api.errors, asked, bodies: bodies.length, extensionErrors: h!.errors });
		const maps = async () => (await new SidecarStore(() => h!.parent, sessionId).load()).filter(record => record.type === "map" && record.data.cut);
		await h.runtime.session.prompt(status);
		await until("coverage of the routine turn", async () => (await maps()).length ? true : undefined, context, 20000);
		assert.equal(bodies.length, 0, "the update model was not asked about a status question");
		assert.deepEqual(asked, [status], "the decision model read the one user turn");
		await h.runtime.session.prompt(steer);
		await until("the steering turn's waypoint", async () => bodies.length ? true : undefined, context, 20000);
		assert.match(bodies[0].newEvents, /edge renderer/i);
		assert.ok(asked.includes(steer));
		assert.deepEqual(h.errors, []);
		assert.deepEqual(api.errors, []);
	} finally {
		await h?.runtime.dispose(); await daemon.stop(); await api.close(); rmSync(box.root, { recursive: true, force: true });
	}
});
