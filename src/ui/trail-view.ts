/**
 * Mom's trail as a person reads it: the widget's breadcrumb rows, the Trail tab, and the status slot that says
 * what Mom herself is doing. Nothing here uses the data model's words (waypoint, line, cursor); each entry is a
 * symbol coloured by its kind, a caption, and a time. Input routing belongs to the parent component.
 *
 * Glyphs: ◎ ↻ ↳ ↰ • ◆ ✗ □ ■ ▸ › ✓ ◔ ◑ ◕ ‖ and the braille spinner are single-width in Western terminals. Under an
 * East Asian ambiguous-width locale some render double; no fallback set yet.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isStep, trailEntries, type Trail, type Waypoint, type WaypointKind } from "../trail/types.ts";
import { detourWalk, glance, type Glance } from "../trail/projection.ts";
import { clockTime } from "../mom/anchor.ts";

type Color = "accent" | "warning" | "success" | "error" | "muted" | "text" | "dim";
const KIND_COLOR: Record<WaypointKind, Color> = {
	set_out: "accent", reframed: "accent", detour: "warning", returned: "success", learned: "text", decided: "text", dead_end: "error", open: "muted", closed: "dim",
};
const KIND_SYMBOL: Record<WaypointKind, string> = {
	set_out: "◎", reframed: "◎", detour: "↳", returned: "↰", learned: "•", decided: "◆", dead_end: "✗", open: "□", closed: "■",
};
/** The kinds in plain words, for the details pane. */
export const KIND_WORD: Record<WaypointKind, string> = {
	set_out: "goal", reframed: "goal changed", detour: "detour", returned: "came back", learned: "finding", decided: "decision", dead_end: "dead end", open: "open", closed: "done",
};
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const GAP = "  ";

const fit = (text: string, width: number) => width > 0 ? truncateToWidth(text, width, "…") : "";
const symbolOf = (w: Waypoint, theme: Theme) => theme.fg(KIND_COLOR[w.kind], KIND_SYMBOL[w.kind]);
/** `…96a9`: the tail of a transcript entry id, never the whole ref. */
const shortRef = (ref: string): string => {
	const entry = ref.split(":").slice(1).filter(part => !/^b\d+$/.test(part)).join(":") || ref;
	return `…${entry.slice(-4)}`;
};

