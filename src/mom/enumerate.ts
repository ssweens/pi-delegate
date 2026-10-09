import { CANDIDATE_LIMIT, QUOTE_LIMIT, type Candidate, type CandidateKind, type ChangeState, type Proposed } from "./candidate.ts";
import type { FeedEvent } from "./feed.ts";
import { isEndeavor, type GraphNode, type WorkGraph } from "./graph.ts";
import { stampSourceRole } from "./provenance.ts";

export interface EnumerationResult {
	candidates: Candidate[];
	/** Prior conversational evidence; never enumerated as new work or completion evidence. */
	context: FeedEvent[];
}

const dialogs = new Set(["ask_user", "gather_input"]);
const constraint = /\b(must|should|always|never|only|do not|don't|keep|ensure|make sure|required)\b/i;
const advice = /\b(recommend|suggest|would|could|should|must|need to|ought to|i['’]d|i can draft|want me to)\b/i;
const request = /^(?:(?:ok[, ]+|please |just |now[, ]+|then )*)(?:(?:can|could|would|will) you\b|(?:help|give|take|break|run|build|add|remove|delete|implement|fix|update|create|show|explain|verify|check|write|use|make|replace|investigate|assess|think)\b)|\?\s*$/i;
const completion = /\b(done|complete[d]?|finished|settled|fixed|removed|deleted|implemented|reworked|verified|passes|passed)\b/i;
const negative = /\b(not|never|no|haven['’]t|hasn['’]t|isn['’]t|didn['’]t|cannot|can['’]t|failed|pending|unverified)\b/i;
const evidence = /\b(tests?|checks?|verifier|browser|verified|rechecking)\b.*\b(pass(?:ed|es)?|green|no|verified)\b|\b(pass(?:ed|es)?|verified)\b.*\b(tests?|checks?|verifier|browser)\b|\b(?:removed|deleted|wrote|implemented|reworked)\b.+(?:`|\/)|`[^`]+`\s+(?:is gone|no longer exists)/i;
const pivot = /\b(pause|park|defer|stop|resume|reopen|restart|return to|switch to)\b/i;
// Attach only on a complete user-visible label mention (longest label wins). Short internal IDs
// are not evidence that a conversational noun is the saved work's subject.
function priorNode(text: string, nodes: readonly GraphNode[]): GraphNode | undefined {
	const lower = text.toLowerCase();
	let best: GraphNode | undefined, score = 0, tied = false;
	for (const node of nodes) {
		const label = node.label.toLowerCase();
		const next = lower.includes(label) ? label.length : 0;
		if (next > score) { best = node; score = next; tied = false; }
		else if (next && next === score) tied = true;
	}
	return tied ? undefined : best;
}

// Both roles split at line and sentence boundaries, so a quote is a whole claim rather than a paragraph prefix. Every user fragment counts ("Yes" can be a request); assistant
// headings, table rows and fragments under four words are not claims the model could select.
function fragments(text: string, user: boolean): string[] {
	// Fenced code/diagrams are artifacts, not independent narrative claims; retain only prose outside fences.
	const prose = text.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\S\n]*(?=\n|$)|$)/g, "\n");
	return prose.split(/\n+|(?<=[.!?])\s+(?=[\p{L}*`])/u).map(part => part.trim().replace(/^(?:[-*]|\d+[.)])\s+/, "").replace(/^\*\*([^*]+)\*\*\s*/, "$1 "))
		.filter(part => /[\p{L}\p{N}]/u.test(part) && (user || (!part.startsWith("|") && !/[:\uff1a]$/.test(part) && part.split(/\s+/).length >= 4)));
}

/** Count the same source fragments the enumerator will stage, without constructing candidates. */
export function candidateCount(events: readonly FeedEvent[]): number {
	let count = 0;
	for (const event of events) {
		const user = event.actor === "lead" && (event.kind === "user" || event.kind === "user_answer");
		const assistant = event.actor === "lead" && event.kind === "assistant" && (event.status === undefined || event.status === "stop");
		if (user || assistant) count += fragments(event.text ?? "", user).length;
		else if (event.kind === "delegate_receipt" || (event.kind === "tool_result" && event.isError === true)
			|| (event.kind === "tool_call" && dialogs.has(event.name?.split(".").at(-1) ?? ""))) count++;
	}
	return count;
}

/** Pure preparation: current narrative only. Saved obligations remain inline in the saved map. */
export function enumerateCandidates(previous: WorkGraph, events: readonly FeedEvent[], known: ReadonlyMap<string, FeedEvent>, history: readonly FeedEvent[] = events, options: { fullQuotes?: boolean } = {}): EnumerationResult {
	const pending: Omit<Candidate, "source_role">[] = [];
	const current = new Set(events.map(event => event.ref));
	const antecedents = new Map<string, FeedEvent>(), calls = new Map<string, FeedEvent>();
	let preceding: FeedEvent | undefined;
	// Associate conversational replies by branch order, not by guessing whether a word means approval.
	for (const event of history) {
		if (event.actor !== "lead") continue;
		if (event.kind === "tool_call" && event.callId && dialogs.has(event.name?.split(".").at(-1) ?? "")) calls.set(event.callId, event);
		if (event.kind === "user" || event.kind === "user_answer") {
			const antecedent = event.kind === "user_answer" ? calls.get(event.callId ?? "") : preceding;
			if (current.has(event.ref) && antecedent) antecedents.set(event.ref, antecedent);
			preceding = undefined;
		} else if (event.kind === "assistant" && (event.status === undefined || event.status === "stop")) preceding = event;
	}
	const context = [...new Map([...antecedents.values()].filter(event => !current.has(event.ref)).map(event => [event.ref, event])).values()];
	const emit = (kind: CandidateKind, event: FeedEvent, text: string, prior_ref: string | null = null, proposed: Proposed = null) => {
		const antecedent = antecedents.get(event.ref);
		pending.push({ id: `c${String(pending.length + 1).padStart(2, "0")}`, kind, source: event.ref, source_kind: event.kind,
			quote: options.fullQuotes ? text.trim() : text.trim().slice(0, QUOTE_LIMIT).trimEnd(), prior_ref, proposed,
			...(antecedent ? { antecedent_ref: antecedent.ref } : {}) });
	};
	for (const event of events) {
		const user = event.actor === "lead" && (event.kind === "user" || event.kind === "user_answer");
		// Missing stop metadata is allowed for text-only feeds; toolUse, aborted and error text is not final.
		const assistant = event.actor === "lead" && event.kind === "assistant" && (event.status === undefined || event.status === "stop");
		const receipt = event.kind === "delegate_receipt";
		const error = event.kind === "tool_result" && event.isError === true;
		const question = event.kind === "tool_call" && dialogs.has(event.name?.split(".").at(-1) ?? "");
		if (!user && !assistant && !receipt && !error && !question) continue;
		if (receipt || error || question) {
			// Receipts without text retain an empty quote; errors prefer the first diagnostic line over preceding successes.
			const text = event.text ?? "";
			const diagnostic = error ? text.split("\n").find(line => /\b(error|fail(?:ed|ure)?|cannot|could not)\b/i.test(line)) : undefined;
			emit("note_add", event, diagnostic ?? text);
			continue;
		}
		for (const text of fragments(event.text ?? "", user)) {
			const node = priorNode(text, previous.nodes);
			// State changes require a named saved endeavor; assistant completion additionally needs concrete evidence.
			if (node && isEndeavor(node) && !negative.test(text)) {
				let to: ChangeState | undefined;
				if (completion.test(text) && (user || evidence.test(text))) to = "settled";
				else if (user && pivot.test(text)) to = /\b(resume|reopen|restart|return to|switch to)\b/i.test(text) ? "active" : "parked";
				if (to && to !== node.state) { emit("status_change", event, text, node.id, { from: node.state, to }); continue; }
			}
			// Evidenced reports without a named prior remain notes, even when followed by advice in the same paragraph.
			if (assistant && /^(?:\*\*)?(?:done|completed?|finished|verified|reworked|implemented|removed|deleted)\b|^I (?:have )?(?:removed|deleted|implemented|reworked|verified)\b/i.test(text) && evidence.test(text)) {
				emit("note_add", event, text, node?.id ?? null); continue;
			}
			// Explicit user constraints become rules; assistant advice/imperatives are stamped down to suggestions.
			if ((user && constraint.test(text)) || (assistant && (advice.test(text) || request.test(text) || /^(always|never|do not|don't|ensure|keep)\b/i.test(text)))) {
				// A rule on an endeavor governs it (scope, no prior_ref); on a saved note it updates that note within its parent's scope.
				emit("rule", event, text, node && !isEndeavor(node) ? node.id : null, { scope: node ? isEndeavor(node) ? node.id : node.parent ?? "root" : "root" });
			// Imperatives and questions request work; descriptive user text and assistant reports remain notes.
			} else emit(user && request.test(text) ? "new_work" : "note_add", event, text, node?.id ?? null);
		}
	}
	if (pending.length > CANDIDATE_LIMIT) throw new Error(`Candidate limit exceeded: ${pending.length} candidates (maximum ${CANDIDATE_LIMIT}); nothing was truncated.`);
	return { candidates: stampSourceRole(pending, known), context };
}
