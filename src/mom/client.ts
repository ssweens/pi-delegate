/**
 * Mom's client in the lead's Pi session. Mom runs in oven: her slice follows this session's file, reviews
 * new activity, retries failed turns, and writes her `.mom` file. This client only ensures her slice (by
 * key, with her configuration), follows it with `oven_watch`, reads her `.mom` file read-only, renders her
 * state, and sends the user's requests. It never writes the `.mom` file.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { branchCheckpoints, emptyUsage, loadState, noticeKey, type MomState, type Usage } from "./checkpoint.ts";
import { STATUS_DOC, type MomStatus } from "./engine.ts";
import { extractEvents, LiveFeed } from "./feed.ts";
import { readGraph } from "./mother.ts";
import { encodeRequest, type FindingRequest, type MomRequest } from "./operation.ts";
import { oven, ovenUrl, OvenUnreachable } from "./oven.ts";
import type { PanelDiagnostics, PanelView } from "../ui/panel.ts";
import { feedbackApplies, type FindingAction, type ProcessRiskClass } from "./process-health.ts";
import { coverageProgress, presentGraph, summaryText, type WorkView } from "../ui/presentation.ts";
import { SidecarStore } from "./sidecar.ts";
import { deciderFor, identityOf, momConfiguration, ownerKey, type SessionIdentity } from "./slice.ts";
import { readMomGlobals, writeMomGlobals, type MomGlobals } from "./globals.ts";
import { formatElapsed, updateErrorSummary } from "./status.ts";
import { ANCHOR } from "./anchor.ts";
import { WINDOW_CORRECTION } from "./window.ts";
import { projectWork, type WorkProjection } from "../work/projection.ts";

/** Mom's slice in oven, as the Status tab shows it. */
export interface SliceHost { pid: number; slice: string; state: string; startedAt: number; sampledAt: number }
export interface SourcePage { ref: string; text: string; offset: number; totalChars: number; nextOffset: number | null; pairedRef?: string }
export interface PreparedAnchor { key: string; content: string; at: number }
export interface Controls { enabled: boolean; inject: boolean; hush: boolean; nudgedClasses: ProcessRiskClass[]; mode: string; model: string; decider: string }
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
	| { kind: "status" };
export interface Publication { customType: string; content: string; details: { key: string } }

