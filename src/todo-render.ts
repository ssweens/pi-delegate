/**
 * Colored todo-panel rendering for the `todo` tool result and the `/todo` widget.
 * The frame matches the Agents panel's `frame()` construction (src/render.ts);
 * the tree, status colors, and caps are faithful to omp's todo panel:
 *
 * - **Widget** (above editor): the same rounded frame with the bold-accent
 *   `Todos · 1/N` header embedded in the top border and the nested tree —
 *   phases as outer `├─`/`└─` nodes carrying `· done/total` progress, tasks as
 *   inner `├─`/`└─` nodes — as the framed body. Active phase is accent-bold;
 *   others are muted.
 * - **Tool result** (scrollback): the same rounded frame (`╭─ ☑ Todo · N tasks ─╮`)
 *   with the status-line header embedded in the top border, dim border, no
 *   background fill, and the flat task tree body inside.
 *
 * Per-status colors: done = success + strikethrough, in-progress = accent,
 * blocked = warning, abandoned = error + strikethrough, pending = dim.
 *
 * Pure and theme-agnostic: takes a minimal {@link TodoStyler} so it is unit-
 * testable with a stub; the real pi `Theme` satisfies it structurally.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { TodoState, TodoItem } from "./todo.js";

/** Subset of pi's ThemeColor used by the todo panel. */
export type TodoColor =
	| "accent"
	| "success"
	| "error"
	| "warning"
	| "dim"
	| "muted"
	| "text"
	| "borderMuted"
	| "toolTitle";

/** Minimal theming surface the panel needs. pi's Theme implements this. */
export interface TodoStyler {
	fg(color: TodoColor, text: string): string;
	bold(text: string): string;
	strikethrough(text: string): string;
}

// --- Symbols (omp unicode preset) ---

export const CHECKED = "☑";
export const UNCHECKED = "☐";
/** Pending hourglass shown while the `todo` tool call streams. */
export const PENDING_ICON = "⏳";
/** Checkbox icon shown on the completed tool result header. */
export const TODO_ICON = "☑";
export const TREE_BRANCH = "├─";
export const TREE_LAST = "└─";
export const TREE_VERTICAL = "│";

// --- Box drawing (Agents panel frame construction, src/render.ts) ---

const BOX_H = "─";
const BOX_V = "│";

const SEP_DOT = " · ";
/** Visible width of a single tree prefix (`├─ ` / `└─ ` / `│  ` / `   `). */
const PREFIX_WIDTH = 3;

