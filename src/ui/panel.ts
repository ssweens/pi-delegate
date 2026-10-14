import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";
import type { AnnotationView, EndeavorView, WorkView } from "./presentation.ts";
import { formatTiming, formatUsage, updateErrorSummary, WAITING_FOR_VIEW } from "../mom/status.ts";
import { frame, withLegend } from "../render.js";
import { formatDuration } from "../util/format.ts";
import { flatten } from "../util/text.ts";
import { GLYPH, TREE } from "./glyphs.ts";
import { chordLabel, graphHints, hint, joinHints, keyLabel } from "./hints.ts";
import { navKeys } from "./keys.ts";
import { Scroller } from "./scroll.ts";
import { fit, fitPad, sideBySide } from "./text.ts";
import { isFinished, isWaiting, kindClass, kindWord, stateWord } from "./vocabulary.ts";
import { GraphBrowser } from "./graph-browser.ts";
import { plainTrailRows, statusSlot, titleWithSlot, trailCompactRow, TrailBrowser, trailRows } from "./trail-view.ts";
import type { Snapshot, SourcePage } from "../mom/client.ts";
import type { Trail } from "../trail/types.ts";
import type { Glance } from "../trail/projection.ts";

export const FOCUS_KEY = "ctrl+shift+j";
export const COMPACT_KEY = "ctrl+shift+k";
export type PanelNoteTag = "Heads up" | "Worth considering";
export type FindingDisposition = "understood" | "dismiss" | "incorrect";
export interface PanelView {
	status: string; summary: string; complete?: boolean; compact?: boolean; note?: string; noteTag?: PanelNoteTag; error?: string; sliceUrl?: string; rebuild?: string; rebuildUrl?: string; work?: WorkView; coverage?: { consumed: number; total: number; percent: number };
	/** Trail mode: where we are at a glance, how many entries the branch has, and what Path is doing when busy. */
	trail?: { glance: Glance; count: number; stage?: string; task?: string; since?: number };
}
export interface PanelDiagnostics { sections: { title: string; text: string }[]; raw: string }
export interface WorkspaceStatus {
	connection: string; project: string; sliceUrl?: string; host?: Snapshot["host"]; telemetry?: Snapshot["telemetry"];
	usage?: Snapshot["usage"]; enabled?: boolean;
}
export interface PanelSource {
	view(): PanelView;
	diagnostics?(): PanelDiagnostics;
	copy?(text: string): Promise<void>;
	findingAction?(action: FindingDisposition, finding: string): void | Promise<void>;
	prepareLeadDraft?(finding: string): void | Promise<void>;
	status?(): WorkspaceStatus;
	refreshStatus?(): Promise<void>;
	setEnabled?(enabled: boolean): Promise<void>;
	/** Run Path's refresh; resolves to the outcome to show, rejects with why it failed. */
	refresh?(): Promise<string>;
	/** The F4 Settings tab's component; `done` returns to Overview. Undefined when Path is not connected. */
	settings?(done: () => void): Component | undefined;
	/** Graph modes: start (or review) the map rebuild; the caller closes the view. */
	rebuild?(): void;
	readSource?(ref: string, offset: number): Promise<SourcePage>;
	draftForLead?(text: string): void | Promise<void>;
	/** Trail mode: the branch's trail for the Trail tab. */
	trail?(): Trail | undefined;
}

/** Trail mode's widget rows: where we are, Path's state at the far right of the first. */
const trailWidgetRows = (view: PanelView, theme: Theme, width: number) => trailRows(view.trail!.glance, theme, width);

/**
 * F1–F4 as the kitty keyboard protocol sends them: `ESC [ P` … `ESC [ S`, with any modifier as `ESC [ 1 ; m P`.
 * pi-tui's parser knows the legacy forms (`ESC O P`, `ESC [ 11 ~`) and kitty's `ESC [ 13 ~` for F3, which is why F3
 * worked in an enhanced-keyboard terminal while F1 and F2 did not.
 */
const KITTY_FUNCTION_KEYS: Record<string, string> = { f1: "P", f2: "Q", f3: "R", f4: "S" };
export function functionKey(data: string, key: "f1" | "f2" | "f3" | "f4"): boolean {
	if (matchesKey(data, key)) return true;
	const final = KITTY_FUNCTION_KEYS[key];
	return data === `\x1b[${final}` || new RegExp(`^\\x1b\\[1;\\d+(?::\\d+)?${final}$`).test(data);
}

const PREVIEW_NEIGHBORS = 6;
const clean = (text: string) => flatten(text.replace(/\[src:[^\]]+\]/g, ""));
/** The note under the map, tagged by what it is. */
const noteLine = (view: PanelView): string => `${view.noteTag ?? "Worth considering"}: ${clean(view.note!)}`;
const fallback = (summary: string) => clean(summary.split("\n").find(line => line.trim() && !line.startsWith("#")) ?? "");

function annotationText(annotation: AnnotationView): string {
	const rule = kindClass(annotation.kind), choice = rule === "choice";
	const text = clean(rule === "rule" || choice ? annotation.intent || annotation.label : annotation.observed || annotation.intent || annotation.label);
	const state = isFinished(annotation.state) ? " (finished)" : isWaiting(annotation.state) ? " (waiting)" : "";
	return `${kindWord(annotation.kind)}${state}: ${text}`;
}

