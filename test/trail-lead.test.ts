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
		point("set_out", "trail reader", "Build the lead-side reader for Mom's trail."),
		point("learned", "trail reader", "The panel's tabs are keyed F1 to F3; F2 is the map."),
		point("open", "trail reader", "Still to do: the widget's where-we-are rows."),
		point("decided", "trail reader", "Reuse the source reader pane for trail refs rather than a new pane."),
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
	assert.match(lines[0]!, /^ ◎ \*Build the lead-side reader for Mom's trail\.\* +⠹ reading$/, "the goal, Mom's state at the far right");
	assert.match(lines[1]!, /^ └↳ Left the reader to chase a flaky terminal smoke test\. +then back to trail reader$/);
	assert.match(lines[2]!, /^ ─+$/);
	assert.doesNotMatch(text, MODEL_WORDS);
	const rows = lines.slice(lines.length - trail.waypoints.length);
	assert.equal(rows.length, 8);
	assert.match(rows[0]!, /^ \d\d:\d\d  ◎ Build the lead-side reader/, "the root thread sits at depth 0");
	assert.match(rows[4]!, /^\[ \d\d:\d\d  ▸ ↳ \*Left the reader.*\]$/, "the selected row is marked and highlighted; a detour sits at the depth it left");
	assert.match(rows[5]!, /^ \d\d:\d\d      • The smoke test races/, "entries inside the detour are indented one step");
	assert.match(rows[7]!, /^ \d\d:\d\d      ✗ Sleeping 50ms/);
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
	assert.match(rows[8]!, /^ \d\d:\d\d  ↰ Back to the reader/, "the returned row is back at depth 0");
	assert.match(rows[9]!, /^\[ \d\d:\d\d  ▸ ■ The widget block is in\. *\]$/);
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

test("the widget shows the breadcrumb, the detour, its open items and the latest entry; a fresh session is one row", () => {
	const trail = fixture();
	const work = { endeavors: [{ id: "e", label: "An endeavor from the graph", state: "active", parent: null, annotations: [], sources: [], kind: "feature", intent: "" }], unattachedAnnotations: [], connections: [], outside: [], focusPath: [], totalRecords: 1 } as any;
	const view = trailView(trail, "up to date", { work, complete: true });
	const lines = momSectionLines(view, theme, 140);
	assert.equal(plain([lines[0]!]), "*Mom*", "the trail header is just Mom: her state is the symbol at the right of the first row");
	const body = lines.slice(1);
	assert.equal(body.length, 4, "four rows and nothing else");
	assert.doesNotMatch(plain(body), /An endeavor from the graph/, "no graph hierarchy in trail mode");
	assert.doesNotMatch(plain(body), MODEL_WORDS);
	assert.match(body[0]!, /^◎ trail reader › \*flaky test\* +✓ \d+[mhd]$/, "the breadcrumb with the innermost thread bold, Mom's state at the far right");
	assert.equal(body[1], "  Left the reader to chase a flaky terminal smoke test.");
	assert.equal(body[2], "  □ Decide whether the settle belongs in the fixture.");
	assert.match(body[3]!, /^  ✗ Sleeping 50ms did not fix the race\. +\d+[mhd]$/, "the latest entry with its age");

	const fresh = trailView({ waypoints: trail.waypoints.slice(0, 1), struck: [] }, "up to date", { complete: true });
	const one = momSectionLines(fresh, theme, 100).slice(1);
	assert.equal(one.length, 1, "a fresh session costs one row");
	assert.match(one[0]!, /^◎ \*Build the lead-side reader for Mom's trail\.\* +✓ \d+[mhd]$/);

	const updating = momSectionLines(trailView(trail, "updating ▰▱▱▱▱ · 40% read · reading history 12s"), theme, 140).slice(1);
	assert.match(updating[0]!, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] reading$/, "a spinner and the stage word");
	const catching = momSectionLines(trailView(trail, "catching up · 40% read", { coverage: { consumed: 4, total: 10, percent: 40 } }), theme, 140).slice(1);
	assert.match(catching[0]!, /◑ 40%$/);
	assert.match(momSectionLines(trailView(trail, "paused"), theme, 140)[1]!, /‖$/);
	assert.match(momSectionLines(trailView(trail, "needs you"), theme, 140)[1]!, /\? needs you$/);
	assert.match(momSectionLines(trailView(trail, "quiet"), theme, 140)[1]!, /\*flaky test\*$/, "quiet without completion says nothing");
	assert.match(momSectionLines(trailView(trail, "quiet", { complete: true }), theme, 140)[1]!, /✓ \d+[mhd]$/);

	const graphView: PanelView = { status: "up to date", summary: "", work };
	assert.match(plain(momSectionLines(graphView, theme, 140)), /An endeavor from the graph/, "map mode is unchanged");
	const narrow = momSectionLines(view, theme, 40);
	assert.ok(narrow.slice(1).every(line => plain([line]).length <= 36), "rows are clipped to the widget");
	assert.match(plain([momSectionLines(view, theme, 36)[1]!]), /\*flaky test\*  ✓$/, "the age goes before the breadcrumb does");
});

test("the compact row collapses the middle of the breadcrumb, counts open items, and keeps Mom's symbol", () => {
	const trail = fixture();
	let n = trail.waypoints.length;
	const at = trail.waypoints.at(-1)!.at;
	const deeper: Waypoint[] = [
		{ id: `job:w${++n}`, sessionId: "s1", at: at + 60_000, kind: "detour", line: "renderer settle", refs: ["s1:e9"], caption: "Adding a settle to the renderer first.", parent: "e9", by: "mom" },
		{ id: `job:w${++n}`, sessionId: "s1", at: at + 120_000, kind: "open", line: "renderer settle", refs: ["s1:e10"], caption: "Does the settle need a timeout?", parent: "e10", by: "mom" },
		{ id: `job:w${++n}`, sessionId: "s1", at: at + 180_000, kind: "open", line: "renderer settle", refs: ["s1:e11"], caption: "Document the settle in the fixture notes.", parent: "e11", by: "mom" },
	];
	const three = { waypoints: [...trail.waypoints, ...deeper], struck: [] };
	const wide = momSectionLines(trailView(three, "up to date", { compact: true, complete: true }), theme, 100);
	assert.equal(wide.length, 2, "header and one row");
	assert.match(wide[1]!, /^◎ trail reader › flaky test › \*renderer settle\*  □2 +✓ \d+[mhd]$/);
	const narrow = momSectionLines(trailView(three, "updating ▰▱▱▱▱ · thinking 3s", { compact: true }), theme, 50)[1]!;
	assert.match(plain([narrow]), /^◎ trail reader › … › \*renderer settle\*  □2 +[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/, "the middle collapses first; the symbol alone");
	assert.doesNotMatch(plain([momSectionLines(trailView(trail.waypoints.slice(0, 2).length ? { waypoints: trail.waypoints.slice(0, 2), struck: [] } : trail, "up to date", { compact: true, complete: true }), theme, 60)[1]!]), /□/, "no □ when nothing is open");
});

test("the tool preview carries the widget rows of a trail read and the standing key is deterministic", () => {
	const trail = fixture();
	const view = trailView(trail, "up to date");
	const preview = momToolPreview(view, trailText(trail).text);
	const lines = preview.split("\n");
	assert.equal(lines[0], "Mom · up to date");
	assert.equal(lines.length, 5, "status plus the four widget rows");
	assert.match(lines[1]!, /^◎ trail reader › flaky test$/);
	assert.match(lines[4]!, /^  ✗ Sleeping 50ms did not fix the race\. +\d+[mhd]$/);
	assert.equal(momToolPreview(view), "Mom · up to date", "without a trail read the preview is unchanged");
	assert.equal(momToolPreview({ status: "up to date", summary: "" }, "text"), "Mom · up to date", "outside trail mode there are no rows to show");
	const key = standingKey(renderStanding(trail));
	assert.equal(key, standingKey(renderStanding(fixture())));
	assert.match(key, /^[0-9a-f]{16}$/);
	assert.notEqual(key, standingKey(renderStanding({ waypoints: trail.waypoints.slice(0, 4), struck: [] })));
});

test("Mom's state as a slot: errors are short, retries are flagged, idle says nothing", () => {
	const last = fixture().waypoints.at(-1);
	const failed = statusSlot({ status: "up to date", error: "Last attempt: Mom's model timed out after 60s. /mom detail has the full error." }, theme, last)!;
	assert.equal(failed.symbol, "!");
	assert.equal(plain([failed.word]), "Mom's model timed out a…");
	assert.deepEqual(statusSlot({ status: "retrying at 10:00 · attempt 2 of 3" }, theme), { symbol: "!", word: "retrying" });
	assert.equal(statusSlot({ status: "idle" }, theme), undefined);
	assert.deepEqual(statusSlot({ status: "up to date · will check routine work by 10:00", complete: true }, theme), { symbol: "✓", word: "" });
	assert.deepEqual(statusSlot({ status: "catching up" }, theme), { symbol: "◔", word: "" });
	assert.equal(statusSlot({ status: "updating ▰▰▱▱▱ · screening 2s", trail: { stage: "starting Mom" } }, theme)?.word, "starting", "the stage comes from the view when it carries one");
});

test("trailText answers each question from the trail and says so on an empty one", () => {
	const trail = fixture();
	const all = trailText(trail);
	assert.equal(all.count, 8);
	assert.match(all.text, /^Mom's trail — where we are/);
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
	assert.deepEqual(trailText({ waypoints: [], struck: [] }), { text: "Mom has not marked any waypoints yet.", count: 0 });
	assert.deepEqual(trailText({ waypoints: [], struck: [] }, { before: true }), { text: "Mom has not marked any waypoints yet.", count: 0 });
});

test("Mom's view labels F2 Trail in trail mode, moves the selection with the arrows, and Enter shows the entry in the transcript", async () => {
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
	assert.match(screen, /◎ \*Build the lead-side reader for Mom's trail\.\* +✓ \d+[mhd]/, "the goal row with Mom's state");
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
	assert.match(screen, /◎ trail reader › \*flaky test\* +✓ \d+[mhd]/);
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
