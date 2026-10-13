/**
 * Path's operations in oven. Every message its slice gets (a delivery of new lead entries from oven's
 * follow, or a request from the lead's client) is one operation: its turn calls `mom_begin`, which settles
 * the previous operation, applies requests, prepares the evidence, and hands it the review; its finalizers
 * accept the map. Only this code writes its `.mom` file. Its status for clients lives in Durable documents
 * of its slice, which oven serves through `oven_state` and `oven_watch`.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, statSync } from "node:fs";
import type * as Durable from "@earendil-works/pi-durable";
import { ANCHOR, collectSideEffects, renderAnchor } from "./anchor.ts";
import { SystemOneAdvisor } from "./advisor.ts";
import { Decider, type DeciderQuestion } from "./decider.ts";
import { DEFAULT_BOOTSTRAP_POLICY, type BootstrapPolicy } from "./bootstrap.ts";
import { emptyUsage, graphChange, isCheckpoint, loadState, noticeKey, sumUsage, type Checkpoint, type Usage, type WindowLive } from "./checkpoint.ts";
import { reviewFromSession, type CompactionReview } from "./compaction.ts";
import { branchIds, extractEvents, isUserDirection, renderEvents, type FeedEvent, type SessionReader } from "./feed.ts";
import { Mom, readStep, type StepRequest, type StepRunner } from "./mother.ts";
import { isEndeavor } from "./graph.ts";
import { Beverly } from "./classify.ts";
import { COMMIT_GRAPH_MODE, V2_MODE, modeFor } from "./modes.ts";
import { fromWorkGraph, v2Body, V2_AUDIT_TASK, V2_DIGEST_TASK, V2_UPDATE_TASK, type V2BodyParts } from "./v2.ts";
import { readSpec, SpecError } from "./spec.ts";
import { writeMomGlobals } from "./globals.ts";
import type { SpecOp } from "./v2.ts";
import { decodeStart, encodeOperation, OPERATION_FAILED, type MomRequest, type OperationHeader, type OperationStart } from "./operation.ts";
import { feedbackApplies, recordEngagement } from "./process-health.ts";
import { currentSession, leadRunning } from "./session-file.ts";
import { SidecarStore } from "./sidecar.ts";
import { formatDuration } from "../util/format.ts";
import { entryIdOf, makeRef } from "../util/ref.ts";
import { clipText, textOf } from "../util/text.ts";
import { NO_ACCEPTED_TRANSACTION } from "./status.ts";
import { collectTurnSignals, lastDirectionOf, MAX_WINDOW_CHECKS, MAX_WINDOW_TURNS, offeredRefs, parseWindowVerdict, renderCorrection, stageOne, windowMessages, windowPurpose } from "./window.ts";
import { TRAIL_BACKFILL_TASK, TRAIL_DIGEST_TASK, TRAIL_REPAIR_TASK, TRAIL_TITLE_TASK, TRAIL_UPDATE_TASK, trailBody } from "../trail/prompt.ts";
import { TrailStore, trailFor } from "../trail/store.ts";

/** The operation in its slice's current context. */
export interface OperationState {
	/** The entry that started it (a delivery or a request). */
	startEntry?: number;
	job?: string;
	header?: OperationHeader;
	start?: OperationStart;
	status: "none" | "open" | "accepted" | "rejected" | "done";
	rejection?: string;
	/** Set when the operation failed in a way oven should retry: its turn ends as a failed turn. */
	fault?: string;
	/** Usage of the operation's child steps (audit sections, continuity checks). */
	childUsage?: Usage;
	/** Its usage before the operation, from its `.mom` file. */
	baseUsage?: Usage;
	/** Shadow: the decider's guess per open item, made before its model saw the batch; compared once it saves. */
	shadow?: { guesses: { id: string; label: string; state: string; guess: string; p: number }[]; latencyMs: number };
	/** v2: the ops the decision model decided for this batch, and the names it chose; logged once it saves. */
	read?: { ops: SpecOp[]; chosen: Record<string, string> };
}

/** What clients show of it: what it is doing, and what the `.mom` file cannot say. */
export interface MomStatus {
	op?: { job: string; mode: string; startedAt: number; thinkingAt?: number; activity: string; target?: string | null; recovering?: boolean; section?: { section: number; of: number };
		/** What this run is, in the widget's word: reading (new activity), titling, repairing or backfilling. Trail only. */
		task?: string };
	waitingForWorkers?: boolean;
	deferredUntil?: number;
	more?: boolean;
	rejectedStreak: number;
	lastRejection?: string;
	/** Its saved notes could not be opened: it needs the user. */
	openingError?: string;
	lastError?: string;
	operationTiming?: { startupMs: number; requestMs: number; totalMs: number; oldestEvidenceAgeMs: number };
	/** Evidence it could not read (a missing worker transcript), and tool calls whose outcome is unknown: for the workspace's Status tab. */
	unavailable?: string[];
	/** Why the lead's own transcript cannot be read past some entry: its coverage cannot advance until it is fixed. */
	blocked?: string;
	uncertainEffects?: { ref: string; name?: string }[];
	/** Messages for the user, newest last. */
	notices: { at: number; text: string; level: "info" | "warning" | "error" }[];
	/** Replies to control requests, by request ID: the client waits for its own. */
	answers: Record<string, { answer?: string; error?: string; at: number }>;
	/** Failed compaction audits, by trigger; two retire the audit. */
	auditAttempts: Record<string, number>;
	model?: string;
}
export const STATUS_DOC = "pi-tether.mom-status";
export const OPERATION_DOC = "pi-tether.mom-operation";
/** More unreviewed compactions than this are a backlog, not live activity. */
const MAX_QUEUED_REVIEWS = 3;
/** The prompt that sends it back to mom_begin when it ended again without a finalizer: that call fails the operation. */
export const GIVE_UP = "You ended without finishing, twice. Call mom_begin.";
const emptyStatus = (): MomStatus => ({ rejectedStreak: 0, notices: [], answers: {}, auditAttempts: {} });

/** Settings the lead passes in its instructions (the `--path-*` flags). */
export interface MomSettings { mapMode?: string; bootstrap?: false | BootstrapPolicy; advisor?: { url: string; model: string; threshold: number; timeoutMs: number }; decider?: { url: string; clear: number };
	/** The decision model every semantic gate asks (classify.ts), resolved from the chosen decider. */
	classifier?: { url: string; model: string; timeoutMs?: number } }
const SETTINGS = /<!-- mom-settings (\{.*\}) -->/;
export const settingsLine = (settings: MomSettings) => `<!-- mom-settings ${JSON.stringify(settings)} -->`;
export function readInstructionSettings(instructions: string | undefined): MomSettings {
	try { return JSON.parse(SETTINGS.exec(instructions ?? "")?.[1] ?? "{}"); } catch { return {}; }
}

