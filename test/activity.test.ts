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

test("overview includes all current agents, complete todos, empty headings, and uncapped recap", () => {
	const styler = { fg: (_c: string, s: string) => s, bold: (s: string) => s, strikethrough: (s: string) => s } as any;
	const owner = new ActivityCoordinator();
	const empty = owner.renderOverview(styler, 50).join("\n");
	for (const heading of ["Agents", "Todos", "Path", "Recap"]) assert.match(empty, new RegExp(heading));
	const runs = Array.from({ length: 7 }, (_, i) => ({ id: String(i), task: `Agent ${i}`, status: "complete", settled: true, endedAt: Date.now(), depth: i + 1 }));
	owner.install({ mode: "print" } as any, { all: () => runs } as any, async () => {});
	owner.setTodos({ phases: [{ name: "Closed", tasks: [{ content: "DONE-END", status: "completed" }] }, { name: "Empty", tasks: [] },
		{ name: "Abandoned", tasks: [{ content: "ABANDONED-END", status: "abandoned" }] },
		{ name: "Blocked", tasks: [{ content: `Full content ${"detail ".repeat(20)}TASK-END`, status: "blocked", blocker: `${"waiting ".repeat(30)}BLOCKER-END` }] }] });
	owner.setRecap(`${"recap ".repeat(80)}RECAP-END`);
	owner.setRecap(undefined);
	const lines = owner.renderOverview(styler, 50), screen = lines.join("\n");
	for (let i = 0; i < 7; i++) assert.match(screen, new RegExp(`Agent ${i}`));
	for (const word of ["completed", "abandoned", "blocked", "Empty", "No tasks", "TASK-END", "BLOCKER-END", "RECAP-END"]) assert.match(screen, new RegExp(word));
	assert.ok(lines.every(line => visibleWidth(line) <= 46));
	owner.setTodos({ phases: [{ name: "All done", tasks: [{ content: "Still visible", status: "completed" }] }] });
	assert.match(owner.renderOverview(styler, 50).join("\n"), /Still visible/);
	owner.dispose();
});

test("overview uses the widget's prompt cutoff without its four-row cap", (t) => {
	const now = t.mock.method(Date, "now", () => 100);
	const owner = new ActivityCoordinator();
	const styler = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as any;
	const runs = [
		{ id: "old", task: "OLD-SETTLED", status: "complete", settled: true, endedAt: 150 },
		{ id: "boundary", task: "BOUNDARY-SETTLED", status: "complete", settled: true, endedAt: 200 },
		...Array.from({ length: 7 }, (_, i) => ({ id: String(i), task: `CURRENT-${i}`, status: "running", settled: false })),
	];
	owner.install({ mode: "print" } as any, { all: () => runs } as any, async () => {});
	assert.match(owner.renderOverview(styler, 80).join("\n"), /OLD-SETTLED/);
	now.mock.mockImplementation(() => 200);
	owner.markPrompt();
	const screen = owner.renderOverview(styler, 80).join("\n");
	assert.doesNotMatch(screen, /OLD-SETTLED/);
	assert.match(screen, /BOUNDARY-SETTLED/);
	for (let i = 0; i < 7; i++) assert.match(screen, new RegExp(`CURRENT-${i}`));
	runs.splice(0, runs.length, { id: "old", task: "OLD-SETTLED", status: "complete", settled: true, endedAt: 150 });
	assert.match(owner.renderOverview(styler, 80).join("\n"), /No current agents\./);
	owner.dispose();
});

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
	const live = { all: () => [run], processes: () => [{ id: "process-1", backend: "process", command: "sleep 30", task: "Background build", status: "running", startedAt: Date.now() }], activity: () => ({ messages: [], activeTools: new Map() }), subscribe: () => () => {}, steer: async () => {}, cancel: async () => {} } as any;
	const coordinator = new ActivityCoordinator();
	coordinator.install(context, live, async () => {});
	const state = startTask(addTask(addTask(emptyState(), "Tasks", "Keep the current task"), "Tasks", "Hide this detail"), "Keep the current task");
	coordinator.setTodos(state);
	coordinator.setCompact(true);
	coordinator.setMom(() => ({ status: "up to date", summary: "Saved work", compact: true }));
	coordinator.setRecap("※ recap: Continue the routing review.");
	const widget = factory(tui, theme);
	const lines = widget.render(100);
	const screen = lines.join("\n");
	assert.match(screen, /Agents · 1\/1 │ Processes · 1\/1 │ Todos · 0\/2 │ Path · up to date/);
	assert.doesNotMatch(screen, /Hide this detail/);
	assert.equal(lines.filter((line: string) => line.startsWith("│")).length, 1, "compact body is one line");
	assert.equal(screen.split("╭").length - 1, 1, "all compact sections share one outer frame");
	const click = { type: "click", button: "left", x: 3, y: 1, screenX: 3, screenY: 1, width: 100, height: lines.length, shift: false, alt: false, ctrl: false } as const;
	assert.deepEqual(widget.handleMouse(click), { handled: true });
	assert.equal(coordinator.isCompact(), false, "a click expands the box");
	const expanded = widget.render(100);
	assert.ok(expanded.length > lines.length);
	assert.match(expanded.join("\n"), /Background build.*running/);
	const processRow = expanded.find((line: string) => line.includes("Background build"));
	assert.doesNotMatch(processRow, /Thinking|fixture|scout|tokens|\$/);
	assert.equal(widget.handleMouse({ ...click, type: "move" }), undefined);
	widget.handleMouse(click);
	assert.equal(coordinator.isCompact(), true, "a second click compacts it again");
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

