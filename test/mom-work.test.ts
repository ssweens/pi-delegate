import assert from "node:assert/strict";
import { test } from "node:test";
import { projectWork, type WorkEntry } from "../src/work/projection.ts";

const todo = (ref: string, stream: string, actor: string, data: unknown): WorkEntry => ({
	ref, stream, actor, entry: { type: "custom", customType: "pi_delegate.todo", data },
});

test("projects lead and worker todo snapshots without merging their authorities", () => {
	const projection = projectWork({ entries: [
		todo("lead:todo-1", "lead-session", "lead", { phases: [{ name: "Build", tasks: [{ content: "Wire Mom", status: "blocked", blocker: "M1" }] }] }),
		todo("worker:todo-2", "worker-session", "worker role worker-1", { phases: [{ name: "Tests", tasks: [{ content: "Run focused checks", status: "in_progress" }] }] }),
	] });
	assert.deepEqual(projection.leadTodos.map(({ content, status, blocker, sourceRef }) => ({ content, status, blocker, sourceRef })), [{
		content: "Wire Mom", status: "blocked", blocker: "M1", sourceRef: { ref: "lead:todo-1", stream: "lead-session", actor: "lead" },
	}]);
	assert.deepEqual(projection.workerTodos.map(({ content, status, sourceRef }) => ({ content, status, sourceRef })), [{
		content: "Run focused checks", status: "in_progress", sourceRef: { ref: "worker:todo-2", stream: "worker-session", actor: "worker" },
	}]);
});

test("keeps delegate task and terminal receipt fields distinct", () => {
	const projection = projectWork({ entries: [
		{ ref: "lead-session:entry-0", stream: "lead-session", actor: "lead", entry: {
			type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "delegate", id: "call-1", arguments: { role: "scout", task: "Build the thing", backend: "acp" } }] },
		} },
		{ ref: "lead-session:entry-1", stream: "lead-session", actor: "lead", entry: {
			type: "message", message: { role: "toolResult", toolName: "delegate", toolCallId: "call-1", details: {
				id: "worker-1", status: "complete", segment: 1, backend: "acp", completionReceipt: true,
				turn: { delivery: "accepted", providerOutcome: "completed" }, output: "done",
			} },
		} },
	] });
	assert.deepEqual(projection.delegateTasks.map(({ runId, task, status, segment, backend, delivery, providerOutcome }) => ({ runId, task, status, segment, backend, delivery, providerOutcome })), [
		{ runId: "worker-1", task: "Build the thing", status: "complete", segment: 1, backend: "acp", delivery: "accepted", providerOutcome: "completed" },
	]);
	assert.deepEqual(projection.terminalReceipts.map(({ runId, status, segment, backend, delivery, providerOutcome, output, sourceRef }) => ({ runId, status, segment, backend, delivery, providerOutcome, output, sourceRef })), [{
		runId: "worker-1", status: "complete", segment: 1, backend: "acp", delivery: "accepted", providerOutcome: "completed", output: "done",
		sourceRef: { ref: "lead-session:entry-1", stream: "lead-session", actor: "terminal" },
	}]);
});