interface Docs { operation: Durable.ConversationDocToken<OperationState & Durable.JsonObject>; status: Durable.ConversationDocToken<MomStatus & Durable.JsonObject> }
const cache = new WeakMap<object, Docs>();
/** Its documents, defined once per Durable instance. */
export function docsFor(durable: typeof Durable): Docs {
	let docs = cache.get(durable);
	if (!docs) {
		docs = {
			operation: durable.defineDoc<OperationState & Durable.JsonObject>({ kind: OPERATION_DOC, version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ status: "none" }) as any }),
			status: durable.defineDoc<MomStatus & Durable.JsonObject>({ kind: STATUS_DOC, version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => emptyStatus() as any }),
		};
		cache.set(durable, docs);
	}
	return docs;
}

/** Entries of a conversation from `min` on (oldest first), with their model messages. */
async function entriesFrom(api: Durable.ToolExecutionApi, ctx: any, conversationId: number, min?: number, max?: number) {
	return api.commit(async tx => {
		const out: { id: number; model: any[] }[] = [];
		let cursor: any;
		do {
			const page = await tx.scanEntries({ conversationId: conversationId as any, ...(min !== undefined ? { minEntryId: min as any } : {}), ...(max !== undefined ? { maxEntryId: max as any } : {}) }, 200, cursor);
			for (const entry of page.items) out.push({ id: Number(entry.id), model: [...(entry.model ?? [])] as any[] });
			cursor = page.next;
		} while (cursor);
		return out.reverse();
	}, ctx);
}

/** The newest entry of its slice that started an operation, and how. */
export async function latestStart(api: Durable.ToolExecutionApi, ctx: any): Promise<{ entry: number; start: OperationStart } | undefined> {
	return api.commit(async tx => {
		let cursor: any;
		do {
			const page = await tx.scanEntries({ conversationId: api.conversationId }, 50, cursor);
			for (const entry of page.items) for (const message of entry.model ?? []) {
				if (message.role !== "user") continue;
				const start = decodeStart(textOf(message?.content, ""));
				if (start) return { entry: Number(entry.id), start };
			}
			cursor = page.next;
		} while (cursor);
		return undefined;
	}, ctx);
}

export interface Engine {
	durable: typeof Durable;
	docs: Docs;
}

export const readOperation = async (engine: Engine, api: Pick<Durable.ToolExecutionApi, "snapshot" | "conversationId">, ctx: any): Promise<OperationState> =>
	(await api.snapshot(engine.docs.operation, api.conversationId, ctx) as OperationState | undefined) ?? { status: "none" };
export const readStatus = async (engine: Engine, api: Pick<Durable.ToolExecutionApi, "snapshot" | "conversationId">, ctx: any): Promise<MomStatus> =>
	({ ...emptyStatus(), ...(await api.snapshot(engine.docs.status, api.conversationId, ctx) as MomStatus | undefined) });
export const writeOperation = (engine: Engine, api: Durable.ToolExecutionApi, ctx: any, change: (op: OperationState) => void) =>
	api.commit(async tx => { change(await tx.doc(engine.docs.operation, api.conversationId) as any); }, ctx);
export const writeStatus = (engine: Engine, api: Durable.ToolExecutionApi, ctx: any, change: (status: MomStatus) => void) =>
	api.commit(async tx => {
		const status = await tx.doc(engine.docs.status, api.conversationId) as any as MomStatus;
		status.notices ??= []; status.answers ??= {}; status.auditAttempts ??= {}; status.rejectedStreak ??= 0;
		change(status);
		if (status.notices.length > 10) status.notices.splice(0, status.notices.length - 10);
		const answers = Object.entries(status.answers).sort(([, a], [, b]) => a.at - b.at);
		for (const [id] of answers.slice(0, Math.max(0, answers.length - 8))) delete status.answers[id];
	}, ctx);

/** A step in a child conversation of its slice: its own fresh context, instructions and tools. */
function stepRunner(engine: Engine, api: Durable.ToolExecutionApi, ctx: any, usage: { total: Usage }): StepRunner {
	return async (request: StepRequest) => {
		const key = `${request.header.job}:${request.header.step}`;
		let id = await api.memo<number>(`step:${key}`, ctx);
		if (id === undefined) {
			const agent = await api.agent(ctx);
			const created = await api.commit(async tx => {
				const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
				await engine.durable.configure(tx, child.id, { instructions: request.instructions, thinkingLevel: request.thinking as any,
					tools: agent.tools.filter(tool => request.tools.includes(tool.name)) });
				return Number(child.id);
			}, ctx);
			id = await api.memo<number>(`step:${key}`, created, ctx);
		}
		const child = await api.conversation(id as any, ctx);
		if (!child) throw new Error(`Path's step ${key} lost its context.`);
		const texts = [encodeOperation(request.header, request.body), ...(request.more ?? [])];
		for (const [index, text] of texts.entries()) {
			const submission = await child.submit({ type: "input", content: text, requestId: index ? `${key}:${index}` : key }, ctx);
			await submission.wait(ctx);
		}
		const messages = (await entriesFrom(api, ctx, id)).flatMap(entry => entry.model);
		usage.total = sumUsage(usage.total, readStep(messages).usage);
		return { messages };
	};
}

/** The lead's session as Path reads it in oven, with its notices collected for clients. */
function leadContext(file: string, notices: MomStatus["notices"]) {
	let reader = currentSession(file);
	const modifiedAt = () => { try { return statSync(file).mtimeMs; } catch { return 0; } };
	let modified = modifiedAt();
	// The session file keeps growing while it waits: `refresh` reads it again.
	const sessionManager: SessionReader = { getSessionId: () => reader.getSessionId(), getSessionFile: () => reader.getSessionFile(), getCwd: () => reader.getCwd(),
		getLeafId: () => reader.getLeafId(), getEntry: id => reader.getEntry(id), getBranch: () => reader.getBranch() };
	return { cwd: reader.getCwd(), isIdle: () => !leadRunning(reader, modified), sessionManager,
		refresh() { reader = currentSession(file); modified = modifiedAt(); },
		ui: { notify: (text: string, level?: "info" | "warning" | "error") => { notices.push({ at: Date.now(), text, level: level ?? "info" }); } } };
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
	const timer = setTimeout(resolve, ms);
	signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); }, { once: true });
});

/** The messages of an earlier operation of its slice: its entries from its start to just before `before`. */
async function operationMessages(api: Durable.ToolExecutionApi, ctx: any, start: number, before: number) {
	return (await entriesFrom(api, ctx, api.conversationId as any, start, before === Number.MAX_SAFE_INTEGER ? undefined : before - 1)).flatMap(entry => entry.model);
}

