/**
 * Mom's trail: an append-only index into the session transcript. A waypoint is a short caption plus the
 * transcript entries it points at; the transcript stays the authority. See docs/trail.md.
 *
 * This module is the shared contract between the Oven-side writer (src/mom/mom-tools.ts), the store
 * (src/trail/store.ts), the projections (src/trail/projection.ts) and the lead's client. It has no
 * dependencies beyond typebox so every side can import it.
 */
import { Type, type Static } from "typebox";
import { Check, Errors } from "typebox/value";

export const WAYPOINT_KINDS = ["set_out", "detour", "returned", "learned", "decided", "dead_end", "reframed", "open", "closed"] as const;
export type WaypointKind = typeof WAYPOINT_KINDS[number];

export const CAPTION_CHARS = 240;
export const LINE_CHARS = 80;

/** Kinds that are never waypoints: what happened along the way, kept as steps for the detail page. */
export const STEP_KINDS: ReadonlySet<WaypointKind> = new Set(["learned", "dead_end"]);

const kind = Type.Union(WAYPOINT_KINDS.map(value => Type.Literal(value)), { description: "Waypoints, each citing the user turn that made it: set_out: the goal the user set (opens a line). detour: the user turned to something else (opens a line). returned: the user came back from a detour (closes it). decided: the user's choice and its reason. reframed: the user changed a line's goal (supersedes its set_out). open: something the user parked for later. closed: an open the user finished or dropped (closes it). Steps, shown only in the detail page: learned: a finding with evidence. dead_end: an attempt that failed, and why." });

/** What the model supplies for one waypoint. The host adds id, sessionId, at, parent and by. */
export const WaypointInput = Type.Object({
	kind,
	line: Type.String({ minLength: 1, maxLength: LINE_CHARS, description: "The thread of the journey this belongs to. Reuse an existing line name exactly; a set_out or detour names a new line." }),
	refs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 8, description: "Evidence ids exactly as supplied in [src:…]. The transcript entries this waypoint points at." }),
	caption: Type.String({ minLength: 1, maxLength: CAPTION_CHARS, description: "One or two sentences in your own words. Never a quote; the transcript holds the quote." }),
	closes: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: "Id of the earlier open (for closed/dead_end) or detour (for returned) this resolves." })),
	supersedes: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: "Id of the earlier waypoint this replaces as the current belief or goal." })),
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
	closes?: string;
	supersedes?: string;
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
 * attempt) or a direction Mom saw without a user turn behind it. Steps appear only in the detail page; the
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

export type TrailRecord = ({ type: "waypoint" } & Waypoint) | ({ type: "strike" } & Strike);

/** A branch's trail as the projections read it: waypoints in transcript order (see trailFor), struck ones removed. */
export interface Trail {
	waypoints: Waypoint[];
	/** Waypoints and steps together in transcript order, for the detail page; absent means there are no steps. */
	entries?: Waypoint[];
	/** Struck waypoints, kept for the log and for `/mom strike` undo decisions. */
	struck: { waypoint: Waypoint; strike: Strike }[];
}

export const emptyTrail = (): Trail => ({ waypoints: [], struck: [] });
export const trailEntries = (trail: Trail): Waypoint[] => trail.entries ?? trail.waypoints;

/** The finalizer's whole argument. An empty list means nothing worth finding again happened. */
export const RecordWaypoints = Type.Object({ waypoints: Type.Array(WaypointInput, { maxItems: 24 }) }, { additionalProperties: false });
export type RecordWaypoints = Static<typeof RecordWaypoints>;

const trim = (value: string) => value.replace(/\s+/g, " ").trim();

/**
 * Structural validation of one commit against what is known. Returns the normalized inputs or a list
 * of defects naming the item. Never judges prose.
 *
 * - every ref must be observed (callers repair near-misses before calling this);
 * - closes/supersedes must name an existing waypoint on this trail or an earlier item in this commit;
 * - returned.closes → a detour; closed.closes → an open; dead_end.closes → an open.
 */
export function validateWaypointInputs(value: unknown, existing: readonly Pick<Waypoint, "id" | "kind">[], observed: ReadonlySet<string>,
	idFor: (index: number) => string): { inputs: WaypointInput[]; defects: string[] } {
	const defects: string[] = [];
	if (!Check(RecordWaypoints, value)) {
		for (const error of Errors(RecordWaypoints, value).slice(0, 6)) defects.push(`${error.instancePath || "(root)"}: ${error.message}`);
		return { inputs: [], defects };
	}
	const kinds = new Map<string, WaypointKind>(existing.map(item => [item.id, item.kind]));
	const inputs: WaypointInput[] = [];
	value.waypoints.forEach((raw, index) => {
		const where = `waypoints[${index}]`;
		const item: WaypointInput = { ...raw, line: trim(raw.line), caption: trim(raw.caption), refs: raw.refs.map(trim) };
		if (item.closes === null) delete item.closes;
		if (item.supersedes === null) delete item.supersedes;
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
		kinds.set(idFor(index), item.kind);
		inputs.push(item);
	});
	return { inputs, defects };
}

/** Lines are matched case-insensitively after whitespace normalization. */
export const lineKey = (line: string): string => trim(line).toLocaleLowerCase();

/**
 * Sorts one call's items into tiers by structure, never by caption. A waypoint is a direction kind that cites a
 * user turn. Everything else is a step: learned and dead_end always, and a direction kind citing no user turn
 * (assistant activity: tool calls, searches, summaries, retries). Steps keep no links. A waypoint that closes an
 * item filed as a step in this call is a step too, since what it closed is not on the trail; one that supersedes
 * such an item just loses the link. Indexes are the call's, so a retry writes the same ids.
 */
export function sortTiers(inputs: readonly WaypointInput[], idFor: (index: number) => string, isUserTurn: (ref: string) => boolean):
	{ waypoints: { index: number; input: WaypointInput }[]; steps: { index: number; input: WaypointInput }[] } {
	const stepIds = new Set<string>(), waypoints: { index: number; input: WaypointInput }[] = [], steps: { index: number; input: WaypointInput }[] = [];
	inputs.forEach((input, index) => {
		const step = STEP_KINDS.has(input.kind) || !input.refs.some(isUserTurn) || (input.closes != null && stepIds.has(input.closes));
		if (step) {
			const { closes: _closes, supersedes: _supersedes, ...bare } = input;
			stepIds.add(idFor(index));
			steps.push({ index, input: bare });
			return;
		}
		const kept = { ...input };
		if (kept.supersedes != null && stepIds.has(kept.supersedes)) delete kept.supersedes;
		waypoints.push({ index, input: kept });
	});
	return { waypoints, steps };
}