/** Open work items under the current endeavor, todo-style; finished ones show only when nothing is open. */
const FOCUS_TASK_CAP = 5;
const FOCUS_STATE_LINES = 2;
interface FocusTask { label: string; state: string; choice: boolean; question?: string; node?: EndeavorView }
const taskRank = (task: FocusTask) => isFinished(task.state) || task.state === "abandoned" ? 6
	: task.choice ? 2 : task.state === "active" ? 0 : task.state === "blocked" ? 1 : task.state === "proposed" ? 3 : isWaiting(task.state) ? 4 : 5;

/** Work nodes and their current state. The current endeavor adds its state and open work items, todo-style;
 * rules and observations appear only in the expanded panel. */
function hierarchy(work: WorkView, theme: Theme, width: number, expanded: boolean): string[] {
	const index = new Map(work.endeavors.map(node => [node.id, node]));
	const focused = index.has(work.focus ?? "") ? work.focus : work.endeavors.find(node => node.annotations.some(a => a.id === work.focus))?.id;
	const path = new Set(work.focusPath.filter(id => index.has(id)));
	for (let current = focused; current && !path.has(current); current = index.get(current)?.parent) path.add(current);
	for (const id of [...path]) {
		const seen = new Set<string>();
		for (let parent = index.get(id)?.parent; parent && !seen.has(parent); parent = index.get(parent)?.parent) { seen.add(parent); path.add(parent); }
	}
	const children = new Map<string | null, EndeavorView[]>();
	for (const node of work.endeavors) {
		const parent = node.parent && index.has(node.parent) ? node.parent : null;
		const siblings = children.get(parent) ?? []; siblings.push(node); children.set(parent, siblings);
	}
	const selected = new Set<string>(expanded ? index.keys() : path);
	if (!expanded) {
		if (work.purpose && index.has(work.purpose)) selected.add(work.purpose);
		const candidates = work.endeavors.filter(node => !selected.has(node.id)).sort((a, b) => {
			const rank = (n: EndeavorView) => n.parent && path.has(n.parent) ? 0 : n.parent === null ? 1 : n.state === "active" ? 2 : isWaiting(n.state) ? 3 : 4;
			return rank(a) - rank(b);
		});
		for (const node of candidates.slice(0, PREVIEW_NEIGHBORS)) selected.add(node.id);
		for (const id of [...selected]) {
			const seen = new Set<string>();
			for (let parent = index.get(id)?.parent; parent && !seen.has(parent); parent = index.get(parent)?.parent) { seen.add(parent); selected.add(parent); }
		}
	}
	const lines: string[] = [], visited = new Set<string>();
	function progress(node: EndeavorView): string {
		const descendants: EndeavorView[] = [], seen = new Set([node.id]);
		const visit = (id: string) => { for (const child of children.get(id) ?? []) if (!seen.has(child.id)) { seen.add(child.id); descendants.push(child); visit(child.id); } };
		visit(node.id);
		const counted = descendants.length ? descendants : [node];
		return ` · ${counted.filter(n => isFinished(n.state)).length}/${counted.length} done`;
	}
	function row(node: EndeavorView, prefix: string, root: boolean): string {
		// The header states freshness; the marker always shows where the saved map says you are.
		const here = node.id === focused;
		let marker = here ? " · you are here" : "";
		const safePrefix = fit(prefix, Math.max(0, width - (here ? "you are here".length : 1)));
		const budget = Math.max(0, width - visibleWidth(safePrefix));
		let meta = here && node.state === "active" ? "" : ` · ${stateWord(node.state)}`;
		if (node.id === work.motherThread && budget >= visibleWidth(marker + meta) + 32) meta += " · mother thread";
		else if (node.id === work.purpose && budget >= visibleWidth(marker + meta) + 28) meta += " · main line";
		if (root && budget >= visibleWidth(marker + meta) + visibleWidth(progress(node)) + 18) meta += progress(node);
		if (visibleWidth(marker + meta) >= budget) { marker = here ? "you are here" : ""; meta = here ? "" : meta.trim(); }
		// Labels are model-written semantic text. Truncate only to the terminal width; never drop words by a fixed count.
		const label = fit(node.label, Math.max(0, budget - visibleWidth(marker + meta)));
		let title: string;
		if (here) title = theme.bold(theme.fg("accent", label));
		else if (isFinished(node.state)) title = theme.fg("success", theme.strikethrough(label));
		else if (node.state === "abandoned") title = theme.fg("error", theme.strikethrough(label));
		else if (node.state === "blocked") title = theme.fg("warning", label);
		else if (isWaiting(node.state)) title = theme.fg("dim", label);
		else if (path.has(node.id)) title = theme.bold(theme.fg("accent", label));
		else title = theme.fg("muted", label);
		return fit(theme.fg("dim", safePrefix) + title + (marker ? theme.bold(theme.fg("accent", marker)) : "") + theme.fg("dim", meta), width);
	}
	function detail(text: string, prefix: string, color: "muted" | "warning" | "dim", preserveSources = false) {
		const safePrefix = fit(prefix, Math.max(0, width - 1)), available = Math.max(1, width - visibleWidth(safePrefix));
		const content = preserveSources ? flatten(text) : clean(text);
		const body = expanded ? wrapTextWithAnsi(content, available) : [fit(content, available)];
		for (const line of body) lines.push(fit(theme.fg("dim", safePrefix) + theme.fg(color, line), width));
	}
	function taskLine(task: FocusTask, prefix: string): string {
		const safePrefix = fit(prefix, Math.max(0, width - 1)), budget = Math.max(0, width - visibleWidth(safePrefix) - 2);
		const done = isFinished(task.state), dropped = task.state === "abandoned";
		let meta = done || dropped ? "" : task.choice ? " · waiting on you" : task.state === "active" ? "" : ` · ${stateWord(task.state)}`;
		if (task.node && children.get(task.node.id)?.length) meta += progress(task.node);
		if (visibleWidth(meta) >= budget) meta = "";
		const label = fit(task.label, Math.max(0, budget - visibleWidth(meta)));
		const glyph = done ? GLYPH.checked : GLYPH.unchecked;
		const body = done ? theme.fg("success", `${glyph} ${theme.strikethrough(label)}`)
			: dropped ? theme.fg("error", `${glyph} ${theme.strikethrough(label)}`)
			: task.choice || task.state === "blocked" ? theme.fg("warning", `${glyph} ${label}${meta}`)
			: task.state === "active" ? theme.fg("accent", `${glyph} ${label}`) + theme.fg("dim", meta)
			: theme.fg("dim", `${glyph} ${label}${meta}`);
		return fit(theme.fg("dim", safePrefix) + body, width);
	}
	/** The current endeavor's state, then its open work items: child endeavors and choices waiting on you. */
	function focusDetail(node: EndeavorView, prefix: string) {
		const all: FocusTask[] = [
			...(children.get(node.id) ?? []).map(child => ({ label: child.label, state: child.state, choice: false, node: child })),
			...node.annotations.filter(note => kindClass(note.kind) === "choice").map(note => ({ label: note.label, state: note.state, choice: true, question: note.intent })),
		];
		const open = all.filter(task => taskRank(task) < 6);
		const pool = (open.length ? open : all).sort((a, b) => taskRank(a) - taskRank(b));
		const shown = pool.slice(0, FOCUS_TASK_CAP), extra = pool.length - shown.length;
		const stem = `${prefix}${shown.length ? "│ " : "  "}`;
		if (node.observed) {
			const available = Math.max(1, width - visibleWidth(stem));
			const wrapped = wrapTextWithAnsi(clean(node.observed), available);
			const kept = wrapped.slice(0, FOCUS_STATE_LINES);
			if (wrapped.length > kept.length) kept[kept.length - 1] = visibleWidth(kept[kept.length - 1]!) + 2 <= available ? `${kept[kept.length - 1]} …` : fit(kept[kept.length - 1]!, available);
			for (const line of kept) lines.push(fit(theme.fg("dim", stem) + theme.fg("muted", line), width));
		}
		shown.forEach((task, i) => {
			if (task.node) visited.add(task.node.id);
			const last = i === shown.length - 1 && !extra;
			lines.push(taskLine(task, `${prefix}${last ? `${TREE.last} ` : `${TREE.branch} `}`));
			// A waiting choice is only useful with its question: what exactly is waiting on you.
			if (task.choice && taskRank(task) < 6 && task.question && clean(task.question) !== clean(task.label)) {
				const stem = `${prefix}${last ? "   " : "│  "}  `;
				lines.push(fit(theme.fg("dim", stem) + theme.fg("muted", fit(clean(task.question), Math.max(1, width - visibleWidth(stem)))), width));
			}
		});
		if (extra) lines.push(fit(theme.fg("dim", `${prefix}${TREE.last} +${extra} more`), width));
	}
	function visit(parent: string | null, prefix: string) {
		const siblings = (children.get(parent) ?? []).filter(node => selected.has(node.id));
		for (let i = 0; i < siblings.length; i++) {
			const node = siblings[i]; if (visited.has(node.id)) continue; visited.add(node.id);
			const last = i === siblings.length - 1;
			lines.push(row(node, `${prefix}${last ? `${TREE.last} ` : `${TREE.branch} `}`, parent === null));
			const continuation = `${prefix}${last ? "   " : "│  "}`;
			if (!expanded && node.id === focused) { focusDetail(node, continuation); continue; }
			if (expanded) {
				if (node.intent) detail(`Purpose: ${node.intent}`, `${continuation}  `, "muted");
				if (node.observed) detail(`State: ${node.observed}`, `${continuation}  `, "muted");
				if (node.history) detail("Earlier work was folded away; its sources are still available.", `${continuation}  `, "dim");
				if (node.sources.length) detail(`Sources: ${node.sources.map(source => `[src:${source}]`).join(" ")}`, `${continuation}  `, "dim", true);
				const annotations = [...node.annotations].sort((a, b) => Number(isFinished(a.state)) - Number(isFinished(b.state)));
				for (const annotation of annotations) {
					detail(annotationText(annotation), `${continuation}  `, annotation.state === "blocked" ? "warning" : isWaiting(annotation.state) ? "dim" : "muted");
					if (annotation.sources.length) detail(`Sources: ${annotation.sources.map(source => `[src:${source}]`).join(" ")}`, `${continuation}    `, "dim", true);
				}
			}
			visit(node.id, continuation);
		}
	}
	visit(null, "");
	const hidden = work.endeavors.length - visited.size;
	if (hidden) lines.push(fit(theme.fg("dim", ` … ${hidden} more endeavor${hidden === 1 ? "" : "s"} · ${chordLabel(FOCUS_KEY)} to read`), width));
	if (work.outside.length) {
		if (expanded) for (const outside of work.outside) detail(`Outside this view: ${outside}`, " ", "dim");
		else lines.push(fit(theme.fg("dim", ` More work is outside this view · ${chordLabel(FOCUS_KEY)} for context`), width));
	}
	return lines;
}

