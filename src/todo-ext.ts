/**
 * Canonical phased-todo extension for stock Pi: `todo` tool, `/todo` command,
 * the bounded above-editor widget, session-backed persistence, Markdown
 * import/export, and bounded incomplete-work reminders.
 *
 * Ownership moved here from pi-omp. State lives in session custom entries under
 * {@link TODO_CUSTOM_TYPE}; entries written by the old owner
 * ({@link LEGACY_TODO_CUSTOM_TYPE}) are still read, so an existing session
 * keeps its todos without any pi-omp code on the other side.
 */
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type TodoState,
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
} from "./todo.js";
import {
	renderTodoCallHeader,
	todoCollapsedComponent,
	todoErrorComponent,
	todoPanelComponent,
	todoWidgetComponent,
} from "./todo-render.js";

/** Custom-entry namespace owned by pi-delegate. */
export const TODO_CUSTOM_TYPE = "pi_delegate.todo";
/** Legacy namespace written by pi-omp; read-only migration source. */
export const LEGACY_TODO_CUSTOM_TYPE = "pi_omp.todo";
export const TODO_WIDGET_KEY = "pi-delegate.todo";
/** Default phase for `/todo add`. */
export const TODO_DEFAULT_PHASE = "Tasks";
/** Default Markdown path for `/todo export|import`. */
export const TODO_FILE = "TODO.md";
/** Reminder cap per session (OMP's `todo.remindersMax`). */
export const TODO_MAX_REMINDERS = 2;

/** What state loading needs from Pi's session (stub-able in tests). */
export interface TodoBranchSource {
	getBranch(): readonly unknown[];
}

/** Structured details: the op plus the full state for the colored renderer. */
interface TodoToolDetails {
	op: TodoParams["op"];
	open: number;
	state: TodoState;
}

const PARAMS = Type.Object({
	op: Type.Union([
		Type.Literal("init"),
		Type.Literal("add"),
		Type.Literal("start"),
		Type.Literal("done"),
		Type.Literal("drop"),
		Type.Literal("block"),
		Type.Literal("unblock"),
		Type.Literal("rm"),
		Type.Literal("view"),
	]),
	phase: Type.Optional(Type.String()),
	content: Type.Optional(Type.String()),
	blocker: Type.Optional(Type.String()),
});
type TodoParams = Static<typeof PARAMS>;

function entryState(entry: unknown): TodoState | undefined {
	if (!entry || typeof entry !== "object") return undefined;
	const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
	if (e.type !== "custom") return undefined;
	if (e.customType !== TODO_CUSTOM_TYPE && e.customType !== LEGACY_TODO_CUSTOM_TYPE) return undefined;
	return parseTodoState(e.data);
}

/**
 * Rehydrate from the newest todo entry on the current branch. Entries written by
 * this package win; legacy pi-omp entries are the fallback until the first
 * delegate-owned write, which is what makes the ownership move invisible to a
 * session that already has todos. Malformed entries are skipped, not fatal.
 */
export function loadState(sessionManager: TodoBranchSource): TodoState {
	let legacy: TodoState | undefined;
	const entries = sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const raw = entries[i] as { customType?: unknown } | undefined;
		const state = entryState(entries[i]);
		if (!state) continue;
		if (raw?.customType === TODO_CUSTOM_TYPE) return state;
		legacy ??= state;
	}
	return legacy ?? emptyState();
}

function applyOp(state: TodoState, p: TodoParams): TodoState {
	switch (p.op) {
		case "init":
			return emptyState();
		case "add":
			return addTask(state, p.phase ?? TODO_DEFAULT_PHASE, p.content ?? "");
		case "start":
			return startTask(state, p.content ?? "");
		case "done":
			return completeTask(state, p.content ?? "");
		case "drop":
			return dropTask(state, p.content ?? "");
		case "block":
			return blockTask(state, p.content ?? "", p.blocker);
		case "unblock":
			return unblockTask(state, p.content ?? "");
		case "rm":
			return removeTask(state, p.content ?? "");
		case "view":
		default:
			return state;
	}
}

