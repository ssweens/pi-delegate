/**
 * Path's trail: an append-only index into the session transcript. A waypoint is a short caption plus the
 * transcript entries it points at; the transcript stays the authority. See docs/trail.md.
 *
 * This module is the shared contract between the Oven-side writer (src/mom/mom-tools.ts), the store
 * (src/trail/store.ts), the projections (src/trail/projection.ts) and the lead's client. It has no
 * dependencies beyond typebox so every side can import it.
 */
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";
import { clipText, flatten } from "../util/text.ts";

export const WAYPOINT_KINDS = ["set_out", "detour", "returned", "learned", "decided", "dead_end", "reframed", "open", "closed"] as const;
export type WaypointKind = typeof WAYPOINT_KINDS[number];

export const CAPTION_CHARS = 240;
export const LINE_CHARS = 80;
export const TITLE_CHARS = 40;

/** Kinds that are never waypoints: what happened along the way, kept as steps for the detail page. */
export const STEP_KINDS: ReadonlySet<WaypointKind> = new Set(["learned", "dead_end"]);

const kind = Type.Union(WAYPOINT_KINDS.map(value => Type.Literal(value)), { description: "Waypoints, each citing the user turn that made it: set_out: the goal the user set (opens a line). detour: the user turned to something else (opens a line). returned: the user came back from a detour (closes it). decided: the user's choice and its reason. reframed: the user changed a line's goal (supersedes its set_out). open: something the user parked for later. closed: an open the user finished or dropped (closes it). Steps, shown only in the detail page: learned: a finding with evidence. dead_end: an attempt that failed, and why." });

/** What the model supplies for one waypoint. The host adds id, sessionId, at, parent and by. */
export const WaypointInput = Type.Object({
	kind,
	line: Type.String({ minLength: 1, maxLength: LINE_CHARS, description: "The thread of the journey this belongs to. Reuse an existing line name exactly; a set_out or detour names a new line." }),
	refs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 8, description: "Evidence ids exactly as supplied in [src:…]. The transcript entries this waypoint points at." }),
	caption: Type.String({ minLength: 1, maxLength: CAPTION_CHARS, description: "One or two sentences in your own words. Never a quote; the transcript holds the quote." }),
	title: Type.Optional(Type.String({ minLength: 1, maxLength: TITLE_CHARS, description: "Two to five words naming it, the label the widget shows: \"OSC 7501 done signal\", \"/bgfork and @@ shortcuts\". A label, not a sentence." })),
	closes: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: "Id of the earlier open (for closed/dead_end) or detour (for returned) this resolves." })),
	supersedes: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: "Id of the earlier waypoint this replaces as the current belief or goal." })),
	from: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: "Id of the trail entry (waypoint or step) or earlier item in this call that led to this: the finding, dead end or decision that prompted it. Give it for a set_out, detour, reframed or open whenever one did." })),
}, { additionalProperties: false });
export type WaypointInput = Static<typeof WaypointInput>;

export interface Waypoint {
	id: string;
	sessionId: string;
	at: number;
	kind: WaypointKind;
	line: string;
	refs: string[];
	caption: string;
	/** Two to five words for glance surfaces; older records lack it and show `label` of the caption. */
	title?: string;
	closes?: string;
	supersedes?: string;
	/** The entry (waypoint or step) that led to this one: what prompted a goal, a detour or an open item. */
	from?: string;
	/** Lead-session transcript entry id this waypoint belongs to. Orders the trail when history is backfilled out of file order; absent, refs decide. */
	anchor?: string;
	/** Lead branch leaf when recorded; a waypoint recorded off the selected branch is not part of its trail. */
	parent: string | null;
	by: "mom" | "user";
	/** Filed as a step: a direction kind recorded without a user turn behind it. */
	step?: true;
}

/**
 * Two tiers. A waypoint is where the user steered; a step is what happened along the way (a finding, a failed
 * attempt) or a direction Path saw without a user turn behind it. Steps appear only in the detail page; the
 * widget, the lead's standing and every projection read waypoints. A waypoint the user marked stays one.
 */
export const isStep = (w: Pick<Waypoint, "kind" | "by" | "step">): boolean => w.by !== "user" && (w.step === true || STEP_KINDS.has(w.kind));

export interface Strike {
	id: string;
	sessionId: string;
	at: number;
	/** The waypoint struck. */
	target: string;
	reason?: string;
	parent: string | null;
}