/**
 * Record what the previous operation left, unless its finalizer already did: usage, and for a rejected or
 * unfinished update a retry record or a skipped range.
 */
async function settlePrevious(engine: Engine, api: Durable.ToolExecutionApi, ctx: any, previous: OperationState, before: number, mom: Mom, status: MomStatus) {
	if (!previous.header || !previous.startEntry || !["open", "rejected"].includes(previous.status)) return false;
	const messages = await operationMessages(api, ctx, previous.startEntry, before);
	const outcome = readStep(messages);
	if (previous.rejection && !outcome.rejection) outcome.rejection = previous.rejection;
	const usage = sumUsage(sumUsage(previous.baseUsage ?? mom.usage, previous.childUsage ?? emptyUsage()), outcome.usage);
	const settled = await mom.settle(previous.header, outcome, usage);
	if (settled.retiredRejection) { status.rejectedStreak++; status.lastRejection = settled.retiredRejection; }
	if (settled.error) status.lastError = settled.error;
	return true;
}

/** `mom_begin`: start the operation its context holds. Returns its tool result. */
export async function begin(engine: Engine, api: Durable.ToolExecutionApi, ctx: any): Promise<Durable.ToolExecutionResult> {
	const text = (value: string) => [{ type: "text" as const, text: value }];
	const done = (value: string): Durable.ToolExecutionResult => ({ content: text(value), control: { terminate: true } });
	const latest = await latestStart(api, ctx);
	if (!latest || latest.start.kind === "step") return done("There is no delivery or request to work on.");
	const previous = await readOperation(engine, api, ctx);
	if (previous.startEntry === latest.entry && previous.status !== "none") {
		// It was told to finish and called mom_begin again instead: the operation gave no finalizer. It fails as a rejected one does.
		if (previous.status === "open" && previous.header && previous.startEntry !== undefined) {
			const messages = (await entriesFrom(api, ctx, api.conversationId as any, previous.startEntry)).flatMap(entry => entry.model);
			if (messages.some((message: any) => message.role === "user" && textOf(message.content, "").startsWith(GIVE_UP))) {
				const message = NO_ACCEPTED_TRANSACTION;
				await rejected(engine, api, ctx, previous.header, message);
				const failedOp = await readOperation(engine, api, ctx);
				return failedOp.fault ? { content: text(`${OPERATION_FAILED}${message}`), isError: true, control: { terminate: true } } : { content: text(`${OPERATION_FAILED}${message}`), control: { terminate: true } };
			}
		}
		return { content: text("This operation has already begun: continue it from the evidence above, and finish with one finalizer."), isError: true };
	}
	const start = latest.start;
	const agent = await api.agent(ctx);
	const model = agent.model ? `${agent.model.provider}/${agent.model.modelId}` : "";
	const settings = readInstructionSettings(agent.instructions);
	const status = await readStatus(engine, api, ctx);
	const notices: MomStatus["notices"] = [];
	const job = randomUUID();
	const usage = { total: emptyUsage() };
	let lead: ReturnType<typeof leadContext> | undefined;
	let current: Mom | undefined;
	const progress = () => { const section = current?.auditProgress; if (section) void writeStatus(engine, api, ctx, status => { if (status.op) status.op.section = section; }).catch(() => {}); };
	const host = (file: string) => ({ ctx: leadContext(file, notices), model, mapMode: settings.mapMode, store: new SidecarStore(() => file, currentSession(file).getSessionId()), steps: stepRunner(engine, api, ctx, usage),
		bootstrapPolicy: settings.bootstrap === false ? undefined : settings.bootstrap ?? DEFAULT_BOOTSTRAP_POLICY,
		advisor: settings.advisor?.url ? new SystemOneAdvisor(settings.advisor) : undefined,
		changed: progress });
	const relabel = start.kind === "request" && start.request.kind === "relabel";
	// The decider every semantic gate asks. A configured-but-bad endpoint throws here: begin fails
	// loudly rather than deriving from word lists.
	const beverly = settings.classifier ? new Beverly(settings.classifier) : undefined;
	// The spec's questions are answered by name (choices), so the batch spec reads the endpoint directly.
	const classifier: Decider | undefined = settings.classifier
		? new Decider(settings.classifier.url, settings.classifier.timeoutMs ?? 15000, settings.classifier.model) : undefined;
	let decider: { client: Decider; clear: number } | undefined;
	try { if (settings.decider?.url) decider = { client: new Decider(settings.decider.url), clear: settings.decider.clear }; } catch { /* a bad URL disables it */ }
	// A slice configured by an older package may still select the retired `mom-ask` extension: Path has only `mom`.
	if (agent.extensions.some(extension => extension.name !== "mom")) {
		const wanted = [api.registry.extension("mom")].filter((e): e is Durable.Extension => Boolean(e));
		await api.commit(tx => engine.durable.configure(tx, api.conversationId, { extensions: wanted }), ctx);
	}
	const save = async (op: Partial<OperationState>, change?: (status: MomStatus) => void) => {
		await writeOperation(engine, api, ctx, current => { for (const key of Object.keys(current)) delete (current as any)[key]; Object.assign(current, { status: "none", startEntry: latest.entry, start, ...op }); });
		await writeStatus(engine, api, ctx, current => {
			Object.assign(current, { ...status, notices: [...current.notices, ...notices], answers: { ...current.answers, ...status.answers }, model });
			delete current.op;
			change?.(current);
		});
	};
	// A settings change: saved, and answered to the client waiting for it (also when its notes cannot be opened).
	const controls = async () => {
		const request = start.kind === "request" && start.request.kind === "controls" ? start.request : undefined;
		if (!request) return undefined;
		// Its controls are saved globally by the client (globals.ts) before this request arrives; its
		// slice only acknowledges it and re-reads the file on its next operation.
		await save({ status: "done" }, current => { current.answers[request.id] = { answer: "Saved.", at: Date.now() }; });
		return done("Saved.");
	};
	let mom: Mom;
	const open = async () => { const opened = host(start.session); lead = opened.ctx; const made = new Mom(opened); await made.open(); current = made; return made; };
	try { mom = await open(); }
	catch (error) {
		const saved = await controls();
		if (saved) return saved;
		status.openingError = String(error);
		notices.push({ at: Date.now(), text: `Path needs you: it couldn't open its saved notes. ${String(error)}`, level: "warning" });
		await save({ status: "done" });
		return done(`Path couldn't open its saved notes: ${String(error)}`);
	}
	status.openingError = undefined;
	try {
		if (await settlePrevious(engine, api, ctx, previous, latest.entry, mom, status)) mom = await open();
	} catch (error) { status.lastError = `Path could not record its last operation: ${String(error)}`; }
	const reader = currentSession(start.session);
	const store = new SidecarStore(() => start.session, reader.getSessionId());
	const leaf = reader.getLeafId();
	// Requests that change settings or record feedback take no review.
	if (start.kind === "request") {
		const request: MomRequest = start.request;
		if (request.kind === "controls") return (await controls())!;
		if (request.kind === "finding") {
			const note = mom.checkpoint?.note;
			if (!note || note.text !== request.finding) { notices.push({ at: Date.now(), text: "This finding has changed; reopen Path.", level: "info" }); await save({ status: "done" }); return done("That finding has changed."); }
			await store.append("notice", { key: noticeKey(note), action: request.action, note, parent: leaf });
			await save({ status: "done" });
			return done("Recorded.");
		}
		if (request.kind === "resume" && !mom.enabled) { await writeMomGlobals({ enabled: true }); mom = await open(); }
	}
	if (!mom.enabled && !(start.kind === "request" && start.request.kind === "rebuild")) {
		await save({ status: "done" });
		return done("Path is paused; nothing to do.");
	}
	let review: CompactionReview | undefined;
	try {
		// The mode in force for this operation. The trail (docs/trail.md) keeps no graph, so the graph-only
		// requests are refused here, as a recorded fault, before any preparation runs for them.
		const mode = modeFor(settings.mapMode ?? mom.mode);
		store.track = mode.name === "trail" ? "trail" : "graph"; // map records this operation writes belong to its mode's coverage track
		const rebuild = start.kind === "request" && start.request.kind === "rebuild";
		if (mode.name === "trail" && rebuild) throw new Error("Path's trail has no work graph to rebuild; /path reindex indexes the trail again.");
		const reviewing = await continuity(mom, start, host(start.session), store, decider);
		if (reviewing) mom = await open();
		// An explicit update handles the pending evidence now; the post-compaction audit remains queued for background delivery.
		// The trail audits no compaction: there is no map for a thread-map audit to reconcile against.
		review = mode.name === "trail" || relabel || (start.kind === "request" && (start.request.kind === "update" || start.request.kind === "rebuild"))
			? undefined : compactionToReview(mom, reader, status);
		await writeStatus(engine, api, ctx, current => { current.op = { job, mode: review ? "audit" : "update", startedAt: Date.now(), activity: "reading history" }; });
		let prepared = await mom.prepare({ refresh: start.kind === "request" && start.request.kind !== "update" && !relabel, review, force: relabel && Boolean(mom.checkpoint || (mode.name === "trail" && mom.coverageCut)),
			forceDigest: start.kind === "request" && start.request.kind === "rebuild", relabel, job, signal: ctx?.abortSignal });
		while (prepared.kind === "defer") {
			await writeStatus(engine, api, ctx, current => { current.waitingForWorkers = mom.waitingForWorkers; current.deferredUntil = prepared.kind === "defer" ? prepared.until : undefined; });
			await sleep(Math.max(250, Math.min(2000, prepared.until - Date.now())), ctx?.abortSignal);
			lead?.refresh();
			prepared = await mom.prepare({ refresh: start.kind === "request" && start.request.kind !== "update" && !relabel, review, force: relabel && Boolean(mom.checkpoint || (mode.name === "trail" && mom.coverageCut)),
				forceDigest: start.kind === "request" && start.request.kind === "rebuild", relabel, job, signal: ctx?.abortSignal });
		}
		status.waitingForWorkers = false; status.deferredUntil = undefined;
		status.unavailable = [...mom.feed.gaps.values()]; status.uncertainEffects = mom.feed.uncertainEffects();
		// A worker transcript that went missing is a side note; the lead's own transcript stuck is a stop, said as one.
		const blocked = mom.feed.gaps.get("parent");
		if (blocked) status.blocked = `Path cannot read past an entry of this session: ${blocked}`; else delete status.blocked;
		if (prepared.kind === "idle") {
			status.more = false;
			await save({ status: "done" }, current => { delete current.op; });
			return done(prepared.reason);
		}
		// Historical catch-up is a chapter-chain thread-map operation. It deliberately uses the
		// transaction finalizer for this operation, then returns to the saved frontier mode. v2 owns
		// every write to its map, so it reconciles the digest itself; the trail owns digests and
		// everything else, since it has no graph for commit_graph to write.
		const operationMode = mode.name === "trail" ? mode : relabel || (prepared.batch.digest && mode !== V2_MODE) ? COMMIT_GRAPH_MODE : mode;
		prepared.header.mapMode = operationMode.name;
		prepared.header.digest = Boolean(prepared.batch.digest);
		prepared.header.relabel = relabel;
		const repair = relabel && mode.name === "trail" && start.kind === "request" && start.request.kind === "relabel" && start.request.repair === true;
		if (repair) prepared.header.repair = true;
		const correction = prepared.batch.events.some(event => event.correction === true);
		const specSkip = operationMode !== V2_MODE ? undefined
			: start.kind !== "delivery" ? "not-delivery"
			: !mom.checkpointId ? "no-checkpoint"
			: review ? "review"
			: prepared.batch.digest ? "digest"
			: prepared.header.leadUnreadable ? "lead-unreadable"
			: prepared.header.retryGap ? "retry-gap"
			: prepared.batch.gaps.length ? "gaps"
			: mom.recovering ? "recovery"
			: correction ? "correction" : undefined;
		const specifiable = operationMode === V2_MODE && specSkip === undefined;
		if (operationMode === V2_MODE && specSkip) specLog(start.session, { job, ran: true, ops: [], skipped: specSkip });
		else if (mode.name === "v2" && operationMode !== V2_MODE && start.kind === "delivery")
			specLog(start.session, { job, ran: true, ops: [], skipped: `mode-${operationMode.name}` });
		let read;
		if (specifiable) {
			try { read = await readSpec(classifier, fromWorkGraph(mom.graph), prepared.batch.events); }
			catch (error) {
				const reason = error instanceof SpecError ? error.reason : "classifier-error";
				specLog(start.session, { job, ran: true, ops: [], failOpen: reason });
				throw error; // a spec is required: no update runs without one
			}
		}
		if (read) prepared.header.spec = read.ops;
		let body: Record<string, unknown> = { ...prepared.body, ...(prepared.guidance.trim() ? { guidance: prepared.guidance.trim() } : {}) };
		if (relabel && operationMode.name !== "trail") body = { task: "Repair the saved work map. Give a decision only for the work that needs one: a concise, meaningful label to keep it, or retired with a short reason. An ID you leave out keeps its saved label. Path tracks only durable, multi-turn things — retire status questions, one-off meta questions, and instructions the next turn fully satisfied. Keep genuine multi-turn work even when phrased as a question. Never retire settled work or work holding unfinished work. The host preserves sources, structure, notes and obligations.",
			work: mom.graph.nodes.filter(isEndeavor).map(node => ({ id: node.id, label: node.label, intent: node.intent, observed: node.observed, state: node.state })) };
		else if (prepared.batch.digest) body.task = "Fast historical catch-up. This is a host-compressed thread-map digest, not raw evidence: reconcile it once and preserve cited sources.";
		if (operationMode === V2_MODE) {
			// v2's own body: the map in its v2 form, and nothing of commit_graph's vocabulary.
			body = v2Body({ map: fromWorkGraph(mom.graph), ...(read ? { changes: read.ops } : {}),
				task: prepared.body.independentThreadMap ? V2_AUDIT_TASK : prepared.batch.digest ? V2_DIGEST_TASK : V2_UPDATE_TASK,
				newEvents: prepared.body.newEvents as string,
				newUserDirections: prepared.body.newUserDirections as V2BodyParts["newUserDirections"],
				instruction: prepared.body.instruction as string | undefined,
				independentThreadMap: prepared.body.independentThreadMap,
				recovery: prepared.body.recovery as Record<string, unknown> | undefined,
				guidance: prepared.guidance });
		}
		if (operationMode.name === "trail") {
			// The trail's own body: the evidence and what it already wrote (lines to reuse, ids to link),
			// read from `session.trail` on the lead's current branch. Nothing of the graph vocabulary.
			const trail = trailFor(await new TrailStore(() => start.session, reader.getSessionId()).load(), branchIds(reader));
			body = trailBody({ repair, task: repair ? TRAIL_REPAIR_TASK : relabel ? TRAIL_TITLE_TASK : prepared.header.backfilling ? TRAIL_BACKFILL_TASK : prepared.batch.digest ? TRAIL_DIGEST_TASK : TRAIL_UPDATE_TASK,
				newEvents: relabel ? "" : prepared.body.newEvents as string,
				newUserDirections: prepared.body.newUserDirections as { ref: string; text?: string }[] | undefined,
				trail, recovery: prepared.body.recovery as Record<string, unknown> | undefined, guidance: prepared.guidance });
		}
		status.operationTiming = mom.operationTiming;
		status.more = prepared.header.more;
		// v2: only a background batch the decision model can read is decided up front. An explicit
		// request, a correction, a first map, catch-up, an audit, a retry and a recovery all skip the
		// questions and go straight to its model, which then runs on structural checks alone.
		// The trail has no work items to guess about, even when a graph checkpoint survives a mode switch.
		const shadow = decider && prepared.kind === "work" && mom.checkpoint && read?.ops.length !== 0 && operationMode.name !== "trail" ? await shadowGuesses(decider.client, mom, prepared.batch.events) : undefined;
		await save({ status: "open", job, header: prepared.header, childUsage: usage.total, baseUsage: mom.usage, ...(shadow ? { shadow } : {}),
			// Recorded only when its model will run on it: the skip below logs its own `ran: false`, and
			// one batch must produce exactly one line either way.
			...(read?.ops.length ? { read: { ops: read.ops, chosen: read.chosen } } : {}) }, current => {
			current.op = { job, mode: review ? "audit" : "update", startedAt: current.op?.startedAt ?? Date.now(), thinkingAt: Date.now(), activity: "thinking",
				target: prepared.kind === "work" ? prepared.header.cut?.parent ?? null : null, recovering: mom.recovering,
				...(operationMode.name === "trail" ? { task: repair ? "repairing" : relabel ? "titling" : prepared.header.backfilling ? "backfilling" : "reading" } : {}) };
		});
		// The trail: the decision model reads each user turn of the batch; when none steers the work (a status
		// question, an acknowledgement, a correction of how the same task is done), nothing goes on the trail and
		// its model is skipped. A batch with no user turn, a request, a retry or a recovery always runs.
		if (operationMode.name === "trail" && beverly && !relabel && !prepared.header.retryGap && !mom.recovering
			&& await routineBatch(beverly, prepared.batch.events, mom.feed.events)) {
			await store.append("map", { base: null, cut: prepared.header.cut, failure: null,
				...(prepared.header.backfill !== undefined ? { backfill: prepared.header.backfill } : {}) }, `${job}:map`);
			await accepted(engine, api, ctx, prepared.header);
			return done("Trail unchanged: the decision model found no steering in this batch. Evidence coverage saved.");
		}
		if (read && !read.ops.length) {
			// The decision model read the batch and found nothing to record: save coverage, skip its model.
			specLog(start.session, { job, ran: false, ops: [], chosen: read.chosen });
			await store.append("map", { base: mom.checkpointId, cut: prepared.header.cut, failure: null, ...(prepared.header.screen ? { screen: prepared.header.screen } : {}) }, `${job}:map`);
			await accepted(engine, api, ctx, prepared.header);
			return done("Map unchanged: the decision model found nothing to record. Evidence coverage saved.");
		}
		return { content: text(JSON.stringify(body)) };
	} catch (error) {
		const message = String(error);
		if (ctx?.abortSignal?.aborted) throw error;
		try { await store.append("usage", { usage: sumUsage(mom.usage, usage.total), error: message }, `${job}:usage`); } catch { /* the failure stays visible */ }
		status.lastError = message;
		// A review that failed still watches the lead after the compaction, from its last accepted map.
		if (review && mom.inject && mom.checkpoint) try { await openWindow(store, reader, mom.window, review.triggerRef); } catch { /* the failure stays visible */ }
		await save({ status: "done", fault: message }, current => { delete current.op; });
		return { content: text(`${OPERATION_FAILED}${message}`), isError: true, control: { terminate: true } };
	}
}

