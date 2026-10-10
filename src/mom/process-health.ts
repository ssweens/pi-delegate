import type { FeedEvent } from "./feed.ts";
import type { WorkGraph } from "./graph.ts";

export const PROCESS_RISK_CLASSES = ["compaction_decisions", "uncommitted_work", "purpose_drift", "repeated_fix_failure",
	"stalled_backlog", "unresolved_backlog_close", "heads_up", "worth_considering"] as const;
export type ProcessRiskClass = typeof PROCESS_RISK_CLASSES[number];
export interface ProcessNotice {
	text: string;
	riskClass: ProcessRiskClass;
	target: string;
	riskRefs: string[];
	actionRefs: string[];
	nextRequest?: boolean;
}
export interface ProcessResolution { riskClass: ProcessRiskClass; target: string; resolutionRefs: string[] }
export interface FindingFeedback { action: "understood" | "dismiss" | "incorrect" | "ignored" | "backoff"; riskRefs: string[] }
// `explained` and `asked` are legacy record values: her sidecar keeps reading them, nothing writes them now.
export const FINDING_ACTIONS = ["delivered", "understood", "dismiss", "incorrect", "discuss", "explained", "asked", "ignored", "backoff"] as const;
export type FindingAction = typeof FINDING_ACTIONS[number];
export interface Engagement {
	counts: Record<Exclude<FindingAction, "delivered"> | "shown", number>;
	ignoredStreak: number;
	remaining: number;
	last?: { key: string; riskRefs: string[] };
	active?: { key: string; riskRefs: string[]; parent: string | null };
}
export const emptyEngagement = (): Engagement => ({ counts: { shown: 0, understood: 0, dismiss: 0, incorrect: 0,
	discuss: 0, explained: 0, asked: 0, ignored: 0, backoff: 0 }, ignoredStreak: 0, remaining: 0 });

/** Replay local interaction receipts. Ignoring a card changes interruption frequency, never the work map. */
export function recordEngagement(state: Engagement, action: FindingAction, key: string, note: ProcessNotice | undefined,
	parent: string | null, presented = false): void {
	if (action === "delivered" || action === "backoff") {
		if (note) state.last = { key, riskRefs: [...note.riskRefs] };
		delete state.active;
		if (action === "backoff") { state.counts.backoff++; state.remaining = Math.max(0, state.remaining - 1); }
		else if (presented && note) { state.counts.shown++; state.active = { key, riskRefs: [...note.riskRefs], parent }; }
		return;
	}
	state.counts[action]++;
	delete state.active;
	if (action === "ignored") {
		state.ignoredStreak = Math.min(4, state.ignoredStreak + 1);
		state.remaining = 2 ** state.ignoredStreak;
	} else { state.ignoredStreak = 0; state.remaining = 0; }
}

/** Identity is entirely host-derived. Model wording and citations cannot create a new occurrence. */
export const processNoticeKey = (value: Pick<ProcessNotice, "riskClass" | "target">) => `${value.riskClass}:${value.target}`;

/** Feedback silences this evidence, not every future concern about the same work. */
export function feedbackApplies(feedback: FindingFeedback | undefined, note: ProcessNotice): boolean {
	return Boolean(feedback && note.riskRefs.every(ref => feedback.riskRefs.includes(ref)));
}

const forbidden = /\b(cursor|gap|endeavou?r|source ref(?:erence)?|commit_graph|sidecar|checkpoint)\b/i;
const visible = (event: FeedEvent | undefined) => Boolean(event && (event.kind === "compaction" ||
	(event.text && ["user", "user_answer", "assistant", "tool_result", "shell_result"].includes(event.kind))));
const userAuthority = (event: FeedEvent | undefined) => Boolean(event?.actor === "lead" && ["user", "user_answer"].includes(event.kind));

/**
 * Enforce only host-provable protocol facts: identity, target ownership, visible and
 * fresh evidence, class-specific source shape, authority presence, and plain output.
 * Mom remains responsible for judging whether prose actually proves a consequential
 * risk and supports the proposed action; keyword matching cannot establish that.
 */
export function validateProcessNotice(note: ProcessNotice, graph: WorkGraph, known: ReadonlyMap<string, FeedEvent>, fresh: ReadonlySet<string>, compactionReview: boolean): void {
	const target = graph.nodes.find(node => node.id === note.target && ["feature", "theory", "postulate", "try"].includes(node.kind));
	if (!target) throw new Error("Process notice target must be an existing work center.");
	if (!note.riskRefs.length || !note.actionRefs.length || new Set(note.riskRefs).size !== note.riskRefs.length || new Set(note.actionRefs).size !== note.actionRefs.length) {
		throw new Error("Process notice needs distinct current references for both the consequential risk and an actionable next step.");
	}
	for (const ref of [...note.riskRefs, ...note.actionRefs]) if (!visible(known.get(ref))) throw new Error("Process notice references must name visible current evidence.");
	if (!note.riskRefs.some(ref => fresh.has(ref))) throw new Error("Process notice risk must include new evidence from this update; changed wording cannot reopen or repeat it.");
	if (note.riskClass === "compaction_decisions") {
		if (!compactionReview || !note.riskRefs.some(ref => fresh.has(ref) && known.get(ref)?.kind === "compaction")) throw new Error("Compaction risk requires the current compaction result.");
		if (note.riskRefs.length < 2) throw new Error("Compaction risk needs both the current compaction and the consequential decision evidence.");
	} else {
		if (note.riskClass === "repeated_fix_failure" && note.riskRefs.filter(ref => known.get(ref)?.kind === "assistant").length < 2) throw new Error("Repeated failure needs at least two distinct observed attempts.");
		if (["uncommitted_work", "purpose_drift"].includes(note.riskClass) && note.riskRefs.length < 2) throw new Error("Process risk needs evidence of both the governing work and the current problem.");
	}
	if (note.riskClass === "uncommitted_work" && !note.actionRefs.some(ref => userAuthority(known.get(ref)))) {
		throw new Error("Uncommitted-work advice needs visible user authority for the proposed commit action.");
	}
	if (note.riskClass === "purpose_drift" && target.purposeSource && !note.riskRefs.includes(target.purposeSource)) throw new Error("Purpose drift must cite the affected work's current grounded purpose.");
	const text = note.text.trim();
	if (!text || text !== note.text || /[\[\]{}]/.test(text) || forbidden.test(text)) {
		throw new Error("Process notice must be plain English without internal terms or citation syntax.");
	}
}

/** Resolution is explicit, identity-matched, visible, and fresh; Mom judges whether it semantically ended the risk. */
export function validateProcessResolution(resolution: ProcessResolution, unresolved: ReadonlySet<string>, known: ReadonlyMap<string, FeedEvent>, fresh: ReadonlySet<string>): void {
	const key = processNoticeKey(resolution);
	if (!unresolved.has(key)) throw new Error("Only an unresolved process risk can be resolved.");
	if (!resolution.resolutionRefs.length || new Set(resolution.resolutionRefs).size !== resolution.resolutionRefs.length || !resolution.resolutionRefs.some(ref => fresh.has(ref))) {
		throw new Error("Process risk resolution needs new current evidence.");
	}
	for (const ref of resolution.resolutionRefs) if (!visible(known.get(ref))) throw new Error("Process risk resolution references must name visible evidence.");
}
