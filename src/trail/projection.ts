/**
 * Projections over one branch's trail (strikes applied). All pure, no model call: the trail is a list of
 * pointers in recorded order, so every question about the journey is a fold over that list. See
 * docs/trail.md "Projections".
 */
import { lineKey, trailEntries, type Trail, type Waypoint } from "./types.ts";
import { clockTime } from "../util/format.ts";

export type LineStatus = "open" | "returned" | "landed" | "dead_end" | "quiet";

export interface LineView {
	/** The line as first written; `key` is its normalized form, which later waypoints match on. */
	name: string;
	key: string;
	openedBy: Waypoint;
	detour: boolean;
	/** For a detour: the line that was current when it began, so a `returned` knows where to go. */
	returnTo?: string;
	status: LineStatus;
	last: Waypoint;
	goal?: Waypoint;
	count: number;
}

export interface Standing {
	goal?: Waypoint;
	currentLine?: string;
	/** Open detours, outermost first; the innermost is where we are. */
	detours: { detour: Waypoint; returnTo: string }[];
	open: Waypoint[];
	recent: Waypoint[];
}

const LANDED_KINDS = new Set(["decided", "learned", "closed"]);
const LANDING_KINDS = new Set(["decided", "learned", "dead_end", "returned", "closed"]);

const supersededIds = (trail: Trail): Set<string> => new Set(trail.waypoints.flatMap(w => w.supersedes ? [w.supersedes] : []));
/** Ids closed by the kinds that may close them, steps included (a finding can answer a parked question); `closes` always names an earlier entry, so order needs no check. */
const closedIds = (trail: Trail, by: readonly Waypoint["kind"][]): Set<string> =>
	new Set(trailEntries(trail).flatMap(w => w.closes && by.includes(w.kind) ? [w.closes] : []));
const closedDetours = (trail: Trail) => detourWalk(trail.waypoints).closed;
const closedOpens = (trail: Trail) => closedIds(trail, ["closed", "dead_end"]);

const lastOf = <T>(items: readonly T[]): T | undefined => items[items.length - 1];
const rootLine = (trail: Trail): string | undefined => (trail.waypoints.find(w => w.kind === "set_out") ?? trail.waypoints[0])?.line;
const currentLine = (trail: Trail): string | undefined => lastOf(trail.waypoints)?.line;
/** The line current before waypoint `index`: the preceding waypoint's line, or the root line for the first. */
const lineBefore = (trail: Trail, index: number): string => (index > 0 ? trail.waypoints[index - 1].line : rootLine(trail)!);

/**
 * The one place detours open and close, over waypoints in transcript order. A `returned` with `closes` closes
 * that detour; one without closes the innermost detour still open before it (backfill may have recorded the
 * live `returned` before the detour it ends, so the link can be missing). `depth[i]` is how many detours were
 * open at waypoint i (`after[i]`: once it is recorded): a `returned` sits at the depth of the thread it resumes. `open` holds the indexes of
 * detours still open, outermost first.
 */
export function detourWalk(waypoints: readonly Waypoint[]): { closed: Set<string>; depth: number[]; after: number[]; open: number[] } {
	const explicit = new Set(waypoints.flatMap(w => w.kind === "returned" && w.closes ? [w.closes] : []));
	const closed = new Set<string>(), stack: number[] = [], depth: number[] = [], after: number[] = [];
	const passed = new Set<string>();
	waypoints.forEach((w, index) => {
		if (w.kind === "returned") {
			if (w.closes) {
				passed.add(w.closes);
				closed.add(w.closes);
				const at = stack.findIndex(i => waypoints[i]!.id === w.closes);
				if (at >= 0) stack.splice(at, 1);
			} else {
				const top = stack.pop();
				if (top !== undefined) closed.add(waypoints[top]!.id);
			}
		}
		depth.push(stack.length);
		// A detour whose explicit closer was already seen (reordered by backfill) never opens.
		if (w.kind === "detour" && !(explicit.has(w.id) && passed.has(w.id))) stack.push(index);
		after.push(stack.length);
	});
	return { closed, depth, after, open: stack };
}