/**
 * Asked of each user turn by the trail's gate: how much it steers, on ordered levels. A scale, not a yes/no: the
 * cutoff sits between "none" and "minor", so a turn the model is unsure about still runs the update.
 */
const STEERS: DeciderQuestion = { type: "score",
	instructions: "Judge the user's message in a coding session (the assistant's preceding words are context only). How much does it steer where the work goes?",
	criteria: [
		"None: asks about status, acknowledges, says go on or try again, or corrects how the assistant does the same task.",
		"Minor: adds a detail or constraint to the task already under way.",
		"Clear: makes or approves a choice, starts a new task, parks something for later, or finishes or drops something.",
		"Major: sets a new goal, or turns to different work, or comes back to earlier work.",
	] };
/**
 * A batch is routine when every user turn scores below this (levels 0–3). Calibrated on a real session's 57 turns
 * with the preceding assistant words in the state: 0.9 skipped 4 of 27 routine turns and lost none of 30 steering
 * ones; 1.1 lost one. Without that context no cutoff separated them. Low on purpose: a missed turn loses a waypoint.
 */
export const STEER_CUTOFF = 0.9;
/** The assistant words a turn is judged against: "go", "proceed" approve whatever was just proposed. */
const CONTEXT_CHARS = 800;

/**
 * Whether a trail batch is routine: it has user turns and the decision model finds none that steers. Any failure
 * to ask counts as not routine, so the model runs.
 */
