/**
 * Path's client in the lead's Pi session. Path runs in oven: its slice follows this session's file, reviews
 * new activity, retries failed turns, and writes its `.mom` file. This client only ensures its slice (by
 * key, with its configuration), follows it with `oven_watch`, reads its `.mom` file read-only, renders its
 * state, and sends the user's requests. It never writes the `.mom` file.
 */
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { branchCheckpoints, emptyUsage, loadState, noticeKey, type MomState, type Usage } from "./checkpoint.ts";
import { STATUS_DOC, type MomStatus } from "./engine.ts";
import { branchIds, extractEvents, LiveFeed } from "./feed.ts";
import { readGraph } from "./mother.ts";
import { encodeRequest, type FindingRequest, type MomRequest } from "./operation.ts";
import { OVEN_EXPIRES, oven, ovenHeartbeat, ovenHealth, ovenSliceUrl, OvenUnreachable, requireExpiry } from "./oven.ts";
import type { PanelDiagnostics, PanelView } from "../ui/panel.ts";
import { feedbackApplies, type FindingAction, type ProcessRiskClass } from "./process-health.ts";
import { coverageProgress, presentGraph, summaryText, type WorkView } from "../ui/presentation.ts";
import { SidecarStore } from "./sidecar.ts";
import { assertSliceSupportsMode, deciderFor, identityOf, momConfiguration, ownerKey, type SessionIdentity } from "./slice.ts";
import { readMomGlobals, writeMomGlobals, type MomGlobals } from "./globals.ts";
import { formatTiming, formatUsage, updateErrorSummary, WAITING_FOR_VIEW } from "./status.ts";
import { ANCHOR } from "./anchor.ts";
import { WINDOW_CORRECTION } from "./window.ts";
import { projectWork, type WorkProjection } from "../work/projection.ts";
import { acceptRebuiltMap, rebuildMap, type RebuiltMap } from "./rebuild.ts";
import { emptyTrail, trailEntries, type Trail } from "../trail/types.ts";
import { TrailStore, trailFor } from "../trail/store.ts";
import { beforeLastDetour, evolution, glance, landing, openItems, renderBefore, renderEvolution, renderLanding, renderOpen, renderStanding, renderTrail, untitledEntries } from "../trail/projection.ts";
import { TRAIL_REFRESH_TASK, UNTITLED_PER_CALL } from "../trail/prompt.ts";
import { trailBriefing } from "../trail/record.ts";
import { parseRef } from "../util/ref.ts";
import { plainTrailRows } from "../ui/trail-view.ts";
import { clockTime, formatDuration } from "../util/format.ts";
import { errorMessage } from "../util/text.ts";

/** Path's slice in oven, as the Status tab shows it. */
export interface SliceHost { pid: number; slice: string; state: string; startedAt: number; sampledAt: number }
export interface SourcePage { ref: string; text: string; offset: number; totalChars: number; nextOffset: number | null; pairedRef?: string }
export interface PreparedAnchor { key: string; content: string; at: number }
export interface Controls { detached?: boolean; enabled: boolean; inject: boolean; hush: boolean; nudgedClasses: ProcessRiskClass[]; mode: string; model: string; decider?: string }
export interface Telemetry {
	model: string; activity: string; lastSavedAt?: number; pendingRanges: number; unavailableSources: number;
	timing?: { startupMs: number; requestMs: number; totalMs: number; oldestEvidenceAgeMs: number };
}
export interface Snapshot {
	passive: PanelView; explicit: PanelView; diagnostics: PanelDiagnostics; usage: Usage; controls: Controls; work?: WorkProjection;
	startedAt?: number; preparedAnchor?: PreparedAnchor; telemetry: Telemetry; host?: SliceHost;
}
export type ControlChange = { detached: boolean } | { enabled: boolean } | { inject: boolean } | { hush: boolean } | { nudgedClasses: ProcessRiskClass[] } | { mode: string } | { model: string } | { decider: string };
export type Command =
	| { kind: "refresh" }
	| { kind: "graph"; options: { nodes?: string[]; depth?: number; checkpoint?: string } }
	| { kind: "source"; ref: string; offset?: number; limit?: number }
	| { kind: "controls"; change: ControlChange }
	| { kind: "finding"; action: FindingRequest; finding: string }
	| { kind: "status" }
	| { kind: "trail"; options: TrailOptions };
