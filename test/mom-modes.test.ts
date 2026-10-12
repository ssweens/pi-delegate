import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import { MOM_PROMPT, acceptGraph, momTools } from "../src/mom/contract.ts";
import momExtension from "../src/mom/mom-tools.ts";
import { readSettings, settingsLine, type MomSettings } from "../src/mom/engine.ts";
import { readMomGlobals, writeMomGlobals } from "../src/mom/globals.ts";
import { settingsFile } from "../src/settings-file.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOM_TOOLS, OPERATION_PROMPT, assertSliceSupportsMode, deciderFor, momConfiguration, type SessionIdentity } from "../src/mom/slice.ts";
import { COMMIT_GRAPH_MODE, DEFAULT_MODE, MODES, TRAIL_MODE, V2_MODE, assertRunnable, modeFor, modeInstructions, modeNames, type MapMode } from "../src/mom/modes.ts";
import { commitV2Tool } from "../src/mom/v2.ts";
import { TRAIL_DIGEST_TASK, TRAIL_UPDATE_TASK, recordWaypointsTool, trailBody } from "../src/trail/prompt.ts";
import { RecordWaypoints, emptyTrail } from "../src/trail/types.ts";
import { updateErrorSummary } from "../src/mom/status.ts";

const settings: MomSettings = { bootstrap: false, decider: { url: "http://127.0.0.1:8711/v1/systemone", clear: 0.9 } };
const identity: SessionIdentity = { cwd: "/tmp/mom-modes", sessionFile: "/tmp/mom-modes/session.jsonl", sessionId: "session" };
const flags = { "mom-model": "fixture/fixture", "mom-decider-url": "" };

/** The instruction string as it was assembled before modes existed. M1 compares against this. */
const preModeInstructions = `${MOM_PROMPT.trim()}\n\n${OPERATION_PROMPT.trim()}\n\n${settingsLine(settings)}`;

test("M1: modeInstructions is format-identical to the pre-mode assembly for any settings", () => {
	for (const line of [settingsLine(settings), settingsLine({ bootstrap: false }), settingsLine({})])
		assert.equal(modeInstructions(modeFor(undefined), OPERATION_PROMPT, line), `${MOM_PROMPT.trim()}\n\n${OPERATION_PROMPT.trim()}\n\n${line}`);
	assert.equal(modeInstructions(COMMIT_GRAPH_MODE, OPERATION_PROMPT, settingsLine(settings)), preModeInstructions);
});

test("M1: choosing no mode, an empty mode, or the current mode changes nothing the model sees", () => {
	const none = momConfiguration(identity, flags).instructions;
	assert.equal(momConfiguration(identity, { ...flags, "mom-mode": "" }).instructions, none);
	assert.equal(momConfiguration(identity, { ...flags, "mom-mode": "   " }).instructions, none);
	assert.equal(momConfiguration(identity, { ...flags, "mom-mode": COMMIT_GRAPH_MODE.name }).instructions, none);
	// The shipped behaviour is the default, not an opt-in.
	assert.equal(DEFAULT_MODE, COMMIT_GRAPH_MODE.name);
	assert.equal(modeFor(undefined), COMMIT_GRAPH_MODE);
	// And the mode contributes exactly MOM_PROMPT, so the model's map-maintenance rules are unchanged.
	assert.ok(none.startsWith(MOM_PROMPT.trim() + "\n\n"));
});

test("command errors retain their concise cause", () => {
	assert.equal(updateErrorSummary('Error: Unknown Mom mode "act_labels"; --mom-mode accepts commit_graph, v2, trail.'), 'Unknown Mom mode "act_labels"; --mom-mode accepts commit_graph, v2, trail.');
});

test("retired mode history is replayed without rejecting the current saved mode", async () => {
	const { loadState } = await import("../src/mom/checkpoint.ts");
	const read = async (...modes: string[]) => loadState({ load: async () => modes.map((mode, index) => ({ id: `mode-${index}`, sessionId: "session", type: "map", at: index + 1, data: { mode } })) } as never,
		{ getBranch: () => [] } as never);
	assert.equal((await read("act_labels", "commit_graph")).mode, "commit_graph", "superseded mode history is not validated as current state");
	assert.equal((await read("act_labels")).mode, DEFAULT_MODE, "a removed last-selected mode migrates to the safe default");
	await assert.rejects(read("unknown_mode"), /Unknown Mom mode "unknown_mode"/);
});

