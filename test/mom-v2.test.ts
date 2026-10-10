import assert from "node:assert/strict";
import { test } from "node:test";
import { checkGraph, emptyGraph, type WorkGraph } from "../src/mom/graph.ts";
import { MOM_PROMPT } from "../src/mom/contract.ts";
import { COMMIT_GRAPH_MODE, V2_MODE, modeFor, modeInstructions } from "../src/mom/modes.ts";
import { MOM_TOOLS, OPERATION_PROMPT, momConfiguration } from "../src/mom/slice.ts";
import { applySpec, applyV2, commitV2Tool, EMPTY_MAP, fromWorkGraph, specFocus, toWorkGraph, v2Body, v2Defects, v2View, V2_AUDIT_TASK, V2_OPERATION, V2_PROMPT, V2_UPDATE_TASK, type SpecOp, type V2Graph } from "../src/mom/v2.ts";
import { attachChoices, evidenceState, readSpec, SPEC_CHARS, SPEC_FLOOR, SPEC_NEW_MASS, specOps, specQuestions, stateChoices, type SpecReading } from "../src/mom/spec.ts";

const known = new Set(["s:u1", "s:u2", "s:a1"]);
const root = { id: "ship", parent: null, kind: "work" as const, state: "active" as const, label: "Ship the release", sources: ["s:u1"] };
const start = (): V2Graph => applyV2({ focus: null, nodes: [] }, { put: [root], focus: "ship" }, known).graph;

test("v2 builds a map from nothing and stores it as a valid shared map that reads back exactly", () => {
	const { graph, defects } = applyV2({ focus: null, nodes: [] }, { put: [root,
		{ id: "lint", parent: "ship", kind: "work", state: "active", label: "Fix lint", sources: ["s:u2"] },
		{ id: "no-force", parent: "ship", kind: "rule", label: "Never force-push", sources: ["s:u2"] }], focus: "lint" }, known);
	assert.deepEqual(defects, []);
	const stored = toWorkGraph(graph, emptyGraph());
	checkGraph(stored);
	assert.equal(stored.purpose, "ship");
	assert.equal(stored.motherThread, "ship");
	assert.deepEqual(stored.edges, []);
	assert.deepEqual(fromWorkGraph(stored), graph);
	assert.equal(toWorkGraph(fromWorkGraph(stored), stored), stored, "an unchanged map keeps its stored revision");
	assert.deepEqual(v2View(graph).nodes[1], { id: "lint", parent: "ship", kind: "work", state: "active", label: "Fix lint" });
});

test("a put replaces the node but its sources only accumulate", () => {
	const { graph, defects } = applyV2(start(), { put: [{ ...root, state: "settled", label: "Release shipped", sources: ["s:a1"] }] }, known);
	assert.deepEqual(defects, []);
	assert.deepEqual(graph.nodes[0], { id: "ship", parent: null, kind: "work", state: "settled", label: "Release shipped", sources: ["s:u1", "s:a1"] });
});

test("commit_v2 {} leaves the map unchanged; strict-transport nulls mean omitted", () => {
	const prior = start();
	assert.deepEqual(applyV2(prior, {}, known), { graph: prior, defects: [] });
	assert.deepEqual(applyV2(prior, { put: null, remove: null, focus: null }, known), { graph: prior, defects: [] });
	const note = applyV2(prior, { put: [{ id: "n1", parent: "ship", kind: "note", state: null, label: "Tagged v1.2", sources: ["s:a1"] }] }, known);
	assert.deepEqual(note.defects, []);
	assert.equal("state" in note.graph.nodes[1]!, false);
});

