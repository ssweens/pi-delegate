// Candidate contract v2 — explicit changes. The model-facing finalizer: DECIDE_PROMPT, the
// commit_changes tool, acceptChanges validation, and resolveChange derivation. Types live in
// candidate.ts; provenance stamping in provenance.ts; nothing here touches the graph or mother.ts.
//
// Design: the host enumerates candidates deterministically from (saved graph, current events). The
// model emits only the changes this turn truly makes — one entry per meaningful change, each naming
// a candidate and its final kind. Omission is never a state action. Every structural target/source
// check below is host verification of shape, never proof that the underlying claim is true.
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import type { FeedEvent } from "./feed.ts";
import { ALLOWED_KINDS, CANDIDATE_LIMIT, QUOTE_LIMIT, type Candidate, type CandidateKind, type Change, type ChangeState, type ModelResponse, type NodeState, type Proposed } from "./candidate.ts";
import { sourceRole } from "./provenance.ts";
import { isEndeavor, type GraphNode } from "./graph.ts";

/** Model-facing instructions. Mechanical invariants (source/target validity, extra fields, length
 *  limits, duplicate/conflict detection, parent/focus checks) live in acceptChanges, never here. */
export const DECIDE_PROMPT = `The saved map is the starting state, not authority over new user directions. Omitted work and notes persist unchanged. Output only meaningful changes, using current candidates as evidence.

new_work: a new user request, including a question to answer. Make each distinct request visible. For assent, use the preceding offer to name the precise work accepted, not just "Yes"; it authorizes nothing else. Assistant next steps are not user requests.

rule: a user requirement about how work is done OR what the artifact must contain. An artifact's requested structure is a requirement, not an ordinary note. A correction to an existing rule replaces it: use rule or note_supersede with on naming that rule.

status_change: set on to saved work and state to active, parked, or settled. A user pivot parks displaced work. A scope correction reopens affected settled verification. Settle only from current completion evidence, never a proposal, pending approval, or an old saved outcome. A final lead assistant report can settle an endeavor, not park/reopen work or retire rules. A tool receipt is not completion evidence.

note_add: a direct answer, correction, or finding worth returning to. note_supersede: replace an earlier saved annotation, never work. suggestion: an assistant proposal awaiting a user decision, never an active rule. Omit restatement and explanation that changes nothing.

text supplies the wording to save; otherwise the candidate quote is saved. on is the saved target or new-work candidate this belongs to. focus is the latest requested work, using its new-work candidate id when creating it.

No inspection or roll call: no tools, nothing to inspect. Source checks prove provenance, not that a claim is true.`;

const object = { additionalProperties: false } as const;
const CHANGE_FIELDS = new Set(["candidate_id", "kind", "on", "text", "state"]);
const KINDS = ["new_work", "status_change", "rule", "suggestion", "note_add", "note_supersede"] as const;
const ChangeSchema = Type.Object({
	candidate_id: Type.String({ minLength: 1, description: "Current evidence candidate, such as c01; not a saved node or source ref." }),
	kind: Type.Union(KINDS.map(kind => Type.Literal(kind))),
	on: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Saved node or candidate this lands on; omit when unattached." })),
	// Strict providers encode optional fields as null.
	text: Type.Optional(Type.Union([Type.String({ maxLength: QUOTE_LIMIT }), Type.Null()], { description: "Exact wording to save; defaults to the candidate quote." })),
	state: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("parked"), Type.Literal("settled"), Type.Null()], { description: "Required for status_change only." })),
}, object);
const ModelResponseSchema = Type.Object({
	changes: Type.Array(ChangeSchema, { maxItems: CANDIDATE_LIMIT, description: "Only the meaningful changes; omission persists the saved map." }),
	focus: Type.String({ minLength: 1, description: "Saved endeavor or selected new-work candidate." }),
}, object);

