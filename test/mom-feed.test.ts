import assert from "node:assert/strict";
import { test } from "node:test";
import { LiveFeed } from "../src/mom/feed.ts";

const leadTodo = { type: "custom", id: "todo-lead", parentId: null, timestamp: new Date().toISOString(), customType: "pi_delegate.todo", data: { phases: [] } };

const manager = {
	getSessionId: () => "lead-session",
	getSessionFile: () => "/tmp/lead-session.jsonl",
	getCwd: () => process.cwd(),
	getLeafId: () => "todo-lead",
	getEntry: (id: string) => id === leadTodo.id ? leadTodo : undefined,
	getBranch: () => [leadTodo],
};

test("retains structured todo entries with lead and worker stream identity", async () => {
	const feed = new LiveFeed(manager);
	await feed.capture(Infinity);
	feed.observe({ key: "worker-session", parent: "lead-session", entries: [{
		type: "custom", id: "todo-worker", customType: "pi_delegate.todo", data: { phases: [] },
	}] });
	assert.deepEqual(feed.todoEntries().map(({ ref, stream, actor }) => ({ ref, stream, actor })), [
		{ ref: "lead-session:todo-lead", stream: "lead-session", actor: "lead" },
		{ ref: "worker-session:todo-worker", stream: "worker-session", actor: "mom" },
	]);
});