test("every structural defect is reported at once, and nothing is repaired by guessing", () => {
	const prior = applyV2(start(), { put: [{ id: "lint", parent: "ship", kind: "work", state: "active", label: "Fix lint", sources: ["s:u2"] }] }, known).graph;
	const cases: [unknown, RegExp][] = [
		[{ put: [{ id: "n1", parent: "ship", kind: "note", label: "x", sources: ["u2"] }] }, /cites unobserved source u2\. Use s:u2\./],
		[{ put: [{ id: "n1", parent: null, kind: "note", label: "x", sources: ["s:u2"] }] }, /note n1 needs a parent work item/],
		[{ put: [{ id: "n1", parent: "lint", kind: "note", label: "x", sources: ["s:u2"] }, { id: "n2", parent: "n1", kind: "note", label: "y", sources: ["s:u2"] }] }, /parent n1 is a note; parents must be work/],
		[{ remove: ["ship"] }, /lint: parent ship is not on the map/],
		[{ put: [{ id: "other", parent: null, kind: "work", state: "active", label: "x", sources: ["s:u2"] }] }, /exactly one root work item.*ship, other/],
		[{ put: [{ id: "r1", parent: "ship", kind: "rule", label: "x", sources: ["s:u2"] }], focus: "r1" }, /Focus r1 must be a work item/],
		[{ put: [{ ...root, state: "settled", sources: ["s:a1"] }] }, /Settled work ship still holds active work lint/],
		[{ put: [{ id: "w", parent: "ship", kind: "work", label: "x", sources: ["s:u2"] }] }, /Work w needs state/],
		[{ put: [{ id: "r1", parent: "ship", kind: "rule", state: "active", label: "x", sources: ["s:u2"] }] }, /rule r1 takes no state/],
		[{ put: [root, root] }, /put lists ship twice/],
		[{ put: [root], remove: ["ship"] }, /ship is both put and removed/],
		[{ remove: ["ghost"] }, /remove: ghost is not on the map/],
		[{ put: [{ ...root, parent: "lint" }] }, /Parent cycle/],
		[{ edges: [] }, /commit_v2/],
	];
	for (const [commit, expected] of cases) {
		const result = applyV2(prior, commit, known);
		assert.ok(result.defects.some(defect => expected.test(defect)), `${JSON.stringify(commit)} -> ${JSON.stringify(result.defects)}`);
	}
	const both = applyV2(prior, { put: [{ id: "w", parent: "nowhere", kind: "work", label: "x", sources: ["zz"] }] }, known).defects;
	assert.ok(both.length >= 3, `all defects reported together: ${JSON.stringify(both)}`);
});

test("a commit may not empty the map, and an empty map is still a legal starting point", async () => {
	// The board can never be wiped: refusing it is what stops a model that then invents work to anchor on.
	const prior = applyV2(start(), { put: [{ id: "lint", parent: "ship", kind: "work", state: "active", label: "Fix lint", sources: ["s:u2"] }] }, known).graph;
	const emptied = applyV2(prior, { remove: ["ship", "lint"] }, known);
	assert.deepEqual(emptied.defects, [EMPTY_MAP]);
	// applyV2 reports the defect; the mode is what keeps the saved map, so assert that layer too.
	const events = new Map([...known].map(ref => [ref, { ref, at: "2026-10-10T00:00:00.000Z", actor: "lead", kind: "user", text: "x" }]));
	const viaMode = await V2_MODE.apply!({ prior: toWorkGraph(prior, emptyGraph()), committed: { remove: ["ship", "lint"] }, known: events as never });
	assert.equal(viaMode.graph.nodes.length, 2, "a refused commit leaves the saved map exactly as it was");
	assert.deepEqual(viaMode.declined, [EMPTY_MAP]);
	// Removing all but the root is allowed: that is dropping work, and the drop is what phase 10 needed.
	const dropped = applyV2(prior, { remove: ["lint"] }, known);
	assert.deepEqual(dropped.defects, []);
	assert.deepEqual(dropped.graph.nodes.map(node => node.id), ["ship"]);
	// An empty map with nothing to empty stays legal, so a first commit is never blocked.
	assert.deepEqual(applyV2({ focus: null, nodes: [] }, {}, known), { graph: { focus: null, nodes: [] }, defects: [] });
	assert.deepEqual(v2Defects({ focus: "ship", nodes: [] }), ["An empty map has no focus."]);
});

test("a commit_graph map reads as v2 through the fixed schema reduction", () => {
	const node = (id: string, kind: string, state: string, parent: string | null) => ({ id, kind, parent, state, label: id, intent: "why", observed: "status", actor: "lead", sources: ["s:u1"] });
	const rich = { revision: 4, motherThread: "root", purpose: "root", focus: "pick", edges: [{ from: "idea", relation: "depends_on", to: "root", sources: ["s:u1"] }],
		nodes: [node("root", "feature", "active", null), node("idea", "theory", "proposed", "root"), node("check", "try", "unknown", "root"),
			node("old-rule", "rule", "settled", "root"), node("rule", "rule", "active", "root"), node("pick", "choice", "parked", "root")] } as unknown as WorkGraph;
	checkGraph(rich);
	const reduced = fromWorkGraph(rich);
	assert.equal(reduced.focus, "root", "a focus on a note moves to its work");
	assert.deepEqual(reduced.nodes.map(n => [n.id, n.kind, n.state ?? "-"]), [
		["root", "work", "active"], ["idea", "work", "parked"], ["check", "work", "active"],
		["old-rule", "note", "-"], ["rule", "rule", "-"], ["pick", "note", "-"]]);
	assert.deepEqual(v2Defects(reduced), []);
	const stored = toWorkGraph(reduced, rich);
	checkGraph(stored);
	assert.equal(stored.revision, 5);
	assert.deepEqual(stored.edges, []);
});

