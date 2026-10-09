import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderActivityLines } from "../src/ui/activity.ts";

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;

const sections = [
	["Agents · 1 active", "  ● Trace the route"],
	["Todos · 0/2", "  └─ ☐ Keep the task visible"],
	["Mom · updating", "  └─ Improve the activity outline"],
];

test("activity coordinator gives agents, todos, and Mom one outline", () => {
	const lines = renderActivityLines(sections, theme, 72);
	assert.equal(lines.filter(line => line.includes("╭")).length, 1);
	assert.equal(lines.filter(line => line.includes("╰")).length, 1);
	assert.match(lines[0]!, /Activity/);
	assert.match(lines.join("\n"), /Agents · 1 active/);
	assert.match(lines.join("\n"), /Todos · 0\/2/);
	assert.match(lines.join("\n"), /Mom · updating/);
	assert.ok(lines.every(line => visibleWidth(line) <= 72));
});

test("activity outline stays visible when the widget is not focused", () => {
	const colored = { fg: (color: string, text: string) => `<${color}>${text}` } as unknown as Theme;
	const lines = renderActivityLines(sections, colored, 72);
	assert.match(lines[0]!, /^<borderAccent>╭─/);
	assert.match(lines.at(-1)!, /^<borderAccent>╰─/);
});

test("activity legend stays inside the frame at narrow widths", () => {
	for (let width = 8; width <= 72; width++) {
		const lines = renderActivityLines(sections, theme, width);
		assert.ok(lines.every(line => visibleWidth(line) <= width), `line exceeds width ${width}`);
		assert.match(lines.at(-1)!, /╯$/, `missing right corner at width ${width}`);
	}
});
