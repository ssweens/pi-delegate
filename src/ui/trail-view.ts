/**
 * Path's trail as a person reads it: the widget's breadcrumb rows, the Trail tab, and the status slot that says
 * what Path itself is doing. Nothing here uses the data model's words (waypoint, line, cursor); each entry is a
 * symbol coloured by its kind, a caption, and a time. Input routing belongs to the parent component.
 *
 * Glyphs: ◎ ↻ ↳ ↰ • ◆ ✗ □ ■ ▸ › ✓ ◔ ◑ ◕ ‖ and the braille spinner are single-width in Western terminals. Under an
 * East Asian ambiguous-width locale some render double; no fallback set yet.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { isStep, label, lineKey, trailEntries, type Trail, type Waypoint, type WaypointKind } from "../trail/types.ts";
import { detourWalk, glance, type Glance } from "../trail/projection.ts";
import { entryIdOf } from "../util/ref.ts";
import { clockTime, formatAge } from "../util/format.ts";
import { clipText, flatten } from "../util/text.ts";
import { GLYPH } from "./glyphs.ts";
import { navKeys } from "./keys.ts";
import { keepInView, moveIndex, stepFor } from "./scroll.ts";
import { fit, indent, padTo, selectedRow } from "./text.ts";

type Color = "accent" | "warning" | "success" | "error" | "muted" | "text" | "dim";
const KIND_COLOR: Record<WaypointKind, Color> = {
	set_out: "accent", reframed: "accent", detour: "warning", returned: "success", learned: "text", decided: "text", dead_end: "error", open: "muted", closed: "dim",
};
const KIND_SYMBOL: Record<WaypointKind, string> = {
	set_out: GLYPH.goal, reframed: GLYPH.goal, detour: GLYPH.detour, returned: GLYPH.back, learned: GLYPH.learned, decided: GLYPH.finding, dead_end: GLYPH.failed, open: GLYPH.open, closed: GLYPH.closed,
};
/** The kinds in plain words, for the details pane. */
export const KIND_WORD: Record<WaypointKind, string> = {
	set_out: "goal", reframed: "goal changed", detour: "detour", returned: "came back", learned: "finding", decided: "decision", dead_end: "dead end", open: "open", closed: "done",
};
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** One spinner frame; whoever draws a spinning slot repaints at this period (see `spinning`). */
export const SPIN_MS = 200;
const GAP = "  ";

const symbolOf = (w: Waypoint, theme: Theme) => theme.fg(KIND_COLOR[w.kind], KIND_SYMBOL[w.kind]);
/** `…96a9`: the tail of a transcript entry id, never the whole ref. */
const shortRef = (ref: string): string => `…${(entryIdOf(ref) ?? ref).slice(-4)}`;

/** What the status slot derives from: Path's status as the panel view carries it. */
export interface MomState { status: string; complete?: boolean; coverage?: { percent: number }; error?: string; trail?: { stage?: string; task?: string; since?: number } }
/** Path's own state in one slot: a symbol, and a word that is the first thing dropped when space runs out. */
export interface StatusSlot { symbol: string; word: string }

const stageWord = (state: MomState): string | undefined => {
	const stage = state.trail?.stage ?? state.status.split(" · ").slice(1).map(part => part.trim().split(/\s+/)[0]!)
		.filter(word => /^[a-z]+$/.test(word) && !["step", "section", "reviewing", "earlier"].includes(word)).at(-1);
	return stage?.split(/\s+/)[0]?.toLowerCase();
};
const shortReason = (error: string): string => {
	const text = flatten(error.replace(/^Last attempt:\s*/i, ""));
	const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
	return clipText(sentence.replace(/[.!?]$/, ""), 24);
};

/** Path's state shows the spinner: its surface must repaint every SPIN_MS or the spinner reads as frozen. */
export const spinning = (status: string): boolean =>
	status.startsWith("updating") || status === "update starting" || status === "connecting" || status === "reconnecting";