/** Collapsed tool results stay out of the transcript's multi-line map; the activity widget owns that view.
 *  A trail read shows where we are: the widget's rows, without colour. */
export function momToolPreview(view: PanelView, trail?: string): string {
	if (trail !== undefined) return [`Path · ${view.status}${view.error ? " ⚠" : ""}`, ...(view.trail ? plainTrailRows(view.trail.glance) : [])].join("\n");
	const work = view.work;
	const index = new Map((work?.endeavors ?? []).map(node => [node.id, node]));
	const focused = work ? index.get(work.focusEndeavor ?? "") : undefined;
	const where = focused ? ` · ${clean(focused.label)}` : "";
	const marker = view.error ? " ⚠" : view.note ? " ◆" : "";
	return `Path · ${view.status}${where}${marker}`;
}

/**
 * Cached hierarchy framed like the Agents panel: the bold-accent `Path` title with
 * its muted status in the top border, the tree (or fallback summary, note, error)
 * as the framed body, and the focus hint in the bottom border's legend.
 */
export function momSectionLines(view: PanelView, theme: Theme, width: number, compact = Boolean(view.compact)): string[] {
	const w = Math.max(0, Math.floor(width));
	// In trail mode Path's state is a symbol (a spinner while it works) beside the title; the long status and the
	// slice links live in the view (F3 Status).
	const title = theme.bold(theme.fg("accent", "Path"));
	const header = view.trail ? titleWithSlot(title, statusSlot(view, theme, view.trail.glance.last)) : title + theme.fg("muted", ` · ${view.status}`);
	const inner = Math.max(0, w - 4);
	const links = view.trail ? [] : [
		...(view.sliceUrl ? [fit(theme.fg("dim", `Slice: ${view.sliceUrl}`), inner)] : []),
		...(view.rebuildUrl ? [fit(theme.fg("dim", `Rebuild slice: ${view.rebuildUrl}`), inner)] : []),
	];
	if (compact) return [header, compactLine(view, theme, w), ...(view.rebuild ? [fit(theme.fg("accent", view.rebuild), inner)] : []), ...links];
	const body: string[] = [];
	if (view.trail) body.push(...trailWidgetRows(view, theme, inner));
	else if (view.work?.endeavors.length) body.push(...hierarchy(view.work, theme, inner, false));
	else body.push(fit(theme.fg("muted", fallback(view.summary) || "Nothing saved yet."), inner));
	if (view.error) body.push(fit(theme.fg("warning", view.error), inner));
	else if (view.note) body.push(fit(theme.fg("accent", noteLine(view)), inner));
	if (view.rebuild) body.push(fit(theme.fg("accent", view.rebuild), inner));
	return [header, ...body, ...links];
}

