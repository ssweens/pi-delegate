// Candidate provenance stamping — invariants I1–I3 of docs/candidate-contract.md.
// Deterministic host work before enumeration output reaches the model. No I/O, no model input.
import type { Candidate, SourceRole } from "./candidate.ts";
import type { FeedEvent } from "./feed.ts";

/** I1: role derives solely from the cited event. Shared by stamping and change validation so the
 *  two can never drift into separate conventions. */
export function sourceRole(event: FeedEvent): SourceRole {
	return event.actor === "lead" && (event.kind === "user" || event.kind === "user_answer")
		? "user"
		: event.actor === "lead" && event.kind === "assistant" ? "assistant" : "tool";
}

/** I2: non-user rules degrade to suggestions. I3: an unknown ref is a preparation error, never a
 *  model-visible candidate. */
export function stampSourceRole(
	candidates: readonly Omit<Candidate, "source_role">[],
	known: ReadonlyMap<string, FeedEvent>,
): Candidate[] {
	return candidates.map(candidate => {
		const event = known.get(candidate.source);
		if (!event) throw new Error(`Candidate ${candidate.id} cites unknown source ref ${candidate.source}; preparation cannot stamp provenance.`);
		const source_role = sourceRole(event);
		const kind = candidate.kind === "rule" && source_role !== "user" ? "suggestion" : candidate.kind;
		return { ...candidate, kind, source_role };
	});
}