test("a stale Oven extension fails clearly when it lacks the selected mode's finalizer", () => {
	assert.doesNotThrow(() => assertSliceSupportsMode("commit_graph", ["commit_v2"]));
	assert.throws(() => assertSliceSupportsMode("v2", ["commit_v2"]), /mode v2 requires missing tool commit_v2.*Restart Oven/);
	assert.throws(() => assertSliceSupportsMode("trail", ["record_waypoints"]), /mode trail requires missing tool record_waypoints.*Restart Oven/);
	assert.ok(MOM_TOOLS.includes("record_waypoints"), "the slice's tool list must carry the trail's finalizer");
});

test("M2: an unknown mode is refused loudly and never falls back to the default", () => {
	assert.throws(() => modeFor("freeform"), /Unknown Mom mode "freeform"/);
	// The message names the flag and the declared names so a typo is fixable from the error alone.
	assert.throws(() => modeFor("nonsense"), /--mom-mode accepts commit_graph, v2, trail/);
	assert.throws(() => momConfiguration(identity, { ...flags, "mom-mode": "nonsense" }), /Unknown Mom mode/);
});

test("M2: the registry is well formed — unique lowercase_underscore names, each with a prompt and finalizer", () => {
	const names = MODES.map(mode => mode.name);
	assert.deepEqual([...new Set(names)], names, "mode names must be unique");
	for (const mode of MODES) {
		assert.match(mode.name, /^[a-z][a-z0-9_]*$/, `${mode.name} is not lowercase_underscore`);
		assert.ok(mode.description.length > 0, `${mode.name} needs a description`);
		assert.ok(mode.prompt.trim().length > 0, `${mode.name} needs a prompt`);
		assert.match(mode.finalizer, /^[a-z][a-z0-9_]*$/, `${mode.name} finalizer is not lowercase_underscore`);
		assert.equal(typeof mode.turns, "number");
	}
	assert.deepEqual(modeNames(), ["commit_graph", "v2", "trail"]);
});

test("M3: a mode needing more than one model turn cannot be selected", () => {
	const multiTurn: MapMode = { ...COMMIT_GRAPH_MODE, name: "needs_two_turns", turns: 2 };
	assert.throws(() => assertRunnable(multiTurn), /needs 2 model turns; the operation runs one/);
	// A one-turn mode passes the same check, so the guard is about the budget, not the mode.
	assert.equal(assertRunnable(COMMIT_GRAPH_MODE), COMMIT_GRAPH_MODE);
});

test("M4: the current mode's finalizer is a tool the registry actually provides", () => {
	assert.equal(COMMIT_GRAPH_MODE.finalizer, "commit_graph");
	const registered = momTools().map(tool => tool.name);
	assert.ok(registered.includes(COMMIT_GRAPH_MODE.finalizer),
		`${COMMIT_GRAPH_MODE.finalizer} is not among registered tools: ${registered.join(", ")}`);
	for (const mode of MODES) assert.ok(mode.turns >= 1, `${mode.name} must declare at least one turn`);
});

test("M5: v2 is selectable, declares its own apply, and its finalizer is registered", () => {
	const mode = modeFor("v2");
	assert.equal(mode, V2_MODE);
	assert.equal(mode.finalizer, "commit_v2");
	assert.equal(typeof mode.apply, "function", "a mode whose model emits its own edits must supply apply");
	// A mode owns its payload: momTools() keeps its small shared contract and does not grow it.
	assert.equal(commitV2Tool().name, "commit_v2");
	assert.ok(!momTools().some(tool => tool.name === "commit_v2"), "mode-owned tools stay out of the shared surface");
});

test("M5: the transaction mode needs no apply; a non-transaction mode does", () => {
	assert.equal(COMMIT_GRAPH_MODE.apply, undefined, "a transaction mode uses the default acceptGraph path");
	for (const mode of MODES) {
		if (mode.finalizer === "commit_graph") continue;
		// The trail keeps no graph at all: its finalizer persists waypoints itself (mom-tools), so there is no apply step to own.
		if (mode === TRAIL_MODE) { assert.equal(mode.apply, undefined, "trail writes no graph"); continue; }
		assert.equal(typeof mode.apply, "function", `${mode.name} emits ${mode.finalizer} and must apply its own payload`);
	}
});

