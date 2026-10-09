// Narrow fact extraction. The model emits facts; the host owns every graph decision.
//
// Evidence behind this shape:
//  - Cohen et al., EMNLP 2025 (arXiv 2509.12423): small models fail at joint inference over a whole
//    trajectory but match/beat large models once the job is decomposed and each step is narrow. Their
//    stage-1 summary quarantines the model's own inference in a field that is DISCARDED downstream;
//    `discarded` below is that field.
//  - Zep/Graphiti (arXiv 2501.13956): extraction reads a message plus a few neighbours; linking is a
//    separate retrieval-scoped resolution over a handful of candidates; the graph is written by
//    predefined queries, never by LLM-authored ones.
//  - This repo's own decider bench (tasks/todo.md): prompt-only small chat models scored at chance
//    (AUC 0.50-0.55) on narrow yes/no work, so a wide joint output space is not a small-model task.
//
// Consequences: the model never sees or emits a saved node id, never picks a status, never derives
// focus. `refers_to` carries label TEXT, which the host resolves deterministically and treats as
// unresolved when ambiguous. Nothing here touches the graph or mother.ts; the caller applies.
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import type { FeedEvent } from "./feed.ts";
import { QUOTE_LIMIT, type Candidate, type Change, type ModelResponse, type SourceRole } from "./candidate.ts";
import { isEndeavor, type GraphNode, type WorkGraph } from "./graph.ts";
import { sourceRole } from "./provenance.ts";
import type { SavedNode } from "./decide.ts";

/** What a turn establishes. `done`/`pivot` are transitions the host applies; the model names only the
 *  work by label and, for a pivot, whether it reopens. */
export const FACT_KINDS = ["new_work", "rule", "finding", "proposal", "done", "pivot"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface Fact {
	/** Host handle of the evidence fragment, e.g. "k7". Never a node id. */
	from: string;
	kind: FactKind;
	/** Wording to save; the host trims it to QUOTE_LIMIT. */
	text: string;
	/** Label text of the saved work this concerns, or null. Never an id. */
	refers_to: string | null;
}

export interface FactResponse {
	facts: Fact[];
	/** The model's own inferences. Recorded, then dropped: never saved as work, rules or findings. */
	discarded: string[];
}

/** Model-facing instructions. Every mechanical rule (label resolution, targets, states, authority,
 *  focus, deduplication) lives in applyFacts, never here. */
export const EXTRACT_PROMPT = `Extract the facts this turn establishes. You do not maintain the map: the host resolves labels, chooses targets, sets states, and derives focus. Never write a saved id. Refer to saved work by its label text in refers_to.

This turn lists each fragment of new conversation as k1, k2, ... Emit at most one fact per fragment, and only for fragments that establish something. Omit the rest.

- new_work: the user asked for something new. A question the user wants answered is new work. Assent ("Yes", "do it") is new work only for the precise thing most recently offered to the user, and authorizes nothing else.
- rule: the user stated a requirement about how work is done, or what the artifact must contain. A requested artifact structure is a requirement, not an ordinary note.
- finding: a direct answer, a correction, or a finding worth returning to.
- proposal: an assistant proposal awaiting a user decision. Never a rule.
- done: this turn finished or verified saved work.
- pivot: the user moved off saved work, or came back to it.

text is the wording to save, at most 140 characters. refers_to is the label of the saved work it concerns, or null.

Only the user creates work, states rules, and pivots. An assistant report can record done. A tool receipt is not completion evidence.

discarded holds your own inferences that the turn does not establish. They are recorded and dropped; they never become work, rules or findings.`;

const object = { additionalProperties: false } as const;
const FactSchema = Type.Object({
	from: Type.String({ minLength: 1, description: "Fragment handle from This turn, such as k7." }),
	kind: Type.Union(FACT_KINDS.map(kind => Type.Literal(kind))),
	text: Type.String({ maxLength: QUOTE_LIMIT, description: "Wording to save." }),
	refers_to: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()], { description: "Label text of the saved work, or null." })),
}, object);
const FactResponseSchema = Type.Object({
	facts: Type.Array(FactSchema, { maxItems: 32, description: "Only what this turn establishes." }),
	discarded: Type.Optional(Type.Array(Type.String({ maxLength: QUOTE_LIMIT }), { description: "Your own inferences; recorded and dropped." })),
}, object);

