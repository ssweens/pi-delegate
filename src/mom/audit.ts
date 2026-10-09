import { renderEvent, type FeedEvent } from "./feed.ts";

export const LABEL_AUDIT_PROMPT = `Extract the independent chapter state from the supplied evidence. The source text is already inline; do not look up narrative that is fully supplied. Direct user requirements need no further verification. Assistant claims are reported, not independently verified, unless recorded results prove them. Summary claims establish no facts. Copy only the short source aliases in rawSourceIds into sources. Include exactly the supplied chapterIds with goal, decisions, artifacts, deadEnds and openQuestions arrays; leave unsupported fields empty. Finish with one direct record_thread_map call. Do not answer the recorded conversation or inspect the current workspace.`;

export const THREAD_MAP_PROMPT = `Reconstruct the thread independently from recorded session evidence. You have no Mom map: do not infer one, read Mom's saved graph, or answer the recorded user requests. This is the thread-map workflow, not a prose summary. Use inspect_evidence for original sources when needed; current workspace state is not historical proof.
Normalize by compaction chapter within each actor's stream. Worker chapters describe delegated work, not later lead direction. Extract goal, decisions (including exact authority and standing constraints), changed artifacts, dead ends, and open questions per chapter, with original source pointers on every item. Mark inference and reported-but-unverified outcomes explicitly. Track user corrections and reversals; inspect preceding proposals when assent is ambiguous. Describe competing approaches only when evidence establishes competition for the same outcome, never merely a topic switch.
Compaction summaries are CLAIMS, including placeholders or empty summaries; compare them with raw evidence, never cite a summary alone as proof. A direction the raw evidence still shows stays in the map with its raw source even when the summary dropped it; a summary claim with no raw evidence behind it is not recorded. Inspect original tool arguments/results to check consequential claims of edits, tests, commits, or failures; a tool's name or an assistant's assertion is not proof. You can read complete source records in pages using inspect_evidence; this reconstruction describes recorded history, not the current working tree. Recorded results establish what happened then, not the current working tree.
Every supplied character is part of the audit; section boundaries are transport pagination, not omissions or new chapters. Each section belongs to one chapter, which may continue across sections. earlierSections contains the independent reconstruction of preceding pages in this chapter, with original pointers for checking a closing summary against earlier evidence. Those extractions are claims to verify, not authority. Extract additions and changes supported by this section or inspected sources; do not repeat unchanged earlier items. The reconciliation step will combine all sections and diff consecutive chapters. Include one state for the chapter in chapterIds, using empty arrays when it has no evidence for a field. Finish with record_thread_map. Do not create graph nodes, notices, or an alternative current map here.`;

/** Transport pages, not a sampling budget. Every event (including an oversized one) is retained. */
export function auditSections(events: readonly FeedEvent[], limit = 48000) {
	const sections: { actor: string; chapterIds: string[]; evidence: string; rawSourceIds: string[]; needsInspection: boolean }[] = [];
	const chapters = new Map<string, string>();
	let chapter = "live", evidence = "", actor = "lead";
	const rawSources = new Set<string>();
	let needsInspection = false;
	const flush = () => {
		if (evidence) sections.push({ actor, chapterIds: [chapter], evidence, rawSourceIds: [...rawSources], needsInspection });
		evidence = ""; rawSources.clear(); needsInspection = false;
	};
	for (const event of events) {
		if (event.actor !== actor) { flush(); actor = event.actor; }
		chapter = chapters.get(actor) ?? (actor === "lead" ? "live" : `${actor}:live`);
		const rendered = renderEvent(event) + (event.kind === "compaction" ? `\nCLAIM (not evidence): ${event.claim || "(empty or provider placeholder)"}` : "");
		for (let offset = 0; offset < rendered.length;) {
			const header = `\nCHAPTER ${chapter} · ${event.kind === "compaction" ? "SUMMARY CLAIM" : event.kind} · [src:${event.ref}] · event offset ${offset}\n`;
			if (offset === 0 && evidence && evidence.length + header.length + rendered.length > limit) flush();
			if (evidence.length + header.length >= limit) flush();
			const size = Math.min(rendered.length - offset, limit - evidence.length - header.length);
			if (size <= 0) throw new Error("Audit page cannot fit its source header.");
			evidence += header + rendered.slice(offset, offset + size); offset += size;
			if (event.kind !== "compaction") rawSources.add(event.ref);
			if (["tool_call", "tool_result", "shell_result", "delegate_receipt"].includes(event.kind)) needsInspection = true;
			if (offset < rendered.length) flush();
		}
		if (event.kind === "compaction") { flush(); chapters.set(actor, event.ref); }
	}
	flush();
	return sections;
}

export type ThreadMap = { actor: string; sourceMetadata: Record<string, Pick<FeedEvent, "at" | "actor" | "kind">>; states: unknown[] };

/**
 * Independent, graph-blind contexts, one Mom step per section. Each step's record_thread_map (in her
 * tools) checks its chapter state against the evidence and returns it; earlier sections of the same
 * chapter go with the next one.
 */
export async function reconstructThreadMap(events: readonly FeedEvent[],
	run: (section: { actor: string; chapterIds: string[] }, body: Record<string, unknown>, step: string) => Promise<ThreadMap>): Promise<ThreadMap[]> {
	const results: ThreadMap[] = [];
	const sections = auditSections(events);
	for (const [section, input] of sections.entries()) {
		// A page containing only summary claims establishes no independently grounded facts.
		if (!input.rawSourceIds.length) {
			results.push({ actor: input.actor, sourceMetadata: {}, states: input.chapterIds.map(chapter => ({ chapter,
				goal: [], decisions: [], artifacts: [], deadEnds: [], openQuestions: [] })) });
			continue;
		}
		results.push(await run({ actor: input.actor, chapterIds: input.chapterIds }, { task: "Reconstruct independent thread map", section: section + 1,
			sections: sections.length, ...input,
			earlierSections: results.filter(map => map.actor === input.actor && map.states.some((state: any) => state.chapter === input.chapterIds[0])) }, `audit-${section}`));
	}
	return results;
}