export async function routineBatch(beverly: Beverly, events: readonly FeedEvent[], history: readonly FeedEvent[] = events): Promise<boolean> {
	const users = events.filter(isUserDirection).filter(event => (event.text ?? "").trim());
	if (!users.length) return false;
	// Each turn with the lead's last words before it, from the whole feed: a batch usually starts at the turn.
	const before = (turn: FeedEvent) => {
		const at = history.findIndex(event => event.ref === turn.ref);
		for (let i = (at < 0 ? history.length : at) - 1; i >= 0; i--) {
			const event = history[i]!;
			if (isUserDirection(event)) return "";
			if (event.actor === "lead" && event.kind === "assistant" && event.text?.trim()) return event.text.trim().slice(-CONTEXT_CHARS);
		}
		return "";
	};
	const states = users.map(turn => `The assistant had just said: ${before(turn) || "(nothing)"}\n\nThe user then sent: ${turn.text!.trim().slice(0, 2000)}`);
	try {
		const scores = await Promise.all(states.map(state => beverly.answers(state, { steers: STEERS })
			.then(answers => answers.steers?.type === "score" ? answers.steers.score : Infinity)));
		return scores.every(score => score < STEER_CUTOFF);
	} catch { return false; }
}

/**
 * The newest compaction after its coverage that has not been reviewed twice without success: its review
 * (a thread-map audit before the map update). Its anchor is prepared first, as the live lead did.
 */
