/**
 * Mom's operations, as they run in oven: each delivery or request is one operation on a fresh `Mom`,
 * rebuilt from the lead's session file and her `.mom` file. `prepare` stages the evidence (bounded batches,
 * the cold-start digest, skipped-range retries, compaction audits) and returns what her turn reviews;
 * her tools accept the map; `settle` records what an operation that was not accepted leaves (a retry
 * record, a skipped range, a retired range) and her usage.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MomStore } from "./sidecar.ts";
import type { AdvisorScreenRecord, SessionAdvisor } from "./advisor.ts";
import { branchCheckpoints, emptyUsage, graphChange, loadState, noticeKey, sumUsage, type AnchorState, type Checkpoint, type CursorFailure, type SkippedGap, type Usage, type WindowLive, type WindowOutcome } from "./checkpoint.ts";
import { extractEvents, isUserDirection, LiveFeed, renderUpdateEvent, renderUpdateEvents, suffix, type Cut, type FeedEvent, type SessionReader } from "./feed.ts";
import type { CompactionReview } from "./compaction.ts";
import { reconstructThreadMap, THREAD_MAP_PROMPT, type ThreadMap } from "./audit.ts";
import { bootstrapDigest, type BootstrapPolicy } from "./bootstrap.ts";
import { CHAPTER_STATE_FIELDS, REFLECTION_PROMPT, normalizeEvidence } from "./contract.ts";
import { emptyGraph, graphForModel, graphSlice } from "./graph.ts";
import { OPERATION_FAILED, type OperationHeader } from "./operation.ts";
import { PROCESS_RISK_CLASSES, emptyEngagement, type FindingFeedback, type ProcessRiskClass } from "./process-health.ts";

export const DEFAULT_MODEL = "openai-codex/gpt-5.6-sol";
export const MAX_DEFERRAL_MS = 60000;
export const thinkingFor = (model: string) => model.endsWith("/gpt-5.6-sol") ? "medium" : "low";

type StagedBatch = Awaited<ReturnType<LiveFeed["capture"]>> & { from: Cut; startIndex: number; endIndex: number;
	retryGapId?: string; retryGapRemaining?: string[]; /** Bootstrap only: replaces the raw slice as this proposal's evidence. */
	digest?: string };
/** What a settled step's messages say happened. */
export interface StepOutcome { usage: Usage; steps: number; accepted: boolean; rejection?: string; failure?: string; audit?: ThreadMap }

/** Gap evidence was originally admitted under the same 24k feed budget. Keep recovery bounded too. */
function boundedGapEvents(events: readonly FeedEvent[], limit = 24000): { events: FeedEvent[]; remaining: string[] } {
	const selected: FeedEvent[] = [];
	for (const event of events) {
		if (renderUpdateEvents([...selected, event]).length > limit) break;
		selected.push(event);
	}
	if (!selected.length && events.length) throw new Error("One recorded gap event exceeds Mom's 24,000-character recovery limit; nothing was truncated.");
	return { events: selected, remaining: events.slice(selected.length).map(event => event.ref) };
}

function recordedRange(events: readonly FeedEvent[], range: Pick<CursorFailure, "firstRef" | "lastRef" | "count">, error: string): FeedEvent[] {
	const first = events.findIndex(event => event.ref === range.firstRef);
	const last = events.findIndex(event => event.ref === range.lastRef);
	if (first < 0 || last < first || last - first + 1 !== range.count) throw new Error(error);
	return events.slice(first, last + 1);
}

/** What Mom reads of the lead: its folder, whether it is working, its session, and where she notifies. */
export type MomContext = Pick<ExtensionContext, "cwd" | "isIdle"> & {
	sessionManager: SessionReader;
	ui: Pick<ExtensionContext["ui"], "notify">;
};

/** One step in its own fresh context: an audit section or a continuity check. */
export interface StepRequest {
	header: OperationHeader;
	body: Record<string, unknown> | string;
	instructions: string;
	tools: string[];
	thinking: string;
	/** Further messages in the same context, each sent once the previous one is answered. */
	more?: string[];
}
export type StepRunner = (request: StepRequest) => Promise<{ messages: any[] }>;

export interface MomHost {
	ctx: MomContext;
	mapMode?: string;
	model: string;
	/** Cold catch-up: one bounded proposal over a chapter-chain digest, not one per capture window. */
	bootstrapPolicy?: BootstrapPolicy;
	advisor?: SessionAdvisor;
	/** Durable state lives beside the session transcript, never inside it. */
	store: MomStore;
	/** Runs a step in a child context of her slice. */
	steps: StepRunner;
	changed(): void;
}