const openDetours = (trail: Trail): { detour: Waypoint; returnTo: string; index: number }[] =>
	detourWalk(trail.waypoints).open.map(index => ({ detour: trail.waypoints[index]!, returnTo: lineBefore(trail, index), index }));

/** Waypoints with superseded ones removed: what we believe now. */
export function current(trail: Trail): Waypoint[] {
	const superseded = supersededIds(trail);
	return trail.waypoints.filter(w => !superseded.has(w.id));
}

export function lines(trail: Trail): LineView[] {
	const superseded = supersededIds(trail), closedDetour = closedDetours(trail), closedOpen = closedOpens(trail);
	const currentKey = currentLine(trail) === undefined ? undefined : lineKey(currentLine(trail)!);
	const views = new Map<string, LineView>();
	const members = new Map<string, Waypoint[]>();
	trail.waypoints.forEach((w, index) => {
		const key = lineKey(w.line);
		if (!views.has(key)) {
			const detour = w.kind === "detour";
			views.set(key, { name: w.line, key, openedBy: w, detour, returnTo: detour ? lineBefore(trail, index) : undefined, status: "quiet", last: w, count: 0 });
			members.set(key, []);
		}
		members.get(key)!.push(w);
	});
	for (const view of views.values()) {
		const own = members.get(view.key)!;
		const believed = own.filter(w => !superseded.has(w.id));
		const last = lastOf(believed) ?? lastOf(own)!;
		view.last = lastOf(own)!;
		view.count = own.length;
		view.goal = lastOf(believed.filter(w => w.kind === "set_out" || w.kind === "reframed"));
		const unclosedOpen = believed.some(w => w.kind === "open" && !closedOpen.has(w.id));
		const unclosedDetour = view.detour && !closedDetour.has(view.openedBy.id);
		// Precedence follows docs/trail.md: a dead end is a dead end even if we came back from it.
		view.status = last.kind === "dead_end" ? "dead_end"
			: view.detour && closedDetour.has(view.openedBy.id) ? "returned"
			: LANDED_KINDS.has(last.kind) ? "landed"
			: view.key === currentKey || unclosedOpen || unclosedDetour ? "open"
			: "quiet";
	}
	return [...views.values()];
}

export function whereWeAre(trail: Trail, recent = 3): Standing {
	const root = rootLine(trail);
	const line = currentLine(trail);
	if (root === undefined || line === undefined) return { detours: [], open: [], recent: [] };
	const believed = current(trail);
	const goal = lastOf(believed.filter(w => lineKey(w.line) === lineKey(root) && (w.kind === "set_out" || w.kind === "reframed")));
	return {
		goal,
		currentLine: line,
		detours: openDetours(trail).map(({ detour, returnTo }) => ({ detour, returnTo })),
		open: openItems(trail, line).flatMap(group => group.items),
		recent: trail.waypoints.slice(-recent),
	};
}

/** Where we were when the innermost open detour began, and the last waypoint there before it. */
export function beforeLastDetour(trail: Trail): { detour: Waypoint; line: LineView; last?: Waypoint } | undefined {
	const innermost = lastOf(openDetours(trail));
	if (!innermost) return undefined;
	const key = lineKey(innermost.returnTo);
	const line = lines(trail).find(view => view.key === key);
	if (!line) return undefined;
	const last = lastOf(trail.waypoints.slice(0, innermost.index).filter(w => lineKey(w.line) === key));
	return { detour: innermost.detour, line, last };
}

