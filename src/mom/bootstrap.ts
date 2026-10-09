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
	/** Hard bound on digest characters, so one model message stays inside the context guard. */
	maxDigestChars: number;
	/** Safety net on local drain windows. Each window is one 24,000-character capture. */
	maxWindows: number;
}
export const DEFAULT_BOOTSTRAP_POLICY: BootstrapPolicy = { maxChapters: 24, maxDigestChars: 56000, maxWindows: 400 };

export interface ChapterDirection { ref: string; text: string }
export interface ChapterFile { ref: string; path: string; operations: Map<string, number> }
export interface Chapter {
	index: number;
	startRef: string;
	endRef: string;
	entries: number;
	narrativeChars: number;
	workersSettled: number;
	/** Every lead direction in order; the block keeps the first, the last, and as many recent ones as its budget allows. */
	directions: ChapterDirection[];
	closingCompactions: number;
	handoffs: ChapterDirection[];
	files: ChapterFile[];
	lastTodo?: ChapterDirection;
	closingClaim?: ChapterDirection;
	/** The last few lead assistant texts, most recent last: a provisional chapter's closing claim surrogate. */
	recentAssistants: ChapterDirection[];
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
}

const DIRECTION_CHARS = 320;
const RECENT_ASSISTANTS = 3;
const CLAIM_CHARS = 800;
const ASSISTANT_CHARS = 1600;

const isCompaction = (event: FeedEvent) => event.actor === "lead" && event.kind === "compaction";
const isDirection = (event: FeedEvent) => event.actor === "lead" && (event.kind === "user" || event.kind === "user_answer");
const isDelegateTool = (event: FeedEvent) => event.actor === "lead" && event.kind === "tool_call" && Boolean(event.name?.includes("delegate"));
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const clamp = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`);

/** Chapters break on compaction entries; the compaction event closes the chapter it ends. */
export function segmentChapters(events: readonly FeedEvent[]): Chapter[] {
	const chapters: Chapter[] = [];
	let current: Chapter | undefined;
	// A run reports once per segment: a joined result and its completion notice are the same receipt.
	const receipts = new Set<string>();
	for (const event of events) {
		if (!current) {
			current = { index: chapters.length + 1, startRef: event.ref, endRef: event.ref, entries: 0,
				narrativeChars: 0, workersSettled: 0, directions: [], closingCompactions: 0, handoffs: [], files: [], recentAssistants: [] };
		}
		current.entries++;
		current.narrativeChars += event.text?.length ?? 0;
		const receipt = event.kind === "delegate_receipt" ? `${event.name}#${event.segment ?? ""}` : undefined;
		const repeat = receipt !== undefined && receipts.has(receipt);
		if (receipt) receipts.add(receipt);
		if (!repeat && event.kind === "delegate_receipt" && (event.status === "complete" || event.status === "settled")) current.workersSettled++;
		if (!repeat && (event.kind === "delegate_receipt" || isDelegateTool(event))) current.handoffs.push({ ref: event.ref,
			text: [event.name, event.status].filter(Boolean).join(" ") || event.kind });
		if (event.kind === "file_op" && event.text) {
			let file = current.files.find(item => item.path === event.text);
			if (!file) { file = { ref: event.ref, path: event.text, operations: new Map() }; current.files.push(file); }
			const operation = event.name ?? "unknown";
			file.operations.set(operation, (file.operations.get(operation) ?? 0) + 1);
		}
		if (event.kind === "todo") current.lastTodo = { ref: event.ref, text: event.text || "(empty todo state)" };
		if (event.actor === "lead" && event.kind === "assistant" && event.text) {
			current.recentAssistants.push({ ref: event.ref, text: event.text });
			if (current.recentAssistants.length > RECENT_ASSISTANTS) current.recentAssistants.shift();
		}
		if (isCompaction(event)) {
			current.closingCompactions++;
			if (event.claim) current.closingClaim = { ref: event.ref, text: event.claim };
		}
		if (isDirection(event) && event.text) current.directions.push({ ref: event.ref, text: event.text });
		current.endRef = event.ref;
		if (isCompaction(event)) { chapters.push(current); current = undefined; }
	}
	if (current) chapters.push(current);
	return chapters;
}