test("full-size Activity has a tab per section and Schedules controls jobs through spur", () => {
	const styler = { fg: (_c: string, s: string) => s, bold: (s: string) => s, bg: (_c: string, s: string) => s, strikethrough: (s: string) => s } as any;
	const owner = new ActivityCoordinator();
	const job = { id: "sugg-watch", prompt: "Check the two Harness suggestion runs\nand report changes.", timing: { kind: "interval" as const, milliseconds: 360_000 },
		nextAt: Date.now() + 300_000, enabled: true, phase: { kind: "idle" as const } };
	owner.setSpur({ version: 1, paused: false, jobs: [job] });
	const requests: unknown[] = [];
	owner.setSpurControl(request => { requests.push(request); return ""; });
	const all = owner.renderOverview(styler, 80).join("\n");
	for (const tab of ["1 All", "2 Agents", "3 Processes", "4 Todos", "5 Path", "6 Schedules", "7 Recap"]) assert.match(all, new RegExp(tab));
	assert.match(all, /sugg-watch · Every 6 minutes · in 5m · idle/);
	assert.doesNotMatch(all, /Prompt:/);
	assert.match(all, /Press 6 to select a job/);
	assert.match(owner.activityHints(), /6 job controls/);
	assert.equal(owner.activityInput("6"), true);
	const schedules = owner.renderOverview(styler, 80).join("\n");
	assert.match(schedules, /› sugg-watch/);
	assert.match(schedules, /Schedule: Every 6 minutes/);
	assert.match(schedules, /Last run: never/);
	assert.match(schedules, /and report changes\./);
	assert.doesNotMatch(schedules, /Agents\n/);
	assert.equal(owner.activityInput("p"), true);
	assert.equal(owner.activityInput("n"), true);
	assert.equal(owner.activityInput("d"), true);
	assert.match(owner.renderOverview(styler, 80).join("\n"), /Remove sugg-watch\?/);
	assert.equal(owner.activityInput("x"), true);
	assert.equal(owner.activityInput("d"), true);
	assert.equal(owner.activityInput("y"), true);
	assert.equal(owner.activityInput("g"), true);
	assert.deepEqual(requests, [{ action: "pause", id: "sugg-watch" }, { action: "run", id: "sugg-watch" }, { action: "remove", id: "sugg-watch" }, { action: "pause" }]);
	assert.equal(owner.activityInput("q"), false);
	assert.equal(owner.activityInput("1"), true);
	assert.match(owner.renderOverview(styler, 80).join("\n"), /Agents/);
	owner.dispose();
});
