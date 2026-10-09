import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { AgentsPanel, type LiveSource } from "../inspector.js";
import { frame } from "../render.js";
import { renderTodoSectionLines } from "../todo-render.js";
import type { TodoState } from "../todo.js";
import { momSectionLines, type PanelView } from "./panel.ts";

export const ACTIVITY_WIDGET_KEY = "pi-delegate.activity";

const withLegend = (lines: string[], legend: string, theme: Theme, width: number): string[] => {
	if (width < 8 || lines.length === 0) return lines;
	const label = theme.fg("dim", truncateToWidth(` ${legend} `, width - 3, "…"));
	lines[lines.length - 1] = theme.fg("borderAccent", "╰─") + label
		+ theme.fg("borderAccent", "─".repeat(Math.max(0, width - 3 - visibleWidth(label))) + "╯");
	return lines;
};

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
	return withLegend(lines, "Ctrl+J agents · Ctrl+Shift+J Mom · Ctrl+Shift+K compact", theme, outer);
}

/** The widget is the focus target; AgentsPanel remains the section renderer and input delegate. */
class ActivityWidget implements Component, Focusable {
	private panel?: AgentsPanel;
	constructor(private readonly owner: ActivityCoordinator) {}
	attach(panel: AgentsPanel): void { this.panel = panel; }
	get focused(): boolean { return Boolean(this.panel?.focused); }
	set focused(value: boolean) { if (this.panel) this.panel.focused = value; }
	handleInput(data: string): void { this.panel?.handleInput(data); }
	render(width: number): string[] { return this.owner.renderWidget(width); }
	invalidate(): void {}
}

/** One persistent above-editor activity surface. Child sections never draw their own frame. */
export class ActivityCoordinator {
	private context?: ExtensionContext;
	private live?: LiveSource;
	private openChild?: (id: string) => Promise<void>;
	private todos?: TodoState;
	private mom?: () => PanelView;
	private panel?: AgentsPanel;
	private widget?: ActivityWidget;
	private tui?: TUI;
	private theme?: Theme;
	private clearOnShrink?: boolean;
	private installed = false;

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

	setMom(view: () => PanelView): void {
		this.mom = view;
		this.tui?.requestRender();
	}

	clearMom(): void {
		this.mom = undefined;
		this.tui?.requestRender();
	}

	focusAgents(): void {
		this.panel?.focus();
	}

	dispose(): void {
		this.panel?.dispose();
		this.panel = undefined;
		this.widget = undefined;
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
		if (this.panel) sections.push(this.panel.renderSection(inner + 4));
		if (this.todos) sections.push(renderTodoSectionLines(this.todos, theme, inner + 4));
		if (this.mom) sections.push(momSectionLines(this.mom(), theme, inner + 4));
		return renderActivityLines(sections, theme, outer, Boolean(this.panel?.focused)).map(line => truncateToWidth(line, outer, ""));
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