test("the v2 mode is selectable, owns its finalizer and instructions, and leaves commit_graph unchanged", () => {
	assert.equal(modeFor("v2"), V2_MODE);
	assert.equal(V2_MODE.finalizer, commitV2Tool().name);
	assert.ok(MOM_TOOLS.includes("commit_v2"));
	assert.equal(modeInstructions(V2_MODE, OPERATION_PROMPT, "S"), `${V2_PROMPT}\n\n${V2_OPERATION}\n\nS`);
	assert.equal(modeInstructions(COMMIT_GRAPH_MODE, OPERATION_PROMPT, "S"), `${MOM_PROMPT.trim()}\n\n${OPERATION_PROMPT.trim()}\n\nS`);
	const identity = { cwd: "/tmp/v2", sessionFile: "/tmp/v2/session.jsonl", sessionId: "session" };
	const configured = momConfiguration(identity, { "mom-model": "fixture/fixture", "mom-mode": "v2" });
	assert.ok(configured.instructions.startsWith(V2_PROMPT));
	assert.ok(configured.instructions.includes('"mapMode":"v2"'), "the operation pins its mode through the settings line");
});

test("the v2 mode's apply stores a valid map, or declines with every defect and keeps the prior map", async () => {
	const prior = emptyGraph();
	const events = new Map([...known].map(ref => [ref, { ref, at: "2026-10-10T00:00:00.000Z", actor: "lead", kind: "user", text: "x" }]));
	const good = await V2_MODE.apply!({ prior, committed: { put: [root], focus: "ship" }, known: events as never });
	assert.deepEqual(good.declined, []);
	checkGraph(good.graph);
	const bad = await V2_MODE.apply!({ prior, committed: { put: [{ ...root, sources: ["nope"] }] }, known: events as never });
	assert.equal(bad.graph, prior);
	assert.ok(bad.declined.some(defect => /unobserved source nope/.test(defect)));
	assert.ok(bad.declined.some(defect => /Set focus/.test(defect)));
});

test("the v2 mode preserves omitted permitted additions as unmet diagnostics", async () => {
	const prior = toWorkGraph(start(), emptyGraph());
	const events = new Map([...known].map(ref => [ref, { ref, at: "2026-10-10T00:00:00.000Z", actor: "lead", kind: "user", text: "x" }]));
	const result = await V2_MODE.apply!({ prior, committed: {}, known: events as never, spec: [{ kind: "attach", node: "ship", attach: "note" }] });
	assert.deepEqual(result, { graph: prior, declined: [], unmet: ["ship: the spec asks for a note here, but the commit adds none"] });
});