/** A title given later to a waypoint (a refresh). The latest for a target wins over its own; the waypoint is unchanged. */
export interface Retitle {
	id: string;
	sessionId: string;
	at: number;
	target: string;
	title: string;
	parent: string | null;
}

export type TrailRecord = ({ type: "waypoint" } & Waypoint) | ({ type: "strike" } & Strike) | ({ type: "title" } & Retitle);

/** A branch's trail as the projections read it: waypoints in transcript order (see trailFor), struck ones removed. */
export interface Trail {
	waypoints: Waypoint[];
	/** Waypoints and steps together in transcript order, for the detail page; absent means there are no steps. */
	entries?: Waypoint[];
	/** Struck waypoints: what a refresh replaced or dropped, kept for the log. */
	struck: { waypoint: Waypoint; strike: Strike }[];
}

export const emptyTrail = (): Trail => ({ waypoints: [], struck: [] });
export const trailEntries = (trail: Trail): Waypoint[] => trail.entries ?? trail.waypoints;

/** The finalizer's whole argument. An empty list means nothing worth finding again happened. */
/** One revision of an existing entry in a refresh (src/trail/repair.ts applies it). */
export const Revision = Type.Object({
	id: Type.String({ minLength: 1, description: "Id of the trail entry to revise (trail.entries)." }),
	title: Type.Optional(Type.String({ minLength: 1, maxLength: TITLE_CHARS, description: "Its title: two to five words naming the task or thing." })),
	kind: Type.Optional(kind),
	from: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: "Id of the entry that led to it; null removes the link." })),
	closes: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: "Id of the open item or detour it ends; null removes the link." })),
	drop: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "Why it is not worth finding again; drops it from the trail." })),
}, { additionalProperties: false });
// The kind union is built from WAYPOINT_KINDS at runtime, which Static cannot see through; name it here.
export type Revision = Omit<Static<typeof Revision>, "kind"> & { kind?: WaypointKind };

const TitleInput = Type.Object({
	id: Type.String({ minLength: 1, description: "Id of a trail waypoint you were shown without a title." }),
	title: Type.String({ minLength: 1, maxLength: TITLE_CHARS, description: "Two to five words naming it." }),
}, { additionalProperties: false });
export const RecordWaypoints = Type.Object({
	waypoints: Type.Array(WaypointInput, { maxItems: 24 }),
	titles: Type.Optional(Type.Array(TitleInput, { maxItems: 40, description: "Titles for trail waypoints you were shown without one (trail.untitled). Optional." })),
	revise: Type.Optional(Type.Array(Revision, { maxItems: 200, description: "Refresh only: revisions of existing trail entries (trail.entries). Leave out in every other operation." })),
}, { additionalProperties: false });
export type RecordWaypoints = Static<typeof RecordWaypoints>;

/**
 * Structural validation of one commit against what is known. Returns the normalized inputs or a list
 * of defects naming the item. Never judges prose.
 *
 * - every ref must be observed (callers repair near-misses before calling this);
 * - closes/supersedes must name an existing waypoint on this trail or an earlier item in this commit;
 * - returned.closes → a detour; closed.closes → an open; dead_end.closes → an open.
 */
