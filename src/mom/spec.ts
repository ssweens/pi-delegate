// The change spec: the questions the decision model answers about a batch, and the ops its answers
// become. The host owns every judgement about shape — which ops exist, when they fire, and what the
// big model may then do — and never interprets prose. Wording here is tuned, not chosen: it was fitted
// against 20 pairs with ground truth read off the v2 contract, and validated on 10 unseen pairs
// (`scripts/v2-spec-tune.mts`, docs/v2-change-spec.md).
//
// Measured (beverly-4B, 2026-10-10): tuning 83/83, holdout 25/30 — and the holdout is why only state
// changes and removals are strictly whitelisted downstream, while rule/note/child additions are
// permitted: `attach` scores 30/30 on the tuning set but 6/10 on unseen pairs.
import { parseDeciderAnswer, type DeciderAnswer, type DeciderQuestion } from "./decider.ts";
import { renderUpdateEvents, type FeedEvent } from "./feed.ts";
import type { SpecOp, V2Graph, V2Node } from "./v2.ts";

/** Below this, an answer is not a decision however it ranks. */
export const SPEC_FLOOR = 0.25;
/** New work is the probability MASS on the two names that mean it (`new_only` + `new_and_existing`),
 *  not an argmax: reading the winner took "Scrap the export entirely." for new work (`both` 0.46
 *  against `existing` 0.39) while genuine asks won a name by as little as 0.01.
 *
 *  The names themselves carry weight, which is why they are spelled out rather than named `work` and
 *  `both`: with `both` the model answered "two things are involved" — true of any instruction about
 *  the map — and the family did not separate at all (pooled gap -0.05 over 40 pairs). Renaming them
 *  to say what they mean, plus one clause in `new_only` that a stated need for something absent counts
 *  while a requirement on work that exists does not, moved the pooled gap positive and left the
 *  never-fitted sets well separated:
 *
 *    tuning 20   gap +0.010      holdout 10  gap +0.230      gap 10  gap +0.200      fresh2 8  gap +0.140
 *
 *  Pooled over all 48 pairs: least-true 0.56 ("Park the export for now. I need SSO login working
 *  before the demo.") against greatest-false 0.55 ("The export also needs to include the current
 *  filter state."). A 0.55 cutoff scores perfectly on all 48, which is exactly why 0.50 is used
 *  instead: it keeps 0.06 of slack to the hardest true case rather than 0.005, and costs two
 *  permissions, which is the safe side because of what the op does — `new_work` only *permits* one
 *  added work item, and an unused permission is logged as `unmet`, while a missed one can leave the
 *  user's request out of the map. */
export const SPEC_NEW_MASS = 0.5;
/** An attachment must beat "nothing attaches" by this much: a spurious child is a phantom work item. */
export const ATTACH_MARGIN = 0.05;

/** The map and the batch exactly as the decision model reads them. */
export function evidenceState(graph: V2Graph, events: readonly FeedEvent[]): string {
	const children = new Map<string | null, V2Node[]>();
	for (const node of graph.nodes) children.set(node.parent, [...(children.get(node.parent) ?? []), node]);
	const lines: string[] = [];
	const visit = (parent: string | null, depth: number) => {
		for (const node of children.get(parent) ?? []) {
			lines.push(`${"  ".repeat(depth)}- ${node.kind}${node.state ? ` [${node.state}]` : ""} ${node.id}: ${node.label}${node.id === graph.focus ? "  <-- current" : ""}`);
			visit(node.id, depth + 1);
		}
	};
	visit(null, 0);
	if (!lines.length) lines.push("(empty)");
	return `CURRENT WORK MAP\n${lines.join("\n")}\n\nNEW ACTIVITY IN THE SESSION\n${renderUpdateEvents(events)}`;
}

/** The state menu follows the node's current state: a settled node cannot be parked, and offering it
 *  let the model answer "deferred" about work nothing had touched. */
export function stateChoices(node: V2Node): Record<string, string> {
	const choices: Record<string, string> = { none: `It neither reports ${node.id} finished nor changes what happens to it — a partial result, an in-flight update, or a caveat about unfinished work is not a state change.` };
	if (node.state === "active") choices.finished = `The activity reports ${node.id} finished: a statement that its tests or checks pass, that it works, or that it is complete or shipped counts as finished, however brief. An open caveat does not count.`;
	if (node.state === "active") choices.deferred = `The user explicitly sets ${node.id} aside or parks it.`;
	if (node.state === "parked") choices.resumed = `The user picks ${node.id} back up as the thing to work on now.`;
	if (node.state === "settled") choices.reopened = `It rejects ${node.id}'s recorded outcome, or asks for work on ${node.id} the map records as finished.`;
	choices.dropped = `It abandons ${node.id} — not wanted, not shipping, to be scrapped — so it no longer belongs on the map.`;
	return choices;
}

export function attachChoices(node: V2Node): Record<string, string> {
	return { none: `Nothing attaches to ${node.id}.`,
		child: `The activity asks for work that belongs under ${node.id}, rather than as separate work.`,
		rule: `It sets, changes or lifts a standing rule for ${node.id} — an instruction meant to hold beyond this turn.`,
		note: `It establishes a decision or finding worth keeping about ${node.id} — a choice, a root cause, a measured result, a risk or a blocker — that the map does not record.` };
}

/** One choice per work node for its state, one for what attaches to it, and one for the user's own
 *  message. Focus is never asked: it follows from the ops (`specFocus`). */