test("the spec exists only when the decision model answered, and it narrows her model without ever blocking it", async () => {
	const graph = applyV2({ focus: null, nodes: [] }, { focus: "export", put: [
		{ id: "export", parent: null, kind: "work", state: "active", label: "CSV export", sources: ["s:u1"] },
		{ id: "dark", parent: "export", kind: "work", state: "parked", label: "Dark mode", sources: ["s:u2"] },
	] }, known).graph;
	const events = [{ ref: "s:a1", at: "2026-10-10T00:00:00.000Z", actor: "lead", kind: "user", text: "Park the export and add dark mode." }];
	const answered = (answers: Record<string, unknown>) => ({ ask: async () => ({ answers: answers as never }) });
	const answers = {
		new_work: { type: "choice", choice: "new_only", probabilities: { new_only: 0.30, new_and_existing: 0.30, existing_only: 0.20, report_only: 0.10, nothing: 0.10 } },
		"state__export": { type: "choice", choice: "none", probabilities: { none: 0.80, finished: 0.10, deferred: 0.05, dropped: 0.05 } },
		"attach__export": { type: "choice", choice: "note", probabilities: { note: 0.40, none: 0.30, child: 0.20, rule: 0.05 } },
		"state__dark": { type: "choice", choice: "resumed", probabilities: { resumed: 0.50, none: 0.30, dropped: 0.10 } },
		"attach__dark": { type: "choice", choice: "none", probabilities: { none: 0.70, rule: 0.10, note: 0.10, child: 0.10 } },
	};
	const read = await readSpec(answered(answers), graph, events);
	// Ops come in one order: new work, then each work node's state and attachment in map order.
	assert.deepEqual(read?.ops, [{ kind: "new_work" }, { kind: "attach", node: "export", attach: "note" }, { kind: "state", node: "dark", to: "resumed" }]);
	assert.equal(read?.chosen.new_work, "new_only");

	// Fail-open: every way of not getting an answer leaves her model running on structure alone and is diagnosable.
	const failures: string[] = [], failed = (reason: string) => { failures.push(reason); };
	assert.equal(await readSpec(undefined, graph, events, failed), undefined, "no decision model");
	assert.equal(await readSpec({ ask: async () => { throw new Error("HTTP 500"); } }, graph, events, failed), undefined, "an endpoint that failed");
	assert.equal(await readSpec(answered({}), graph, events, failed), undefined, "an empty round is not 'nothing to record'");
	assert.equal(await readSpec(answered({ ...answers, "attach__export": undefined }), graph, events, failed), undefined, "a partial round is not a spec");
	const malformed = [
		{ ...answers, "state__export": { type: "choice", choice: "finished", probabilities: { none: 0.8, finished: "1", deferred: 0.1, dropped: 0.0 } } },
		{ ...answers, "attach__export": { type: "choice", choice: "unoffered", probabilities: { note: 0.4, none: 0.3, child: 0.2, rule: 0.05, unoffered: 0.05 } } },
		{ ...answers, "attach__export": { type: "choice", choice: "note", probabilities: { note: 0.4, none: 0.3, child: 0.2, rule: 0.05, unknown: 0.05 } } },
		{ ...answers, "attach__export": { type: "choice", choice: "note", probabilities: { note: 0.4, none: 0.3, child: 0.3 } } },
	];
	for (const invalid of malformed) assert.equal(await readSpec(answered(invalid), graph, events, failed), undefined, "a malformed answer fails open");
	const oversized = [{ ...events[0]!, text: "x".repeat(SPEC_CHARS) }];
	assert.equal(await readSpec(answered(answers), graph, oversized, failed), undefined, "a batch too large to show is never truncated into a spec");
	assert.deepEqual(failures, ["no-client", "classifier-error", "incomplete", "incomplete", "incomplete", "incomplete", "incomplete", "incomplete", "oversized"]);

	// A round that answers everything and decides nothing IS a spec: the empty one that skips her model.
	const quiet = Object.fromEntries(Object.entries(specQuestions(graph)).map(([name, question]) => {
		if (question.type !== "choice") throw new Error(`spec question ${name} must be a choice`);
		const choice = Object.hasOwn(question.criteria, "none") ? "none" : "nothing";
		return [name, { type: "choice", choice, probabilities: Object.fromEntries(Object.keys(question.criteria).map(option => [option, option === choice ? 0.9 : 0])) }];
	}));
	const empty = await readSpec(answered(quiet), graph, events);
	assert.deepEqual(empty?.ops, [], "every question answered, nothing decided: the spec that skips her model");
	assert.deepEqual(Object.keys(empty?.chosen ?? {}).sort(), Object.keys(specQuestions(graph)).sort());
});
test("her model reads only what v2 acts on: the map, the evidence, and no commit_graph vocabulary", () => {
	const graph = applyV2(start(), { put: [{ id: "lint", parent: "ship", kind: "work", state: "active", label: "Fix lint", sources: ["s:u2"] }] }, known).graph;
	const directions = [{ ref: "s:u1", text: "Fix the lint" }];
	const body = v2Body({ map: graph, task: V2_UPDATE_TASK, newEvents: "[src:s:u1] lead user", newUserDirections: directions, instruction: "Record changed requirements and reported outcomes from newEvents." });
	assert.deepEqual(Object.keys(body), ["task", "map", "newEvents", "newUserDirections", "instruction"]);
	assert.deepEqual(body.map, v2View(graph));
	assert.equal("graph" in body, false, "the mode's own projection replaces the shared graph view");
	// Nothing of commit_graph's body reaches v2: no chapter state, process risks, findings, or folds.
	for (const absent of ["graph", "chapterState", "reflect", "chapters", "unresolvedProcessRisks", "findingFeedback", "original", "activity", "uncertainEffects", "contextBeforeBatch", "gaps", "pendingMore"])
		assert.equal(absent in body, false, `${absent} is commit_graph's and must not reach v2`);
	// The audit, a recovery range and a review each add exactly their own field and instruction.
	const audit = v2Body({ map: graph, task: V2_AUDIT_TASK, newEvents: "pending", independentThreadMap: { states: [] } });
	assert.deepEqual(Object.keys(audit), ["task", "map", "independentThreadMap", "newEvents"]);
	const recovery = v2Body({ map: graph, task: V2_UPDATE_TASK, newEvents: "old", recovery: { error: "rejected", instruction: "commit_graph's" } });
	assert.match(String((recovery.recovery as Record<string, unknown>).instruction), /older evidence/);
	const review = v2Body({ map: graph, task: V2_UPDATE_TASK, newEvents: "x", guidance: "Reflect only to shorten settled detail." });
	assert.deepEqual(Object.keys(review), ["task", "guidance", "map", "newEvents"]);
	// No user turns in the batch means no directions and no instruction about them.
	assert.deepEqual(Object.keys(v2Body({ map: graph, task: V2_UPDATE_TASK, newEvents: "x", newUserDirections: [] })), ["task", "map", "newEvents"]);
});

