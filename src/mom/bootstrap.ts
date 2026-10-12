// Cold-start bootstrap. A long backlog must not become one Mom proposal per 24,000-character
// capture window: that window is a per-call context guard, not a schedule. Instead, walk the
// branch locally (no model calls), segment on compaction boundaries into chapters, extract a
// fixed schema per chapter with source pointers, and hand Mom ONE bounded chapter-chain digest.
//
// Design follows the thread-map skill: normalize first, segment on compaction, extract state not
// prose, and treat every compaction summary as a claim rather than truth. The host performs no
// semantic judgment here — it emits recorded facts with pointers; Mom synthesizes the graph.
//
// Cut safety: the digest always describes exactly the evidence the feed drained, and the returned
// cut is the drain's own cut. Coverage is therefore never claimed beyond processed evidence, and
// worker cursors keep matching the drained end.
import type { Cut, FeedEvent } from "./feed.ts";

export interface BootstrapPolicy {
	/**
	 * Target chapters (compaction-bounded segments) per digest batch. This is a TARGET, not a hard
	 * maximum: the drain stops at a capture-window boundary after the target is crossed, so the
	 * emitted count is target + the chapters inside that crossing window. Enforcing an exact cap
	 * would require rewinding the feed mid-window (cut surgery), which risks skipping worker
	 * evidence. The digest's character bound IS hard.
	 */
	maxChapters: number;
	/** Hard bound on digest characters, so one model message stays inside the context guard.
	 *  Must match --mom-bootstrap-chars' default (mom/index.ts); one source of truth for the cap. */
	maxDigestChars: number;
	/** Safety net on local drain windows. Each window is one 24,000-character capture. */
	maxWindows: number;
}
export const DEFAULT_BOOTSTRAP_POLICY: BootstrapPolicy = { maxChapters: 24, maxDigestChars: 48000, maxWindows: 400 };

export interface ChapterDirection { ref: string; text: string }
/** A lead direction, or the assistant text that closed a turn (its reported outcome), in recorded order. */
export interface ChapterBeat extends ChapterDirection { kind: "direction" | "outcome" }
export interface ChapterFile { ref: string; path: string; operations: Map<string, number> }
export interface Chapter {
	index: number;
	startRef: string;
	endRef: string;
	entries: number;
	narrativeChars: number;
	workersSettled: number;
	/**
	 * Every lead direction, each followed by the assistant text that closed its turn: the thread-map pairing of
	 * what was asked with what was reported done. The block keeps the first and last direction and the chapter's
	 * last outcome longest; a summary claim (often a provider placeholder) never stands in for them.
	 */
	beats: ChapterBeat[];
	closingCompactions: number;
	handoffs: ChapterDirection[];
	files: ChapterFile[];
	lastTodo?: ChapterDirection;
	closingClaim?: ChapterDirection;
}
export interface BootstrapDigest {
	text: string;
	cut: Cut;
	chapters: number;
	/** Chapters emitted above `maxChapters`, caused by the crossing window. Zero when the target is not crossed. */
	overshoot: number;
	coveredThroughRef: string;
	windows: number;
	/** Evidence remained beyond the drain: the caller must keep catching up, not claim it. */
	remainingMore: boolean;
	/** Accepted prefix only: strict rebuild may have read a further window that would not fit. */
	drainedCount: number;
}

const DIRECTION_CHARS = 320;
const OUTCOME_CHARS = 700;
const CLAIM_CHARS = 800;
const ASSISTANT_CHARS = 1600;

