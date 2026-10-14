import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ActivityCoordinator, renderActivityLines, renderRecapSectionLines } from "../src/ui/activity.ts";
import { addTask, emptyState, startTask } from "../src/todo.ts";

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

test("compact mode keeps every Activity section represented in one shared box", () => {
	let factory: any;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text, strikethrough: (text: string) => text } as any;
	const tui = { terminal: { columns: 100, rows: 30 }, requestRender: () => {}, getClearOnShrink: () => false, setClearOnShrink: () => {},
		addInputListener: () => () => {}, hasOverlay: () => false } as any;
	const context = { mode: "tui", ui: { setWidget: (key: string, value: unknown) => { if (key === "pi-delegate.activity" && typeof value === "function") factory = value; } } } as any;
	const run = { id: "agent-1", segment: 1, stopped: false, settled: false, role: "scout", model: "fixture", cwd: "/tmp", thinking: "", context: "fresh",
		status: "running", task: "Review the routing", output: "", turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0,
		durationMs: 1000, segmentDurationMs: 1000, changedFiles: [], droppedTools: [], toolCalls: [], revision: 0, depth: 1 };
	const live = { all: () => [run], activity: () => ({ messages: [], activeTools: new Map() }), subscribe: () => () => {}, steer: async () => {}, cancel: async () => {} } as any;
	const coordinator = new ActivityCoordinator();
	coordinator.install(context, live, async () => {});
	const state = startTask(addTask(addTask(emptyState(), "Tasks", "Keep the current task"), "Tasks", "Hide this detail"), "Keep the current task");
	coordinator.setTodos(state);
	coordinator.setCompact(true);
	coordinator.setMom(() => ({ status: "up to date", summary: "Saved work", compact: true }));
	coordinator.setRecap("※ recap: Continue the routing review.");
	const screen = factory(tui, theme).render(100).join("\n");
	assert.match(screen, /Agents · 1 active/);
	assert.match(screen, /Review the routing/);
	assert.match(screen, /Todos · 0\/2/);
	assert.match(screen, /Keep the current task/);
	assert.doesNotMatch(screen, /Hide this detail/);
	assert.match(screen, /Path · up to date/);
	assert.match(screen, /Recap/);
	assert.match(screen, /Continue the routing review/);
	assert.equal(renderRecapSectionLines("A long recap ".repeat(30), theme, 100, true).length, 2, "compact Recap keeps one summary row");
	assert.equal(screen.split("╭").length - 1, 1, "all compact sections share one outer frame");
	coordinator.dispose();
});

test("Path's spinner repaints on its own clock while it works, and the clock stops when Path is idle", async () => {
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