export function extractTool(): Tool {
	return { name: "commit_facts", description: "Commit the facts this turn establishes: one entry per fact (from, kind, text, refers_to by label text) plus your discarded inferences. The host resolves labels, targets, states and focus.",
		constrainedSampling: { type: "json_schema", strict: "prefer" }, parameters: FactResponseSchema };
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const absent = (value: unknown): unknown => value === "null" || value === "" ? null : value;
const normalize = (value: string): string => value.toLocaleLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** Resolve label text to exactly one saved node. An ambiguous or absent match is unresolved: the
 *  host then leaves the saved record untouched rather than guessing a target. */
export function resolveLabel(refers_to: string | null | undefined, nodes: readonly GraphNode[]): string | null {
	if (typeof refers_to !== "string") return null;
	const query = normalize(refers_to);
	if (query.length < 3) return null;
	const ids = new Set<string>();
	for (const node of nodes) {
		const label = normalize(node.label);
		if (!label) continue;
		if (label === query || (query.length >= 6 && label.length >= 6 && (label.includes(query) || query.includes(label)))) ids.add(node.id);
	}
	return ids.size === 1 ? [...ids][0] : null;
}

const REOPEN = /\b(resume|reopen|restart|return to|back to|switch to|pick up|continue)\b/i;
/** A non-user transition is admissible only from a final lead assistant report. Mirrors the event
 *  check in acceptChanges so the host never produces a response that validation must reject. */
const settles = (event: FeedEvent | undefined): boolean =>
	!!event && event.actor === "lead" && event.kind === "assistant" && (event.status === undefined || event.status === "stop");

export interface ApplyResult {
	response: ModelResponse;
	/** Facts that could not be attributed to a current candidate: a real provenance failure. */
	provenance_errors: number;
	/** Facts the host declined to apply, with the reason. Never silently dropped. */
	declined: { fact: Fact; why: string }[];
}

/** Deterministic application: facts -> the explicit-change ModelResponse of candidate.ts. The
 *  caller (and the scorer) revalidate the result through acceptChanges; this function is written so
 *  that revalidation passes, never so that it is skipped. */
export function applyFacts(
	value: unknown,
	candidates: readonly Candidate[],
	graph: WorkGraph,
	saved: ReadonlyMap<string, SavedNode>,
	/** The update's current events, for the terminal-assistant check on a non-user settlement. */
	current: ReadonlyMap<string, FeedEvent>,
): ApplyResult {
	// Handles are derived here, not passed in, so the numbering the model saw cannot drift from the
	// numbering the host applies.
	const handles = fragmentHandles(candidates);
	const declined: { fact: Fact; why: string }[] = [];
	let provenanceErrors = 0;
	if (!record(value) || !Array.isArray(value.facts)) return { response: { changes: [], focus: "" }, provenance_errors: 0, declined };
	const raw: unknown[] = value.facts;
	// Only user-created work can carry focus; the saved focus is the fallback.
	const focusNode = graph.focus && saved.get(graph.focus)?.endeavor ? graph.focus : null;
	const root = graph.nodes.find(node => node.parent === null)?.id ?? null;
	// Granularity is the host's: one handle is one enumerated fragment, so a fact cannot silently
	// merge two distinct claims the way a free-form extraction can.
	const facts = new Map<string, Fact>();
	for (const entry of raw) {
		if (!record(entry)) { declined.push({ fact: { from: "?", kind: "finding", text: "", refers_to: null }, why: "not an object" }); continue; }
		const from = typeof entry.from === "string" ? entry.from : "";
		const kind = FACT_KINDS.includes(entry.kind as FactKind) ? (entry.kind as FactKind) : undefined;
		const text = typeof entry.text === "string" ? entry.text.slice(0, QUOTE_LIMIT).replace(/\s+\S*$/, "").trimEnd() : "";
		const fact: Fact = { from, kind: kind ?? "finding", text, refers_to: absent(entry.refers_to) as string | null };
		if (!kind) { declined.push({ fact, why: `unknown kind ${JSON.stringify(entry.kind)}` }); continue; }
		if (!text) { declined.push({ fact, why: "empty text" }); continue; }
		if (facts.has(from)) { declined.push({ fact, why: `handle ${from} already carries a fact` }); continue; }
		facts.set(from, fact);
	}

	const changes: Change[] = [];
	// One fragment carries at most one fact, and one fragment is one source, so two changes can never
	// share a source. What remains is competing writes to one saved target.
	const seenWrite = new Set<string>(), seenNewWork = new Set<string>();
	const focusCandidates: string[] = [];
	const push = (change: Change, writeKey: string | null): boolean => {
		if (writeKey && seenWrite.has(writeKey)) return false;
		if (change.kind === "new_work" && seenNewWork.has(change.candidate_id)) return false;
		if (writeKey) seenWrite.add(writeKey);
		if (change.kind === "new_work") seenNewWork.add(change.candidate_id);
		if (change.kind === "new_work" && change.candidate_id) focusCandidates.push(change.candidate_id);
		changes.push(change);
		return true;
	};

	for (const fact of facts.values()) {
		const target = handles.get(fact.from);
		if (!target) { provenanceErrors++; declined.push({ fact, why: `unknown fragment handle ${JSON.stringify(fact.from)}` }); continue; }
		const role: SourceRole = target.source_role;
		const resolved = resolveLabel(fact.refers_to, graph.nodes);
		const node = resolved ? saved.get(resolved) : undefined;

		const kind = fact.kind, text = fact.text;
		// Authority, mirroring ALLOWED_KINDS: only the user creates work, rules and pivots.
		if ((kind === "new_work" || kind === "pivot") && role !== "user") { declined.push({ fact, why: `${kind} needs a user source` }); continue; }
		if (kind === "rule" && role !== "user") {
			// I2: a non-user rule degrades to a proposal rather than being dropped.
			if (node?.kind === "rule") { declined.push({ fact, why: "a suggestion cannot target a saved rule" }); continue; }
			push({ candidate_id: target.id, kind: "suggestion", ...(resolved ? { on: resolved } : {}), text }, null);
			continue;
		}
		if (kind === "proposal" && node?.kind === "rule") { declined.push({ fact, why: "a suggestion cannot target a saved rule" }); continue; }

		if (kind === "done" || kind === "pivot") {
			if (!resolved || !node?.endeavor) { declined.push({ fact, why: `${kind} needs a named saved endeavor` }); continue; }
			if (kind === "pivot") {
				push({ candidate_id: target.id, kind: "status_change", on: resolved, state: REOPEN.test(text) ? "active" : "parked", text }, `status:${resolved}`);
				continue;
			}
			if (role === "user") { push({ candidate_id: target.id, kind: "status_change", on: resolved, state: "settled", text }, `status:${resolved}`); continue; }
			// A non-user settlement needs an actual final lead assistant report, never a running turn or a receipt.
			if (!settles(current.get(target.source))) { declined.push({ fact, why: "done needs a user source or a final lead assistant report" }); continue; }
			push({ candidate_id: target.id, kind: "status_change", on: resolved, state: "settled", text }, `status:${resolved}`);
			continue;
		}

		const on = resolved && !(kind === "proposal" && node?.kind === "rule") ? resolved : undefined;
		if (kind === "rule") {
			// A rule on a saved annotation replaces it; on an endeavor it scopes to it; unattached it is root scope.
			push({ candidate_id: target.id, kind: "rule", ...(on ? { on } : {}), text }, on && !node?.endeavor ? `annotation:${on}` : null);
			continue;
		}
		push({ candidate_id: target.id, kind: kind === "new_work" ? "new_work" : kind === "proposal" ? "suggestion" : "note_add",
			...(kind === "new_work" ? { on: focusNode ?? undefined } : on ? { on } : {}), text }, null);
	}

	// Focus: the latest user-created work, else the saved focus, else the root. Never model-authored.
	const focus = focusCandidates.at(-1) ?? focusNode ?? root ?? "";
	return { response: { changes, focus }, provenance_errors: provenanceErrors, declined };
}

/** Render the turn for the model: the host-enumerated fragments as numbered handles, plus the saved
 *  labels `refers_to` may name. One handle is one fragment, so the model cannot merge two claims.
 *  The enumerator's provisional kinds are deliberately not shown: they were being copied verbatim. */
/** The one place handles are numbered. Shared by the renderer and the applier so they cannot drift. */
const fragmentHandles = (candidates: readonly Candidate[]): ReadonlyMap<string, Candidate> =>
	new Map(candidates.map((candidate, index) => [`k${index + 1}`, candidate]));

export function renderExtractionInput(graph: WorkGraph, candidates: readonly Candidate[], context: readonly FeedEvent[] = []): { body: string; handles: ReadonlyMap<string, Candidate> } {
	const work = graph.nodes.filter(isEndeavor).map(node => `- ${node.label} [${node.state}]`);
	const notes = graph.nodes.filter(node => !isEndeavor(node)).map(node => `- ${node.label} (${node.kind})`);
	const handles = fragmentHandles(candidates);
	const lines = candidates.map((candidate, index) =>
		`k${index + 1} <${candidate.source_role}> ${candidate.antecedent_ref ? "(answers an offer) " : ""}${JSON.stringify(candidate.quote)}`);
	const purpose = graph.nodes.find(node => node.id === graph.purpose);
	const body = [
		`purpose: ${purpose?.label ?? "?"}`,
		work.length ? `saved work:\n${work.join("\n")}` : "saved work: none",
		notes.length ? `saved notes:\n${notes.join("\n")}` : "saved notes: none",
		...(context.length ? ["earlier conversation (context only, not new evidence):", ...context.map(event => `<${sourceRole(event)}>: ${(event.text ?? "").trim()}`)] : []),
		"this turn, one fragment per line:", ...lines,
	].join("\n");
	return { body, handles };
}

/** The saved-node projection applyFacts needs. Re-exported so callers need not import decide.ts. */
export type { SavedNode };
