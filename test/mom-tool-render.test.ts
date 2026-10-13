import assert from "node:assert/strict";
import { test } from "node:test";
import { installMom } from "../src/mom/index.ts";
import { FOCUS_KEY, MomView } from "../src/ui/panel.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, bg: (_color: string, text: string) => text, dim: (text: string) => text };

function momTool(): any {
	const tools: any[] = [];
	const pi: any = {
		registerFlag() {}, registerTool(tool: any) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, getFlag() { return undefined; },
		events: { emit() {} }, sendMessage() {},
	};
	installMom(pi);
	return tools.find(tool => tool.name === "path");
}

test("collapsed Mom tool results use the activity preview instead of dumping the saved map", () => {
	const output = "Path has not read the latest activity yet; this is its last-saved snapshot, not current orientation.\nMother thread: Review pi-delegate [review] — finished\nRules in force (2):\n    Why: Keep the map readable [src:session:rule]";
	const rendered = momTool().renderResult({ content: [{ type: "text", text: output }], details: { overview: output, preview: "Path · updating · Review pi-delegate" } }, { expanded: false }, theme);
	const screen = rendered.render(120, 10).map((line: string) => line.trimEnd()).join("\n");
	assert.equal(screen, "Path · updating · Review pi-delegate");
	assert.doesNotMatch(screen, /last-saved snapshot|Rules in force|\[src:/);
});

test("expanded Mom tool results never print the saved map or source details", () => {
	const output = "Mother thread: Review pi-delegate [review] — finished\nRules in force (2):\n    Why: Keep the map readable [src:session:rule]";
	const rendered = momTool().renderResult({ content: [{ type: "text", text: output }], details: { overview: "Path · up to date", preview: "Path · up to date", expandable: true } }, { expanded: true }, theme);
	const screen = rendered.render(120, 10).map((line: string) => line.trimEnd()).join("\n");
	assert.equal(screen, "Path · up to date\nSelected records and sources are available to the model, not displayed here.");
	assert.doesNotMatch(screen, /Mother thread|Rules in force|\[src:/);
});

/** Path's view: what she saved, with no way to ask her a question from it. */
test("Path's view shows her saved map and status, and typing asks her nothing", async () => {
	let refreshes = 0, runs = 0, renders = 0, progress = "Rebuilding · pass 1 · reasoning · 100 chars streamed";
	const sliceUrl = "http://127.0.0.1:6836/slice/s-tracking", rebuildUrl = "http://127.0.0.1:6836/slice/s-rebuild";
	const source: any = {
		view: () => ({ status: "up to date", summary: "Mother thread: Review pi-delegate — finished", rebuild: progress, rebuildUrl }),
		status: () => ({ connection: "connected", project: "/repo", sliceUrl }),
		refreshStatus: async () => { refreshes++; },
		refresh: async () => { runs++; return "Refreshed — 2 new entries on the trail."; },
		findingAction: async () => {},
	};
	const view = new MomView(source, theme as any, { terminal: { rows: 24, columns: 100 }, requestRender: () => { renders++; } } as any, () => {});
	const screen = view.render(100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(screen, /F1 Overview/);
	assert.match(screen, /F2 Map/);
	assert.match(screen, /F3 Status/);
	assert.doesNotMatch(screen, /Chat|ask Mom|questions and answers/i);
	assert.match(screen, /R refresh · O on\/off · F4 settings · C copy · Esc back/);
	assert.match(screen, /F4 Settings/);
	// Typing lands nowhere: a character or Enter never reaches a model, and R is the only run.
	for (const key of ["w", "\r", "y"]) view.handleInput(key);
	assert.equal(refreshes, 0, "typing does not read her notes either");
	assert.equal(runs, 0);
	view.handleInput("r");
	assert.match(view.render(100).join("\n"), /Refreshing…/);
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(runs, 1);
	assert.equal(refreshes, 1, "the view is read again after the run");
	assert.match(view.render(100).join("\n"), /Refreshed — 2 new entries on the trail\./);
	view.handleInput("\x1bOR"); // F3
	const status = view.render(100).join("\n");
	assert.ok(status.includes(`Slice: ${sliceUrl}`));
	assert.ok(status.includes(`Rebuild slice: ${rebuildUrl}`));
	assert.ok(status.includes(progress));
	progress = "Rebuilding · pass 1 · reasoning · 200 chars streamed";
	view.statusChanged();
	assert.ok(view.render(100).join("\n").includes(progress), "rebuild activity stays live while the saved map is held steady");
	view.dispose();
	assert.ok(renders > 0);
});

const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

test("Path's view: F4 holds the settings, O turns Path on or off, R runs the refresh", async () => {
	const keys: string[] = [], enabled: boolean[] = [];
	let done = 0, rebuilds = 0;
	const component = { render: () => ["Path settings", `typed: ${keys.join("")}`], handleInput: (data: string) => { keys.push(data); if (data === "\x1b") closeSettings(); }, invalidate() {} };
	let closeSettings = () => {};
	const source: any = {
		view: () => ({ status: "up to date", summary: "Saved work" }),
		status: () => ({ connection: "connected", project: "/repo", enabled: enabled.at(-1) ?? true }),
		setEnabled: async (value: boolean) => { enabled.push(value); },
		refresh: async () => "Caught up.",
		settings: (finished: () => void) => { closeSettings = finished; return component; },
		rebuild: () => { rebuilds++; },
	};
	const view = new MomView(source, theme as any, { terminal: { rows: 24, columns: 100 }, requestRender() {} } as any, () => { done++; });
	view.handleInput("\x1bOS"); // F4
	assert.match(plain(view.render(100)), /typed: /);
	for (const key of ["r", "o", "b", "c"]) view.handleInput(key);
	assert.deepEqual(keys, ["r", "o", "b", "c"], "letters belong to the settings component, not to the view's actions");
	assert.deepEqual(enabled, []);
	assert.equal(rebuilds, 0);
	view.handleInput("\x1b"); // Esc at its top level returns to Overview
	assert.match(plain(view.render(100)), /Current work/);
	assert.equal(done, 0, "Esc inside Settings does not close the view");
	view.handleInput("o");
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(enabled, [false], "O turns Path off when it is on");
	assert.match(plain(view.render(100)), /Path off\./);
	view.handleInput("o");
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.deepEqual(enabled, [false, true]);
	view.handleInput("b");
	assert.equal(rebuilds, 0, "B rebuilds only from F3 Status");
	view.handleInput("\x1bOR"); // F3
	view.handleInput("b");
	assert.equal(rebuilds, 1);
	view.dispose();
});

test("Path's view says settings are unavailable when Path is not connected", () => {
	const source: any = { view: () => ({ status: "connecting", summary: "" }), settings: () => undefined };
	const view = new MomView(source, theme as any, { terminal: { rows: 24, columns: 100 }, requestRender() {} } as any, () => {});
	view.handleInput("\x1bOS");
	assert.match(plain(view.render(100)), /Path is not connected; settings are unavailable\./);
	view.dispose();
});
