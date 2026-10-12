/**
 * Mom's client in the lead's Pi session. Mom runs in oven: her slice follows this session's file, reviews
 * new activity, retries failed turns, and writes her `.mom` file. This client only ensures her slice (by
 * key, with her configuration), follows it with `oven_watch`, reads her `.mom` file read-only, renders her
 * state, and sends the user's requests. It never writes the `.mom` file.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { branchCheckpoints, emptyUsage, loadState, noticeKey, type MomState, type Usage } from "./checkpoint.ts";
import { STATUS_DOC, type MomStatus } from "./engine.ts";
import { extractEvents, LiveFeed } from "./feed.ts";
import { readGraph } from "./mother.ts";
import { encodeRequest, type FindingRequest, type MomRequest } from "./operation.ts";
import { oven, ovenUrl, ovenSliceUrl, OvenUnreachable } from "./oven.ts";
import type { PanelDiagnostics, PanelView } from "../ui/panel.ts";
import { feedbackApplies, type FindingAction, type ProcessRiskClass } from "./process-health.ts";
import { coverageProgress, presentGraph, summaryText, type WorkView } from "../ui/presentation.ts";
import { SidecarStore } from "./sidecar.ts";
import { assertSliceSupportsMode, deciderFor, identityOf, momConfiguration, ownerKey, type SessionIdentity } from "./slice.ts";
import { readMomGlobals, writeMomGlobals, type MomGlobals } from "./globals.ts";
import { formatElapsed, updateErrorSummary } from "./status.ts";
import { ANCHOR } from "./anchor.ts";
import { WINDOW_CORRECTION } from "./window.ts";
import { projectWork, type WorkProjection } from "../work/projection.ts";
import { acceptRebuiltMap, rebuildMap, type RebuiltMap } from "./rebuild.ts";
import { emptyTrail, type Strike, type Trail, type Waypoint, type WaypointKind } from "../trail/types.ts";
import { TrailStore, trailFor } from "../trail/store.ts";
import { beforeLastDetour, evolution, glance, landing, openItems, renderBefore, renderEvolution, renderLanding, renderOpen, renderStanding, renderTrail, whereWeAre } from "../trail/projection.ts";
import { plainTrailRows } from "../ui/trail-view.ts";

/** Mom's slice in oven, as the Status tab shows it. */
export interface SliceHost { pid: number; slice: string; state: string; startedAt: number; sampledAt: number }
export interface SourcePage { ref: string; text: string; offset: number; totalChars: number; nextOffset: number | null; pairedRef?: string }
export interface PreparedAnchor { key: string; content: string; at: number }
export interface Controls { enabled: boolean; inject: boolean; hush: boolean; nudgedClasses: ProcessRiskClass[]; mode: string; model: string; decider?: string }
export interface Telemetry {
	model: string; activity: string; lastSavedAt?: number; pendingRanges: number; unavailableSources: number;
	timing?: { startupMs: number; requestMs: number; totalMs: number; oldestEvidenceAgeMs: number };
}
export interface Snapshot {
	passive: PanelView; explicit: PanelView; diagnostics: PanelDiagnostics; usage: Usage; controls: Controls; work?: WorkProjection;
	startedAt?: number; preparedAnchor?: PreparedAnchor; telemetry: Telemetry; host?: SliceHost;
}
export type ControlChange = { enabled: boolean } | { inject: boolean } | { hush: boolean } | { nudgedClasses: ProcessRiskClass[] } | { mode: string } | { model: string } | { decider: string };
export type Command =
	| { kind: "refresh" }
	| { kind: "relabel" }
	| { kind: "graph"; options: { nodes?: string[]; depth?: number; checkpoint?: string } }
	| { kind: "source"; ref: string; offset?: number; limit?: number }
	| { kind: "log" } | { kind: "controls"; change: ControlChange }
	| { kind: "finding"; action: FindingRequest; finding: string }
	| { kind: "status" }
	| { kind: "trail"; options: TrailOptions }
	| { kind: "mark"; waypoint: { kind: WaypointKind; caption: string; line?: string } }
	| { kind: "strike"; target: string; reason?: string };
export interface TrailOptions { line?: string; query?: string; before?: boolean; open?: boolean; evolution?: boolean; limit?: number }
export interface Publication { customType: string; content: string; details: { key: string } }
/** The hidden message carrying Mom's standing (where we are on the trail) into the lead's context. */
export const TRAIL_STANDING = "pi-tether.mom-trail";
export const TRAIL_MODE = "trail";
const NO_WAYPOINTS = "Mom has not marked any waypoints yet.";
/** The trail's identity for the lead: the standing changes, a new message follows; otherwise nothing is appended. */
export const standingKey = (content: string): string => createHash("sha256").update(content).digest("hex").slice(0, 16);
/** What the `mom` tool's `trail` request and the /mom trail commands read: one projection, as text. */
export function trailText(trail: Trail, options: TrailOptions = {}): { text: string; count: number } {
	const count = trail.waypoints.length;
	if (!count) return { text: NO_WAYPOINTS, count };
	if (options.before) return { text: renderBefore(beforeLastDetour(trail)), count };
	if (options.open) return { text: renderOpen(openItems(trail, options.line)), count };
	if (options.evolution) return { text: renderEvolution(evolution(trail)), count };
	if (options.query) return { text: renderLanding(landing(trail, options.query)), count };
	return { text: `${renderStanding(trail)}\n\n${renderTrail(trail, { line: options.line, limit: options.limit ?? 40 })}`, count };
}