function compactionToReview(mom: Mom, reader: ReturnType<typeof currentSession>, status: MomStatus): CompactionReview | undefined {
	// A backlog (read cold, or still being caught up) has compactions that are history, read by the catch-up itself:
	// only a few compactions since its last save, on a saved map, are worth an audit.
	const queued = mom.unreviewedCompactions();
	const trigger = mom.checkpoint && !status.more && queued.length <= MAX_QUEUED_REVIEWS ? queued.at(-1) : undefined;
	if (!trigger) return undefined;
	if ((status.auditAttempts[trigger.ref] ?? 0) >= 2) return undefined;
	status.auditAttempts[trigger.ref] = (status.auditAttempts[trigger.ref] ?? 0) + 1;
	// A compaction's ref names its entry (no block suffix): the review wants that entry id.
	const id = entryIdOf(trigger.ref);
	if (!id) return undefined;
	try { return reviewFromSession(reader.getBranch(), reader.getSessionId(), id); } catch { return undefined; }
}

/**
 * Post-compaction continuity, before the review: the anchor for a new compaction, the receipt of one the
 * lead delivered, and the check of a settled lead turn while a continuity window is open.
 */
async function continuity(mom: Mom, start: OperationStart, host: ConstructorParameters<typeof Mom>[0], store: SidecarStore,
	decider: { client: Decider; clear: number } | undefined): Promise<boolean> {
	let changed = false;
	const reader = host.ctx.sessionManager, branch = reader.getBranch(), leaf = reader.getLeafId();
	// The lead delivered the anchor it prepared: record it.
	const reserved = mom.reservedAnchor;
	if (reserved && branch.some(entry => entry.type === "custom_message" && entry.customType === ANCHOR && entry.details?.key === reserved.key)) {
		await store.append("injection", { kind: "anchor", action: "delivered", key: reserved.key, compaction: reserved.key, content: reserved.content, parent: leaf }, `${reserved.key}:delivered`);
		changed = true;
	}
	// A new compaction: queue and prepare its anchor from the saved map, before the audit changes it.
	const trigger = mom.unreviewedCompactions().at(-1);
	const known = (await store.load()).some(record => record.type === "injection" && record.data.kind === "anchor" && record.data.key === trigger?.ref);
	if (trigger && mom.inject && !known) {
		await store.append("injection", { kind: "anchor", action: "pending", key: trigger.ref, compaction: trigger.ref, parent: leaf }, `${trigger.ref}:pending`);
		if (!mom.checkpoint) await store.append("injection", { kind: "anchor", action: "skipped", key: trigger.ref, compaction: trigger.ref, reason: "Path had no saved map to anchor from", parent: leaf }, `${trigger.ref}:skipped`);
		else {
			const content = renderAnchor(mom.checkpoint, await collectSideEffects(mom.feed), formatDuration(Date.now() - mom.checkpoint.at));
			await store.append("injection", { kind: "anchor", action: "reserved", key: trigger.ref, compaction: trigger.ref, content, parent: leaf }, `${trigger.ref}:reserved`);
		}
		changed = true;
	}
	// The finding the user saw stays unanswered across two of their messages: ignored.
	const active = mom.engagement.active, note = mom.checkpoint?.note;
	if (active && note && active.key === noticeKey(note) && !feedbackApplies(mom.findingFeedback.get(active.key), note)) {
		const since = active.parent === null ? -1 : branch.findIndex(entry => entry.id === active.parent);
		const messages = branch.slice(since + 1).filter(entry => entry.type === "message" && entry.message.role === "user");
		if (since >= -1 && messages.length >= 2) { await store.append("notice", { key: active.key, action: "ignored", note, parent: leaf }); changed = true; }
	}
	const win = mom.window;
	if (start.kind !== "delivery" || !win || !mom.inject || !mom.checkpoint || !host.ctx.isIdle()) return changed;
	// The turn since the last check, as one settled lead turn.
	const records = (await store.load()).filter(record => record.type === "injection" && record.data.kind === "window" && record.data.key === win.key);
	const boundary = records.at(-1)?.data.parent ?? null;
	const check = new Mom(host); await check.open();
	await check.feed.capture(24000, true);
	const events = check.feed.events, from = boundary === null ? 0 : events.findIndex(event => entryIdOf(event.ref) === boundary) + 1;
	const turn = events.slice(Math.max(0, from)).filter(event => event.actor === "lead");
	if (!turn.length) return changed;
	const compactAt = events.findIndex(event => event.ref === win.compaction);
	const close = (reason: string, held: boolean, turns: number) => store.append("injection", { kind: "window", action: "closed", key: win.key, compaction: win.compaction, reason, held, turns, parent: leaf });
	// The user's own message is direction: it supersedes the record, so the window closes.
	if (events.slice(Math.max(compactAt + 1, from)).some(isUserDirection)) { await close("user-message", win.turns > 0, win.turns); return true; }
	let error: string | undefined;
	const signals = await collectTurnSignals(check.feed, turn);
	let flags: Awaited<ReturnType<typeof stageOne>> = [];
	try { flags = await stageOne(check.feed, mom.checkpoint, signals); } catch (cause) { error = String(cause); }
	const direction = lastDirectionOf(check.feed), purpose = windowPurpose(mom.checkpoint);
	const canCheck = flags.length > 0 && win.checks < MAX_WINDOW_CHECKS;
	let verdict: ReturnType<typeof parseWindowVerdict>;
	// The local decider can only clear: a confident "continues" skips the model check; anything else falls through.
	let cleared: { p: number; latencyMs: number } | undefined;
	if (canCheck && decider) try {
		const state = [purpose, direction ? `Last user direction: ${direction.text}` : "", "Flagged records this turn touched:",
			...flags.map(flag => `- ${flag.class}: ${flag.label}${flag.intent ? ` — ${flag.intent}` : ""}`), "", "This turn:", renderEvents(turn)].filter(Boolean).join("\n").slice(-24000);
		const { answers, latencyMs } = await decider.client.ask(state, { continues: { type: "noul", instructions: "Does this turn stay on the current line of work, or the user's last direction?",
			criteria: { false: "The turn departs from the recorded line: it resumes parked or finished work, breaks a standing rule, or pursues a different goal without the user asking.",
				true: "The turn continues the recorded line of work or follows the user's last direction; touching a flagged record is incidental." } } });
		const p = answers.continues.type === "noul" ? answers.continues.noul : 0;
		if (p >= decider.clear) cleared = { p, latencyMs };
	} catch { /* the decider is optional: the model check runs */ }
	if (canCheck && !cleared) try {
		const texts = windowMessages({ flags, turnEvents: turn, purpose, lastUserDirection: direction }).map(message => textOf((message as any).content, ""));
		const checkJob = `window-${createHash("sha256").update(JSON.stringify(texts)).digest("hex").slice(0, 32)}`;
		const session = { file: reader.getSessionFile()!, id: reader.getSessionId(), cwd: host.ctx.cwd, leaf };
		const result = await host.steps({ header: { job: checkJob, step: "check", mode: "check", refs: [], session }, body: texts[0], more: texts.slice(1),
			instructions: "Check post-compaction continuity using the supplied evidence.", tools: [], thinking: "low" });
		const reply = [...result.messages].reverse().find((message: any) => message.role === "assistant");
		if (!reply || reply.stopReason === "error") throw new Error(reply?.errorMessage ?? "Path's check returned no answer.");
		verdict = parseWindowVerdict(textOf((reply as any)?.content, ""), offeredRefs({ flags, turnEvents: turn, lastUserDirection: direction }));
		if (!verdict) error = "The check reply was not a cited verdict; no correction.";
	} catch (cause) { error = String(cause); }
	const turns = win.turns + 1, checks = canCheck ? win.checks + 1 : win.checks;
	await store.append("injection", { kind: "window", action: "checked", key: win.key, compaction: win.compaction, turns, checks, ...(flags.length ? { flagged: flags } : {}), ...(error ? { error } : {}),
		...(cleared ? { decider: { continues: cleared.p, latencyMs: cleared.latencyMs } } : {}), parent: leaf });
	if (verdict && !verdict.continues) {
		const content = renderCorrection({ signals, flags, purpose, lastUserDirection: direction });
		await store.append("injection", { kind: "window", action: "corrected", key: win.key, compaction: win.compaction, content, parent: leaf });
		await close("correction", false, turns);
	} else if (turns >= MAX_WINDOW_TURNS) await close("turns", true, turns);
	return true;
}