export function specQuestions(graph: V2Graph): Record<string, DeciderQuestion> {
	const questions: Record<string, DeciderQuestion> = {
		new_work: { type: "choice", instructions: "What does the user's own message in this activity do?",
			criteria: { new_only: "It approves an offer of work, or names or states a need for work that no item on the map covers yet — a thing to build, add, fix or have (\"I need a way to export the audit trail\" names something to build). A message whose only content is an approval (\"yes, go ahead\", \"do it\", \"please\") is new work: nothing else in it asks about existing work. Saying yes to \"shall I do X\" is new work even when X will live under an item already on the map.",
				existing_only: "It asks only of work already on the map: to work on it, correct it, decide or choose between approaches for it, park, drop, set a rule for it, change what it must cover, or declare one existing item the priority over another. An urgent or imperative instruction about map work, and a request to get to work on an item already on the map, is still existing, not new work — choosing an approach for existing work is not new work, however decisive the phrasing.",
				new_and_existing: "It names new work that no item on the map covers AND also asks something of work already on the map — for instance parking or dropping existing work while requesting the new item. If it names no new item, it is existing, not both.",
				report_only: "It reports, acknowledges or confirms something that happened, or asks for an explanation of it. It asks for no change to the map.",
				nothing: "Nothing in it needs doing or deciding." } },
	};
	for (const node of graph.nodes.filter(entry => entry.kind === "work")) {
		questions[`state__${node.id}`] = { type: "choice", instructions: `Work item "${node.label}" is ${node.state}. What did the new activity do to its state?`, criteria: stateChoices(node) };
		questions[`attach__${node.id}`] = { type: "choice", instructions: `Beyond its state, what does the new activity add to work item "${node.label}"?`, criteria: attachChoices(node) };
	}
	return questions;
}

/** One answered question: the names it offered, best first, with their probabilities. */
export type SpecReading = Record<string, [string, number][]>;

/** The spec's ops, read off the answers by the same rules the tuning harness scored: an argmax above
 *  the floor for state and attachments, an attachment only with a margin over `none`, and new work by
 *  probability mass. */
export function specOps(graph: V2Graph, reading: SpecReading): { ops: SpecOp[]; chosen: Record<string, string> } {
	const top = (name: string): [string, number] | undefined => reading[name]?.[0];
	const ops: SpecOp[] = [], chosen: Record<string, string> = {};
	const newRead = reading.new_work ?? [];
	const mass = (newRead.find(([name]) => name === "new_only")?.[1] ?? 0) + (newRead.find(([name]) => name === "new_and_existing")?.[1] ?? 0);
	if (mass >= SPEC_NEW_MASS) ops.push({ kind: "new_work" });
	chosen.new_work = newRead[0]?.[0] ?? "none";
	for (const node of graph.nodes.filter(entry => entry.kind === "work")) {
		const state = top(`state__${node.id}`);
		const offered = stateChoices(node);
		// A name the node's own menu did not offer is not an answer to it, whatever the endpoint returns.
		const state0 = state && state[1] >= SPEC_FLOOR && state[0] in offered ? state[0] : "none";
		chosen[`state__${node.id}`] = state0;
		if (state0 !== "none") ops.push({ kind: "state", node: node.id, to: state0 as Extract<SpecOp, { kind: "state" }>["to"] });
		const attach = top(`attach__${node.id}`);
		const none = reading[`attach__${node.id}`]?.find(([name]) => name === "none")?.[1] ?? 0;
		const attach0 = attach && attach[1] >= SPEC_FLOOR && (attach[0] === "none" || attach[1] - none >= ATTACH_MARGIN) ? attach[0] : "none";
		chosen[`attach__${node.id}`] = attach0;
		if (attach0 !== "none") ops.push({ kind: "attach", node: node.id, attach: attach0 as Extract<SpecOp, { kind: "attach" }>["attach"] });
	}
	return { ops, chosen };
}

/** The most the decision model is shown for a spec. A larger batch goes to her model unchecked rather
 *  than truncated: a spec built from part of the evidence would reject the rest of it. */
export const SPEC_CHARS = 12000;

/** The client this needs: one call, answers by name (spec.ts stays clear of the transport). */
export interface SpecClient { ask(state: string, questions: Record<string, DeciderQuestion>): Promise<{ answers: Record<string, DeciderAnswer> }> }

/**
 * Ask the spec's questions and read the ops off the answers. Fail-open everywhere: no client, a failed
 * or slow endpoint, or a batch too large to show all return `undefined`, and her model then runs with
 * the structural checks alone. The spec can only ever narrow what her model may write — it is never
 * the thing that stops an update.
 */
export type SpecFailOpenReason = "no-client" | "oversized" | "incomplete" | "classifier-error";

export async function readSpec(client: SpecClient | undefined, graph: V2Graph, events: readonly FeedEvent[], onFailOpen?: (reason: SpecFailOpenReason) => void): Promise<{ ops: SpecOp[]; chosen: Record<string, string> } | undefined> {
	const failOpen = (reason: SpecFailOpenReason) => { try { onFailOpen?.(reason); } catch { /* diagnostics never close the fail-open path */ } return undefined; };
	if (!client) return failOpen("no-client");
	const state = evidenceState(graph, events);
	if (state.length > SPEC_CHARS) return failOpen("oversized");
	try {
		const questions = specQuestions(graph);
		const { answers } = await client.ask(state, questions);
		const reading: SpecReading = {};
		for (const [name, question] of Object.entries(questions)) {
			const answer = parseDeciderAnswer(question, answers[name]);
			if (!answer || answer.type !== "choice") return failOpen("incomplete");
			reading[name] = Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
		}
		// A partial or malformed round is not a spec. Reading a missing answer or probability as
		// "no change" could skip her model on evidence nobody judged, so fail the whole read open.
		return specOps(graph, reading);
	} catch { return failOpen("classifier-error"); }
}