export function syncTodoWidget(ui: Pick<ExtensionCommandContext["ui"], "setWidget">, state: TodoState): void {
	if (countOpen(state) === 0) {
		ui.setWidget(TODO_WIDGET_KEY, undefined);
		return;
	}
	ui.setWidget(TODO_WIDGET_KEY, (_tui, theme) => todoWidgetComponent(state, theme), {
		placement: "aboveEditor",
	});
}

/** Incomplete-work reminder text, or undefined when nothing is open. */
export function todoReminderText(sessionManager: TodoBranchSource): string | undefined {
	const state = loadState(sessionManager);
	const open = countOpen(state);
	if (open === 0) return undefined;
	const inProgress = state.phases
		.flatMap((p) => p.tasks)
		.filter((t) => t.status === "in_progress")
		.map((t) => t.content);
	const heading = inProgress.length > 0 ? `In progress: ${inProgress.join(", ")}. ` : "";
	return `${heading}You stopped with ${open} open todo item(s). Continue working on them or mark them complete/finished.`;
}

export interface TodoInstallOptions {
	/**
	 * True while a background delegate child still owes the parent a wake-up.
	 * A reminder sent then is premature: the child's completion message is
	 * going to re-run the loop anyway (OMP's `hasPendingAsyncWake()` check).
	 */
	hasActiveJobs?: () => boolean;
	/** Reminder cap per session. Defaults to {@link TODO_MAX_REMINDERS}. */
	maxReminders?: number;
}

export function installTodo(pi: ExtensionAPI, options: TodoInstallOptions = {}): void {
	const hasActiveJobs = options.hasActiveJobs ?? (() => false);
	const maxReminders = options.maxReminders ?? TODO_MAX_REMINDERS;

	pi.registerTool({
		name: "todo",
		label: "Todos",
		description:
			"Manage a phased todo list. Ops: init, add (content, phase), start (content), done (content), drop/rm (content), block/unblock (content, blocker), view. Tasks are addressed by their content string; one task is in_progress; completing auto-promotes the next open task.",
		promptSnippet: "todo(op, content?, phase?, blocker?) — manage phased todos",
		parameters: PARAMS,
		// The todo panel renders its own framed block (the Agents frame
		// construction, src/render.ts); self-framing keeps pi's default
		// bg-colored Box shell off.
		renderShell: "self",
		executionMode: "sequential",
		execute: async (_toolCallId, params: TodoParams, _signal, _onUpdate, ctx) => {
			const state = applyOp(loadState(ctx.sessionManager), params);
			pi.appendEntry(TODO_CUSTOM_TYPE, state);
			syncTodoWidget(ctx.ui, state);
			const text = params.op === "init" ? "Todos cleared." : viewTasks(state);
			return {
				content: [{ type: "text", text }],
				details: { op: params.op, open: countOpen(state), state },
			};
		},
		// omp-style streaming header: `⏳ Todo · add <content>` (plain text, no frame).
		renderCall: (args: TodoParams, theme) => new Text(renderTodoCallHeader(args ?? {}, theme), 0, 0),
		// Collapsed: framed block `☑ Todo · N tasks` + bounded nested tree.
		// Expanded: same frame + full nested tree (all phases, all tasks).
		renderResult: (result, options, theme, context) => {
			const details = result?.details as TodoToolDetails | undefined;
			const state = details?.state;
			if (!details || !state || context?.isError) {
				const errorText =
					result?.content?.find((c) => c.type === "text")?.text ?? "Todo operation failed";
				return todoErrorComponent(errorText, theme);
			}
			if (options.expanded) return todoPanelComponent(state, theme);
			return todoCollapsedComponent(state, theme);
		},
	});

	const syncFromBranch = (ctx: { ui: Pick<ExtensionCommandContext["ui"], "setWidget">; sessionManager: TodoBranchSource }) =>
		syncTodoWidget(ctx.ui, loadState(ctx.sessionManager));

	pi.on("session_start", (_event, ctx) => syncFromBranch(ctx));
	pi.on("session_tree", (_event, ctx) => syncFromBranch(ctx));

	pi.registerCommand("todo", {
		description:
			"Phased todos: /todo, /todo add <content>, /todo start|done|drop|rm <content>, /todo export [path], /todo import [path]",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/);
			const state = loadState(ctx.sessionManager);
			const persist = (next: TodoState) => {
				pi.appendEntry(TODO_CUSTOM_TYPE, next);
				syncTodoWidget(ctx.ui, next);
				return next;
			};
			switch (sub) {
				case "export": {
					const target = rest[0] ?? join(ctx.cwd, TODO_FILE);
					await fs.writeFile(target, phasesToMarkdown(state), "utf8");
					ctx.ui.notify(`Todos exported to ${target}`, "info");
					return;
				}
				case "import": {
					const source = rest[0] ?? join(ctx.cwd, TODO_FILE);
					const md = await fs.readFile(source, "utf8");
					const imported = persist(markdownToPhases(md));
					ctx.ui.notify(`Imported ${countOpen(imported)} open tasks from ${source}`, "info");
					return;
				}
				case "add": {
					const content = rest.join(" ");
					if (!content) {
						ctx.ui.notify("Usage: /todo add <task content>", "warning");
						return;
					}
					persist(addTask(state, TODO_DEFAULT_PHASE, content));
					ctx.ui.notify(`Added: ${content}`, "info");
					return;
				}
				case "start":
				case "done":
				case "drop":
				case "rm": {
					const content = rest.join(" ");
					const fn =
						sub === "start" ? startTask : sub === "done" ? completeTask : sub === "drop" ? dropTask : removeTask;
					persist(fn(state, content));
					ctx.ui.notify(`${sub}: ${content}`, "info");
					return;
				}
				case "":
				default: {
					syncTodoWidget(ctx.ui, state);
					ctx.ui.notify(`Todos: ${countOpen(state)} open across ${state.phases.length} phase(s).`, "info");
					return;
				}
			}
		},
	});

	wireTodoReminder(pi, hasActiveJobs, maxReminders);
}

