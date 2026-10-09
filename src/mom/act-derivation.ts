// Act derivation — the `act_labels` mode's host half.
//
// The model labels each enumerated conversation fragment with one LINGUISTIC ACT. Everything the
// graph does about it is decided here, deterministically, from (act x graph state): what a claim is
// about, where it lands, what state a record takes, what focus becomes. The model never names a
// node, never sets a state, never derives focus.
//
// This is the whole point of the mode. Mom's map-maintenance judgment ("the soul") lives in
// MOM_PROMPT as about fifteen prose rules a large model holds and a small one loses. Moving the
// structural half into code leaves the model a single classification per fragment. Native
// preparation and finalization are separate requests; see docs/map-modes.md for
// bounded measurements and their limits.
//
// Derivation rules:
//   request         + no saved work covering it      -> new work (focus follows)
//   request         + saved work already covering it -> redirect (park displaced work, move focus)
//   constraint      + no explicit prior rule ref     -> append a rule on the subject's work
//   constraint      + explicit prior rule ref        -> replace that rule (reactivate, retext)
//   correction                                    -> update the record it governs, and reopen the
//                                                      settled verification whose proof it voids
//   report-of-completion                          -> settle only cited, unnegated, lexis-grounded
//                                                      completions, only the named work; carry the
//                                                      report's caveats as observations
//   proposal                                      -> suggestion note, never a rule
//   assent                                        -> authorize exactly the most recent offer
//   answer | other                                -> nothing
import { Type } from "typebox";
import type { Tool } from "@earendil-works/pi-ai";
import type { Candidate } from "./candidate.ts";
import type { FeedEvent } from "./feed.ts";
import { checkGraph, editGraph, isEndeavor, type GraphEdit, type GraphNode, type WorkGraph } from "./graph.ts";

export const ACTS = ["request", "constraint", "correction", "question", "answer", "report-of-completion", "proposal", "assent", "other"] as const;
export type Act = (typeof ACTS)[number];

export interface ActDerivation { graph: WorkGraph; focus: string | null; log: string[] }

const FENCE = /(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\S\n]*(?=\n|$)|$)/g;
const STOP = new Set(("a an the and or but if then of to in on at for with by from as is are was were be been being it its this that " +
	"these those i you we they me my your our us do does did just so than too very can will into over also there here when what " +
	"which who how why all any some more most other each every about up out off again still now got get let lets").split(" "));

/** Lowercase alphanumeric tokens, light plural stem, stopwords dropped. */
function tokens(text: string): string[] {
	return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
		.filter(token => !STOP.has(token) && token.length >= 2)
		.map(token => token.length > 4 && token.endsWith("ies") ? `${token.slice(0, -3)}y`
			: token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token);
}
const matches = (a: string, b: string): boolean => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** Name (id+label) matches outweigh intent matches; observed is transient status, never retrieval text. */
function score(node: GraphNode, fragment: Set<string>): number {
	const name = new Set([...tokens(node.id.replace(/[_-]+/g, " ")), ...tokens(node.label)]);
	const intent = new Set(tokens(node.intent ?? ""));
	let value = 0;
	for (const token of fragment) {
		const hitName = [...name].some(field => matches(token, field));
		const hitIntent = !hitName && [...intent].some(field => matches(token, field));
		if (hitName) value += 3; else if (hitIntent) value += 1;
	}
	return value;
}

const clip = (text: string, max: number): string => text.length <= max ? text : text.slice(0, max);

// A caveat is an explicit statement that a step did NOT happen. Ordinary negation words
// ("only", "no", "left") are not caveats and turned every report sentence into one.
const ADVICE_SHAPE = /\b(?:should|could|would|might|recommend|suggest|suggesting|idea|option|want me to|shall i|how about|it should|it could|let me|happy to|can i|use|try|consider|switch|prefer|instead|maybe|perhaps)\b|\?\s*$/i;

