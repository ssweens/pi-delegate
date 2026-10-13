/**
 * What one record_waypoints answer does to the trail: check it against the session and the trail as they are,
 * then append its waypoints and steps, titles and revisions to `session.trail`. The watcher (src/trail/watcher.ts)
 * calls it; nothing else writes the trail's model records.
 */
import { currentSession } from "../mom/session-file.ts";
import { makeRef, parseRef } from "../util/ref.ts";
import { clipText, flatten, textOf } from "../util/text.ts";
import { planRepair } from "./repair.ts";
import { TrailStore, trailFor } from "./store.ts";
import { sortTiers, STEP_KINDS, trailEntries, validateWaypointInputs, type Revision, type Waypoint } from "./types.ts";

export interface RecordTarget {
	/** The lead's session file. */
	session: string;
	/** Names this answer's records (`<job>:w<n>`, `:t<n>`, `:r<n>`, `:s<n>`), so a replayed answer writes nothing twice. */
	job: string;
}

/** The lead's entries on its current branch, by evidence ref: when each was written and whether it is the user's. */
function sessionEntries(file: string) {
	const reader = currentSession(file);
	const sessionId = reader.getSessionId(), branch = reader.getBranch();
	const entries = new Map(branch.map(entry => [makeRef(sessionId, entry.id), {
		id: entry.id, at: Date.parse(String((entry as any).timestamp ?? "")),
		user: entry.type === "message" && (entry as any).message?.role === "user",
		text: entry.type === "message" && (entry as any).message?.role === "user" ? textOf((entry as any).message.content) : undefined,
	}]));
	return { sessionId, leaf: reader.getLeafId(), branch: new Set(branch.map(entry => entry.id)), entries };
}

/** A cited entry as the watcher read it (`3016e383`) or as a full ref (`<session>:3016e383`), as a ref. */
const refOf = (sessionId: string, cited: unknown) => typeof cited !== "string" ? cited : parseRef(cited) ? cited : makeRef(sessionId, cited);

/**
 * Record one answer. Returns what the watcher is told: the ids it may link to later, or every defect (nothing is
 * written when there is one).
 */