export interface TrailOptions { line?: string; query?: string; before?: boolean; open?: boolean; evolution?: boolean; limit?: number }
export interface Publication { customType: string; content: string; details: { key: string } }
/** The hidden message carrying Path's standing (where we are on the trail) into the lead's context. */
export const TRAIL_STANDING = "pi-tether.mom-trail";
export const TRAIL_MODE = "trail";
const NO_WAYPOINTS = "Path has not marked any waypoints yet.";
/** The trail's identity for the lead: the standing changes, a new message follows; otherwise nothing is appended. */
export const standingKey = (content: string): string => createHash("sha256").update(content).digest("hex").slice(0, 16);
/** What the `mom` tool's `trail` request and the /path trail commands read: one projection, as text. */
export function trailText(trail: Trail, options: TrailOptions = {}): { text: string; count: number } {
	const count = trail.waypoints.length;
	if (!count) return { text: NO_WAYPOINTS, count };
	if (options.before) return { text: renderBefore(beforeLastDetour(trail)), count };
	if (options.open) return { text: renderOpen(openItems(trail, options.line)), count };
	if (options.evolution) return { text: renderEvolution(evolution(trail)), count };
	if (options.query) return { text: renderLanding(landing(trail, options.query)), count };
	return { text: `${renderStanding(trail)}\n\n${renderTrail(trail, { line: options.line, limit: options.limit ?? 40 })}`, count };
}

/** How long a settings change waits for its answer before it is shown as made. */
/** Between its rounds of catching up on what a bounded batch or a skipped range left. */
const DRAIN_DELAY_MS = 250;
const STAGES = ["reading history", "screening", "starting Path", "thinking", "saving"] as const;
/** Five-cell bar: one cell per stage reached. */
const meter = (activity: string | undefined) => {
	const reached = Math.max(1, STAGES.indexOf((activity ?? "") as typeof STAGES[number]) + 1);
	return "▰".repeat(reached) + "▱".repeat(STAGES.length - reached);
};