const REQUEST_SHAPE = /\b(?:please|can you|could you|would you|will you|help me|give me|let['’]?s|i need|we need|gonna need you to|make sure|ensure|add|build|create|remove|delete|fix|update|implement|write|show|explain|verify|check|run|split|redesign|rework|switch|move|rename|refactor|replace|investigate|assess|think through|walk me|tell me)\b/i;
const QUESTION = /\?\s*$/;
// Only durable, multi-turn things are tracked. A status or meta question is single-turn: Mom answers it,
// so it is never work. The model marks those `question`; these host patterns are the backstop for a
// model that reaches for `request` anyway.
const STATUS_REQUEST = /^(?:ok[, ]*|so[, ]*|hey[, ]*|hold on[, ]*|wait[, ]*)*(?:wtf|what the fuck|what the hell)?\s*(?:where are we|how are we|how'?s it going|what'?s next|what'?s the status|what is the status|are we (?:done|there|finished|ready|good)|is (?:it|this|that|everything) (?:done|finished|ready|fixed|in place|working|still running)|should i be seeing|are things (?:still |going |working )|what are you doing|what'?s going on|what happened|what went wrong|what is taking so long|what'?s taking so long|why is (?:it|this) taking|how much longer|any progress|getting (?:fixed|done|there)|are the .{0,40} (?:global|project|shared|local))\b/i;
const EXPLICIT_OFFER = /\b(?:want me to|would you like me to|shall i|should i|can i|i can|i could|i propose|how about|let me)\b/i;

/** An explicit repair can remove work that older act-label rules fabricated from dialog results
 *  or from a non-offer assistant status. Original sources remain in the append-only sidecar, so the
 *  evidence survives even when the node it was misread into does not. Durability itself is the
 *  model's judgment, never a host pattern: "What else is fucking idiotic in this stack?" is durable
 *  work and "Is it in place now?" is not, and no regex tells them apart. */
export function repairWorkProvenance(prior: WorkGraph, known: ReadonlyMap<string, FeedEvent>): { graph: WorkGraph; removed: string[] } {
	const removed = new Set<string>(), retained = new Map<string, GraphNode>();
	for (const node of prior.nodes) {
		if (!/^actw\d+$/.test(node.id) || !isEndeavor(node) || !node.parent || node.state === "settled") continue;
		const sources = node.sources.map(ref => known.get(ref));
		if (sources.some(source => !source)) continue;
		const dialog = sources.some(source => source?.kind === "user_answer") && !sources.some(source => source?.kind === "user");
		const reminder = sources.some(source => source?.kind === "user" && /You stopped with \d+ open todo item/.test(source.text ?? ""));
		const statusAsOffer = reminder && Boolean(node.intent) && sources.some(source => source?.kind === "assistant" && source.text?.startsWith(node.intent) && !EXPLICIT_OFFER.test(source.text));
		if (!dialog && !statusAsOffer) continue;
		const descendants = new Set([node.id]);
		for (const id of descendants) for (const child of prior.nodes) if (child.parent === id) descendants.add(child.id);
		if (prior.nodes.some(child => child.id !== node.id && descendants.has(child.id) && child.sources.some(ref => !known.has(ref)))) continue;
		for (const child of prior.nodes) {
			if (!descendants.has(child.id)) continue;
			const user = child.id !== node.id ? child.sources.map(ref => known.get(ref)).find(source => source?.kind === "user") : undefined;
			if (user) {
				const quote = clip(user.text ?? child.label, 160);
				retained.set(child.id, { ...child, parent: node.parent, kind: "observation", state: "active", label: quote,
					intent: clip(user.text ?? child.intent, 1200), observed: clip(user.text ?? child.observed, 2400) });
			} else removed.add(child.id);
		}
	}
	if (!removed.size) return { graph: prior, removed: [] };
	const focus = prior.focus && removed.has(prior.focus) ? prior.nodes.find(node => node.id === prior.focus)?.parent ?? prior.purpose : prior.focus;
	const graph: WorkGraph = { ...prior, revision: prior.revision + 1, focus,
		nodes: prior.nodes.filter(node => !removed.has(node.id)).map(node => retained.get(node.id) ?? node),
		edges: prior.edges.filter(edge => !removed.has(edge.from) && !removed.has(edge.to)) };
	checkGraph(graph);
	return { graph, removed: [...removed] };
}
const STALE_COMPLAINT = /\b(?:stale|dated|old|outdated|obsolete|still shows?|still showing|not refreshed|not updated|refresh(?:ed|ing)?|behind)\b/i;
const RESULT_FINDING = /\b(?:\d+\s*\/\s*\d+|tests?|checks?|verified|passed|failed|fixed|implemented|removed|restarted|uncommitted|gaps?)\b/i;
const NUMERIC_RESULT = /\b\d+\s*\/\s*\d+\b/;
const OBSOLETE_PARKED = /\b(?:abandoned|obsolete|superseded|deferred|resume only if|parked after)\b/i;

const NEGATED = /\b(not|never|didn['’]?t|haven['’]?t|hasn['’]?t|isn['’]?t|wasn['’]?t|weren['’]?t|doesn['’]?t|don['’]?t|didnt|skipped|omitted|left out|pending|unverified|untested|failed|cannot|can['’]?t|without running)\b/i;
const COMPLETION_LEXIS = /\b(done|completed?|finished|passed|passes|verified|fixed|deleted|removed|implemented|reworked|is gone|gone|shipped|cleared)\b/i;

/**
 * Host derivation: fragments and their labeled acts in, the resulting map out. Only touched
 * records are edited, so every untouched node stays byte-identical.
 */
/**
 * The act_labels mode's finalizer, declared with the mode rather than in contract.ts's shared tool
 * surface: `momTools()` keeps its small integration contract, and each mode owns its own payload.
 */
export function actLabelsTool(): Tool {
	return {
		name: "commit_acts",
		description: "Commit one linguistic act per conversation fragment and a model-written label for new work. The host derives graph operations; you never name a node, a state or focus.",
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		parameters: Type.Object({ acts: Type.Array(Type.Object({
			id: Type.String({ minLength: 1, description: "The fragment id, such as c01." }),
			act: Type.String({ minLength: 1, description: "request | constraint | correction | answer | report-of-completion | proposal | assent | other" }),
			label: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "Model-written short work label, required for request and assent." })),
		}, { additionalProperties: false }), { minItems: 0, maxItems: 64, description: "Exactly one act per supplied fragment; an empty list only when no fragments were supplied." }) }, { additionalProperties: false }),
	};
}

/** The act-labeling mode's committed payload: one act per fragment id, with labels for work acts. */
export interface ActPayload { acts: { id: string; act: string; label?: string }[] }

/** Normalize a model-spoken act name. Models drift in wording; the vocabulary is the contract. */
const SYNONYMS: Record<string, Act> = {
	request: "request", "new-request": "request", new_work: "request",
	constraint: "constraint", requirement: "constraint", "artifact-requirement": "constraint",
	correction: "correction", reject: "correction", rejection: "correction",
	question: "question", "status-question": "question", ping: "question",
	answer: "answer",
	"report-of-completion": "report-of-completion", completion: "report-of-completion", "completion-report": "report-of-completion", done: "report-of-completion", report: "report-of-completion",
	proposal: "proposal", suggestion: "proposal", offer: "proposal",
	assent: "assent", approval: "assent", approve: "assent", consent: "assent",
	other: "other", none: "other", note: "other",
};

/** Parse the committed payload into one act per fragment. Missing or unknown acts come back as
 *  defects so the caller can reject the whole payload once and ask for a corrected one — the host
 *  never guesses a missing label. */
export function parseActs(value: unknown, ids: readonly string[]): { acts: Map<string, Act>; labels: Map<string, string>; defects: string[] } {
	const defects: string[] = [], acts = new Map<string, Act>(), labels = new Map<string, string>();
	const raw = (value as { acts?: unknown } | null)?.acts;
	// Two shapes are accepted: the strict-schema array [{id, act}], or a plain {id: act} map.
	const entries: [string, unknown, unknown][] = Array.isArray(raw)
		? raw.map(entry => [String((entry as { id?: unknown } | null)?.id ?? ""), (entry as { act?: unknown } | null)?.act, (entry as { label?: unknown } | null)?.label])
		: raw && typeof raw === "object" ? Object.entries(raw as Record<string, unknown>).map(([id, act]) => [id, act, undefined]) : [];
	if (!Array.isArray(raw) && (!raw || typeof raw !== "object")) return { acts, labels, defects: ["commit_acts needs one act per fragment (an acts array of {id, act, label})."] };
	const expected = new Set(ids), spoken = new Map<string, unknown>(), labelsById = new Map<string, unknown>();
	for (const [id, act, label] of entries) {
		if (!expected.has(id)) defects.push(`unknown fragment ${id}`);
		if (spoken.has(id)) defects.push(`duplicate fragment ${id}`);
		spoken.set(id, act); labelsById.set(id, label);
	}
	for (const id of ids) {
		const said = spoken.get(id);
		if (typeof said !== "string") { defects.push(`missing act for ${id}`); continue; }
		const act = SYNONYMS[said.trim().toLowerCase().replace(/[\s_]+/g, "-")];
		if (!act) { defects.push(`${id}: unknown act ${JSON.stringify(said)}; use ${ACTS.join(", ")}`); continue; }
		acts.set(id, act);
		const label = labelsById.get(id);
		if (label !== undefined) {
			if (typeof label !== "string" || !label.trim()) defects.push(`${id}: label must be a non-empty short work label`);
			else labels.set(id, label.trim());
		}
		if ((act === "request" || act === "assent") && !labels.has(id)) defects.push(`${id}: ${act} needs a model-written label`);
	}
	return { acts, labels, defects };
}

export function deriveActs(
	prior: WorkGraph,
	candidates: readonly Candidate[],
	acts: ReadonlyMap<string, Act>,
	known: ReadonlyMap<string, FeedEvent>,
	events: readonly FeedEvent[],
	labels: ReadonlyMap<string, string> = new Map(),
): ActDerivation {
	const log: string[] = [];
	const nodes = new Map<string, GraphNode>(prior.nodes.map(node => [node.id, node]));
	let focus = prior.focus;
	let serial = 0;
	let purpose = prior.purpose && prior.nodes.some(node => node.id === prior.purpose) ? prior.purpose : null;
	const freshId = (prefix: string): string => { do { serial++; } while (nodes.has(`${prefix}${serial}`)); return `${prefix}${serial}`; };

	// The turn's report: the last final assistant statement, code fences stripped — the current
	// status evidence a correction or completion attaches to the record it governs.
	const turnReport = (() => {
		for (let i = events.length - 1; i >= 0; i--) {
			const event = events[i]!;
			if (event.kind === "assistant" && (event.status === undefined || event.status === "stop") && event.text)
				return clip(event.text.replace(FENCE, "\n").replace(/\n{2,}/g, "\n").trim(), 2400);
		}
		return "";
	})();

	const parentOf = (node: GraphNode): string => isEndeavor(node) ? node.id : node.parent ?? purpose!;
	const sourceAt = (node: GraphNode): number => Math.max(...node.sources.map(ref => {
		const at = known.get(ref)?.at;
		return at ? Date.parse(at) : Number.NEGATIVE_INFINITY;
	}));
	const currentWork = (): GraphNode | undefined => [...nodes.values()]
		.filter(node => isEndeavor(node) && ["active", "parked"].includes(node.state) && !(node.state === "parked" && OBSOLETE_PARKED.test(`${node.label} ${node.intent} ${node.observed}`)))
		.sort((a, b) => sourceAt(b) - sourceAt(a) || a.id.localeCompare(b.id))[0];
	const toEndeavor = (id: string): GraphNode | undefined => {
		const node = nodes.get(id);
		if (!node) return undefined;
		return isEndeavor(node) ? node : nodes.get(node.parent ?? "") || undefined;
	};
	const depthOf = (node: GraphNode): number => { let depth = 0, parent = node.parent; while (parent) { depth++; parent = nodes.get(parent)?.parent ?? null; } return depth; };

	/** Subject of a claim: exact saved mention -> a dialog answer concerns current work -> best
	 *  matching saved WORK first (a claim governs the enclosing work item), then the best-matching
	 *  saved note (a correction naming no work governs the record it contradicts). Ties break toward
	 *  the shallower, umbrella record. Verification bookkeeping (try) is never the subject of a
	 *  content claim — except a completion, which is precisely about a check. */
	const subjectOf = (candidate: Candidate, allowTry: boolean): GraphNode | undefined => {
		if (candidate.prior_ref && nodes.has(candidate.prior_ref)) return nodes.get(candidate.prior_ref)!;
		const antecedent = candidate.antecedent_ref ? known.get(candidate.antecedent_ref) : undefined;
		if (antecedent?.kind === "tool_call" && focus) return nodes.get(focus) ?? undefined;
		const fragment = new Set(tokens(candidate.quote));
		if (!fragment.size) return undefined;
		const best = (eligible: (node: GraphNode) => boolean): GraphNode | undefined => {
			let winner: GraphNode | undefined, winnerScore = 0, winnerDepth = Number.MAX_SAFE_INTEGER;
			for (const node of nodes.values()) {
				if (!eligible(node)) continue;
				const value = score(node, fragment);
				if (!value) continue;
				const depth = depthOf(node);
				if (value > winnerScore || (value === winnerScore && depth < winnerDepth)) { winner = node; winnerScore = value; winnerDepth = depth; }
			}
			return winner;
		};
		return best(node => isEndeavor(node) && (allowTry || node.kind !== "try"))
			?? best(node => !isEndeavor(node) && (allowTry || node.kind !== "try"));
	};

	/** Saved work a fragment covers: only an exact saved name counts as covering. */
	const coverageOf = (candidate: Candidate): GraphNode | undefined =>
		candidate.prior_ref ? toEndeavor(candidate.prior_ref) : undefined;

	const put = (node: GraphNode): void => { nodes.set(node.id, node); log.push(`upsert ${node.id} [${node.kind}/${node.state}] ${JSON.stringify(node.label.slice(0, 60))}`); };
	const attach = (parent: string, kind: "rule" | "choice" | "observation", text: string, source: string): string => {
		const id = freshId("actn");
		put({ id, kind, parent, state: "active", label: clip(text, 160), intent: clip(text, 1200), observed: clip(text, 2400), actor: "", sources: [source] });
		return id;
	};
	const moveFocus = (target: string): void => {
		if (focus === target) return;
		const displaced = focus ? nodes.get(focus) : undefined;
		if (displaced && displaced.state === "active") { put({ ...displaced, state: "parked" }); log.push(`park displaced ${displaced.id}`); }
		focus = target;
		log.push(`focus -> ${target}`);
	};

	// Role stamping (host-side authority): assistant and tool speech cannot create work or rules.
	const stamp = (candidate: Candidate, act: Act): Act => {
		if (candidate.source_role === "tool") return "other";
		if (candidate.source_role === "assistant") {
			if (act === "request" || act === "constraint" || act === "correction" || act === "assent") return "proposal";
			if (act === "answer") return "other";
		}
		return act;
	};

	// Cold start: a nonempty graph must have purpose and focus nodes (checkGraph). The host
	// establishes the mother thread from the turn's earliest user fragment; the model never names a
	// root. On an existing map this is a no-op and the saved purpose is kept exactly.
	let openingId: string | undefined;
	if (!purpose) {
		// The mother thread is the session's first durable ask, never a status question the user
		// asked and Mom answered. Only when nothing durable was said does a bare fragment stand in.
		const durable = candidates.find(candidate => acts.get(candidate.id) === "request" || acts.get(candidate.id) === "assent");
		const opening = durable ?? candidates.find(candidate => candidate.source_role === "user") ?? candidates[0];
		const id = freshId("actroot");
		put({ id, kind: "feature", parent: null, state: "active", label: clip(opening ? labels.get(opening.id) ?? opening.quote : "Session purpose", 160),
			intent: clip(opening?.quote ?? "", 1200), observed: "", actor: "", sources: opening ? [opening.source] : [] });
		purpose = id;
		focus = focus ?? id;
		openingId = opening?.id;
		log.push(`cold start: mother thread ${id}`);
	}
	if (!focus) focus = purpose;

	const processedNotes = new Set<string>();
	const suggested = new Set<string>();
	const caveated = new Set<string>();
	const reports = new Map<string, string>();
	let explicitFocus = false;
	// A refresh can arrive with no new fragments. Retain the latest source-backed factual result
	// rather than treating an empty batch as permission to forget it.
	if (!candidates.length) {
		const results = [...known.values()]
			.filter(event => event.actor === "lead" && event.kind === "assistant" && event.text && NUMERIC_RESULT.test(event.text))
			.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.ref.localeCompare(a.ref));
		for (const result of results) {
			const target = [...nodes.values()].find(node => isEndeavor(node) && node.sources.includes(result.ref));
			if (!target) continue;
			const existing = [...nodes.values()].some(node => node.kind === "observation" && node.sources.includes(result.ref) && NUMERIC_RESULT.test(node.observed));
			if (!existing) attach(target.id, "observation", result.text!, result.ref);
		}
	}
	for (const candidate of candidates) {
		const labeled = acts.get(candidate.id) ?? "other";
		const stamped = candidate.source_role === "user" && STALE_COMPLAINT.test(candidate.quote) ? "correction" : stamp(candidate, labeled);
		// A dialog answer is evidence about the preceding question, not a fresh work request. The
		// model still chooses assent, correction, or answer; only the impossible request reading is
		// blocked by source kind, never by the answer's wording.
		const act = candidate.source_kind === "user_answer" && (stamped === "request" || stamped === "assent") ? "answer" : stamped;
		if (candidate.source_role === "assistant" && NUMERIC_RESULT.test(candidate.quote)) {
			const target = currentWork() ?? nodes.get(focus ?? "");
			if (target && isEndeavor(target) && ![...nodes.values()].some(node => node.kind === "observation" && node.sources.includes(candidate.source) && NUMERIC_RESULT.test(node.observed))) {
				attach(target.id, "observation", candidate.quote, candidate.source);
				processedNotes.add(candidate.id);
			}
		}

		if (act === "question") { log.push(`question ${candidate.id}: single-turn, answered not tracked`); continue; }

		if (act === "request") {
			// The act label decides the utterance kind; the enumerator's provisional kind is only a hint
			// and its request verb-list is narrow enough to miss "Please split ...". A permissive host
			// shape check still keeps pure description from becoming work.
			if (STATUS_REQUEST.test(candidate.quote)) { log.push(`request ${candidate.id}: status question, dropped`); continue; }
			// A question is durable work only when it asks for a deliverable. A bare question is
			// single-turn — Mom answers it — so it never becomes work.
			if (QUESTION.test(candidate.quote) && !REQUEST_SHAPE.test(candidate.quote)) { log.push(`request ${candidate.id}: question-shaped, not durable work, dropped`); continue; }
			// The fragment that established the mother thread IS that work: it must not become a
			// duplicate child of itself.
			const covered = candidate.id === openingId && purpose ? nodes.get(purpose) : coverageOf(candidate);
			if (covered) { moveFocus(covered.id); explicitFocus = true; continue; }
			const id = freshId("actw");
			const workLabel = labels.get(candidate.id);
			if (!workLabel) throw new Error(`${candidate.id}: request needs a model-written label`);
			put({ id, kind: "feature", parent: purpose, state: "active", label: clip(workLabel, 160),
				intent: clip(candidate.quote, 1200), observed: "", actor: "", sources: [candidate.source] });
			focus = id;
			explicitFocus = true;
			log.push(`request -> new work ${id}`);
			continue;
		}

		if (act === "constraint" || act === "correction") {
			if (act === "correction" && candidate.source_role === "user" && STALE_COMPLAINT.test(candidate.quote)) {
				const target = currentWork() ?? subjectOf(candidate, false) ?? nodes.get(focus ?? "");
				if (target && isEndeavor(target)) {
					attach(target.id, "observation", candidate.quote, candidate.source);
					put({ ...target, observed: clip(candidate.quote, 2400), sources: [...new Set([...target.sources, candidate.source])] });
					moveFocus(target.id); explicitFocus = true;
					log.push(`complaint ${candidate.id} on ${target.id}`);
				}
				continue;
			}
			const subject = subjectOf(candidate, false) ?? nodes.get(focus ?? "");
			if (!subject) { log.push(`${act} ${candidate.id}: no subject, dropped`); continue; }
			if (act === "constraint") {
				// Sharing a work item does not mean one requirement supersedes another.
				if (subject.kind === "rule" && candidate.prior_ref === subject.id) {
					put({ ...subject, state: "active", label: clip(candidate.quote, 160), intent: clip(candidate.quote, 1200),
						sources: [...new Set([...subject.sources, candidate.source])] });
					log.push(`constraint replaces explicit rule ${subject.id}`);
				} else attach(parentOf(subject), "rule", candidate.quote, candidate.source);
			} else if (isEndeavor(subject)) {
				// Correction on work: record the correction on it, and reopen the settled verification
				// it governs — the rejection invalidates the evidence that closed that check.
				attach(subject.id, "rule", candidate.quote, candidate.source);
				for (const node of nodes.values()) {
					if (node.state !== "settled" || node.kind !== "try" || !/^(re)?verify/i.test(node.label)) continue;
					const dependsOn = prior.edges.some(edge => edge.from === node.id && edge.relation === "depends_on" && edge.to === subject.id);
					let ancestor: string | null = node.parent, within = false;
					while (ancestor) { if (ancestor === subject.id) { within = true; break; } ancestor = nodes.get(ancestor)?.parent ?? null; }
					if (dependsOn || within) {
						put({ ...node, state: "active", observed: turnReport || node.observed, sources: [...new Set([...node.sources, candidate.source])] });
						log.push(`correction reopens ${node.id}`);
					}
				}
			} else put({ ...subject, state: "active", intent: clip(candidate.quote, 1200),
				observed: turnReport || subject.observed, sources: [...new Set([...subject.sources, candidate.source])] });
			continue;
		}

		if (act === "report-of-completion") {
			const negated = NEGATED.test(candidate.quote);
			// One report, one work: fragments from the same source as an already-resolved completion
			// belong to THAT completion's work — detail sentences never re-resolve a subject of their
			// own, or a stray word would bind them to unrelated work.
			const bound = reports.get(candidate.source);
			const subject = bound ? nodes.get(bound) : subjectOf(candidate, true);
			const work = subject ? toEndeavor(subject.id) : undefined;
			if (negated || !COMPLETION_LEXIS.test(candidate.quote)) {
				// A negative or lexis-less "completion" is a caveat, never a state change — and only if
				// it actually concerns the work it would attach to. At most one caveat per work per turn.
				if (work && caveated.size < 2 && !caveated.has(work.id) && score(work, new Set(tokens(candidate.quote)))) { caveated.add(work.id); attach(work.id, "observation", candidate.quote, candidate.source); processedNotes.add(candidate.id); log.push(`caveat ${candidate.id} on ${work.id}`); }
				else log.push(`caveat ${candidate.id}: does not concern ${work?.id ?? "any work"}, dropped`);
				continue;
			}
			if (!work) { log.push(`completion ${candidate.id}: no named work, dropped`); continue; }
			put({ ...work, state: "settled", observed: clip(candidate.quote, 2400), sources: [...new Set([...work.sources, candidate.source])] });
			log.push(`completion settles ${work.id}`);
			reports.set(candidate.source, work.id);
			processedNotes.add(candidate.id);
			// A completion package includes factual result sentences as well as its final status. Keep
			// those details as findings on the same work, even when the classifier called them answer/other.
			for (const sibling of candidates) {
				if (sibling.source !== candidate.source || processedNotes.has(sibling.id)) continue;
				const siblingAct = acts.get(sibling.id) ?? "other";
				if (siblingAct !== "other" && siblingAct !== "answer") continue;
				if (NEGATED.test(sibling.quote)) {
					if (!score(work, new Set(tokens(sibling.quote)))) { log.push(`caveat ${sibling.id}: does not concern ${work.id}, dropped`); continue; }
					attach(work.id, "observation", sibling.quote, sibling.source);
					processedNotes.add(sibling.id);
					log.push(`caveat ${sibling.id} on ${work.id}`);
					continue;
				}
				if (ADVICE_SHAPE.test(sibling.quote) || !RESULT_FINDING.test(sibling.quote)) continue;
				attach(work.id, "observation", sibling.quote, sibling.source);
				processedNotes.add(sibling.id);
				log.push(`finding ${sibling.id} on ${work.id}`);
			}
			continue;
		}

		if (act === "proposal") {
			// A permissive advice-shape check keeps ordinary assistant description from becoming
			// suggestions. It must admit both an imperative ("Use a grid layout ...") and an
			// impersonal maxim ("where it can be a script, it should be"). A work item also holds at
			// most one pending suggestion per turn.
			if (!ADVICE_SHAPE.test(candidate.quote)) { log.push(`proposal ${candidate.id}: not advice-shaped, dropped`); continue; }
			const subject = subjectOf(candidate, false);
			const slot = subject ? parentOf(subject) : (focus ?? purpose!);
			if (nodes.get(slot)?.state === "settled") { log.push(`proposal ${candidate.id}: ${slot} is settled, no pending offer, dropped`); continue; }
			if (suggested.has(slot)) { log.push(`proposal ${candidate.id}: suggestion already pending on ${slot}, dropped`); continue; }
			suggested.add(slot);
			attach(slot, "choice", candidate.quote, candidate.source);
			log.push(`proposal ${candidate.id} -> suggestion on ${slot} (subject ${subject?.id ?? "none"})`);
			continue;
		}

		if (act === "assent") {
			const offer = candidate.antecedent_ref ? known.get(candidate.antecedent_ref) : undefined;
			if (offer?.kind !== "assistant" || !offer.text || !EXPLICIT_OFFER.test(offer.text)) { log.push(`assent ${candidate.id}: no explicit offer, dropped`); continue; }
			const id = freshId("actw");
			const workLabel = labels.get(candidate.id);
			if (!workLabel) throw new Error(`${candidate.id}: assent needs a model-written label`);
			put({ id, kind: "feature", parent: purpose, state: "active", label: clip(workLabel, 160),
				intent: clip(offer.text, 1200), observed: "", actor: "", sources: [...new Set([offer.ref, candidate.source])] });
			focus = id;
			explicitFocus = true;
			log.push(`assent authorizes ${id}`);
			continue;
		}
		// answer | other: nothing.
	}
	if (!explicitFocus) {
		const target = currentWork();
		if (target && target.id !== focus) moveFocus(target.id);
	}

	const touched: GraphEdit[] = [];
	const before = new Map(prior.nodes.map(node => [node.id, node]));
	for (const node of nodes.values()) {
		const saved = before.get(node.id);
		if (!saved || JSON.stringify(saved) !== JSON.stringify(node)) touched.push({ op: "put_node", node });
	}
	const graph = editGraph(prior, prior.revision, touched, purpose, focus, new Set(known.keys()));
	return { graph, focus, log };
}

/** The act-labeling mode's model-facing instructions. The model answers with one act per fragment
 *  id and nothing else — never a node id, a state, or a focus. */
export const ACT_LABEL_PROMPT = `You label the linguistic act of each conversation fragment. You never decide graph structure: no node ids, no states, no focus — only acts.

Acts (exactly one per fragment):
- request — the user asks for durable, multi-turn work: something that will span turns and needs its own outcome ("fold Mom into pi-delegate", "set up the ssweens stack", "validate the other agent's fix"). A one-off instruction the next turn fully satisfies, or a question about the state of the work, is question or other — never a request. Only user fragments can be requests. A question that asks for an explanation of what is happening now ("were those labels from act mode or commit mode", "what is the status") is question, not request: it is answered in one turn. Only a question that asks for a deliverable which will outlive the turn is a request. A question that spells out what the deliverable must show is a constraint.
- constraint — states a requirement that must hold of the artifact or record: how something must be ("those can all be the same 6ish lane swimlane"), or what it must show ("what skills are engaged when, what artifacts are created when"). Phrased as a question it is still a constraint when it specifies the deliverable's content. It adds or supersedes a requirement; it does not assert that something existing is wrong.
- correction — says something that exists, was recorded, or was just proposed is WRONG or rejected ("Last chance - Time goes vertical"). When the reply to "what still looks wrong?" is a picked option — even a bare selection like "User answered: Diagram as a whole" — that selection rejects the artifact: it is a correction, not an answer. It changes what is true now.
- question — asks about the state of the work right now: status, progress, what is happening, whether something is done or in place, or a one-off factual question — including a question about Mom's own output, labels, or mode ("where are we?", "is it in place now?", "were those labels from act mode or commit mode?", "are the mom settings global or project?"). Single-turn: Mom answers it. It is never work, never a rule, and never changes focus. Use it for anything that is not durable, multi-turn work.
- answer — supplies information that was asked for and rejects nothing: no new requirement, nothing declared wrong. If the reply itself says the current thing is wrong or must change, or picks which part is wrong, it is a correction, not an answer.
- report-of-completion — states specific work is finished, done, verified, or removed ("The cleanup is done.", "Verified. The page check passes."). Only the sentence that declares completion counts; the report's other sentences describing what was done, checked, or found are other.
- proposal — the assistant offers, suggests, or recommends something awaiting the user: "Want me to…", "I can draft…", and its advice on how things should be done — including an impersonal conditional maxim with no first person ("Where it can be a script, it should be: …"). That is the assistant recommending a standard, not describing what exists.
- assent — the user approves the offer most recently made to them ("Yes", "Sure", "go ahead"): it authorizes exactly that offer.
- other — everything else: narration, description of what exists, tool errors, status commentary, lead-in fragments that only introduce what follows, questions that ask for nothing. Advice on how things SHOULD be (the assistant's "should"/"where it can be" guidance) is never other.

For request and assent, label is required. Make it a concise imperative describing the actual work, not the conversational wrapper. Do not copy markdown menus, selected-option prefixes, or tool-result envelopes into labels. A user_answer is a response to the preceding dialog: classify it as assent, correction, or answer, never as request merely because the selected option contains an imperative.

Rules: label every fragment exactly once; one message can carry different acts, so judge each fragment on its own wording; a fragment answers an offer only if it approves it; a fragment that only reports or describes never becomes a rule.`;