const ROMAN = ["", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV"];

export function romanNumeral(oneBased: number): string {
	return ROMAN[oneBased] ?? String(oneBased);
}

// --- Width helpers ---

/** ANSI-aware truncation with a unicode ellipsis. */
function clip(label: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(label);
	if (w <= width) return label;
	return truncateToWidth(label, width, "…");
}

function phaseDisplayName(name: string, index: number): string {
	return `${romanNumeral(index)}. ${name}`;
}

function countOpen(all: TodoItem[]): number {
	return all.filter((t) => t.status === "pending" || t.status === "in_progress" || t.status === "blocked").length;
}

// --- Tree helpers (omp-style box-drawing connectors) ---

/** Branch prefix: `├─ ` (not last) or `└─ ` (last). 3 visible chars. */
function treeBranchPrefix(isLast: boolean): string {
	return isLast ? `${TREE_LAST} ` : `${TREE_BRANCH} `;
}

/** Continuation prefix: `│  ` (not last) or `   ` (last). 3 visible chars. */
function treeContinuePrefix(isLast: boolean): string {
	return isLast ? "   " : `${TREE_VERTICAL}  `;
}

// --- Status line (omp renderStatusLine port) ---

/**
 * Compose a tool header line: `icon title · meta1 · meta2`.
 * The icon is pre-styled by the caller (omp colors pending=muted, todo=accent).
 * The title is accent-colored (NOT bold — omp's `renderStatusLine` does not bold
 * the title). Meta is dim, joined by ` · `. When `width` is given and the line
 * would overflow, the meta is clipped.
 */
function renderStatusLine(icon: string, title: string, meta: string[], theme: TodoStyler, width?: number): string {
	const titleStyled = theme.fg("accent", title);
	let line = icon ? `${icon} ${titleStyled}` : titleStyled;
	if (meta.length > 0) {
		const metaText = meta.join(SEP_DOT);
		if (width !== undefined) {
			const prefixLen = visibleWidth(icon) + 1 + visibleWidth(title) + 1;
			if (prefixLen + visibleWidth(metaText) > width) {
				line += ` ${theme.fg("dim", clip(metaText, Math.max(0, width - prefixLen)))}`;
				return line;
			}
		}
		line += ` ${theme.fg("dim", metaText)}`;
	}
	return line;
}

/** Tool call header shown while the `todo` tool streams: `⏳ Todo · add <content>`. */
export function renderTodoCallHeader(
	args: { op?: string; content?: string; phase?: string },
	theme: TodoStyler,
): string {
	const op = args.op ?? "update";
	const parts = [op];
	if (args.content) parts.push(args.content);
	else if (args.phase) parts.push(`phase: ${args.phase}`);
	const icon = theme.fg("muted", PENDING_ICON);
	return renderStatusLine(icon, "Todo", [parts.join(" ")], theme);
}

/** Result header: `☑ Todo · N tasks` (omp shows only the task count, not open). */
function renderTodoResultHeader(state: TodoState, theme: TodoStyler, width?: number): string {
	const total = state.phases.flatMap((p) => p.tasks).length;
	const meta = [`${total} task${total === 1 ? "" : "s"}`];
	const icon = theme.fg("accent", TODO_ICON);
	return renderStatusLine(icon, "Todo", meta, theme, width);
}

// --- Task line rendering ---

/**
 * Render a single task line (checkbox + content), colored per status.
 * `width` is the full budget for the checkbox glyph + space + content.
 */
function renderTodoTaskLine(task: TodoItem, theme: TodoStyler, width: number): string {
	const chromeLen = 2; // checkbox glyph + space
	switch (task.status) {
		case "completed": {
			const label = clip(task.content, width - chromeLen);
			return theme.fg("success", `${CHECKED} ${theme.strikethrough(label)}`);
		}
		case "in_progress": {
			const label = clip(task.content, width - chromeLen);
			return theme.fg("accent", `${UNCHECKED} ${label}`);
		}
		case "blocked": {
			const note = task.blocker ? ` (blocked: ${task.blocker})` : " (blocked)";
			const suffixLen = visibleWidth(note);
			if (suffixLen >= width - chromeLen) {
				return theme.fg("warning", clip(`${UNCHECKED} ${note.trim()}`, width));
			}
			const label = clip(task.content, Math.max(0, width - chromeLen - suffixLen));
			return theme.fg("warning", `${UNCHECKED} ${label}${note}`);
		}
		case "abandoned": {
			const label = clip(task.content, width - chromeLen);
			return theme.fg("error", `${UNCHECKED} ${theme.strikethrough(label)}`);
		}
		case "pending":
		default: {
			const label = clip(task.content, width - chromeLen);
			return theme.fg("dim", `${UNCHECKED} ${label}`);
		}
	}
}

// --- Phase header rendering (nested tree, with progress fraction) ---

/**
 * Render a phase header line (without tree prefix): accent-bold when active,
 * muted when not, plus a dim ` · done/total` progress fraction.
 */
function renderPhaseHeaderLine(
	phase: TodoState["phases"][number],
	index: number,
	multiPhase: boolean,
	isActive: boolean,
	theme: TodoStyler,
	width: number,
): string {
	const label = multiPhase ? phaseDisplayName(phase.name, index + 1) : phase.name;
	const done = phase.tasks.filter((t) => t.status === "completed").length;
	const progress = `${SEP_DOT}${done}/${phase.tasks.length}`;
	const labelBudget = width - visibleWidth(progress);
	const labelClipped = clip(label, labelBudget);
	const labelStyled = isActive ? theme.bold(theme.fg("accent", labelClipped)) : theme.fg("muted", labelClipped);
	return labelStyled + theme.fg("dim", progress);
}

// --- Tree bodies ---

/** Max open tasks previewed for the active phase in the widget (omp: 5). */
const ACTIVE_TASK_CAP = 5;
/** Max tasks per phase in the collapsed tool result (omp PREVIEW_LIMITS.COLLAPSED_ITEMS: 8). */
const TOOL_RESULT_TASK_CAP = 8;
const WIDGET_SUBSEQUENT_PHASE_CAP = 4;

function currentPhaseIndex(phases: TodoState["phases"]): number {
	const active = phases.findIndex((phase) =>
		phase.tasks.some((task) => task.status === "pending" || task.status === "in_progress" || task.status === "blocked"),
	);
	return active === -1 ? phases.length - 1 : active;
}

function widgetTaskPreview(tasks: TodoItem[], cap: number): { tasks: TodoItem[]; hidden: number } {
	const open = tasks.filter((task) => task.status === "pending" || task.status === "in_progress" || task.status === "blocked");
	// No open work: fall back to closed tasks so a settled phase still renders
	// (omp's selectCollapsedTodos does the same for HUD closed-todo persistence).
	const base = open.length > 0 ? open : tasks;
	if (base.length <= cap) return { tasks: base, hidden: 0 };

	const active = base.filter((task) => task.status === "in_progress");
	if (active.length >= cap) {
		return { tasks: active.slice(0, cap), hidden: base.length - cap };
	}

	const preview = [...active];
	const start = active.length > 0 ? base.indexOf(active[0]!) : 0;
	for (let index = start; index < base.length && preview.length < cap; index++) {
		const task = base[index]!;
		if (!preview.includes(task)) preview.push(task);
	}
	return { tasks: preview, hidden: base.length - preview.length };
}

/**
 * Render the nested tree body for the widget: phases as outer `├─`/`└─` nodes
 * (with `· done/total`), tasks as inner `├─`/`└─` nodes under the active phase.
 * Non-active phases are one-line headers (collapsed) or full subtrees (expanded).
 *
 * `width` is the budget for the tree lines themselves (no outer indent — the
 * widget adds that).
 *
 * - `expanded`: every phase, every task.
 * - `boundPhases` (collapsed): active phase + a bounded number of following phases;
 *   trailing hidden phases get a `└─ … N more phases` summary. When false, all
 *   phases are listed (active shows tasks, others are one-line headers).
 */
function renderNestedTree(
	state: TodoState,
	theme: TodoStyler,
	width: number,
	expanded: boolean,
	boundPhases: boolean,
): string[] {
	const phases = state.phases.filter((phase) => phase.tasks.length > 0);
	if (phases.length === 0) return [];

	const activeIndex = currentPhaseIndex(phases);
	const multiPhase = phases.length > 1;

	// Determine the phase slice.
	const start = expanded ? 0 : activeIndex;
	const end = expanded
		? phases.length
		: boundPhases
			? Math.min(phases.length, activeIndex + 1 + WIDGET_SUBSEQUENT_PHASE_CAP)
			: phases.length;
	const hasHiddenPhases = !expanded && boundPhases && end < phases.length;
	const slice = phases.slice(start, end);

	const lines: string[] = [];
	const headerBudget = width - PREFIX_WIDTH;
	const taskBudget = width - PREFIX_WIDTH * 2; // outer continue + inner branch

	for (let i = 0; i < slice.length; i++) {
		const phase = slice[i]!;
		const phaseIdx = start + i;
		const isActive = phaseIdx === activeIndex;
		const isLastPhase = i === slice.length - 1 && !hasHiddenPhases;
		const outerBranch = theme.fg("dim", treeBranchPrefix(isLastPhase));
		const outerCont = theme.fg("dim", treeContinuePrefix(isLastPhase));

		// Phase header line (outer branch + header content).
		lines.push(`${outerBranch}${renderPhaseHeaderLine(phase, phaseIdx, multiPhase, isActive, theme, headerBudget)}`);

		// Tasks under this phase.
		const showTasks = expanded || isActive;
		if (showTasks) {
			const { tasks: taskList, hidden } = selectTasks(phase.tasks, expanded, ACTIVE_TASK_CAP);
			for (let t = 0; t < taskList.length; t++) {
				const isLastTask = t === taskList.length - 1 && hidden === 0;
				const innerBranch = theme.fg("dim", treeBranchPrefix(isLastTask));
				lines.push(`${outerCont}${innerBranch}${renderTodoTaskLine(taskList[t]!, theme, taskBudget)}`);
			}
			if (hidden > 0) {
				const summary = `… ${hidden} more task${hidden === 1 ? "" : "s"}`;
				const innerLast = theme.fg("dim", treeBranchPrefix(true));
				lines.push(`${outerCont}${innerLast}${theme.fg("muted", clip(summary, taskBudget))}`);
			}
		}
	}

	if (hasHiddenPhases) {
		const hidden = phases.length - end;
		const summary = `… ${hidden} more phase${hidden === 1 ? "" : "s"}`;
		const outerLast = theme.fg("dim", treeBranchPrefix(true));
		lines.push(`${outerLast}${theme.fg("muted", clip(summary, headerBudget))}`);
	}

	return lines;
}

/**
 * Render the flat tool-result body matching omp's `renderResult`:
 * - Multi-phase: accent-bold roman phase names (no tree prefix, no progress on
 *   active phases); non-active collapsed phases get a dim one-line summary with
 *   a 2-space progress gap. Tasks indented 2 spaces with `├─`/`└─` tree.
 * - Single-phase: no phase header at all, just the task tree (no indent).
 * - Collapsed: walking-viewport task selection (cap = TOOL_RESULT_TASK_CAP).
 * - Expanded: all phases fully rendered with all tasks.
 */
function renderToolResultBody(
	state: TodoState,
	theme: TodoStyler,
	width: number,
	expanded: boolean,
): string[] {
	const phases = state.phases.filter((phase) => phase.tasks.length > 0);
	if (phases.length === 0) return [];

	const activeIndex = currentPhaseIndex(phases);
	const multiPhase = phases.length > 1;
	const indent = multiPhase ? "  " : "";

	const taskBudget = width - visibleWidth(indent) - PREFIX_WIDTH;
	const headerBudget = width;

	const lines: string[] = [];

	for (let i = 0; i < phases.length; i++) {
		const phase = phases[i]!;
		const isActive = i === activeIndex;
		const showTasks = expanded || isActive;

		if (multiPhase) {
			if (showTasks) {
				// Active/touched phase: accent-bold roman name, no progress.
				const name = phaseDisplayName(phase.name, i + 1);
				lines.push(theme.bold(theme.fg("accent", clip(name, headerBudget))));
			} else {
				// Untouched phase: dim-bold name + dim "  done/total" (2-space gap).
				const name = phaseDisplayName(phase.name, i + 1);
				const done = phase.tasks.filter((t) => t.status === "completed").length;
				const progress = `  ${done}/${phase.tasks.length}`;
				const nameClipped = clip(name, Math.max(0, headerBudget - visibleWidth(progress)));
				lines.push(theme.fg("dim", theme.bold(nameClipped)) + theme.fg("dim", progress));
			}
		}

		if (showTasks) {
			const { tasks: taskList, hidden } = selectTasks(phase.tasks, expanded, TOOL_RESULT_TASK_CAP);
			for (let t = 0; t < taskList.length; t++) {
				const isLastTask = t === taskList.length - 1 && hidden === 0;
				const branch = theme.fg("dim", treeBranchPrefix(isLastTask));
				lines.push(`${indent}${branch}${renderTodoTaskLine(taskList[t]!, theme, taskBudget)}`);
			}
			if (hidden > 0) {
				const summary = `… ${hidden} more task${hidden === 1 ? "" : "s"}`;
				const innerLast = theme.fg("dim", treeBranchPrefix(true));
				lines.push(`${indent}${innerLast}${theme.fg("muted", clip(summary, taskBudget))}`);
			}
		}
	}

	// Trim leading blank lines (omp does this).
	while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();

	return lines;
}

/**
 * Select tasks to display for a phase.
 * - expanded: every task, no hidden count.
 * - collapsed: walking-viewport (open tasks only when open work exists, with
 *   active tasks at the head), bounded by `cap`. Falls back to closed tasks
 *   when no open work remains so a settled phase still renders.
 */
function selectTasks(
	tasks: TodoItem[],
	expanded: boolean,
	cap: number,
): { tasks: TodoItem[]; hidden: number } {
	if (expanded) return { tasks, hidden: 0 };
	return widgetTaskPreview(tasks, cap);
}

// --- Framed block (Agents panel frame construction, src/render.ts) ---

/**
 * Render a rounded frame with the header embedded in the top border, matching
 * the Agents panel's `frame()`: a `╭─` lead, the header label, dashes to the
 * right corner, `│`-wrapped body rows, and a plain `╰` bottom. Dim border, no
 * background fill. Widths too narrow to frame fall back to bare clipped lines,
 * exactly like `frame()`.
 *
 *   ╭─ <header> ───────────╮
 *   │  <body line>          │
 *   ╰───────────────────────╯
 */
function renderFramedBlock(
	header: string,
	bodyLines: readonly string[],
	theme: TodoStyler,
	width: number,
	borderColor: TodoColor = "borderMuted",
): string[] {
	if (width < 6) return [header, ...bodyLines].map((l) => truncateToWidth(l, Math.max(0, width), ""));
	const border = (text: string) => theme.fg(borderColor, text);
	const inner = width - 4;
	const label = clip(` ${header} `, width - 4);
	const rows = [border("╭─") + label + border(`${BOX_H.repeat(Math.max(0, width - 3 - visibleWidth(label)))}╮`)];
	for (const body of bodyLines) {
		const clipped = clip(body, inner);
		const pad = Math.max(0, inner - visibleWidth(clipped));
		rows.push(`${border(BOX_V)} ${clipped}${" ".repeat(pad)} ${border(BOX_V)}`);
	}
	rows.push(border(`╰${BOX_H.repeat(width - 2)}╯`));
	return rows;
}

// --- Widget (above-editor, collapsed, open tasks only) ---

/**
 * Render the bounded above-editor widget framed like the Agents panel: the
 * bold-accent `Todos · N/M` header embedded in the top border and the nested
 * tree of phases — the active phase's open tasks as inner `├─`/`└─`
 * continuation lines — as the framed body.
 */
export function renderTodoWidgetLines(state: TodoState, theme: TodoStyler, width: number): string[] {
	const phases = state.phases.filter((phase) => phase.tasks.length > 0);
	const allTasks = phases.flatMap((phase) => phase.tasks);
	const open = countOpen(allTasks);
	if (open === 0) return [];

	const activeIndex = currentPhaseIndex(phases);
	const multiPhase = phases.length > 1;

	// Bold-accent "Todos" + dim " · 1/N", embedded in the top border.
	const header = theme.bold(theme.fg("accent", "Todos")) + (multiPhase ? theme.fg("dim", ` · ${activeIndex + 1}/${phases.length}`) : "");

	// The frame's rows give the tree its budget: `│ ` + line + ` │`.
	const tree = renderNestedTree(state, theme, Math.max(0, width - 4), false, true);
	return renderFramedBlock(header, tree, theme, width);
}

// --- Tool result (framed block, scrollback) ---

/** Render the framed tool result: rounded border with `☑ Todo · N tasks` header. */
export function renderTodoCollapsedLines(state: TodoState, theme: TodoStyler, width: number): string[] {
	const phases = state.phases.filter((phase) => phase.tasks.length > 0);
	const total = phases.reduce((n, p) => n + p.tasks.length, 0);
	const header = renderTodoResultHeader(state, theme, width);
	if (total === 0) {
		return renderFramedBlock(header, [], theme, width);
	}
	// Flat body: active phase shows walking-viewport tasks, others are summaries.
	const body = renderToolResultBody(state, theme, Math.max(0, width - 4), false);
	return renderFramedBlock(header, body, theme, width);
}

/** Render the expanded tool result: rounded border + flat body (all phases, all tasks). */
export function renderTodoLines(state: TodoState, theme: TodoStyler, width: number): string[] {
	const phases = state.phases.filter((phase) => phase.tasks.length > 0);
	const total = phases.reduce((n, p) => n + p.tasks.length, 0);
	const header = renderTodoResultHeader(state, theme, width);
	if (total === 0) {
		return renderFramedBlock(header, [], theme, width);
	}
	const body = renderToolResultBody(state, theme, Math.max(0, width - 4), true);
	return renderFramedBlock(header, body, theme, width);
}

// --- Components ---

interface Renderable {
	render(width: number): string[];
	invalidate(): void;
}

/** Collapsed result component used in the chat scrollback (framed block). */
export function todoCollapsedComponent(state: TodoState, theme: TodoStyler): Renderable {
	return {
		render(width) {
			return renderTodoCollapsedLines(state, theme, Math.max(8, width));
		},
		invalidate() {},
	};
}

/** Full historical panel used only when a todo tool result is expanded (framed block). */
export function todoPanelComponent(state: TodoState, theme: TodoStyler): Renderable {
	return {
		render(width) {
			return renderTodoLines(state, theme, Math.max(8, width));
		},
		invalidate() {},
	};
}

/** Bounded persistent widget kept above the editor while work remains. */
export function todoWidgetComponent(state: TodoState, theme: TodoStyler): Renderable {
	return {
		render(width) {
			return renderTodoWidgetLines(state, theme, Math.max(4, width));
		},
		invalidate() {},
	};
}

/** Error result component: framed block with error-colored border and `✘ Todo` header. */
export function todoErrorComponent(message: string, theme: TodoStyler): Renderable {
	return {
		render(width) {
			const w = Math.max(8, width);
			const icon = theme.fg("error", "✘");
			const header = renderStatusLine(icon, "Todo", [], theme, w);
			return renderFramedBlock(header, [theme.fg("error", clip(message, w - 4))], theme, w, "error");
		},
		invalidate() {},
	};
}