const isCompaction = (event: FeedEvent) => event.actor === "lead" && event.kind === "compaction";
const isDirection = (event: FeedEvent) => event.actor === "lead" && (event.kind === "user" || event.kind === "user_answer");
const isDelegateTool = (event: FeedEvent) => event.actor === "lead" && event.kind === "tool_call" && Boolean(event.name?.includes("delegate"));
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
/** The file an edit or write call names. Sessions rarely carry `file_op` entries; the calls themselves do. */
function writtenPath(event: FeedEvent): string | undefined {
	if (event.actor !== "lead" || event.kind !== "tool_call" || !/^(edit|write)$/i.test(event.name ?? "") || !event.text) return undefined;
	const match = /"path":("(?:[^"\\]|\\.)*")/.exec(event.text);
	try { return match ? JSON.parse(match[1]) as string : undefined; } catch { return undefined; }
}
const clamp = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`);

/** Chapters break on compaction entries; the compaction event closes the chapter it ends. */
export function segmentChapters(events: readonly FeedEvent[]): Chapter[] {
	const chapters: Chapter[] = [];
	let current: Chapter | undefined;
	/** The latest assistant text of the open turn: its outcome once the next direction or the chapter's end closes it. */
	let report: ChapterDirection | undefined;
	const close = () => { if (report) current!.beats.push({ kind: "outcome", ...report }); report = undefined; };
	// A run reports once per segment: a joined result and its completion notice are the same receipt.
	const receipts = new Set<string>();
	for (const event of events) {
		if (!current) {
			current = { index: chapters.length + 1, startRef: event.ref, endRef: event.ref, entries: 0,
				narrativeChars: 0, workersSettled: 0, beats: [], closingCompactions: 0, handoffs: [], files: [] };
		}
		current.entries++;
		current.narrativeChars += event.text?.length ?? 0;
		const receipt = event.kind === "delegate_receipt" ? `${event.name}#${event.segment ?? ""}` : undefined;
		const repeat = receipt !== undefined && receipts.has(receipt);
		if (receipt) receipts.add(receipt);
		if (!repeat && event.kind === "delegate_receipt" && (event.status === "complete" || event.status === "settled")) current.workersSettled++;
		if (!repeat && (event.kind === "delegate_receipt" || isDelegateTool(event))) current.handoffs.push({ ref: event.ref,
			text: [event.name, event.status].filter(Boolean).join(" ") || event.kind });
		const path = event.kind === "file_op" ? event.text : writtenPath(event);
		if (path) {
			let file = current.files.find(item => item.path === path);
			if (!file) { file = { ref: event.ref, path, operations: new Map() }; current.files.push(file); }
			const operation = (event.kind === "file_op" ? event.name : event.name?.toLowerCase()) ?? "unknown";
			file.operations.set(operation, (file.operations.get(operation) ?? 0) + 1);
		}
		if (event.kind === "todo") current.lastTodo = { ref: event.ref, text: event.text || "(empty todo state)" };
		if (event.actor === "lead" && event.kind === "assistant" && event.text) report = { ref: event.ref, text: event.text };
		if (isCompaction(event)) {
			current.closingCompactions++;
			if (event.claim) current.closingClaim = { ref: event.ref, text: event.claim };
		}
		if (isDirection(event) && event.text) { close(); current.beats.push({ kind: "direction", ref: event.ref, text: event.text }); }
		current.endRef = event.ref;
		if (isCompaction(event)) { close(); chapters.push(current); current = undefined; }
	}
	if (current) { close(); chapters.push(current); }
	return chapters;
}

/**
 * One chapter under a character budget. Lines are emitted in chronological order but trimmed by
 * class, not position: TODO@end, the closing CLAIM and the first and last directions are never
 * dropped; then files go before handoffs, handoffs before directions, directions before turn
 * outcomes, and the chapter's last outcome last of all, oldest first within a class. Trimming a
 * line never drops a chapter, so the cut still covers everything emitted.
 */
const TRIM_ORDER = ["file", "handoff", "direction", "outcome", "end"] as const;
type TrimClass = typeof TRIM_ORDER[number];
interface BlockLine { text: string; cls?: TrimClass; rank: number }

