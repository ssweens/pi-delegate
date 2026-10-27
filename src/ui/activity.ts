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
import { type Job, type Request, type Snapshot, scheduleLabel } from "../spur/scheduler.ts";
import { navKeys } from "./keys.ts";
import { errorMessage } from "../util/text.ts";
import { formatDuration } from "../util/format.ts";

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

function formatCountdown(nextAt: number | null | undefined): string {
  if (!nextAt) return 'no next run';
  const d = nextAt - Date.now();
  if (d <= 0) return 'due';
  const m = Math.ceil(d / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h >= 48) return `in ${Math.floor(h / 24)}d`;
  const mm = m % 60;
  return `in ${h}h${mm ? `${mm}m` : ''}`;
}

const ACTIVITY_VIEWS = ["All", "Agents", "Processes", "Todos", "Path", "Schedules", "Recap"] as const;
type ActivityView = typeof ACTIVITY_VIEWS[number];

function jobState(job: Job): string {
  if (!job.enabled) return "paused";
  if (job.phase.kind === "pending") return "waiting for idle";
  if (job.phase.kind === "active") return "running";
  return job.phase.kind;
}

function jobDetailLines(job: Job, theme: Theme, width: number): string[] {
  const field = (label: string, value: string) => wrapTextWithAnsi(`${theme.fg("muted", `${label}:`)} ${value}`, width);
  const lines = [
    ...field("Job", job.name && job.name !== job.id ? `${job.name} (${job.id})` : job.id),
    ...field("Schedule", scheduleLabel(job)),
    ...field("Next run", job.nextAt ? `${new Date(job.nextAt).toLocaleString()} · ${formatCountdown(job.nextAt)}` : "none"),
    ...field("State", jobState(job)),
  ];
  if (job.phase.kind === "uncertain") lines.push(...field("Why uncertain", job.phase.reason));
  const last = job.lastRun;
  lines.push(...field("Last run", last ? `${new Date(last.startedAt).toLocaleString()} · took ${formatDuration(last.endedAt - last.startedAt)}${last.aborted ? " · aborted" : ""}` : "never"));
  lines.push(theme.fg("muted", "Prompt:"), ...job.prompt.split("\n").flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - 2)).map(part => `  ${part}`)));
  return lines;
}

