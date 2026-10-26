import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, type TUI, type TuiMouseEvent, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { AgentsPanel, isCurrentAgent, type LiveSource } from "../inspector.js";
import { frame, runTitle, statusMark, withLegend, processLine } from "../render.js";
import { renderTodoOverviewLines, renderTodoSectionLines } from "../todo-render.js";
import type { TodoState } from "../todo.js";
import { COMPACT_KEY, FOCUS_KEY, momSectionLines, type PanelView } from "./panel.ts";
import { agentListHint, chordLabel, hint, joinHints } from "./hints.ts";
import { cut } from "./text.ts";
import { SPIN_MS, spinning } from "./trail-view.ts";
import type { SettingsRow } from "./settings-panel.ts";

export const ACTIVITY_WIDGET_KEY = "pi-delegate.activity";
// Keep the existing cross-extension key so a reload or a separately loaded Path host preserves the mode.
const COMPACT_STATE = Symbol.for("@ssweens/pi-tether/compact");

/** Recap is another unframed section; the coordinator supplies the outer Activity frame. */
export function renderRecapSectionLines(recap: string, theme: Theme, width: number, compact = false): string[] {
	const inner = Math.max(1, Math.floor(width) - 4);
	const maxLine = Math.max(1, inner - 2);
	const lines = wrapTextWithAnsi(recap, maxLine);
	const body = compact ? [truncateToWidth(lines.join(" "), maxLine, "…")] : lines.slice(0, 2);
	if (!compact && lines.length > 2) body[1] = `${truncateToWidth(body[1]!, Math.max(0, inner - 3), "")}…`;
	return [theme.bold(theme.fg("accent", "Recap")), ...body.map(line => `  ${line}`)];
}

function renderSpurSectionLines(jobs: any[], theme: any, width: number, compact = false): string[] {
  const heading = theme.bold ? theme.bold(theme.fg("accent", "Scheduled")) : "Scheduled";
  if (!jobs || !jobs.length) return compact ? [] : [heading, "  No scheduled jobs."];
  const lines = jobs.slice(0, compact ? 1 : 5).map((j: any) => `  ${j.id}: ${j.phase ? j.phase.kind : ""} ${ (j.prompt || "").slice(0,30) }`);
  return [heading, ...lines];
}

/** Path's settings panel, built for a submenu: `close` returns to the panel that opened it. Undefined until it is connected. */
/** Path's rows of the settings panel; undefined until Path is connected. */
export type MomRowsFactory = (context: ExtensionContext, tui: TUI) => SettingsRow[] | undefined;

/** Compose one outer frame around already-unframed section rows. */
export function renderActivityLines(sections: readonly (readonly string[])[], theme: Theme, width: number, focused = false): string[] {
	const outer = Math.max(0, Math.floor(width));
	const body: string[] = [];
	for (const section of sections) {
		if (!section.length) continue;
		if (body.length) body.push(theme.fg("borderMuted", ""));
		body.push(...section);
	}
	if (!body.length) return [];
	const lines = frame("Activity", body, "borderAccent", theme, outer);
	return withLegend(lines, focused ? agentListHint() : joinHints(hint.left("agents"), `${chordLabel(FOCUS_KEY)} Activity`, `${chordLabel(COMPACT_KEY)} compact`), "borderAccent", theme, outer);
}

/** The widget is the focus target; AgentsPanel remains the section renderer and input delegate. */
class ActivityWidget implements Component, Focusable {
	private panel?: AgentsPanel;
	constructor(private readonly owner: ActivityCoordinator) {}
	attach(panel: AgentsPanel): void { this.panel = panel; }
	get focused(): boolean { return Boolean(this.panel?.focused); }
	set focused(value: boolean) { if (this.panel) this.panel.focused = value; }
	handleInput(data: string): void { this.panel?.handleInput(data); }
	/** A click anywhere on the box expands or collapses it, like a tool result. */
	handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
		if (event.type !== "click" || event.button !== "left") return undefined;
		this.owner.toggleCompact();
		return { handled: true };
	}
	render(width: number): string[] { return this.owner.renderWidget(width); }
	invalidate(): void {}
}