/**
 * One chapter under a character budget. Lines are emitted in chronological order but trimmed by
 * class, not position: the chapter's end state (TODO@end, the closing CLAIM, or for the provisional
 * frontier chapter its last few assistant texts) and its first and last directions are never
 * dropped; then files go before handoffs, handoffs before directions, oldest first within a class.
 * Trimming a line never drops a chapter, so the cut still covers everything emitted.
 */
const TRIM_ORDER = ["file", "handoff", "direction"] as const;
type TrimClass = typeof TRIM_ORDER[number];
interface BlockLine { text: string; cls?: TrimClass; rank: number }

function chapterBlock(chapter: Chapter, budget: number): string {
	const lines: BlockLine[] = [{ text: `Chapter ${chapter.index} · entries ${chapter.entries} · narrative ${chapter.narrativeChars} chars · workers settled ${chapter.workersSettled} · compactions ${chapter.closingCompactions}`, rank: 0 }];
	const cite = (label: string, item: ChapterDirection, limit = DIRECTION_CHARS) => `  ${label} [src:${item.ref}] ${clamp(flat(item.text), limit)}`;
	const first = chapter.directions[0], last = chapter.directions.at(-1);
	chapter.directions.forEach((direction, i) => lines.push({ text: cite(direction === first ? "first direction" : direction === last ? "last direction" : "direction", direction),
		...(direction === first || direction === last ? {} : { cls: "direction" }), rank: i }));
	chapter.handoffs.forEach((handoff, i) => lines.push({ text: cite("delegate handoff", handoff), cls: "handoff", rank: i }));
	chapter.files.forEach((file, i) => lines.push({ text: `  file [src:${file.ref}] ${file.path} (${[...file.operations].map(([op, count]) => `${op}×${count}`).join(", ")})`, cls: "file", rank: i }));
	if (chapter.lastTodo) lines.push({ text: cite("TODO@end", chapter.lastTodo), rank: 0 });
	if (chapter.closingClaim) {
		const placeholder = /remote compaction applied/i.test(chapter.closingClaim.text);
		// The closing claim is the provider's summary: context for the chapter, never citable evidence.
		lines.push({ text: `  ${placeholder ? "CLAIM(placeholder — no content)" : "CLAIM"} ${clamp(flat(chapter.closingClaim.text), CLAIM_CHARS)}`, rank: 0 });
	} else if (!chapter.closingCompactions) {
		const final = chapter.recentAssistants.at(-1);
		for (const assistant of chapter.recentAssistants) lines.push({ text: cite(assistant === final ? "last assistant text" : "recent assistant text", assistant, ASSISTANT_CHARS), rank: 0 });
	}
	const omitted: Record<TrimClass, number> = { file: 0, handoff: 0, direction: 0 };
	const render = (kept: BlockLine[]) => {
		const out = kept.map(line => line.text);
		const notes = [omitted.direction ? `${omitted.direction} lead directions` : "", omitted.handoff ? `${omitted.handoff} delegate handoffs` : "", omitted.file ? `${omitted.file} files touched` : ""].filter(Boolean);
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
	const header = "BOOTSTRAP CHAPTER CHAIN — recorded evidence compressed by the host with source pointers. No semantic judgment is added; synthesize the work map from these directions, files and todo states; closing CLAIM lines are provider summaries for orientation and carry no citable source.";
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
export async function bootstrapDigest(feed: BootstrapFeed, firstMore: boolean, policy: BootstrapPolicy, fromIndex = 0): Promise<BootstrapDigest | undefined> {
	if (!firstMore) return undefined; // a single window already holds everything: nothing to compress
	// Drain readable lead history even when a worker is live or unavailable. capture(..., true)
	// still defers worker reads; its cut never advances over that unobserved evidence.
	let more: boolean = firstMore, windows = 0, cut: Cut | undefined;
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
		coveredThroughRef: segments.at(-1)!.endRef, windows, remainingMore: more };
}