/** `4m`, `1h`, `2d`: how long ago, for the far right of a row. */
export function age(at: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

/** What the status slot derives from: Mom's status as the panel view carries it. */
export interface MomState { status: string; complete?: boolean; coverage?: { percent: number }; error?: string; trail?: { stage?: string } }
/** Mom's own state in one slot: a symbol, and a word that is the first thing dropped when space runs out. */
export interface StatusSlot { symbol: string; word: string }

const stageWord = (state: MomState): string | undefined => {
	const stage = state.trail?.stage ?? state.status.split(" · ").slice(1).map(part => part.trim().split(/\s+/)[0]!)
		.filter(word => /^[a-z]+$/.test(word) && !["step", "section", "reviewing", "earlier"].includes(word)).at(-1);
	return stage?.split(/\s+/)[0]?.toLowerCase();
};
const shortReason = (error: string): string => {
	const text = error.replace(/^Last attempt:\s*/i, "").replace(/\s+/g, " ").trim();
	const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
	return fit(sentence.replace(/[.!?]$/, ""), 24);
};

/** Mom's state as a symbol and a word; undefined when there is nothing to say. */
export function statusSlot(state: MomState, theme: Theme, last?: Waypoint, now = Date.now()): StatusSlot | undefined {
	const status = state.status;
	if (status === "paused") return { symbol: theme.fg("muted", "‖"), word: "" };
	if (status === "needs you") return { symbol: theme.fg("warning", "?"), word: theme.fg("warning", "needs you") };
	if (state.error) return { symbol: theme.fg("error", "!"), word: theme.fg("error", shortReason(state.error)) };
	if (status.startsWith("retrying") || status.startsWith("re-reviewing")) return { symbol: theme.fg("warning", "!"), word: theme.fg("warning", "retrying") };
	if (status.startsWith("updating") || status === "update starting" || status === "connecting" || status === "reconnecting") {
		const frame = SPINNER[Math.floor(now / 120) % SPINNER.length]!;
		const word = status.startsWith("updating") ? stageWord(state) ?? "" : status === "update starting" ? "starting" : status;
		return { symbol: theme.fg("accent", frame), word: theme.fg("dim", word) };
	}
	if (status.startsWith("catching up")) {
		const percent = state.coverage?.percent ?? Number(/(\d+)%/.exec(status)?.[1]);
		const symbol = !Number.isFinite(percent) || percent <= 33 ? "◔" : percent <= 66 ? "◑" : "◕";
		return { symbol: theme.fg("accent", symbol), word: Number.isFinite(percent) ? theme.fg("dim", `${percent}%`) : "" };
	}
	if (status.startsWith("up to date") || ((status === "quiet" || status === "idle") && state.complete)) {
		return { symbol: theme.fg("success", "✓"), word: last ? theme.fg("dim", age(last.at, now)) : "" };
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
	return text + " ".repeat(width - visibleWidth(text) - visibleWidth(right)) + right;
}

/** Thread names from the root to where we are, the innermost bold; the middle collapses to … before anything truncates. */
function breadcrumb(crumbs: string[], theme: Theme, width: number): string {
	const sep = theme.fg("dim", " › ");
	const paint = (name: string, index: number) => index === crumbs.length - 1 ? theme.bold(theme.fg("accent", name)) : theme.fg("muted", name);
	const join = (names: string[], offset: number) => names.map((name, i) => name === "…" ? theme.fg("dim", "…") : paint(name, offset + i)).join(sep);
	const whole = join(crumbs, 0);
	if (visibleWidth(whole) <= width || crumbs.length < 3) return fit(whole, width);
	const collapsed = [paint(crumbs[0]!, 0), theme.fg("dim", "…"), paint(crumbs.at(-1)!, crumbs.length - 1)].join(sep);
	return fit(collapsed, width);
}

/** `□ caption    □ caption` as many as fit, then `□N` for the rest. */
function openRow(items: Waypoint[], theme: Theme, width: number): string {
	const box = theme.fg("muted", "□");
	const tail = (rest: number) => rest ? theme.fg("muted", `□${rest}`) : "";
	let row = "";
	for (let i = 0; i < items.length; i++) {
		const piece = `${box} ${items[i]!.caption}`;
		const rest = tail(items.length - i - 1);
		const prefix = row ? `${row}    ` : "";
		const needed = visibleWidth(prefix) + visibleWidth(piece) + (rest ? 4 + visibleWidth(rest) : 0);
		if (needed <= width) { row = prefix + piece; continue; }
		if (!row) {
			const left = tail(items.length - 1);
			const text = fit(piece, Math.max(0, width - (left ? 4 + visibleWidth(left) : 0)));
			return left ? `${text}    ${left}` : text;
		}
		return `${row}    ${tail(items.length - i)}`;
	}
	return row;
}

/**
 * The widget's rows, at most four: where we are (with Mom's state at the far right), the detour we are on, its open
 * items, the latest entry. A row that would repeat another is left out; a fresh session is one row.
 */
export function trailRows(view: Glance, theme: Theme, width: number, slot?: StatusSlot, now = Date.now()): string[] {
	const w = Math.max(1, Math.floor(width));
	if (!view.crumbs.length) return [withSlot(theme.fg("muted", "Nothing on the trail yet."), slot, w)];
	const goalSymbol = theme.fg("accent", "◎") + " ";
	const goal = view.opening ?? view.goal;
	const changed = view.changed ? theme.fg("dim", " · changed") : "";
	const headWidth = Math.max(0, w - visibleWidth(goalSymbol) - (slot ? GAP.length + visibleWidth(slot.symbol) : 0));
	// The opening goal, never a later request: a goal change shows as a mark here and as the latest entry below.
	const head = view.current ? breadcrumb(view.crumbs, theme, headWidth)
		: fit(theme.bold(theme.fg("accent", goal?.caption ?? view.crumbs[0]!)), Math.max(0, headWidth - visibleWidth(changed))) + changed;
	const rows = [withSlot(goalSymbol + head, slot, w)];
	if (view.current) rows.push(fit(`  ${view.current.detour.caption}`, w));
	if (view.open.length) rows.push(fit(`  ${openRow(view.open, theme, w - 2)}`, w));
	// The latest entry earns a row only when the rows above have not already shown it (as the goal, the detour, or an open item).
	const last = view.last;
	if (last && last.id !== goal?.id && last.id !== view.current?.detour.id && !view.open.some(item => item.id === last.id)) {
		rows.push(withRight(`  ${symbolOf(last, theme)} ${last.caption}`, theme.fg("dim", age(last.at, now)), w));
	}
	return rows;
}

/** One row: the breadcrumb, `□N` when anything is open, Mom's symbol. */
export function trailCompactRow(view: Glance, theme: Theme, width: number, slot?: StatusSlot): string {
	const w = Math.max(1, Math.floor(width));
	if (!view.crumbs.length) return withSlot(theme.fg("muted", "Nothing on the trail yet."), slot, w);
	const open = view.open.length ? `${GAP}${theme.fg("muted", `□${view.open.length}`)}` : "";
	const symbol = theme.fg("accent", "◎") + " ";
	const reserved = visibleWidth(symbol) + visibleWidth(open) + (slot ? GAP.length + visibleWidth(slot.symbol) : 0);
	return withSlot(symbol + breadcrumb(view.crumbs, theme, Math.max(0, w - reserved)) + open, slot, w);
}

/** The same rows without colour, for text surfaces (tool previews, `/mom overview` outside the TUI). */
export function plainTrailRows(view: Glance, width = 100): string[] {
	const plain = { fg: (_c: string, text: string) => text, bold: (text: string) => text, bg: (_c: string, text: string) => text } as unknown as Theme;
	return trailRows(view, plain, width);
}

/** One entry of the chronological trail: dim time, indent by its depth then, coloured symbol, caption; the selected row is marked and highlighted. */
function row(waypoint: Waypoint, depth: number, theme: Theme, width: number, selected: boolean): string {
	const marker = selected ? theme.fg("accent", "▸ ") : "";
	const step = isStep(waypoint);
	const caption = waypoint.kind === "closed" ? theme.fg("dim", waypoint.caption) : selected ? theme.bold(waypoint.caption) : step ? theme.fg("dim", waypoint.caption) : waypoint.caption;
	const line = ` ${theme.fg("dim", clockTime(waypoint.at))}  ${"  ".repeat(depth)}${marker}${stepSymbol(waypoint, theme)} ${caption}`;
	return selected ? theme.bg("selectedBg", truncateToWidth(line, width, "…", true)) : fit(line, width);
}

/** A step shows its own symbol for a finding or a dead end, and `·` for a direction no user turn stood behind. */
const stepSymbol = (w: Waypoint, theme: Theme) => !isStep(w) ? symbolOf(w, theme) : w.step ? theme.fg("dim", "·") : theme.fg("dim", KIND_SYMBOL[w.kind]);

/** Each entry's indent: a waypoint at its detour depth, a step one deeper than the waypoints around it. */
function entryDepths(entries: readonly Waypoint[]): number[] {
	const flow = entries.filter(w => !isStep(w));
	const { depth, after } = detourWalk(flow);
	let next = 0, open = 0;
	return entries.map(w => {
		if (isStep(w)) return open + 1;
		open = after[next]!;
		return depth[next++]!;
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
	const head = goal ? `${theme.fg("accent", "◎")} ${theme.bold(goal.caption)}${view.changed ? theme.fg("dim", " · changed") : ""}`
		: view.crumbs.length ? `${theme.fg("accent", "◎")} ${theme.bold(view.crumbs[0]!)}` : theme.fg("muted", "No goal yet; steps only.");
	lines.push(withSlot(" " + head, slot, w));
	const open = openDetourStack(trail);
	open.forEach(({ detour, returnTo }, i) => {
		const left = ` ${"  ".repeat(i)}${theme.fg("dim", "└")}${theme.fg("warning", "↳")} ${detour.caption}`;
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
		const count = this.count;
		if (!count) return;
		this.index = Math.min(count - 1, Math.max(0, this.index + Math.trunc(delta)));
	}

	first(): void { this.index = 0; }
	last(): void { this.index = Math.max(0, this.count - 1); }

	selectedWaypoint(): Waypoint | undefined { return this.trail ? trailEntries(this.trail)[this.index] : undefined; }

	/** The tab's lines windowed to `height`, scrolled so the selected row stays visible. */
	render(theme: Theme, width: number, height: number, slot?: StatusSlot): string[] {
		if (width < 1 || height < 1) return [];
		const trail = this.trail ?? { waypoints: [], struck: [] };
		const lines = renderTrailTab(trail, theme, width, this.index, slot);
		const count = trailEntries(trail).length;
		const selectedRow = count ? lines.length - count + this.index : 0;
		this.scroll = Math.min(Math.max(this.scroll, selectedRow - height + 1, 0), selectedRow, Math.max(0, lines.length - height));
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
