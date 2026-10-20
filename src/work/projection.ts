import { parseTodoState, type TodoStatus } from "../todo.js";
import type { RunView } from "../render.js";

export type WorkProjectionKind = "todo" | "delegate-task" | "terminal-receipt";
export type WorkProjectionActor = "lead" | "worker" | "delegate" | "terminal";

export interface WorkSourceRef {
	ref: string;
	stream: string;
	actor: WorkProjectionActor;
}

export interface TodoProjection {
	kind: "todo";
	id: string;
	phase: string;
	content: string;
	status: TodoStatus;
	blocker?: string;
	actor: "lead" | "worker";
	stream: string;
	sourceRef: WorkSourceRef;
}

export interface DelegateTaskProjection {
	kind: "delegate-task";
	id: string;
	runId: string;
	task: string;
	status: string;
	actor: "delegate";
	stream: string;
	segment?: number;
	backend?: "pi" | "acp";
	delivery?: string;
	providerOutcome?: string;
	sourceRef: WorkSourceRef;
}

export interface TerminalReceiptProjection {
	kind: "terminal-receipt";
	id: string;
	runId: string;
	status: string;
	segment: number;
	actor: "terminal";
	stream: string;
	backend?: "pi" | "acp";
	delivery?: string;
	providerOutcome?: string;
	output?: string;
	sourceRef: WorkSourceRef;
}

export interface WorkProjection {
	leadTodos: TodoProjection[];
	workerTodos: TodoProjection[];
	delegateTasks: DelegateTaskProjection[];
	terminalReceipts: TerminalReceiptProjection[];
}

export interface WorkEntry {
	ref: string;
	stream: string;
	actor: string;
	entry: Record<string, any>;
}

export interface WorkProjectionInput {
	entries?: readonly WorkEntry[];
	delegateRuns?: readonly RunView[];
}

export const emptyWorkProjection = (): WorkProjection => ({ leadTodos: [], workerTodos: [], delegateTasks: [], terminalReceipts: [] });

const text = (value: unknown): string => typeof value === "string" ? value : "";
const detailsOf = (value: unknown): Record<string, any> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
const sourceActor = (actor: string): "lead" | "worker" => actor === "lead" ? "lead" : "worker";
const messageOf = (entry: Record<string, any>): Record<string, any> | undefined =>
	entry.type === "message" && detailsOf(entry.message) ? entry.message : entry.type === "custom_message" ? entry : undefined;
const blocksOf = (message: Record<string, any>): readonly Record<string, any>[] => Array.isArray(message.content) ? message.content.filter(detailsOf) as Record<string, any>[] : [];
const runIdOf = (value: unknown): string | undefined => {
	const details = detailsOf(value);
	return typeof details?.id === "string" ? details.id : undefined;
};
const segmentOf = (value: unknown): number | undefined => {
	const segment = detailsOf(value)?.segment;
	return Number.isInteger(segment) && segment > 0 ? segment : undefined;
};
const backendOf = (value: unknown): "pi" | "acp" | undefined => {
	const details = detailsOf(value);
	return details?.backend === "pi" || details?.backend === "acp" ? details.backend : undefined;
};
const turnOf = (value: unknown): Record<string, any> | undefined => {
	const details = detailsOf(value);
	return detailsOf(details?.turn);
};
const source = (ref: string, stream: string, actor: WorkProjectionActor): WorkSourceRef => ({ ref, stream, actor });

function projectTodos(entry: WorkEntry, target: WorkProjection): void {
	const state = parseTodoState(entry.entry.data);
	if (!state) return;
	const actor = sourceActor(entry.actor);
	for (let phaseIndex = 0; phaseIndex < state.phases.length; phaseIndex++) {
		const phase = state.phases[phaseIndex]!;
		for (let taskIndex = 0; taskIndex < phase.tasks.length; taskIndex++) {
			const task = phase.tasks[taskIndex]!;
			const item: TodoProjection = {
				kind: "todo", id: `${entry.ref}:${phaseIndex}:${taskIndex}`, phase: phase.name, content: task.content,
				status: task.status, actor, stream: entry.stream, sourceRef: source(entry.ref, entry.stream, actor),
				...(task.blocker !== undefined ? { blocker: task.blocker } : {}),
			};
			(actor === "lead" ? target.leadTodos : target.workerTodos).push(item);
		}
	}
}

function taskFrom(runId: string, status: string, ref: WorkSourceRef, value: unknown): DelegateTaskProjection {
	const details = detailsOf(value);
	const turn = turnOf(value);
	const segment = segmentOf(value);
	return {
		kind: "delegate-task", id: `${runId}:${segment ?? 1}`, runId, task: text(details?.task), status,
		actor: "delegate", stream: ref.stream, sourceRef: { ...ref, actor: "delegate" },
		...(segment === undefined ? {} : { segment }), ...(backendOf(value) ? { backend: backendOf(value) } : {}),
		...(typeof turn?.delivery === "string" ? { delivery: turn.delivery } : {}),
		...(typeof turn?.providerOutcome === "string" ? { providerOutcome: turn.providerOutcome } : {}),
	};
}

