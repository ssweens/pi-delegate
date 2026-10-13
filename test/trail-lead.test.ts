import "./setup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Trail, Waypoint, WaypointKind } from "../src/trail/types.ts";
import { glance, renderStanding } from "../src/trail/projection.ts";
import { standingKey, trailText } from "../src/mom/client.ts";
import { momSectionLines, momToolPreview, MomView, type PanelView, functionKey } from "../src/ui/panel.ts";
import { renderTrailTab, statusSlot, TrailBrowser } from "../src/ui/trail-view.ts";

const theme = {
	fg: (_color: string, text: string) => text, bold: (text: string) => `*${text}*`, bg: (_color: string, text: string) => `[${text}]`,
	dim: (text: string) => text, strikethrough: (text: string) => text,
} as unknown as Theme;
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const MODEL_WORDS = /waypoint|set_out|dead_end|cursor|coverage|standing|job:w\d/i;

/** A journey: a goal, a finding, a detour (still open) with its own waypoints, and an open step on the root line. */
function fixture(): Trail {
	let n = 0;
	const at = Date.UTC(2026, 9, 11, 9, 0) + 0;
	const point = (kind: WaypointKind, line: string, caption: string, extra: Partial<Waypoint> = {}): Waypoint =>
		({ id: `job:w${++n}`, sessionId: "s1", at: at + n * 60_000, kind, line, refs: [`s1:e${n}`], caption, parent: `e${n}`, by: "mom", ...extra });
	const waypoints = [
		point("set_out", "trail reader", "Build the lead-side reader for Path's trail."),
		point("learned", "trail reader", "The panel's tabs are keyed F1 to F3; F2 is the map."),
		point("open", "trail reader", "Still to do: the widget's where-we-are rows."),
		point("decided", "trail reader", "Reuse the source reader pane for trail refs rather than a new pane.", { title: "Reuse the source pane" }),
		point("detour", "flaky test", "Left the reader to chase a flaky terminal smoke test."),
		point("learned", "flaky test", "The smoke test races the renderer; it needs a settle."),
		point("open", "flaky test", "Decide whether the settle belongs in the fixture.", { by: "user" }),
		point("dead_end", "flaky test", "Sleeping 50ms did not fix the race."),
	];
	return { waypoints, struck: [] };
}
const trailView = (trail: Trail, status: string, extra: Partial<PanelView> = {}): PanelView =>
	({ status, summary: "", ...extra, trail: { glance: glance(trail), count: trail.waypoints.length } });