function chapterBlock(chapter: Chapter, budget: number): string {
	const lines: BlockLine[] = [{ text: `Chapter ${chapter.index} · entries ${chapter.entries} · narrative ${chapter.narrativeChars} chars · workers settled ${chapter.workersSettled} · compactions ${chapter.closingCompactions}`, rank: 0 }];
	const cite = (label: string, item: ChapterDirection, limit = DIRECTION_CHARS) => `  ${label} [src:${item.ref}] ${clamp(flat(item.text), limit)}`;
	const directions = chapter.beats.filter(beat => beat.kind === "direction"), outcomes = chapter.beats.filter(beat => beat.kind === "outcome");
	const first = directions[0], last = directions.at(-1), end = outcomes.at(-1);
	chapter.beats.forEach((beat, i) => lines.push(beat.kind === "direction"
		? { text: cite(beat === first ? "first direction" : beat === last ? "last direction" : "direction", beat), ...(beat === first || beat === last ? {} : { cls: "direction" }), rank: i }
		: beat === end ? { text: cite("last outcome (reported)", beat, ASSISTANT_CHARS), cls: "end", rank: i }
			: { text: cite("outcome (reported)", beat, OUTCOME_CHARS), cls: "outcome", rank: i }));
	chapter.handoffs.forEach((handoff, i) => lines.push({ text: cite("delegate handoff", handoff), cls: "handoff", rank: i }));
	chapter.files.forEach((file, i) => lines.push({ text: `  file [src:${file.ref}] ${file.path} (${[...file.operations].map(([op, count]) => `${op}×${count}`).join(", ")})`, cls: "file", rank: i }));
	if (chapter.lastTodo) lines.push({ text: cite("TODO@end", chapter.lastTodo), rank: 0 });
	if (chapter.closingClaim) {
		// The closing claim is the provider's summary: context for the chapter, never citable evidence. A remote
		// compaction's placeholder says nothing about the chapter, so only its presence is recorded.
		const placeholder = /remote compaction applied/i.test(chapter.closingClaim.text);
		lines.push({ text: placeholder ? "  CLAIM(placeholder — no content)" : `  CLAIM ${clamp(flat(chapter.closingClaim.text), CLAIM_CHARS)}`, rank: 0 });
	}
	const omitted: Record<TrimClass, number> = { file: 0, handoff: 0, direction: 0, outcome: 0, end: 0 };
	const render = (kept: BlockLine[]) => {
		const out = kept.map(line => line.text);
		const notes = [omitted.direction ? `${omitted.direction} lead directions` : "", omitted.outcome + omitted.end ? `${omitted.outcome + omitted.end} turn outcomes` : "",
			omitted.handoff ? `${omitted.handoff} delegate handoffs` : "", omitted.file ? `${omitted.file} files touched` : ""].filter(Boolean);
		if (notes.length) out.splice(1, 0, `  … ${notes.join(", ")} omitted for budget`);
		return out.join("\n");
	};
	const kept = [...lines];
	const order = (line: BlockLine) => line.cls === undefined ? Number.POSITIVE_INFINITY : TRIM_ORDER.indexOf(line.cls) * 1e6 + line.rank;
	while (render(kept).length > budget) {
		let drop = -1;
		kept.forEach((line, i) => { if (line.cls && (drop < 0 || order(line) < order(kept[drop]))) drop = i; });
		if (drop < 0) break;
		omitted[kept[drop].cls!]++;
		kept.splice(drop, 1);
	}
	return render(kept);
}

/**
 * Emits exactly the chapters given, each bounded, so the text can never outgrow the guard. Budget
 * is fair-shared by demand: a chapter that fits keeps its full block and its surplus flows to the
 * chapters that need trimming, so a 37-direction chapter is not held to the same characters as a
 * 2-direction one.
 */
export function chapterDigest(chapters: readonly Chapter[], policy: BootstrapPolicy): string | undefined {
	const header = "BOOTSTRAP CHAPTER CHAIN — recorded evidence compressed by the host with source pointers. No semantic judgment is added; synthesize the work map from these directions, the outcome each turn reported, files and todo states. Each separately requested piece of work is its own item. Outcomes are the assistant's reports, not verification; closing CLAIM lines are provider summaries for orientation and carry no citable source.";
	const full = chapters.map(chapter => chapterBlock(chapter, Number.POSITIVE_INFINITY));
	let remaining = policy.maxDigestChars - header.length - 2 * (chapters.length + 1), left = chapters.length;
	const budgets = new Array<number>(chapters.length);
	for (const i of full.map((_, i) => i).sort((a, b) => full[a].length - full[b].length)) {
		budgets[i] = Math.min(full[i].length, Math.floor(remaining / left));
		remaining -= budgets[i]; left--;
	}
	const lines = [header, ""];
	chapters.forEach((chapter, i) => lines.push(budgets[i] >= full[i].length ? full[i] : chapterBlock(chapter, budgets[i]), ""));
	const text = lines.join("\n");
	return text.length > policy.maxDigestChars ? undefined : text; // caller keeps the ordinary path
}

