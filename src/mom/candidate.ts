// Candidate contract v2 — explicit changes. Types only. Enumeration lives in enumerate.ts,
// provenance stamping in provenance.ts, the model-facing finalizer and validation in decide.ts.
// The model no longer renders per-fact verdicts; it emits only the meaningful changes of a turn.
import type { FeedEvent } from "./feed.ts";
import type { GraphNode } from "./graph.ts";

export type NodeState = GraphNode["state"];
export type SourceRole = "user" | "assistant" | "tool";
export type CandidateKind =
	| "new_work" | "status_change" | "rule" | "suggestion" | "note_add" | "note_supersede";

/** The explicit target state a status_change asserts. Derived `from` comes from saved state. */
export type ChangeState = "active" | "parked" | "settled";

export type Proposed =
	| { from: NodeState; to: ChangeState }
	| { replaces: string }
	| { scope: "root" | (string & {}) }
	| null;

export interface Candidate {
	id: string;
	kind: CandidateKind;
	/** Exactly one FeedEvent.ref, present in the update's current events. */
	source: string;
	/** Stamped from the cited event by provenance.ts. Never model-authored. */
	source_role: SourceRole;
	/** Raw event kind retained so structured dialog answers cannot be mistaken for new work. */
	source_kind?: FeedEvent["kind"];
	/** Complete fragment in act_labels; the explicit-change experiments cap quotes at 140 chars. */
	quote: string;
	prior_ref: string | null;
	proposed: Proposed;
	/** Host-supplied ref to a preceding offer this candidate answers; context only, never
	 *  admissible current evidence (only `source` is validated against the current update). */
	antecedent_ref?: string;
}

export const CANDIDATE_LIMIT = 60;
export const QUOTE_LIMIT = 140;

/** Kinds a change may carry, by stamped source_role. Tool is note_add only: a bare successful
 *  receipt is not completion evidence. Assistant may settle an endeavor but never reopen/park or
 *  change a rule (both enforced structurally in acceptChanges). */
export const ALLOWED_KINDS: Record<SourceRole, readonly CandidateKind[]> = {
	user: ["new_work", "status_change", "rule", "note_add", "note_supersede"],
	assistant: ["suggestion", "note_add", "note_supersede", "status_change"],
	tool: ["note_add"],
};

/** One explicit change the model asserts. `kind` is required; `on`/`text`/`state` are optional and
 *  kind-specific. Omission of a candidate is never a state action. */
export interface Change {
	candidate_id: string;
	kind: CandidateKind;
	on?: string | null;
	text?: string | null;
	state?: ChangeState | null;
}

export interface ModelResponse {
	changes: Change[];
	/** Saved endeavor or a selected new_work candidate: the latest requested work. */
	focus: string;
}

export interface ExpectedChange {
	kind: CandidateKind;
	source_role: SourceRole;
	prior_ref: string | null;
	/** Substring that must appear in the accepted candidate's quote or the change text. */
	quote_match: string;
	proposed: Proposed;
	/** Optional preceding-offer ref this expectation answers (asserted independently of quote). */
	antecedent_ref?: string;
	/** Optional pattern the resolved text must match, independent of the source quote. */
	text_pattern?: string;
}

export interface GoldenCase {
	id: string;
	session: string;
	seed_record: number;
	until_record: number;
	prior_state: unknown;
	expected: ExpectedChange[];
	forbidden: ExpectedChange[];
	focus: string;
	rationale: string;
}