export function validateWaypointInputs(value: unknown, existing: readonly Pick<Waypoint, "id" | "kind">[], observed: ReadonlySet<string>,
	idFor: (index: number) => string): { inputs: WaypointInput[]; titles: { id: string; title: string }[]; defects: string[] } {
	const defects: string[] = [];
	if (!Check(RecordWaypoints, value)) {
		for (const error of Errors(RecordWaypoints, value).slice(0, 6)) defects.push(`${error.instancePath || "(root)"}: ${error.message}`);
		return { inputs: [], titles: [], defects };
	}
	// A title for an id the trail does not hold is dropped, not a defect: the waypoints are what the call is for.
	const known = new Set(existing.map(item => item.id));
	const titles = (value.titles ?? []).map(item => ({ id: item.id, title: flatten(item.title) })).filter(item => item.title && known.has(item.id));
	const kinds = new Map<string, WaypointKind>(existing.map(item => [item.id, item.kind]));
	const inputs: WaypointInput[] = [];
	value.waypoints.forEach((raw, index) => {
		const where = `waypoints[${index}]`;
		const item: WaypointInput = { ...raw, line: flatten(raw.line), caption: flatten(raw.caption), refs: raw.refs.map(flatten) };
		if (item.title !== undefined) item.title = flatten(item.title) || undefined;
		if (item.title === undefined) delete item.title;
		if (item.closes === null) delete item.closes;
		if (item.supersedes === null) delete item.supersedes;
		if (item.from === null) delete item.from;
		// `#n` names item n of this call, whose id the model cannot know.
		for (const field of ["closes", "supersedes", "from"] as const) {
			const local = typeof item[field] === "string" ? /^#(\d+)$/.exec(item[field] as string) : null;
			if (!local) continue;
			if (Number(local[1]) < index) item[field] = idFor(Number(local[1]));
			else defects.push(`${where}.${field} ${item[field]} must name an earlier item of this call`);
		}
		if (!item.line) defects.push(`${where}.line is empty`);
		if (!item.caption) defects.push(`${where}.caption is empty`);
		if (item.line.length > LINE_CHARS) defects.push(`${where}.line exceeds ${LINE_CHARS} characters`);
		for (const ref of item.refs) if (!observed.has(ref)) defects.push(`${where} cites unobserved source ${ref}`);
		if (new Set(item.refs).size !== item.refs.length) defects.push(`${where} repeats a source`);
		const link = (field: "closes" | "supersedes") => {
			const target = item[field];
			if (target === undefined || target === null) return;
			const targetKind = kinds.get(target);
			if (!targetKind) { defects.push(`${where}.${field} names unknown waypoint ${target}`); return; }
			if (field === "closes") {
				const wanted: WaypointKind[] = item.kind === "returned" ? ["detour"] : item.kind === "closed" || item.kind === "dead_end" ? ["open"] : [];
				if (!wanted.length) defects.push(`${where}: a ${item.kind} does not close anything; omit closes`);
				else if (!wanted.includes(targetKind)) defects.push(`${where}.closes must name ${wanted.join(" or ")}, not ${targetKind} ${target}`);
			}
		};
		link("closes"); link("supersedes");
		if (item.from !== undefined && !kinds.has(item.from)) defects.push(`${where}.from names unknown entry ${item.from}`);
		kinds.set(idFor(index), item.kind);
		inputs.push(item);
	});
	return { inputs, titles, defects };
}

/**
 * The short form glance surfaces show: the title; for a record written before titles existed, a set_out's or detour's
 * line name (it names that thread), else the caption's first clause cut at a word. The caption stays in the detail page.
 */
export function label(w: Pick<Waypoint, "title" | "caption" | "kind" | "line">): string {
	if (w.title) return w.title;
	if (w.kind === "set_out" || w.kind === "detour") return w.line;
	const clause = flatten(w.caption).split(/(?:[:;]\s|\s[—–-]\s|,\s|\.\s|\s\()/)[0]!.replace(/[.!?]$/, "");
	return clipText(clause, FALLBACK_CHARS, { words: true });
}
const FALLBACK_CHARS = 30;

/** Lines are matched case-insensitively after whitespace normalization. */
export const lineKey = (line: string): string => flatten(line).toLocaleLowerCase();

/**
 * Sorts one call's items into tiers by structure, never by caption. A waypoint is a direction kind that cites a
 * user turn. Everything else is a step: learned and dead_end always, and a direction kind citing no user turn
 * (assistant activity: tool calls, searches, summaries, retries). A step keeps its `from` and a `closes` that names
 * an entry already on the trail (a finding that answers a parked question does close it); its other links are
 * dropped. A waypoint that closes an item filed as a step in this call is a step too, since what it closed is not on
 * the trail; one that supersedes such an item just loses the link. Indexes are the call's, so a retry writes the same ids.
 */
export function sortTiers(inputs: readonly WaypointInput[], idFor: (index: number) => string, isUserTurn: (ref: string) => boolean):
	{ waypoints: { index: number; input: WaypointInput }[]; steps: { index: number; input: WaypointInput }[] } {
	const callIds = new Set(inputs.map((_, index) => idFor(index)));
	const stepIds = new Set<string>(), waypoints: { index: number; input: WaypointInput }[] = [], steps: { index: number; input: WaypointInput }[] = [];
	inputs.forEach((input, index) => {
		const step = STEP_KINDS.has(input.kind) || !input.refs.some(isUserTurn) || (input.closes != null && stepIds.has(input.closes));
		if (step) {
			const { closes, supersedes: _supersedes, ...bare } = input;
			stepIds.add(idFor(index));
			steps.push({ index, input: closes != null && !callIds.has(closes) ? { ...bare, closes } : bare });
			return;
		}
		const kept = { ...input };
		if (kept.supersedes != null && stepIds.has(kept.supersedes)) delete kept.supersedes;
		waypoints.push({ index, input: kept });
	});
	return { waypoints, steps };
}