/** How long a settings change waits for her answer before it is shown as made. */
/** Between her rounds of catching up on what a bounded batch or a skipped range left. */
const DRAIN_DELAY_MS = 250;
const STAGES = ["reading history", "screening", "starting Mom", "thinking", "saving"] as const;
/** Five-cell bar: one cell per stage reached. */
const meter = (activity: string | undefined) => {
	const reached = Math.max(1, STAGES.indexOf((activity ?? "") as typeof STAGES[number]) + 1);
	return "▰".repeat(reached) + "▱".repeat(STAGES.length - reached);
};
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });

/** The lead's client of Mom's slice. */
export class MomClient {
	slice?: any;
	sliceUrl?: string;
	status?: MomStatus;
	state?: MomState;
	error?: string;
	hush = false;
	readonly identity: SessionIdentity;
	readonly key: string;
	#host?: SliceHost;
	#checkpoints: ReturnType<typeof branchCheckpoints> = [];
	#records: { type: string; at: number; data: Record<string, any>; id: string }[] = [];
	#openingError?: string;
	#closed = false;
	#watch = new AbortController();
	/** Wakes the follow loop when a paused Mom resumes (or the client closes). */
	#resume?: () => void;
	#steps = 0;
	#saving = false;
	#seenNotices = Date.now();
	#notifiedFailure?: string;
	#notifiedSkipped = 0;
	#notifiedRejection = false;
	#published = new Set<string>();
	#reloading?: Promise<void>;
	#work?: WorkProjection;
	#draining = false;
	#controlTail: Promise<void> = Promise.resolve();
	#drained?: string;
	#warnedDecider?: string;
	#trail?: Trail;
	#trailSkipped = 0;
	#trailError?: string;

	constructor(private context: ExtensionContext, private readonly options: {
		flags: Record<string, string | boolean | undefined>; changed(): void; publish(message: Publication): void;
		notify(text: string, level: "info" | "warning" | "error"): void;
	}) {
		this.identity = identityOf(context.sessionManager, context.cwd);
		this.key = ownerKey(this.identity);
	}

	updateContext(context: ExtensionContext) { this.context = context; }