/** How long a settings change waits for her answer before it is shown as made. */
const CONTROLS_WAIT_MS = 3000;
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
	#steps = 0;
	#saving = false;
	#seenNotices = Date.now();
	#notifiedFailure?: string;
	#notifiedRejection = false;
	#published = new Set<string>();
	#reloading?: Promise<void>;
	#work?: WorkProjection;
	#draining = false;
	#drained?: string;
	#warnedDecider?: string;

	constructor(private context: ExtensionContext, private readonly options: {
		flags: Record<string, string | boolean | undefined>; changed(): void; publish(message: Publication): void;
		notify(text: string, level: "info" | "warning" | "error"): void;
	}) {
		this.identity = identityOf(context.sessionManager, context.cwd);
		this.key = ownerKey(this.identity);
	}

	updateContext(context: ExtensionContext) { this.context = context; }

	/** Ensure her slice (create-or-get by key with her configuration), read her notes, and follow her. */
	async connect(): Promise<void> {
		await this.reload();
		await this.ensure();
		void this.follow();
	}

	async ensure(): Promise<void> {
		// Saved settings override startup flags. Each operation pins its configured mode at begin.
		// `create` is create-or-get: an idle slice takes this configuration, a busy one keeps it for next time.
		const flags = { ...this.options.flags, ...(this.state?.mode ? { "mom-mode": this.state.mode } : {}), ...(this.state?.model ? { "mom-model": this.state.model } : {}),
			...(this.state?.decider !== undefined ? { "mom-decider": this.state.decider } : {}) };
		// An unreachable decision model never stops Mom: she runs without it, and the user is told once.
		const decider = deciderFor(flags, this.context.modelRegistry);
		if (decider.ref && !decider.classifier && this.#warnedDecider !== decider.ref) {
			this.#warnedDecider = decider.ref;
			this.options.notify(`Mom's decision model ${decider.ref} is not available: Pi has no local System One classifier by that name. Mom runs without it: v2 sends every update to her model. Choose another in /mom settings.`, "warning");
		}
		const slice = await oven("create", { key: this.key, cwd: this.identity.cwd, copy: "none", config: momConfiguration(this.identity, flags, this.context.modelRegistry) });
		if (slice.state === "failed" && !slice.conversation) throw new Error(`Mom's slice in oven failed (${slice.reason}): ${slice.detail}`);
		this.slice = slice;
		// Notes paused before her slice followed this session stay paused.
		if (this.state && !this.state.enabled && !slice.stopped) this.slice = await oven("stop", { slice: slice.id });
		this.error = undefined;
		this.options.changed();
	}

	/** Follow her slice: its state, her status document, and her `.mom` file after each change. */
	private async follow(): Promise<void> {
		while (!this.#closed) {
			try {
				if (!this.slice) await this.ensure();
				await oven("watch", { slice: this.slice.id, untilSettled: false }, { signal: this.#watch.signal, onEvent: event => this.event(event) });
			} catch (error) {
				if (this.#closed) return;
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
				this.#records = await store.load() as any;
				this.#checkpoints = branchCheckpoints(this.#records as any, new Set(manager.getBranch().map(entry => entry.id)));
				this.#openingError = undefined;
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
		const progress = `${this.state.checkpoint?.cut.parent}|${this.state.gaps.map(gap => gap.id).join(",")}|${this.status?.more}`;
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
		return this.#openingError ?? this.status?.openingError ?? (["failed", "retrying"].includes(this.slice?.stage) && this.slice?.conversation ? this.slice.detail : undefined)
			?? this.state?.error ?? this.state?.failure?.error;
	}
	private branch() { return this.context.sessionManager.getBranch(); }
	private coverage() { return coverageProgress(this.branch(), this.state?.coverageCut?.parent ?? this.state?.checkpoint?.cut.parent ?? null); }
	/** Her coverage reaches the last lead entry she reads (her own hints and bookkeeping don't count). */
	private complete(): boolean {
		if (!this.state?.checkpoint || this.busy || this.problem() || this.state.gaps.length || this.state.failure || this.status?.more) return false;
		const branch = this.branch(), cut = this.state.coverageCut?.parent ?? this.state.checkpoint.cut.parent;
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
				: `${this.state?.checkpoint ? "up to date" : "nothing to map yet"} · will check routine work by ${clock(due ?? Date.now())}`;
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
		const finding = state.checkpoint?.note;
		const feedback = finding ? state.feedback[noticeKey(finding)] : undefined;
		const muted = finding && feedbackApplies(feedback, finding) && !(explicit && ["ignored", "backoff"].includes(feedback!.action));
		const showFinding = done && finding && !muted && (explicit || (!this.hush && state.nudgedClasses.includes(finding.riskClass) && !state.engagement.remaining));
		return { status, complete: done, compact: false, work, summary: summaryText(work), coverage: progress,
			note: showFinding ? finding.text : undefined, noteTag: finding?.riskClass === "worth_considering" ? "Worth considering" : "Heads up",
			error: this.busy ? undefined : this.error ? updateErrorSummary(this.error) : this.rejecting && !this.needsYou ? this.rejectionText() : !reason ? undefined
				: this.#openingError || this.status?.openingError ? `Mom couldn't open her saved notes: ${updateErrorSummary(reason)} /mom detail has the full error.`
					: this.needsYou ? `${updateErrorSummary(reason)} Retried ${this.slice?.retryDelays?.length ?? 3} times. /mom refresh tries again; /mom detail has the full error.`
						: `Last attempt: ${updateErrorSummary(reason)}` };
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
		add("History", `Ranges awaiting review: ${state?.gaps.length ?? 0} · Unavailable sources: ${this.status?.unavailable?.length ?? 0}`);
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
			decider: state.decider ?? String(this.options.flags["mom-decider"] ?? "") };
		const anchor = state.reservedAnchor && controls.enabled && state.inject && !this.hush ? { key: state.reservedAnchor.key, content: state.reservedAnchor.content, at: state.reservedAnchor.at } : undefined;
		return { passive: this.view(false), explicit: this.view(true), diagnostics: this.diagnostics(), usage: structuredClone(state.usage ?? emptyUsage()), controls,
			...(this.#work ? { work: structuredClone(this.#work) } : {}),
			...(this.busy ? { startedAt: this.status!.op!.startedAt } : {}), ...(anchor ? { preparedAnchor: anchor } : {}),
			telemetry: { model: this.slice?.model ?? String(this.options.flags["mom-model"] ?? ""), activity: this.activity(),
				...(state.checkpoint ? { lastSavedAt: state.checkpoint.at } : {}), pendingRanges: state.gaps.length, unavailableSources: this.status?.unavailable?.length ?? 0,
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
				if (this.status?.waitingForWorkers || this.status?.deferredUntil) await oven("halt", { slice: this.slice.id });
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
		}
	}

	/** Her reply to a control request she was sent (by its ID), polled from her status document; undefined when she has not answered in time. */
	private async answerTo(id: string, ms: number): Promise<{ answer?: string; error?: string } | undefined> {
		for (const end = Date.now() + ms; !this.#closed;) {
			const doc = (await oven("state", { slice: this.slice.id, names: [STATUS_DOC] })).docs[STATUS_DOC] as MomStatus | undefined;
			if (doc) this.status = doc;
			if (doc?.answers[id]) { await this.reload(); return doc.answers[id]; }
			if (Date.now() >= end) return undefined;
			await new Promise(resolve => setTimeout(resolve, 100));
		}
		return undefined;
	}

	/**
	 * Controls are her records: a request to her, answered once saved. The settings wait for that answer for a
	 * moment. When she is busy the request queues behind her work: the change is shown as made, and a failure to
	 * save it is notified when it comes. Pause halts her turn first and stops her slice once the change is saved
	 * (no deliveries, no retries); resume saves it and has her catch up.
	 */
	async controls(change: ControlChange): Promise<void> {
		if ("hush" in change) { this.hush = change.hush; this.options.changed(); return; }
		// Save globally first. New and reconfigured slices read this value, and it survives an
		// unreachable slice. Other running clients do not reconfigure their slices automatically.
		await writeMomGlobals(change as MomGlobals);
		// A mode change is refused before it is saved, and once saved it reconfigures her slice: the
		// standing instructions are the mode, so an idle slice takes the new prompt on the next ensure.
		const reconfiguring = "mode" in change || "model" in change || "decider" in change;
		if (!this.slice) await this.ensure();
		const pausing = "enabled" in change && !change.enabled, resuming = "enabled" in change && change.enabled;
		if (pausing) await oven("halt", { slice: this.slice.id });
		const id = randomUUID();
		await this.send({ kind: "controls", id, change });
		const saved = this.answerTo(id, 600_000).then(async reply => {
			if (reply && !reply.error && !this.#closed) {
				if (pausing) this.slice = await oven("stop", { slice: this.slice.id });
				if (reconfiguring) await this.ensure();
			}
			return reply;
		});
		const quick = await Promise.race([saved, new Promise<undefined>(resolve => setTimeout(resolve, CONTROLS_WAIT_MS))]);
		if (quick?.error) throw new Error(quick.error);
		if (!quick) saved.then(late => { if (late?.error) this.options.notify(`Mom's slice did not take that setting: ${late.error} It is saved, and applies the next time she reconfigures.`, "warning"); }, () => {});
		// The catch-up waits for her to finish the request: one queued behind work that then fails is not started again by oven.
		if (resuming) { await this.settle().catch(() => {}); await this.send({ kind: "refresh" }); }
		this.options.changed();
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
	close(): void { this.#closed = true; this.#watch.abort(); }
}