/** What the widget shows at a glance: the goal, the thread names from the root to where we are, the detour we are on, its open items, the latest waypoint. */
export interface Glance {
	/** The current goal: the root line's latest set_out or reframed. */
	goal?: Waypoint;
	/** The goal the session set out with. The widget shows this one: a later request must not replace it at a glance. */
	opening?: Waypoint;
	/** The root line's goal was reframed since. */
	changed: boolean;
	/** Thread names, root first, the thread we are on last; one entry when no detour is open. */
	crumbs: string[];
	/** The innermost open detour and the thread it returns to. */
	current?: { detour: Waypoint; returnTo: string };
	/** Open items on the thread we are on. */
	open: Waypoint[];
	/** The widget's tree; absent on an empty trail. */
	tree?: GlanceTree;
	/** Open items on every thread, oldest first. */
	parked: Waypoint[];
	last?: Waypoint;
	/** How many detours are open. */
	depth: number;
}

export function glance(trail: Trail): Glance {
	const standing = whereWeAre(trail);
	const root = rootLine(trail);
	const crumbs = root === undefined ? [] : [root, ...standing.detours.map(entry => entry.detour.line)];
	const goals = root === undefined ? [] : trail.waypoints.filter(w => lineKey(w.line) === lineKey(root) && (w.kind === "set_out" || w.kind === "reframed"));
	const opening = goals.find(w => w.kind === "set_out") ?? goals[0];
	const parked = openItems(trail).flatMap(group => group.items);
	return { goal: standing.goal, opening, changed: goals.some(w => w.kind === "reframed"), crumbs, current: lastOf(standing.detours), open: standing.open,
		tree: glanceTree(trail, parked), parked, last: lastOf(trail.waypoints), depth: standing.detours.length };
}

/** Kinds that finish something: a choice made, an open item closed, a detour come back from. */
const DONE_KINDS = new Set<Waypoint["kind"]>(["decided", "closed", "returned"]);
const GOAL_KINDS = new Set<Waypoint["kind"]>(["set_out", "reframed"]);

/**
 * The widget's tree, as tasks. The current goal is the latest goal on any thread (a new set_out on its own thread
 * replaces the last one as much as a reframe does), with the goals before it, newest first, as what led there. Under
 * it hang what is still open and the detours still open, each nested in the one it left and carrying what led to it
 * (its `from`). Everything finished is left out, except the most recent finished thing, which shows under the level
 * it happened in and reads as the thing it finished: a `returned` as its detour, a `closed` as its open item.
 */
function glanceTree(trail: Trail, parked: readonly Waypoint[]): GlanceTree | undefined {
	const all = trail.waypoints, entries = trailEntries(trail);
	if (!all.length) return undefined;
	const byId = new Map(entries.map(w => [w.id, w]));
	const goals = all.filter(w => GOAL_KINDS.has(w.kind));
	const goal = lastOf(goals) ?? all[0]!;
	// Transcript position over waypoints and steps alike.
	const position = new Map(entries.map((w, i) => [w.id, i]));
	const at = (w: Waypoint) => position.get(w.id) ?? -1;
	const isWaypoint = new Set(all.map(w => w.id));
	const before = goals.filter(w => at(w) < at(goal)).reverse();
	const detours = openDetours(trail);
	const from = (w: Waypoint) => w.from ? byId.get(w.from) : undefined;
	const levels: GlanceLevel[] = [{ head: goal, open: [] }, ...detours.map(({ detour }) => ({ head: detour, from: from(detour), open: [] as Waypoint[] }))];
	// An item belongs to the level whose thread it names: an open detour's, else the goal's; on any other thread, to
	// the innermost open detour that began before it, else to the goal.
	const levelOf = (w: Waypoint) => {
		const key = lineKey(w.line), named = levels.findLastIndex(level => lineKey(level.head.line) === key);
		if (named >= 0) return named;
		let level = 0; detours.forEach((d, i) => { if (at(d.detour) < at(w)) level = i + 1; }); return level;
	};
	for (const item of parked) levels[levelOf(item)]!.open.push(item);
	// Finished: a waypoint that decides, closes or returns, or a step that closes a parked item (it answered it).
	const done = lastOf(entries.filter(w => DONE_KINDS.has(w.kind) && (isWaypoint.has(w.id) || (w.closes !== undefined && byId.has(w.closes)))));
	if (done) levels[levelOf(done)]!.done = { waypoint: (done.closes ? byId.get(done.closes) : undefined) ?? done, at: done.at, kind: done.kind };
	return { goal, before, levels };
}