	/** This branch's trail (waypoints in recorded order, struck ones removed); undefined until her notes are read. */
	get trail(): Trail | undefined { return this.#trail; }
	get trailSkipped(): number { return this.#trailSkipped; }
	get trailError(): string | undefined { return this.#trailError; }
	/** The mode in force, as her slice resolves it: a saved mode (global, then this session's), else the startup flag. */
	private get mapMode(): string { return this.state?.mode || String(this.options.flags["mom-mode"] ?? ""); }
	private get trailMode(): boolean { return this.mapMode === TRAIL_MODE; }

	/** Ensure her slice (create-or-get by key with her configuration), read her notes, and follow her. */
	async connect(): Promise<void> {
		await this.reload();
		await this.ensure();
		void this.follow();
	}

	async ensure(reconfigure = false): Promise<void> {
		// A paused Mom holds no slice. Oven retires a stopped ephemeral slice as soon as its last operation ends, so
		// creating one only to stop it again loops (create, stop, retire, "No slice", create…) every reconnect.
		if (this.state?.enabled === false) { await this.release(); return; }
		// Saved settings override startup flags. Each operation pins its configured mode at begin.
		// `create` is create-or-get: an idle slice takes this configuration; a running one is returned unchanged.
		const flags = { ...this.options.flags, ...(this.state?.mode ? { "mom-mode": this.state.mode } : {}), ...(this.state?.model ? { "mom-model": this.state.model } : {}),
			...(this.state?.decider !== undefined ? { "mom-decider": this.state.decider } : {}) };
		// Mom's saved decision model (globals) is what the config uses; state.decider is only set after a reload.
		const savedDecider = readMomGlobals().decider;
		if (!flags["mom-decider"] && typeof savedDecider === "string" && savedDecider) flags["mom-decider"] = savedDecider;
		// An unreachable decision model never stops Mom: she runs without it, and the user is told once.
		const decider = deciderFor(flags, this.context.modelRegistry);
		if (decider.ref && !decider.classifier && this.#warnedDecider !== decider.ref) {
			this.#warnedDecider = decider.ref;
			this.options.notify(`Mom's decision model ${decider.ref} is not available: Pi has no local System One classifier by that name. Mom runs without it: v2 sends every update to her model. Choose another in /mom settings.`, "warning");
		}
		const create = { key: this.key, cwd: this.identity.cwd, copy: "none", config: momConfiguration(this.identity, flags, this.context.modelRegistry) };
		let slice = await oven("create", create);
		// She is nearly always running, so a changed model or mode would never land: end her current operation,
		// configure the now idle slice, and have her pick the work up again.
		const stale = slice.state === "running" && (reconfigure || slice.model !== create.config.model);
		if (stale) {
			await oven("halt", { slice: slice.id });
			slice = await oven("create", create);
		}
		if (slice.state === "failed" && !slice.conversation) throw new Error(`Mom's slice in oven failed (${slice.reason}): ${slice.detail}`);
		assertSliceSupportsMode(String(flags["mom-mode"] ?? ""), slice.missingTools ?? []);
		this.slice = slice;
		this.sliceUrl = ovenSliceUrl(slice.id);
		if (stale) await this.send({ kind: "refresh" });
		this.error = undefined;
		this.options.changed();
	}

	/** Follow her slice: its state, her status document, and her `.mom` file after each change. */
	private async follow(): Promise<void> {
		while (!this.#closed) {
			try {
				if (!this.slice) await this.ensure();
				if (!this.slice) { await new Promise<void>(resolve => { this.#resume = resolve; }); continue; }
				await oven("watch", { slice: this.slice.id, untilSettled: false }, { signal: this.#watch.signal, onEvent: event => this.event(event) });
			} catch (error) {
				if (this.#closed) return;
				// Pausing stops her slice and Oven retires it, which ends this watch: expected, not a fault.
				if (this.state?.enabled === false) { this.slice = undefined; this.error = undefined; this.options.changed(); continue; }
				this.error = error instanceof OvenUnreachable ? error.message : String(error);
				this.options.changed();
				await new Promise(resolve => setTimeout(resolve, 2000));
				// Reconnect by key: the same slice, wherever oven is now.
				try { await this.ensure(); } catch (cause) { this.error = cause instanceof Error ? cause.message : String(cause); this.options.changed(); }
			}
		}
	}

	private event(event: any): void {
		if (this.#closed) return;
		this.error = undefined;
		if (event.type === "snapshot") {
			this.slice = event.slice;
			if (event.docs?.[STATUS_DOC]) this.status = event.docs[STATUS_DOC];
			this.#steps = 0; this.#saving = false;
			void this.reload();
		} else if (event.type === "state") this.slice = event.slice;
		else if (event.type === "settled") { this.slice = event.slice; this.#steps = 0; this.#saving = false; void this.reload(); }
		else if (event.type === "doc" && event.name === STATUS_DOC) {
			const before = this.status?.op?.job;
			this.status = event.value ?? undefined;
			// Her document follows the events that already counted this operation's steps: a new job restarts them, the first sight of one does not.
			if (this.status?.op?.job !== before && before !== undefined) { this.#steps = 0; this.#saving = false; }
			void this.reload();
		} else if (event.type === "message" && event.message?.role === "assistant") {
			// mom_begin only starts the operation: the steps are her own turns.
			const content = Array.isArray(event.message.content) ? event.message.content : [];
			if (!(content.length > 0 && content.every((block: any) => block.type === "toolCall" && block.name === "mom_begin"))) this.#steps++;
		} else if (event.type === "tool" && ["commit_graph", "commit_v2"].includes(event.tool?.name)) this.#saving = event.tool.status === "running";
		this.options.changed();
	}

	/** Read her `.mom` file (read-only), notify what she said, and pass on her hints for the lead. */
	async reload(): Promise<void> {
		this.#reloading ??= (async () => {
			try {
				const manager = this.context.sessionManager;
				const store = new SidecarStore(() => this.identity.sessionFile, this.identity.sessionId);
				this.state = await loadState(store, manager);
				// No saved mode: the startup flag decides, so fold the coverage track that flag's operations write.
				const flagMode = this.options.flags["mom-mode"];
				if (!this.state.mode && typeof flagMode === "string" && flagMode) { store.invalidate(); this.state = await loadState(store, manager, { mode: flagMode }); }
				this.#records = await store.load() as any;
				const branch = new Set(manager.getBranch().map(entry => entry.id));
				this.#checkpoints = branchCheckpoints(this.#records as any, branch);
				this.#openingError = undefined;
				// The trail is read beside her notes; an unreadable trail never hides the map.
				try {
					const trailStore = new TrailStore(() => this.identity.sessionFile, this.identity.sessionId);
					this.#trail = trailFor(await trailStore.load(), branch);
					this.#trailSkipped = trailStore.skipped.length; this.#trailError = undefined;
				} catch (error) { this.#trail = emptyTrail(); this.#trailSkipped = 0; this.#trailError = String(error); }
				try { this.#work = await this.workProjection(); } catch { this.#work = undefined; }
			} catch (error) { this.#openingError = String(error); this.#work = undefined; }
			finally { this.#reloading = undefined; }
			if (this.#closed) return;
			try { this.afterReload(); } catch (error) { if (!this.#closed) this.#openingError = String(error); }
			this.options.changed();
		})();
		return this.#reloading;
	}

	/** What a fresh read of her notes means for the user and the lead: her notices, a failure, and her corrections. */
	private afterReload(): void {
		for (const notice of this.status?.notices ?? []) if (notice.at > this.#seenNotices) { this.#seenNotices = notice.at; this.options.notify(notice.text, notice.level); }
		const failure = this.slice?.stage === "failed" && this.slice?.conversation ? `${this.slice.id}:${this.slice.detail}` : undefined;
		if (failure && failure !== this.#notifiedFailure && this.state?.enabled !== false) {
			this.#notifiedFailure = failure;
			this.options.notify(`Mom needs you: ${updateErrorSummary(this.slice.detail ?? "")} She retried ${this.slice.retryDelays?.length ?? 3} times. /mom refresh tries again; /mom detail has the full error.`, "warning");
		}
		// Records she could not read are skipped, not fatal; say so once for each new count.
		const skipped = this.state?.skipped?.length ?? 0;
		if (skipped > this.#notifiedSkipped) {
			this.#notifiedSkipped = skipped;
			this.options.notify(`Mom skipped ${skipped} unreadable record${skipped === 1 ? "" : "s"} in her saved notes and carried on from the last good map. /mom detail lists them.`, "warning");
		}
		// A model whose notes keep being rejected needs the user too (once, until a map is accepted).
		if (!this.rejecting) this.#notifiedRejection = false;
		if (this.rejecting && !this.needsYou && this.state?.enabled !== false && !this.#notifiedRejection) {
			this.#notifiedRejection = true;
			this.options.notify(`Mom needs you: ${this.rejectionText()}`, "warning");
		}
		this.publishCorrections();
		this.drain();
	}

	/**
	 * What her slice leaves behind after an operation (a bounded batch's remainder, or skipped ranges) is read by
	 * the next operation, which new activity or a request starts. While this Pi session is open, the client starts it
	 * as soon as she is idle, as long as each round changes something: her coverage, or the ranges awaiting review.
	 */
	private drain(): void {
		if (this.#closed || this.#draining || !this.state || !this.slice || this.busy || this.paused || this.retrying || this.needsYou || this.rejecting || this.problem()) return;
		if (this.slice.state !== "idle" || this.slice.stage !== "idle") return;
		// A round that failed is not repeated at once: new activity, her retries or /mom refresh go on from there.
		if (this.status?.lastError) return;
		const more = Boolean(this.status?.more), ranges = this.state.gaps.length > 0;
		if (!more && !ranges) { this.#drained = undefined; return; }
		// Trail coverage and backfill progress count too: each backfill operation moves `backfill.next`, not the cut.
		const progress = `${(this.state.coverageCut ?? this.state.checkpoint?.cut)?.parent}|${this.state.backfill?.next ?? ""}|${this.state.gaps.map(gap => gap.id).join(",")}|${this.status?.more}`;
		if (progress === this.#drained) return;
		this.#drained = progress;
		this.#draining = true;
		setTimeout(() => {
			this.#draining = false;
			if (this.#closed) return;
			this.send({ kind: more ? "update" : "refresh" }).catch(error => { this.error = error instanceof Error ? error.message : String(error); this.options.changed(); });
		}, DRAIN_DELAY_MS).unref();
	}

	/** Her continuity corrections reach the lead once each, as before. */
	private publishCorrections(): void {
		const branch = this.context.sessionManager.getBranch(), ids = new Set(branch.map(entry => entry.id));
		for (const record of this.#records) {
			const d = record.data;
			if (record.type !== "injection" || d.kind !== "window" || d.action !== "corrected" || (d.parent !== null && !ids.has(d.parent))) continue;
			if (this.#published.has(d.key) || branch.some(entry => entry.type === "custom_message" && entry.customType === WINDOW_CORRECTION && (entry.details as any)?.key === d.key)) continue;
			this.#published.add(d.key);
			this.options.publish({ customType: WINDOW_CORRECTION, content: d.content, details: { key: d.key } });
		}
	}

	private get busy(): boolean { return Boolean(this.slice && this.slice.state === "running" && this.status?.op); }
	private get paused(): boolean { return Boolean(this.slice?.stopped) || this.state?.enabled === false; }
	private get retrying(): boolean { return this.slice?.stage === "retrying" && Boolean(this.slice?.retry); }
	private get needsYou(): boolean { return Boolean(this.#openingError || this.status?.openingError || (this.slice?.stage === "failed" && this.slice?.conversation)); }
	private get rejecting(): boolean { return (this.status?.rejectedStreak ?? 0) >= 3 && !this.busy; }
	private rejectionText() { return `Mom's model produced notes she had to reject for ${this.status?.rejectedStreak} history ranges in a row: ${updateErrorSummary(this.status?.lastRejection ?? "")} Check --mom-model; /mom detail has the full error.`; }
	private problem(): string | undefined {
		return this.#openingError ?? this.status?.openingError ?? this.status?.blocked ?? (["failed", "retrying"].includes(this.slice?.stage) && this.slice?.conversation ? this.slice.detail : undefined)
			?? this.state?.error ?? this.state?.failure?.error;
	}
	private branch() { return this.context.sessionManager.getBranch(); }
	private coverage() { return coverageProgress(this.branch(), this.state?.coverageCut?.parent ?? this.state?.checkpoint?.cut.parent ?? null); }
	/** Her coverage reaches the last lead entry she reads (her own hints and bookkeeping don't count). */
	private complete(): boolean {
		// The trail has no checkpoint: her coverage cursor alone says what she has read.
		if (!this.state || (!this.state.checkpoint && !this.trailMode) || this.busy || this.problem() || this.state.gaps.length || this.state.failure || this.status?.more) return false;
		const branch = this.branch(), cut = this.state.coverageCut?.parent ?? this.state.checkpoint?.cut.parent ?? null;
		const at = cut === null ? -1 : branch.findIndex(entry => entry.id === cut);
		if (cut !== null && at < 0) return false;
		return branch.slice(at + 1).every(entry => !extractEvents({ key: this.identity.sessionId, actor: "lead" }, entry).length);
	}
	/** Oven says why new activity is waiting and when it goes at the latest. */
	private waitingText(): string | undefined {
		const waiting = this.slice?.followed?.waiting, due = waiting?.dueAt;
		if (!waiting || this.status?.more) return undefined;
		return waiting.reason === "turn" ? `waiting for the lead's turn to end${due ? ` · by ${clock(due)}` : ""}`
			: waiting.reason === "quiet" ? `updating at ${clock(due ?? Date.now())} if things stay quiet`
				: `${this.state?.checkpoint || (this.trailMode && this.state?.coverageCut) ? "up to date" : "nothing to map yet"} · will check routine work by ${clock(due ?? Date.now())}`;
	}
	private activity(): string {
		if (!this.busy) return "idle";
		if (this.#saving) return "saving";
		return this.status?.op?.activity ?? "thinking";
	}

	view(explicit: boolean, elapsed = true): PanelView {
		if (this.error && !this.state) return { status: "reconnecting", summary: "Waiting for Mom's saved view. Existing notes have not been loaded.", error: updateErrorSummary(this.error) };
		if (!this.state) return { status: this.#openingError ? "needs you" : "connecting", summary: "Waiting for Mom's saved view. Existing notes have not been loaded.",
			...(this.#openingError ? { error: `Mom couldn't open her saved notes: ${updateErrorSummary(this.#openingError)} /mom detail has the full error.` } : {}) };
		const state = this.state, reason = this.problem(), done = this.complete();
		const progress = done || state.gaps.length ? undefined : this.coverage();
		let status: string;
		if (this.busy) {
			const op = this.status!.op!, target = op.target !== undefined ? coverageProgress(this.branch(), op.target ?? null) : undefined;
			const toward = progress && target && target.percent > progress.percent ? ` → ${target.percent}%` : "";
			const reviewing = !explicit ? "" : op.recovering ? " · reviewing earlier activity" : state.gaps.length ? " · earlier activity pending" : "";
			const activity = this.activity(), section = op.section;
			const steps = section && op.mode === "audit" && activity !== "saving" ? ` · section ${section.section} of ${section.of}`
				: activity === "thinking" && this.#steps ? ` · step ${this.#steps + 1}` : "";
			status = `updating ${meter(activity)}${reviewing}${progress ? ` · ${progress.percent}%${toward} read` : ""} · ${activity}${steps}`;
			if (elapsed) status += ` ${formatElapsed(Date.now() - op.startedAt)}`;
		} else if (this.needsYou || this.rejecting) status = "needs you";
		else if (this.retrying) status = reason ? `retrying at ${clock(this.slice.retry.at)} · attempt ${this.slice.retry.attempt} of ${this.slice.retry.of}`
			: `re-reviewing ${state.gaps.length} skipped range${state.gaps.length === 1 ? "" : "s"} at ${clock(this.slice.retry.at)}`;
		else if (done) status = "up to date";
		else if (this.waitingText()) status = this.waitingText()!;
		else if (this.status?.more || (!state.checkpoint && this.branch().some(entry => entry.type === "message" && entry.message.role === "user"))) status = `catching up${progress ? ` · ${progress.percent}% read` : ""}`;
		else if (!state.checkpoint) status = "idle";
		else status = "update starting";
		if (this.paused) status = "paused"; else if (this.hush) status = "quiet";
		const work = presentGraph({ ...this.readGraph(), coverageComplete: done, coverage: this.coverage() }) as WorkView;
		const trail = this.trailMode ? this.trailView() : undefined;
		const finding = state.checkpoint?.note;
		const feedback = finding ? state.feedback[noticeKey(finding)] : undefined;
		const muted = finding && feedbackApplies(feedback, finding) && !(explicit && ["ignored", "backoff"].includes(feedback!.action));
		const showFinding = done && finding && !muted && (explicit || (!this.hush && state.nudgedClasses.includes(finding.riskClass) && !state.engagement.remaining));
		return { status, complete: done, compact: false, work, summary: trail ? plainTrailRows(trail.glance).join("\n") : summaryText(work), coverage: progress, sliceUrl: this.sliceUrl,
			...(trail ? { trail } : {}), note: showFinding ? finding.text : undefined, noteTag: finding?.riskClass === "worth_considering" ? "Worth considering" : "Heads up",
			error: this.busy ? undefined : this.error ? updateErrorSummary(this.error) : this.rejecting && !this.needsYou ? this.rejectionText() : !reason ? undefined
				: this.#openingError || this.status?.openingError ? `Mom couldn't open her saved notes: ${updateErrorSummary(reason)} /mom detail has the full error.`
					: this.needsYou ? `${updateErrorSummary(reason)} Retried ${this.slice?.retryDelays?.length ?? 3} times. /mom refresh tries again; /mom detail has the full error.`
						: `Last attempt: ${updateErrorSummary(reason)}` };
	}

	/** The widget's and panel's trail block: where we are at a glance, and what Mom is doing when she is busy. */
	private trailView(): NonNullable<PanelView["trail"]> {
		const trail = this.#trail ?? emptyTrail();
		return { glance: glance(trail), count: trail.waypoints.length, ...(this.busy ? { stage: this.activity() } : {}) };
	}

	/**
	 * Where we are on the trail, for the lead's context: sent before a turn when it changed since the last one sent.
	 * Gated like the anchor (tracking on, continuity on, not hushed); undefined outside trail mode, on an empty
	 * trail, or when this standing is already in the branch.
	 */
	standingForLead(): { key: string; content: string } | undefined {
		const state = this.state, trail = this.#trail;
		if (!state || !this.trailMode || !trail?.waypoints.length || this.paused || !state.inject || this.hush) return undefined;
		const content = renderStanding(trail);
		if (!content) return undefined;
		// A compaction drops the earlier standing from the lead's context, so the same text is owed again
		// after one: the key carries the latest compaction, and only messages after it count as delivered.
		const branch = this.branch(), since = branch.findLastIndex(entry => entry.type === "compaction");
		const key = standingKey(`${since < 0 ? "" : branch[since].id}\n${content}`);
		const delivered = branch.slice(since + 1).some(entry => entry.type === "custom_message" && entry.customType === TRAIL_STANDING && (entry.details as any)?.key === key);
		return delivered ? undefined : { key, content };
	}

	diagnostics(): PanelDiagnostics {
		const state = this.state, error = this.problem(), usage = state?.usage ?? emptyUsage();
		const sections: PanelDiagnostics["sections"] = [];
		const add = (title: string, text: string) => sections.push({ title, text });
		add("Now", this.paused ? "Tracking is paused." : this.needsYou && (this.#openingError || this.status?.openingError) ? "Mom could not open her saved notes." : this.busy
			? (this.status?.op?.recovering ? "Reviewing earlier activity." : "Updating notes.") : this.view(true).status);
		if (error || this.error) add("Last problem", updateErrorSummary(error ?? this.error!));
		add("Next", this.paused ? "Updates stay paused until tracking resumes." : this.busy ? "The current update is running in oven. Mom saves accepted changes when it finishes."
			: this.needsYou ? "Mom needs you: /mom refresh tries again." : this.retrying ? `Mom retries automatically at ${clock(this.slice.retry.at)}.`
				: "Mom updates in oven as the conversation continues, also while Pi is closed.");
		add("Saved notes", state?.checkpoint ? `Last saved ${new Date(state.checkpoint.at).toLocaleString()}.` : "No notes have been saved yet.");
		if (state?.skipped?.length) add("Unreadable records", `${state.skipped.length} skipped; she carried on from the last good map.\n${state.skipped.slice(0, 5).join("\n")}${state.skipped.length > 5 ? `\n…and ${state.skipped.length - 5} more` : ""}`);
		add("History", `Ranges awaiting review: ${state?.gaps.length ?? 0} · Unavailable sources: ${this.status?.unavailable?.length ?? 0}`);
		if (this.trailMode || this.#trail?.waypoints.length || this.#trailError) {
			const trail = this.#trail ?? emptyTrail();
			add("Trail", `${trail.waypoints.length} entr${trail.waypoints.length === 1 ? "y" : "ies"} · ${trail.struck.length} struck · ${this.#trailSkipped} unreadable record${this.#trailSkipped === 1 ? "" : "s"} skipped`
				+ (this.#trailError ? `\nThe trail could not be read: ${updateErrorSummary(this.#trailError)}` : ""));
		}
		add("Session", `Model calls: ${usage.calls} · ${formatElapsed(usage.elapsedMs)} total model/update time\n${(usage.input + usage.cacheRead + usage.cacheWrite).toLocaleString()} input tokens · ${usage.output.toLocaleString()} output tokens · $${usage.nominalCost.toFixed(4)} nominal cost`);
		const timing = this.status?.operationTiming;
		if (timing) add("Last operation", `${formatElapsed(timing.totalMs)} total · ${formatElapsed(timing.startupMs)} startup · ${formatElapsed(timing.requestMs)} model requests`);
		return { sections, raw: JSON.stringify({ error, missingSources: this.status?.unavailable ?? [], slice: this.slice && { id: this.slice.id, key: this.slice.key, stage: this.slice.stage, reason: this.slice.reason, detail: this.slice.detail, retry: this.slice.retry, follow: this.slice.follow, followed: this.slice.followed },
			status: this.status, uncertainEffects: this.status?.uncertainEffects ?? [], failureState: state?.failure, skippedEvidence: state?.gaps, sessionUsage: usage, engagement: state?.engagement }, null, 2) };
	}

	/** What the panel, widget and workspace read. */
	get snapshot(): Snapshot | undefined {
		const state = this.state;
		if (!state) return undefined;
		const controls: Controls = { enabled: !this.paused, inject: state.inject, hush: this.hush, nudgedClasses: [...state.nudgedClasses], mode: state.mode, model: state.model,
			// Only what the user saved counts as set: a flag default must never look like a configured model.
			// Undefined is "nothing saved yet"; empty is "explicitly no decision model".
			decider: state.decider };
		const anchor = state.reservedAnchor && controls.enabled && state.inject && !this.hush ? { key: state.reservedAnchor.key, content: state.reservedAnchor.content, at: state.reservedAnchor.at } : undefined;
		return { passive: this.view(false), explicit: this.view(true), diagnostics: this.diagnostics(), usage: structuredClone(state.usage ?? emptyUsage()), controls,
			...(this.#work ? { work: structuredClone(this.#work) } : {}),
			...(this.busy ? { startedAt: this.status!.op!.startedAt } : {}), ...(anchor ? { preparedAnchor: anchor } : {}),
			telemetry: { model: this.slice?.model ?? String(this.options.flags["mom-model"] ?? ""), activity: this.activity(),
				...(state.checkpoint ? { lastSavedAt: state.checkpoint.at } : this.trailMode && this.#trail?.waypoints.length ? { lastSavedAt: this.#trail.waypoints.at(-1)!.at } : {}), pendingRanges: state.gaps.length, unavailableSources: this.status?.unavailable?.length ?? 0,
				...(this.status?.operationTiming ? { timing: { ...this.status.operationTiming } } : {}) },
			...(this.#host ? { host: this.#host } : {}) };
	}

	readGraph(options: { nodes?: string[]; depth?: number; checkpoint?: string } = {}) {
		const events = this.branch().flatMap(entry => extractEvents({ key: this.identity.sessionId, actor: "lead" }, entry));
		return readGraph(this.#checkpoints, this.state?.checkpoint, this.state?.checkpointId, events, options);
	}

	/** Read structured lead, worker, and delegate activity without changing any authority. */
	async workProjection(): Promise<WorkProjection> {
		const feed = new LiveFeed(this.context.sessionManager);
		await feed.restore(this.state?.coverageCut ?? this.state?.checkpoint?.cut);
		await feed.capture(Infinity, true);
		return projectWork({ entries: feed.sourceEntries() });
	}

	/** Send her a request; it waits behind work she is doing. */
	async send(request: MomRequest): Promise<string> {
		if (!this.slice) await this.ensure();
		if (!this.slice) throw new Error("Mom is paused.");
		const id = randomUUID();
		this.slice = await oven("send", { slice: this.slice.id, text: encodeRequest(this.identity.sessionFile, request), requestId: id });
		this.options.changed();
		return id;
	}

	/** Wait for her to finish what she has (including a request just sent), then read her notes again. */
	async settle(signal?: AbortSignal): Promise<void> {
		const settled = await oven("wait", { slice: this.slice.id, timeoutMs: 600_000 }, { signal });
		this.slice = { ...this.slice, ...settled };
		const state = await oven("state", { slice: this.slice.id, names: [STATUS_DOC] });
		this.status = state.docs[STATUS_DOC] ?? this.status;
		await this.reload();
	}

	async rebuild(progress: (text: string, sliceUrl?: string) => void, signal: AbortSignal): Promise<RebuiltMap> {
		const flags = { ...this.options.flags, ...(this.state?.mode ? { "mom-mode": this.state.mode } : {}),
			...(this.state?.model ? { "mom-model": this.state.model } : {}),
			...(this.state?.decider !== undefined ? { "mom-decider": this.state.decider } : {}) };
		return rebuildMap(this.context, this.identity, flags, progress, signal);
	}

	async acceptRebuild(candidate: RebuiltMap): Promise<void> {
		await acceptRebuiltMap(this.context, candidate);
		await this.#reloading;
		await this.reload();
	}

	async request(command: Command, signal?: AbortSignal): Promise<unknown> {
		switch (command.kind) {
			case "relabel": {
				if (this.paused) throw new Error("Mom is paused.");
				await this.send({ kind: "relabel" });
				await this.settle(signal);
				return undefined;
			}
			case "refresh": {
				if (this.paused) throw new Error("Mom is paused.");
				// A refresh is explicit: it ends a wait she is in the middle of (for a running worker or a screen).
				if (this.slice && (this.status?.waitingForWorkers || this.status?.deferredUntil)) await oven("halt", { slice: this.slice.id });
				await this.send({ kind: "refresh" });
				await this.settle(signal);
				return undefined;
			}
			case "graph": {
				if (this.#openingError) throw new Error(this.#openingError);
				const view = this.view(true);
				return { ...this.readGraph(command.options), status: view.status, error: view.error, coverageComplete: view.complete, coverage: view.coverage };
			}
			case "source": {
				const feed = new LiveFeed(this.context.sessionManager);
				await feed.restore(this.state?.coverageCut ?? this.state?.checkpoint?.cut);
				for (const observation of this.state?.observations ?? []) feed.observe(observation);
				if (!feed.byRef.has(command.ref)) await feed.capture(Infinity);
				return { ...await feed.lookup(command.ref, command.offset ?? 0, command.limit), pairedRef: feed.pairedSource(command.ref) };
			}
			case "log": {
				await this.reload();
				const ids = new Set(this.branch().map(entry => entry.id));
				return this.#records.filter(record => (record.type === "notice" || record.type === "injection") && (record.data.parent === null || ids.has(record.data.parent)));
			}
			case "controls": return this.controls(command.change);
			case "finding": {
				const note = this.state?.checkpoint?.note;
				if (!note || note.text !== command.finding) throw new Error("This finding has changed; reopen Mom.");
				await this.send({ kind: "finding", action: command.action, finding: command.finding });
				return null;
			}
			case "status": {
				this.#host = await this.sliceHost().catch(() => undefined);
				return this.snapshot;
			}
			case "trail": {
				if (this.#trailError) throw new Error(this.#trailError);
				return trailText(this.#trail ?? emptyTrail(), command.options);
			}
			case "mark": return this.mark(command.waypoint);
			case "strike": return this.strike(command.target, command.reason);
		}
	}

	private trailStore(): TrailStore { return new TrailStore(() => this.identity.sessionFile, this.identity.sessionId); }

	/** The latest lead entry on the branch that is evidence (her own hints are not), as the waypoint's ref. */
	private latestLeadRef(): { leaf: string; ref: string } {
		const branch = this.branch(), leaf = this.context.sessionManager.getLeafId();
		if (!leaf || !branch.length) throw new Error("There is nothing on this branch to mark yet.");
		const cited = [...branch].reverse().find(entry => extractEvents({ key: this.identity.sessionId, actor: "lead" }, entry).length)?.id ?? leaf;
		return { leaf, ref: `${this.identity.sessionId}:${cited}` };
	}

	/** `/mom mark`: the user's own waypoint, citing the latest lead entry, on the current line unless one is named. */
	private async mark(input: { kind: WaypointKind; caption: string; line?: string }): Promise<Waypoint> {
		const caption = input.caption.replace(/\s+/g, " ").trim();
		if (!caption) throw new Error("A waypoint needs a caption.");
		const { leaf, ref } = this.latestLeadRef();
		const trail = this.#trail ?? emptyTrail();
		const line = input.line?.replace(/\s+/g, " ").trim() || whereWeAre(trail).currentLine || "session";
		const waypoint: Waypoint = { id: `user:${randomUUID()}`, sessionId: this.identity.sessionId, at: Date.now(), kind: input.kind, line, refs: [ref], caption, parent: leaf, by: "user" };
		const written = await this.trailStore().appendWaypoint(waypoint);
		await this.reload();
		return written;
	}

	/** `/mom strike`: a wrong waypoint stays in the file but leaves this branch's trail. */
	private async strike(target: string, reason?: string): Promise<Strike> {
		const trail = this.#trail ?? emptyTrail();
		if (trail.struck.some(item => item.waypoint.id === target)) throw new Error(`Waypoint ${target} is already struck.`);
		if (!trail.waypoints.some(waypoint => waypoint.id === target)) throw new Error(`No waypoint ${target} is on this branch's trail.`);
		const text = reason?.replace(/\s+/g, " ").trim();
		const strike: Strike = { id: `strike:${randomUUID()}`, sessionId: this.identity.sessionId, at: Date.now(), target, ...(text ? { reason: text } : {}), parent: this.context.sessionManager.getLeafId() };
		const written = await this.trailStore().appendStrike(strike);
		await this.reload();
		return written;
	}

	/** Persist a setting locally, then apply slice lifecycle/configuration changes off the UI path. */
	async controls(change: ControlChange): Promise<void> {
		if ("hush" in change) { this.hush = change.hush; this.options.changed(); return; }
		// The global file is authoritative. Resolve the UI as soon as that local atomic write succeeds;
		// a local Oven request must not hold the settings dialog open.
		await writeMomGlobals(change as MomGlobals);
		if (this.state) Object.assign(this.state, change);
		this.options.changed();
		this.#controlTail = this.#controlTail.then(() => this.applyControl(change)).catch(error => {
			if (!this.#closed) this.options.notify(`Setting saved globally, but Mom could not apply it: ${updateErrorSummary(String(error))}`, "warning");
		});
	}

	private async applyControl(change: Exclude<ControlChange, { hush: boolean }>): Promise<void> {
		if (this.#closed) return;
		const pausing = "enabled" in change && !change.enabled;
		const resuming = "enabled" in change && change.enabled;
		const reconfiguring = "mode" in change || "model" in change || "decider" in change;
		if (pausing) { await this.release(); this.options.changed(); return; }
		if (resuming) { this.#resume?.(); this.#resume = undefined; }
		if (reconfiguring || resuming) await this.ensure(reconfiguring);
		if (resuming) await this.send({ kind: "refresh" });
		// Suggestions and continuity are read from globals on the next operation; they need no slice round trip.
	}

	/** Her slice in oven, read when Status is refreshed. */
	private async sliceHost(): Promise<SliceHost | undefined> {
		const [health, slices] = await Promise.all([fetch(`${ovenUrl()}/health`).then(res => res.json() as Promise<{ pid: number }>), oven<any[]>("list", {})]);
		const slice = slices.find(s => s.key === this.key);
		return slice ? { pid: health.pid, slice: slice.id, state: slice.stage ?? slice.state, startedAt: slice.createdAt, sampledAt: Date.now() } : undefined;
	}

	/** The hint the lead adds after a compaction, when she prepared one and it is not in the lead's context yet. */
	pendingAnchor(): PreparedAnchor | undefined {
		const anchor = this.snapshot?.preparedAnchor;
		if (!anchor) return undefined;
		const delivered = this.branch().some(entry => entry.type === "custom_message" && entry.customType === ANCHOR && (entry.details as any)?.key === anchor.key);
		return delivered ? undefined : anchor;
	}

	/** The lead moved to another branch: what her slice is working on belongs to the old one. */
	async halt(): Promise<void> {
		if (this.slice) await oven("halt", { slice: this.slice.id }).catch(() => {});
	}

	/** Stop following her. Her slice keeps following the session in oven. */
	close(): void { this.#closed = true; this.#watch.abort(); this.#resume?.(); }

	/** Pausing ends her slice: halt what runs, stop it, and let Oven retire it. Also finds a slice left by an earlier client. */
	private async release(): Promise<void> {
		const id = this.slice?.id ?? (await oven<any[]>("list", {}).catch(() => [])).find(slice => slice.key === this.key && !slice.stopped)?.id;
		this.slice = undefined;
		if (!id) return;
		try { await oven("halt", { slice: id }); await oven("stop", { slice: id }); }
		catch (error) { if (!/No slice/.test(String(error))) throw error; }
	}
}
