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

import { extractEvents, isUserDirection, renderUpdateEvents } from "../src/mom/feed.ts";

const userEntry = (id: string, parentId: string | null, text: string) =>
	({ type: "message", id, parentId, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text }] } });
const stream = { key: "s", actor: "lead" };

test("a skill expansion is collapsed to a marker and the real request survives", () => {
	const skill = `<skill name="ssweens-mode" location="/x/SKILL.md">\n${"body ".repeat(5000)}\n</skill>\n\nReview this session`;
	assert.ok(skill.length > 25000);
	const events = extractEvents(stream, userEntry("u1", null, skill));
	assert.equal(events.length, 1);
	assert.match(events[0].text!, /Review this session/);
	assert.match(events[0].text!, /\[skill ssweens-mode loaded .*inspect_evidence s:u1 returns the original\]/);
	assert.ok(events[0].text!.length < 500);
	assert.ok(isUserDirection(events[0]));
});

test("an unclosed skill block is left alone but still bounded", () => {
	const events = extractEvents(stream, userEntry("u1", null, `<skill name="a">${"x".repeat(30000)}`));
	assert.match(events[0].text!, /\[Clipped: \d+ of 30\d+ chars left out; inspect_evidence s:u1/);
	assert.ok(renderUpdateEvents(events).length < 9000);
});

test("a 30k plain user message is clipped explicitly", () => {
	const events = extractEvents(stream, userEntry("u1", null, "y".repeat(30000)));
	assert.ok(events[0].text!.length <= 8000);
	assert.match(events[0].text!, /\[Clipped: \d+ of 30000 chars left out; inspect_evidence s:u1 returns the full original text\.\]$/);
});

test("capture advances past an oversized user entry", async () => {
	const entries = [userEntry("a", null, "first"), userEntry("b", "a", `<skill name="k" location="/l">${"z".repeat(25000)}</skill>\nDo it`),
		userEntry("c", "b", "y".repeat(30000)), userEntry("d", "c", "last")];
	const mgr = { getSessionId: () => "sess", getSessionFile: () => "/tmp/sess.jsonl", getCwd: () => process.cwd(),
		getLeafId: () => "d", getEntry: (id: string) => entries.find(e => e.id === id), getBranch: () => entries };
	const feed = new LiveFeed(mgr);
	const batch = await feed.capture();
	assert.deepEqual(batch.gaps, []);
	assert.deepEqual(batch.events.map(e => e.ref), ["sess:a", "sess:b", "sess:c", "sess:d"]);
});