function receiptFrom(runId: string, status: string, ref: WorkSourceRef, value: unknown): TerminalReceiptProjection {
	const details = detailsOf(value);
	const turn = turnOf(value);
	const segment = segmentOf(value) ?? 1;
	return {
		kind: "terminal-receipt", id: `${runId}:${segment}`, runId, status, segment, actor: "terminal", stream: ref.stream,
		sourceRef: { ...ref, actor: "terminal" }, ...(backendOf(value) ? { backend: backendOf(value) } : {}),
		...(typeof turn?.delivery === "string" ? { delivery: turn.delivery } : {}),
		...(typeof turn?.providerOutcome === "string" ? { providerOutcome: turn.providerOutcome } : {}),
		...(typeof details?.output === "string" ? { output: details.output } : {}),
	};
}

function projectDelegateEntry(entry: WorkEntry, target: WorkProjection, runByCallId: ReadonlyMap<string, string>): void {
	const message = messageOf(entry.entry);
	if (!message) return;
	const ref = source(entry.ref, entry.stream, "delegate");
	if (message.role === "assistant") {
		for (const block of blocksOf(message)) {
			if (block.type !== "toolCall" || block.name !== "delegate") continue;
			const runId = runIdOf(block.arguments) ?? (typeof block.id === "string" ? runByCallId.get(block.id) ?? block.id : undefined);
			if (!runId) continue;
			const details = detailsOf(block.arguments);
			target.delegateTasks.push(taskFrom(runId, "requested", ref, { task: details?.task, segment: 1, backend: details?.backend }));
		}
	}
	if (message.role !== "toolResult" && message.role !== "custom") return;
	const details = detailsOf(message.details);
	const runId = runIdOf(details);
	if (!runId) return;
	const status = text(details?.status) || (message.isError ? "error" : "complete");
	const segment = segmentOf(details) ?? 1;
	if (message.role === "toolResult" && message.toolName !== "delegate") return;
	target.delegateTasks.push(taskFrom(runId, status, ref, details));
	if (details?.completionReceipt === true || ["complete", "error", "cancelled", "timeout", "interrupted", "stopped", "expired"].includes(status)) {
		target.terminalReceipts.push(receiptFrom(runId, status, ref, details));
	}
}

function projectRun(run: RunView, target: WorkProjection): void {
	const ref = source(`delegate:${run.id}:${run.segment}`, "delegate", "delegate");
	target.delegateTasks.push(taskFrom(run.id, run.status, ref, run));
	if (run.completionReceipt || run.settled) target.terminalReceipts.push(receiptFrom(run.id, run.status, source(`delegate:${run.id}:${run.segment}`, "delegate", "terminal"), run));
}

const uniqueBy = <T>(items: readonly T[], key: (item: T) => string): T[] => {
	const seen = new Set<string>(), result: T[] = [];
	for (const item of items) { const id = key(item); if (seen.has(id)) continue; seen.add(id); result.push(item); }
	return result;
};
const latestBy = <T>(items: readonly T[], key: (item: T) => string): T[] => {
	const latest = new Map<string, T>();
	for (const item of items) latest.set(key(item), item);
	return [...latest.values()];
};

/** Pure, read-only projection. It never mutates a todo, Path graph, delegate record, or sidecar. */
export function projectWork(input: WorkProjectionInput = {}): WorkProjection {
	const result = emptyWorkProjection();
	const entries = input.entries ?? [];
	const runByCallId = new Map<string, string>();
	for (const entry of entries) {
		const message = messageOf(entry.entry);
		if (message?.role !== "toolResult" || message.toolName !== "delegate") continue;
		const runId = runIdOf(message.details);
		if (runId && typeof message.toolCallId === "string") runByCallId.set(message.toolCallId, runId);
	}
	for (const entry of entries) { projectTodos(entry, result); projectDelegateEntry(entry, result, runByCallId); }
	for (const run of input.delegateRuns ?? []) projectRun(run, result);
	result.leadTodos = uniqueBy(result.leadTodos, item => item.id);
	result.workerTodos = uniqueBy(result.workerTodos, item => item.id);
	const tasks = new Map<string, DelegateTaskProjection>();
	for (const task of result.delegateTasks) {
		const key = `${task.runId}:${task.segment ?? 1}`;
		const previous = tasks.get(key);
		tasks.set(key, previous && !task.task ? { ...task, task: previous.task } : task);
	}
	result.delegateTasks = [...tasks.values()];
	result.terminalReceipts = latestBy(result.terminalReceipts, item => item.id);
	return result;
}