/** What `prepare` hands her turn: the evidence to review, nothing (with why), or a wait. */
export type Prepared =
	| { kind: "work"; header: OperationHeader; body: Record<string, unknown>; guidance: string; batch: StagedBatch }
	| { kind: "idle"; reason: string }
	| { kind: "defer"; until: number };

/** Read a settled step: usage, acceptance, a rejection, an operation failure, or an audit result. */
export function readStep(messages: readonly any[], slice?: any): StepOutcome {
	const outcome: StepOutcome = { usage: emptyUsage(), steps: 0, accepted: false };
	for (const message of messages) {
		if (message.role === "assistant") {
			outcome.steps++;
			const u = message.usage;
			// Every provider request counts, mom_begin's included: "model calls" is what the user pays for.
			if (u) outcome.usage = sumUsage(outcome.usage, { calls: 1, input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, nominalCost: u.cost?.total ?? 0, elapsedMs: 0 });
			if (message.stopReason === "error") outcome.failure = message.errorMessage ?? "Mom provider failed.";
		} else if (message.role === "toolResult") {
			const text = (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
			if (text.startsWith(OPERATION_FAILED)) outcome.failure = text.slice(OPERATION_FAILED.length);
			else if (["commit_graph", "commit_v2"].includes(message.toolName)) {
				if (!message.isError && text.startsWith("Map saved.")) outcome.accepted = true;
				else if (message.isError) outcome.rejection = text;
			} else if (message.toolName === "record_thread_map" && !message.isError && text.startsWith("Chapter state recorded.\n")) outcome.audit = JSON.parse(text.slice(text.indexOf("\n") + 1));
		}
	}
	if (!outcome.accepted && !outcome.failure && slice?.state === "failed") outcome.failure = slice.detail ?? `Mom's slice failed (${slice.reason ?? "unknown"}).`;
	return outcome;
}

/** Mom for one operation: her saved state, rebuilt from her `.mom` file and the lead's session file. */
export class Mom {
	feed: LiveFeed;
	checkpoint?: Checkpoint;
	checkpointId?: string;
	private readonly initialGraph = emptyGraph();
	private coverageCut?: Cut;
	get graph() { return this.checkpoint?.graph ?? this.initialGraph; }
	enabled = true;
	/** Which map-maintenance split is in force (docs/map-modes.md). Durable, like enabled and inject. */
	/** Which map-maintenance split is in force (docs/map-modes.md). "" = never saved. */
	mode = "";
	/** The model this Mom runs on, as provider/id. Empty means the configured default. */
	model = "";
	/** Anchor and window injection. Off silences the post-compaction surfaces without pausing Mom. */
	inject = false;
	nudgedClasses: ReadonlySet<ProcessRiskClass>;
	readonly unresolvedNotices = new Set<string>();
	readonly findingFeedback = new Map<string, FindingFeedback>();
	engagement = emptyEngagement();
	usage = emptyUsage();
	screen?: AdvisorScreenRecord;
	error?: string;
	/** What the operation is doing, for her status. */
	activity?: "reading history" | "screening" | "starting Mom" | "thinking" | "saving";
	/** The cut this operation covers if accepted: its scope, never claimed coverage. */
	target?: Cut;
	recovering = false;
	more = false;
	waitingForWorkers = false;
	/** A screen postponed the staged batch: the next look at the session adds what arrived meanwhile. */
	private screenDeferred = false;
	failure?: CursorFailure;
	gaps: SkippedGap[] = [];
	pendingAnchor?: AnchorState;
	lastAnchor?: AnchorState;
	reservedAnchor?: AnchorState & { content: string };
	window?: WindowLive;
	lastWindow?: WindowOutcome;
	operationTiming?: { startupMs: number; requestMs: number; totalMs: number; oldestEvidenceAgeMs: number };
	private committed = 0;
	private chapterBoundary: string | null = null;
	private checkpoints: { id: string; data: Checkpoint }[] = [];
	private staged?: StagedBatch;

	constructor(private host: MomHost) { this.feed = new LiveFeed(host.ctx.sessionManager); this.nudgedClasses = new Set(PROCESS_RISK_CLASSES); }

	private stage(activity: NonNullable<Mom["activity"]>): void {
		if (this.activity === activity) return;
		this.activity = activity;
		this.host.changed();
	}

	async open(): Promise<void> {
		const state = await loadState(this.host.store, this.host.ctx.sessionManager);
		const cutoverCheckpointId = state.cutover ? state.checkpointId : undefined;
		if (state.cutover && state.checkpoint) {
			// One atomic current-format snapshot completes the version-free graph cutover.
			const checkpoint = { ...state.checkpoint, at: Date.now() };
			const saved = await this.host.store.append("map", { snapshot: checkpoint, ...(state.failure ? { failure: state.failure } : {}) });
			state.checkpoint = checkpoint; state.checkpointId = saved.id; state.coverageCut = checkpoint.cut; delete state.cutover;
		}
		this.checkpoint = state.checkpoint;
		this.checkpointId = state.checkpointId;
		this.coverageCut = state.coverageCut ?? state.checkpoint?.cut;
		this.enabled = state.enabled;
		this.mode = state.mode;
		this.model = state.model;
		this.inject = state.inject;
		this.nudgedClasses = new Set(state.nudgedClasses);
		this.unresolvedNotices.clear(); for (const key of state.unresolvedNotices) this.unresolvedNotices.add(key);
		this.findingFeedback.clear(); for (const [key, action] of Object.entries(state.feedback)) this.findingFeedback.set(key, action);
		this.engagement = state.engagement;
		this.usage = state.usage ?? emptyUsage();
		this.screen = state.screen;
		this.error = state.error;
		this.failure = state.failure; this.gaps = state.gaps;
		this.pendingAnchor = state.pendingAnchor;
		this.lastAnchor = state.lastAnchor;
		this.reservedAnchor = state.reservedAnchor;
		this.window = state.window;
		this.lastWindow = state.lastWindow;
		let retry: StagedBatch | undefined;
		if (state.failure) try {
			await this.feed.restore(state.failure.through);
			const events = recordedRange(this.feed.events, state.failure, "Mom cannot restore the evidence range recorded for retry.");
			retry = { events, cut: state.failure.through, from: state.failure.from, gaps: [], more: false,
				startIndex: this.feed.events.length - events.length, endIndex: this.feed.events.length };
		} catch {
			// A retry record is not a saved map; nothing cites it. When its history is gone
			// (e.g. a deleted worker transcript), re-read from the last accepted point instead.
			this.failure = undefined;
			this.feed = new LiveFeed(this.host.ctx.sessionManager);
		}
		if (!retry) await this.feed.restore(state.coverageCut ?? this.checkpoint?.cut);
		for (const observation of state.observations) this.feed.observe(observation);
		if (this.checkpoint) for (const item of [...this.checkpoint.graph.nodes, ...this.checkpoint.graph.edges]) for (const ref of item.sources) {
			if (!this.feed.byRef.has(ref)) throw new Error(`Checkpoint cites an unknown or unobserved source: ${ref}`);
		}
		this.staged = retry;
		this.committed = retry ? retry.startIndex : this.feed.events.length;
		this.chapterBoundary = null;
		for (let i = 0; i < this.committed; i++) if (this.feed.events[i].kind === "compaction") this.chapterBoundary = this.feed.events[i].ref;
		this.checkpoints = branchCheckpoints(await this.host.store.load(), new Set(this.host.ctx.sessionManager.getBranch().map(e => e.id)))
			.filter(item => item.id !== cutoverCheckpointId);
	}

	detail() { return { failureState: this.failure, skippedEvidence: this.gaps, sessionUsage: this.usage, operationTiming: this.operationTiming, screen: this.screen, engagement: this.engagement,
		uncertainEffects: this.feed.uncertainEffects() }; }

	readGraph(options: { nodes?: string[]; depth?: number; checkpoint?: string } = {}) { return readGraph(this.checkpoints, this.checkpoint, this.checkpointId, this.feed.events, options); }

	private valid(cut: Cut): void {
		suffix(this.host.ctx.sessionManager, this.host.ctx.sessionManager.getLeafId(), cut.parent);
	}

	/** Unreviewed lead compactions after her coverage, newest last. */
	/** The thread-map section being reconstructed, while a compaction review runs. */
	auditProgress?: { section: number; of: number };

	unreviewedCompactions(): FeedEvent[] {
		const manager = this.host.ctx.sessionManager;
		const captured = this.feed.events.slice(this.committed).filter(event => event.actor === "lead" && event.kind === "compaction");
		// Her operation starts from the session file: entries nothing has read yet may hold a compaction.
		const unread = suffix(manager, manager.getLeafId(), this.feed.cut().parent).flatMap(entry => extractEvents({ key: manager.getSessionId(), actor: "lead" }, entry))
			.filter(event => event.kind === "compaction");
		return [...captured, ...unread];
	}

	/**
	 * Stage this operation's evidence and build what her turn reviews. A compaction review first
	 * reconstructs an independent thread map in child steps.
	 */
	async prepare(options: { refresh: boolean; review?: CompactionReview; force?: boolean; relabel?: boolean; job: string; signal?: AbortSignal }): Promise<Prepared> {
		const { refresh, review: compactionReview, job } = options;
		this.stage("reading history");
		const started = performance.now();
		const timing = { startupMs: 0, requestMs: 0, totalMs: 0, oldestEvidenceAgeMs: 0 };
		let screen: AdvisorScreenRecord | undefined;
		if (options.relabel && this.checkpoint) {
			// Repair saved labels without consuming or waiting for the unrelated live backlog.
			this.staged = { events: [], cut: this.checkpoint.cut, from: this.checkpoint.cut,
				gaps: [], more: false, startIndex: this.committed, endIndex: this.committed };
		} else if (compactionReview) {
			const from = this.checkpoint?.cut ?? this.feed.cut();
			const captured = await this.feed.capture(Infinity, false);
			this.staged = { ...captured, events: this.feed.events.slice(this.committed), from, startIndex: this.committed, endIndex: this.feed.events.length };
			// Optional worker history must not block reconciliation of readable lead evidence.
			if (this.feed.gaps.has("parent")) throw new Error(`Thread-map audit cannot read lead evidence: ${this.feed.gaps.get("parent")}`);
		} else if (!this.staged) {
			const from = this.checkpoint?.cut ?? this.feed.cut(), startIndex = this.feed.events.length;
			const captured = await this.feed.capture(24000, false);
			this.staged = { ...captured, from, startIndex, endIndex: this.feed.events.length };
		} else if (this.waitingForWorkers || this.screenDeferred) {
			const used = renderUpdateEvents(this.staged.events).length;
			const next = await this.feed.capture(24000 - used, false);
			this.staged = { ...this.staged, events: [...this.staged.events, ...next.events], cut: next.cut,
				gaps: [...new Set([...this.staged.gaps, ...next.gaps])], more: next.more, endIndex: this.feed.events.length };
		}
		this.screenDeferred = false;
		// A failed range (restored from her `.mom` file) is retried alone; later evidence waits for the next operation.
		const retryingGaps = () => !options.relabel && (refresh || (!this.failure && !this.staged!.events.length)) && this.gaps.length > 0 && !compactionReview;
		if (retryingGaps()) {
			// A skipped range whose sources are gone can never be re-reviewed: retire it durably.
			const unreadable = this.gaps.filter(gap => { try { recordedRange(this.feed.events, gap, ""); return false; } catch { return true; } });
			if (unreadable.length) {
				await this.host.store.append("map", { base: this.checkpointId ?? null, cut: this.checkpoint?.cut ?? unreadable.at(-1)!.through,
					resolvedGaps: unreadable.map(gap => gap.id) }, `${job}:retired`);
				this.gaps = this.gaps.filter(gap => !unreadable.includes(gap));
			}
		}
		if (retryingGaps()) {
			const gap = this.gaps[0];
			const old = recordedRange(this.feed.events, gap, "Mom cannot retry a skipped range because its recorded sources are unreadable.");
			const chunk = boundedGapEvents(old, 24000);
			const gapStart = this.feed.events.findIndex(event => event.ref === chunk.events[0]?.ref);
			if (gapStart < 0) throw new Error("Mom cannot locate the recorded gap boundary in the restored evidence stream.");
			this.staged = { events: chunk.events, cut: this.coverageCut ?? gap.through, from: gap.from,
				gaps: [], more: chunk.remaining.length > 0 || this.staged!.events.length > 0 || this.staged!.more, startIndex: gapStart, endIndex: this.committed,
				retryGapId: gap.id, retryGapRemaining: chunk.remaining };
			this.recovering = true;
		}
		let batch = this.staged!;
		this.valid(batch.cut);
		this.more = batch.more;
		if (this.failure && !batch.retryGapId) this.recovering = true;
		const oldestEvidence = batch.events.reduce((oldest, event) => Math.min(oldest, Date.parse(event.at)), Date.now());
		const deadline = oldestEvidence + MAX_DEFERRAL_MS;
		if (!refresh && !compactionReview && batch.events.length && this.feed.hasRunningWorkers && Date.now() < deadline) {
			// Prefer settlement briefly, but a long worker must not hold the current account indefinitely.
			this.waitingForWorkers = true;
			return { kind: "defer", until: deadline };
		}
		this.waitingForWorkers = false;
		if (!batch.events.length && !compactionReview && !options.force) return { kind: "idle", reason: "Nothing new to review." };
		if (this.host.bootstrapPolicy && !compactionReview && !this.failure && !batch.retryGapId && batch.more) {
			// Any bounded backlog uses the local thread-map chapter digest: one proposal over the drained backlog,
			// regardless of the normal frontier mode. Raw act labeling is for live increments, not catch-up.
			const digest = await bootstrapDigest(this.feed, batch.more, this.host.bootstrapPolicy, batch.startIndex);
			if (digest) {
				this.staged = { ...batch, events: this.feed.events.slice(batch.startIndex), cut: digest.cut,
					endIndex: this.feed.events.length, more: digest.remainingMore, digest: digest.text };
				batch = this.staged;
				this.more = digest.remainingMore;
			}
		}
		const prior = this.feed.events.slice(0, batch.startIndex).findLast((e) => e.actor === "lead" && Boolean(e.text) && ["assistant", "tool_call"].includes(e.kind));
		const unresolved = new Set(this.unresolvedNotices);
		if (this.checkpoint?.note) unresolved.add(noticeKey(this.checkpoint.note));
		// A classifier may postpone routine mid-run evidence, never certify it unchanged.
		const mandatory = refresh || Boolean(compactionReview) || batch.events.some(event => event.correction === true) ||
			Boolean(this.failure) || Boolean(batch.retryGapId) || Date.now() >= deadline;
		if (this.host.advisor && !mandatory && this.checkpoint) {
			this.stage("screening");
			const advisor = this.host.advisor, screenStarted = performance.now();
			try {
				screen = await advisor.screen({ current: this.graph, newEvidence: renderUpdateEvents(batch.events),
					contextBeforeBatch: prior ? renderUpdateEvent(prior) : null, pendingMore: batch.more,
					unresolvedProcessRisks: [...unresolved] }, options.signal ?? new AbortController().signal);
			} catch (error) {
				if (options.signal?.aborted) throw error;
				screen = { status: "unavailable", model: advisor.model, error: String(error), latencyMs: Math.round(performance.now() - screenStarted) };
			}
			this.screen = screen;
			const routine = batch.events.every(event => !event.isError && !["user", "user_answer", "tool_result", "shell_result", "compaction"].includes(event.kind));
			if (screen.status === "screened" && !screen.wake && routine && !batch.more && !batch.gaps.length && !this.host.ctx.isIdle() && Date.now() < deadline) { this.screenDeferred = true; return { kind: "defer", until: deadline }; }
		}
		const manager = this.host.ctx.sessionManager;
		const session = { file: manager.getSessionFile()!, id: manager.getSessionId(), cwd: this.host.ctx.cwd, leaf: manager.getLeafId() };
		this.target = batch.cut;
		let audit: ThreadMap[] | undefined, auditedGaps: string[] = [];
		if (compactionReview) {
			this.stage("thinking");
			// Her saved map already covers everything up to its cut: audit only what it has not (pending
			// evidence plus the compaction event), not the session's whole history again.
			const covered = new Set(this.feed.events.slice(0, batch.startIndex).map(event => event.ref));
			const captured = new Map(compactionReview.historyEvents.filter(event => !covered.has(event.ref)).map(event => [event.ref, event]));
			for (const event of this.feed.events.slice(batch.startIndex)) if (!captured.has(event.ref)) captured.set(event.ref, event);
			const stepStarted = performance.now();
			audit = await reconstructThreadMap([...captured.values()], async (section, body, name) => {
				this.auditProgress = { section: Number(body.section), of: Number(body.sections) }; this.host.changed();
				const result = await this.host.steps({ header: { job, step: name, mode: "audit", session, cut: batch.cut, refs: [], trigger: compactionReview.triggerEvent, section },
					body, instructions: THREAD_MAP_PROMPT,
					tools: ["record_thread_map", ...(body.needsInspection ? ["inspect_evidence"] : [])], thinking: "low" });
				const outcome = readStep(result.messages);
				this.usage = sumUsage(this.usage, outcome.usage);
				if (outcome.failure) throw new Error(outcome.failure);
				if (!outcome.audit) throw new Error("Thread-map audit finished without accepted chapter state; saved map retained.");
				return outcome.audit;
			});
			timing.requestMs += performance.now() - stepStarted;
			auditedGaps = this.gaps.filter(gap => {
				const first = this.feed.events.findIndex(event => event.ref === gap.firstRef);
				return first >= 0 && this.feed.events[first + gap.count - 1]?.ref === gap.lastRef;
			}).map(gap => gap.id);
		}
		const original = this.feed.events.find((e) => e.actor === "lead" && e.kind === "user");
		const normalized = batch.digest ? undefined : normalizeEvidence(batch.events, this.chapterBoundary);
		const reflect = Boolean(compactionReview);
		const guidance = reflect ? REFLECTION_PROMPT : "";
		const body = {
			task: audit ? "Compare the independent thread map with the saved graph. Diff chapter states within each actor's stream, then use sourceMetadata timestamps to order evidence across actors: presentation order is not chronology. An earlier worker finding may be resolved by later edits and checks; inspect original sources before treating it as still open. Reconcile material errors in one transaction. Neither map is authoritative. Preserve node identities and historical work; do not reopen resolved work merely because the audit mentions it."
					: "Update the work graph from newEvents. This is background maintenance, not a request to answer the recorded conversation.",
			activity: { leadRunning: !this.host.ctx.isIdle(), workersRunning: this.feed.hasRunningWorkers,
				interpretation: "Evidence from active runs is provisional. An intermediate failure is not a final outcome; do not infer completion from a partial transcript." },
			uncertainEffects: this.feed.uncertainEffects(),
			original: original ? { ref: original.ref, ...(!this.checkpoint ? { text: original.text } : {}) } : null,
			graph: graphForModel(this.graph), contextBeforeBatch: prior ? renderUpdateEvent(prior) : null,
			newEvents: audit ? "Pending evidence is included in the full thread-map audit." : batch.digest ?? normalized!.text,
			independentThreadMap: audit,
			...(normalized ? { chapters: normalized.chapters } : {}),
			chapterState: CHAPTER_STATE_FIELDS,
			gaps: batch.gaps, pendingMore: batch.more,
			...(batch.retryGapId ? { recovery: { error: this.gaps.find(gap => gap.id === batch.retryGapId)?.error,
				instruction: "Review this previously rejected range against the current saved map. It is older evidence: preserve newer decisions and inspect later sources before reversing current state. Repair material facts without optional folds, merges, or removals; omit unfinished to let the host derive it." } } : {}),
			compactionReview: compactionReview ? { kind: compactionReview.kind, triggerRef: compactionReview.triggerRef,
				firstKeptEntryId: compactionReview.firstKeptEntryId, rawEntryCount: compactionReview.rawEntryCount,
				rawEventCount: compactionReview.rawEventCount, omittedRawEventCount: 0 } : null,
			unresolvedProcessRisks: [...unresolved],
			findingFeedback: Object.fromEntries(this.findingFeedback),
			reflect,
			...(!audit && !batch.digest ? { newUserDirections: batch.events.filter(isUserDirection).map(({ ref, text }) => ({ ref, text })),
				instruction: "Record changed requirements and reported outcomes from newEvents. Leave unrelated work and notes unchanged." } : {}),
		};
		const header: OperationHeader = { job, step: "map", mode: "update", session, cut: batch.cut, from: batch.from,
			refs: batch.events.map(event => event.ref), more: batch.more, gaps: batch.gaps.length,
			...(batch.retryGapId ? { retryGap: { id: batch.retryGapId, remaining: batch.retryGapRemaining ?? [] } } : {}),
			...(compactionReview ? { trigger: compactionReview.triggerEvent } : {}),
			...(auditedGaps.length ? { auditedGaps } : {}), ...(screen ? { screen } : {}), ...(this.feed.gaps.has("parent") ? { leadUnreadable: true } : {}) };
		timing.startupMs = performance.now() - started - timing.requestMs;
		timing.oldestEvidenceAgeMs = batch.events.length ? Math.max(0, Date.now() - oldestEvidence) : 0;
		this.operationTiming = timing;
		this.stage("thinking");
		return { kind: "work", header, body, guidance, batch };
	}

	/**
	 * What an operation that was not accepted leaves. A provider outage or a failure of her own tooling is
	 * not a verdict on the evidence: only usage is recorded. A rejected batch is recorded for one retry,
	 * then skipped (coverage moves past it); a rejected skipped range is retired. Returns the error to
	 * show, and whether the rejection counts toward her rejected streak.
	 */
	async settle(header: OperationHeader, outcome: StepOutcome, usage: Usage): Promise<{ error?: string; retiredRejection?: string }> {
		const job = header.job;
		const record = (error: string | null) => this.host.store.append("usage", { usage, error }, `${job}:usage`);
		if (outcome.accepted) { await record(null); return {}; }
		if (outcome.failure) { await record(outcome.failure); return { error: outcome.failure }; }
		const failureError = outcome.rejection ?? "Mom finished without an accepted background graph transaction.";
		if (header.trigger || header.mode !== "update" || header.gaps) { await record(failureError); return { error: failureError }; }
		if (header.retryGap) {
			// The range failed twice before it was skipped, and coverage already moved past it. A failed
			// re-review retires it instead of looping or asking the user to fix the model.
			const remaining = header.retryGap.remaining, prior = this.gaps.find(gap => gap.id === header.retryGap!.id);
			if (remaining.length && !prior) throw new Error("Cannot preserve the remaining skipped range: its gap record is missing.");
			const change = remaining.length ? { gap: { action: "open", ...prior!, firstRef: remaining[0], lastRef: remaining.at(-1)!, count: remaining.length } }
				: { resolvedGaps: [header.retryGap.id] };
			await this.host.store.append("map", { base: this.checkpointId ?? null, cut: this.coverageCut ?? header.cut!, ...change }, `${job}:retired`);
			await record(null);
			return { retiredRejection: failureError };
		}
		const range = { firstRef: header.refs[0], lastRef: header.refs.at(-1)!, count: header.refs.length };
		if (!range.count) { await record(failureError); return { error: failureError }; }
		const key = JSON.stringify({ from: header.from, through: header.cut, ...range });
		const failures = this.failure?.key === key ? this.failure.failures + 1 : 1;
		const failure: CursorFailure = { key, from: header.from!, through: header.cut!, ...range, error: failureError, failures };
		if (failures < 2) await this.host.store.append("map", { failure }, `${job}:failure`);
		else {
			const gap: SkippedGap = { ...failure, id: randomUUID() };
			// One map record both exposes the gap and advances coverage. A failed append skips nothing.
			await this.host.store.append("map", { base: this.checkpointId ?? null, cut: gap.through, failure: null, gap: { action: "open", ...gap } }, `${job}:failure`);
		}
		await record(failureError);
		return { error: failureError };
	}
}

/** Her saved map as the `mom` tool and the panel read it: a slice of the current or an earlier checkpoint. */
export function readGraph(checkpoints: readonly { id: string; data: Checkpoint }[], current: Checkpoint | undefined, currentId: string | undefined,
	events: readonly FeedEvent[], options: { nodes?: string[]; depth?: number; checkpoint?: string } = {}) {
	let checkpoint = current, checkpointId = currentId;
	if (options.checkpoint) {
		const entry = checkpoints.find(c => c.id === options.checkpoint);
		if (!entry) throw new Error("Graph checkpoint is unavailable on this session's selected branch.");
		checkpoint = entry.data; checkpointId = entry.id;
	}
	const all = [...checkpoints].sort((a, b) => a.data.at - b.data.at);
	const index = all.findIndex(c => c.id === checkpointId);
	const previous = index > 0 ? all[index - 1] : undefined;
	const original = events.find(e => e.actor === "lead" && e.kind === "user");
	const historical = Boolean(options.checkpoint && options.checkpoint !== currentId);
	return { initialized: Boolean(checkpoint), format: "endeavors",
		checkpoint: checkpointId, previousCheckpoint: previous?.id, at: checkpoint?.at,
		change: checkpoint ? checkpoint.change ?? graphChange(previous?.data.graph ?? null, checkpoint.graph) : undefined,
		unfinished: checkpoint?.unfinished, historical,
		original: original ? { ref: original.ref, text: original.text } : null,
		...graphSlice(checkpoint?.graph ?? emptyGraph(), options.nodes, options.depth) };
}