/** A feed shape sufficient for bootstrap: local capture windows plus citation resolution. */
export interface BootstrapFeed {
	capture(limit?: number, deferRunningWorkers?: boolean): Promise<{ events: FeedEvent[]; cut: Cut; more: boolean }>;
	readonly events: readonly FeedEvent[];
}

/**
 * Drain the backlog locally, then return one bounded digest plus the drain's own cut. Stops at the
 * chapter bound, at the window safety net, or when the transcript is exhausted. Returns undefined
 * when the digest cannot be bounded or the backlog is not a backlog, so the caller keeps the
 * ordinary per-window path.
 */
export async function bootstrapDigest(feed: BootstrapFeed, firstMore: boolean, policy: BootstrapPolicy, fromIndex = 0, singleWindowCut?: Cut): Promise<BootstrapDigest | undefined> {
	// An explicit rebuild never drops directions to make a digest fit. Keep the last fully
	// represented capture window, then resume from its cut in the next operation. A long
	// chapter can therefore span several bounded, source-backed proposals.
	if (singleWindowCut) {
		const build = (cut: Cut, windows: number): BootstrapDigest | undefined => {
			const drained = feed.events.slice(fromIndex), segments = segmentChapters(drained);
			if (!segments.length) return undefined;
			const text = chapterDigest(segments, policy);
			if (!text || /^  … .* omitted for budget$/m.test(text)) return undefined;
			return { text, cut, chapters: segments.length, overshoot: Math.max(0, segments.length - policy.maxChapters),
				coveredThroughRef: segments.at(-1)!.endRef, windows, remainingMore: false, drainedCount: drained.length };
		};
		let best = build(singleWindowCut, 0);
		if (!best) return undefined;
		let more = firstMore, windows = 0;
		while (more && windows < policy.maxWindows && best.chapters <= policy.maxChapters) {
			const captured = await feed.capture(24000, true);
			windows++;
			more = captured.more && captured.events.length > 0;
			if (!captured.events.length) break;
			const next = build(captured.cut, windows);
			if (!next) break;
			best = next;
		}
		return { ...best, remainingMore: more || feed.events.length - fromIndex > best.drainedCount };
	}
	if (!firstMore) return undefined; // routine single-window updates keep raw evidence
	// Drain readable lead history even when a worker is live or unavailable. capture(..., true)
	// still defers worker reads; its cut never advances over that unobserved evidence.
	let more: boolean = firstMore, windows = 0, cut: Cut | undefined = singleWindowCut;
	// Count the chapters already present in the initial staged capture: the drain loop must not
	// resume from zero or it keeps draining past the target (the observed 26-vs-24 overshoot).
	let chapters = 0;
	for (const event of feed.events.slice(fromIndex)) if (isCompaction(event)) chapters++;
	while (more && windows < policy.maxWindows) {
		const captured = await feed.capture(24000, true);
		windows++;
		cut = captured.cut;
		more = captured.more && captured.events.length > 0;
		if (!captured.events.length) break;
		for (const event of captured.events) if (isCompaction(event)) chapters++;
		if (chapters > policy.maxChapters) break;
	}
	if (!cut) return undefined;
	// Segment only what THIS pass drained: a continuation digest must not re-describe chapters
	// its checkpoint already consumed.
	const drained = feed.events.slice(fromIndex);
	if (!drained.length) return undefined;
	const segments = segmentChapters(drained);
	if (!segments.length) return undefined;
	const text = chapterDigest(segments, policy);
	if (!text) return undefined;
	return { text, cut, chapters: segments.length, overshoot: Math.max(0, segments.length - policy.maxChapters),
		coveredThroughRef: segments.at(-1)!.endRef, windows, remainingMore: more, drainedCount: drained.length };
}