export function widgetLines(view: PanelView, theme: Theme, width: number): string[] {
	const w = Math.max(0, Math.floor(width));
	const section = momSectionLines(view, theme, w);
	if (view.compact) return section.slice(1);
	// Like focused Agents, the accent border: borderMuted can disappear on the terminal background.
	return withLegend(frame(section[0]!, section.slice(1), "borderAccent", theme, w, { truncate: true }),
		joinHints(`${chordLabel(FOCUS_KEY)} Path`, `${chordLabel(COMPACT_KEY)} compact`, "/path"), "borderAccent", theme, w);
}

/** One line: freshness, then the current endeavor with its open and waiting counts. */
function compactLine(view: PanelView, theme: Theme, width: number): string {
	if (view.trail) return trailCompactRow(view.trail.glance, theme, width);
	const work = view.work, index = new Map((work?.endeavors ?? []).map(node => [node.id, node]));
	const focused = work ? index.get(work.focus ?? "") ?? work.endeavors.find(node => node.annotations.some(a => a.id === work.focus)) : undefined;
	let where = "";
	if (focused) {
		const tasks: FocusTask[] = [
			...(work!.endeavors.filter(node => node.parent === focused.id).map(node => ({ label: node.label, state: node.state, choice: false }))),
			...focused.annotations.filter(note => kindClass(note.kind) === "choice").map(note => ({ label: note.label, state: note.state, choice: true })),
		].filter(task => taskRank(task) < 6);
		const waitingOnYou = tasks.filter(task => task.choice).length;
		where = theme.fg("dim", " │ ") + theme.bold(theme.fg("accent", focused.label))
			+ (tasks.length ? theme.fg("dim", ` · ${tasks.length} open`) : "")
			+ (waitingOnYou ? theme.fg("warning", ` · ${waitingOnYou} waiting on you`) : "");
	}
	const finding = view.error ? theme.fg("warning", " ⚠") : view.note ? theme.fg("accent", " ◆") : "";
	const status = theme.fg("muted", ` · ${view.status}`);
	// The current work is useful at every width. Freshness yields first; a finding marker never does.
	const focus = focused ? theme.bold(theme.fg("accent", focused.label))
		+ (where.includes(" · ") ? where.slice(where.indexOf(" · ")) : "") : theme.bold(theme.fg("accent", "Path"));
	const primary = fit(focus, Math.max(0, width - visibleWidth(finding))) + finding;
	return primary + fit(status, Math.max(0, width - visibleWidth(primary)));
}

/** Path's full-viewport view: its saved map, its original sources, its status and its settings. It owns neither the
 *  lead editor nor lead messages. It shows what it saved; R runs Path's refresh and reads it again. */
export class MomView implements Component {
	private notice = "";
	private readonly scroller = new Scroller();
	private pageRows = 1;
	private total = 0;
	private snapshot: PanelView;
	private diagnostics?: PanelDiagnostics;
	private status?: WorkspaceStatus;
	private headerSignature = "";
	private tab: "Overview" | "Map" | "Status" | "Settings" = "Overview";
	private settingsPanel?: Component;
	private browser: GraphBrowser;
	private trailBrowser: TrailBrowser;
	private shownTrail?: Trail;
	private mapPane: "tree" | "details" | "source" = "tree";
	private sourceRead?: { kind: "loading" } | { kind: "loaded"; page: SourcePage } | { kind: "failed"; error: string };
	private sourceIndex = 0;
	private sourceOffsets: number[] = [];
	private sourceRequest = 0;
	private pendingAction = false;
	private raw = false;