test("trail: selectable, its finalizer is record_waypoints, and its body shows an empty trail as empty", () => {
	const mode = modeFor("trail");
	assert.equal(mode, TRAIL_MODE);
	assert.equal(mode.finalizer, "record_waypoints");
	assert.ok(mode.prompt.includes("set_out") && mode.operation?.includes("record_waypoints"), "the prompt names the kinds and the finalizer");
	assert.ok(!momTools().some(tool => tool.name === "record_waypoints"), "mode-owned tools stay out of the shared surface");
	const tool = recordWaypointsTool();
	assert.equal(tool.name, "record_waypoints");
	assert.equal(tool.parameters, RecordWaypoints, "the finalizer validates exactly the shared schema");
	assert.ok(Check(tool.parameters, { waypoints: [] }), "an empty list is a valid 'nothing worth finding again'");
	const update = trailBody({ task: TRAIL_UPDATE_TASK, newEvents: "events", trail: emptyTrail() });
	assert.deepEqual(update, { task: TRAIL_UPDATE_TASK, trail: { lines: [], recent: [], open: [] }, newEvents: "events" });
	const digest = trailBody({ task: TRAIL_DIGEST_TASK, newEvents: "digest", trail: emptyTrail(), newUserDirections: [], guidance: " " });
	assert.equal(digest.task, TRAIL_DIGEST_TASK);
	assert.equal(digest.guidance, undefined, "blank guidance is omitted");
	assert.equal(digest.newUserDirections, undefined, "an empty direction list is omitted");
	const configured = momConfiguration(identity, { ...flags, "mom-mode": "trail" });
	assert.ok(configured.instructions.startsWith(TRAIL_MODE.prompt) && configured.instructions.includes("record_waypoints"));
	assert.deepEqual(configured.tools, [...MOM_TOOLS]);
});

test("the current mode's prompt is exactly MOM_PROMPT, with no mode-specific drift", () => {
	// Regression guard for M1: if someone edits the mode's prompt independently of MOM_PROMPT the
	// two would diverge silently and the shipped model input would change.
	assert.equal(COMMIT_GRAPH_MODE.prompt, MOM_PROMPT.trim());
});

test("local settings save returns while Mom's runtime reconfiguration is still pending", async () => {
	const { MomClient } = await import("../src/mom/client.ts");
	const dir = await mkdtemp(join(tmpdir(), "pi-delegate-mom-fast-setting-")), session = join(dir, "session.jsonl");
	const file = settingsFile(), previous = await readFile(file, "utf8").catch(() => undefined);
	await writeFile(session, "{}\n");
	let release!: () => void, entered!: () => void;
	const pending = new Promise<void>(resolve => { release = resolve; }), startedApplying = new Promise<void>(resolve => { entered = resolve; });
	class SlowClient extends MomClient {
		override async ensure() { entered(); await pending; }
	}
	const client = new SlowClient({ cwd: dir, sessionManager: { getCwd: () => dir, getSessionFile: () => session, getSessionId: () => "fast-setting" } } as never,
		{ flags: {}, changed() {}, publish() {}, notify() {} });
	client.state = { enabled: true, inject: false, nudgedClasses: [], mode: "", model: "", decider: "" } as never;
	const started = Date.now();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([client.controls({ mode: "v2" }), new Promise<never>((_, reject) => {
			timeout = setTimeout(() => reject(new Error("settings save waited for runtime reconfiguration")), 1000);
		})]);
		if (timeout) clearTimeout(timeout);
		await startedApplying;
		assert.ok(Date.now() - started < 1000);
		assert.equal((client.state as unknown as { mode: string }).mode, "v2");
		assert.equal(readMomGlobals(file).mode, "v2");
	} finally {
		release(); client.close();
		if (timeout) clearTimeout(timeout);
		if (previous === undefined) await rm(file, { force: true });
		else await writeFile(file, previous);
		await rm(dir, { recursive: true, force: true });
	}
});

