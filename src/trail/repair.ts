/**
 * A refresh's revisions: beside any new activity, Path revises the entries it already wrote from the trail alone
 * (captions and the user's words, no transcript), so an older trail gets titles, links and kinds under the current
 * rules in the same model call.
 * Records are never edited: a title alone becomes a title record; any other change strikes the entry and appends a
 * revised copy (same refs, anchor and time, so it keeps its place). An entry linking to a copied one is copied too,
 * with the link moved, so nothing points at a struck id. See docs/trail.md "Revision".
 */
import { STEP_KINDS, trailEntries, type Revision, type Trail, type Waypoint, type WaypointKind } from "./types.ts";
import { flatten } from "../util/text.ts";



export interface RepairPlan {
	defects: string[];
	/** Titles for entries otherwise unchanged. */
	titles: { id: string; title: string }[];
	/** Entries leaving the trail: dropped, or replaced by a revised copy. */
	strikes: { target: string; reason: string }[];
	/** Revised copies, in trail order. */
	copies: Waypoint[];
}

const CLOSES: Partial<Record<WaypointKind, WaypointKind[]>> = { returned: ["detour"], closed: ["open"], dead_end: ["open"] };

/** Plans one refresh's revisions against `trail` (struck entries excluded). `idFor(n)` names the n-th copy. */
export function planRepair(trail: Trail, revisions: readonly Revision[], idFor: (index: number) => string): RepairPlan {
	const entries = trailEntries(trail), byId = new Map(entries.map(w => [w.id, w]));
	const defects: string[] = [];
	const wanted = new Map<string, Revision>();
	revisions.forEach((revision, index) => {
		const where = `revise[${index}]`;
		const entry = byId.get(revision.id);
		if (!entry) { defects.push(`${where} names unknown entry ${revision.id}`); return; }
		if (entry.by === "user") { defects.push(`${where}: ${revision.id} was marked by the user; leave it`); return; }
		if (wanted.has(revision.id)) { defects.push(`${where} repeats ${revision.id}`); return; }
		// A goal is where the user set out: never dropped. A wrong one is retitled or reframed instead.
		if (revision.drop && entry.kind === "set_out") { defects.push(`${where}: ${revision.id} is a goal the user set (set_out); a goal is never dropped, give it a better title instead`); return; }
		const kind = revision.kind ?? entry.kind;
		for (const field of ["from", "closes"] as const) {
			const target = revision[field];
			if (typeof target !== "string") continue;
			if (target === revision.id) defects.push(`${where}.${field} names the entry itself`);
			else if (!byId.has(target)) defects.push(`${where}.${field} names unknown entry ${target}`);
		}
		const closes = revision.closes === undefined ? entry.closes : revision.closes ?? undefined;
		if (closes !== undefined && byId.has(closes)) {
			const allowed = CLOSES[kind];
			if (!allowed) defects.push(`${where}: a ${kind} does not close anything; set closes to null`);
			else if (!allowed.includes(byId.get(closes)!.kind)) defects.push(`${where}.closes must name ${allowed.join(" or ")}, not ${byId.get(closes)!.kind} ${closes}`);
		}
		wanted.set(revision.id, revision);
	});
	if (defects.length) return { defects, titles: [], strikes: [], copies: [] };

	const dropped = new Set([...wanted.values()].filter(r => r.drop).map(r => r.id));
	const changes = (w: Waypoint, r: Revision) => (r.kind !== undefined && r.kind !== w.kind) || (r.from !== undefined && (r.from ?? undefined) !== w.from)
		|| (r.closes !== undefined && (r.closes ?? undefined) !== w.closes);
	const copied = new Set([...wanted.values()].filter(r => !r.drop && changes(byId.get(r.id)!, r)).map(r => r.id));
	// An entry linking to a copied one is copied with the link moved; repeat until nothing new links to a copy.
	for (let grew = true; grew;) {
		grew = false;
		for (const w of entries) {
			if (copied.has(w.id) || dropped.has(w.id) || w.by === "user") continue;
			if ([w.closes, w.supersedes, w.from].some(link => link !== undefined && copied.has(link))) { copied.add(w.id); grew = true; }
		}
	}
	const newId = new Map<string, string>();
	let n = 0;
	for (const w of entries) if (copied.has(w.id)) newId.set(w.id, idFor(n++));
	const move = (link: string | undefined) => link === undefined || dropped.has(link) ? undefined : newId.get(link) ?? link;
	const copies: Waypoint[] = [];
	for (const w of entries) {
		if (!copied.has(w.id)) continue;
		const r = wanted.get(w.id);
		const kind = r?.kind ?? w.kind;
		const { closes: _c, supersedes: _s, from: _f, step: _step, ...base } = w;
		const closes = move(r?.closes === undefined ? w.closes : r.closes ?? undefined);
		const supersedes = move(w.supersedes), from = move(r?.from === undefined ? w.from : r.from ?? undefined);
		// A direction kind keeps the tier it had: one recorded without a user turn stays a step.
		const step = !STEP_KINDS.has(kind) && w.step === true;
		copies.push({ ...base, id: newId.get(w.id)!, kind, ...(r?.title ? { title: r.title } : {}), by: "mom",
			...(closes ? { closes } : {}), ...(supersedes ? { supersedes } : {}), ...(from ? { from } : {}), ...(step ? { step: true as const } : {}) });
	}
	const strikes = [...[...dropped].map(target => ({ target, reason: wanted.get(target)!.drop! })),
		...[...copied].map(target => ({ target, reason: `revised as ${newId.get(target)}` }))];
	const titles = [...wanted.values()].filter(r => r.title && !copied.has(r.id) && !dropped.has(r.id)).map(r => ({ id: r.id, title: flatten(r.title!) }));
	return { defects, titles, strikes, copies };
}