export interface GlanceLevel {
	/** The current goal (level 0) or an open detour. */
	head: Waypoint;
	/** What led to this detour, when Path recorded it. */
	from?: Waypoint;
	/** The most recent finished thing, when it happened here: what to label it by, when, and how it finished. */
	done?: { waypoint: Waypoint; at: number; kind: Waypoint["kind"] };
	/** Open items raised here. */
	open: Waypoint[];
}
export interface GlanceTree {
	/** The current goal. */
	goal: Waypoint;
	/** The goals before it, newest first: how the work got here. */
	before: Waypoint[];
	/** The current goal's level, then each open detour, outermost first; the last is where we are. */
	levels: GlanceLevel[];
}

/**
 * What the glance shows that has no title yet, the most visible first, then every other untitled waypoint newest
 * first. Path is offered these to title (trail.untitled); a pass over an older trail starts where the eye does.
 */
export function untitledEntries(trail: Trail): Waypoint[] {
	const tree = glance(trail).tree;
	const shown = tree ? [tree.goal, ...tree.before, ...tree.levels.flatMap(level => [level.head, ...(level.from ? [level.from] : []), ...(level.done ? [level.done.waypoint] : []), ...level.open])] : [];
	return [...new Set([...shown, ...[...trail.waypoints].reverse()])].filter(w => !w.title);
}

/** Each waypoint's detour depth when it was recorded: how many detours were open. A `returned` sits at the depth of the thread it resumes. */
export function depths(trail: Trail): number[] {
	return detourWalk(trail.waypoints).depth;
}

/**
 * Lines matching `query`: by line name first; only when no name matches, by caption. A name match is
 * what "where did we land with X" means, and caption matches on a common word would bury it.
 */
export function landing(trail: Trail, query: string): { line: LineView; landed?: Waypoint; lastTouched: Waypoint }[] {
	const needle = lineKey(query);
	if (!needle) return [];
	const all = lines(trail);
	let matched = all.filter(view => view.key.includes(needle));
	if (!matched.length) {
		const keys = new Set(trail.waypoints.filter(w => lineKey(w.caption).includes(needle)).map(w => lineKey(w.line)));
		matched = all.filter(view => keys.has(view.key));
	}
	const superseded = supersededIds(trail);
	return matched.map(line => ({
		line,
		landed: lastOf(trail.waypoints.filter(w => lineKey(w.line) === line.key && LANDING_KINDS.has(w.kind) && !superseded.has(w.id))),
		lastTouched: line.last,
	}));
}

/** `open` waypoints nothing has closed (and nothing has superseded), grouped by line in first-appearance order. */
export function openItems(trail: Trail, line?: string): { line: string; items: Waypoint[] }[] {
	const closed = closedOpens(trail), superseded = supersededIds(trail);
	const only = line === undefined ? undefined : lineKey(line);
	const groups = new Map<string, { line: string; items: Waypoint[] }>();
	for (const w of trail.waypoints) {
		const key = lineKey(w.line);
		if (only !== undefined && key !== only) continue;
		if (!groups.has(key)) groups.set(key, { line: w.line, items: [] });
		if (w.kind === "open" && !closed.has(w.id) && !superseded.has(w.id)) groups.get(key)!.items.push(w);
	}
	return [...groups.values()].filter(group => group.items.length);
}

/** How the root goal changed: its set_out then every reframed, superseded ones included; that chain is the story. */
export function evolution(trail: Trail): Waypoint[] {
	const root = rootLine(trail);
	if (root === undefined) return [];
	const key = lineKey(root);
	return trail.waypoints.filter(w => lineKey(w.line) === key && (w.kind === "set_out" || w.kind === "reframed"));
}

const refs = (w: Waypoint): string => w.refs.map(ref => `[src:${ref}]`).join(" ");
const cited = (w: Waypoint): string => `${w.caption} ${refs(w)}`;