const STATE_CHOICES = {
	unchanged: "Still in progress, or not touched by this activity.",
	finished: "This activity finished, shipped, or verified it.",
	blocked: "This activity left it blocked, waiting on the user or something else.",
	abandoned: "This activity dropped it, rejected it, or replaced it with another approach.",
};
/** Shadow only: for each open item on its map, the decider's guess of what this batch did to it. Failures are silent. */
async function shadowGuesses(client: Decider, mom: Mom, events: readonly FeedEvent[]): Promise<OperationState["shadow"]> {
	const open = (mom.checkpoint?.graph.nodes ?? []).filter(node => ["active", "proposed", "parked"].includes(node.state) && ["feature", "theory", "postulate", "try"].includes(node.kind)).slice(0, 12);
	if (!open.length || !events.length) return undefined;
	const activity = renderEvents(events).slice(-20000);
	const guesses: NonNullable<OperationState["shadow"]>["guesses"] = [];
	let latencyMs = 0;
	try {
		for (const node of open) {
			const state = `WORK ITEM: [${node.state}] ${node.label}${node.intent ? ` — ${clipText(node.intent, 300, { ellipsis: "" })}` : ""}\n\nWHAT HAPPENED SINCE THE LAST UPDATE:\n${activity}`;
			const { answers, latencyMs: ms } = await client.ask(state, { fate: { type: "choice", instructions: "What did this activity do to the work item?", criteria: STATE_CHOICES } });
			latencyMs += ms;
			const a = answers.fate;
			if (a.type === "choice") guesses.push({ id: node.id, label: node.label, state: node.state, guess: a.choice, p: Math.round((a.probabilities[a.choice] ?? 0) * 1000) / 1000 });
		}
	} catch { return guesses.length ? { guesses, latencyMs } : undefined; }
	return { guesses, latencyMs };
}

/** What the decision model decided, and once known what its model then did with it: evaluation data in
 *  its own log beside its .mom file, never its state. Best-effort, and the record the constants are
 *  re-fitted from (docs/v2-change-spec.md). */
function specLog(sessionFile: string, entry: Record<string, unknown>) {
	try { appendFileSync(sessionFile.replace(/\.jsonl$/, "") + ".mom-decider", JSON.stringify({ at: Date.now(), kind: "v2-spec", ...entry }) + "\n"); } catch { /* evaluation data */ }
}

/** A compaction's continuity window opens (a window still open for an earlier one closes as superseded). */
async function openWindow(store: SidecarStore, reader: ReturnType<typeof currentSession>, open: WindowLive | undefined, trigger: string) {
	if (open?.key === trigger) return; // a retry of the same review
	if (open) await store.append("injection", { kind: "window", action: "closed", key: open.key, compaction: open.compaction, reason: "superseded", held: open.turns > 0, turns: open.turns, parent: reader.getLeafId() });
	await store.append("injection", { kind: "window", action: "opened", key: trigger, compaction: trigger, parent: reader.getLeafId() }, `${trigger}:window`);
}