	constructor(private source: PanelSource, private theme: Theme, private tui: TUI, private done: () => void) {
		this.snapshot = structuredClone(source.view());
		this.diagnostics = structuredClone(source.diagnostics?.());
		this.status = structuredClone(source.status?.());
		this.browser = new GraphBrowser(this.snapshot.work);
		this.trailBrowser = new TrailBrowser(this.shownTrail = source.trail?.());
	}

	/** Trail mode: F2 is the Trail tab (where we are, then every entry) instead of the Map. */
	private get trailMode(): boolean { return Boolean(this.snapshot.trail); }
	private get mapLabel(): string { return this.trailMode ? "Trail" : "Map"; }

	/** Show its latest saved view, then `notice`. */
	private async reread(notice: string): Promise<void> {
		try {
			await this.source.refreshStatus?.();
			this.snapshot = structuredClone(this.source.view());
			this.diagnostics = structuredClone(this.source.diagnostics?.());
			this.status = structuredClone(this.source.status?.());
			this.browser.update(this.snapshot.work);
			this.trailBrowser.update(this.shownTrail = this.source.trail?.());
			this.sourceRequest++; this.sourceRead = undefined; this.sourceOffsets = []; this.sourceIndex = 0;
			if (this.mapPane === "source") this.mapPane = this.trailMode ? "tree" : "details";
			this.notice = notice;
		} catch (error) { this.notice = updateErrorSummary(String(error)); }
		this.tui.requestRender();
	}

	/** R: run Path's refresh, then show what it saved. */
	private async refresh(): Promise<void> {
		if (this.pendingAction) return;
		this.pendingAction = true;
		try {
			if (!this.source.refresh) throw new Error("Refresh is unavailable in this view.");
			this.notice = "Refreshing…"; this.tui.requestRender();
			await this.reread(await this.source.refresh());
		} catch (error) { this.notice = updateErrorSummary(String(error)); this.tui.requestRender(); }
		finally { this.pendingAction = false; }
	}

	private async copy(): Promise<void> {
		try {
			if (!this.source.copy) throw new Error("Clipboard is unavailable in this view.");
			const width = this.tui.terminal.columns;
			const lines = this.content(width);
			if (this.tab === "Map") lines.unshift(...(this.trailMode ? this.trailBrowser.render(this.theme, width, Number.MAX_SAFE_INTEGER) : this.browser.render(this.theme, width, Number.MAX_SAFE_INTEGER)), "");
			await this.source.copy(stripVTControlCharacters(lines.join("\n")));
			this.notice = "Copied the displayed view.";
		} catch (error) { this.notice = updateErrorSummary(String(error)); }
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		for (const [key, tab] of ([["f1", "Overview"], ["f2", "Map"], ["f3", "Status"], ["f4", "Settings"]] as const)) {
			if (functionKey(data, key)) { this.switchTab(tab); this.tui.requestRender(); return; }
		}
		// Settings has type-to-search: every other key is its own.
		if (this.tab === "Settings") { this.settingsPanel?.handleInput?.(data); this.tui.requestRender(); return; }
		const nav = navKeys(data);
		if (nav === "cancel" && this.tab === "Map" && this.mapPane !== "tree") {
			this.mapPane = this.mapPane === "source" && !this.trailMode ? "details" : "tree"; this.sourceRequest++; this.scroller.top = 0; this.tui.requestRender(); return;
		}
		if (nav === "cancel" || matchesKey(data, FOCUS_KEY)) { this.done(); return; }
		const finding = this.snapshot.note;
		const actions = this.source.findingAction || this.source.prepareLeadDraft;
		if (finding && actions && matchesKey(data, "alt+u")) void this.findingAction("understood", finding);
		else if (finding && actions && matchesKey(data, "alt+d")) void this.findingAction("dismiss", finding);
		else if (finding && actions && matchesKey(data, "alt+i")) void this.findingAction("incorrect", finding);
		else if (finding && actions && matchesKey(data, "alt+l")) void this.prepareLeadDraft(finding);
		else if (this.tab === "Map" && (this.trailMode ? this.trailInput(data) : this.mapInput(data))) {
			// Map or trail navigation consumed the key.
		} else if (this.tab === "Status" && data === "v") this.raw = !this.raw;
		else if (this.tab === "Status" && data === "b" && !this.trailMode && this.source.rebuild) this.source.rebuild();
		else if (data === "r") void this.refresh();
		else if (data === "o") {
			const enabled = this.source.status?.().enabled;
			if (enabled !== undefined) void this.control(!enabled);
		}
		else if (data === "c") void this.copy();
		else this.scroller.handle(nav, this.pageRows, this.total);
		this.tui.requestRender();
	}

	private switchTab(tab: typeof this.tab): void {
		this.sourceRequest++;
		if (this.mapPane === "source" && this.sourceRead?.kind !== "loaded") this.mapPane = this.trailMode ? "tree" : "details";
		this.tab = tab; this.scroller.top = 0; this.notice = "";
		this.settingsPanel = tab === "Settings" ? this.source.settings?.(() => { this.switchTab("Overview"); this.tui.requestRender(); }) : undefined;
	}