test("the spec enforces state and drops while permitting measured additions", () => {
	const prior = applyV2({ focus: null, nodes: [] }, { focus: "export", put: [
		{ id: "export", parent: null, kind: "work", state: "active", label: "CSV export", sources: ["s:u1"] },
		{ id: "dark", parent: "export", kind: "work", state: "parked", label: "Dark mode", sources: ["s:u2"] },
		{ id: "dep-rule", parent: "export", kind: "rule", label: "Never add a dependency without asking", sources: ["s:u1"] },
		{ id: "lint", parent: "export", kind: "work", state: "active", label: "Fix the lint errors", sources: ["s:u1"] },
		{ id: "lint-rule", parent: "lint", kind: "rule", label: "Prefix unused args with _", sources: ["s:u1"] },
	] }, known).graph;
	const spec: SpecOp[] = [{ kind: "state", node: "dark", to: "resumed" }, { kind: "attach", node: "export", attach: "note" }];

	// Inside the spec: dark is picked back up, a finding lands on the export, focus follows dark.
	const good = applySpec(spec, prior, { put: [
		{ id: "dark", parent: "export", kind: "work", state: "active", label: "Dark mode", sources: ["s:a1"] },
		{ id: "note-1", parent: "export", kind: "note", label: "Chose the token approach", sources: ["s:a1"] },
	] }, known);
	assert.deepEqual(good.defects, []);
	assert.deepEqual(good.unmet, []);
	assert.equal(good.graph.focus, "dark", "focus follows the spec, not the commit, which did not even name one");

	const cases: [unknown, RegExp][] = [
		// a state the spec does not touch
		[{ put: [{ id: "dark", parent: "export", kind: "work", state: "settled", label: "Dark mode", sources: ["s:a1"] }] }, /dark: the spec picks this work back up, but the commit records settled/],
		// a required state change the commit simply omits
		[{ put: [{ id: "note-1", parent: "export", kind: "note", label: "x", sources: ["s:a1"] }] }, /dark: the spec picks this work back up, but the commit records parked/],
		// work the spec keeps and the commit deletes
		[{ remove: ["dark"] }, /dark: the spec keeps this work, but the commit does not/],
		// work added where the spec asks for nothing
		[{ put: [{ id: "spare", parent: "export", kind: "work", state: "active", label: "Spare", sources: ["s:a1"] }] }, /export: the commit adds work under this, but the spec adds nothing there/],
		// a finding under a node the spec never touched
		[{ put: [{ id: "dark", parent: "export", kind: "work", state: "active", label: "Dark mode", sources: ["s:a1"] },
			{ id: "note-9", parent: "lint", kind: "note", label: "x", sources: ["s:a1"] }] }, /lint: the commit adds a note here, but the spec records nothing/],
		// a rule removed where the spec says nothing about that work
		[{ put: [{ id: "dark", parent: "export", kind: "work", state: "active", label: "Dark mode", sources: ["s:a1"] }], remove: ["lint-rule"] }, /lint-rule: the commit removes this rule/],
		// an existing rule rewritten under work the spec did not touch
		[{ put: [{ id: "dark", parent: "export", kind: "work", state: "active", label: "Dark mode", sources: ["s:a1"] },
			{ id: "lint-rule", parent: "lint", kind: "rule", label: "Install anything without asking", sources: ["s:a1"] }] }, /lint-rule: the commit changes this rule, but the spec does not touch its parent lint/],
		// changing an existing attachment's kind or parent is not an attach operation
		[{ put: [{ id: "dark", parent: "export", kind: "work", state: "active", label: "Dark mode", sources: ["s:a1"] },
			{ id: "dep-rule", parent: "dark", kind: "note", label: "A finding", sources: ["s:a1"] }] }, /dep-rule: the commit changes this rule's kind or parent/],
	];
	for (const [commit, expected] of cases) {
		const checked = applySpec(spec, prior, commit, known);
		assert.ok(checked.defects.some(defect => expected.test(defect)), `${JSON.stringify(commit)} -> ${JSON.stringify(checked.defects)}`);
	}

	// An additive op is permitted wherever the batch was about the work: the menu that decides them
	// misses real rules and notes on unseen pairs, so a rejection here would lose them.
	const additive = applySpec(spec, prior, { put: [
		{ id: "dark", parent: "export", kind: "work", state: "active", label: "Dark mode", sources: ["s:a1"] },
		{ id: "note-2", parent: "dark", kind: "note", label: "Chose token auth", sources: ["s:a1"] },
		{ id: "rule-2", parent: "export", kind: "rule", label: "Ask before adding dependencies", sources: ["s:a1"] },
	] }, known);
	assert.deepEqual(additive.defects, [], JSON.stringify(additive.defects));

	// Dropping is authorized per node: the spec drops `export`, so keeping it is a defect...
	const drop: SpecOp[] = [{ kind: "state", node: "export", to: "dropped" }];
	assert.ok(applySpec(drop, prior, { remove: [] }, known).defects.some(defect => /export: the spec drops this work, but the commit keeps it/.test(defect)));
	// A dropped root can be removed when surviving work is promoted to the sole root.
	const promoted = applySpec(drop, prior, { put: [
		{ id: "dark", parent: null, kind: "work", state: "parked", label: "Dark mode", sources: ["s:a1"] },
		{ id: "lint", parent: "dark", kind: "work", state: "active", label: "Fix the lint errors", sources: ["s:a1"] },
	], remove: ["export", "dep-rule"] }, known);
	assert.deepEqual(promoted.defects, [], JSON.stringify(promoted.defects));
	assert.equal(promoted.graph.nodes.find(node => node.id === "dark")?.parent, null);
	assert.equal(promoted.graph.nodes.find(node => node.id === "lint")?.parent, "dark");
	// ...and taking anything else with it is too, even when the result is an empty map.
	const overreach = applySpec(drop, prior, { remove: ["export", "dark", "lint", "dep-rule", "lint-rule"] }, known);
	assert.ok(overreach.defects.some(defect => /dark: the spec keeps this work, but the commit does not/.test(defect)), JSON.stringify(overreach.defects));
	assert.ok(overreach.defects.some(defect => /dark: the spec keeps this work, but the commit does not/.test(defect)), JSON.stringify(overreach.defects));
	// A spec that drops every work item authorizes exactly that, and nothing else is left to check.
	const dropAll: SpecOp[] = [{ kind: "state", node: "export", to: "dropped" }, { kind: "state", node: "dark", to: "dropped" },
		{ kind: "state", node: "lint", to: "dropped" }, { kind: "attach", node: "export", attach: "rule" }];
	const dropped = applySpec(dropAll, prior, { remove: ["export", "dark", "lint", "dep-rule", "lint-rule"] }, known);
	assert.deepEqual(dropped.defects, [], JSON.stringify(dropped.defects));
	assert.equal(dropped.graph.focus, null, "an emptied map has no focus");

	// Rewriting an existing rule under work the batch touched is permitted.
	const rewritten = applySpec(spec, prior, { put: [
		{ id: "dark", parent: "export", kind: "work", state: "active", label: "Dark mode", sources: ["s:a1"] },
		{ id: "dep-rule", parent: "export", kind: "rule", label: "Ask before installing dependencies", sources: ["s:a1"] },
	] }, known);
	assert.deepEqual(rewritten.defects, [], JSON.stringify(rewritten.defects));

	// Permitted additions are never manufactured: omitting them is recorded, not rejected.
	const permitted = applySpec([{ kind: "new_work" }, { kind: "attach", node: "export", attach: "child" }], prior, {}, known);
	assert.deepEqual(permitted.defects, []);
	assert.deepEqual(permitted.unmet, ["export: the spec asks for work here, but the commit adds none", "the spec asks for new work, but the commit adds none"]);
	// New work the spec permits lands under the purpose, and only one of them.
	const sso = { id: "sso", parent: "export", kind: "work", state: "active", label: "SSO", sources: ["s:a1"] };
	const added = applySpec([{ kind: "new_work" }], prior, { put: [sso] }, known);
	assert.deepEqual(added.defects, [], JSON.stringify(added.defects));
	assert.deepEqual(added.unmet, []);
	assert.equal(added.graph.focus, "sso", "focus follows added work");
	assert.ok(applySpec([{ kind: "new_work" }], prior, { put: [sso, { id: "extra", parent: null, kind: "work", state: "active", label: "Extra", sources: ["s:a1"] }] }, known)
		.defects.some(defect => /needs exactly one root work item/.test(defect)), "a second root is structural, caught before the spec is consulted");
	assert.ok(applySpec([], { focus: null, nodes: [] }, { put: [{ id: "first", parent: null, kind: "work", state: "active", label: "First ask", sources: ["s:a1"] }] }, known)
		.defects.some(defect => /adds top-level work, but the spec asks for none/.test(defect)), "an empty spec authorizes no work at all");
	// A cold start's first ask IS the purpose, so it is the root.
	const cold = applySpec([{ kind: "new_work" }], { focus: null, nodes: [] }, { put: [{ id: "first", parent: null, kind: "work", state: "active", label: "First ask", sources: ["s:a1"] }] }, known);
	assert.deepEqual(cold.defects, [], JSON.stringify(cold.defects));
	assert.equal(cold.graph.focus, "first");

	// Structure is still checked first, and its defects are the ones reported.
	const broken = applySpec(spec, prior, { put: [{ id: "dark", parent: "export", kind: "work", state: "active", label: "Dark mode", sources: ["nope"] }] }, known);
	assert.ok(broken.defects.some(defect => /unobserved source nope/.test(defect)));

	// Focus: resumed work outranks reopened work regardless of their order in the spec.
	assert.equal(specFocus(prior, prior, [{ kind: "state", node: "export", to: "reopened" }, { kind: "state", node: "dark", to: "resumed" }]), "dark");
	assert.equal(specFocus(prior, prior, [{ kind: "state", node: "export", to: "reopened" }]), "export");
	assert.equal(specFocus(prior, prior, []), prior.focus ?? "export");
	assert.equal(specFocus(prior, prior, [{ kind: "state", node: "dark", to: "dropped" }]), "export");
	assert.equal(specFocus(prior, { focus: null, nodes: [] }, []), null);
});

test("the spec adapter reads the tuned rules off the answers, and never takes a name the node's menu did not offer", () => {
	const graph = applyV2({ focus: null, nodes: [] }, { focus: "export", put: [
		{ id: "export", parent: null, kind: "work", state: "active", label: "CSV export", sources: ["s:u1"] },
		{ id: "dark", parent: "export", kind: "work", state: "parked", label: "Dark mode", sources: ["s:u2"] },
		{ id: "done", parent: "export", kind: "work", state: "settled", label: "Old import", sources: ["s:u2"] },
	] }, known).graph;
	const reading = (entries: Record<string, [string, number][]>): SpecReading => entries;
	const { ops, chosen } = specOps(graph, reading({
		new_work: [["new_and_existing", 0.51], ["new_only", 0.20], ["existing_only", 0.20]],
		"state__export": [["finished", 0.62], ["none", 0.31]],
		// parked and settled nodes are offered neither `deferred` nor `resumed`: the menu follows the node
		"state__dark": [["deferred", 0.71], ["none", 0.20]],
		"state__done": [["resumed", 0.66], ["none", 0.22]],
		// an attachment needs a margin over "nothing attaches"
		"attach__export": [["note", 0.42], ["none", 0.28]],
		"attach__dark": [["rule", 0.31], ["none", 0.30]],
		"attach__done": [["child", 0.90], ["none", 0.05]],
	}));
	assert.deepEqual(ops, [
		{ kind: "new_work" },
		{ kind: "state", node: "export", to: "finished" },
		{ kind: "attach", node: "export", attach: "note" },
		{ kind: "attach", node: "done", attach: "child" },
	], JSON.stringify(ops));
	assert.deepEqual(chosen, { new_work: "new_and_existing", "state__export": "finished", "attach__export": "note",
		"state__dark": "none", "attach__dark": "none", "state__done": "none", "attach__done": "child" });

	// New work reads by mass, not by the winning name, and the constant is set for recall: an
	// abandonment reading at 0.53 clears it, which only PERMITS one work item — an unused permission is
	// logged, never invented — while a genuine ask at 0.48 must never be missed.
	// The two readings the recall constant deliberately lets through: both only touch existing work, and
	// clearing the constant merely permits one work item, logged as `unmet` if the model does not add it.
	assert.deepEqual(specOps(graph, reading({ new_work: [["new_and_existing", 0.46], ["existing_only", 0.39], ["new_only", 0.07], ["nothing", 0.06], ["report_only", 0.03]] })).ops,
		[{ kind: "new_work" }], "an abandonment reading at 0.53 clears the constant, and only permits");
	assert.deepEqual(specOps(graph, reading({ new_work: [["new_and_existing", 0.41], ["existing_only", 0.49], ["new_only", 0.02], ["nothing", 0.06], ["report_only", 0.02]] })).ops,
		[], "below the constant stays silent");
	assert.deepEqual(specOps(graph, reading({ new_work: [["new_only", SPEC_NEW_MASS - 0.01]] })).ops, []);
	assert.deepEqual(specOps(graph, reading({ new_work: [["new_only", SPEC_NEW_MASS]] })).ops, [{ kind: "new_work" }]);
	// A stated need for something absent is new work; a requirement on work that exists is not.
	assert.deepEqual(specOps(graph, reading({ new_work: [["new_and_existing", 0.43], ["new_only", 0.17], ["existing_only", 0.28], ["nothing", 0.07], ["report_only", 0.05]] })).ops,
		[{ kind: "new_work" }], "\"We're going to need rate limiting before launch.\" — mass 0.60");
	assert.deepEqual(specOps(graph, reading({ new_work: [["new_and_existing", 0.38], ["new_only", 0.08], ["existing_only", 0.37], ["nothing", 0.10], ["report_only", 0.07]] })).ops,
		[], "\"Forget the audit log for now.\" — mass 0.46, an abandonment that stays silent");
	assert.deepEqual(specOps(graph, reading({ new_work: [["existing_only", 0.45], ["new_and_existing", 0.26], ["new_only", 0.14], ["nothing", 0.09], ["report_only", 0.06]] })).ops,
		[], "\"Nudge the export to use tabs instead of commas.\" — mass 0.40, a change to work on the map");
	assert.deepEqual(specOps(graph, reading({ new_work: [["existing_only", 0.30], ["new_only", 0.27], ["new_and_existing", 0.31], ["nothing", 0.11], ["report_only", 0.02]] })).ops,
		[{ kind: "new_work" }], "a separate request wins on mass even when `existing` is close behind");
	assert.deepEqual(specOps(graph, reading({ new_work: [["existing_only", 0.9], ["new_and_existing", 0.02], ["new_only", 0.03]] })).ops, [], "existing is not new work");
	// An attachment that ties with `none` is not an attachment.
	assert.deepEqual(specOps(graph, reading({ "attach__export": [["note", 0.30], ["none", 0.29]] })).ops, []);

	// The menus themselves: what each node state is offered.
	assert.deepEqual(Object.keys(stateChoices(graph.nodes[0]!)), ["none", "finished", "deferred", "dropped"]);
	assert.deepEqual(Object.keys(stateChoices(graph.nodes[1]!)), ["none", "resumed", "dropped"]);
	assert.deepEqual(Object.keys(stateChoices(graph.nodes[2]!)), ["none", "reopened", "dropped"]);
	assert.deepEqual(Object.keys(attachChoices(graph.nodes[0]!)), ["none", "child", "rule", "note"]);

	// Every work node gets exactly its two questions, plus one for the user's message.
	assert.deepEqual(Object.keys(specQuestions(graph)).sort(),
		["attach__dark", "attach__done", "attach__export", "new_work", "state__dark", "state__done", "state__export"]);
});