/** Path's state as a symbol and a word; undefined when there is nothing to say. */
export function statusSlot(state: MomState, theme: Theme, last?: Waypoint, now = Date.now()): StatusSlot | undefined {
	const status = state.status;
	if (status === "paused") return { symbol: theme.fg("muted", GLYPH.paused), word: "" };
	if (status === "needs you") return { symbol: theme.fg("warning", GLYPH.ask), word: theme.fg("warning", "needs you") };
	if (state.error) return { symbol: theme.fg("error", GLYPH.alert), word: theme.fg("error", shortReason(state.error)) };
	if (status.startsWith("retrying") || status.startsWith("re-reviewing")) return { symbol: theme.fg("warning", GLYPH.alert), word: theme.fg("warning", "retrying") };
	if (spinning(status)) {
		const frame = SPINNER[Math.floor(now / SPIN_MS) % SPINNER.length]!;
		// A busy trail names its run (reading, titling, repairing, backfilling) and, past a minute, how long it has run.
		const running = state.trail?.since !== undefined && now - state.trail.since >= 60_000 ? ` ${formatAge(state.trail.since, now)}` : "";
		const word = status.startsWith("updating") ? `${state.trail?.task ?? stageWord(state) ?? ""}${running}` : status === "update starting" ? "starting" : status;
		return { symbol: theme.fg("accent", frame), word: theme.fg("dim", word) };
	}
	if (status.startsWith("catching up")) {
		const percent = state.coverage?.percent ?? Number(/(\d+)%/.exec(status)?.[1]);
		const symbol = !Number.isFinite(percent) || percent <= 33 ? "◔" : percent <= 66 ? "◑" : "◕";
		return { symbol: theme.fg("accent", symbol), word: Number.isFinite(percent) ? theme.fg("dim", `${percent}%`) : "" };
	}
	if (status.startsWith("up to date") || ((status === "quiet" || status === "idle") && state.complete)) {
		return { symbol: theme.fg("success", GLYPH.done), word: last ? theme.fg("dim", formatAge(last.at, now)) : "" };
	}
	return undefined;
}

/** `left` with `slot` right-aligned on one row of `width`; the slot's word goes first, then the left truncates. */
function withSlot(left: string, slot: StatusSlot | undefined, width: number): string {
	if (!slot) return fit(left, width);
	const full = slot.word ? `${slot.symbol} ${slot.word}` : slot.symbol;
	const leftWidth = visibleWidth(left);
	const right = leftWidth + GAP.length + visibleWidth(full) <= width ? full : slot.symbol;
	const budget = Math.max(0, width - visibleWidth(right) - GAP.length);
	const text = fit(left, budget);
	return text + " ".repeat(Math.max(1, width - visibleWidth(text) - visibleWidth(right))) + right;
}

/** `left` with dim `right` at the far edge. `left` gives way down to half the row; past that `right` is dropped. */
function withRight(left: string, right: string, width: number): string {
	const budget = width - GAP.length - visibleWidth(right);
	if (!right || budget < Math.floor(width / 2)) return fit(left, width);
	const text = fit(left, budget);
	return padTo(text, width - visibleWidth(right)) + right;
}

/** `◎ goal › ↳ detour › ↳ detour`, newest bold; past the width the first stays, then `…`, then as many of the latest as fit. */
function journeyChain(items: readonly Waypoint[], theme: Theme, width: number): string {
	const sep = theme.fg("dim", " › ");
	const piece = (w: Waypoint, latest: boolean) => `${symbolOf(w, theme)} ${latest ? theme.bold(theme.fg("accent", label(w))) : theme.fg("muted", label(w))}`;
	const pieces = items.map((w, i) => piece(w, i === items.length - 1));
	const whole = pieces.join(sep);
	if (visibleWidth(whole) <= width || pieces.length < 3) return fit(whole, width);
	let tail = [pieces.at(-1)!];
	for (let i = pieces.length - 2; i > 0; i--) {
		const next = [pieces[i]!, ...tail];
		if (visibleWidth([pieces[0]!, theme.fg("dim", "…"), ...next].join(sep)) > width) break;
		tail = next;
	}
	return fit([pieces[0]!, theme.fg("dim", "…"), ...tail].join(sep), width);
}

/** Open items a level lists, one per row, before the rest are counted. */
const OPEN_ROWS = 3;

/**
 * The widget's rows: a task list. The current goal, with the goals that led to it trailing dim after `‹` (newest
 * first, the oldest cut first). Under it, one row per thing still to do (`□`), the most recent finished thing (`✓`,
 * with its age), and each open detour (`↳`) nested in the one it left, with what led to it after `‹`; the innermost,
 * where we are, is bold. Nothing else finished is shown. A fresh session is one row.
 */