export function renderWaypoint(w: Waypoint, opts: { time?: boolean; line?: boolean } = {}): string {
	const head = [opts.time === false ? "" : clockTime(w.at), w.kind].filter(Boolean).join(" ");
	return [head, ...(opts.line === false ? [] : [w.line]), cited(w)].join(" · ");
}

/**
 * The lead's standing section: descriptive, cites the transcript, never direction. "" for an empty trail.
 * The "Last:" row is left out when the latest waypoint is the goal or the innermost detour already shown.
 */
export function renderStanding(trail: Trail): string {
	const standing = whereWeAre(trail);
	const last = lastOf(trail.waypoints);
	if (!last) return "";
	const out = ["Path's trail — where we are (descriptive, not direction):"];
	if (standing.goal) out.push(`Set out${standing.goal.kind === "reframed" ? " (reframed)" : ""}: ${cited(standing.goal)}`);
	// Innermost first: the detour we are on matters most, and deep stacks must not crowd out the rest.
	const depth = standing.detours.length;
	standing.detours.slice(-3).reverse().forEach((entry, i) => out.push(`Detour ${depth - i} deep: ${entry.detour.caption} — return to: ${entry.returnTo} ${refs(entry.detour)}`));
	if (depth > 3) out.push(`(${depth - 3} more detour${depth - 3 === 1 ? "" : "s"} beneath)`);
	if (standing.open.length) {
		const shown = standing.open.slice(0, 3).map(cited).join("; ");
		out.push(`Open on this line: ${shown}${standing.open.length > 3 ? `; +${standing.open.length - 3} more` : ""}`);
	}
	const shownAlready = last.id === standing.goal?.id || last.id === lastOf(standing.detours)?.detour.id;
	if (!shownAlready) out.push(`Last: ${clockTime(last.at)} ${last.kind} ${cited(last)}`);
	return out.join("\n");
}

/** Chronological trail, one waypoint per line; struck ones are already gone from `trail`. "" when nothing matches. */
export function renderTrail(trail: Trail, opts: { line?: string; since?: number; limit?: number } = {}): string {
	const key = opts.line === undefined ? undefined : lineKey(opts.line);
	let shown = trail.waypoints.filter(w => (key === undefined || lineKey(w.line) === key) && (opts.since === undefined || w.at >= opts.since));
	if (opts.limit !== undefined && opts.limit >= 0) shown = shown.slice(-opts.limit);
	return shown.map(w => renderWaypoint(w)).join("\n");
}

export function renderLanding(results: ReturnType<typeof landing>): string {
	if (!results.length) return "Nothing on the trail matches.";
	return results.map(({ line, landed, lastTouched }) => [
		`${line.name} (${line.status})`,
		landed ? `  landed ${clockTime(landed.at)} ${landed.kind}: ${cited(landed)}`
			: `  never landed; last touched ${clockTime(lastTouched.at)}: ${cited(lastTouched)}`,
	].join("\n")).join("\n");
}

export function renderBefore(result: ReturnType<typeof beforeLastDetour> | undefined): string {
	if (!result) return "No open detour; nothing to return to.";
	return [
		`Before the detour (${result.detour.caption} ${refs(result.detour)}) we were on: ${result.line.name} (${result.line.status})`,
		result.last ? `  last there ${clockTime(result.last.at)} ${result.last.kind}: ${cited(result.last)}` : "  nothing recorded on it before the detour",
	].join("\n");
}

export function renderOpen(groups: ReturnType<typeof openItems>): string {
	if (!groups.length) return "No open items.";
	return groups.map(group => [`${group.line}:`, ...group.items.map(w => `  ${clockTime(w.at)} ${cited(w)}`)].join("\n")).join("\n");
}

export function renderEvolution(points: Waypoint[]): string {
	if (!points.length) return "No goal recorded yet.";
	return points.map(w => renderWaypoint(w, { line: false })).join("\n");
}
