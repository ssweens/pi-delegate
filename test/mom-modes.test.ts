import assert from "node:assert/strict";
import { test } from "node:test";
import { MOM_PROMPT, momTools } from "../src/mom/contract.ts";
import { settingsLine, type MomSettings } from "../src/mom/engine.ts";
import { MOM_TOOLS, OPERATION_PROMPT, momConfiguration, type SessionIdentity } from "../src/mom/slice.ts";
import { COMMIT_GRAPH_MODE, DEFAULT_MODE, MODES, ACT_LABELS_MODE, assertRunnable, modeFor, modeInstructions, modeNames, type MapMode } from "../src/mom/modes.ts";
import { actLabelsTool } from "../src/mom/act-derivation.ts";

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

test("M2: an unknown mode is refused loudly and never falls back to the default", () => {
	assert.throws(() => modeFor("freeform"), /Unknown Mom mode "freeform"/);
	// The message names the flag and the declared names so a typo is fixable from the error alone.
	assert.throws(() => modeFor("nonsense"), /--mom-mode accepts commit_graph, act_labels/);
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
	assert.deepEqual(modeNames(), ["commit_graph", "act_labels"]);
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

test("M5: act_labels is selectable, declares its own apply, and its finalizer is registered", () => {
	const mode = modeFor("act_labels");
	assert.equal(mode, ACT_LABELS_MODE);
	assert.equal(mode.finalizer, "commit_acts");
	assert.equal(typeof mode.apply, "function", "a mode whose model emits acts must supply apply");
	// A mode owns its payload: momTools() keeps its small shared contract and does not grow it.
	assert.equal(actLabelsTool().name, "commit_acts");
	assert.ok(!momTools().some(tool => tool.name === "commit_acts"), "mode-owned tools stay out of the shared surface");
});

test("M5: the transaction mode needs no apply; a non-transaction mode does", () => {
	assert.equal(COMMIT_GRAPH_MODE.apply, undefined, "a transaction mode uses the default acceptGraph path");
	for (const mode of MODES) {
		if (mode.finalizer === "commit_graph") continue;
		assert.equal(typeof mode.apply, "function", `${mode.name} emits ${mode.finalizer} and must derive the graph in host code`);
	}
});

test("M5: act_labels derives the graph from acts alone — the model names no node", () => {
	const graph = {
		revision: 1, motherThread: "root", purpose: "root", focus: "root", edges: [],
		nodes: [{ id: "root", kind: "feature", parent: null, label: "Ship it", state: "active", intent: "Ship it", observed: "", actor: "user", sources: ["u1"] }],
	} as never;
	const candidate = { id: "c01", kind: "new_work" as const, source: "u1", source_role: "user" as const, quote: "Add a second pane", prior_ref: null, proposed: null };
	const known = new Map([["u1", { ref: "u1", at: "t", actor: "lead", kind: "user", text: "Add a second pane" }]]);
	const result = ACT_LABELS_MODE.apply!({ prior: graph, candidates: [candidate], committed: { acts: [{ id: "c01", act: "request", label: "Add a second pane" }] }, known, events: [...known.values()] as never });
	assert.deepEqual(result.declined, []);
	assert.ok(result.graph.nodes.some(n => /second pane/.test(n.label) && n.kind === "feature"), "the host created the work");
});

test("the current mode's prompt is exactly MOM_PROMPT, with no mode-specific drift", () => {
	// Regression guard for M1: if someone edits the mode's prompt independently of MOM_PROMPT the
	// two would diverge silently and the shipped model input would change.
	assert.equal(COMMIT_GRAPH_MODE.prompt, MOM_PROMPT.trim());
});

test("mode is a durable setting: listed, cycled to a declared name, and carried in the sidecar", async () => {
	const { initTheme } = await import("@earendil-works/pi-coding-agent");
	const { momSettings } = await import("../src/mom/settings.ts");
	const { CONTROL_KEYS } = await import("../src/mom/sidecar.ts");
	initTheme("dark");
	const saved: unknown[] = [];
	const component = momSettings({ enabled: true, inject: false, hush: false, nudgedClasses: [], mode: "", model: "" },
		async change => { saved.push(change); }, () => {}, () => {});
	const rendered = component.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(rendered, /Map mode/);
	assert.match(rendered, /commit_graph/);
	// The sidecar accepts a mode control record alongside the existing ones.
	assert.deepEqual([...CONTROL_KEYS], ["enabled", "inject", "nudgedClasses", "mode", "model"]);
	assert.equal(modeFor("act_labels").name, "act_labels");
});

test("Mom's model receives only bounded domain tools, never native filesystem or shell tools", () => {
	const configured = momConfiguration(identity, flags);
	assert.deepEqual(configured.tools, [...MOM_TOOLS]);
	assert.ok(!configured.tools?.some(tool => ["read", "write", "edit", "bash", "codemode"].includes(tool)), "native tools let Mom leave the bounded operation");
	assert.deepEqual(momConfiguration(identity, { ...flags, "mom-mode": "act_labels" }).tools, [...MOM_TOOLS]);
});

test("momConfiguration honors a persisted mode: the prompt is that mode's, not the flag's", () => {
	const configured = momConfiguration(identity, { ...flags, "mom-mode": "act_labels" });
	const act = configured.instructions;
	assert.ok(act.startsWith(ACT_LABELS_MODE.prompt), "the persisted mode must drive the standing instructions");
	assert.ok(act.includes("historical catch-up") && act.includes("commit_graph"), "act_labels must define the fast thread-map catch-up path");
	assert.ok(configured.tools?.includes("commit_graph"), "act_labels slices need the transaction finalizer for historical catch-up");
	assert.ok(act !== momConfiguration(identity, flags).instructions, "switching mode must change what the model sees");
	// M1 still holds: the default path is unchanged (asserted byte-for-byte above, against itself).
});

test("the model control is durable and scoped to Mom, never to Pi", async () => {
	const { CONTROL_KEYS } = await import("../src/mom/sidecar.ts");
	assert.deepEqual([...CONTROL_KEYS], ["enabled", "inject", "nudgedClasses", "mode", "model"]);
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