export function trailRows(view: Glance, theme: Theme, width: number, now = Date.now()): string[] {
	const w = Math.max(1, Math.floor(width));
	const tree = view.tree;
	if (!tree) return [fit(theme.fg("muted", "Nothing on the trail yet."), w)];
	const rows: string[] = [];
	const led = (items: readonly Waypoint[]) => items.length ? theme.fg("dim", items.map(item => `  ‹ ${label(item)}`).join("")) : "";
	const deepest = tree.levels.length - 1;
	const name = (w: Waypoint, here: boolean) => here ? theme.bold(theme.fg("accent", label(w))) : label(w);
	tree.levels.forEach((level, i) => {
		const head = i === 0 ? `${theme.fg("accent", GLYPH.goal)} ${name(level.head, i === deepest)}${led(tree.before)}`
			: `${theme.fg("warning", GLYPH.detour)} ${name(level.head, i === deepest)}${led(level.from ? [level.from] : [])}`;
		rows.push(fit(indent(i) + head, w));
		const inner = indent(i + 1);
		const shown = level.open.length > OPEN_ROWS + 1 ? level.open.slice(0, OPEN_ROWS) : level.open;
		for (const item of shown) rows.push(fit(`${inner}${theme.fg("muted", GLYPH.open)} ${label(item)}`, w));
		if (shown.length < level.open.length) rows.push(fit(`${inner}${theme.fg("dim", `${GLYPH.open} +${level.open.length - shown.length} more`)}`, w));
		if (level.done) rows.push(withRight(`${inner}${theme.fg("success", GLYPH.done)} ${theme.fg("muted", label(level.done.waypoint))}`, theme.fg("dim", formatAge(level.done.at, now)), w));
	});
	return rows;
}

/** One row: where we are as `◎ goal › ↳ detour`, then `□N` when anything is still to do. */
export function trailCompactRow(view: Glance, theme: Theme, width: number): string {
	const w = Math.max(1, Math.floor(width));
	const tree = view.tree;
	if (!tree) return fit(theme.fg("muted", "Nothing on the trail yet."), w);
	const open = view.parked.length ? `${GAP}${theme.fg("muted", `□${view.parked.length}`)}` : "";
	return journeyChain(tree.levels.map(level => level.head), theme, Math.max(0, w - visibleWidth(open))) + open;
}

/** Path's state beside its title: `Path ⠙ thinking`; nothing when it is idle and current. */
export function titleWithSlot(title: string, slot: StatusSlot | undefined): string {
	if (!slot) return title;
	return `${title} ${slot.word ? `${slot.symbol} ${slot.word}` : slot.symbol}`;
}

/** The same rows without colour, for text surfaces (tool previews, `/path overview` outside the TUI). */
export function plainTrailRows(view: Glance, width = 100): string[] {
	const plain = { fg: (_c: string, text: string) => text, bold: (text: string) => text, bg: (_c: string, text: string) => text } as unknown as Theme;
	return trailRows(view, plain, width);
}

/** One entry of the chronological trail: dim time, indent by its depth then, coloured symbol, caption; the selected row is marked and highlighted. */
function row(waypoint: Waypoint, depth: number, theme: Theme, width: number, selected: boolean): string {
	const marker = selected ? theme.fg("accent", `${GLYPH.here} `) : "";
	const step = isStep(waypoint);
	const caption = waypoint.kind === "closed" ? theme.fg("dim", waypoint.caption) : selected ? theme.bold(waypoint.caption) : step ? theme.fg("dim", waypoint.caption) : waypoint.caption;
	const line = ` ${theme.fg("dim", clockTime(waypoint.at))}  ${indent(depth)}${marker}${stepSymbol(waypoint, theme)} ${caption}`;
	return selected ? selectedRow(theme, line, width) : fit(line, width);
}

/** A step shows its own symbol for a finding or a dead end, and `·` for a direction no user turn stood behind. */
const stepSymbol = (w: Waypoint, theme: Theme) => !isStep(w) ? symbolOf(w, theme) : w.step ? theme.fg("dim", "·") : theme.fg("dim", KIND_SYMBOL[w.kind]);

/**
 * Each entry's indent. Goals (the root thread's set_out and reframes) are headings at depth 0; everything under a
 * goal sits one in, plus its detour depth; a step one deeper than the waypoints around it.
 */
function entryDepths(entries: readonly Waypoint[]): number[] {
	const flow = entries.filter(w => !isStep(w));
	const { depth, after } = detourWalk(flow);
	const root = (flow.find(w => w.kind === "set_out") ?? flow[0])?.line;
	const isGoal = (w: Waypoint) => root !== undefined && lineKey(w.line) === lineKey(root) && (w.kind === "set_out" || w.kind === "reframed");
	let next = 0, open = 1;
	return entries.map(w => {
		if (isStep(w)) return open + 1;
		const goal = isGoal(w);
		open = after[next]! + 1;
		const at = depth[next++]!;
		return goal && at === 0 ? 0 : at + 1;
	});
}

