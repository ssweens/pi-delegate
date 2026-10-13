import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TrailStore, trailFile, trailFor } from "../src/trail/store.ts";
import { beforeLastDetour, current, depths, evolution, glance, landing, lines, openItems, renderBefore, renderEvolution, renderLanding, renderOpen, renderStanding, renderTrail, renderWaypoint, whereWeAre } from "../src/trail/projection.ts";
import { label, sortTiers, trailEntries, validateWaypointInputs, type Strike, type Trail, type TrailRecord, type Waypoint } from "../src/trail/types.ts";

const sessionId = "session-trail";
let clock = 1_700_000_000_000;
const wp = (id: string, kind: Waypoint["kind"], line: string, caption: string, extra: Partial<Waypoint> = {}): Waypoint =>
	({ id, sessionId, at: (clock += 60_000), kind, line, refs: [`lead:${id}`], caption, parent: null, by: "mom", ...extra });
const strike = (id: string, target: string, extra: Partial<Strike> = {}): Strike => ({ id, sessionId, at: (clock += 60_000), target, parent: null, ...extra });
const asTrail = (waypoints: Waypoint[]): Trail => ({ waypoints, struck: [] });

test("trail store: round trip, idempotent retry, bad and foreign lines skipped, file only ever appended", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-delegate-trail-store-"));
	const session = join(dir, "session.jsonl");
	try {
		await writeFile(session, "{}\n");
		const file = trailFile(session);
		assert.equal(file, join(dir, "session.trail"), "sits beside the transcript and must not look like one");
		const foreign = JSON.stringify({ type: "waypoint", ...wp("other:w1", "set_out", "elsewhere", "another session's work"), sessionId: "someone-else" }) + "\n";
		const prefix = foreign + "{not json\n" + JSON.stringify({ type: "waypoint", id: "bad", sessionId, at: 1, kind: "wander", line: "x", refs: ["a"], caption: "c", parent: null, by: "mom" }) + "\n";
		await writeFile(file, prefix + '{"type":"waypoint","id":"torn"'); // a crashed writer's unfinished line

		const store = new TrailStore(() => session, sessionId);
		assert.deepEqual(await store.load(), [], "a torn tail and bad lines yield nothing, not an error");
		assert.equal(store.skipped.length, 2, "both complete bad lines reported; the torn tail is not complete yet");
		assert.match(store.skipped[1], /unknown waypoint kind/);

		const w1 = wp("job:w1", "set_out", "trail", "Build the trail store");
		const w2 = wp("job:w2", "learned", "trail", "The sidecar's IO is the pattern to copy");
		const s1 = strike("user:s1", "job:w2", { reason: "wrong line" });
		assert.deepEqual(await store.appendWaypoint(w1), w1);
		assert.deepEqual(await store.appendWaypoint(w2), w2);
		assert.deepEqual(await store.appendStrike(s1), s1);
		const retried = await store.appendWaypoint({ ...w1, caption: "a retry with different words" });
		assert.equal(retried.caption, w1.caption, "an id already on the trail returns what was recorded");

		const text = await readFile(file, "utf8");
		assert.ok(text.startsWith(prefix + '{"type":"waypoint","id":"torn"\n'), "existing bytes are never rewritten; the torn line is finished, not removed");
		const written = text.slice(prefix.length).split("\n").filter(Boolean);
		assert.equal(written.length, 4, "torn line, two waypoints, one strike; the retry wrote nothing");
		assert.deepEqual(JSON.parse(written[1]), { type: "waypoint", ...w1 });

		const fresh = new TrailStore(() => session, sessionId);
		const records = await fresh.load();
		assert.deepEqual(records.map(r => r.id), ["job:w1", "job:w2", "user:s1"], "other sessions' records are ignored");
		assert.equal(fresh.skipped.length, 3, "the finished torn line is now a complete unreadable line");
		assert.deepEqual(records[2], { type: "strike", ...s1 });

		// Another writer appended behind this instance's back: invalidate() makes the next load see it.
		await appendFile(file, JSON.stringify({ type: "waypoint", ...wp("job:w3", "open", "trail", "Write the tests") }) + "\n");
		assert.equal((await fresh.load()).length, 3, "cached until told otherwise");
		fresh.invalidate();
		assert.equal((await fresh.load()).length, 4);

		await assert.rejects(new TrailStore(() => undefined, sessionId).appendWaypoint(w1), /persisted session file/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("trailFor scopes to the branch and applies strikes", () => {
	const onBranch = wp("a", "set_out", "trail", "root", { parent: "leaf-1" });
	const rootless = wp("b", "decided", "trail", "parent null is always ours", { parent: null });
	const elsewhere = wp("c", "decided", "trail", "recorded on another branch", { parent: "leaf-other" });
	const struckOne = wp("d", "open", "trail", "a question we withdrew", { parent: "leaf-2" });
	const records: TrailRecord[] = [
		{ type: "waypoint", ...onBranch }, { type: "waypoint", ...rootless }, { type: "waypoint", ...elsewhere }, { type: "waypoint", ...struckOne },
		{ type: "strike", ...strike("s-off", "b", { parent: "leaf-other" }) }, // a strike off the branch does not strike
		{ type: "strike", ...strike("s-d", "d", { parent: "leaf-2", reason: "answered itself" }) },
		{ type: "strike", ...strike("s-unknown", "c") }, // names a waypoint that is not on this trail
	];
	const trail = trailFor(records, new Set(["leaf-1", "leaf-2"]));
	assert.deepEqual(trail.waypoints.map(w => w.id), ["a", "b"]);
	assert.deepEqual(trail.struck.map(entry => [entry.waypoint.id, entry.strike.id, entry.strike.reason]), [["d", "s-d", "answered itself"]]);
	assert.deepEqual(trailFor(records, new Set()).waypoints.map(w => w.id), ["b"], "with nothing selected only parentless records remain");
});

// A journey: set out, learn, detour (A), raise a question on A, detour again (B) inside A, learn on B,
// return to A, answer the question, decide on A, return to the root, reframe the goal, hit a dead end.
const journey = (() => {
	const all = [
		wp("j:w1", "set_out", "Trail mode", "Replace the graph with an append-only trail"),
		wp("j:w2", "learned", "Trail mode", "The sidecar already has the locking discipline the trail needs"),
		wp("j:w3", "detour", "Lockfile bug", "Stopped to chase a stale lock left by a crashed oven"),
		wp("j:w4", "open", "Lockfile bug", "Does proper-lockfile reclaim a stale lock on its own?"),
		wp("j:w5", "detour", "Flaky test", "Sidecar test failed on the way; looking at it first"),
		wp("j:w6", "learned", "Flaky test", "Failure came from a shared temp dir, not the lock"),
		wp("j:w7", "returned", "Lockfile bug", "Back to the lock after isolating the test", { closes: "j:w5" }),
		wp("j:w8", "closed", "Lockfile bug", "Stale locks are reclaimed after 15s", { closes: "j:w4" }),
		wp("j:w9", "decided", "Lockfile bug", "Keep the 15s stale window; retries cover the gap"),
		wp("j:w10", "returned", "Trail mode", "Back on the trail work with the lock understood", { closes: "j:w3" }),
		wp("j:w11", "reframed", "Trail mode", "The trail replaces the graph entirely rather than sitting beside it", { supersedes: "j:w1" }),
		wp("j:w12", "dead_end", "Cache idea", "Caching projections saved nothing measurable; dropped"),
	];
	return { all, upTo: (n: number) => asTrail(all.slice(0, n)), byId: (id: string) => all.find(w => w.id === id)! };
})();

test("journey: current line and the detour stack at each depth", () => {
	assert.equal(whereWeAre(asTrail([])).currentLine, undefined);
	assert.equal(renderStanding(asTrail([])), "", "an empty trail has no standing");

	const twoDeep = journey.upTo(6);
	const standing = whereWeAre(twoDeep);
	assert.equal(standing.currentLine, "Flaky test");
	assert.deepEqual(standing.detours.map(d => [d.detour.id, d.returnTo]), [["j:w3", "Trail mode"], ["j:w5", "Lockfile bug"]], "outermost first, innermost last");
	assert.equal(standing.goal?.id, "j:w1");

	const oneDeep = journey.upTo(8);
	assert.equal(whereWeAre(oneDeep).currentLine, "Lockfile bug");
	assert.deepEqual(whereWeAre(oneDeep).detours.map(d => d.detour.id), ["j:w3"]);

	const home = journey.upTo(11);
	assert.equal(whereWeAre(home).currentLine, "Trail mode");
	assert.deepEqual(whereWeAre(home).detours, []);
	assert.equal(whereWeAre(home).goal?.id, "j:w11", "the reframed goal replaces the set_out");

	const done = asTrail(journey.all);
	assert.equal(whereWeAre(done).currentLine, "Cache idea");
	assert.deepEqual(whereWeAre(done, 2).recent.map(w => w.id), ["j:w11", "j:w12"]);
});

test("journey: before the last detour, two deep, points at the last waypoint on A", () => {
	const before = beforeLastDetour(journey.upTo(6));
	assert.ok(before);
	assert.equal(before.detour.id, "j:w5");
	assert.equal(before.line.name, "Lockfile bug");
	assert.equal(before.last?.id, "j:w4");
	assert.match(renderBefore(before), /we were on: Lockfile bug/);
	assert.match(renderBefore(before), /last there \d\d:\d\d open: Does proper-lockfile/);

	const outer = beforeLastDetour(journey.upTo(8));
	assert.equal(outer?.detour.id, "j:w3");
	assert.equal(outer?.line.name, "Trail mode");
	assert.equal(outer?.last?.id, "j:w2");
	assert.equal(beforeLastDetour(journey.upTo(11)), undefined, "nothing open once every detour has returned");
	assert.equal(renderBefore(undefined), "No open detour; nothing to return to.");
});

test("journey: lines, landing and open items", () => {
	const done = asTrail(journey.all);
	const views = lines(done);
	assert.deepEqual(views.map(v => [v.name, v.status, v.detour, v.returnTo, v.count]), [
		["Trail mode", "quiet", false, undefined, 4],
		["Lockfile bug", "returned", true, "Trail mode", 5],
		["Flaky test", "returned", true, "Lockfile bug", 2],
		["Cache idea", "dead_end", false, undefined, 1],
	]);
	assert.equal(views[0].goal?.id, "j:w11");
	assert.equal(lines(journey.upTo(11))[0].status, "open", "the line we are on is open");
	assert.equal(lines(journey.upTo(9))[1].status, "landed", "a decided on an unclosed detour: landed");
	assert.equal(lines(journey.upTo(4))[1].status, "open", "an unanswered question keeps a line open");

	const landed = landing(done, "lockfile");
	assert.equal(landed.length, 1);
	assert.equal(landed[0].landed?.id, "j:w9", "the decided is where A landed");
	assert.equal(landed[0].lastTouched.id, "j:w9");
	assert.match(renderLanding(landed), /^Lockfile bug \(returned\)\n  landed \d\d:\d\d decided: Keep the 15s stale window; retries cover the gap \[src:lead:j:w9\]$/);
	assert.equal(landing(done, "temp dir")[0]?.line.name, "Flaky test", "falls back to captions when no line name matches");
	assert.equal(landing(done, "nothing like this").length, 0);
	assert.equal(renderLanding([]), "Nothing on the trail matches.");
	const early = landing(journey.upTo(2), "trail mode");
	assert.equal(early[0].landed?.id, "j:w2", "a learned counts as landing");
	assert.match(renderLanding(landing(journey.upTo(1), "trail")), /never landed; last touched \d\d:\d\d: Replace the graph/);

	assert.deepEqual(openItems(journey.upTo(7)).map(g => [g.line, g.items.map(w => w.id)]), [["Lockfile bug", ["j:w4"]]]);
	assert.deepEqual(openItems(journey.upTo(7), "lockfile BUG").length, 1, "line filter matches case-insensitively");
	assert.deepEqual(openItems(journey.upTo(7), "Trail mode"), []);
	assert.deepEqual(openItems(journey.upTo(8)), [], "closed by the closed that names it");
	assert.match(renderOpen(openItems(journey.upTo(7))), /^Lockfile bug:\n  \d\d:\d\d Does proper-lockfile reclaim a stale lock on its own\? \[src:lead:j:w4\]$/);
	assert.equal(renderOpen([]), "No open items.");
});

test("journey: the glance carries the crumbs, the detour we are on, its open items and the latest waypoint; depths follow the open detours", () => {
	const twoDeep = glance(journey.upTo(6));
	assert.equal(twoDeep.goal?.id, "j:w1");
	assert.deepEqual(twoDeep.crumbs, ["Trail mode", "Lockfile bug", "Flaky test"]);
	assert.deepEqual([twoDeep.current?.detour.id, twoDeep.current?.returnTo], ["j:w5", "Lockfile bug"]);
	assert.deepEqual(twoDeep.open, [], "the open question is on Lockfile bug, not the thread we are on");
	assert.equal(twoDeep.last?.id, "j:w6");
	assert.equal(twoDeep.depth, 2);
	const onA = glance(journey.upTo(4));
	assert.deepEqual([onA.crumbs, onA.open.map(w => w.id), onA.depth], [["Trail mode", "Lockfile bug"], ["j:w4"], 1]);
	const home = glance(asTrail(journey.all));
	assert.deepEqual([home.goal?.id, home.crumbs, home.current, home.depth, home.last?.id], ["j:w11", ["Trail mode"], undefined, 0, "j:w12"]);
	const shape = (view: ReturnType<typeof glance>) => view.tree && { goal: view.tree.goal.id, before: view.tree.before.map(w => w.id),
		levels: view.tree.levels.map(level => ({ head: level.head.id, open: level.open.map(w => w.id), ...(level.from ? { from: level.from.id } : {}), ...(level.done ? { done: [level.done.waypoint.id, level.done.kind] } : {}) })) };
	assert.deepEqual(shape(twoDeep), { goal: "j:w1", before: [], levels: [{ head: "j:w1", open: [] }, { head: "j:w3", open: ["j:w4"] }, { head: "j:w5", open: [] }] },
		"the tree: the goal, then each open detour nested in the one it left, an open item under the level it was raised in; nothing finished yet");
	assert.deepEqual(shape(glance(journey.upTo(9))), { goal: "j:w1", before: [], levels: [{ head: "j:w1", open: [] }, { head: "j:w3", open: [], done: ["j:w9", "decided"] }] },
		"a finished detour and a closed item are gone; only the latest finished thing shows, where it happened");
	assert.deepEqual(shape(home), { goal: "j:w11", before: ["j:w1"], levels: [{ head: "j:w11", open: [], done: ["j:w3", "returned"] }] },
		"back home under the changed goal, the old goal as what led there; the latest finished thing reads as the detour it ended");
	const reframes = asTrail([...journey.all, wp("j:w13", "reframed", "Trail mode", "Ship the trail as the default mode"), wp("j:w14", "reframed", "Trail mode", "Make the trail the only mode")]);
	assert.deepEqual(shape(glance(reframes))!.before, ["j:w13", "j:w11", "j:w1"], "the goals that led here, newest first");
	const newThread = asTrail([wp("n:w1", "set_out", "Ledger", "Build the portable ledger"), wp("n:w2", "set_out", "Hop integration", "Run the ledger from Hop")]);
	assert.deepEqual([shape(glance(newThread))!.goal, shape(glance(newThread))!.before], ["n:w2", ["n:w1"]], "a set_out on a new thread is the current goal, whatever thread it is on");
	const finding = wp("s:w3", "learned", "Ledger", "OpenCode cannot receive messages");
	const answered = { waypoints: [wp("s:w1", "set_out", "Ledger", "Build it"), wp("s:w2", "open", "Ledger", "Is MCP elicitation a handoff?"), wp("s:w5", "detour", "receiver", "Build a receiver", { from: "s:w3" })],
		entries: [] as Waypoint[], struck: [] } as Trail;
	answered.entries = [answered.waypoints[0]!, answered.waypoints[1]!, finding, wp("s:w4", "closed", "Ledger", "Elicitation cannot target another session", { closes: "s:w2", step: true }), answered.waypoints[2]!];
	assert.deepEqual(shape(glance(answered)), { goal: "s:w1", before: [], levels: [{ head: "s:w1", open: [], done: ["s:w2", "closed"] }, { head: "s:w5", open: [], from: "s:w3" }] },
		"a step that closes a parked question closes it; a detour carries the finding that led to it");
	assert.deepEqual(glance(asTrail([])), { goal: undefined, opening: undefined, changed: false, crumbs: [], current: undefined, open: [], tree: undefined, parked: [], last: undefined, depth: 0 });
	assert.deepEqual(depths(asTrail(journey.all)), [0, 0, 0, 1, 1, 2, 1, 1, 1, 0, 0, 0], "a detour sits where it left; a returned sits where it resumes");
});

test("journey: evolution keeps the superseded set_out; current() drops it", () => {
	const done = asTrail(journey.all);
	assert.deepEqual(evolution(done).map(w => w.id), ["j:w1", "j:w11"]);
	assert.ok(!current(done).some(w => w.id === "j:w1"));
	assert.equal(current(done).length, journey.all.length - 1);
	assert.match(renderEvolution(evolution(done)), /^\d\d:\d\d set_out · Replace the graph[^\n]*\n\d\d:\d\d reframed · The trail replaces the graph/);
	assert.equal(renderEvolution([]), "No goal recorded yet.");
});

test("journey: standing and trail rendering", () => {
	const twoDeep = journey.upTo(6);
	const standing = renderStanding(twoDeep).split("\n");
	assert.equal(standing[0], "Path's trail — where we are (descriptive, not direction):");
	assert.equal(standing[1], "Set out: Replace the graph with an append-only trail [src:lead:j:w1]");
	assert.equal(standing[2], "Detour 2 deep: Sidecar test failed on the way; looking at it first — return to: Lockfile bug [src:lead:j:w5]");
	assert.equal(standing[3], "Detour 1 deep: Stopped to chase a stale lock left by a crashed oven — return to: Trail mode [src:lead:j:w3]");
	assert.match(standing[4], /^Last: \d\d:\d\d learned Failure came from a shared temp dir, not the lock \[src:lead:j:w6\]$/);
	assert.equal(standing.length, 5, "no footer");
	assert.doesNotMatch(renderStanding(journey.upTo(5)), /\nLast:/, "the latest waypoint is the innermost detour, already shown");
	assert.doesNotMatch(renderStanding(journey.upTo(1)), /\nLast:/, "the latest waypoint is the goal, already shown");
	assert.match(renderStanding(journey.upTo(2)), /\nLast: \d\d:\d\d learned/);

	const onA = renderStanding(journey.upTo(4));
	assert.match(onA, /\nOpen on this line: Does proper-lockfile reclaim a stale lock on its own\? \[src:lead:j:w4\]\n/);
	assert.ok(renderStanding(asTrail(journey.all)).split("\n").length <= 10);
	assert.match(renderStanding(asTrail(journey.all)), /^Path's trail .*\nSet out \(reframed\): The trail replaces/);

	const done: Trail = { waypoints: journey.all, struck: [{ waypoint: wp("j:w13", "learned", "Cache idea", "struck and gone"), strike: strike("s", "j:w13") }] };
	const whole = renderTrail(done);
	assert.equal(whole.split("\n").length, 12, "struck waypoints are not in the trail");
	assert.match(whole.split("\n")[0], /^\d\d:\d\d set_out · Trail mode · Replace the graph with an append-only trail \[src:lead:j:w1\]$/);
	assert.deepEqual(renderTrail(done, { line: "flaky test" }).split("\n").map(l => l.split(" · ")[1]), ["Flaky test", "Flaky test"]);
	assert.equal(renderTrail(done, { limit: 2 }).split("\n").length, 2);
	assert.equal(renderTrail(done, { since: journey.byId("j:w11").at }).split("\n").length, 2);
	assert.equal(renderTrail(asTrail([])), "");
	const multi = wp("m", "learned", "L", "two refs", { refs: ["lead:1", "scout:2:b1"] });
	assert.match(renderWaypoint(multi), /^\d\d:\d\d learned · L · two refs \[src:lead:1\] \[src:scout:2:b1\]$/);
	assert.equal(renderWaypoint(multi, { time: false, line: false }), "learned · two refs [src:lead:1] [src:scout:2:b1]");
});

test("validateWaypointInputs: unobserved refs, closes kinds, and links within one commit", () => {
	const observed = new Set(["lead:1", "lead:2"]);
	const existing = [{ id: "j:w2", kind: "learned" as const }, { id: "j:w3", kind: "detour" as const }];
	const idFor = (index: number) => `job:w${index + 1}`;
	const base = { line: "L", caption: "c", refs: ["lead:1"] };

	const unobserved = validateWaypointInputs({ waypoints: [{ ...base, kind: "learned", refs: ["lead:9"] }] }, existing, observed, idFor);
	assert.deepEqual(unobserved.defects, ["waypoints[0] cites unobserved source lead:9"]);

	const wrongKind = validateWaypointInputs({ waypoints: [{ ...base, kind: "returned", closes: "j:w2" }] }, existing, observed, idFor);
	assert.deepEqual(wrongKind.defects, ["waypoints[0].closes must name detour, not learned j:w2"]);
	assert.deepEqual(validateWaypointInputs({ waypoints: [{ ...base, kind: "returned", closes: "j:w3" }] }, existing, observed, idFor).defects, []);

	const sameCommit = validateWaypointInputs({ waypoints: [
		{ ...base, kind: "detour", line: "side" },
		{ ...base, kind: "returned", refs: ["lead:2"], closes: idFor(0) },
	] }, existing, observed, idFor);
	assert.deepEqual(sameCommit.defects, [], "a returned may close a detour recorded earlier in the same commit");
	assert.equal(sameCommit.inputs.length, 2);
	assert.match(validateWaypointInputs({ waypoints: [{ ...base, kind: "returned", closes: idFor(5) }] }, existing, observed, idFor).defects[0], /names unknown waypoint/);
});

test("a waypoint cites the user turn that made it; findings, dead ends and unbacked directions are steps", () => {
	const user = new Set(["s:u1", "s:u2"]);
	const w = (kind: string, refs: string[], extra: Record<string, string> = {}) => ({ kind, line: "Hop", refs, caption: "c", ...extra }) as never;
	const inputs = [w("set_out", ["s:u1", "s:a1"]), w("learned", ["s:u2"], { supersedes: "x" }), w("open", ["s:a3"]), w("closed", ["s:u2"], { closes: "j:w2" }),
		w("decided", ["s:u2"], { supersedes: "j:w1" }), w("dead_end", ["s:u2", "s:a4"])];
	const { waypoints, steps } = sortTiers(inputs, i => `j:w${i}`, ref => user.has(ref));
	assert.deepEqual(waypoints.map(k => k.index), [0, 4], "the goal and the user's decision are waypoints; ids keep their call index");
	assert.equal(waypoints[1]!.input.supersedes, undefined, "a link to a step is dropped");
	assert.deepEqual(steps.map(k => k.index), [1, 2, 3, 5], "a finding and a dead end are steps even when a user turn is cited; so is an open nobody parked, and its close");
	assert.ok(steps.every(k => k.input.closes === undefined && k.input.supersedes === undefined), "steps keep no links");
});

test("trailFor keeps steps out of the waypoints and in the entries, older files included", () => {
	const at = 1;
	const rec = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({ type: "waypoint", id, sessionId: "s", at, kind, line: "L", refs: ["s:1"], caption: id, parent: null, by: "mom", ...extra }) as TrailRecord;
	const trail = trailFor([rec("a", "set_out"), rec("b", "learned"), rec("c", "open", { step: true }), rec("d", "learned", { by: "user" }), rec("e", "dead_end")], new Set());
	assert.deepEqual(trail.waypoints.map(w => w.id), ["a", "d"], "a finding the user marked stays a waypoint");
	assert.deepEqual(trail.entries?.map(w => w.id), ["a", "b", "c", "d", "e"]);
	assert.equal(trailFor([rec("a", "set_out")], new Set()).entries, undefined, "no steps, no entries list");
});

// ---- transcript order (backfill) ----
const rec = (w: Waypoint, parent: string | null = null): TrailRecord => ({ type: "waypoint", ...w, parent });
const branchOf = (...ids: string[]) => new Set(ids);

test("trailFor orders backfilled records by transcript position, not file order", () => {
	const branch = branchOf("e1", "e2", "e3", "e4", "e5");
	const records = [
		rec(wp("late", "decided", "main", "Decided", { refs: ["lead:e5"] })),
		rec(wp("early", "set_out", "main", "Goal", { refs: ["lead:e1"] })),
		rec(wp("mid", "detour", "side", "Detour", { refs: ["lead:e3:b2"] })),
		{ type: "strike", ...strike("s1", "mid"), parent: null } as TrailRecord,
	];
	const trail = trailFor(records, branch);
	assert.deepEqual(trail.waypoints.map(w => w.id), ["early", "late"]);
	assert.deepEqual(trail.struck.map(s => s.waypoint.id), ["mid"]);
	const all = trailFor(records.slice(0, 3), branch);
	assert.deepEqual(all.waypoints.map(w => w.id), ["early", "mid", "late"]);
});

test("anchor beats refs; smallest ref index wins otherwise; worker-only refs keep file-relative position", () => {
	const branch = branchOf("a", "b", "c", "d");
	const records = [
		rec(wp("x", "decided", "main", "x", { refs: ["lead:d"] })),
		rec(wp("anchored", "set_out", "main", "anchored", { anchor: "a", refs: ["lead:c"] })),
		rec(wp("multi", "decided", "main", "multi", { refs: ["lead:d", "lead:b"] })),
		rec(wp("worker", "learned", "main", "worker", { refs: ["worker:zz"], by: "mom" })),
		rec(wp("offbranch", "decided", "main", "off", { anchor: "nope", refs: ["lead:c"] })),
	];
	const trail = trailFor(records, branch);
	assert.deepEqual(trailEntries(trail).map(w => w.id), ["anchored", "multi", "worker", "offbranch", "x"]);
});

test("a returned without closes closes the innermost open detour", () => {
	const waypoints = [
		wp("g", "set_out", "main", "Goal"),
		wp("d1", "detour", "one", "First"),
		wp("d2", "detour", "two", "Second"),
		wp("r", "returned", "one", "Back"),
	];
	assert.deepEqual(whereWeAre(asTrail(waypoints)).detours.map(d => d.detour.id), ["d1"]);
	assert.equal(glance(asTrail(waypoints)).depth, 1);
	assert.deepEqual(depths(asTrail(waypoints)), [0, 0, 1, 1]);
	assert.equal(lines(asTrail(waypoints)).find(l => l.name === "two")!.status, "returned");
});

test("a live returned recorded before its backfilled detour still closes it", () => {
	const branch = branchOf("e1", "e2", "e3");
	const trail = trailFor([
		rec(wp("g", "set_out", "main", "Goal", { refs: ["lead:e1"] })),
		rec(wp("r", "returned", "main", "Back", { refs: ["lead:e3"] })),
		rec(wp("d", "detour", "side", "Away", { refs: ["lead:e2"] })),
	], branch);
	assert.deepEqual(trail.waypoints.map(w => w.id), ["g", "d", "r"]);
	assert.equal(whereWeAre(trail).detours.length, 0);
});

test("an explicit closes still wins over the innermost rule", () => {
	const waypoints = [
		wp("g", "set_out", "main", "Goal"),
		wp("d1", "detour", "one", "First"),
		wp("d2", "detour", "two", "Second"),
		wp("r", "returned", "one", "Back", { closes: "d1" }),
	];
	assert.deepEqual(whereWeAre(asTrail(waypoints)).detours.map(d => d.detour.id), ["d2"]);
	assert.deepEqual(depths(asTrail(waypoints)), [0, 0, 1, 1]);
});

test("store keeps a string anchor", async () => {
	const dir = await mkdtemp(join(tmpdir(), "trail-anchor-"));
	try {
		const session = join(dir, "s.jsonl");
		await writeFile(trailFile(session), JSON.stringify({ type: "waypoint", ...wp("a", "set_out", "main", "x", { anchor: "d462cc4d", sessionId }) }) + "\n"
			+ JSON.stringify({ type: "waypoint", ...wp("b", "set_out", "main", "y", { anchor: 5 as unknown as string, sessionId }) }) + "\n");
		const loaded = await new TrailStore(() => session, sessionId).load();
		assert.deepEqual(loaded.map(r => (r as Waypoint).anchor), ["d462cc4d", undefined]);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("the glance keeps the opening goal; a reframe is marked, not swapped in", () => {
	const start = wp("j:w0", "set_out", "Agents", "Review the reverse-engineering work for ideas to adopt");
	const later = wp("j:w1", "reframed", "Agents", "Agent rows must keep spawn order", { supersedes: "j:w0" });
	const view = glance(asTrail([start, later]));
	assert.equal(view.opening?.id, "j:w0", "the widget shows what the session set out to do");
	assert.equal(view.goal?.id, "j:w1", "the current goal is still known to the standing and the Trail tab");
	assert.equal(view.changed, true);
	assert.equal(glance(asTrail([start])).changed, false);
});

test("titles: a waypoint's own title, a later title record that renames it, and a label fallback for the rest", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-delegate-trail-titles-"));
	const session = join(dir, "session.jsonl");
	try {
		await writeFile(session, "{}\n");
		const store = new TrailStore(() => session, sessionId);
		await store.appendWaypoint(wp("t:w1", "set_out", "Trail glance", "Make the widget glanceable."));
		await store.appendWaypoint(wp("t:w2", "decided", "Trail glance", "Show short labels in the widget, never captions.", { title: "Labels, not captions" }));
		await store.appendWaypoint(wp("t:w3", "decided", "Trail glance", "Spin Path's symbol beside its title; repaint on a clock while it works."));
		const title = (id: string, target: string, text: string) => ({ id, sessionId, at: (clock += 60_000), target, title: text, parent: null });
		await store.appendTitle(title("t:t0", "t:w3", "Spinner by title"));
		await store.appendTitle(title("t:t1", "t:w3", "Spinner beside the title"));
		await store.appendTitle(title("t:t2", "t:w2", "Overwritten?"));
		await store.appendTitle(title("t:t3", "nowhere", "Nothing to title"));
		assert.equal((await readFile(trailFile(session), "utf8")).trim().split("\n").length, 7, "titles are appended records; no waypoint is rewritten");
		const trail = trailFor(await new TrailStore(() => session, sessionId).load(), new Set());
		assert.deepEqual(trail.waypoints.map(w => w.title), [undefined, "Overwritten?", "Spinner beside the title"], "the latest title record wins, over a waypoint's own title too (a repair renames)");
		assert.deepEqual(trail.waypoints.map(label), ["Trail glance", "Overwritten?", "Spinner beside the title"], "an untitled goal reads as its thread name");
	} finally { await rm(dir, { recursive: true, force: true }); }
	assert.equal(label(wp("x", "decided", "l", "Drive Amp over stdin: echo the prompt rather than pass it.")), "Drive Amp over stdin", "the first clause");
	assert.equal(label(wp("x", "decided", "l", "Approve proceeding with the single-PTY plan so Claude Code can be spawned too")), "Approve proceeding with the…", "cut at a word");
	const { inputs, titles, defects } = validateWaypointInputs({
		waypoints: [{ kind: "decided", line: "l", refs: ["lead:a"], caption: "c", title: "  " }],
		titles: [{ id: "known", title: "  Two words " }, { id: "unknown", title: "Dropped" }],
	}, [{ id: "known", kind: "decided" }], new Set(["lead:a"]), index => `j:w${index}`);
	assert.deepEqual(defects, []);
	assert.equal(inputs[0]!.title, undefined, "a blank title is no title");
	assert.deepEqual(titles, [{ id: "known", title: "Two words" }], "titles for ids the trail does not hold are dropped, not defects");
	assert.ok(validateWaypointInputs({ waypoints: [{ kind: "decided", line: "l", refs: ["lead:a"], caption: "c", title: "x".repeat(41) }] }, [], new Set(["lead:a"]), i => `${i}`).defects.length, "a title is at most 40 characters");
});