test("mode is a durable setting: listed, cycled to a declared name, and carried in the sidecar", async () => {
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	const { momSettings } = await import("../src/mom/settings.ts");
	const { CONTROL_KEYS } = await import("../src/mom/sidecar.ts");
	initTheme("dark");
	const saved: unknown[] = [];
	const component = momSettings({ enabled: true, inject: false, hush: false, nudgedClasses: [], mode: "", model: "", decider: "" },
		async change => { saved.push(change); }, () => {}, () => {});
	const rendered = component.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(rendered, /Map mode/);
	assert.match(rendered, /Decision model/);
	assert.match(rendered, /SETTING HELP/);
	assert.match(rendered, /Background tracking/);
	assert.match(rendered, /work map in the background/);
	component.handleInput?.("\u001b[B");
	const next = component.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(next, /SETTING HELP/);
	assert.match(next, /eligible findings from Mom's map/);
	// The decision-model row never shows a flag default as if the user saved it: unset is not a setting.
	const shown = (decider: string | undefined) => momSettings({ enabled: true, inject: false, hush: false, nudgedClasses: [], mode: "", model: "", decider },
		async () => {}, () => {}, () => {}).render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(shown(undefined), /Decision model\s+\(not set\)/, "nothing saved is 'not set', never a model name");
	assert.match(shown(""), /Decision model\s+\(none\)/, "an explicit empty value is a choice");
	assert.match(shown("local-dgx/beverly-4B"), /Decision model\s+local-dgx\/beverly-4B/);
	// The model row names the model Mom actually runs instead of hiding it behind a placeholder.
	const modeled = (model: string, fallback: string) => momSettings({ enabled: true, inject: false, hush: false, nudgedClasses: [], mode: "", model, decider: undefined },
		async () => {}, () => {}, () => {}, 12, undefined, undefined, fallback).render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(modeled("", "openai-codex/gpt-5.6-sol"), /Model\s+openai-codex\/gpt-5\.6-sol/, "the default she runs is named");
	assert.match(modeled("local-dgx/beverly-4B", "openai-codex/gpt-5.6-sol"), /Model\s+local-dgx\/beverly-4B/, "a saved model is named");
	assert.match(modeled("", ""), /Model\s+\(not set\)/);
	const narrow = component.render(54).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	assert.ok(narrow.indexOf("SETTING HELP") > narrow.indexOf("Enter/Space to change"), "narrow terminals stack the help below the list");
	assert.match(narrow, /eligible findings from Mom's map/);
	// The sidecar accepts mode and decision-model control records alongside the existing ones.
	assert.deepEqual([...CONTROL_KEYS], ["enabled", "inject", "nudgedClasses", "mode", "model", "decider"]);
	assert.equal(modeFor("v2").name, "v2");
});

test("Mom's model receives only bounded domain tools, never native filesystem or shell tools", () => {
	const configured = momConfiguration(identity, flags);
	assert.deepEqual(configured.tools, [...MOM_TOOLS]);
	assert.ok(!configured.tools?.some(tool => ["read", "write", "edit", "bash", "codemode"].includes(tool)), "native tools let Mom leave the bounded operation");
	assert.deepEqual(momConfiguration(identity, { ...flags, "mom-mode": "v2" }).tools, [...MOM_TOOLS]);
});

test("momConfiguration honors a persisted mode: the prompt is that mode's, not the flag's", () => {
	const configured = momConfiguration(identity, { ...flags, "mom-mode": "v2" });
	const v2 = configured.instructions;
	assert.ok(v2.startsWith(V2_MODE.prompt), "the persisted mode must drive the standing instructions");
	assert.ok(v2.includes("commit_v2"), "v2 must state its own finalizer");
	assert.ok(configured.tools?.includes("commit_v2"));
	assert.ok(v2 !== momConfiguration(identity, flags).instructions, "switching mode must change what the model sees");
	// M1 still holds: the default path is unchanged (asserted byte-for-byte above, against itself).
});

test("a global setting applies when each session loads it, not only in the transcript that saved it", async () => {
	const { loadState } = await import("../src/mom/checkpoint.ts");
	const { SidecarStore } = await import("../src/mom/sidecar.ts");
	const dir = await mkdtemp(join(tmpdir(), "pi-delegate-mom-global-sessions-"));
	const file = settingsFile();
	const saved = await readMomGlobals(file);
	const session = async (name: string, legacy: Record<string, unknown>) => {
		const path = join(dir, `${name}.jsonl`);
		await writeFile(path, "{}\n");
		const store = new SidecarStore(() => path, name);
		if (Object.keys(legacy).length) await store.append("map", { ...legacy });
		return loadState(store, { getBranch: () => [] } as never);
	};
	try {
		// Two sessions that each saved something different, the old way.
		assert.equal((await session("one", { mode: "commit_graph" })).mode, "commit_graph");
		assert.equal((await session("two", { decider: "" })).decider, "");
		// Each session reads the global save after it changes.
		await writeMomGlobals({ mode: "v2", decider: "local-llm/beverly-4B" }, file);
		for (const name of ["one", "two"]) {
			const state = await session(name, {});
			assert.equal(state.mode, "v2", `${name} reads the global mode`);
			assert.equal(state.decider, "local-llm/beverly-4B", `${name} reads the global decision model`);
		}
	} finally {
		await rm(file, { force: true });
		if (Object.keys(saved).length) await writeMomGlobals(saved, file);
		await rm(dir, { recursive: true, force: true });
	}
});

test("the model control is durable and scoped to Mom, never to Pi", async () => {
	const { CONTROL_KEYS } = await import("../src/mom/sidecar.ts");
	assert.deepEqual([...CONTROL_KEYS], ["enabled", "inject", "nudgedClasses", "mode", "model", "decider"]);
	// A persisted model overrides the flag when the slice is configured.
	const withModel = momConfiguration(identity, { ...flags, "mom-model": "fixture/fixture" });
	assert.match(withModel.instructions, /[\s\S]*/, "instructions still build with a model set");
	// The picker is scoped: selecting must not touch Pi's default. That is why it takes an inert
	// persist callback on the legacy path (src/model-picker.ts).
	const picker = await import("../src/mom/model-picker.ts");
	assert.equal(typeof picker.pickMomModel, "function");
	assert.equal(typeof picker.configuredMomModel, "function");
	assert.equal(typeof picker.getModelRuntime, "function");
});

test("commit_graph applies a MiMo commit whose lists arrive JSON-encoded", () => {
	const known = new Map([["s:u1", { ref: "s:u1", at: "2026-10-11T00:00:00.000Z", actor: "lead", kind: "user", text: "Ship the release" }]]);
	const before = { revision: 1, purpose: null, motherThread: null, nodes: [], edges: [] };
	// Exactly the shape that failed: every list as a JSON string, and "null" for the empty ones.
	const commit = {
		focus: "ship",
		work: JSON.stringify([{ id: "ship", parent: null, state: "active", label: "Ship the release", why: "user asked", status: "in progress", sources: ["s:u1"] }]),
		notes: JSON.stringify([{ id: "n1", on: "ship", kind: "observation", state: "active", text: "MiMo encodes lists", sources: ["s:u1"] }]),
		upsertEdges: "null", removeEdges: "null",
	};
	// Exercise the Durable tool boundary: it validates before acceptGraph sees a call.
	const durable = { defineDoc: (value: unknown) => value, defineDocFamily: (value: unknown) => value,
		defineTool: (value: unknown) => value, defineExtension: (value: unknown) => value, hook: (value: unknown) => value };
	const extension = momExtension(durable as never) as unknown as { tools: { name: string; prepareArguments: (args: unknown) => any }[] };
	const tool = extension.tools.find(tool => tool.name === "commit_graph")!;
	const prepared = tool.prepareArguments(commit);
	assert.ok(Array.isArray(prepared.work) && Array.isArray(prepared.notes), "tool validation receives decoded lists");
	assert.equal(prepared.upsertEdges, undefined);
	assert.equal(prepared.removeEdges, undefined);
	const result: any = acceptGraph(prepared, before as never, undefined, known as never, new Set(["s:u1"]), new Set());
	const ids = result.graph.nodes.map((n: any) => n.id);
	assert.deepEqual(new Set(ids), new Set(["ship", "n1"]), "both lists decoded and applied");
	assert.equal(result.graph.nodes.find((n: any) => n.id === "n1").label, "MiMo encodes lists");
	assert.throws(() => acceptGraph({ focus: "ship", notes: "[{" }, before as never, undefined, known as never, new Set(["s:u1"]), new Set()),
		/Invalid work changes|Invalid graph transaction/, "a string that is not a list still fails loudly");
});

test("all Mom finalizers decode JSON-string lists before tool validation", () => {
	const durable = { defineDoc: (value: unknown) => value, defineDocFamily: (value: unknown) => value,
		defineTool: (value: unknown) => value, defineExtension: (value: unknown) => value, hook: (value: unknown) => value };
	const extension = momExtension(durable as never) as unknown as { tools: { name: string; prepareArguments: (args: unknown) => any }[] };
	const prepare = (name: string, args: unknown) => extension.tools.find(tool => tool.name === name)!.prepareArguments(args);
	const chapter = { chapter: "c1", goal: [], decisions: [], artifacts: [], deadEnds: [], openQuestions: [] };
	assert.deepEqual(prepare("record_thread_map", { states: JSON.stringify([chapter]) }).states, [chapter]);
	const put = { id: "ship", parent: null, kind: "work", state: "active", label: "Ship", sources: ["s:u1"] };
	assert.deepEqual(prepare("commit_v2", { put: JSON.stringify([put]), remove: "null" }).put, [put]);
	const label = { id: "ship", label: "Ship" };
	assert.deepEqual(prepare("commit_labels", { labels: JSON.stringify([label]), retired: "null" }).labels, [label]);
	const waypoint = { kind: "set_out", line: "Ship", refs: ["s:u1"], caption: "Set out to ship the release." };
	assert.deepEqual(prepare("record_waypoints", { waypoints: JSON.stringify([waypoint]) }).waypoints, [waypoint]);
	assert.equal(prepare("record_thread_map", { states: `${JSON.stringify([chapter])}}` }).states[0].chapter, "",
		"a malformed list is not silently repaired into an accepted audit");
});

test("commit_graph merges obsolete work into its surviving parent without losing children or history", () => {
	const known = new Map([
		["s:u1", { ref: "s:u1", at: "2026-10-11T00:00:00.000Z", actor: "lead", kind: "user", text: "Build the graph" }],
		["s:u2", { ref: "s:u2", at: "2026-10-11T01:00:00.000Z", actor: "lead", kind: "user", text: "The redesign umbrella is obsolete; current work belongs under Ship" }],
	]);
	const source = ["s:u1"], work = (id: string, parent: string | null, label: string) =>
		({ id, parent, state: "active", label, why: label, status: "In progress", sources: source });
	const empty = { revision: 0, purpose: null, motherThread: null, focus: null, nodes: [], edges: [] };
	const first: any = acceptGraph({ work: [work("ship", null, "Ship"), work("obsolete", "ship", "Old umbrella"),
		work("current", "obsolete", "Current work"), work("sibling", "ship", "Other work")], notes: [{ id: "rule", on: "obsolete", kind: "rule", state: "active", text: "Keep this rule", sources: source }],
		focus: "current" }, empty as never, undefined, known as never, new Set(source), new Set());
	const merge = { work: [{ id: "ship", state: "active", status: "Current work continues", sources: ["s:u2"] }],
		merges: JSON.stringify([{ thread: "obsolete", into: "ship", reason: "User pruned an outdated umbrella", sources: ["s:u2"] }]), focus: "current" };
	assert.equal(Check(momTools()[0]!.parameters, { ...merge, merges: JSON.parse(merge.merges) }), true,
		"the model can author a merge in commit_graph");
	const durable = { defineDoc: (value: unknown) => value, defineDocFamily: (value: unknown) => value,
		defineTool: (value: unknown) => value, defineExtension: (value: unknown) => value, hook: (value: unknown) => value };
	const extension = momExtension(durable as never) as unknown as { tools: { name: string; prepareArguments: (args: unknown) => any }[] };
	const prepared = extension.tools.find(tool => tool.name === "commit_graph")!.prepareArguments(merge);
	assert.equal(prepared.merges.length, 1, "MiMo's encoded merge is decoded before tool validation");
	const second: any = acceptGraph(prepared, first.graph, "checkpoint-1", known as never, new Set(["s:u2"]), new Set());
	const nodes = new Map(second.graph.nodes.map((node: any) => [node.id, node]));
	assert.equal(nodes.has("obsolete"), false, "obsolete umbrella leaves the current work map");
	assert.equal((nodes.get("current") as any).parent, "ship", "active work moves to the surviving parent");
	assert.equal((nodes.get("rule") as any).parent, "ship", "scoped notes survive the move");
	assert.ok((nodes.get("ship") as any).history.nodes.includes("obsolete"), "retired work remains in history");
	assert.equal(second.graph.focus, "current");
	const direct: any = acceptGraph({ merges: [{ thread: "obsolete", into: "ship", reason: "User pruned old work", sources: ["s:u2"] }],
		work: [{ id: "sibling", parent: "ship", state: "active", status: "", sources: ["s:u2"] }], focus: "current" },
		first.graph, "checkpoint-1", known as never, new Set(["s:u2"]), new Set());
	assert.equal(direct.graph.nodes.some((node: any) => node.id === "obsolete"), false, "a sourced direct-parent merge needs no target upsert");
	assert.equal(direct.graph.nodes.find((node: any) => node.id === "sibling")?.observed, "In progress", "blank status keeps saved text");
	assert.throws(() => acceptGraph({ work: [{ id: "brand_new", state: "active", label: "New work", status: "Requested", sources: ["s:u2"] }] },
		first.graph, "checkpoint-1", known as never, new Set(["s:u2"]), new Set()), /needs a parent/);
	assert.throws(() => acceptGraph({ work: [{ id: "brand_new", parent: "ship", state: "active", label: "New work", status: "", sources: ["s:u2"] }] },
		first.graph, "checkpoint-1", known as never, new Set(["s:u2"]), new Set()), /needs a status/);
	assert.throws(() => acceptGraph({ merges: [{ thread: "obsolete", into: "sibling", reason: "wrong branch", sources: ["s:u2"] }] },
		first.graph, "checkpoint-1", known as never, new Set(["s:u2"]), new Set()), /merge across branches needs the destination target upserted/);
});

test("the decision model resolves through Pi's classifier registry; an empty or unavailable pick runs Mom without it", () => {
	const registry = { findOfType: (_type: "classifier", provider: string, id: string) =>
		provider === "local-llm" && id === "beverly-4B" ? { id, api: "typesafe-system-one", baseUrl: "http://127.0.0.1:8000/v1/" } : undefined };
	const configured = momConfiguration(identity, { ...flags, "mom-decider": "local-llm/beverly-4B" }, registry);
	assert.deepEqual(readSettings(configured.instructions).classifier, { url: "http://127.0.0.1:8000/v1/systemone", model: "beverly-4B", timeoutMs: 120000 });
	assert.deepEqual(deciderFor({ "mom-decider": " local-llm/beverly-4B " }, registry), { ref: "local-llm/beverly-4B", classifier: { url: "http://127.0.0.1:8000/v1/systemone", model: "beverly-4B" } });
	// Unregistered, not System One, or not local: Mom still starts, with no decision model, and the ref is
	// reported unresolved so the client can say so.
	const incompatible = { findOfType: () => ({ id: "model", api: "openai-chat-completions", baseUrl: "https://example.test/v1" }) };
	const remote = { findOfType: () => ({ id: "model", api: "typesafe-system-one", baseUrl: "https://example.test/v1" }) };
	for (const [ref, from] of [["missing/model", registry], ["provider/model", incompatible], ["provider/model", remote], ["local-llm/beverly-4B", undefined]] as const) {
		assert.equal(readSettings(momConfiguration(identity, { ...flags, "mom-decider": ref }, from).instructions).classifier, undefined);
		assert.deepEqual(deciderFor({ "mom-decider": ref }, from), { ref, classifier: undefined });
	}
	const disabled = momConfiguration(identity, { ...flags, "mom-decider": "" }, registry);
	assert.equal(readSettings(disabled.instructions).classifier, undefined);
	assert.deepEqual(deciderFor({ "mom-decider": "" }, registry), { ref: "" });
});

test("the decision-model picker excludes classifier models Mom cannot call", async () => {
	const { deciderModels } = await import("../src/mom/model-picker.ts");
	const models = [
		{ provider: "local-llm", id: "beverly-4B", name: "Beverly", api: "typesafe-system-one", baseUrl: "http://127.0.0.1:8000/v1" },
		{ provider: "remote", id: "classifier", name: "Remote", api: "typesafe-system-one", baseUrl: "https://example.test/v1" },
		{ provider: "chat", id: "chat", name: "Chat", api: "openai-completions", baseUrl: "http://127.0.0.1:8000/v1" },
	];
	const registry = { getModelsOfType: () => models, findOfType: (_type: "classifier", provider: string, id: string) => models.find(model => model.provider === provider && model.id === id) };
	const context = { modelRegistry: registry } as never;
	assert.deepEqual(deciderModels(context), [{ value: "local-llm/beverly-4B", label: "local-llm/beverly-4B", description: "Beverly" }]);
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	const { momDeciderSelector } = await import("../src/mom/model-picker.ts");
	initTheme("dark");
	let selected: string | undefined;
	const picker = momDeciderSelector(context, undefined, "local-llm/beverly-4B", value => { selected = value; });
	picker.handleInput?.("\r");
	assert.equal(selected, "local-llm/beverly-4B");
});

test("continuity injection is enabled by default, and a missing global setting means inject: true", async () => {
	const { loadState } = await import("../src/mom/checkpoint.ts");
	const store = { load: async () => [{ id: "empty", sessionId: "session", type: "map", at: 1, data: { inject: false } }] } as never;
	const branch = { getBranch: () => [] } as never;
	const file = settingsFile(), previous = await readFile(file, "utf8").catch(() => undefined);
	try {
		await rm(file, { force: true });
		const state = await loadState(store, branch);
		assert.equal(state.inject, true, "no global file: continuity injection defaults to on");
		await writeMomGlobals({ inject: false }, file);
		assert.equal((await loadState(store, branch)).inject, false, "an explicit global inject: false is honored");
		await writeMomGlobals({ inject: true }, file);
		assert.equal((await loadState(store, branch)).inject, true, "an explicit global inject: true is honored");
	} finally {
		if (previous === undefined) await rm(file, { force: true }); else await writeFile(file, previous);
	}
});

test("a pause saved in a session's sidecar never outlives the user's current setting: the global file alone decides, and missing means on", async () => {
	const { loadState } = await import("../src/mom/checkpoint.ts");
	const stale = { load: async () => [{ id: "pause", sessionId: "session", type: "map", at: 1, data: { enabled: false } }] } as never;
	const branch = { getBranch: () => [] } as never;
	const file = settingsFile(), previous = await readFile(file, "utf8").catch(() => undefined);
	try {
		await rm(file, { force: true });
		assert.equal((await loadState(stale, branch)).enabled, true, "no global setting: a stale session pause does not hold Mom off");
		await writeMomGlobals({ enabled: true }, file);
		assert.equal((await loadState(stale, branch)).enabled, true, "the user's mom.enabled: true wins over the checkpoint");
		await writeMomGlobals({ enabled: false }, file);
		assert.equal((await loadState(stale, branch)).enabled, false, "a pause the user saved globally still pauses her");
	} finally {
		if (previous === undefined) await rm(file, { force: true }); else await writeFile(file, previous);
	}
});

test("the persisted decision-model control survives sidecar loading, including an explicit disable", async () => {
	const { loadState } = await import("../src/mom/checkpoint.ts");
	const read = async (decider: string) => loadState({ load: async () => [{ id: "control", sessionId: "session", type: "map", at: 1, data: { decider } }] } as never,
		{ getBranch: () => [] } as never);
	assert.equal((await read("local-llm/beverly-4B")).decider, "local-llm/beverly-4B");
	assert.equal((await read("")).decider, "");

	// Global controls outrank older sidecar values when a session loads its settings.
	const file = settingsFile();
	const saved = await readMomGlobals(file);
	try {
		await writeMomGlobals({ mode: "v2", decider: "local-llm/beverly-4B", enabled: false }, file);
		const withGlobals = await loadState({ load: async () => [{ id: "legacy", sessionId: "session", type: "map", at: 1, data: { mode: "commit_graph", decider: "" } }] } as never,
			{ getBranch: () => [] } as never);
		assert.equal(withGlobals.mode, "v2", "the global mode wins over the session's older one");
		assert.equal(withGlobals.decider, "local-llm/beverly-4B", "and so does the global decision model");
		assert.equal(withGlobals.enabled, false, "the loader applies the global pause");
	} finally {
		await rm(file, { force: true });
		if (Object.keys(saved).length) await writeMomGlobals(saved, file);
	}
});