/** The Trail tab: the goal and the open detours on top, a rule, then every waypoint and step oldest first. */
export function renderTrailTab(trail: Trail, theme: Theme, width: number, selected: number, slot?: StatusSlot): string[] {
	const w = Math.max(1, Math.floor(width));
	const view = glance(trail);
	const entries = trailEntries(trail);
	if (!entries.length) return [withSlot(" " + theme.fg("muted", "Nothing on the trail yet."), slot, w)];
	const lines: string[] = [];
	const goal = view.opening ?? view.goal;
	const head = goal ? `${theme.fg("accent", GLYPH.goal)} ${theme.bold(goal.caption)}${view.changed ? theme.fg("dim", " · changed") : ""}`
		: view.crumbs.length ? `${theme.fg("accent", GLYPH.goal)} ${theme.bold(view.crumbs[0]!)}` : theme.fg("muted", "No goal yet; steps only.");
	lines.push(withSlot(" " + head, slot, w));
	const open = openDetourStack(trail);
	open.forEach(({ detour, returnTo }, i) => {
		const left = ` ${indent(i)}${theme.fg("dim", "└")}${theme.fg("warning", GLYPH.detour)} ${detour.caption}`;
		lines.push(withRight(left, theme.fg("dim", `then back to ${returnTo}`), w));
	});
	lines.push(theme.fg("dim", ` ${"─".repeat(Math.max(0, w - 2))}`));
	const at = Math.min(entries.length - 1, Math.max(0, selected));
	const depth = entryDepths(entries);
	entries.forEach((waypoint, index) => lines.push(row(waypoint, depth[index]!, theme, w, index === at)));
	return lines;
}

/** Open detours outermost first with the thread each returns to; the same walk the standing uses. */
function openDetourStack(trail: Trail): { detour: Waypoint; returnTo: string }[] {
	const root = (trail.waypoints.find(w => w.kind === "set_out") ?? trail.waypoints[0])?.line ?? "";
	return detourWalk(trail.waypoints).open.map(index => ({ detour: trail.waypoints[index]!, returnTo: index > 0 ? trail.waypoints[index - 1]!.line : root }));
}

/** The selection over the trail's entries; the render keeps the selected row in view. */
export class TrailBrowser {
	private trail: Trail | undefined;
	private index = 0;
	private scroll = 0;

	constructor(trail: Trail | undefined) { this.update(trail); }

	update(trail: Trail | undefined): void {
		const previous = this.selectedWaypoint()?.id;
		this.trail = trail;
		const kept = previous && trail ? trailEntries(trail).findIndex(waypoint => waypoint.id === previous) : -1;
		// A fresh trail (or a struck selection) lands on the newest entry, where the work is.
		this.index = kept >= 0 ? kept : Math.max(0, this.count - 1);
	}

	get selected(): number { return this.index; }
	private get count(): number { return this.trail ? trailEntries(this.trail).length : 0; }

	move(delta: number): void {
		if (this.count) this.index = moveIndex(this.index, delta, this.count);
	}

	/** ↑↓ and Home/End move the selection. True when the key was one of them. */
	handleKey(data: string, page?: number): boolean {
		const step = stepFor(navKeys(data), page);
		if (step === undefined) return false;
		this.move(step);
		return true;
	}

	selectedWaypoint(): Waypoint | undefined { return this.trail ? trailEntries(this.trail)[this.index] : undefined; }

	/** The tab's lines windowed to `height`, scrolled so the selected row stays visible. */
	render(theme: Theme, width: number, height: number, slot?: StatusSlot): string[] {
		if (width < 1 || height < 1) return [];
		const trail = this.trail ?? { waypoints: [], struck: [] };
		const lines = renderTrailTab(trail, theme, width, this.index, slot);
		const count = trailEntries(trail).length;
		const selectedRow = count ? lines.length - count + this.index : 0;
		this.scroll = keepInView(this.scroll, selectedRow, height, lines.length);
		return lines.slice(this.scroll, this.scroll + height);
	}

	/** The details pane for the selected entry: caption, kind in plain words, thread, time, who marked it, and where it points in the transcript. */
	details(theme: Theme): string[] {
		const waypoint = this.selectedWaypoint();
		if (!waypoint) return [];
		const out = [`${stepSymbol(waypoint, theme)} ${theme.bold(waypoint.caption)}`,
			theme.fg("muted", `${isStep(waypoint) ? `step${waypoint.step ? "" : `, ${KIND_WORD[waypoint.kind]}`}` : KIND_WORD[waypoint.kind]} · ${waypoint.line} · ${clockTime(waypoint.at)}${waypoint.by === "user" ? " · marked by you" : ""}`)];
		if (waypoint.refs.length) out.push(theme.fg("dim", `in transcript ${waypoint.refs.map(shortRef).join(" ")}`));
		return out;
	}
}