function renderSpurSectionLines(jobs: Job[], theme: Theme, width: number, compact = false): string[] {
  const heading = theme.bold(theme.fg("accent", "Scheduled"));
  if (!jobs.length) return compact ? [] : [heading, "  No scheduled jobs."];
  const lines: string[] = [];
  for (const j of jobs.slice(0, compact ? 1 : 5)) {
    const sched = scheduleLabel(j);
    const cd = formatCountdown(j.nextAt);
    const phase = j.phase ? j.phase.kind : '';
    const p = (j.prompt || '').slice(0, 30);
    const paused = j.enabled === false ? ' (paused)' : '';
    const line = `  ${j.id}: ${sched} ${cd} [${phase}]${paused} ${p}`;
    lines.push(truncateToWidth(line, width - 2));
  }
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
	private spur: Snapshot = { version: 1, paused: false, jobs: [] };
	private spurControl?: (request: Request) => string;
	private view: ActivityView = "All";
	private selectedJob = 0;
	private confirmRemove?: string;
	private spurNotice = "";
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


	setSpur(state: Snapshot): void {
		this.spur = state;
		this.tui?.requestRender();
	}

	/** The spur tool's own `manage`, so the Schedules tab changes jobs through the same validation and save. */
	setSpurControl(control: (request: Request) => string): void { this.spurControl = control; }

	/** Keys for the full-size Activity tab. Returns false for keys the Path view should handle. */
	activityInput(data: string): boolean {
		if (this.confirmRemove) {
			const id = this.confirmRemove;
			this.confirmRemove = undefined;
			if (data === "y") this.control({ action: "remove", id }, `Removed ${id}.`);
			else this.spurNotice = "Remove cancelled.";
			return true;
		}
		const nav = navKeys(data);
		if (nav === "left" || nav === "right") {
			const index = ACTIVITY_VIEWS.indexOf(this.view) + (nav === "left" ? -1 : 1);
			this.showView(ACTIVITY_VIEWS[(index + ACTIVITY_VIEWS.length) % ACTIVITY_VIEWS.length]!);
			return true;
		}
		if (/^[1-7]$/.test(data)) { this.showView(ACTIVITY_VIEWS[Number(data) - 1]!); return true; }
		if (this.view !== "Schedules") return false;
		const jobs = this.spur.jobs;
		if ((nav === "up" || nav === "down") && jobs.length) {
			this.selectedJob = Math.max(0, Math.min(jobs.length - 1, this.selectedJob + (nav === "up" ? -1 : 1)));
			this.spurNotice = "";
			return true;
		}
		if (data === "g") {
			const paused = this.spur.paused;
			this.control({ action: paused ? "resume" : "pause" }, paused ? "Scheduling resumed." : "Scheduling paused; no job starts until you resume.");
			return true;
		}
		const job = jobs[this.selectedJob];
		if (!job) return false;
		if (data === "p") this.control({ action: job.enabled ? "pause" : "resume", id: job.id }, job.enabled ? `Paused ${job.id}.` : `Resumed ${job.id}.`);
		else if (data === "n") {
			if (!job.enabled) this.spurNotice = `Resume ${job.id} first; Run now does not override a paused job.`;
			else this.control({ action: "run", id: job.id }, this.spur.paused ? `Queued ${job.id}; it waits until scheduling resumes (G).` : `Queued ${job.id}; it runs when Pi is idle.`);
		}
		else if (data === "d") { this.confirmRemove = job.id; this.spurNotice = `Remove ${job.id}? Y removes it; any other key cancels. Active work is not stopped.`; }
		else return false;
		return true;
	}

	activityHints(): string {
		const tabs = "←/→ or 1–7 tabs";
		if (this.view !== "Schedules") return tabs;
		const any = this.spur.jobs.length > 0;
		return joinHints(tabs, any && "↑↓ select", any && "P pause/resume", any && "N run now", any && "D remove", this.spur.paused ? "G resume all" : "G pause all");
	}

	private showView(view: ActivityView): void {
		this.view = view;
		this.confirmRemove = undefined;
		this.spurNotice = "";
	}

	private control(request: Request, done: string): void {
		if (!this.spurControl) { this.spurNotice = "Scheduling is not ready in this session."; return; }
		try { this.spurControl(request); this.spurNotice = done; }
		catch (error) { this.spurNotice = errorMessage(error); }
	}

	private scheduleLines(theme: Theme, width: number, detailed: boolean): string[] {
		const jobs = this.spur.jobs;
		const lines = wrapTextWithAnsi(theme.bold(theme.fg("accent", "Schedules")) + theme.fg("muted", ` · scheduling ${this.spur.paused ? "paused" : "on"}`), width);
		if (!jobs.length) return [...lines, ...wrapTextWithAnsi(theme.fg("muted", "No scheduled jobs. Ask the agent to schedule one with the spur tool."), width),
			...(detailed && this.spurNotice ? ["", ...wrapTextWithAnsi(theme.fg("accent", this.spurNotice), width)] : [])];
		this.selectedJob = Math.min(this.selectedJob, jobs.length - 1);
		for (const [index, job] of jobs.entries()) {
			const selected = detailed && index === this.selectedJob;
			const row = `${selected ? "›" : " "} ${job.id} · ${scheduleLabel(job)} · ${formatCountdown(job.nextAt)} · ${jobState(job)}`;
			lines.push(truncateToWidth(selected ? theme.bold(theme.fg("accent", row)) : row, width, "…"));
		}
		if (!detailed) return lines;
		lines.push("", ...jobDetailLines(jobs[this.selectedJob]!, theme, width));
		if (this.spurNotice) lines.push("", ...wrapTextWithAnsi(theme.fg(this.confirmRemove ? "warning" : "accent", this.spurNotice), width));
		return lines;
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
		const runs = this.live?.all().filter(run => isCurrentAgent(run, this.settledBefore)) ?? [];
		const commands = (this.live?.processes?.() ?? []).filter(v => v.status === "running" || (v.endedAt ?? 0) >= this.settledBefore);
		const sections: Record<Exclude<ActivityView, "All">, () => string[]> = {
			Agents: () => {
				const lines = [heading("Agents")];
				for (const run of runs) {
					const { color, glyph } = statusMark(run);
					const indent = "  ".repeat(Math.max(0, (run.depth ?? 1) - 1));
					lines.push(...wrapTextWithAnsi(`${indent}${theme.fg(color, glyph)} ${runTitle(run)} · ${run.status} · depth ${run.depth ?? 1}`, inner));
				}
				if (!runs.length) lines.push(theme.fg("muted", "No current agents."));
				return lines;
			},
			Processes: () => [heading("Processes"), ...(commands.length ? commands.map(v => processLine(v, theme, inner)) : [theme.fg("muted", "No current processes.")])],
			Todos: () => renderTodoOverviewLines(this.todos, theme, width),
			Path: () => { const mom = this.mom?.(); return mom ? momSectionLines(mom, theme, width, false) : [heading("Path"), theme.fg("muted", "Path is unavailable.")]; },
			Schedules: () => this.scheduleLines(theme, inner, this.view === "Schedules"),
			Recap: () => [heading("Recap"), ...wrapTextWithAnsi(this.overviewRecap || "No recap yet.", inner)],
		};
		const tabs = ACTIVITY_VIEWS.map((view, index) => view === this.view
			? theme.bold(theme.fg("accent", `[${index + 1} ${view}]`)) : theme.fg("muted", ` ${index + 1} ${view} `)).join("");
		const body = this.view === "All"
			? (["Agents", "Processes", "Todos", "Path", "Schedules", "Recap"] as const)
				.filter(view => view !== "Processes" || commands.length)
				.flatMap((view, index) => [...(index ? [""] : []), ...sections[view]()])
			: sections[this.view]();
		return [...wrapTextWithAnsi(tabs, inner), "", ...body];
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
		if (this.spur.jobs.length) sections.push(renderSpurSectionLines(this.spur.jobs, theme, inner + 4, this.compact));
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

