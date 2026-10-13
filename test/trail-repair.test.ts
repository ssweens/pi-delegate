import assert from "node:assert/strict";
import { test } from "node:test";
import { planRepair } from "../src/trail/repair.ts";
import { glance } from "../src/trail/projection.ts";
import { trailFor } from "../src/trail/store.ts";
import type { Trail, TrailRecord, Waypoint } from "../src/trail/types.ts";

let clock = 1_700_000_000_000;
const wp = (id: string, kind: Waypoint["kind"], line: string, caption: string, extra: Partial<Waypoint> = {}): Waypoint =>
	({ id, sessionId: "s", at: (clock += 60_000), kind, line, refs: [`s:${id}`], caption, parent: null, by: "mom", anchor: id, ...extra });
const hop = () => {
	const waypoints = [
		wp("a", "set_out", "Hop integration", "Run Werkit from Hop."),
		wp("b", "reframed", "Hop integration", "Agent rows must keep spawn order.", { supersedes: "a" }),
		wp("c", "open", "Hop integration", "MCP elicitations floated as another candidate handoff channel."),
		wp("d", "detour", "receiver", "Revive the parked handoff question."),
		wp("e", "returned", "Hop integration", "Back from the receiver.", { closes: "d" }),
	];
	const finding = wp("f", "learned", "Hop integration", "OpenCode has no inbound delivery.");
	const answered = wp("g", "learned", "Hop integration", "Elicitation cannot target another session.");
	const entries = [waypoints[0]!, waypoints[1]!, waypoints[2]!, finding, waypoints[3]!, answered, waypoints[4]!];
	return { waypoints, entries, struck: [] } as Trail;
};

test("repair: titles alone are title records; kinds and links make revised copies that keep their place; links to a copy move with it", () => {
	const trail = hop();
	const plan = planRepair(trail, [
		{ id: "a", title: "Run Werkit from Hop" },
		{ id: "b", kind: "decided", title: "Spawn-order agent rows" },
		{ id: "d", from: "f", title: "OpenCode receiver" },
		{ id: "g", kind: "closed", closes: "c", title: "MCP elicitation dropped" },
	], i => `j:r${i}`);
	assert.deepEqual(plan.defects, []);
	assert.deepEqual(plan.titles, [{ id: "a", title: "Run Werkit from Hop" }], "a title alone needs no copy");
	assert.deepEqual(plan.copies.map(c => [c.id, c.kind, c.title, c.from, c.closes, c.supersedes, c.anchor]), [
		["j:r0", "decided", "Spawn-order agent rows", undefined, undefined, "a", "b"],
		["j:r1", "detour", "OpenCode receiver", "f", undefined, undefined, "d"],
		["j:r2", "closed", "MCP elicitation dropped", undefined, "c", undefined, "g"],
		["j:r3", "returned", undefined, undefined, "j:r1", undefined, "e"],
	], "the returned that closed the revised detour is copied with its link moved; every copy keeps its anchor");
	assert.deepEqual(plan.strikes.map(s => s.target).sort(), ["b", "d", "e", "g"]);

	// Applied as records, the trail reads as the repair meant it.
	const records: TrailRecord[] = [...trail.entries!.map(w => ({ type: "waypoint" as const, ...w })),
		...plan.copies.map(w => ({ type: "waypoint" as const, ...w })),
		...plan.titles.map((t, i) => ({ type: "title" as const, id: `j:t${i}`, sessionId: "s", at: clock, target: t.id, title: t.title, parent: null })),
		...plan.strikes.map((s, i) => ({ type: "strike" as const, id: `j:s${i}`, sessionId: "s", at: clock, target: s.target, reason: s.reason, parent: null }))];
	const repaired = trailFor(records, new Set(["a", "b", "c", "f", "d", "g", "e"]));
	const view = glance(repaired).tree!;
	assert.equal(view.goal.title, "Run Werkit from Hop", "the bogus goal change is a decision now; the real goal is current again");
	assert.deepEqual(view.levels.map(level => level.head.id), ["a"], "the detour is still closed by its moved returned");
	assert.deepEqual(view.levels[0]!.open, [], "the parked question is closed by the finding that answered it");
});

test("repair: drops leave the trail and links to them are cut; defects are named and nothing is planned", () => {
	const trail = hop();
	const plan = planRepair(trail, [{ id: "f", drop: "routine" }, { id: "d", title: "OpenCode receiver", from: null }], i => `j:r${i}`);
	assert.deepEqual(plan.strikes, [{ target: "f", reason: "routine" }]);
	assert.deepEqual(plan.titles, [{ id: "d", title: "OpenCode receiver" }], "from: null on an entry with no from changes nothing but the title");
	const bad = planRepair(trail, [{ id: "zz", title: "x" }, { id: "c", kind: "decided", closes: "d" }, { id: "e", closes: "c" }, { id: "a", from: "a" }], i => `${i}`);
	assert.equal(bad.defects.length, 4, bad.defects.join(" | "));
	assert.match(bad.defects.join(" "), /unknown entry zz/);
	assert.match(bad.defects.join(" "), /a decided does not close anything/);
	assert.match(bad.defects.join(" "), /closes must name detour, not open c/);
	assert.match(bad.defects.join(" "), /names the entry itself/);
	assert.deepEqual([bad.copies, bad.strikes, bad.titles], [[], [], []]);
	const user = { ...trail, entries: trail.entries!.map(w => w.id === "a" ? { ...w, by: "user" as const } : w) };
	assert.match(planRepair(user, [{ id: "a", title: "Mine" }], i => `${i}`).defects[0]!, /marked by the user/);
	assert.match(planRepair(trail, [{ id: "a", drop: "routine status update" }], i => `${i}`).defects[0]!, /a goal is never dropped/, "the goal the user set is never dropped");
});
