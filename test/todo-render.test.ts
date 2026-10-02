import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { addTask, blockTask, completeTask, dropTask, emptyState, startTask } from "../src/todo.ts";
import {
	CHECKED,
	UNCHECKED,
	renderTodoLines,
	renderTodoWidgetLines,
	romanNumeral,
	type TodoStyler,
} from "../src/todo-render.ts";

/** Stub styler that wraps text in `⟨color:›text` markers for assertion. */
const stubTheme: TodoStyler = {
	fg: (color, text) => `⟨${color}›${text}`,
	bold: (text) => `[${text}]`,
	strikethrough: (text) => `~${text}~`,
};

const plainTheme: TodoStyler = {
	fg: (_color, text) => text,
	bold: (text) => text,
	strikethrough: (text) => text,
};

test("romanNumeral covers phases up to 14", () => {
	assert.equal(romanNumeral(1), "I");
	assert.equal(romanNumeral(4), "IV");
	assert.equal(romanNumeral(12), "XII");
	assert.equal(romanNumeral(20), "20");
});

test("renderTodoLines emits a status header plus flat task tree with status-styled tasks", () => {
	let s = emptyState();
	s = addTask(s, "Base", "Wire the router");
	s = addTask(s, "Base", "Add tests");
	s = addTask(s, "Base", "Scaffold blockers");
	s = startTask(s, "Wire the router");
	s = blockTask(s, "Scaffold blockers", "waiting on API");
	s = completeTask(s, "Wire the router");

	const lines = renderTodoLines(s, stubTheme, 80);

	// Framed status header in the top border: `╭─ ☑ Todo · N tasks ─╮`.
	assert.ok(lines[0]!.includes("Todo"));
	assert.ok(lines[0]!.includes("3 tasks"));

	// Single-phase: no phase header — tasks start at lines[1].
	assert.ok(lines[1]!.includes(CHECKED));
	assert.ok(lines[1]!.includes("~Wire the router~"));

	// Auto-promoted in-progress task: accent.
	assert.ok(lines[2]!.includes(UNCHECKED));
	assert.ok(lines[2]!.includes("⟨accent›☐ Add tests"));

	// Blocked task: warning + blocker note.
	assert.ok(lines[3]!.includes("⟨warning›"));
	assert.ok(lines[3]!.includes("(blocked: waiting on API)"));
});

test("tool result frame matches the Agents panel frame construction", () => {
	const s = addTask(emptyState(), "Base", "One");
	const lines = renderTodoLines(s, plainTheme, 40);
	// Top border: `╭─` lead, header label, dashes to the right corner.
	assert.ok(lines[0]!.startsWith("╭─ ☑ Todo 1 task"));
	assert.ok(lines[0]!.endsWith("─╮"));
	// Bottom border: plain `╰` corner and a full dash run — no omp `╰───` cap.
	assert.equal(lines.at(-1), `╰${"─".repeat(38)}╯`);
	assert.ok(lines.every((line) => visibleWidth(line) === 40));
});

test("renderTodoLines clips a long task label to width with an ellipsis", () => {
	let s = addTask(emptyState(), "Base", "this is an extremely long task description that must be truncated");
	const lines = renderTodoLines(s, plainTheme, 20);
	assert.ok(lines.every((line) => visibleWidth(line) <= 20));
	assert.ok(lines[1]!.includes("…"));
});

test("empty phases produce only the header", () => {
	const lines = renderTodoLines(emptyState(), stubTheme, 60);
	assert.equal(lines.length, 2);
	assert.ok(lines[0]!.includes("0 tasks"));
});

test("panel and widget stay within width for every rendered task status", () => {
	let s = emptyState();
	s = addTask(s, "Tasks", "Pending task with a long label");
	s = addTask(s, "Tasks", "In-progress task with a long label");
	s = addTask(s, "Tasks", "Blocked task with a very long blocker reason");
	s = addTask(s, "Tasks", "Abandoned task with a long label");
	s = startTask(s, "In-progress task with a long label");
	s = blockTask(s, "Blocked task with a very long blocker reason", "waiting for a very long external dependency");
	s = completeTask(s, "Abandoned task with a long label");
	s = dropTask(s, "Abandoned task with a long label");

	const panel = renderTodoLines(s, plainTheme, 12);
	const widget = renderTodoWidgetLines(s, plainTheme, 12);
	assert.ok(panel.every((line) => visibleWidth(line) <= 12));
	assert.ok(widget.every((line) => visibleWidth(line) <= 12));
});

test("widget keeps the active phase visible while bounding its task preview", () => {
	let s = emptyState();
	for (let i = 1; i <= 8; i++) s = addTask(s, "Research", `Research task ${i}`);
	s = addTask(s, "Verify", "Run unit tests");
	s = addTask(s, "Verify", "Smoke-test the widget");
	s = completeTask(s, "Research task 1");
	s = startTask(s, "Research task 4");
	s = blockTask(s, "Research task 5", "waiting on CI");

	const lines = renderTodoWidgetLines(s, stubTheme, 80);

	// Agents-panel frame: the "Todos · 1/2" header sits in the top border.
	assert.ok(lines[0]!.startsWith("⟨borderMuted›╭─"));
	assert.ok(lines[0]!.includes("Todos"));
	assert.ok(lines[0]!.includes("1/2"));

	assert.ok(lines[1]!.includes("I. Research"));
	assert.ok(lines[2]!.includes("Research task 4"));
	assert.ok(!lines.some((line) => line.includes("Research task 1")));
	assert.ok(lines.some((line) => line.includes("2 more tasks")));
	assert.ok(lines.some((line) => line.includes("II. Verify")));
});

test("widget renders the Agents panel frame: header in the top border, tree inside", () => {
	let s = emptyState();
	s = addTask(s, "Research", "Call the API");
	s = startTask(s, "Call the API");
	s = addTask(s, "Verify", "Check the response");

	const lines = renderTodoWidgetLines(s, plainTheme, 40);

	assert.ok(lines[0]!.startsWith("╭─ Todos · 1/2"));
	assert.ok(lines[0]!.endsWith("─╮"));
	assert.ok(lines[1]!.startsWith("│ ├─ I. Research"));
	assert.equal(lines.at(-1), `╰${"─".repeat(38)}╯`);
	assert.ok(lines.every((line) => visibleWidth(line) === 40));
});

test("widget keeps blocked work in the active phase", () => {
	let s = addTask(emptyState(), "Blocked", "Wait for CI");
	s = addTask(s, "Later", "Already complete");
	s = blockTask(s, "Wait for CI", "waiting on CI");
	s = completeTask(s, "Already complete");

	const lines = renderTodoWidgetLines(s, stubTheme, 80);
	assert.ok(lines[1]!.includes("I. Blocked"));
	assert.ok(lines.some((line) => line.includes("Wait for CI")));
});

test("widget clips every row at narrow widths", () => {
	let s = emptyState();
	for (let i = 1; i <= 6; i++) s = addTask(s, "Research", `Task ${i}`);
	for (let i = 1; i <= 6; i++) s = addTask(s, `Later ${i}`, `Follow-up ${i}`);

	const lines = renderTodoWidgetLines(s, plainTheme, 16);
	assert.ok(lines.every((line) => visibleWidth(line) <= 16));
});

test("widget has no rows after all work is complete", () => {
	assert.deepEqual(renderTodoWidgetLines(emptyState(), stubTheme, 40), []);
});