test("the Trail tab shows the goal and the open detour on top, then every entry at its depth with the selected row marked", () => {
	const trail = fixture();
	const lines = renderTrailTab(trail, theme, 120, 4, { symbol: "⠹", word: "reading" });
	const text = plain(lines);
	assert.match(lines[0]!, /^ ◎ \*Build the lead-side reader for Path's trail\.\* +⠹ reading$/, "the goal, Path's state at the far right");
	assert.match(lines[1]!, /^ └↳ Left the reader to chase a flaky terminal smoke test\. +then back to trail reader$/);
	assert.match(lines[2]!, /^ ─+$/);
	assert.doesNotMatch(text, MODEL_WORDS);
	const rows = lines.slice(lines.length - trail.waypoints.length);
	assert.equal(rows.length, 8);
	assert.match(rows[0]!, /^ \d\d:\d\d  ◎ Build the lead-side reader/, "a goal is a heading at depth 0");
	assert.match(rows[3]!, /^ \d\d:\d\d    ◆ Reuse the source reader pane/, "what happens under a goal sits one in");
	assert.match(rows[4]!, /^\[ \d\d:\d\d    ▸ ↳ \*Left the reader.*\]$/, "the selected row is marked and highlighted; a detour sits at the depth it left");
	assert.match(rows[6]!, /^ \d\d:\d\d      □ Decide whether the settle/, "entries inside the detour are indented one more");
	assert.match(rows[7]!, /^ \d\d:\d\d        ✗ Sleeping 50ms/, "a step one deeper than the waypoints around it");
	assert.ok(rows.every((row, index) => index === 4 || !row.includes("▸")), "only the selected row carries the marker");
	assert.doesNotMatch(text, /\[src:/, "no transcript ids on the tab");
	const empty = plain(renderTrailTab({ waypoints: [], struck: [] }, theme, 80, 0));
	assert.match(empty, /Nothing on the trail yet/);
	assert.doesNotMatch(empty, /─/);
});

test("a came-back row sits at the depth of the thread it resumes, and a done item is dim", () => {
	const trail = fixture();
	let n = trail.waypoints.length;
	const at = trail.waypoints.at(-1)!.at;
	const more: Waypoint[] = [
		{ id: `job:w${++n}`, sessionId: "s1", at: at + 60_000, kind: "returned", line: "trail reader", refs: ["s1:e9"], caption: "Back to the reader with the race understood.", closes: "job:w5", parent: "e9", by: "mom" },
		{ id: `job:w${++n}`, sessionId: "s1", at: at + 120_000, kind: "closed", line: "trail reader", refs: ["s1:e10"], caption: "The widget block is in.", closes: "job:w3", parent: "e10", by: "mom" },
	];
	const lines = renderTrailTab({ waypoints: [...trail.waypoints, ...more], struck: [] }, theme, 120, 9);
	assert.doesNotMatch(plain(lines.slice(0, 3)), /└↳/, "no detour is open, so none is stacked on top");
	const rows = lines.slice(-10);
	assert.match(rows[8]!, /^ \d\d:\d\d    ↰ Back to the reader/, "the returned row is back under the goal");
	assert.match(rows[9]!, /^\[ \d\d:\d\d    ▸ ■ The widget block is in\. *\]$/);
});

test("the trail browser moves within the entries, lands on the newest, windows around the selection, and describes one in plain words", () => {
	const trail = fixture();
	const browser = new TrailBrowser(trail);
	assert.equal(browser.selectedWaypoint()?.id, "job:w8", "a fresh trail selects the newest entry");
	browser.move(-3);
	assert.equal(browser.selectedWaypoint()?.id, "job:w5");
	browser.move(-100);
	assert.equal(browser.selectedWaypoint()?.id, "job:w1");
	browser.move(100);
	assert.equal(browser.selectedWaypoint()?.id, "job:w8");
	const window = browser.render(theme, 100, 3);
	assert.equal(window.length, 3);
	assert.match(plain(window), /Sleeping 50ms/, "the selected row is within the window");
	browser.move(-1);
	const details = plain(browser.details(theme));
	assert.match(details, /^□ \*Decide whether the settle belongs in the fixture\.\*\nopen · flaky test · \d\d:\d\d · marked by you\nin transcript …e7$/);
	assert.doesNotMatch(details, MODEL_WORDS);
	browser.update({ waypoints: trail.waypoints.slice(0, 4), struck: [] });
	assert.equal(browser.selectedWaypoint()?.id, "job:w4", "a struck selection falls back to the newest remaining entry");
	assert.match(plain(browser.details(theme)), /\ndecision · trail reader · \d\d:\d\d\nin transcript …e4$/);
	assert.equal(new TrailBrowser(undefined).selectedWaypoint(), undefined);
	assert.deepEqual(new TrailBrowser(undefined).details(theme), []);
});

test("the widget is a tree: the goal, what is open under it, the detour we are on nested in it, and only the latest finished thing", () => {
	const trail = fixture();
	const work = { endeavors: [{ id: "e", label: "An endeavor from the graph", state: "active", parent: null, annotations: [], sources: [], kind: "feature", intent: "" }], unattachedAnnotations: [], connections: [], outside: [], focusPath: [], totalRecords: 1 } as any;
	const view = trailView(trail, "up to date", { work, complete: true });
	const lines = momSectionLines(view, theme, 140);
	assert.match(plain([lines[0]!]), /^\*Path\* ✓ \d+[mhd]$/, "Path's state is beside the title, not on a content row");
	const body = lines.slice(1);
	assert.doesNotMatch(plain(body), /An endeavor from the graph/, "no graph hierarchy in trail mode");
	assert.doesNotMatch(plain(body), MODEL_WORDS);
	assert.equal(body.length, 5, "the task list and nothing else: no slice link in trail mode");
	assert.equal(body[0], "◎ trail reader", "the goal; untitled, it reads as its thread name");
	assert.equal(body[1], "  □ Still to do", "what is still to do under the goal, one per row");
	assert.match(body[2]!, /^  ✓ Reuse the source pane +\d+[mhd]$/, "the latest finished thing, by title, with its age");
	assert.equal(body[3], "  ↳ *flaky test*", "the detour we are on, nested and bold");
	assert.equal(body[4], "    □ Decide whether the settle…", "what is to do inside the detour");
	assert.doesNotMatch(plain(body), /rather than a new pane|Sleeping|smoke test races/, "captions and steps stay in the detail page");

	let n = trail.waypoints.length;
	const at = trail.waypoints.at(-1)!.at;
	const point = (kind: WaypointKind, line: string, caption: string, extra: Partial<Waypoint> = {}): Waypoint =>
		({ id: `job:w${++n}`, sessionId: "s1", at: at + n * 60_000, kind, line, refs: [`s1:e${n}`], caption, parent: `e${n}`, by: "mom", ...extra });
	const later = [...trail.waypoints,
		point("decided", "flaky test", "Move the settle into the fixture.", { title: "Settle in the fixture" }),
		point("returned", "trail reader", "Back to the reader.", { closes: "job:w5" }),
		point("closed", "trail reader", "The where-we-are rows are in.", { closes: "job:w3" }),
		point("reframed", "trail reader", "Make the reader the lead's only trail surface.", { title: "Reader as sole surface" }),
		point("reframed", "trail reader", "Ship the reader as the default.", { title: "Reader by default" }),
	];
	const tree = momSectionLines(trailView({ waypoints: later, struck: [] }, "up to date", { complete: true }), theme, 100).slice(1);
	assert.deepEqual(tree.map(row => row.replace(/ +\d+[mhd]$/, "")), [
		"◎ *Reader by default*  ‹ Reader as sole surface  ‹ trail reader",
		"  □ Decide whether the settle…",
		"  ✓ Still to do",
	], "the goals that led here trail the current one; the finished detour and decisions are gone, only the latest finished thing stays");
	const many = { waypoints: [...trail.waypoints, ...["Wire the reader", "Theme the rows", "Test narrow widths", "Write the docs"].map(caption => point("open", "trail reader", caption))], struck: [] };
	const listed = momSectionLines(trailView(many, "up to date", { complete: true }), theme, 100).slice(1).map(row => plain([row]));
	assert.deepEqual(listed.slice(1, 5), ["  □ Still to do", "  □ Wire the reader", "  □ Theme the rows", "  □ +2 more"], "past three to-dos the rest are counted");

	const fresh = trailView({ waypoints: trail.waypoints.slice(0, 1), struck: [] }, "up to date", { complete: true });
	assert.deepEqual(momSectionLines(fresh, theme, 100).slice(1), ["◎ *trail reader*"], "a fresh session costs one row");

	const header = (status: string, extra: Partial<PanelView> = {}) => plain([momSectionLines(trailView(trail, status, extra), theme, 140)[0]!]);
	assert.match(header("updating ▰▱▱▱▱ · 40% read · reading history 12s"), /^\*Path\* [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] reading$/, "a spinner and the stage word beside the title");
	assert.equal(header("catching up · 40% read", { coverage: { consumed: 4, total: 10, percent: 40 } }), "*Path* ◑ 40%");
	assert.equal(header("paused"), "*Path* ‖");
	assert.equal(header("needs you"), "*Path* ? needs you");
	assert.equal(header("quiet"), "*Path*", "quiet without completion says nothing");
	assert.match(header("quiet", { complete: true }), /✓ \d+[mhd]$/);

	const graphView: PanelView = { status: "up to date", summary: "", work, sliceUrl: "http://slice" };
	assert.match(plain(momSectionLines(graphView, theme, 140)), /An endeavor from the graph[\s\S]*Slice: http:\/\/slice/, "map mode is unchanged");
	const narrow = momSectionLines(view, theme, 30);
	assert.ok(narrow.slice(1).every(line => plain([line]).length <= 26), "rows are clipped to the widget");
});

test("the compact row is where we are, collapsing its middle, and counts what is parked", () => {
	const trail = fixture();
	let n = trail.waypoints.length;
	const at = trail.waypoints.at(-1)!.at;
	const deeper: Waypoint[] = [
		{ id: `job:w${++n}`, sessionId: "s1", at: at + 60_000, kind: "reframed", line: "trail reader", refs: ["s1:e9"], caption: "Make the reader the lead's only trail surface.", title: "Reader as sole surface", parent: "e9", by: "mom" },
		{ id: `job:w${++n}`, sessionId: "s1", at: at + 120_000, kind: "detour", line: "renderer settle", refs: ["s1:e10"], caption: "Adding a settle to the renderer first.", parent: "e10", by: "mom" },
		{ id: `job:w${++n}`, sessionId: "s1", at: at + 180_000, kind: "open", line: "renderer settle", refs: ["s1:e11"], caption: "Does the settle need a timeout?", parent: "e11", by: "mom" },
	];
	const more = { waypoints: [...trail.waypoints, ...deeper], struck: [] };
	const wide = momSectionLines(trailView(more, "up to date", { compact: true, complete: true }), theme, 120);
	assert.equal(wide.length, 2, "header and one row");
	assert.equal(wide[1], "◎ Reader as sole surface › ↳ flaky test › ↳ *renderer settle*  □3", "the current goal, then each open detour");
	const narrow = momSectionLines(trailView(more, "updating ▰▱▱▱▱ · thinking 3s", { compact: true }), theme, 56);
	assert.match(plain([narrow[0]!]), /^\*Path\* [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] thinking$/);
	assert.match(plain([narrow[1]!]), /^◎ Reader as sole surface › … › ↳ \*renderer settle\*  □3$/, "the goal and the newest stay; the middle collapses");
	assert.doesNotMatch(plain([momSectionLines(trailView({ waypoints: trail.waypoints.slice(0, 2), struck: [] }, "up to date", { compact: true, complete: true }), theme, 60)[1]!]), /□/, "no □ when nothing is open");
});

test("the tool preview carries the widget rows of a trail read and the standing key is deterministic", () => {
	const trail = fixture();
	const view = trailView(trail, "up to date");
	const preview = momToolPreview(view, trailText(trail).text);
	const lines = preview.split("\n");
	assert.equal(lines[0], "Path · up to date");
	assert.deepEqual(lines.slice(1).map(row => row.replace(/ +\d+[mhd]$/, "")), ["◎ trail reader", "  □ Still to do", "  ✓ Reuse the source pane", "  ↳ flaky test", "    □ Decide whether the settle…"], "status plus the widget's task list");
	assert.equal(momToolPreview(view), "Path · up to date", "without a trail read the preview is unchanged");
	assert.equal(momToolPreview({ status: "up to date", summary: "" }, "text"), "Path · up to date", "outside trail mode there are no rows to show");
	const key = standingKey(renderStanding(trail));
	assert.equal(key, standingKey(renderStanding(fixture())));
	assert.match(key, /^[0-9a-f]{16}$/);
	assert.notEqual(key, standingKey(renderStanding({ waypoints: trail.waypoints.slice(0, 4), struck: [] })));
});

test("Path's state as a slot: errors are short, retries are flagged, idle says nothing", () => {
	const last = fixture().waypoints.at(-1);
	const failed = statusSlot({ status: "up to date", error: "Last attempt: Path's model timed out after 60s. /path detail has the full error." }, theme, last)!;
	assert.equal(failed.symbol, "!");
	assert.equal(plain([failed.word]), "Path's model timed out…");
	assert.deepEqual(statusSlot({ status: "retrying at 10:00 · attempt 2 of 3" }, theme), { symbol: "!", word: "retrying" });
	assert.equal(statusSlot({ status: "idle" }, theme), undefined);
	assert.deepEqual(statusSlot({ status: "up to date · will check routine work by 10:00", complete: true }, theme), { symbol: "✓", word: "" });
	assert.deepEqual(statusSlot({ status: "catching up" }, theme), { symbol: "◔", word: "" });
	assert.equal(statusSlot({ status: "updating ▰▰▱▱▱ · screening 2s", trail: { stage: "starting Path" } }, theme)?.word, "starting", "the stage comes from the view when it carries one");
	const now = 1_000_000_000;
	assert.equal(statusSlot({ status: "updating ▰▱▱▱▱ · thinking 5s", trail: { stage: "thinking", task: "repairing", since: now - 5_000 } }, theme, undefined, now)?.word, "repairing", "a busy trail names its run");
	assert.equal(statusSlot({ status: "updating ▰▱▱▱▱ · thinking 3m", trail: { stage: "thinking", task: "backfilling", since: now - 180_000 } }, theme, undefined, now)?.word, "backfilling 3m", "and, past a minute, how long it has run");
});

test("trailText answers each question from the trail and says so on an empty one", () => {
	const trail = fixture();
	const all = trailText(trail);
	assert.equal(all.count, 8);
	assert.match(all.text, /^Path's trail — where we are/);
	assert.match(all.text, /Sleeping 50ms/, "the chronological trail follows the standing");
	const limited = trailText(trail, { limit: 1 }).text.split("\n\n")[1]!;
	assert.match(limited, /^\d\d:\d\d dead_end · flaky test · Sleeping 50ms/, "limit keeps only the newest waypoints after the standing");
	assert.doesNotMatch(limited, /\n/);
	assert.match(trailText(trail, { before: true }).text, /trail reader/, "before the detour we were on the reader");
	assert.match(trailText(trail, { before: true }).text, /Reuse the source reader pane/, "with its last waypoint before the detour");
	const open = trailText(trail, { open: true }).text;
	assert.match(open, /widget's where-we-are rows/);
	assert.match(open, /settle belongs in the fixture/);
	assert.doesNotMatch(trailText(trail, { open: true, line: "trail reader" }).text, /settle belongs/);
	assert.match(trailText(trail, { query: "flaky" }).text, /Sleeping 50ms/, "where the detour landed");
	assert.match(trailText(trail, { evolution: true }).text, /Build the lead-side reader/);
	assert.deepEqual(trailText({ waypoints: [], struck: [] }), { text: "Path has not marked any waypoints yet.", count: 0 });
	assert.deepEqual(trailText({ waypoints: [], struck: [] }, { before: true }), { text: "Path has not marked any waypoints yet.", count: 0 });
});

test("Path's view labels F2 Trail in trail mode, moves the selection with the arrows, and Enter shows the entry in the transcript", async () => {
	const trail = fixture();
	const reads: string[] = [];
	const source: any = {
		view: () => trailView(trail, "up to date", { complete: true }),
		trail: () => trail,
		readSource: async (ref: string) => { reads.push(ref); return { ref, text: `original ${ref}`, offset: 0, totalChars: 12, nextOffset: null }; },
	};
	const tui = { terminal: { rows: 30, columns: 120 }, requestRender: () => {} } as any;
	const view = new MomView(source, theme, tui, () => {});
	assert.match(plain(view.render(120)), /F2 Trail/);
	assert.doesNotMatch(plain(view.render(120)), /F2 Map/);
	view.handleInput("\x1bOQ"); // F2
	let screen = plain(view.render(120));
	assert.match(screen, /◎ \*Build the lead-side reader for Path's trail\.\* +✓ \d+[mhd]/, "the goal row with Path's state");
	assert.match(screen, /└↳ Left the reader.*then back to trail reader/);
	assert.match(screen, /▸ ✗ \*Sleeping 50ms/, "the newest entry is selected");
	assert.match(screen, /│ step, dead end · flaky test · \d\d:\d\d/, "the details pane sits beside the trail");
	assert.match(screen, /↑↓ move · Enter show in transcript/);
	assert.doesNotMatch(screen, MODEL_WORDS);
	view.handleInput("\x1b[A"); view.handleInput("\x1b[A"); // up, up
	screen = plain(view.render(120));
	assert.match(screen, /▸ • \*The smoke test races/);
	assert.match(screen, /│ step, finding · flaky test/);
	view.handleInput("\r");
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(reads, ["s1:e6"], "Enter opens the selected entry's first source");
	screen = plain(view.render(120));
	assert.match(screen, /original s1:e6/);
	assert.match(screen, /Esc trail/);
	view.handleInput("\x1b"); // Esc returns to the trail, not out of the view
	screen = plain(view.render(120));
	assert.match(screen, /▸ • \*The smoke test races/);
	// The Overview tab shows the widget's rows and nothing else about the trail.
	view.handleInput("\x1bOP"); // F1
	screen = plain(view.render(120));
	assert.match(screen, /◎ trail reader\s+□ Still to do[\s\S]*↳ \*flaky test\*/);
	assert.doesNotMatch(screen, /F2 explore|entries/);
	// Narrow terminals keep the whole row for the trail.
	const narrowTui = { terminal: { rows: 30, columns: 80 }, requestRender: () => {} } as any;
	const narrow = new MomView(source, theme, narrowTui, () => {});
	narrow.handleInput("\x1bOQ");
	assert.doesNotMatch(plain(narrow.render(80)), /│ dead end/);
	// Map mode is untouched: no trail in the view, F2 stays the Map.
	const mapView = new MomView({ view: () => ({ status: "up to date", summary: "" }) }, theme, tui, () => {});
	assert.match(plain(mapView.render(120)), /F2 Map/);
	view.dispose(); mapView.dispose(); narrow.dispose();
});

test("the panel's F-keys match pi-tui's legacy forms and the kitty protocol's ESC [ P/Q/R/S forms", () => {
	assert.ok(functionKey("\x1bOP", "f1")); assert.ok(functionKey("\x1b[P", "f1")); assert.ok(functionKey("\x1b[1;5P", "f1"));
	assert.ok(functionKey("\x1b[Q", "f2")); assert.ok(functionKey("\x1b[13~", "f3")); assert.ok(functionKey("\x1b[R", "f3"));
	assert.ok(!functionKey("\x1b[Q", "f1")); assert.ok(!functionKey("P", "f1")); assert.ok(!functionKey("\x1b[12~", "f1"));
});