/** The final assistant text, whitespace-normalized, when there is one. */
function finalAssistantText(messages: readonly unknown[]): { text: string; stopReason?: string } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: unknown; content?: unknown; stopReason?: unknown } | undefined;
		if (m?.role !== "assistant") continue;
		const pieces = Array.isArray(m.content)
			? m.content.filter((c): c is { type: string; text?: string } => Boolean(c) && typeof c === "object" && (c as { type?: unknown }).type === "text")
			: [];
		return {
			text: pieces.map((c) => c.text ?? "").join(" ").trim(),
			stopReason: typeof m.stopReason === "string" ? m.stopReason : undefined,
		};
	}
	return undefined;
}

/**
 * Bounded, non-spammy incomplete-todo reminder. Suppressed when:
 * the turn was aborted (Escape), the model is asking the user a question, a
 * reminder is already waiting on the model to act, the cap is spent, or a
 * background delegate child will wake the parent anyway.
 */
function wireTodoReminder(pi: ExtensionAPI, hasActiveJobs: () => boolean, maxReminders: number): void {
	let sent = 0;
	let awaitingProgress = false;

	// OMP's `onToolResult`: the model acted on the reminder, so it may remind again.
	pi.on("message_end", (event) => {
		if (event.message.role === "toolResult") awaitingProgress = false;
	});

	pi.on("agent_end", (event, ctx) => {
		const last = finalAssistantText(event.messages);
		// The signal can be aborted after the final assistant message was emitted,
		// before agent_end is delivered; stop there even if stopReason still says stop.
		if (ctx.signal?.aborted) return;
		// A deliberate abort (Escape) settles the turn — don't auto-restart it with a
		// reminder. Mirrors omp's agent-session, which returns early on
		// `stopReason === "aborted"` before its todo checkCompletion ever runs.
		if (last?.stopReason === "aborted") return;
		const text = todoReminderText(ctx.sessionManager);
		if (!text) {
			// Nothing left to remind about: the next open todo earns a fresh budget.
			sent = 0;
			awaitingProgress = false;
			return;
		}
		if (sent >= maxReminders) return;
		// A prior reminder is still waiting for the model to touch its todos.
		if (awaitingProgress) return;
		// The model asked the user something; the ball is in the human's court.
		if (last?.text.endsWith("?")) return;
		// A background child's completion message will re-wake the loop on its own.
		if (hasActiveJobs()) return;
		sent += 1;
		awaitingProgress = true;
		pi.sendUserMessage(text, { deliverAs: "followUp" });
	});
}