export function decideTool(): Tool {
	return { name: "commit_changes", description: "Commit only the meaningful changes of this turn: one entry per change (candidate_id, kind, and kind-specific on/text/state) plus the focus id. Omitted work and notes persist.",
		constrainedSampling: { type: "json_schema", strict: "prefer" }, parameters: ModelResponseSchema };
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
// Small models sometimes spell an absent optional field as the string "null" or ""; read as absent.
const absent = (value: unknown): unknown => value === "null" || value === "" ? null : value;

export interface SavedNode { state: NodeState; parent: string | null; endeavor: boolean; kind: GraphNode["kind"] }
/** A validation-side projection of a saved graph; no graph behavior is duplicated here. */
export const indexSavedNodes = (graph: { nodes: readonly Pick<GraphNode, "id" | "kind" | "parent" | "state">[] }): ReadonlyMap<string, SavedNode> =>
	new Map(graph.nodes.map(node => [node.id, { state: node.state, parent: node.parent, endeavor: isEndeavor(node), kind: node.kind }]));
const annotation = (node: SavedNode | undefined): node is SavedNode => !!node && !node.endeavor;

/** Normalize an effective change into its canonical write shape. A note_supersede of a saved rule
 *  and a rule update of that same rule are one canonical replacement, so they share a form for
 *  duplicate/conflict detection and for matching equivalent expectations without dropping scope. */
export function canonicalEffect(effect: Pick<Candidate, "kind" | "prior_ref" | "proposed">, saved: ReadonlyMap<string, SavedNode>): Pick<Candidate, "kind" | "prior_ref" | "proposed"> {
	// Always a fresh three-field object: never the input reference, so ids/extra fields cannot leak
	// into stability or duplicate keys.
	const base = { kind: effect.kind, prior_ref: effect.prior_ref, proposed: effect.proposed };
	if (effect.kind !== "note_supersede") return base;
	const node = effect.prior_ref ? saved.get(effect.prior_ref) : undefined;
	if (!node || node.kind !== "rule") return base;
	return { kind: "rule", prior_ref: effect.prior_ref, proposed: { scope: node.parent ?? "root" } };
}

/** The effective candidate shape one change resolves to, before text/parent are attached. Shared by
 *  validation (write keys) and resolveChange so the two cannot disagree. */
function effectiveCandidate(candidate: Candidate, change: Change, saved: ReadonlyMap<string, SavedNode>): Pick<Candidate, "kind" | "prior_ref" | "proposed"> {
	const on = change.on ?? null;
	switch (change.kind) {
		case "new_work": return { kind: "new_work", prior_ref: null, proposed: null };
		case "rule": case "suggestion": {
			const node = on ? saved.get(on) : undefined;
			if (!node) return { kind: change.kind, prior_ref: null, proposed: { scope: on ?? "root" } };
			if (node.endeavor) return { kind: change.kind, prior_ref: null, proposed: { scope: on! } };
			// A rule scopes within a saved note's parent endeavor. A suggestion may never target a
			// saved rule (rejected in validation), so this branch is rule-only for rule targets.
			return { kind: change.kind, prior_ref: on, proposed: { scope: node.parent ?? "root" } };
		}
		case "note_add": return { kind: "note_add", prior_ref: on ?? candidate.prior_ref, proposed: null };
		case "note_supersede": return { kind: "note_supersede", prior_ref: on, proposed: { replaces: on! } };
		case "status_change": {
			const node = on ? saved.get(on) : undefined;
			return { kind: "status_change", prior_ref: on, proposed: { from: node?.state ?? "active", to: change.state! } };
		}
	}
}

/** Write key for duplicate/conflicting-write detection, or null for additive effects. Derived from
 *  the canonical form so a rule update and a rule note_supersede collide on the same target. */
function writeKey(effect: Pick<Candidate, "kind" | "prior_ref" | "proposed">, saved: ReadonlyMap<string, SavedNode>): string | null {
	const canonical = canonicalEffect(effect, saved);
	switch (canonical.kind) {
		case "status_change": return canonical.prior_ref ? `status:${canonical.prior_ref}` : null;
		case "rule": return canonical.prior_ref && annotation(saved.get(canonical.prior_ref)) ? `annotation:${canonical.prior_ref}` : null;
		case "note_supersede": return canonical.prior_ref ? `annotation:${canonical.prior_ref}` : null;
		default: return null;
	}
}

export interface Resolved { candidate: Candidate; text: string | null; parent: string | null }

/** Validate one model response against the prepared candidates and the current update's events.
 *  Returns the validated changes plus repairs, or the named defects (whole response rejected). */
export function acceptChanges(
	value: unknown,
	candidates: readonly Candidate[],
	saved: ReadonlyMap<string, SavedNode>,
	current: ReadonlyMap<string, FeedEvent>,
): { response: ModelResponse; repairs: string[] } | { defects: string[] } {
	const defects: string[] = [], repairs: string[] = [];
	if (!record(value) || !Array.isArray(value.changes) || typeof value.focus !== "string")
		return { defects: ["commit_changes needs changes (array) and focus (string)."] };
	if (value.changes.length > CANDIDATE_LIMIT) return { defects: [`Too many changes: maximum ${CANDIDATE_LIMIT}.`] };
	// Unexpected top-level fields reject the whole response.
	const extraTop = Object.keys(value).filter(key => key !== "changes" && key !== "focus");
	if (extraTop.length) return { defects: [`commit_changes carries unsupported field ${extraTop.join(", ")}.`] };
	const byId = new Map(candidates.map(candidate => [candidate.id, candidate]));
	const dedup = new Map<string, string>(), writeKeys = new Map<string, string>();
	const newWorkParent = new Map<string, string | null>(), newWorkSeen = new Set<string>();
	const changes: Change[] = [];

	for (const [index, entry] of (value.changes as unknown[]).entries()) {
		if (!record(entry)) { defects.push(`Change ${index + 1} is not an object.`); continue; }
		const id = entry.candidate_id;
		const extra = Object.keys(entry).filter(key => !CHANGE_FIELDS.has(key));
		if (extra.length) defects.push(`Change ${typeof id === "string" && id ? id : `${index + 1}`} carries unsupported field ${extra.join(", ")}.`);
		if (typeof id !== "string" || !id) { defects.push(`Change ${index + 1} has no candidate_id.`); continue; }
		const candidate = byId.get(id);
		if (!candidate) { defects.push(`Unknown candidate ${id}.`); continue; }
		// Source must be a current event whose stamped role matches. The antecedent is context only.
		const event = current.get(candidate.source);
		if (!event) { defects.push(`Candidate ${id} cites source ${candidate.source} that is not in the current update.`); continue; }
		if (sourceRole(event) !== candidate.source_role) { defects.push(`Candidate ${id} source role mismatch: stamped ${candidate.source_role}, event is ${sourceRole(event)}.`); continue; }
		const kind = entry.kind as CandidateKind | undefined;
		if (typeof kind !== "string" || !KINDS.includes(kind)) { defects.push(`Change ${id} has invalid kind ${JSON.stringify(entry.kind)}.`); continue; }
		if (!ALLOWED_KINDS[candidate.source_role].includes(kind)) { defects.push(`Change ${id} (${candidate.source_role}) cannot be ${kind}; allowed: ${ALLOWED_KINDS[candidate.source_role].join(", ")}.`); continue; }
		const on = absent(entry.on);
		if (on !== undefined && on !== null && typeof on !== "string") { defects.push(`Change ${id} has an invalid on.`); continue; }
		const rawText = entry.text;
		if (rawText !== undefined && rawText !== null && typeof rawText !== "string") { defects.push(`Change ${id} has invalid text.`); continue; }
		// Over-long wording is trimmed at a word boundary and recorded; the change itself is clear.
		const text = typeof rawText === "string" && rawText.length > QUOTE_LIMIT ? rawText.slice(0, QUOTE_LIMIT).replace(/\s+\S*$/, "").trimEnd() : rawText;
		if (text !== rawText) repairs.push(`Change ${id} text was ${(rawText as string).length} characters; trimmed to ${QUOTE_LIMIT}.`);
		const state = absent(entry.state) as ChangeState | null | undefined;
		if (state !== undefined && state !== null && !["active", "parked", "settled"].includes(state)) { defects.push(`Change ${id} has invalid state ${JSON.stringify(entry.state)}.`); continue; }
		// Correction 6: state is meaningful only for a status_change; never silently discard it.
		if (kind !== "status_change" && state !== undefined && state !== null) { defects.push(`Change ${id} carries state but is ${kind}; state is only valid for status_change.`); continue; }

		if (kind === "status_change") {
			if (typeof on !== "string" || !saved.has(on)) { defects.push(`Change ${id} as status_change needs on: a saved node.`); continue; }
			if (state === undefined || state === null) { defects.push(`Change ${id} as status_change needs an explicit state.`); continue; }
			if (candidate.kind === "suggestion") { defects.push(`Change ${id}: a suggestion candidate is not completion evidence.`); continue; }
			if (candidate.source_role !== "user") {
				// Correction 2: a non-user transition must cite an actual final lead assistant report. The
				// host checks the event is lead+assistant and terminal; it does NOT prove the claim is true —
				// that the work is genuinely done remains model judgment, not host verification.
				if (event.actor !== "lead" || event.kind !== "assistant" || (event.status !== undefined && event.status !== "stop")) {
					defects.push(`Change ${id}: a non-user status_change must cite a final lead assistant report (got actor ${JSON.stringify(event.actor)}, kind ${JSON.stringify(event.kind)}, status ${JSON.stringify(event.status)}).`); continue;
				}
				if (state !== "settled") { defects.push(`Change ${id} (${candidate.source_role}) may only settle, not ${state}.`); continue; }
				if (!saved.get(on)!.endeavor) { defects.push(`Change ${id} (${candidate.source_role}) may only settle an endeavor, not ${on}.`); continue; }
			}
		}

		if (kind === "note_supersede") {
			if (typeof on !== "string" || !annotation(saved.get(on))) { defects.push(`Change ${id} as note_supersede needs on: a saved annotation.`); continue; }
			if (saved.get(on)!.kind === "rule" && candidate.source_role !== "user") { defects.push(`Change ${id} (${candidate.source_role}) cannot replace a saved rule.`); continue; }
		}
		if (kind === "rule" && typeof on === "string" && saved.get(on)?.kind === "rule" && candidate.source_role !== "user") {
			defects.push(`Change ${id} (${candidate.source_role}) cannot replace a saved rule.`); continue;
		}
		// Correction 5: a suggestion may not target (modify) a saved rule; note_add ABOUT one is allowed.
		if (kind === "suggestion" && typeof on === "string" && saved.get(on)?.kind === "rule") {
			defects.push(`Change ${id}: a suggestion cannot target a saved rule.`); continue;
		}
		// Correction 1: at most one new_work per candidate.
		if (kind === "new_work") {
			if (newWorkSeen.has(id)) { defects.push(`Change ${id} already carries a new_work; a candidate may start work at most once.`); continue; }
			newWorkSeen.add(id);
		}

		const resolved: Change = { candidate_id: id, kind, ...(typeof on === "string" ? { on } : {}), ...(text != null ? { text } : {}), ...(state != null ? { state } : {}) };
		const shape = effectiveCandidate(candidate, resolved, saved), canonical = canonicalEffect(shape, saved);
		// Correction 1: a duplicate is the same source + canonical effect + target (on) + state + wording.
		const dedupKey = JSON.stringify([candidate.source, canonical, kind === "new_work" ? on ?? null : null, text ?? candidate.quote]);
		const priorDup = dedup.get(dedupKey);
		if (priorDup !== undefined) { defects.push(`Change ${id} duplicates change ${priorDup}: same source, effect, target, state and wording.`); continue; }
		dedup.set(dedupKey, id);
		// Saved-target conflict keys reject two writes to one saved node (status/replace/supersede).
		const key = writeKey(shape, saved);
		if (key) {
			const prior = writeKeys.get(key);
			if (prior !== undefined) { defects.push(`Change ${id} conflicts with change ${prior} on ${key}.`); continue; }
			writeKeys.set(key, id);
		}
		if (kind === "new_work") newWorkParent.set(id, typeof on === "string" ? on : null);
		changes.push(resolved);
	}

	// Correction 7: candidate `on` targets must be selected NEW WORK, never any selected annotation.
	const selectedNewWork = new Set(changes.filter(c => c.kind === "new_work").map(c => c.candidate_id));
	for (const c of changes) {
		if ((c.kind === "note_add" || c.kind === "rule" || c.kind === "suggestion") && typeof c.on === "string" && !saved.has(c.on) && !selectedNewWork.has(c.on)) {
			defects.push(`Change ${c.candidate_id} on ${JSON.stringify(c.on)} is not a saved node or selected new work.`);
		}
		if (c.kind === "new_work" && typeof c.on === "string") {
			const parent = saved.get(c.on);
			if (parent ? !parent.endeavor : !selectedNewWork.has(c.on)) {
				defects.push(`Change ${c.candidate_id} new_work parent ${JSON.stringify(c.on)} is not a saved endeavor or selected new work.`);
			}
		}
	}
	// Correction 1: reject new_work parent cycles.
	for (const c of changes) {
		if (c.kind !== "new_work") continue;
		const chain = new Set<string>();
		let cursor: string | null | undefined = c.candidate_id;
		while (cursor) {
			if (chain.has(cursor)) { defects.push(`new_work parent cycle through ${cursor}.`); break; }
			chain.add(cursor);
			cursor = newWorkParent.get(cursor) ?? null;
		}
	}
	const focusNode = saved.get(value.focus);
	if (!((focusNode && focusNode.endeavor) || selectedNewWork.has(value.focus)))
		defects.push(`Focus ${JSON.stringify(value.focus)} is not a saved endeavor or selected new work.`);

	if (defects.length) return { defects };
	return { response: { changes, focus: value.focus as string }, repairs };
}

/** The effective change one validated change yields: the candidate with its final kind/target, the
 *  saved wording, and — for new_work — its parent. A status_change to the state a node is already in
 *  is suppressed (returns null): derived from saved state, never a fake write. */
export function resolveChange(candidate: Candidate, change: Change, saved: ReadonlyMap<string, SavedNode>): Resolved | null {
	if (change.kind === "status_change") {
		const node = saved.get(change.on ?? ""), from = node?.state, to = change.state;
		if (from !== undefined && to !== undefined && from === to) return null;
	}
	const shape = effectiveCandidate(candidate, change, saved);
	return { candidate: { ...candidate, ...shape }, text: change.text ?? candidate.quote, parent: change.kind === "new_work" ? (change.on ?? null) : null };
}