/** The lead's client of Path's slice. */
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
	#ensuring?: Promise<boolean>;
	#watch = new AbortController();
	/** Renews its slice while this session lives; cleared at close. */
	#beat?: ReturnType<typeof setInterval>;
	/** Wakes the follow loop when a paused Path resumes (or the client closes). */
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
	/** Trail: when its watcher started its current turn, and whether that turn is a refresh. */
	#runningSince?: number;
	#refreshing = false;

	constructor(private context: ExtensionContext, private readonly options: {
		flags: Record<string, string | boolean | undefined>; changed(): void; publish(message: Publication): void;
		notify(text: string, level: "info" | "warning" | "error"): void;
	}) {
		this.identity = identityOf(context.sessionManager, context.cwd);
		this.key = ownerKey(this.identity);
	}

	updateContext(context: ExtensionContext) { this.context = context; }

	/** This branch's trail (waypoints in recorded order, struck ones removed); undefined until its notes are read. */
	get trail(): Trail | undefined { return this.#trail; }
	get trailSkipped(): number { return this.#trailSkipped; }
	get trailError(): string | undefined { return this.#trailError; }

	recapAnchor(): string | undefined {
		const trail = this.#trail;
		if (!this.trailMode || !trail?.waypoints.length || this.paused || this.error || this.#trailError) return;
		const branch = this.branch(), covered = this.coveredThrough();
		const latestUser = branch.findLastIndex(entry => entry.type === "message" && entry.message.role === "user");
		if (latestUser < 0 || branch.findIndex(entry => entry.id === covered) < latestUser) return;
		return renderStanding(trail);
	}

	/** The mode in force, as its slice resolves it: a saved mode (global, then this session's), else the startup flag. */
	private get mapMode(): string { return this.state?.mode || String(this.options.flags["mom-mode"] ?? ""); }
	private get trailMode(): boolean { return this.mapMode === TRAIL_MODE; }

	/** Ensure its slice (create-or-get by key with its configuration), read its notes, and follow it. */
	async connect(): Promise<void> {
		await this.reload();
		if (this.#closed) return;
		await this.ensure();
		if (this.#closed) return;
		this.#beat ??= setInterval(() => {
			// The watch/reconnect reports transport failures. A failed beat never starts a replacement conversation.
			if (!this.#closed && !this.state?.detached && !this.paused && this.slice) void oven("expires", { slice: this.slice.id }).catch(() => {});
		}, ovenHeartbeat.everyMs);
		this.#beat.unref?.();
		void this.follow();
	}

	/** Ensure its slice; true when it asked the slice to pick its work up again. */
	async ensure(reconfigure = false): Promise<boolean> {
		if (this.#closed) return false;
		if (this.#ensuring) {
			await this.#ensuring;
			return reconfigure ? this.ensure(true) : false;
		}
		const pending = this.ensureSlice(reconfigure);
		this.#ensuring = pending;
		try { return await pending; }
		finally { this.#ensuring = undefined; }
	}

	private async ensureSlice(reconfigure: boolean): Promise<boolean> {
		// A paused Path retains history in Oven without an active client watch or lease.
		if (this.state?.enabled === false) { await this.release(); return false; }
		// Saved settings override startup flags. Each operation pins its configured mode at begin.
		// `create` is create-or-get: an idle slice takes this configuration; a running one is returned unchanged.
		const flags = { ...this.options.flags, ...(this.state?.mode ? { "mom-mode": this.state.mode } : {}), ...(this.state?.model ? { "mom-model": this.state.model } : {}),
			...(this.state?.decider !== undefined ? { "mom-decider": this.state.decider } : {}) };
		// Path's saved decision model (globals) is what the config uses; state.decider is only set after a reload.
		const savedDecider = readMomGlobals().decider;
		if (!flags["mom-decider"] && typeof savedDecider === "string" && savedDecider) flags["mom-decider"] = savedDecider;
		// An unreachable decision model never stops Path: it runs without a decision model, and the user is told once.
		const decider = deciderFor(flags, this.context.modelRegistry);
		if (decider.ref && !decider.classifier && this.#warnedDecider !== decider.ref) {
			this.#warnedDecider = decider.ref;
			this.options.notify(`Path's decision model ${decider.ref} is not available: Pi has no local System One classifier by that name. Path runs without it: v2 sends every update to its model. Choose another in /path settings.`, "warning");
		}
		// The trail's watcher resumes after the last entry the trail covers, and is briefed with the trail when it is made.
		const trail = String(flags["mom-mode"] ?? "") === TRAIL_MODE;
		// The watcher is a different slice from a map mode's: its own key, and the other one stops so only one follows.
		const key = this.sliceKey(trail);
		await this.stopSlice(this.sliceKey(!trail));
		const expires = this.state?.detached ? "never" : OVEN_EXPIRES;
		const create = { owner: { client: "pi-delegate", session: this.identity.sessionId }, key, cwd: this.identity.cwd, copy: "none", expires, expiryAction: "archive",
			config: momConfiguration(this.identity, flags, this.context.modelRegistry, trail ? { after: this.coveredThrough() } : {}),
			...(trail ? { task: `Path trail watcher\n${await trailBriefing(this.identity.sessionFile)}` } : {}) };
		let slice = await oven("create", create);
		// Keyed creates keep their original expiry. Apply only this client's explicit lease setting, without waking it.
		if (slice.expiryAction === "archive" && !isDeepStrictEqual(slice.expires, expires)) slice = await oven("expires", { slice: slice.id, expires });
		await requireExpiry(slice, oven, expires);
		// It is nearly always running, so a changed model or mode would never land: end its current operation,
		// configure the now idle slice, and have it pick the work up again.
		const stale = slice.state === "running" && (reconfigure || slice.model !== create.config.model);
		if (stale) {
			await oven("halt", { slice: slice.id });
			slice = await oven("create", create);
			await requireExpiry(slice, oven, expires);
		}
		if (slice.state === "failed" && !slice.conversation) throw new Error(`Path's slice in oven failed (${slice.reason}): ${slice.detail}`);
		assertSliceSupportsMode(String(flags["mom-mode"] ?? ""), slice.missingTools ?? []);
		this.slice = slice;
		this.sliceUrl = ovenSliceUrl(slice.id);
		if (this.#closed) return false; // end() joins this create before releasing; reload only leaves it for rebinding.
		// Explicit reconnect/resume reacquires the archived mapping, never a replacement conversation.
		const asleep = slice.archived || slice.stopped || (reconfigure && ["failed", "retrying"].includes(slice.stage));
		const wake = asleep || (stale && !trail);
		if (wake) await (trail ? this.refreshTrail() : this.send({ kind: "refresh" }));
		this.error = undefined;
		this.options.changed();
		return wake;
	}

	/** Follow its slice: its state, its status document, and its `.mom` file after each change. */
	private async follow(): Promise<void> {
		while (!this.#closed) {
			try {
				if (!this.slice) await this.ensure();
				if (!this.slice) { await new Promise<void>(resolve => { this.#resume = resolve; }); continue; }
				await oven("watch", { slice: this.slice.id, untilSettled: false }, { signal: this.#watch.signal, onEvent: event => this.event(event) });
			} catch (error) {
				if (this.#closed) return;
				// Pausing aborts the watch and archives execution; saved history is not a fault.
				if (this.state?.enabled === false) { this.slice = undefined; this.error = undefined; this.options.changed(); continue; }
				this.error = error instanceof OvenUnreachable ? error.message : String(error);
				this.options.changed();
				await new Promise(resolve => setTimeout(resolve, 2000));
				// Reconnect by key: the same slice, wherever oven is now.
				try { await this.ensure(); } catch (cause) { this.error = errorMessage(cause); this.options.changed(); }
			}
		}
	}

	private event(event: any): void {
		if (this.#closed) return;
		this.error = undefined;
		if (event.slice) {
			if (event.slice.state === "running") this.#runningSince ??= Date.now();
			else { this.#runningSince = undefined; this.#refreshing = false; }
		}
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
			// Its document follows the events that already counted this operation's steps: a new job restarts them, the first sight of one does not.
			if (this.status?.op?.job !== before && before !== undefined) { this.#steps = 0; this.#saving = false; }
			void this.reload();
		} else if (event.type === "message" && event.message?.role === "assistant") {
			// mom_begin only starts the operation: the steps are its own turns.
			const content = Array.isArray(event.message.content) ? event.message.content : [];
			if (!(content.length > 0 && content.every((block: any) => block.type === "toolCall" && block.name === "mom_begin"))) this.#steps++;
		} else if (event.type === "tool" && ["commit_graph", "commit_v2"].includes(event.tool?.name)) this.#saving = event.tool.status === "running";
		this.options.changed();
	}

	/** Read its `.mom` file (read-only), notify what it said, and pass on its hints for the lead. */
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
				const branch = branchIds(manager);
				this.#checkpoints = branchCheckpoints(this.#records as any, branch);
				this.#openingError = undefined;
				// The trail is read beside its notes; an unreadable trail never hides the map.
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

	/** What a fresh read of its notes means for the user and the lead: its notices, a failure, and its corrections. */
	private afterReload(): void {
		for (const notice of this.status?.notices ?? []) if (notice.at > this.#seenNotices) { this.#seenNotices = notice.at; this.options.notify(notice.text, notice.level); }
		const failure = this.slice?.stage === "failed" && this.slice?.conversation ? `${this.slice.id}:${this.slice.detail}` : undefined;
		if (failure && failure !== this.#notifiedFailure && this.state?.enabled !== false) {
			this.#notifiedFailure = failure;
			this.options.notify(`Path needs you: ${updateErrorSummary(this.slice.detail ?? "")} It retried ${this.slice.retryDelays?.length ?? 3} times. /path refresh tries again; open /path for the full error.`, "warning");
		}
		// Records it could not read are skipped, not fatal; say so once for each new count.
		const skipped = this.state?.skipped?.length ?? 0;
		if (skipped > this.#notifiedSkipped) {
			this.#notifiedSkipped = skipped;
			this.options.notify(`Path skipped ${skipped} unreadable record${skipped === 1 ? "" : "s"} in its saved notes and carried on from the last good map. open /path to see them.`, "warning");
		}
		// A model whose notes keep being rejected needs the user too (once, until a map is accepted).
		if (!this.rejecting) this.#notifiedRejection = false;
		if (this.rejecting && !this.needsYou && this.state?.enabled !== false && !this.#notifiedRejection) {
			this.#notifiedRejection = true;
			this.options.notify(`Path needs you: ${this.rejectionText()}`, "warning");
		}
		this.publishCorrections();
		this.drain();
	}

	/**
	 * What its slice leaves behind after an operation (a bounded batch's remainder, or skipped ranges) is read by
	 * the next operation, which new activity or a request starts. While this Pi session is open, the client starts it
	 * as soon as it is idle, as long as each round changes something: its coverage, or the ranges awaiting review.
	 */
	#titled?: string;

	private drain(): void {
		// The trail's watcher follows the session itself: the client never starts its runs.
		if (this.trailMode) { this.retitle(); return; }
		if (this.#closed || this.#draining || !this.state || !this.slice || this.busy || this.paused || this.retrying || this.needsYou || this.rejecting || this.problem()) return;
		if (this.slice.state !== "idle" || this.slice.stage !== "idle") return;
		// A round that failed is not repeated at once: new activity, its retries or /path refresh go on from there.
		if (this.status?.lastError) return;
		const more = Boolean(this.status?.more), ranges = this.state.gaps.length > 0;
		if (!more && !ranges) { this.#drained = undefined; return; }
		const progress = `${(this.state.coverageCut ?? this.state.checkpoint?.cut)?.parent}|${this.state.gaps.map(gap => gap.id).join(",")}|${this.status?.more}`;
		if (progress === this.#drained) return;
		this.#drained = progress;
		this.#draining = true;
		setTimeout(() => {
			this.#draining = false;
			if (this.#closed) return;
			this.send({ kind: more ? "update" : "refresh" }).catch(error => { this.error = errorMessage(error); this.options.changed(); });
		}, DRAIN_DELAY_MS).unref();
	}

	/**
	 * Caught up, the trail's entries without a title (recorded before titles existed) get a refresh, which titles the
	 * ones the widget shows first. One that titles nothing leaves the same set, which is never asked for again.
	 */
	private retitle(): void {
		if (!this.#trail || !this.slice || this.busy || this.paused || this.needsYou) return;
		const untitled = untitledEntries(this.#trail).slice(0, UNTITLED_PER_CALL).map(entry => entry.id).join(",");
		if (!untitled || untitled === this.#titled) return;
		this.#titled = untitled;
		this.refreshTrail().catch(error => { this.error = errorMessage(error); this.options.changed(); });
	}

	/** Ask the trail's watcher to revise the trail: one message, the trail as it stands below it. */
	private async refreshTrail(): Promise<void> {
		if (!this.slice) await this.ensure();
		if (!this.slice) throw new Error("Path is off.");
		this.#refreshing = true;
		this.slice = await oven("send", { slice: this.slice.id, text: `${TRAIL_REFRESH_TASK}\n\n${await trailBriefing(this.identity.sessionFile)}`, requestId: randomUUID() });
		this.options.changed();
	}

	/** The last lead entry the trail covers: its old coverage cursor, or the newest entry a trail record points at. */
	private coveredThrough(): string | undefined {
		const order = new Map(this.branch().map((entry, index) => [entry.id, index]));
		const cited = trailEntries(this.#trail ?? emptyTrail()).flatMap(entry => [entry.anchor, ...entry.refs.map(ref => parseRef(ref)?.entryId)]);
		const candidates = [this.state?.coverageCut?.parent, ...cited].filter((id): id is string => typeof id === "string" && order.has(id));
		return candidates.sort((a, b) => order.get(b)! - order.get(a)!)[0];
	}

	/** Its continuity corrections reach the lead once each, as before. */
	private publishCorrections(): void {
		const branch = this.context.sessionManager.getBranch(), ids = branchIds(this.context.sessionManager);
		for (const record of this.#records) {
			const d = record.data;
			if (record.type !== "injection" || d.kind !== "window" || d.action !== "corrected" || (d.parent !== null && !ids.has(d.parent))) continue;
			if (this.#published.has(d.key) || branch.some(entry => entry.type === "custom_message" && entry.customType === WINDOW_CORRECTION && (entry.details as any)?.key === d.key)) continue;
			this.#published.add(d.key);
			this.options.publish({ customType: WINDOW_CORRECTION, content: d.content, details: { key: d.key } });
		}
	}

	private get busy(): boolean { return Boolean(this.slice && this.slice.state === "running" && (this.trailMode || this.status?.op)); }
	/** What it is doing now: its status document's operation, or for the trail's watcher, its turn. */
	private get op(): { startedAt: number; task?: string; activity?: string } | undefined {
		if (!this.busy) return undefined;
		return this.trailMode ? { startedAt: this.#runningSince ?? Date.now(), task: this.#refreshing ? "refreshing" : "reading" } : this.status!.op!;
	}
	private get paused(): boolean { return Boolean(this.slice?.stopped) || this.state?.enabled === false; }
	private get retrying(): boolean { return this.slice?.stage === "retrying" && Boolean(this.slice?.retry); }
	private get needsYou(): boolean { return Boolean(this.#openingError || this.status?.openingError || (this.slice?.stage === "failed" && this.slice?.conversation)); }
	private get rejecting(): boolean { return (this.status?.rejectedStreak ?? 0) >= 3 && !this.busy; }
	private rejectionText() { return `Path's model produced notes it had to reject for ${this.status?.rejectedStreak} history ranges in a row: ${updateErrorSummary(this.status?.lastRejection ?? "")} Check --path-model; open /path for the full error.`; }
	/** How the slice's last run ended: its error, or undefined when it succeeded. Read after `settle`. */
	get runError(): string | undefined { return this.trailMode ? (this.slice?.stage === "failed" ? this.slice.detail : undefined) : this.status?.lastError; }
	private problem(): string | undefined {
		return this.#openingError ?? this.status?.openingError ?? this.status?.blocked ?? (["failed", "retrying"].includes(this.slice?.stage) && this.slice?.conversation ? this.slice.detail : undefined)
			?? this.state?.error ?? this.state?.failure?.error;
	}
	private branch() { return this.context.sessionManager.getBranch(); }
	private coverage() { return coverageProgress(this.branch(), this.state?.coverageCut?.parent ?? this.state?.checkpoint?.cut.parent ?? null); }
	/** Its coverage reaches the last lead entry it reads (its own hints and bookkeeping don't count). */
	private complete(): boolean {
		// The trail's watcher is up to date when it is idle with nothing waiting.
		if (this.trailMode) return Boolean(this.state) && !this.busy && !this.problem() && !this.slice?.followed?.waiting && !this.slice?.followed?.draining;
		if (!this.state || !this.state.checkpoint || this.busy || this.problem() || this.state.gaps.length || this.state.failure || this.status?.more) return false;
		const branch = this.branch(), cut = this.state.coverageCut?.parent ?? this.state.checkpoint?.cut.parent ?? null;
		const at = cut === null ? -1 : branch.findIndex(entry => entry.id === cut);
		if (cut !== null && at < 0) return false;
		return branch.slice(at + 1).every(entry => !extractEvents({ key: this.identity.sessionId, actor: "lead" }, entry).length);
	}
	/** Oven says why new activity is waiting and when it goes at the latest. */
	private waitingText(): string | undefined {
		const waiting = this.slice?.followed?.waiting, due = waiting?.dueAt;
		if (!waiting || this.status?.more) return undefined;
		return waiting.reason === "turn" ? `waiting for the lead's turn to end${due ? ` · by ${clockTime(due)}` : ""}`
			: waiting.reason === "quiet" ? `updating at ${clockTime(due ?? Date.now())} if things stay quiet`
				: `${this.state?.checkpoint || (this.trailMode && this.state?.coverageCut) ? "up to date" : "nothing to map yet"} · will check routine work by ${clockTime(due ?? Date.now())}`;
	}
	private activity(): string {
		if (!this.busy) return "idle";
		if (this.#saving) return "saving";
		return this.op?.activity ?? "thinking";
	}

	view(explicit: boolean, elapsed = true): PanelView {
		if (this.error && !this.state) return { status: "reconnecting", summary: WAITING_FOR_VIEW, error: updateErrorSummary(this.error) };
		if (!this.state) return { status: this.#openingError ? "needs you" : "connecting", summary: WAITING_FOR_VIEW,
			...(this.#openingError ? { error: `Path couldn't open its saved notes: ${updateErrorSummary(this.#openingError)} open /path for the full error.` } : {}) };
		const state = this.state, reason = this.problem(), done = this.complete();
		const progress = done || state.gaps.length ? undefined : this.coverage();
		let status: string;
		if (this.busy && this.trailMode) {
			status = this.op!.task!;
			if (elapsed) status += ` ${formatDuration(Date.now() - this.op!.startedAt)}`;
		} else if (this.busy) {
			const op = this.status!.op!, target = op.target !== undefined ? coverageProgress(this.branch(), op.target ?? null) : undefined;
			const toward = progress && target && target.percent > progress.percent ? ` → ${target.percent}%` : "";
			const reviewing = !explicit ? "" : op.recovering ? " · reviewing earlier activity" : state.gaps.length ? " · earlier activity pending" : "";
			const activity = this.activity(), section = op.section;
			const steps = section && op.mode === "audit" && activity !== "saving" ? ` · section ${section.section} of ${section.of}`
				: activity === "thinking" && this.#steps ? ` · step ${this.#steps + 1}` : "";
			status = `updating ${meter(activity)}${reviewing}${progress ? ` · ${progress.percent}%${toward} read` : ""} · ${activity}${steps}`;
			if (elapsed) status += ` ${formatDuration(Date.now() - op.startedAt)}`;
		} else if (this.needsYou || this.rejecting) status = "needs you";
		else if (this.retrying) status = reason ? `retrying at ${clockTime(this.slice.retry.at)} · attempt ${this.slice.retry.attempt} of ${this.slice.retry.of}`
			: `re-reviewing ${state.gaps.length} skipped range${state.gaps.length === 1 ? "" : "s"} at ${clockTime(this.slice.retry.at)}`;
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
				: this.#openingError || this.status?.openingError ? `Path couldn't open its saved notes: ${updateErrorSummary(reason)} open /path for the full error.`
					: this.needsYou ? `${updateErrorSummary(reason)} Retried ${this.slice?.retryDelays?.length ?? 3} times. /path refresh tries again; open /path for the full error.`
						: `Last attempt: ${updateErrorSummary(reason)}` };
	}

	/** The widget's and panel's trail block: where we are at a glance, and what Path is doing when it is busy. */
	private trailView(): NonNullable<PanelView["trail"]> {
		const trail = this.#trail ?? emptyTrail();
		const op = this.op;
		return { glance: glance(trail), count: trail.waypoints.length, ...(op ? { stage: this.activity(), since: op.startedAt, ...(op.task ? { task: op.task } : {}) } : {}) };
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
		add("Now", this.paused ? "Tracking is paused." : this.needsYou && (this.#openingError || this.status?.openingError) ? "Path could not open its saved notes." : this.busy
			? (this.status?.op?.recovering ? "Reviewing earlier activity." : "Updating notes.") : this.view(true).status);
		if (error || this.error) add("Last problem", updateErrorSummary(error ?? this.error!));
		add("Next", this.paused ? "Updates stay paused until tracking resumes." : this.busy ? "The current update is running in oven. Path saves accepted changes when it finishes."
			: this.needsYou ? "Path needs you: /path refresh tries again." : this.retrying ? `Path retries automatically at ${clockTime(this.slice.retry.at)}.`
				: "Path updates in oven as the conversation continues, also while Pi is closed.");
		add("Saved notes", state?.checkpoint ? `Last saved ${new Date(state.checkpoint.at).toLocaleString()}.` : "No notes have been saved yet.");
		if (state?.skipped?.length) add("Unreadable records", `${state.skipped.length} skipped; it carried on from the last good map.\n${state.skipped.slice(0, 5).join("\n")}${state.skipped.length > 5 ? `\n…and ${state.skipped.length - 5} more` : ""}`);
		add("History", `Ranges awaiting review: ${state?.gaps.length ?? 0} · Unavailable sources: ${this.status?.unavailable?.length ?? 0}`);
		if (this.trailMode || this.#trail?.waypoints.length || this.#trailError) {
			const trail = this.#trail ?? emptyTrail();
			add("Trail", `${trail.waypoints.length} entr${trail.waypoints.length === 1 ? "y" : "ies"} · ${trail.struck.length} struck · ${this.#trailSkipped} unreadable record${this.#trailSkipped === 1 ? "" : "s"} skipped`
				+ (this.#trailError ? `\nThe trail could not be read: ${updateErrorSummary(this.#trailError)}` : ""));
		}
		add("Session", formatUsage(usage));
		const timing = this.status?.operationTiming;
		if (timing) add("Last operation", formatTiming(timing));
		return { sections, raw: JSON.stringify({ error, missingSources: this.status?.unavailable ?? [], slice: this.slice && { id: this.slice.id, key: this.slice.key, stage: this.slice.stage, reason: this.slice.reason, detail: this.slice.detail, retry: this.slice.retry, follow: this.slice.follow, followed: this.slice.followed },
			status: this.status, uncertainEffects: this.status?.uncertainEffects ?? [], failureState: state?.failure, skippedEvidence: state?.gaps, sessionUsage: usage, engagement: state?.engagement }, null, 2) };
	}

	/** What the panel, widget and workspace read. */
	get snapshot(): Snapshot | undefined {
		const state = this.state;
		if (!state) return undefined;
		const controls: Controls = { detached: state.detached === true, enabled: !this.paused, inject: state.inject, hush: this.hush, nudgedClasses: [...state.nudgedClasses], mode: state.mode, model: state.model,
			// Only what the user saved counts as set: a flag default must never look like a configured model.
			// Undefined is "nothing saved yet"; empty is "explicitly no decision model".
			decider: state.decider };
		const anchor = state.reservedAnchor && controls.enabled && state.inject && !this.hush ? { key: state.reservedAnchor.key, content: state.reservedAnchor.content, at: state.reservedAnchor.at } : undefined;
		return { passive: this.view(false), explicit: this.view(true), diagnostics: this.diagnostics(), usage: structuredClone(state.usage ?? emptyUsage()), controls,
			...(this.#work ? { work: structuredClone(this.#work) } : {}),
			...(this.op ? { startedAt: this.op.startedAt } : {}), ...(anchor ? { preparedAnchor: anchor } : {}),
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

	/** Send it a request; it waits behind work it is doing. */
	async send(request: MomRequest): Promise<string> {
		if (!this.slice) await this.ensure();
		if (!this.slice) throw new Error("Path is paused.");
		const id = randomUUID();
		this.slice = await oven("send", { slice: this.slice.id, text: encodeRequest(this.identity.sessionFile, request), requestId: id });
		this.options.changed();
		return id;
	}

	/** Wait for it to finish what it has (including a request just sent), then read its notes again. */
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
			case "refresh": {
				if (this.paused) throw new Error("Path is paused.");
				// A refresh is explicit: it ends a wait it is in the middle of (for a running worker or a screen).
				if (this.slice && (this.status?.waitingForWorkers || this.status?.deferredUntil)) await oven("halt", { slice: this.slice.id });
				if (this.trailMode) await this.refreshTrail(); else await this.send({ kind: "refresh" });
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
			case "controls": return this.controls(command.change);
			case "finding": {
				const note = this.state?.checkpoint?.note;
				if (!note || note.text !== command.finding) throw new Error("This finding has changed; reopen Path.");
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
		}
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
			if (!this.#closed) this.options.notify(`Setting saved globally, but Path could not apply it: ${updateErrorSummary(errorMessage(error))}`, "warning");
		});
	}

	private async applyControl(change: Exclude<ControlChange, { hush: boolean }>): Promise<void> {
		if (this.#closed) return;
		const pausing = "enabled" in change && !change.enabled;
		const resuming = "enabled" in change && change.enabled;
		const reconfiguring = "mode" in change || "model" in change || "decider" in change;
		if (pausing) { await this.#ensuring; await this.release(); this.options.changed(); return; }
		if ("detached" in change) {
			await this.#ensuring;
			if (this.slice) {
				const expires = change.detached ? "never" : OVEN_EXPIRES;
				await requireExpiry(await oven("expires", { slice: this.slice.id, expires }), oven, expires);
			}
			return;
		}
		if (resuming) { this.#resume?.(); this.#resume = undefined; }
		const woke = (reconfiguring || resuming) && await this.ensure(reconfiguring);
		if (resuming && !woke && !this.trailMode) await this.send({ kind: "refresh" });
		// Suggestions and continuity are read from globals on the next operation; they need no slice round trip.
	}

	/** Its slice in oven, read when Status is refreshed. */
	private async sliceHost(): Promise<SliceHost | undefined> {
		const [health, slices] = await Promise.all([ovenHealth(), oven<any[]>("list", {})]);
		const slice = slices.find(s => s.key === this.sliceKey(this.trailMode));
		return slice ? { pid: health.pid, slice: slice.id, state: slice.stage ?? slice.state, startedAt: slice.createdAt, sampledAt: Date.now() } : undefined;
	}

	/** The hint the lead adds after a compaction, when it prepared one and it is not in the lead's context yet. */
	pendingAnchor(): PreparedAnchor | undefined {
		const anchor = this.snapshot?.preparedAnchor;
		if (!anchor) return undefined;
		const delivered = this.branch().some(entry => entry.type === "custom_message" && entry.customType === ANCHOR && (entry.details as any)?.key === anchor.key);
		return delivered ? undefined : anchor;
	}

	/** The lead moved to another branch: what its slice is working on belongs to the old one. */
	async halt(): Promise<void> {
		if (this.slice) await oven("halt", { slice: this.slice.id }).catch(() => {});
	}

	/** Stop following it. Its slice keeps following the session in oven. */
	close(): void { this.#closed = true; clearInterval(this.#beat); this.#beat = undefined; this.#watch.abort(); this.#resume?.(); }

	/** Explicit parent end releases owned execution, unless the user opted into detached background work. */
	async end(): Promise<void> {
		this.close();
		await this.#ensuring;
		await this.#controlTail;
		if (!this.slice) return;
		if (!this.state?.detached || this.paused) await this.release();
		else await requireExpiry(await oven("expires", { slice: this.slice.id, expires: "never" }), oven, "never");
	}

	/** Pause archives even detached work. Abort the open watch so it cannot keep an execution lease alive. */
	private async release(): Promise<void> {
		this.#watch.abort();
		this.#watch = new AbortController();
		await this.stopSlice(this.sliceKey(this.trailMode), this.slice?.id);
		this.slice = undefined;
	}

	/** Its slice's key: the trail's watcher and a map mode's operations are different slices of this session. */
	private sliceKey(trail: boolean): string { return trail ? `${this.key}-trail` : this.key; }

	/** Archive only this client's exact slice, or a matching attributed key. Never touch unknown/foreign ownership. */
	private async stopSlice(key: string, id?: string): Promise<void> {
		id ??= (await oven<any[]>("list", {})).find(slice => slice.key === key && slice.owner?.client === "pi-delegate" && slice.owner?.session === this.identity.sessionId)?.id;
		if (!id) return;
		const view = await oven("archive", { slice: id });
		if (view?.archived !== true || view.state === "running") throw new Error(`Path execution release unconfirmed for ${id}`);
	}
}
