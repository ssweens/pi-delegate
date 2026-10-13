import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderActivityLines } from "../src/ui/activity.ts";

const theme = { fg: (_color: string, text: string) => text } as unknown as Theme;

const sections = [
	["Agents · 1 active", "  ● Trace the route"],
	["Todos · 0/2", "  └─ ☐ Keep the task visible"],
	["Path · updating", "  └─ Improve the activity outline"],
];

test("activity coordinator gives agents, todos, and Path one outline", () => {
	const lines = renderActivityLines(sections, theme, 72);
	assert.equal(lines.filter(line => line.includes("╭")).length, 1);
	assert.equal(lines.filter(line => line.includes("╰")).length, 1);
	assert.match(lines[0]!, /Activity/);
	assert.match(lines.join("\n"), /Agents · 1 active/);
	assert.match(lines.join("\n"), /Todos · 0\/2/);
	assert.match(lines.join("\n"), /Path · updating/);
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

test("Path's spinner repaints on its own clock while it works, and the clock stops when Path is idle", async () => {
	const { ActivityCoordinator } = await import("../src/ui/activity.ts");
	const { glance } = await import("../src/trail/projection.ts");
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t } as any;
	let factory: any, renders = 0;
	const tui = { terminal: { columns: 100, rows: 30 }, requestRender: () => { renders++; }, getClearOnShrink: () => false, setClearOnShrink: () => {},
		addInputListener: () => () => {}, hasOverlay: () => false } as any;
	const context = { mode: "tui", ui: { setWidget: (key: string, value: unknown) => { if (key === "pi-delegate.activity" || typeof value === "function") factory ??= value; } } } as any;
	const live = { all: () => [], activity: () => ({}), subscribe: () => () => {}, steer: async () => {}, cancel: async () => {} } as any;
	const coordinator = new ActivityCoordinator();
	coordinator.install(context, live, async () => {});
	const widget = factory(tui, theme);
	const trail = { glance: glance({ waypoints: [], struck: [] }), count: 0 };
	let status = "updating ▰▱▱▱▱ · thinking 2s";
	coordinator.setMom(() => ({ status, summary: "", trail }));
	try {
		assert.match(widget.render(100).join("\n"), /Path [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] thinking/, "the spinner sits beside the Path title");
		const before = renders;
		await new Promise(resolve => setTimeout(resolve, 700));
		assert.ok(renders - before >= 2, `the spinner asked for repaints on its own (${renders - before})`);
		status = "up to date";
		widget.render(100);
		const stopped = renders;
		await new Promise(resolve => setTimeout(resolve, 500));
		assert.equal(renders, stopped, "no repaint clock once Path is idle");
	} finally { coordinator.dispose(); }
});
