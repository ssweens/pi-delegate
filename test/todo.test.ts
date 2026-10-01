import assert from "node:assert/strict";
import { test } from "node:test";
import {
	addTask,
	blockTask,
	completeTask,
	countOpen,
	dropTask,
	emptyState,
	markdownToPhases,
	parseTodoState,
	phasesToMarkdown,
	removeTask,
	startTask,
	unblockTask,
	viewTasks,
} from "../src/todo.ts";

test("addTask creates a phase and pending task", () => {
	const s = addTask(emptyState(), "Tasks", "scaffold crate");
	assert.equal(s.phases.length, 1);
	assert.deepEqual(s.phases[0]!.tasks[0], { content: "scaffold crate", status: "pending" });
});

test("addTask appends to an existing phase", () => {
	let s = addTask(emptyState(), "Tasks", "a");
	s = addTask(s, "Tasks", "b");
	assert.deepEqual(s.phases[0]!.tasks.map((t) => t.content), ["a", "b"]);
});

test("operations return new state and leave the input untouched", () => {
	const before = addTask(emptyState(), "T", "a");
	const snapshot = JSON.stringify(before);
	startTask(before, "a");
	completeTask(before, "a");
	dropTask(before, "a");
	blockTask(before, "a", "why");
	unblockTask(before, "a");
	removeTask(before, "a");
	assert.equal(JSON.stringify(before), snapshot);
});

test("startTask marks a task in_progress and demotes any other in_progress", () => {
	let s = addTask(addTask(emptyState(), "T", "a"), "T", "b");
	s = startTask(s, "a");
	s = startTask(s, "b");
	assert.equal(s.phases[0]!.tasks.find((t) => t.content === "a")!.status, "pending");
	assert.equal(s.phases[0]!.tasks.find((t) => t.content === "b")!.status, "in_progress");
});

test("completeTask auto-promotes the earliest open task", () => {
	let s = addTask(addTask(addTask(emptyState(), "T", "a"), "T", "b"), "T", "c");
	s = completeTask(s, "a");
	assert.equal(s.phases[0]!.tasks.find((t) => t.content === "a")!.status, "completed");
	assert.equal(s.phases[0]!.tasks.find((t) => t.content === "b")!.status, "in_progress");
});

test("block/unblock set and clear the blocker", () => {
	let s = addTask(emptyState(), "T", "a");
	s = blockTask(s, "a", "waiting on API");
	assert.deepEqual(s.phases[0]!.tasks[0], { content: "a", status: "blocked", blocker: "waiting on API" });
	s = unblockTask(s, "a");
	assert.equal(s.phases[0]!.tasks[0]!.status, "pending");
	assert.equal(s.phases[0]!.tasks[0]!.blocker, undefined);
});

test("drop marks abandoned; rm removes the task and its empty phase", () => {
	let s = addTask(addTask(emptyState(), "T", "a"), "T", "b");
	s = dropTask(s, "a");
	assert.equal(s.phases[0]!.tasks.find((t) => t.content === "a")!.status, "abandoned");
	s = removeTask(s, "b");
	assert.deepEqual(s.phases[0]!.tasks.map((t) => t.content), ["a"]);
	s = removeTask(s, "a");
	assert.deepEqual(s.phases, []);
});

test("countOpen counts pending, in_progress and blocked only", () => {
	let s = addTask(emptyState(), "T", "a");
	s = addTask(s, "T", "b");
	s = addTask(s, "T", "c");
	s = dropTask(s, "c");
	s = completeTask(s, "b");
	assert.equal(countOpen(s), 1);
});

test("markdown round-trip preserves state", () => {
	let s = emptyState();
	s = addTask(s, "Foundation", "scaffold crate");
	s = startTask(s, "scaffold crate");
	s = addTask(s, "Foundation", "wire workspace");
	s = addTask(s, "🧪 Tests", "run tests");
	s = completeTask(s, "scaffold crate");
	s = addTask(s, "Foundation", "blocked task");
	s = blockTask(s, "blocked task", "waiting on API");

	const md = phasesToMarkdown(s);
	assert.ok(md.includes("# Foundation"));
	assert.ok(md.includes("[x] scaffold crate"));
	assert.ok(md.includes("<!-- blocker: waiting on API -->"));
	assert.ok(md.includes("# 🧪 Tests"));

	const parsed = markdownToPhases(md);
	assert.deepEqual(parsed, s);
});

test("viewTasks reports open counts", () => {
	let s = addTask(addTask(emptyState(), "T", "a"), "T", "b");
	assert.ok(viewTasks(s).includes("2/2 open"));
	s = completeTask(s, "a");
	assert.ok(viewTasks(s).includes("1/2 open"));
});

test("parseTodoState accepts a well-formed persisted state", () => {
	const state = { phases: [{ name: "Work", tasks: [{ content: "a", status: "pending" }, { content: "b", status: "blocked", blocker: "CI" }] }] };
	assert.deepEqual(parseTodoState(state), state);
	assert.deepEqual(parseTodoState({ phases: [] }), { phases: [] });
});

test("parseTodoState rejects malformed persisted input", () => {
	const bad: unknown[] = [
		undefined,
		null,
		"phases",
		[],
		{},
		{ phases: "nope" },
		{ phases: [null] },
		{ phases: [{ name: 7, tasks: [] }] },
		{ phases: [{ name: "a" }] },
		{ phases: [{ name: "a", tasks: "nope" }] },
		{ phases: [{ name: "a", tasks: ["a"] }] },
		{ phases: [{ name: "a", tasks: [{ content: "a", status: "done" }] }] },
		{ phases: [{ name: "a", tasks: [{ content: 1, status: "pending" }] }] },
		{ phases: [{ name: "a", tasks: [{ content: "a", status: "pending", blocker: 5 }] }] },
	];
	for (const value of bad) assert.equal(parseTodoState(value), undefined, `should reject ${JSON.stringify(value)}`);
});