/** One persistent above-editor activity surface. Child sections never draw their own frame. */
export class ActivityCoordinator {
	private context?: ExtensionContext;
	private live?: LiveSource;
	private openChild?: (id: string) => Promise<void>;
	private todos?: TodoState;
	private recap?: string;
	private overviewRecap?: string;
	private compact = Reflect.get(globalThis, COMPACT_STATE) === true;
	private mom?: () => PanelView;
	private panel?: AgentsPanel;
	private widget?: ActivityWidget;
	private tui?: TUI;
	private theme?: Theme;
	private clearOnShrink?: boolean;
	private installed = false;
	private settledBefore = Date.now();
	private spurJobs: any[] = [];
	private momRowsFactory?: MomRowsFactory;
	private spinner?: ReturnType<typeof setInterval>;

	install(context: ExtensionContext, live: LiveSource, openChild: (id: string) => Promise<void>): void {
		this.context = context;
		this.live = live;
		this.openChild = openChild;
		if (context.mode !== "tui" || this.installed) return;
		this.installed = true;
		context.ui.setWidget(ACTIVITY_WIDGET_KEY, (tui, theme) => {
			this.tui = tui;
			this.clearOnShrink = tui.getClearOnShrink();
			tui.setClearOnShrink(true);
			this.theme = theme;
			this.panel?.dispose();
			this.widget = new ActivityWidget(this);
			this.panel = new AgentsPanel(this.live!, theme, tui, id => this.openChild!(id), this.widget);
			this.panel.hideSettledBefore(this.settledBefore);
			this.widget.attach(this.panel);
			return this.widget;
		}, { placement: "aboveEditor" });
		context.ui.setWidget("delegate-agents", undefined);
		context.ui.setWidget("pi-delegate.todo", undefined);
		context.ui.setWidget("pi-omp.todo", undefined);
		this.tui?.requestRender();
	}

	setTodos(state: TodoState): void {
		this.todos = structuredClone(state);
		this.tui?.requestRender();
	}

	setRecap(recap: string | undefined): void {
		this.recap = recap;
		if (recap !== undefined) this.overviewRecap = recap;
		this.tui?.requestRender();
	}

	resetRecap(): void {
		this.overviewRecap = undefined;
		this.setRecap(undefined);
	}


	setSpurJobs(jobs: any[]): void {
		this.spurJobs = jobs || [];
		this.tui?.requestRender();
	}

	setCompact(compact: boolean): void {
		this.compact = compact;
		Reflect.set(globalThis, COMPACT_STATE, compact);
		this.tui?.requestRender();
	}

	isCompact(): boolean { return this.compact; }
	toggleCompact(): void { this.setCompact(!this.compact); }

	setMom(view: () => PanelView): void {
		this.mom = view;
		this.tui?.requestRender();
	}

	clearMom(): void {
		this.mom = undefined;
		this.spin(false);
		this.tui?.requestRender();
	}

	/** Path's spinner repaints on its own clock while the last frame drew one; a state change alone would leave it frozen. */
	private spin(on: boolean): void {
		if (on && !this.spinner) { this.spinner = setInterval(() => this.tui?.requestRender(), SPIN_MS); this.spinner.unref?.(); }
		if (!on && this.spinner) { clearInterval(this.spinner); this.spinner = undefined; }
	}