/**
 * After its finalizer saved the map: usage, its finding for the user, and for a compaction review the
 * continuity window. Runs in the finalizer's tool call.
 */
export async function accepted(engine: Engine, api: Durable.ToolExecutionApi, ctx: any, header: OperationHeader, diagnostics?: { unmet?: string[] }) {
	const op = await readOperation(engine, api, ctx);
	if (op.job !== header.job || op.status !== "open") return;
	const file = header.session.file;
	const store = new SidecarStore(() => file, header.session.id);
	const messages = op.startEntry ? (await entriesFrom(api, ctx, api.conversationId as any, op.startEntry)).flatMap(entry => entry.model) : [];
	// Its turn's wall time (the model's replies and its tool calls), from the end of the preparation to now.
	const before = await readStatus(engine, api, ctx), turnMs = before.op?.thinkingAt ? Math.max(0, Date.now() - before.op.thinkingAt) : 0;
	const turn = readStep(messages).usage;
	const usage = sumUsage(sumUsage(op.baseUsage ?? emptyUsage(), op.childUsage ?? emptyUsage()), { ...turn, elapsedMs: turn.elapsedMs + turnMs });
	await store.append("usage", { usage, error: null }, `${header.job}:usage`);
	const reader = currentSession(file);
	const state = await loadState(store, reader, { mode: header.mapMode });
	// The spec read this batch: whether its model then changed the map is what labels the ops.
	if (op.read) specLog(file, { job: header.job, ran: true, ...op.read, ...(diagnostics?.unmet?.length ? { unmet: diagnostics.unmet } : {}),
		changed: (await store.load()).some(record => record.id === `${header.job}:map` && record.data.snapshot !== undefined) });
	if (op.shadow?.guesses.length) {
		const after = new Map((state.checkpoint?.graph.nodes ?? []).map(node => [node.id, node.state]));
		const actual = (before: string, now: string | undefined) => now === undefined ? "removed" : now === before ? "unchanged"
			: now === "settled" ? "finished" : now === "parked" ? "blocked" : `now ${now}`;
		// Its own log beside its .mom file: evaluation data, not its state (older readers reject unknown record types).
		try {
			appendFileSync(file.replace(/\.jsonl$/, "") + ".mom-decider", JSON.stringify({ at: Date.now(), kind: "state-shadow", job: header.job, latencyMs: op.shadow.latencyMs,
				items: op.shadow.guesses.map(g => ({ ...g, actual: actual(g.state, after.get(g.id)) })) }) + "\n");
		} catch { /* shadow data is best-effort */ }
	}
	const notices: MomStatus["notices"] = [];
	{
		// Its finding reaches the user when its account is complete and the user wants that kind of finding.
		const note = state.checkpoint?.note, key = note ? noticeKey(note) : undefined;
		const offered = note && state.engagement.last?.key === key && note.riskRefs.every(ref => state.engagement.last!.riskRefs.includes(ref));
		if (note && key && state.enabled && !header.more && !state.gaps.length && !state.failure && state.nudgedClasses.includes(note.riskClass) && !offered && !feedbackApplies(state.feedback[key], note)) {
			const action = state.engagement.remaining ? "backoff" : "delivered";
			await store.append("notice", { key, action, note, parent: reader.getLeafId(), presented: action === "delivered" });
			recordEngagement(state.engagement, action, key, note, reader.getLeafId(), action === "delivered");
		}
		// A reviewed compaction opens its continuity window.
		// A compaction queued behind this one opens its own window instead.
		const branch = reader.getBranch(), at = branch.findIndex(entry => makeRef(header.session.id, entry.id) === header.trigger?.ref);
		const superseded = at >= 0 && branch.slice(at + 1).some(entry => entry.type === "compaction");
		if (header.trigger && state.inject && state.checkpoint && !superseded) await openWindow(store, reader, state.window, header.trigger.ref);
	}
	await writeOperation(engine, api, ctx, current => { current.status = "accepted"; });
	await writeStatus(engine, api, ctx, status => {
		delete status.op;
		if (status.operationTiming) status.operationTiming = { ...status.operationTiming, requestMs: turnMs, totalMs: status.operationTiming.startupMs + turnMs };
		status.notices.push(...notices);
		status.rejectedStreak = 0; delete status.lastRejection; delete status.lastError; status.more = Boolean(header.more) || state.gaps.length > 0;
		if (header.trigger) delete status.auditAttempts[header.trigger.ref];
	});
}

/**
 * A finalizer gave up after its repair: the operation is rejected, and what it leaves is recorded now (a
 * retry record, a skipped range, or a retired range). An update's turn then fails, so oven retries it.
 */
export async function rejected(engine: Engine, api: Durable.ToolExecutionApi, ctx: any, header: OperationHeader, rejection: string) {
	const op = await readOperation(engine, api, ctx);
	if (op.job !== header.job || op.status !== "open") return;
	const fault = header.mode === "update" && !header.retryGap ? rejection : undefined;
	const status = await readStatus(engine, api, ctx);
	let settled = false;
	try {
		const file = header.session.file, notices: MomStatus["notices"] = [];
		const mom = new Mom({ ctx: leadContext(file, notices), model: "", store: new SidecarStore(() => file, header.session.id), steps: async () => { throw new Error("no steps while settling"); }, changed: () => {} });
		await mom.open();
		const messages = op.startEntry ? await operationMessages(api, ctx, op.startEntry, Number.MAX_SAFE_INTEGER) : [];
		const outcome = { ...readStep(messages), rejection };
		const result = await mom.settle(header, outcome, sumUsage(sumUsage(op.baseUsage ?? mom.usage, op.childUsage ?? emptyUsage()), outcome.usage));
		if (result.retiredRejection) { status.rejectedStreak++; status.lastRejection = result.retiredRejection; }
		settled = true;
	} catch (error) { status.lastError = `Path could not record its rejected notes: ${String(error)}`; }
	await writeOperation(engine, api, ctx, current => { current.status = settled ? "done" : "rejected"; current.rejection = rejection; if (fault) current.fault = fault; });
	await writeStatus(engine, api, ctx, current => {
		delete current.op; current.lastError = rejection; current.rejectedStreak = status.rejectedStreak; current.lastRejection = status.lastRejection;
	});
}

/** Its own tooling failed mid-operation: the operation ends; an update's turn fails so oven retries it. */
export async function failed(engine: Engine, api: Durable.ToolExecutionApi, ctx: any, error: string) {
	const op = await readOperation(engine, api, ctx);
	if (op.status !== "open") return;
	await writeOperation(engine, api, ctx, current => { current.fault = error; });
	await writeStatus(engine, api, ctx, status => { delete status.op; status.lastError = error; });
}
