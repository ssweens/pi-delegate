/** The pure part of Amp observation (todo 044): cursor, version, bound. The CLI path is in acp-native.test.ts. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { observationText, selectObserved } from "../src/amp-observe.ts";

const T = "T-00000000-0000-0000-0000-000000000001";
const at = "2026-09-30T00:00:00.000Z";
const msg = (messageId: number | undefined, text: string, extra: Record<string, unknown> = {}) => ({ ...(messageId !== undefined ? { messageId } : {}), role: "user", content: [{ type: "text", text }], ...extra });

test("first observation lists every message; a later one lists only what follows the cursor", () => {
	const thread = { v: 1, updatedAt: "u1", messages: [msg(1, "a"), msg(2, "b")] };
	const first = selectObserved(T, thread, undefined, 10_000, at);
	assert.deepEqual(first.observation.messages.map((m) => m.text), ["a", "b"]);
	assert.equal(first.observation.state, "changed");
	assert.deepEqual(first.cursor, { remaining: 0, at, messageId: "2", version: 1, updatedAt: "u1" });
	const same = selectObserved(T, thread, first.cursor, 10_000, at);
	assert.equal(same.observation.state, "unchanged");
	const next = selectObserved(T, { v: 2, updatedAt: "u2", messages: [...thread.messages, msg(3, "c")] }, first.cursor, 10_000, at);
	assert.deepEqual(next.observation.messages.map((m) => m.text), ["c"]);
	const moved = selectObserved(T, { v: 3, updatedAt: "u3", messages: [...thread.messages, msg(3, "c")] }, next.cursor, 10_000, at);
	assert.deepEqual([moved.observation.state, moved.observation.messages.length], ["changed", 0], "a version change with no new message is a change, with nothing to list");
});

test("a cursor no longer in the thread lists from the start and says so", () => {
	const out = selectObserved(T, { v: 2, messages: [msg(7, "x")] }, { messageId: "3", version: 1, remaining: 0, at }, 10_000, at);
	assert.equal(out.observation.cursorReset, true);
	assert.deepEqual(out.observation.messages.map((m) => m.text), ["x"]);
	assert.match(observationText(out.observation), /no longer in the thread, so this lists from its start/);
});

test("without a version, no change means only no message after the cursor", () => {
	const thread = { messages: [msg(1, "a")] };
	const first = selectObserved(T, thread, undefined, 10_000, at);
	assert.equal(selectObserved(T, thread, first.cursor, 10_000, at).observation.state, "unchanged");
	assert.equal(selectObserved(T, { messages: [msg(1, "a"), msg(2, "b")] }, first.cursor, 10_000, at).observation.state, "changed");
});

test("missing fields are unknown; non-text blocks are markers", () => {
	const out = selectObserved(T, { messages: [{ content: [{ type: "tool_use", name: "Bash" }, { type: "text", text: "t" }] }] }, undefined, 10_000, at);
	const [m] = out.observation.messages;
	assert.deepEqual([m!.messageId, m!.role, m!.author, m!.createdAt, m!.text], ["unknown", "unknown", "unknown", "unknown", "[tool_use Bash]\nt"]);
	assert.equal(out.cursor.messageId, undefined, "a message without an ID cannot be a cursor");
});

test("the bound cuts the first message on a character boundary and pages the rest", () => {
	const out = selectObserved(T, { v: 1, messages: [msg(1, "é".repeat(500)), msg(2, "next")] }, undefined, 300, at);
	const [m] = out.observation.messages;
	assert.equal(out.observation.messages.length, 1);
	assert.equal(m!.truncated, true);
	assert.equal(m!.text.includes("�"), false);
	assert.ok(Buffer.byteLength(m!.text) < 300);
	assert.deepEqual([out.observation.remaining, out.observation.truncated, out.cursor.messageId, out.cursor.offset], [1, true, undefined, m!.text.length]);
	const rest = selectObserved(T, { v: 1, messages: [msg(1, "é".repeat(500)), msg(2, "next")] }, out.cursor, 300, at);
	const [more] = rest.observation.messages;
	assert.deepEqual([rest.observation.state, more!.messageId, more!.continued, rest.observation.remaining], ["unchanged", "1", true, 1], "the cut message continues where it was cut");
	assert.match(observationText(rest.observation), /#1 user · author unknown · unknown · continued/);
});

test("a message larger than the bound is returned in parts across observations, none of it lost", () => {
	const long = "é".repeat(500) + "END";
	const thread = { v: 1, messages: [msg(1, long), msg(2, "next")] };
	let cursor: ReturnType<typeof selectObserved>["cursor"] | undefined;
	const parts: string[] = [], after: string[] = [];
	for (let i = 0; i < 10; i++) {
		const out = selectObserved(T, thread, cursor, 300, at);
		for (const m of out.observation.messages) (m.messageId === "1" ? parts : after).push(m.text);
		cursor = out.cursor;
		if (!out.observation.truncated) break;
	}
	assert.equal(parts.join(""), long, "every part of the cut message is returned, in order");
	assert.deepEqual(after, ["next"]);
	assert.equal(selectObserved(T, thread, cursor, 300, at).observation.messages.length, 0, "then nothing is left");
});