export async function recordWaypoints(args: Record<string, unknown>, target: RecordTarget): Promise<{ text: string; isError?: boolean }> {
	const { sessionId, leaf, branch, entries } = sessionEntries(target.session);
	const value: Record<string, unknown> = { ...args, waypoints: Array.isArray(args.waypoints) ? args.waypoints.map(item => !item || typeof item !== "object" || !Array.isArray((item as any).refs) ? item
		: { ...item, refs: (item as { refs: unknown[] }).refs.map(ref => refOf(sessionId, ref)) }) : args.waypoints };
	const store = new TrailStore(() => target.session, sessionId);
	const existing = trailFor(await store.load(), branch);
	const idFor = (index: number) => `${target.job}:w${index}`;
	const { inputs, titles, defects } = validateWaypointInputs(value, trailEntries(existing), new Set(entries.keys()), idFor);
	const revisions = Array.isArray(value.revise) ? value.revise as Revision[] : [];
	const repair = revisions.length ? planRepair(existing, revisions, index => `${target.job}:r${index}`) : undefined;
	if (repair) defects.push(...repair.defects);
	if (defects.length) return { text: `Nothing was saved. Fix every defect and call record_waypoints again: ${defects.join(" ")}`, isError: true };
	// Waypoints are where the user steered; the rest are steps for the detail page.
	const isUserTurn = (ref: string) => Boolean(entries.get(ref)?.user);
	const tiers = sortTiers(inputs, idFor, isUserTurn);
	// The same moment is never written twice: an item of the same kind citing a source the trail already holds is that entry.
	const held = trailEntries(existing), alias = new Map<string, string>();
	inputs.forEach((input, index) => {
		const same = held.find(entry => entry.kind === input.kind && entry.refs.some(ref => input.refs.includes(ref)));
		if (same) alias.set(idFor(index), same.id);
	});
	const relink = (id: string | null | undefined) => id == null ? undefined : alias.get(id) ?? id;
	// Where it sits and when it happened: the user turn it cites, else its first source.
	const anchorOf = (refs: readonly string[]) => entries.get(refs.find(isUserTurn) ?? refs[0]!)?.id;
	const recorded = Date.now(), atOf = (refs: readonly string[]) => {
		const time = entries.get(refs.find(isUserTurn) ?? refs[0]!)?.at;
		return time !== undefined && Number.isFinite(time) ? time : recorded;
	};
	const written: Waypoint[] = [];
	const all = [...tiers.waypoints.map(item => ({ ...item, step: false })), ...tiers.steps.map(item => ({ ...item, step: true }))]
		.filter(item => !alias.has(idFor(item.index))).sort((a, b) => a.index - b.index);
	for (const { index, input, step } of all) {
		const closes = relink(input.closes), supersedes = relink(input.supersedes), from = relink(input.from), anchor = anchorOf(input.refs);
		const waypoint: Waypoint = { id: idFor(index), sessionId, at: atOf(input.refs), kind: input.kind, line: input.line, refs: input.refs, caption: input.caption,
			...(input.title ? { title: input.title } : {}), ...(from ? { from } : {}),
			...(closes ? { closes } : {}), ...(supersedes ? { supersedes } : {}), ...(anchor ? { anchor } : {}), parent: leaf, by: "mom",
			...(step && !STEP_KINDS.has(input.kind) ? { step: true as const } : {}) };
		written.push(await store.appendWaypoint(waypoint));
	}
	for (const [index, item] of [...titles, ...(repair?.titles ?? [])].entries())
		await store.appendTitle({ id: `${target.job}:t${index}`, sessionId, at: recorded, target: item.id, title: item.title, parent: leaf });
	// A revision's copy first, then the strike of what it replaces: a crash between leaves both, never neither.
	for (const copy of repair?.copies ?? []) await store.appendWaypoint({ ...copy, parent: copy.parent ?? leaf });
	for (const [index, item] of (repair?.strikes ?? []).entries())
		await store.appendStrike({ id: `${target.job}:s${index}`, sessionId, at: recorded, target: item.target, reason: item.reason, parent: leaf });
	const saved = written.map(w => `${w.id} ${w.kind}${w.step ? " (step)" : ""} "${w.title ?? w.caption}"`);
	const revised = repair ? repair.copies.length + repair.strikes.length + repair.titles.length : 0;
	return { text: [saved.length ? `Saved:\n${saved.join("\n")}` : "Nothing new saved.",
		alias.size ? `${alias.size} already on the trail, not repeated.` : "", revised ? `${revised} revision${revised === 1 ? "" : "s"} applied.` : "",
		"Use these ids in closes, supersedes and from."].filter(Boolean).join("\n") };
}

/** The trail as the watcher is briefed with it: every entry's id, kind, line, title, caption and links; a goal with the user's words. */
export async function trailBriefing(session: string): Promise<string> {
	const { sessionId, branch, entries } = sessionEntries(session);
	const trail = trailFor(await new TrailStore(() => session, sessionId).load(), branch);
	const said = (w: Waypoint) => ["set_out", "detour", "reframed"].includes(w.kind) ? w.refs.map(ref => entries.get(ref)?.text).find(Boolean) : undefined;
	const rows = trailEntries(trail).map(w => JSON.stringify({ id: w.id, kind: w.kind, line: w.line, ...(w.title ? { title: w.title } : {}), caption: w.caption,
		...(said(w) ? { said: clipText(flatten(said(w)!), 400, { words: true }) } : {}),
		...(w.from ? { from: w.from } : {}), ...(w.closes ? { closes: w.closes } : {}), ...(w.supersedes ? { supersedes: w.supersedes } : {}),
		...(w.step || STEP_KINDS.has(w.kind) ? { step: true } : {}) }));
	return rows.length ? `The trail so far, oldest first:\n${rows.join("\n")}` : "The trail is empty so far.";
}

