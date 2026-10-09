import assert from "node:assert/strict";
import { test } from "node:test";
import { installMom } from "../src/mom/index.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function momTool(): any {
	const tools: any[] = [];
	const pi: any = {
		registerFlag() {}, registerTool(tool: any) { tools.push(tool); }, registerCommand() {}, registerShortcut() {}, on() {}, getFlag() { return undefined; },
		events: { emit() {} }, sendMessage() {},
	};
	installMom(pi);
	return tools.find(tool => tool.name === "mom");
}

test("collapsed Mom tool results use the activity preview instead of dumping the saved map", () => {
	const output = "Mom has not read the latest activity yet; this is her last-saved snapshot, not current orientation.\nMother thread: Review pi-delegate [review] — finished\nRules in force (2):\n    Why: Keep the map readable [src:session:rule]";
	const rendered = momTool().renderResult({ content: [{ type: "text", text: output }], details: { overview: output, preview: "Mom · updating · Review pi-delegate" } }, { expanded: false }, theme);
	const screen = rendered.render(120, 10).map((line: string) => line.trimEnd()).join("\n");
	assert.equal(screen, "Mom · updating · Review pi-delegate");
	assert.doesNotMatch(screen, /last-saved snapshot|Rules in force|\[src:/);
});

test("expanded Mom tool results retain the complete saved map", () => {
	const output = "Mother thread: Review pi-delegate [review] — finished\nRules in force (2):\n    Why: Keep the map readable [src:session:rule]";
	const rendered = momTool().renderResult({ content: [{ type: "text", text: output }], details: { overview: "Mom · up to date", preview: "Mom · up to date", expandable: true } }, { expanded: true }, theme);
	assert.equal(rendered.render(120, 10).map((line: string) => line.trimEnd()).join("\n"), output);
});
