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
	let refreshes = 0, renders = 0, progress = "Rebuilding · pass 1 · reasoning · 100 chars streamed";
	const sliceUrl = "http://127.0.0.1:6836/slice/s-tracking", rebuildUrl = "http://127.0.0.1:6836/slice/s-rebuild";
	const source: any = {
		view: () => ({ status: "up to date", summary: "Mother thread: Review pi-delegate — finished", rebuild: progress, rebuildUrl }),
		status: () => ({ connection: "connected", project: "/repo", sliceUrl }),
		refreshStatus: async () => { refreshes++; },
		findingAction: async () => {},
	};
	const view = new MomView(source, theme as any, { terminal: { rows: 24, columns: 100 }, requestRender: () => { renders++; } } as any, () => {});
	const screen = view.render(100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(screen, /F1 Overview/);
	assert.match(screen, /F2 Map/);
	assert.match(screen, /F3 Status/);
	assert.doesNotMatch(screen, /Chat|ask Mom|questions and answers/i);
	assert.match(screen, /R refresh · C copy · Esc back/);
	// Typing lands nowhere: a character or Enter never reaches a model, and R is the only read.
	for (const key of ["w", "\r", "y"]) view.handleInput(key);
	assert.equal(refreshes, 0, "typing does not read her notes either");
	view.handleInput("r");
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(refreshes, 1);
	assert.match(view.render(100).join("\n"), /Showing the latest saved view\./);
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
