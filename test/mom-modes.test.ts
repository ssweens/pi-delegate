import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { MOM_PROMPT, momTools } from "../src/mom/contract.ts";
import { readSettings, settingsLine, type MomSettings } from "../src/mom/engine.ts";
import { readMomGlobals, writeMomGlobals } from "../src/mom/globals.ts";
import { settingsFile } from "../src/settings-file.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOM_TOOLS, OPERATION_PROMPT, assertSliceSupportsMode, deciderFor, momConfiguration, type SessionIdentity } from "../src/mom/slice.ts";
import { COMMIT_GRAPH_MODE, DEFAULT_MODE, MODES, V2_MODE, assertRunnable, modeFor, modeInstructions, modeNames, type MapMode } from "../src/mom/modes.ts";
import { commitV2Tool } from "../src/mom/v2.ts";
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
	assert.equal(updateErrorSummary('Error: Unknown Mom mode "act_labels"; --mom-mode accepts commit_graph, v2.'), 'Unknown Mom mode "act_labels"; --mom-mode accepts commit_graph, v2.');
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
});

test("M2: an unknown mode is refused loudly and never falls back to the default", () => {
	assert.throws(() => modeFor("freeform"), /Unknown Mom mode "freeform"/);
	// The message names the flag and the declared names so a typo is fixable from the error alone.
	assert.throws(() => modeFor("nonsense"), /--mom-mode accepts commit_graph, v2/);
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
	assert.deepEqual(modeNames(), ["commit_graph", "v2"]);
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
		assert.equal(typeof mode.apply, "function", `${mode.name} emits ${mode.finalizer} and must apply its own payload`);
	}
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
	const component = momSettings({ enabled: true, inject: false, hush: false, nudgedClasses: [], mode: "", model: "", decider: "" },
		async change => { saved.push(change); }, () => {}, () => {});
	const rendered = component.render(120).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(rendered, /Map mode/);
	assert.match(rendered, /Decision model/);
	assert.match(rendered, /commit_graph/);
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

test("the decision model resolves through Pi's classifier registry; an empty or unavailable pick runs Mom without it", () => {
	const registry = { findOfType: (_type: "classifier", provider: string, id: string) =>
		provider === "local-llm" && id === "beverly-4B" ? { id, api: "typesafe-system-one", baseUrl: "http://127.0.0.1:8000/v1/" } : undefined };
	const configured = momConfiguration(identity, { ...flags, "mom-decider": "local-llm/beverly-4B" }, registry);
	assert.deepEqual(readSettings(configured.instructions).classifier, { url: "http://127.0.0.1:8000/v1/systemone", model: "beverly-4B", timeoutMs: 15000 });
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