	/** Trail tab: ↑↓ select an entry, Enter shows it in the transcript, [ ] its other sources, N/B page through it. */
	private trailInput(data: string): boolean {
		const page = this.sourceRead?.kind === "loaded" ? this.sourceRead.page : undefined;
		if (this.mapPane === "source") {
			if (data === "[" || data === "]") {
				this.sourceIndex = Math.max(0, Math.min(this.sources().length - 1, this.sourceIndex + (data === "[" ? -1 : 1)));
				this.sourceOffsets = []; void this.openSource(0);
			} else if (data === "n" && page && page.nextOffset !== null) { this.sourceOffsets.push(page.offset); void this.openSource(page.nextOffset); }
			else if (data === "b" && this.sourceOffsets.length) void this.openSource(this.sourceOffsets.pop()!);
			else if (data === "s") { this.sourceOffsets = []; void this.openSource(0); }
			else return false;
			return true;
		}
		if (navKeys(data) === "confirm" || data === "s") { this.sourceIndex = 0; this.sourceOffsets = []; void this.openSource(0); return true; }
		if (!this.trailBrowser.handleKey(data)) return false;
		this.sourceRequest++; this.sourceRead = undefined; this.sourceIndex = 0; this.sourceOffsets = []; this.scroller.top = 0;
		return true;
	}

	private mapInput(data: string): boolean {
		const selected = this.browser.selected;
		const page = this.sourceRead?.kind === "loaded" ? this.sourceRead.page : undefined;
		if (data === "d" && selected && this.source.draftForLead) {
			void Promise.resolve(this.source.draftForLead(`Let's discuss ${selected.label} [${selected.id}].\n${selected.intent}`))
				.then(() => { this.notice = "Prepared a lead draft; nothing was sent."; }, error => { this.notice = String(error); }).finally(() => this.tui.requestRender());
		} else if (data === "s") { this.sourceOffsets = []; void this.openSource(0); }
		else if (data === "[" || data === "]") {
			this.sourceIndex = Math.max(0, Math.min(this.sources().length - 1, this.sourceIndex + (data === "[" ? -1 : 1)));
			this.sourceOffsets = []; void this.openSource(0);
		} else if (data === "n" && page && page.nextOffset !== null) {
			this.sourceOffsets.push(page.offset); void this.openSource(page.nextOffset);
		} else if (data === "b" && this.sourceOffsets.length) void this.openSource(this.sourceOffsets.pop()!);
		else if (navKeys(data) === "confirm") { this.mapPane = "details"; this.scroller.top = 0; }
		else if (this.mapPane === "tree") {
			if (!this.browser.handleKey(data)) return false;
			this.sourceRequest++; this.sourceRead = undefined; this.sourceIndex = 0; this.sourceOffsets = []; this.scroller.top = 0;
		} else return false;
		return true;
	}

	private sources(): string[] {
		if (this.trailMode) return [...new Set(this.trailBrowser.selectedWaypoint()?.refs ?? [])];
		const item = this.browser.selected;
		return item ? [...new Set([...item.sources, ...(item.purposeSource ? [item.purposeSource] : [])])] : [];
	}

	private async openSource(offset: number): Promise<void> {
		const ref = this.sources()[this.sourceIndex];
		if (!ref || !this.source.readSource) { this.notice = this.trailMode ? "This entry has no readable transcript source." : "No readable source is selected."; return; }
		const request = ++this.sourceRequest;
		this.mapPane = "source"; this.sourceRead = { kind: "loading" }; this.scroller.top = 0;
		this.tui.requestRender();
		try {
			const page = await this.source.readSource(ref, offset);
			if (request !== this.sourceRequest) return;
			this.sourceRead = { kind: "loaded", page }; this.scroller.top = 0;
		} catch (error) { if (request === this.sourceRequest) this.sourceRead = { kind: "failed", error: updateErrorSummary(String(error)) }; }
		finally { this.tui.requestRender(); }
	}

	private async control(enabled: boolean): Promise<void> {
		if (!this.source.setEnabled || this.pendingAction) return;
		this.pendingAction = true; this.notice = enabled ? "Turning Path on…" : "Turning Path off…"; this.tui.requestRender();
		try {
			await this.source.setEnabled(enabled); await this.source.refreshStatus?.();
			this.status = structuredClone(this.source.status?.());
			this.notice = enabled ? "Path on." : "Path off.";
		}
		catch (error) { this.notice = updateErrorSummary(String(error)); }
		finally { this.pendingAction = false; this.tui.requestRender(); }
	}

	private async findingAction(action: FindingDisposition, finding: string) {
		if (!this.source.findingAction) return;
		try {
			await this.source.findingAction(action, finding);
			this.snapshot.note = undefined;
			this.notice = action === "understood" ? "Marked understood." : action === "dismiss" ? "Dismissed." : "Marked incorrect.";
		}
		catch { this.notice = "That finding action could not be saved."; }
		this.tui.requestRender();
	}

	private async prepareLeadDraft(finding: string) {
		if (!this.source.prepareLeadDraft) return;
		try { await this.source.prepareLeadDraft(finding); this.notice = "Prepared a lead draft; nothing was sent."; }
		catch { this.notice = "The lead draft was left unchanged."; }
		this.tui.requestRender();
	}

