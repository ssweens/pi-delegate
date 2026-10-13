import type { SessionBeforeCompactEvent, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import { extractEvents, renderEvents, type Entry, type FeedEvent } from "./feed.ts";
import { makeRef } from "../util/ref.ts";

export interface PendingCompactionReview {
	sessionId: string;
	firstKeptEntryId: string;
	rawEntries: Entry[];
	rawEvents: FeedEvent[];
	historyEvents: FeedEvent[];
}

export interface CompactionReview {
	kind: "compaction_review";
	summary: string;
	firstKeptEntryId: string;
	triggerRef: string;
	triggerEvent: FeedEvent;
	rawReplacedEvents: string;
	rawEntryCount: number;
	rawEventCount: number;
	omittedRawEventCount: number;
	historyEvents: FeedEvent[];
}

/** Capture the exact selected-branch entries replaced by this compaction before Pi mutates context. */
export function prepareCompactionReview(event: SessionBeforeCompactEvent, sessionId: string): PendingCompactionReview {
	const entries = event.branchEntries as Entry[];
	const end = entries.findIndex(entry => entry.id === event.preparation.firstKeptEntryId);
	if (end < 0) throw new Error("Compaction's first kept entry is absent from its source branch.");
	let start = 0;
	for (let i = entries.length - 1; i >= 0; i--) if (entries[i].type === "compaction") {
		const previousFirstKept = entries[i].firstKeptEntryId;
		if (typeof previousFirstKept !== "string") throw new Error("Previous compaction is missing its first kept entry.");
		start = entries.findIndex((entry, index) => index <= i && entry.id === previousFirstKept);
		if (start < 0) throw new Error("Previous compaction's first kept entry is absent from its source branch.");
		break;
	}
	if (start > end) throw new Error("Compaction's first kept entry precedes the previous compaction boundary.");
	const rawEntries = entries.slice(start, end);
	const stream = { key: sessionId, actor: "lead" };
	return { sessionId, firstKeptEntryId: event.preparation.firstKeptEntryId, rawEntries,
		rawEvents: rawEntries.flatMap(entry => extractEvents(stream, entry)),
		historyEvents: entries.flatMap(entry => extractEvents(stream, entry)) };
}

/** Bind the successful provider result to the immutable raw segment captured by the before hook. */
export function finishCompactionReview(pending: PendingCompactionReview, event: SessionCompactEvent): CompactionReview {
	if (event.compactionEntry.firstKeptEntryId !== pending.firstKeptEntryId) {
		throw new Error("Compaction result does not match the raw segment captured before compaction.");
	}
	const triggerRef = makeRef(pending.sessionId, event.compactionEntry.id);
	const triggerEvent = { ref: triggerRef, at: event.compactionEntry.timestamp, actor: "lead", kind: "compaction", claim: event.compactionEntry.summary ?? "" };
	return { kind: "compaction_review", summary: event.compactionEntry.summary ?? "", firstKeptEntryId: pending.firstKeptEntryId,
		triggerRef, triggerEvent, rawReplacedEvents: renderEvents(pending.rawEvents), rawEntryCount: pending.rawEntries.length, rawEventCount: pending.rawEvents.length,
		omittedRawEventCount: 0, historyEvents: [...pending.historyEvents, triggerEvent] };
}

/**
 * The review of a compaction Pi recorded in the lead's session file, as oven reads it: the branch before
 * the compaction entry is the history it replaced (what `prepareCompactionReview` captured live).
 */
export function reviewFromSession(branch: readonly Entry[], sessionId: string, compactionId: string): CompactionReview {
	const at = branch.findIndex(entry => entry.id === compactionId);
	const compaction = branch[at];
	if (at < 0 || compaction?.type !== "compaction" || typeof compaction.firstKeptEntryId !== "string") throw new Error(`No compaction ${compactionId} on the lead's branch.`);
	const pending = prepareCompactionReview({ branchEntries: branch.slice(0, at), preparation: { firstKeptEntryId: compaction.firstKeptEntryId } } as any, sessionId);
	return finishCompactionReview(pending, { compactionEntry: compaction } as any);
}