	renderOverview(theme: Theme, width: number): string[] {
		const inner = Math.max(1, Math.floor(width) - 4);
		const heading = (text: string) => theme.bold(theme.fg("accent", text));
		const lines = [heading("Agents")];
		const runs = this.live?.all().filter(run => isCurrentAgent(run, this.settledBefore)) ?? [];
		for (const run of runs) {
			const { color, glyph } = statusMark(run);
			const indent = "  ".repeat(Math.max(0, (run.depth ?? 1) - 1));
			lines.push(...wrapTextWithAnsi(`${indent}${theme.fg(color, glyph)} ${runTitle(run)} · ${run.status} · depth ${run.depth ?? 1}`, inner));
		}
		if (!runs.length) lines.push(theme.fg("muted", "No current agents."));
		const commands = (this.live?.processes?.() ?? []).filter(v => v.status === "running" || (v.endedAt ?? 0) >= this.settledBefore);
		if (commands.length) lines.push("", heading("Processes"), ...commands.map(v => processLine(v, theme, inner)));
		lines.push("", ...renderTodoOverviewLines(this.todos, theme, width), "");
		const mom = this.mom?.();
		lines.push(...(mom ? momSectionLines(mom, theme, width, false) : [heading("Path"), theme.fg("muted", "Path is unavailable.")]));
		if (this.spurJobs && this.spurJobs.length) lines.push("", ...renderSpurSectionLines(this.spurJobs, theme, width));
		lines.push("", heading("Recap"), ...wrapTextWithAnsi(this.overviewRecap || "No recap yet.", inner));
		return lines;
	}

	focusAgents(): void {
		this.panel?.focus();
	}

	/** The person sent a prompt: runs that settled before it leave the Agents section. */
	markPrompt(): void {
		this.settledBefore = Date.now();
		this.panel?.hideSettledBefore(this.settledBefore);
		this.tui?.requestRender();
	}

	/** Path offers its settings panel here, so /delegate settings can open it as a submenu. */
	setMomRows(factory: MomRowsFactory | undefined): void { this.momRowsFactory = factory; }
	momRows(context: ExtensionContext, tui: TUI): SettingsRow[] | undefined { return this.momRowsFactory?.(context, tui); }

	dispose(): void {
		this.spin(false);
		this.panel?.dispose();
		this.panel = undefined;
		this.widget = undefined;
		this.recap = undefined;
		this.overviewRecap = undefined;
		this.setCompact(false);
		if (this.tui && this.clearOnShrink !== undefined) this.tui.setClearOnShrink(this.clearOnShrink);
		this.clearOnShrink = undefined;
		if (this.context?.mode === "tui") this.context.ui.setWidget(ACTIVITY_WIDGET_KEY, undefined);
		this.tui = undefined;
		this.theme = undefined;
		this.installed = false;
	}

	renderWidget(width: number): string[] {
		const theme = this.theme;
		if (!theme) return [];
		const terminalWidth = process.stdout.isTTY && Number.isInteger(process.stdout.columns) ? process.stdout.columns : this.tui?.terminal.columns ?? Math.floor(width);
		const outer = Math.max(0, Math.min(Math.floor(width), terminalWidth));
		const inner = Math.max(1, outer - 4);
		const sections: string[][] = [];
		const mom = this.mom?.();
		if (this.panel) sections.push(this.panel.renderSection(inner + 4, this.compact), this.panel.renderProcessSection(inner + 4, this.compact));
		if (this.todos) sections.push(renderTodoSectionLines(this.todos, theme, inner + 4, this.compact));
		this.spin(Boolean(mom?.trail && spinning(mom.status)));
		if (mom) sections.push(momSectionLines(mom, theme, inner + 4, this.compact));
		if (this.recap && !this.compact) sections.push(renderRecapSectionLines(this.recap, theme, inner + 4, this.compact));
		if (this.spurJobs && this.spurJobs.length) sections.push(renderSpurSectionLines(this.spurJobs, theme, inner + 4, this.compact));
		if (this.compact) {
			// One line: each section's title and count, side by side.
			const parts = sections.filter(section => section.length).map(section => section[0]!);
			if (this.recap) parts.push(theme.fg("muted", this.recap.replace(/\s+/g, " ")));
			sections.length = 0;
			if (parts.length) sections.push([cut(parts.join(theme.fg("dim", " │ ")), inner)]);
		}
		return renderActivityLines(sections, theme, outer, Boolean(this.panel?.focused)).map(line => cut(line, outer));
	}
}

const coordinators = new WeakMap<ExtensionAPI, ActivityCoordinator>();

export function activityFor(pi: ExtensionAPI): ActivityCoordinator {
	let coordinator = coordinators.get(pi);
	if (!coordinator) {
		coordinator = new ActivityCoordinator();
		coordinators.set(pi, coordinator);
	}
	return coordinator;
}