	private content(width: number): string[] {
		const view = this.snapshot;
		const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(1, width)).map(line => fit(line, width));
		const lines: string[] = [];
		if (this.tab === "Settings") return (this.settingsPanel?.render(width) ?? wrap("Path is not connected; settings are unavailable."));
		if (this.tab === "Map") return (this.trailMode && this.mapPane !== "source" ? this.trailBrowser.render(this.theme, width, Number.MAX_SAFE_INTEGER, this.slot()) : this.mapDetails()).flatMap(wrap);
		if (this.tab === "Status") {
			const status = this.status, host = status?.host, telemetry = status?.telemetry, usage = status?.usage;
			if (status) {
				lines.push(...wrap(`Connection: ${status.connection} · Path: ${status.enabled === undefined ? "unavailable" : status.enabled ? "on" : "off"}`),
					...wrap(`Project: ${status.project}`));
				if (status.sliceUrl) lines.push(...wrap(`Slice: ${status.sliceUrl}`));
				const live = this.source.view();
				if (live.rebuild) lines.push(...wrap(live.rebuild));
				if (live.rebuildUrl) lines.push(...wrap(`Rebuild slice: ${live.rebuildUrl}`));
				if (host) lines.push(...wrap(`oven PID ${host.pid} · slice ${host.slice} (${host.state}) · Age ${formatDuration(host.sampledAt - host.startedAt)}`),
					...wrap(`Sampled ${new Date(host.sampledAt).toLocaleTimeString()}`));
				else lines.push(...wrap("Path's slice in oven has not been read yet."));
				if (telemetry) lines.push(...wrap(`Model: ${telemetry.model}`), ...wrap(`Activity: ${telemetry.activity}`),
					...wrap(`Awaiting review: ${telemetry.pendingRanges} ranges · Unavailable sources: ${telemetry.unavailableSources}`));
				if (telemetry?.lastSavedAt) lines.push(...wrap(`Last saved: ${new Date(telemetry.lastSavedAt).toLocaleString()}`));
				if (telemetry?.timing) lines.push(...wrap(`Last operation: ${formatTiming(telemetry.timing)}`));
				if (usage) lines.push(...formatUsage(usage).split("\n").flatMap(wrap));
				lines.push("");
			}
			for (const section of this.diagnostics?.sections ?? []) {
				lines.push(...wrap(this.theme.bold(this.theme.fg("accent", section.title))),
					...section.text.split("\n").flatMap(text => wrap(this.theme.fg("text", text))), "");
			}
			if (!this.diagnostics) lines.push(...wrap("No diagnostics are available for this session."), "");
			else {
				lines.push(this.theme.bold(this.theme.fg("accent", "Raw records")),
					...wrap(this.theme.fg("muted", this.raw ? "V to collapse · C copies these records" : "Hidden · V to expand")));
				if (this.raw) lines.push("", ...this.diagnostics.raw.split("\n").flatMap(wrap));
			}
		}
		else if (this.tab === "Overview") {
			lines.push(this.theme.bold(this.theme.fg("accent", "Current work")));
			if (view.error) lines.push(...wrap(this.theme.fg("warning", view.error)),
				...wrap(this.theme.fg("muted", view.status === "reconnecting"
					? "Path must reconnect before updates can run."
					: "R refreshes and retries the update. Saved notes are unchanged.")), "");
			if (view.trail) lines.push(...trailWidgetRows(view, this.theme, width));
			else if (view.work?.endeavors.length) lines.push(...hierarchy(view.work, this.theme, width, false));
			else lines.push(...wrap(this.theme.fg("muted", fallback(view.summary) ||
				(view.status === "reconnecting" || view.status === "connecting"
					? WAITING_FOR_VIEW
					: "No saved work yet."))));
			if (view.note) lines.push("", ...wrap(this.theme.fg("accent", noteLine(view))));
			if (view.work && !view.trail) {
				lines.push("", this.theme.bold(this.theme.fg("accent", "Saved map")),
					...wrap(`${view.work.totalRecords} records · ${view.work.connections.length} relationships · F2 explore`));
				if (view.work.at) lines.push(...wrap(`Saved ${new Date(view.work.at).toLocaleString()}`));
				const pending = view.work.endeavors.filter(node => isWaiting(node.state));
				if (pending.length) lines.push("", this.theme.bold(this.theme.fg("accent", "Waiting work")), ...pending.flatMap(node => wrap(`• ${node.label}`)));
			}
			if (view.coverage) lines.push(...wrap(`History reviewed: ${view.coverage.consumed.toLocaleString()} / ${view.coverage.total.toLocaleString()} entries`));
		}
		return lines.map(line => fit(line, width));
	}

	private mapDetails(): string[] {
		if (this.mapPane === "source") {
			if (this.sourceRead?.kind === "failed") return [this.sourceRead.error, `Press S to retry, or ${keyLabel("tui.select.cancel")} to return to the ${this.trailMode ? "trail" : "node"}.`];
			if (this.sourceRead?.kind !== "loaded") return ["Reading original source…"];
			const page = this.sourceRead.page;
			return [`Original source ${this.sourceIndex + 1}/${this.sources().length}`, page.ref,
				`Characters ${page.offset + 1}–${Math.min(page.totalChars, page.offset + page.text.length)} of ${page.totalChars}`,
				`[ ] source · N next page · B previous · ${hint.cancel(this.trailMode ? "trail" : "node")}`, "", ...page.text.split("\n")];
		}
		return [...this.browser.details(), "", "S sources · D draft for lead", joinHints(graphHints.parent(), graphHints.expand(), hint.enter("inspect"))];
	}

	/** Path's state for the Trail tab's first row. */
	private slot() { return statusSlot(this.snapshot, this.theme, this.snapshot.trail?.glance.last); }

	statusChanged(): void {
		const status = this.source.status?.();
		const live = this.source.view();
		// The watcher saves while the view is open: its new entries show without a refresh, the selection kept.
		const trail = this.source.trail?.();
		if (trail !== this.shownTrail) { this.shownTrail = trail; this.trailBrowser.update(trail); this.tui.requestRender(); }
		const signature = JSON.stringify([status?.connection, status?.telemetry?.model, status?.telemetry?.activity, status?.host?.pid,
			status?.sliceUrl, live.rebuild, live.rebuildUrl]);
		if (signature === this.headerSignature) return;
		this.headerSignature = signature; this.tui.requestRender();
	}

	render(width: number): string[] {
		const w = Math.max(1, Math.floor(width));
		const height = Math.max(5, this.tui.terminal.rows);
		const divider = this.theme.fg("dim", " │ ");
		const status = this.source.status?.();
		const heading = this.theme.bold(this.theme.fg("accent", "Path")) + this.theme.fg("dim", ` · ${this.tab === "Status" ? "diagnostics" : this.snapshot.status}`);
		const tabs = (["Overview", "Map", "Status", "Settings"] as const).map((tab, index) => tab === this.tab
			? this.theme.bg("selectedBg", this.theme.bold(this.theme.fg("accent", ` F${index + 1} ${tab === "Map" ? this.mapLabel : tab} `))) : ` F${index + 1} ${tab === "Map" ? this.mapLabel : tab} `);
		const header = [fit(heading + (status ? ` · ${status.project.split("/").at(-1)} · ${status.connection}` : ""), w),
			...(status?.telemetry ? [fit(`${status.telemetry.model} · ${status.telemetry.activity}${status.host ? ` · PID ${status.host.pid}` : ""}`, w)] : []),
			...(visibleWidth(tabs.join(" ")) <= w ? [tabs.join(" ")] : [tabs.slice(0, 2).join(" "), tabs.slice(2).join(" ")]), ""];
		const findingKeys = w < 80 ? "Alt+U understood · Alt+D dismiss · Alt+I incorrect · Alt+L discuss"
			: "Alt+U understood · Alt+D dismiss · Alt+I incorrect · Alt+L discuss with lead";
		const navigation = this.tab === "Map" && this.trailMode ? (this.mapPane === "tree" ? joinHints(hint.move("move"), hint.enter("show in transcript")) : joinHints("[ ] source", "N/B page", hint.cancel("trail")))
			: this.tab === "Map" ? joinHints(this.mapPane === "tree" && hint.move("select"), this.mapPane === "tree" && hint.enter("inspect"), "S source", "D draft")
			: this.tab === "Status" ? joinHints("V raw", !this.trailMode && this.source.rebuild && "B rebuild map")
				: this.tab === "Settings" ? "F1–F3 other tabs" : "";
		const footer = [
			...(this.notice ? [fit(this.theme.fg("dim", this.notice), w)] : []),
			...(this.snapshot.note && (this.source.findingAction || this.source.prepareLeadDraft)
				? wrapTextWithAnsi(this.theme.fg("dim", findingKeys), w) : []),
			...wrapTextWithAnsi(this.theme.fg("dim", this.tab === "Settings" ? navigation : joinHints(navigation, "R refresh", "O on/off", "F4 settings", "C copy", hint.cancel("back"), hint.scroll())), w),
		];
		const available = Math.max(1, height - footer.length - header.length);
		this.pageRows = Math.max(1, available - 1);
		const detailWidth = this.tab === "Map" && !this.trailMode && w >= 80 ? w - Math.floor(w * 0.4) - 3 : w;
		const content = this.content(detailWidth);
		const max = Math.max(0, content.length - this.pageRows);
		this.total = content.length;
		const top = this.scroller.window(content.length, this.pageRows);
		let visible = content.slice(top, top + this.pageRows);
		if (this.tab === "Map" && this.trailMode && this.mapPane !== "source") {
			// Wide enough, the selected entry's details sit beside the trail; otherwise the trail has the row.
			const detailWidth = w >= 100 ? Math.min(44, Math.floor(w * 0.3)) : 0;
			const leftWidth = detailWidth ? w - detailWidth - 3 : w;
			const rows = this.trailBrowser.render(this.theme, leftWidth, this.pageRows, this.slot());
			const details = detailWidth ? this.trailBrowser.details(this.theme).flatMap(line => wrapTextWithAnsi(line, detailWidth).map(part => fit(part, detailWidth))) : [];
			visible = Array.from({ length: this.pageRows }, (_, i) => detailWidth
				? sideBySide(rows[i] ?? "", details[i] ?? "", leftWidth, divider, w)
				: rows[i] ?? "");
		}
		else if (this.tab === "Map" && (w >= 80 || this.mapPane === "tree")) {
			const leftWidth = w >= 80 ? Math.floor(w * 0.4) : w;
			const tree = this.browser.render(this.theme, leftWidth, this.pageRows);
			const details = visible;
			visible = Array.from({ length: this.pageRows }, (_, i) => w >= 80
				? sideBySide(tree[i] ?? "", details[i] ?? "", leftWidth, divider, w)
				: tree[i] ?? "");
		}
		while (visible.length < this.pageRows) visible.push("");
		if (available > 1) visible.push(fit(this.theme.fg("dim", top < max ? joinHints("More below", keyLabel("tui.select.pageDown")) : top ? joinHints("More above", keyLabel("tui.select.pageUp"))
			: this.tab === "Map" ? (this.trailMode ? `Trail held steady · ${keyLabel("tui.select.confirm")} shows the entry in the transcript` : joinHints("Map held steady", graphHints.expand())) : ""), w));
		return [...header, ...visible, ...footer].slice(0, height).map(line => fitPad(line, w));
	}

	invalidate(): void {}
	dispose(): void { this.sourceRequest++; }
}
