/**
 * The pi backend: in-process Pi children (and oven slices) as durable runs, and their lifecycle. The process-wide
 * run registry and each parent's Owner; run records (RunStore); creating a run, opening its session and running a
 * segment; settling it and delivering its completion; its views and reports; joining runs for a wait; steer,
 * cancel, resume and parent close. PiBackend is the DelegateBackend over it, one per parent binding (it owns that
 * binding's model runtime). What only the binding knows comes in as PiBackendHooks (index.ts): the parent, its
 * model registry and session link, a child's extension loader, and how a delegate call or a steer's model spec
 * resolves against the parent's roles, settings and catalog.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createAgentSession, type DefaultResourceLoader, type ExtensionAPI, type ExtensionContext, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AGENT_DIR, SETTINGS_PATH } from "./agent-dir.ts";
import { type AcpBackend, runningAcpRuns } from "./acp-backend.js";
import { type AcpRunView, type BackendCapabilities, type CancelRequest, type CloseRequest, DelegateError, type DelegateBackend, OVEN_CAPABILITIES, PI_CAPABILITIES, type PiRunView, type PiStartInput, requireAction, type SteerRequest, unwrap, type WaitOutcome, type WaitRequest } from "./backend.js";
import { RunCompletion } from "./completion.js";
import { readDelegateSettings } from "./delegate-settings.ts";
import type { LiveSource } from "./inspector.js";
import { expiredEvent, OVEN_EXPIRES, ovenCall, ovenHeartbeat, requireExpiry, SliceExpired, SliceGone, type Settled, type SliceView } from "./oven.js";
import type { TrustSource } from "./project-trust.js";
import type { RunView } from "./render.js";
import { droppedTools, toolAllowlist } from "./roles.js";
import { modelKey, splitModelRef } from "./model-ref.ts";
import { ownedElsewhereError, processOwner, readRecord, releaseOwner, RunStore, storageDir, writeRecord } from "./storage.js";
import type { ActiveTool, ChildActivity } from "./transcript.js";
import { formatDuration, formatTokens } from "./util/format.ts";
import { gitSync } from "./util/git.ts";
import { errorMessage, oneLine, textOf } from "./util/text.ts";
import { BROWSE_CALLS, budgetText, clock, runHealth, type Verdict, WRAP_UP_MIN_MS } from "./health.js";
import { type Join, joinRuns, WAIT_POLL_MS } from "./wait.ts";

const LOG_FILE = join(AGENT_DIR, "delegate-runs.jsonl");

export const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

/** The depth limit now: read at each delegate call, so a settings change applies to the next child. */
export const maxDepth = () => readDelegateSettings(SETTINGS_PATH).maxDepth;

const MAX_RETAINED_SESSIONS = 8;
const OUTPUT_CAP = 40_000;

/** Parent-session event bus only. No model turn or worker tool is created by a milestone. */
export const DELEGATE_MILESTONE_EVENT = "pi-delegate:milestone.v1";
export interface DelegateMilestone {
	version: 1;
	runId: string;
	segment: number;
	role: string;
	kind: "started" | "note" | "settled";
	at: number;
	task?: string;
	text?: string;
	status?: Status;
	changedFiles?: string[];
}

export type Status = RunView["status"];
export type RunResult = { content: { type: "text"; text: string }[]; details: RunView; isError: boolean };

export interface Run {
	id: string;
	ownerKey: string;
	recordPath: string;
	segment: number;
	stopped: boolean;
	acknowledged: boolean;
	systemPrompt: string;
	contextFiles: { path: string; content: string }[];
	appendSystemPrompt: string[];
	/** The role's `tools` line, names and `*` patterns; EVERY_TOOL when it has none. */
	tools: string[];
	/** Names it may not have whatever its list says: the delegation pair at the depth cap. */
	withheld?: string[];
	timeoutMs: number;
	sessionId: string;
	completion: RunCompletion<RunResult>;
	role: string;
	model: string;
	thinking: string;
	context: "fork" | "fresh";
	cwd: string;
	task: string;
	status: Status;
	startedAt: number;
	endedAt?: number;
	turns: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	cost: number;
	changedFiles: string[];
	droppedTools: string[];
	output: string;
	failedAttempts: number;
	/** Failed attempts in the current segment, for causal timeout reporting. */
	segmentFailedAttempts: number;
	segmentFailedAttemptsBase: number;
	lastAttemptError?: string;
	providerRetryMs: number;
	providerRetry?: { attempt: number; maxAttempts: number; delayMs: number; errorMessage: string; startedAt: number };
	error?: string;
	lastTool?: string;
	toolCalls: { name: string; args: Record<string, unknown>; at: number }[];
	activeTools: Map<string, ActiveTool>;
	revision: number;
	streamingMessage?: any;
	activityCache?: { revision: number; items: ChildActivity };
	contextWindow?: number;
	session?: any;
	ready?: Promise<void>;
	/** Resource preparation is part of the background launch, not the parent tool call. */
	preparing?: Promise<void>;
	startIdx: number;
	/** Transcript index at which the current segment began; lifetime counters still use startIdx. */
	segmentStartIdx: number;
	/** Start of the current execution segment; unlike startedAt, this resets on every resume. */
	segmentStartedAt: number;
	forkedMessages?: number;
	writer: boolean;
	/** The delegate call's firstDeliverableMin: minutes from each segment's start (health.ts firstDeliverableAt). */
	firstDeliverableMin?: number;
	dirtyBefore?: Map<string, number>;
	timer?: ReturnType<typeof setTimeout>;
	/** Fires the wrap-up steer ahead of `timer` (armTimeout). */
	wrapTimer?: ReturnType<typeof setTimeout>;
	/** Last tool start/end or message end; a segment start counts as one (health.ts). */
	lastProgressAt?: number;
	/** When the open assistant message began; unset between messages. */
	turnStartedAt?: number;
	/** The child's last `EXTEND:` line, until a steer changes its budget or a segment starts. */
	extendRequest?: { minutes: number; reason: string; at: number };
	/** The verdicts the watchdog alerted on since the run last moved; cleared when it is moving again. */
	alerted?: Verdict[];
	sessionFile?: string;
	// Per-run ownership (see storage.ts). A run owned by another live process is read-only here.
	ownerPid?: number;
	ownerHost?: string;
	ownerToken?: string;
	foreign?: boolean;
	/** 1 for a child of the root parent; one more for each delegating child above it. */
	depth: number;
	/** Set when the child runs as an oven slice instead of in this process (role `runtime: oven`, or the call's `runtime`). */
	runtime?: "oven";
	/** oven: the extensions the slice selects, from the role. */
	extensions?: string[];
	/** oven: the slice this run drives; set once oven created it. */
	sliceId?: string;
	/** Why the last cancel could not show that oven halted this run's slice; unset when oven confirmed it (or the run has no slice). */
	haltNote?: string;
	/** oven: the last heartbeat (oven_expires) that failed, until one succeeds again. */
	heartbeatError?: string;
	/** oven tui: the agent whose own TUI oven hosts for this run (a tui slice), and the agent template it was made from. */
	tui?: "pi" | "claude" | "amp";
	template?: Record<string, unknown>;
	/** oven tui: instructions the agent cannot take as a system prompt (Amp), put ahead of the first message. */
	taskPrefix?: string;
	/** oven tui: the call's model, passed to the agent as an override of its template's. */
	modelOverride?: string;
	/** Set when a delegating child started this run. */
	parentRunId?: string;
	/** Which entry of the role's model list the run got, and why earlier entries were skipped. */
	modelPick?: string;
	/** Started by the person with /delegate: its completion is shown without starting a model turn. */
	userStarted?: true;
	/** Every tool name the child's current session was offered, allowed or not; droppedTools is read from it. */
	offered?: Set<string>;
	/** Extensions that failed to load, or failed in a handler, in the child's current session. It ran without them. */
	extensionErrors?: string[];
	/**
	 * Whether the child's project is trusted, decided by its parent at delegate time (childTrust). It
	 * governs everything the child reads from `<cwd>/.pi`: settings, mcp.json, and a delegating child's roles.
	 */
	projectTrusted: boolean;
	/** Why the child has that trust (see TrustSource); `unknown` for a record from before 0.2.0. */
	projectTrustSource: TrustSource;
	/** A record from before trust was recorded (pi-delegate < 0.2.0): it runs untrusted, and says so. */
	projectTrustUnknown?: true;
	/** Set by stopTree: once this segment settles its session closes, since its children's owner is gone. */
	closeOnSettle?: boolean;
	/** Read receipts of its last STEER_RECEIPTS delegate_ctl steers: queued when, read by its session when. */
	steers?: SteerReceipt[];
}

/** One delegate_ctl steer: when it was queued, and when the child's session took the message in (its user message started). */
export interface SteerReceipt { queuedAt: number; readAt?: number; interrupt?: true }
const STEER_RECEIPTS = 5;
/** Each unread receipt's message, matched against the user messages the child's session starts. In memory only. */
const steerTexts = new WeakMap<SteerReceipt, string>();
/** An interrupting steer's message, by run id: launch sends it as the next prompt once the aborted turn's prompt returns. */
const interrupts = new Map<string, string>();
function noteSteer(run: Run, message: string, interrupt?: boolean): SteerReceipt {
	const receipt: SteerReceipt = { queuedAt: Date.now(), ...(interrupt ? { interrupt: true as const } : {}) };
	steerTexts.set(receipt, message);
	run.steers = [...(run.steers ?? []), receipt].slice(-STEER_RECEIPTS);
	return receipt;
}
/** A user message the child's session started: every unread steer it carries is read now (an interrupt may join two). */
function readSteers(run: Run, text: string) {
	for (const receipt of run.steers ?? []) {
		const message = steerTexts.get(receipt);
		if (receipt.readAt === undefined && message !== undefined && text.includes(message)) { receipt.readAt = Date.now(); steerTexts.delete(receipt); }
	}
}

/** A parent's in-process binding. There is no parent-level lock: runs carry their own ownership. */
export interface Owner {
	key: string;
	// One pointer file per run: concurrent processes on the same parent never clobber a shared list.
	dir: string;
	queued: Set<string>;
	closed: boolean;
	binding?: { pi: ExtensionAPI; ctx: ExtensionContext };
	/**
	 * Set when this owner is a delegating child's own session: its children's completions go to
	 * that child (wakeChild), never straight into its session as a parent turn.
	 */
	parentRun?: Run;
	/** The attached binding's steer, so a completion can revive one of this owner's settled runs. */
	resume?: (run: Run, message: string) => Promise<void>;
	/** The same steer for a message the person typed in the root's UI: an explicit restart request. */
	steerFromUser?: (run: Run, message: string) => Promise<void>;
	/** The attached binding's ACP backend: the one that reads, steers and cancels this owner's ACP runs. */
	acp?: AcpBackend;
	/** A root parent's view of its whole tree, as the Agents frame reads and acts on it. */
	live?: LiveSource;
	/** Open one of this owner's settled runs' sessions without starting a turn: a delegating run's own children reattach with it. */
	reopen?: (run: Run) => Promise<void>;
	/** True while one of this owner's runs, pi or ACP, has not settled. */
	busy?: () => boolean;
	/**
	 * Closes this owner and its ACP runs, as session_shutdown does. A nested owner also gets that
	 * event when its delegating child's session closes (closeSession); detach closes it while the session stays.
	 */
	detach?: () => Promise<void>;
	/** Late-report notices that arrived while this owner had no binding (a reload); attach delivers them. */
	pendingNotices?: Notice[];
}
export interface RuntimeState {
	runs: Map<string, Run>;
	owners: Map<string, Owner>;
	listeners: Set<() => void>;
}
// This is the process-owned execution layer. Extension instances are replaceable UI/tool bindings.
// Never persist live session objects; a fresh process reconstructs only inert records from disk.
const runtimeKey = Symbol.for("@ssweens/pi-delegate/runtime/1");
const processState = globalThis as typeof globalThis & { [key: symbol]: RuntimeState };
export const state = processState[runtimeKey] ??= { runs: new Map(), owners: new Map(), listeners: new Set() };
export const { runs, listeners } = state;
export function changed() { for (const listener of listeners) listener(); }
function milestone(run: Run, event: Omit<DelegateMilestone, "version" | "runId" | "segment" | "role" | "at">) {
	const owner = state.owners.get(run.ownerKey);
	if (!owner?.binding || owner.closed || run.foreign) return;
	owner.binding.pi.events.emit(DELEGATE_MILESTONE_EVENT, {
		version: 1, runId: run.id, segment: run.segment, role: run.role, at: Date.now(), ...event,
	} satisfies DelegateMilestone);
}
function newId(role: string): string { return `${role}-${randomUUID()}`; }
export function ownerPath(ctx: ExtensionContext): string {
	return join(storageDir(ctx.sessionManager.getCwd()), "owners", `${ctx.sessionManager.getSessionId()}.json`);
}
export function ownedRuns(owner: Owner): Run[] { return [...runs.values()].filter((r) => r.ownerKey === owner.key); }
export function pointerDir(key: string): string { return key.replace(/\.json$/, ""); }
/** Legacy single-file index (read only) plus one pointer file per run. */
export function runRecordPaths(owner: Owner): string[] {
	const paths: string[] = [];
	const legacy = readRecord<{ version: number; runs: string[] }>(owner.key);
	if (legacy && (legacy.version !== 1 || !Array.isArray(legacy.runs) || legacy.runs.some((p) => typeof p !== "string"))) throw new Error(`Invalid delegate index: ${owner.key}`);
	paths.push(...(legacy?.runs ?? []));
	for (const file of RunStore.recordFiles(owner.dir)) {
		const pointer = readRecord<{ version: number; recordPath: string }>(file);
		if (!pointer || pointer.version !== 1 || typeof pointer.recordPath !== "string") throw new Error(`Invalid delegate pointer: ${file}`);
		paths.push(pointer.recordPath);
	}
	return [...new Set(paths)];
}

/**
 * The runs a delegating child started, kept when its session closes (retired, cancelled, reopened on a
 * new model): the root lists, reads and revives them as it does its own settled children, until the next
 * prompt hides them. Keyed by the delegating run's id; its revival restores them live and drops the entry.
 */
export interface Departed { pi: Run[]; acp: { view: AcpRunView; activity: ChildActivity }[] }
export const departed = new Map<string, Departed>();
/** A delegating child's close still in progress (parking its ACP runs), by its run id. A revival waits for it. */
export const closingChildren = new Map<string, Promise<void>>();
/** A departed run, and the delegating run whose session held it. */
export function findDeparted(id: string): { parentId: string; run?: Run; acp?: Departed["acp"][number] } | undefined {
	for (const [parentId, gone] of departed) {
		const run = gone.pi.find((r) => r.id === id);
		if (run) return { parentId, run };
		const acpRun = gone.acp.find((a) => a.view.id === id);
		if (acpRun) return { parentId, acp: acpRun };
	}
	return undefined;
}
/** Forget a run's departed descendants: its root parent closed, so nothing shows or revives them any more. */
function forgetDeparted(runId: string) {
	const gone = departed.get(runId);
	departed.delete(runId);
	for (const run of gone?.pi ?? []) forgetDeparted(run.id);
}

/** The owner of the children a delegating run started, once its session's delegation tools attached. */
export function childOwner(run: Run): Owner | undefined {
	for (const owner of state.owners.values()) if (owner.parentRun === run) return owner;
	return undefined;
}
/** A delegating child's own children end with its session, as a root parent's end with its own. */
async function closeChildOwner(run: Run) {
	const nested = childOwner(run);
	if (!nested) return;
	if (nested.detach) await nested.detach();
	else await closeOwner(nested);
}

/**
 * Cancel and timeout end a delegating run's whole subtree. Its unsettled descendants are cancelled,
 * not parked, so none of them runs on or revives it; then its children's owner closes. Its session,
 * whose delegation tools that owner served, closes once the run settles, and a restart reopens it
 * from the records.
 */
async function stopTree(run: Run) {
	const nested = childOwner(run);
	if (!nested) return;
	const mark = (owner: Owner) => {
		for (const child of ownedRuns(owner)) {
			if (child.foreign || child.completion.settled) continue;
			child.stopped = true;
			if (child.status === "running") child.status = "cancelled";
			try { saveRun(child); } catch { /* closing still stops it */ }
			const deeper = childOwner(child);
			if (deeper) mark(deeper);
		}
	};
	mark(nested);
	if (run.completion.settled) dropSession(run);
	else run.closeOnSettle = true;
	await closeChildOwner(run);
}

/** Close a settled run's session, keeping its activity readable. Revival opens a new one from the transcript. */
function dropSession(run: Run) {
	const session = run.session;
	if (!session) return;
	run.activityCache = { revision: run.revision, items: activityOf(run) };
	run.session = undefined;
	void closeSession(session);
}

/**
 * End a child's session. dispose() emits no session_shutdown, so without this its extensions never
 * learn it ended: MCP servers keep running, and a delegating child's own children stay bound to it.
 */
async function closeSession(session: any) {
	if (!session) return;
	try { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); }
	catch { /* the session is disposed regardless */ }
	try { session.dispose(); } catch { /* ignore */ }
}

export type Notice = { customType: "delegate"; content: string; display: boolean; details: unknown };
/** The user turn that stands in for removed delegation turns between two assistant messages in a fork. */
export const FORK_BRIDGE = "Continue.";
/** Shown on a run whose record predates trust recording. */
export const TRUST_UNKNOWN = "project trust unknown for this record; treated as untrusted";
/** The prompt that revives a delegating child after it reported, when one of its own children settles. */
export const CHILD_SETTLED_PROMPT = "A child you delegated has settled; its report is above. Continue your assignment from there, then end with your own final report.";

/**
 * Wake an owner with a completion. The root parent gets a follow-up that starts its turn. A
 * delegating child gets it through wakeChild, so it never starts a turn that its run does not track.
 */
function deliver(owner: Owner, message: Notice, retry: () => void) {
	if (!owner.binding || owner.closed) return;
	if (owner.parentRun) { wakeChild(owner.parentRun, message, retry); return; }
	// A run the person started with /delegate reports to them: shown, and in context for the next turn,
	// without spending a model turn on it.
	if ((message.details as any)?.userStarted) { owner.binding.pi.sendMessage(message, { triggerTurn: false }); return; }
	// A steer reaches the parent at once: an idle one starts a turn, and a busy one reads it at its next
	// model request, inside the run it is in. A follow-up would wait for that run to end, however long it runs.
	inFlight(owner).set(noticeKey(message), message);
	owner.binding.pi.sendMessage(message, { deliverAs: "steer", triggerTurn: true });
}

/** A notice's identity: its run and segment (an ACP run's turn count stands in for a segment). */
export const noticeKey = (message: Notice) => { const d = message.details as any; return `${d?.id}:${d?.segment ?? d?.turns?.length ?? ""}`; };
/**
 * Completion notices sent to the root parent and not yet in its conversation. Pi drops queued extension
 * messages when the person aborts the run (it clears its queues), so whatever is still here when the
 * run settles is sent again: see redeliver.
 */
const inFlightNotices = new WeakMap<Owner, Map<string, Notice>>();
export function inFlight(owner: Owner): Map<string, Notice> {
	let map = inFlightNotices.get(owner);
	if (!map) inFlightNotices.set(owner, map = new Map());
	return map;
}
/**
 * The parent's run settled with notices that never reached its conversation. After an abort they are
 * appended without a turn, shown and in context for the next prompt, as the person stopped the run;
 * otherwise they start the turn they were sent to start.
 */
export function redeliver(owner: Owner, aborted: boolean) {
	if (!inFlight(owner).size) return;
	// The conversation is the record: a notice it holds was delivered, whichever way it got there (a
	// directly appended message raises no extension event).
	const recorded = new Set((owner.binding?.ctx.sessionManager.getEntries() ?? [])
		.filter((entry: any) => entry.type === "custom_message" && entry.customType === "delegate")
		.map((entry: any) => noticeKey({ details: entry.details } as Notice)));
	const lost = [...inFlight(owner).values()].filter((message) => !recorded.has(noticeKey(message)));
	inFlight(owner).clear();
	if (!lost.length || !owner.binding || owner.closed) return;
	const { pi } = owner.binding;
	for (const message of lost) {
		if (!aborted) inFlight(owner).set(noticeKey(message), message);
		pi.sendMessage(message, aborted ? { triggerTurn: false } : { deliverAs: "steer", triggerTurn: true });
	}
}

const takesFollowUp = (run: Run) => run.status === "running" && !run.completion.settled && Boolean(run.session?.isStreaming);
/**
 * A completion for one of a delegating child's own children. Mid-turn, the child gets a follow-up,
 * as a root parent does. Opening or between turns, delivery waits until it streams or settles.
 * After it reported, the completion is kept in its transcript and the child is revived to act on
 * it, as an unjoined completion wakes a root parent. Its settled segment reports first.
 */
function wakeChild(run: Run, message: Notice, retry: () => void) {
	const session = run.session;
	if (!session || run.foreign) return; // Its session is gone; its children's owner closed with it.
	if (takesFollowUp(run)) { void session.sendCustomMessage(message, { deliverAs: "followUp", triggerTurn: true }); return; }
	if (!run.completion.settled) {
		const listener = () => {
			if (!run.completion.settled && !takesFollowUp(run)) return;
			listeners.delete(listener);
			retry();
		};
		listeners.add(listener);
		return;
	}
	setImmediate(() => {
		if (!run.completion.settled || run.session !== session) { retry(); return; }
		void session.sendCustomMessage(message, { triggerTurn: false });
		// A run stopped, cancelled or timed out is not revived with a fresh budget by its own children.
		const blocked = run.stopped ? "it was explicitly stopped" : run.status === "cancelled" ? "it was cancelled"
			: run.status === "timeout" ? "its last segment ran out of its time budget" : undefined;
		if (blocked) { lateReport(run, message, blocked); return; }
		const resume = state.owners.get(run.ownerKey)?.resume;
		if (!resume) { lateReport(run, message, "its parent's delegate runtime is not attached"); return; }
		resume(run, CHILD_SETTLED_PROMPT).catch((error) => lateReport(run, message, errorMessage(error)));
	});
}

/**
 * A child's report reached a delegating child that was not revived to act on it. The report is in
 * that child's transcript, but nothing would read it there, so its own owner is told which run, which
 * report, and why, with the report. An owner between bindings (a reload) gets it when it attaches.
 */
function lateReport(run: Run, message: Notice, why: string) {
	const owner = state.owners.get(run.ownerKey);
	if (!owner || owner.closed) return;
	const childRunId = (message.details as any)?.id;
	const notice: Notice = {
		customType: "delegate", display: true,
		content: `delegate late report: ${childRunId ?? "a child"} of ${run.id} settled after ${run.id} reported, and ${run.id} was not revived to act on it: ${why}. Its report is in ${run.id}'s transcript and below. Steer ${run.id} to act on it, or act on it yourself.\n\n${message.content}`,
		details: { kind: "late-report", runId: run.id, ...(childRunId ? { childRunId } : {}), reason: why },
	};
	if (!owner.binding) { (owner.pendingNotices ??= []).push(notice); return; }
	notify(owner, notice);
}

/** Deliver a notice to an owner, again each time delivery asks for a retry (a delegating child not ready for it yet). */
export function notify(owner: Owner, notice: Notice): void {
	const attempt = () => deliver(owner, notice, attempt);
	attempt();
}

/** A run's completion notice, either backend's: its report, and its details for the renderer and the receipt. */
export const finishedNotice = (report: string, details: unknown): Notice => ({ customType: "delegate", content: `delegate finished\n${report}`, display: true, details });

/**
 * An exception about a running run, told to its owner as one short notice by the completion path (notify). Advisory:
 * an owner between bindings, or a delegating child that is not mid-turn, goes without it, so an alert never revives one.
 */
function alert(run: Run, kind: "extend-request" | "watchdog", content: string) {
	const owner = state.owners.get(run.ownerKey);
	if (!owner?.binding || owner.closed || run.foreign) return;
	if (owner.parentRun && !takesFollowUp(owner.parentRun)) return;
	notify(owner, { customType: "delegate", display: true, content: `delegate alert: ${content}`,
		details: { kind, runId: run.id, ...(run.userStarted ? { userStarted: true } : {}) } });
}

/** The line a child ends its message with to ask for more time (the wrap-up steer tells it how). */
const EXTEND_LINE = /^EXTEND:\s*(\d+)\s*[-—:]?\s*(.*)$/m;
const MAX_EXTEND_MIN = 60;

/** Progress for health.ts from a child's session events, and an `EXTEND:` request in an assistant message, told to its owner. */
export function trackProgress(run: Run, ev: any, now = Date.now()) {
	if (ev.type === "tool_execution_start" || ev.type === "tool_execution_end") run.lastProgressAt = now;
	const assistant = ev.message?.role === "assistant";
	if (ev.type === "message_start" && assistant) run.turnStartedAt ??= now;
	if (ev.type !== "message_end") return;
	run.lastProgressAt = now;
	if (!assistant) return;
	run.turnStartedAt = undefined;
	const ask = EXTEND_LINE.exec(textOf(ev.message.content));
	const minutes = Math.min(MAX_EXTEND_MIN, Number(ask?.[1] ?? 0));
	if (!ask || !minutes || run.status !== "running") return;
	const reason = oneLine(ask[2] ?? "", 200);
	run.extendRequest = { minutes, reason, at: now };
	alert(run, "extend-request", `${run.id} asks +${minutes} min${reason ? `: ${reason}` : ""}. Grant with delegate_ctl steer runId=${run.id} timeoutMs=${minutes * 60_000} (time from now), or let it end.`);
}

const mins = (ms: number) => `${Math.round(ms / 60_000)}m`;
/**
 * When the child last showed life: its own events, or its session file being written. The file covers a run restored
 * after a reload (no events reach this process) and any gap in the events; it is what a person checks by hand.
 */
export function progressAt(run: Pick<Run, "lastProgressAt" | "sessionFile">): number | undefined {
	let at = run.lastProgressAt;
	try { if (run.sessionFile) at = Math.max(at ?? 0, statSync(run.sessionFile).mtimeMs); } catch { /* not written yet */ }
	return at;
}

/**
 * The watchdog's look at one run: a notice when it stops moving (retrying, looping, silent, no-artifact, browsing or
 * slow), once per verdict until it moves again. Exception-only: a moving run is never reported.
 */
export function healthAlert(run: Run, now = Date.now()) {
	const health = runHealth({ ...run, lastProgressAt: progressAt(run) }, now);
	if (health.verdict === "moving" || health.verdict === "settled") { run.alerted = undefined; return; }
	if (run.alerted?.includes(health.verdict)) return;
	(run.alerted ??= []).push(health.verdict);
	if (health.verdict === "browsing") {
		alert(run, "watchdog", `${run.id} browsing: ${BROWSE_CALLS} calls without an edit; send it the fact it is missing or ask for the deliverable now. Run ${budgetText(health)}.`);
		return;
	}
	const facts = [
		health.loop ? `same \`${health.loop.name}\` call ${health.loop.count}x` : "",
		health.verdict === "no-artifact" && health.dueAt !== undefined ? `no files written; first deliverable was due ${clock(health.dueAt)}` : "",
		health.verdict === "looping" || health.verdict === "no-artifact" ? "" : `no output for ${mins(health.sinceProgressMs ?? now - run.segmentStartedAt)}`,
		health.turnMs ? `turn open ${mins(health.turnMs)}` : "",
		run.providerRetry ? `provider retry ${run.providerRetry.attempt}/${run.providerRetry.maxAttempts} (${oneLine(run.providerRetry.errorMessage, 120)})` : "",
		budgetText(health),
	].filter(Boolean);
	alert(run, "watchdog", `${run.id} ${health.verdict}: ${facts.join(", ")}. Check it or steer.`);
}

const WATCH_MS = 30_000;
let watchdog: ReturnType<typeof setInterval> | undefined;
const watched = (r: Run) => r.status === "running" && !r.completion.settled && !r.foreign;
/** One interval for every running run of this process (healthAlert); it stops when none is running. Oven runs' progress comes from their watch (trackOven). */
function watch() {
	if (watchdog) return;
	watchdog = setInterval(() => {
		if (stopWatchdogIfIdle()) return;
		for (const run of [...runs.values()].filter(watched)) healthAlert(run);
	}, WATCH_MS);
	watchdog.unref?.();
}
/** Stop the watchdog the moment no run is running (a settle or a cancel); its tick only re-checks. True when it is stopped. */
function stopWatchdogIfIdle(): boolean {
	if (watchdog && ![...runs.values()].some(watched)) { clearInterval(watchdog); watchdog = undefined; }
	return !watchdog;
}

/** A pi run's saved fields: the run without what lives only in this process. */
export type RunRecord = Omit<Run, "completion" | "session" | "timer" | "wrapTimer" | "alerted" | "streamingMessage" | "activeTools" | "activityCache" | "dirtyBefore" | "ready" | "preparing" | "acknowledged" | "foreign" | "offered" | "closeOnSettle">;
/** Pi run records: each in the subsession directory of its working directory, found through its parent's pointers. */
const piStore = new RunStore<Run, RunRecord>({
	valid: (record) => typeof record.systemPrompt === "string" && Array.isArray(record.contextFiles) && Array.isArray(record.appendSystemPrompt) && Array.isArray(record.tools) &&
		typeof record.sessionId === "string" && Number.isInteger(record.segment) && typeof record.cwd === "string" && Array.isArray(record.toolCalls),
	revive: (record, path) => {
		// Parent message_end hooks run before Pi appends the message. Only its transcript
		// can establish durable delivery after a crash; never trust a saved in-memory acknowledgement.
		const run: Run = { ...record, recordPath: path, acknowledged: false, completion: new RunCompletion(), activeTools: new Map() };
		// Older records used the lifetime start as the implicit segment start. Keep them readable;
		// a subsequent resume always establishes a fresh segment start.
		run.segmentStartedAt ??= run.startedAt;
		run.segmentStartIdx ??= run.startIdx;
		run.segmentFailedAttempts ??= 0;
		run.segmentFailedAttemptsBase ??= Math.max(0, run.failedAttempts - run.segmentFailedAttempts);
		run.providerRetryMs ??= 0;
		run.depth ??= 1; // Records from before nesting are children of a root parent.
		// 0.2.0 kept a role's MCP opt-in apart from its tools: as tool patterns, every server's tools or the named servers'.
		const legacyMcp = (record as { mcp?: true | string[] }).mcp;
		if (legacyMcp) {
			run.tools = [...run.tools, ...(legacyMcp === true ? ["mcp__*"] : legacyMcp.flatMap((server) => [...new Set([`mcp__${server}__*`, `mcp__${server.replace(/-/g, "_")}__*`])]))];
			delete (run as { mcp?: unknown }).mcp;
		}
		// Records from before trust was recorded: nothing of the project is read, and the run says why.
		if (typeof run.projectTrusted !== "boolean") { run.projectTrusted = false; run.projectTrustUnknown = true; }
		run.projectTrustSource ??= "unknown";
		return run;
	},
	recover: (run, savedAt) => {
		if (run.status !== "running") return;
		run.status = "interrupted";
		run.endedAt = savedAt;
		run.error = run.runtime === "oven"
			? `The previous process ended before this execution settled. Its oven slice ${run.sliceId ?? "(not created yet)"} keeps running in oven, renewed while this session has the run (it expires ${OVEN_EXPIRES.idle} after the last call); steer to rejoin it.`
			: "The previous process ended before this execution settled. Inspect its saved work; send a message to continue.";
	},
	persisted: (run) => {
		const { completion, session, timer, wrapTimer, alerted, streamingMessage, activeTools, activityCache, dirtyBefore, ready, preparing, acknowledged, foreign, offered, closeOnSettle, ...record } = run;
		return record satisfies RunRecord;
	},
	foreignSave: "throw",
});
export function saveRun(run: Run): void { piStore.save(run, run.recordPath); }
function messagesOf(run: Run): any[] {
	if (!run.sessionFile) return [];
	const manager = run.session?.sessionManager ?? openTranscript(run);
	return manager.getEntries().filter((e: any) => e.type === "message").map((e: any) => e.message);
}
function openTranscript(run: Run): SessionManager {
	if (!run.sessionFile || !existsSync(run.sessionFile)) throw new Error(`${run.id}: saved transcript is missing; refusing to start a replacement.`);
	const manager = SessionManager.open(run.sessionFile);
	if (manager.getSessionId() !== run.sessionId) throw new Error(`${run.id}: transcript identity does not match its saved configuration.`);
	return manager;
}
export function finalResult(run: Run): RunResult {
	const details = { ...recordedView(run), settled: true as const, completionReceipt: true as const };
	// The result is the settlement record, not a snapshot of the waiter that received it.
	details.joinedWaiters = 0;
	return { content: [{ type: "text", text: resultText(run) }], details, isError: run.status !== "complete" };
}
export function restoreRun(path: string, owner: Owner): Run {
	const run = piStore.load(path, owner.key);
	// A foreign run's live owner is still running or delivering it: show a snapshot, never write or re-deliver it.
	if (!run.foreign) {
		try { harvest(run); }
		catch (error) { run.status = "error"; run.error = errorMessage(error); }
		saveRun(run);
	}
	run.completion.settle(finalResult(run));
	// Its parent has it again: its oven slice is renewed from now on.
	if (!run.foreign && run.runtime === "oven" && run.sliceId) beatOven();
	return run;
}

/** Dirty paths (tracked+untracked) → mtime, or undefined when cwd is not a git work tree. */
function snapshotDirty(cwd: string): Map<string, number> | undefined {
	let out: string;
	try {
		out = gitSync(cwd, "status", "--porcelain", "-uall", "-z");
	} catch {
		return undefined;
	}
	const m = new Map<string, number>();
	for (const rec of out.split("\0")) {
		if (rec.length < 4) continue;
		const p = rec.slice(3);
		let mtime = 0;
		try {
			mtime = statSync(join(cwd, p)).mtimeMs;
		} catch {
			/* deleted */
		}
		m.set(p, mtime);
	}
	return m;
}

function dirtyDelta(before: Map<string, number> | undefined, cwd: string): string[] | undefined {
	if (!before) return undefined;
	const after = snapshotDirty(cwd);
	if (!after) return undefined;
	const changed: string[] = [];
	for (const [p, mt] of after) if (!before.has(p) || before.get(p) !== mt) changed.push(p);
	for (const p of before.keys()) if (!after.has(p)) changed.push(p);
	return changed;
}

export function harvest(run: Run) {
	// An oven run has no transcript here: its output and turns come from oven (launchOven).
	if (run.runtime === "oven") return;
	const msgs = messagesOf(run);
	let turns = 0;
	const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	let cost = 0;
	const changed = new Set<string>(dirtyDelta(run.dirtyBefore, run.cwd) ?? []);
	const gitBacked = run.dirtyBefore !== undefined;
	let output = "";
	let failedAttempts = 0;
	let lastAttemptError: string | undefined;
	for (let i = run.startIdx; i < msgs.length; i++) {
		const m = msgs[i];
		if (m?.role !== "assistant") continue;
		// A failed request and its retries are attempts, not turns of work. Counting them as turns
		// made a provider stalling twice for five minutes look like a slow model thinking hard.
		if (m.stopReason === "error") { failedAttempts += 1; lastAttemptError = m.errorMessage || "unknown provider error"; }
		else if (m.stopReason !== "aborted") turns += 1;
		const u = m.usage;
		if (u) {
			tokens.input += u.input ?? 0;
			tokens.output += u.output ?? 0;
			tokens.cacheRead += u.cacheRead ?? 0;
			tokens.cacheWrite += u.cacheWrite ?? 0;
			cost += u.cost?.total ?? 0;
		}
		let text = "";
		for (const b of m.content ?? []) {
			if (b?.type === "text") text += b.text;
			if (!gitBacked && b?.type === "toolCall" && (b.name === "edit" || b.name === "write")) {
				const p = b.arguments?.path ?? b.arguments?.file_path;
				if (typeof p === "string") changed.add(p);
			}
		}
		// A resumed segment may fail before producing text. Do not re-report the last
		// completed segment as if it were the current attempt's report.
		if (i >= run.segmentStartIdx && text.trim()) output = text;
	}
	run.turns = turns;
	run.failedAttempts = failedAttempts;
	run.segmentFailedAttempts = Math.max(run.segmentFailedAttempts, Math.max(0, failedAttempts - run.segmentFailedAttemptsBase));
	run.lastAttemptError = lastAttemptError;
	run.tokens = tokens;
	run.cost = cost;
	run.changedFiles = [...changed].sort();
	run.output = output.length > OUTPUT_CAP ? `${output.slice(0, OUTPUT_CAP)}\n…[truncated ${output.length - OUTPUT_CAP} chars]` : output;
}

const MAX_TOOL_CALLS = 200;

export function view(run: Run): RunView {
	const taskDurationMs = (run.status === "running" ? Date.now() : (run.endedAt ?? Date.now())) - run.segmentStartedAt;
	return {
		id: run.id,
		segment: run.segment,
		stopped: run.stopped,
		settled: run.completion.settled,
		role: run.role,
		model: run.model,
		cwd: run.cwd,
		thinking: run.thinking,
		context: run.context,
		forkedMessages: run.forkedMessages,
		contextWindow: run.contextWindow,
		status: run.status,
		task: run.task,
		output: run.output,
		turns: run.turns,
		tokens: run.tokens,
		cost: run.cost,
		// The UI and tool details describe the current task, not the persistent run lifetime.
		// `segmentDurationMs` remains as a compatibility alias for consumers of older details.
		durationMs: taskDurationMs,
		segmentDurationMs: taskDurationMs,
		changedFiles: run.changedFiles,
		droppedTools: run.droppedTools,
		failedAttempts: run.failedAttempts,
		lastAttemptError: run.lastAttemptError,
		providerRetryMs: run.providerRetryMs,
		...(run.providerRetry ? { providerRetry: run.providerRetry } : {}),
		toolCalls: run.toolCalls,
		activeTool: run.activeTools.values().next().value,
		joinedWaiters: run.completion.waiting,
		revision: run.revision,
		lastTool: run.lastTool,
		error: run.error,
		sessionFile: run.sessionFile,
		depth: run.depth,
		...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
		...(run.endedAt ? { endedAt: run.endedAt } : {}),
		...(run.userStarted ? { userStarted: true as const } : {}),
	};
}

// The SDK retains result objects in its session tree. Published facts must not
// share mutable arrays/objects with a child that is still running or later resumed.
export function recordedView(run: Run): RunView {
	return structuredClone(view(run));
}

export function summary(run: Run): string {
	const dur = (run.status === "running" ? Date.now() : (run.endedAt ?? Date.now())) - run.segmentStartedAt;
	const parts = [
		`${run.status} · ${run.id}`,
		`role ${run.role}`,
		`model ${run.model}${run.thinking ? `:${run.thinking}` : ""}`,
		run.context === "fork" ? `context forked from ${run.forkedMessages ?? 0} parent messages` : "context fresh",
		`${run.turns} turn${run.turns === 1 ? "" : "s"} · ${formatDuration(dur)} current task`,
		`tokens in ${formatTokens(run.tokens.input)}, out ${formatTokens(run.tokens.output)}` +
			(run.tokens.cacheRead ? `, cached ${formatTokens(run.tokens.cacheRead)}` : ""),
		run.cost ? `$${run.cost.toFixed(4)}` : "",
	].filter(Boolean);
	let s = parts.join(" · ");
	if (run.providerRetry) {
		const elapsed = Math.max(0, Date.now() - run.providerRetry.startedAt);
		s += `\nprovider retrying · retry ${run.providerRetry.attempt}/${run.providerRetry.maxAttempts} · backoff ${run.providerRetry.delayMs}ms · ${formatDuration(elapsed)} elapsed (last: ${run.providerRetry.errorMessage})`;
	}
	if (run.providerRetryMs) s += `\nprovider retry wall ${formatDuration(run.providerRetryMs)}; separate from task and tool time.`;
	if (run.failedAttempts) s += `\n${run.failedAttempts} provider attempt${run.failedAttempts === 1 ? "" : "s"} failed and were retried before this (last: ${run.lastAttemptError}) — that wall clock and any tokens are included above.`;
	if (run.heartbeatError) s += `\noven heartbeat failed: ${run.heartbeatError}`;
	if (run.modelPick) s += `\nmodel picked: ${run.modelPick}`;
	if (run.sessionFile) s += `\nsession: ${run.sessionFile}`;
	s += `\nproject ${run.projectTrusted ? "trusted" : "untrusted"} (trust source: ${run.projectTrustSource})`;
	if (run.projectTrustUnknown) s += `\n${TRUST_UNKNOWN}`;
	if (run.parentRunId) s += `\nstarted by ${run.parentRunId} · depth ${run.depth} of ${maxDepth()}`;
	if (run.extensionErrors?.length) s += `\nextensions that failed in the child (it ran without them):\n  ${run.extensionErrors.join("\n  ")}`;
	if (run.droppedTools.length) s += `\ntools the child could not have (a child gets the tools its parent's extensions and MCP tools provide, limited to its role's tools; no delegate or delegate_ctl at the depth limit, ${maxDepth()}; no todo): ${run.droppedTools.join(", ")}`;
	if (run.changedFiles.length) s += `\nchanged: ${run.changedFiles.join(", ")}`;
	if (run.error) s += `\nerror: ${run.error}`;
	return s;
}

/** The child's words are quoted, never blended into this tool's own reporting. */
export function resultText(run: Run): string {
	const report = run.output || `(no final report was produced in segment ${run.segment}; an earlier segment's report is not repeated)`;
	return `${summary(run)}\n\n----- ${run.id} reported for segment ${run.segment}, verbatim -----\n${report}\n----- end of report -----`;
}

function log(run: Run) {
	try {
		mkdirSync(dirname(LOG_FILE), { recursive: true });
		const { session: _s, timer: _t, wrapTimer: _w, activityCache: _a, streamingMessage: _m, activeTools: _tools, completion: _completion, ready: _ready, systemPrompt: _prompt, contextFiles: _context, appendSystemPrompt: _append, offered: _offered, closeOnSettle: _close, ...rest } = run;
		appendFileSync(LOG_FILE, `${JSON.stringify({ ...rest, output: run.output.slice(0, 2000), ts: Date.now() })}\n`);
	} catch {
		/* logging must never fail the run */
	}
}

function retire(keep: Run) {
	// A delegating child's children report into its session. It is retired only once they are all
	// settled and delivered; its children's owner closes first, and a revival restores them from records.
	const idle = (r: Run) => { const nested = childOwner(r); return !nested || (!nested.busy?.() && !nested.queued.size && !nested.pendingNotices?.length); };
	const finished = [...runs.values()].filter((r) => r.ownerKey === keep.ownerKey && r !== keep && r.session && r.completion.settled && idle(r));
	finished.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
	while (finished.length > MAX_RETAINED_SESSIONS - 1) {
		const r = finished.shift()!;
		if (childOwner(r)) void closeChildOwner(r).finally(() => dropSession(r));
		else dropSession(r);
	}
}

/** What a timed-out run left, read off the run without a model call: its last words, changes, last tools, and how to resume it. */
export function salvage(run: Run): string {
	const said = run.output || textOf(run.streamingMessage?.content);
	const arg = (args: Record<string, unknown>) => oneLine(String(args.command ?? args.path ?? args.file_path ?? args.pattern ?? Object.values(args).find((v) => typeof v === "string") ?? ""), 80);
	return [
		"Salvage:",
		said.trim() ? `last words: ${said.trim().slice(0, 600)}` : "last words: (none)",
		run.changedFiles.length ? `changed: ${run.changedFiles.join(", ")}` : "",
		run.toolCalls.length ? `last tools: ${run.toolCalls.slice(-5).map((call) => `${call.name} ${arg(call.args)}`.trim()).join("; ")}` : "",
		`Resume: delegate_ctl steer runId=${run.id} timeoutMs=<ms from now> message=<what remains>`,
	].filter(Boolean).join("\n");
}

function disarm(run: Run) {
	clearTimeout(run.timer);
	clearTimeout(run.wrapTimer);
	run.timer = run.wrapTimer = undefined;
}

function finish(run: Run, status: Status, error?: string) {
	if (run.completion.settled) return;
	disarm(run);
	if (run.providerRetry) {
		run.providerRetryMs += Math.max(0, Date.now() - run.providerRetry.startedAt);
		run.providerRetry = undefined;
	}
	run.turnStartedAt = undefined;
	run.endedAt = Date.now();
	run.status = status;
	if (error) run.error = error;
	try { if (run.session) harvest(run); }
	catch (e) { run.status = "error"; run.error = `Cannot read child transcript: ${errorMessage(e)}`; }
	if (run.status === "timeout" && !run.error) {
		run.error = `Stopped after its ${Math.round(run.timeoutMs / 60000)} min budget (timeoutMs, default ${DEFAULT_TIMEOUT_MS / 60000} min). Its work up to that point stands and is not rolled back.`
			+ (run.segmentFailedAttempts
				? ` Most of this segment's budget went to ${run.segmentFailedAttempts} failed provider attempt${run.segmentFailedAttempts === 1 ? "" : "s"} and retries (last: ${run.lastAttemptError}), not to the work \u2014 investigate that provider or choose another offering before granting more time.`
				: ` Give it a larger timeoutMs only if the work genuinely needs longer.`)
			+ `\n${salvage(run)}`;
	}
	run.activeTools.clear();
	run.streamingMessage = undefined;
	// What the role listed that its session never offered. MCP tools register as their servers connect, so this waits for the settle.
	if (run.offered) run.droppedTools = droppedTools(run.tools, run.offered, run.withheld);
	run.revision++;
	try { saveRun(run); }
	catch (e) { run.status = "error"; run.error = `Could not persist completion: ${errorMessage(e)}`; }
	log(run);
	retire(run);
	if (run.closeOnSettle) { run.closeOnSettle = false; dropSession(run); }
	run.completion.settle(finalResult(run));
	stopTimersIfIdle();
	milestone(run, { kind: "settled", status: run.status, changedFiles: run.changedFiles.slice(0, 20) });
	changed();
}

export async function cancelRun(run: Run) {
	if (run.foreign) throw ownedElsewhereError(run);
	run.stopped = true;
	if (run.status === "running") run.status = "cancelled";
	stopTimersIfIdle();
	try { saveRun(run); }
	// The subtree is marked stopped before the abort can settle this run, so nothing below revives it.
	finally { changed(); await Promise.all([stopTree(run), run.session?.abort(), haltSlice(run)]); }
}

/** What a cancel tells its caller: "stopped" only when oven confirmed the halt (or the run holds no slice). */
export const cancelText = (run: Run) => run.haltNote
	? `${run.id} cancel sent; oven did not confirm the halt: ${run.haltNote}. Automatic revival is disabled.`
	: `${run.id} stopped; automatic revival is disabled.`;

/**
 * End an oven run's slice's work (oven_halt), whatever stage it is in; its conversation and copy stay in oven. A tui slice is
 * also stopped, so no idle TUI is left running; a steer wakes it on the same session. Oven's answer is checked: a failed
 * halt, or a slice still reported running, is kept in run.haltNote for the cancel's reply, never hidden.
 */
async function haltSlice(run: Run) {
	ovenWatches.get(run.id)?.abort();
	run.haltNote = undefined;
	if (run.runtime !== "oven") return;
	if (!run.sliceId) {
		// Oven's create has not answered, so the slice id is unknown: launchOven halts the slice the moment it is told.
		if (run.status === "cancelled") run.haltNote = "oven has not yet returned this run's slice id, so no halt could be sent; it is halted when oven answers";
		return;
	}
	try {
		const view = await ovenCall<SliceView | undefined>("halt", { slice: run.sliceId });
		if (view?.state === "running") run.haltNote = `oven answered the halt but still reports slice ${run.sliceId} running${view.stage ? ` (stage ${view.stage})` : ""}`;
	} catch (error) { run.haltNote = errorMessage(error); }
	if (run.tui) await ovenCall("stop", { slice: run.sliceId }).catch((error) => { run.haltNote ??= `stop failed: ${errorMessage(error)}`; });
}

/** The values of a tui run's declared secrets, from this process's environment; oven keeps them out of argv and records. */
function tuiSecrets(run: Run): Record<string, string> | undefined {
	const names = Array.isArray(run.template?.secrets) ? run.template.secrets as string[] : [];
	if (!names.length) return undefined;
	const missing = names.filter((name) => !process.env[name]);
	if (missing.length) throw new Error(`role ${run.role} declares secret${missing.length > 1 ? "s" : ""} ${missing.join(", ")}, not set in this session's environment`);
	return Object.fromEntries(names.map((name) => [name, process.env[name]!]));
}

/** The watch call each oven run is following, so a cancel ends it. */
const ovenWatches = new Map<string, AbortController>();

export { ovenHeartbeat };
let heartbeat: ReturnType<typeof setInterval> | undefined;
/** The oven runs this process keeps alive: its own, with a slice, neither cancelled nor expired, running or settled. */
const kept = (run: Run) => run.runtime === "oven" && !!run.sliceId && !run.foreign && !run.stopped && run.status !== "expired";
/**
 * One interval for every oven run this process keeps: each beat is oven_expires with no expires, which starts the slice's
 * idle window again, so a settled run (a stopped tui agent between segments) is still there for its next steer. A run
 * stops being renewed when it is cancelled or expires, or its parent closes it (closeOwner) or dies, and then its slice
 * expires on its own. A failed beat is noted on the run (status shows it), never fatal; an expired slice expires the run.
 */
function beatOven() {
	if (heartbeat) return;
	heartbeat = setInterval(() => {
		if (stopHeartbeatIfIdle()) return;
		for (const run of [...runs.values()].filter(kept)) {
			ovenCall("expires", { slice: run.sliceId! }).then(() => { run.heartbeatError = undefined; }, (error) => {
				if (error instanceof SliceExpired) { if (kept(run)) expireRun(run, error); return; }
				run.heartbeatError = `${new Date().toISOString()}: ${errorMessage(error)}`;
			});
		}
	}, ovenHeartbeat.everyMs);
	heartbeat.unref?.();
}
/**
 * Stop the heartbeat the moment no run is kept: every path that ends one (finish, cancelRun, expireRun, closeOwner, a
 * refused create) calls it. Its tick only re-checks, as a safety net. True when it is stopped.
 */
function stopHeartbeatIfIdle(): boolean {
	if (heartbeat && ![...runs.values()].some(kept)) { clearInterval(heartbeat); heartbeat = undefined; }
	return !heartbeat;
}
/** A run ended, or stopped being kept: stop whichever process-wide interval has nothing left to do. */
function stopTimersIfIdle() { stopHeartbeatIfIdle(); stopWatchdogIfIdle(); }

/** The run's slice was retired (an oven that ignores expiry made it): nothing renews or sends to it again, and a steer starts over with a create. */
function forgetSlice(run: Run) {
	run.sliceId = undefined;
	saveRun(run);
	stopTimersIfIdle();
}

/**
 * The run's slice expired. A running run's segment ends as expired, with oven's words, once its watch is let go; a
 * settled run is marked expired at once.
 */
function expireRun(run: Run, error: SliceExpired) {
	run.status = "expired";
	run.error = expiredText(run, error);
	stopTimersIfIdle();
	if (!run.completion.settled) { ovenWatches.get(run.id)?.abort(); return; }
	run.revision++;
	try { saveRun(run); } catch { /* the record keeps its last outcome; this process knows */ }
	changed();
}
const expiredText = (run: Run, error: SliceExpired) =>
	`${run.id}: its oven slice expired, so it cannot continue; start a new run for more work. oven: ${error.message}`;

/**
 * Progress for health.ts from one oven_watch event, as trackProgress reads an in-process child's session events: a
 * streaming answer opens a turn, a finished message closes it (and may carry an `EXTEND:` line), a tool call's start and
 * end count as progress and its start is recorded as a tool call. A successful edit or write adds its path to
 * changedFiles (a path in the slice's copy). A snapshot or state event carries the slice's turn count.
 */
/** What a slice view carries beyond its turn count, when this oven reports it: a pending retry, token usage, changed files. */
export function applySlice(run: Run, slice: SliceView | undefined, now = Date.now()) {
	if (!slice) return;
	if (Number.isInteger(slice.turns)) run.turns = slice.turns;
	if (slice.stage === "retrying" && slice.retry) {
		const { attempt, of, at, error } = slice.retry;
		run.providerRetry = { attempt, maxAttempts: of, delayMs: Math.max(0, at - now), errorMessage: error ?? slice.detail ?? "retrying", startedAt: run.providerRetry?.startedAt ?? now };
	} else if (run.providerRetry) run.providerRetry = undefined;
	if (slice.usage) {
		run.tokens = { input: slice.usage.input ?? run.tokens.input, output: slice.usage.output ?? run.tokens.output, cacheRead: slice.usage.cacheRead ?? run.tokens.cacheRead, cacheWrite: slice.usage.cacheWrite ?? run.tokens.cacheWrite };
		if (slice.usage.cost !== undefined) run.cost = slice.usage.cost;
	}
	if (slice.changedFiles) run.changedFiles = [...new Set([...run.changedFiles, ...slice.changedFiles])].sort();
}

export function trackOven(run: Run, event: any, now = Date.now()) {
	if (run.status !== "running" || !event) return;
	switch (event.type) {
		case "snapshot":
		case "state":
			applySlice(run, event.slice, now);
			if (event.type === "snapshot") {
				if (event.partial) trackProgress(run, { type: "message_start", message: { role: "assistant" } }, now);
				const open = (event.tools ?? []).filter((t: any) => t.status === "running");
				for (const t of open) run.activeTools.set(t.callId, { name: t.name, args: t.args ?? {} });
				if (open.length) run.lastTool = open.at(-1).name;
			}
			break;
		case "partial":
			if (run.turnStartedAt !== undefined) return; // The answer streaming on: nothing new for health.
			trackProgress(run, { type: "message_start", message: { role: "assistant" } }, now);
			break;
		case "message":
			trackProgress(run, { type: "message_end", message: event.message ?? {} }, now);
			if (Number.isInteger(event.turns)) run.turns = event.turns;
			else if (event.message?.role === "assistant") run.turns++;
			break;
		case "tool": {
			const tool = event.tool;
			if (!tool?.callId) return;
			if (tool.status === "running") {
				if (run.activeTools.has(tool.callId)) return; // Its output printing on.
				const args = (tool.args ?? {}) as Record<string, unknown>;
				run.activeTools.set(tool.callId, { name: tool.name, args });
				run.lastTool = tool.name;
				{ run.toolCalls.push({ name: tool.name, args, at: now }); if (run.toolCalls.length > MAX_TOOL_CALLS) run.toolCalls.shift(); }
				trackProgress(run, { type: "tool_execution_start" }, now);
			} else {
				const args = (run.activeTools.get(tool.callId)?.args ?? tool.args ?? {}) as Record<string, unknown>;
				run.activeTools.delete(tool.callId);
				const path = args.path ?? args.file_path;
				if (!tool.isError && (tool.name === "edit" || tool.name === "write") && typeof path === "string" && !run.changedFiles.includes(path))
					run.changedFiles = [...run.changedFiles, path].sort();
				trackProgress(run, { type: "tool_execution_end" }, now);
			}
			break;
		}
		default: return;
	}
	run.revision++;
	changed();
}

/**
 * Follow an oven run's slice until it settles: oven_watch, whose result is the settled event the moment the
 * slice is done. When the call drops (oven restarted, network), it is made again after a short pause, for as
 * long as the run is running; a cancel or the run's timeout (armTimeout) ends it.
 */
async function settleOven(run: Run): Promise<SliceView> {
	for (let attempt = 0; ; attempt++) {
		const abort = new AbortController();
		ovenWatches.set(run.id, abort);
		try {
			const settled = await ovenCall<Settled>("watch", { slice: run.sliceId! }, { signal: abort.signal, onEvent: (event) => trackOven(run, event) });
			const expired = expiredEvent(run.sliceId!, settled);
			if (expired) throw expired;
			return { ...settled.slice, output: settled.output };
		} catch (error) {
			// A slice that expired or is gone never comes back: no retry.
			if (run.status !== "running" || error instanceof SliceExpired || error instanceof SliceGone) throw error;
			await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * (attempt + 1), 5000)));
		} finally { ovenWatches.delete(run.id); }
	}
}

const failure = (slice: SliceView) => `oven slice ${slice.id} ${slice.state}${slice.reason ? ` (${slice.reason})` : ""}${slice.detail ? `: ${slice.detail}` : ""}`;

/**
 * One segment of an oven run: the first creates the slice from the run's role configuration in a copy of its
 * cwd, a later one sends the message to it, each with a requestId stable for the run and segment so a retry
 * never starts a second slice or turn. Then it follows the slice until it settles and settles the run like
 * an in-process child's.
 */
export async function launchOven(run: Run, task: string) {
	if (run.tui) return launchTui(run, task);
	try {
		milestone(run, { kind: "started", task: task.slice(0, 600) });
		beginSegment(run);
		if (!run.sliceId) {
			const config = { name: run.role, instructions: run.systemPrompt, model: run.model, ...(run.thinking ? { thinking: run.thinking } : {}),
				...(run.extensions?.length ? { extensions: run.extensions } : {}), ...(run.tools.includes("*") ? {} : { tools: run.tools }) };
			const created = await ovenCall<SliceView>("create", { config, task, cwd: run.cwd, requestId: `pi-delegate:${run.id}`, expires: OVEN_EXPIRES });
			run.sliceId = created.id;
			saveRun(run);
			// Cancelled while oven was still creating (copying): halt the slice now that its id is known.
			if (run.stopped) { await haltSlice(run); finish(run, run.status); return; }
			await requireExpiry(created, ovenCall, () => forgetSlice(run));
			if (created.state === "failed") { finish(run, "error", failure(created)); return; }
		} else await ovenCall("send", { slice: run.sliceId, text: task, requestId: `pi-delegate:${run.id}:${run.segment}` });
		beatOven();
		const slice = await settleOven(run);
		if (run.status !== "running") { await haltSlice(run); finish(run, run.status); return; }
		applySlice(run, slice);
		run.output = `${slice.output ?? ""}\n\n(oven slice ${run.sliceId}; its changes are in its copy, ${slice.cwd})`;
		finish(run, slice.state === "idle" ? "complete" : "error", slice.state === "idle" ? undefined : failure(slice));
	} catch (e: any) {
		if (e instanceof SliceExpired && run.status === "running") { finish(run, "expired", expiredText(run, e)); return; }
		finish(run, run.status === "running" ? "error" : run.status, run.error ?? errorMessage(e));
	}
}

/** What oven reports for a tui slice. */
interface TuiSliceView { id: string; kind: "tui"; state: "starting" | "running" | "idle" | "stopped"; status: { state: string; msg?: string }; process: { state: string; code?: number }; cwd: string; session: string; attach?: { command: string }; expires?: unknown }

/** Health progress from a tui slice's status: working opens a turn, rest after it closes one. */
export function trackTui(run: Run, event: any, now = Date.now()) {
	if (run.status !== "running" || event?.type !== "status") return;
	const state = event.status?.state;
	if (state === "working" || state === "blocked") { if (run.turnStartedAt !== undefined) return; trackProgress(run, { type: "message_start", message: { role: "assistant" } }, now); }
	else if (state === "done" || state === "idle" || state === "error") { if (run.turnStartedAt === undefined) return; trackProgress(run, { type: "message_end", message: { role: "assistant" } }, now); run.turns++; }
	else return;
	run.revision++;
	changed();
}

/** Follow a tui slice until it settles, as settleOven does a durable one; the call is made again when it drops. */
async function settleTui(run: Run): Promise<TuiSliceView> {
	for (let attempt = 0; ; attempt++) {
		const abort = new AbortController();
		ovenWatches.set(run.id, abort);
		try {
			const settled = await ovenCall<{ type: "settled"; view: TuiSliceView }>("watch", { slice: run.sliceId! }, { signal: abort.signal, onEvent: (event) => trackTui(run, event) });
			const expired = expiredEvent(run.sliceId!, settled);
			if (expired) throw expired;
			if (settled?.view) return settled.view;
			return await ovenCall<TuiSliceView>("status", { slice: run.sliceId! });
		} catch (error) {
			if (run.status !== "running" || error instanceof SliceExpired || error instanceof SliceGone) throw error;
			await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * (attempt + 1), 5000)));
		} finally { ovenWatches.delete(run.id); }
	}
}

/**
 * One segment of a tui run: the first creates the agent's TUI in oven from the run's template, in a copy of
 * its cwd; a later one sends the message, which wakes the stopped agent on the same session. Each has a
 * requestId stable for the run and segment. When the turn settles, the answer is read from the agent's own
 * record (oven_result) and the agent is stopped, so no idle TUI is left running between segments.
 */
async function launchTui(run: Run, task: string) {
	try {
		milestone(run, { kind: "started", task: task.slice(0, 600) });
		beginSegment(run);
		if (!run.sliceId) {
			const secrets = tuiSecrets(run);
			const created = await ovenCall<TuiSliceView>("create", { agent: run.tui, template: run.template, ...(run.modelOverride ? { model: run.modelOverride } : {}), ...(secrets ? { secrets } : {}),
				task: run.taskPrefix ? `${run.taskPrefix}\n\n---\n\n${task}` : task, cwd: run.cwd, copy: "cow", requestId: `pi-delegate:${run.id}`, expires: OVEN_EXPIRES });
			run.sliceId = created.id;
			saveRun(run);
			if (run.stopped) { await haltSlice(run); finish(run, run.status); return; }
			await requireExpiry(created, ovenCall, () => forgetSlice(run));
		} else await ovenCall("send", { slice: run.sliceId, text: task, requestId: `pi-delegate:${run.id}:${run.segment}` });
		beatOven();
		const view = await settleTui(run);
		if (run.status !== "running") { await haltSlice(run); finish(run, run.status); return; }
		const output = await ovenCall<string>("result", { slice: run.sliceId! });
		await ovenCall("stop", { slice: run.sliceId! }).catch(() => {});
		const failed = view.process.state !== "running" ? `${run.tui} exited${view.process.code !== undefined ? ` (${view.process.code})` : ""}`
			: view.status.state === "error" ? `${run.tui} reported an error${view.status.msg ? `: ${view.status.msg}` : ""}` : undefined;
		run.output = `${output ?? ""}\n\n(oven ${run.tui} slice ${run.sliceId}; its changes are in its copy, ${view.cwd}; oven attach ${run.sliceId} shows its terminal)`;
		finish(run, failed ? "error" : "complete", failed ? `oven ${run.tui} slice ${run.sliceId}: ${failed}` : undefined);
	} catch (e: any) {
		// An expired slice is gone: nothing is left to stop.
		if (e instanceof SliceExpired && run.status === "running") { finish(run, "expired", expiredText(run, e)); return; }
		// A real failure stops the agent; a cancel (the aborted watch lands here too) leaves that to haltSlice, which halts first.
		if (run.sliceId && run.status === "running") await ovenCall("stop", { slice: run.sliceId }).catch(() => {});
		finish(run, run.status === "running" ? "error" : run.status, run.error ?? errorMessage(e));
	}
}

export function publish(completion: RunCompletion<RunResult>) {
	if (completion.claimed) return;
	const result = completion.result;
	const run = runs.get(result.details.id);
	if (!run || run.segment !== result.details.segment || run.acknowledged) return;
	if (run.foreign) return; // Its owner delivers it.
	const owner = state.owners.get(run.ownerKey);
	if (!owner?.binding || owner.closed) return;
	const key = `${run.id}:${run.segment}`;
	if (owner.queued.has(key)) return;
	owner.queued.add(key);
	try {
		deliver(owner, finishedNotice(result.content[0].text, result.details),
			() => { owner.queued.delete(key); publish(completion); });
	} catch (error) { owner.queued.delete(key); throw error; }
}

export function acknowledge(owner: Owner, details: any) {
	// A several-run wait delivers each settled pi run it reports, with that run's own receipt.
	if (details?.kind === "runs" && Array.isArray(details.rows)) { for (const row of details.rows) acknowledge(owner, row); return; }
	const run = details?.id ? runs.get(details.id) : undefined;
	if (!run || !details.completionReceipt || run.ownerKey !== owner.key || details.status === "running" || details.segment !== run.segment || run.acknowledged) return;
	run.acknowledged = true;
	owner.queued.delete(`${run.id}:${run.segment}`);
}

/** One run in a wait report: its full report once settled, its one-line summary while pending. */
export interface WaitRow { id: string; settled: boolean; report: string; summary: string; details: any; bad: boolean }

/**
 * pi runs held by one wait (wait.ts). Each run's current segment is joined through its completion, so a segment that
 * settles while joined is claimed by the wait instead of waking the parent; the row is that segment's own result. A
 * run whose status turned terminal without settling for two polls stopped without reporting completion (a failure
 * path that set its status and never finished): the wait reports it instead of waiting out its budget. A release
 * after an abort reports nothing, so a segment the wait claimed as it settled still wakes the parent.
 */
function piJoin(joined: readonly Run[]): Join<WaitRow> {
	let wake: (() => void) | undefined;
	const entries = joined.map((run) => ({ run, completion: run.completion, settledAtJoin: run.completion.settled, unsubscribe: run.completion.subscribe(() => wake?.()) }));
	const stoppedSince = new Map<string, number>();
	let released = false;
	return {
		views: () => entries.map(({ run, completion }) => {
			if (!completion.settled) return { id: run.id, settled: false, view: { id: run.id, settled: false, report: resultText(run), summary: summary(run), details: recordedView(run), bad: false } };
			const result = completion.result;
			return { id: run.id, settled: true, view: { id: run.id, settled: true, report: result.content[0].text, summary: summary(run), details: result.details, bad: result.isError } };
		}),
		// A settle wakes the wait at once; otherwise the slice ends it.
		next: (_pending, ms) => new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => { wake = undefined; resolve(true); }, ms);
			wake = () => { clearTimeout(timer); wake = undefined; resolve(true); };
		}),
		stranded: () => {
			for (const { run, completion } of entries) {
				if (run.status === "running" || completion.settled) { stoppedSince.delete(run.id); continue; }
				const since = stoppedSince.get(run.id);
				if (since === undefined) stoppedSince.set(run.id, Date.now());
				else if (Date.now() - since >= 2 * WAIT_POLL_MS) return run.id;
			}
			return undefined;
		},
		// Claimed already: a segment that settles while subscribed is the wait's (RunCompletion.settle).
		claim: (settled) => [...settled],
		release: (aborted) => {
			if (released) return;
			released = true;
			wake?.();
			for (const entry of entries) {
				entry.unsubscribe();
				if (aborted && !entry.settledAtJoin && entry.completion.settled && entry.completion.claimed && entry.run.completion === entry.completion) {
					entry.completion.claimed = false;
					publish(entry.completion);
				}
			}
		},
	};
}

export async function closeOwner(owner: Owner) {
	owner.binding = undefined;
	owner.closed = true;
	// A delegating child's runs outlive its session in the root's view; a root's take its whole tree along.
	const closing = ownedRuns(owner);
	if (owner.parentRun) departed.set(owner.parentRun.id, { pi: closing.filter((run) => !run.foreign), acp: departed.get(owner.parentRun.id)?.acp ?? [] });
	await Promise.all(ownedRuns(owner).map(async (run) => {
		if (!run.foreign) {
			await closeChildOwner(run);
			if (!run.completion.settled) {
				if (run.status === "running") run.status = "interrupted";
				await run.session?.abort();
				await run.completion.wait();
			}
			await closeSession(run.session);
			// Release ownership so the next process to open this parent adopts it.
			releaseOwner(run);
			try { saveRun(run); } catch { /* the record stays with its last owner; a dead owner is adopted anyway */ }
		}
		runs.delete(run.id);
		stopTimersIfIdle();
	}));
	state.owners.delete(owner.key);
	// After its children's sessions closed (each kept its runs above): a root's tree goes with it.
	if (!owner.parentRun) for (const run of closing) forgetDeparted(run.id);
}

/**
 * The user's limit on runs running at once (`maxConcurrent`), across every parent in this process and
 * both backends, grandchildren included. Over it, a start or revival is refused, never queued: a queued
 * child would make a background launch's "running" untrue, and the caller can wait for one to finish.
 */
export function capacityError(): DelegateError | undefined {
	const limit = readDelegateSettings(SETTINGS_PATH).maxConcurrent;
	if (!limit) return undefined;
	const pi = [...runs.values()].filter((r) => !r.foreign && !r.completion.settled).length;
	const running = pi + runningAcpRuns();
	if (running < limit) return undefined;
	return new DelegateError("CONCURRENCY_LIMIT", `${running} runs are already running, the limit set in /delegate settings is ${limit}. Wait for one to finish (delegate_ctl wait), then start this one; nothing was started.`);
}
/** Refuse a start or revival over the limit (capacityError). */
export function admit(): void {
	const full = capacityError();
	if (full) throw full;
}

/** The unsettled writer in `cwd`, other than `except`: one writer per working directory. */
export const activeWriter = (cwd: string, except?: Run): Run | undefined =>
	[...runs.values()].find((r) => r !== except && !r.completion.settled && r.writer && r.cwd === cwd);

/** The steer a child gets when `leftMs` of its budget remain. */
export const wrapUpMessage = (leftMs: number) => `${Math.round(leftMs / 60_000)} min left in your budget. Stop starting new work, restore anything you changed temporarily, and write your final report now. If you genuinely need more time, end your message with one line: EXTEND: <minutes> - <reason>.`;

/** Put a message into a running run's live work: its session's turn, or its oven slice's running work. */
async function steerLive(run: Run, message: string) {
	if (run.runtime === "oven") await ovenCall("send", { slice: run.sliceId!, text: message, steer: true, requestId: `pi-delegate:${run.id}:steer:${randomUUID()}` });
	else await run.session?.steer(message);
}

/** A segment's clock starts: its budget, and its progress for the watchdog, count from now. */
function beginSegment(run: Run) {
	run.segmentStartedAt = run.lastProgressAt = Date.now();
	run.turnStartedAt = run.alerted = run.extendRequest = undefined;
	armTimeout(run);
}

/**
 * Arm the current segment's hard timeout, and ahead of it the wrap-up steer: WRAP_UP_MIN_MS or 15% of the budget
 * before the end, whichever is larger, unless the budget is shorter than that lead or the run is past it.
 */
export function armTimeout(run: Run) {
	disarm(run);
	const spent = Date.now() - run.segmentStartedAt;
	if (spent >= run.timeoutMs) throw new Error(`${run.id} has already run ${Math.round(spent / 60000)} min of this segment; a ${Math.round(run.timeoutMs / 60000)} min budget is already spent. Pass a larger timeoutMs.`);
	// The explanation is composed in finish(), after harvesting can say where the budget went.
	run.timer = setTimeout(() => { run.status = "timeout"; void stopTree(run); void run.session?.abort(); }, run.timeoutMs - spent);
	const lead = Math.max(WRAP_UP_MIN_MS, run.timeoutMs * 0.15);
	const wrapIn = run.timeoutMs - spent - lead;
	if (lead < run.timeoutMs && wrapIn > 0) run.wrapTimer = setTimeout(() => {
		run.wrapTimer = undefined;
		if (run.status === "running" && !run.completion.settled) steerLive(run, wrapUpMessage(lead)).catch(() => {});
	}, wrapIn);
	watch();
}

export type Replacement = { model?: string; thinking?: string; contextWindow?: number; timeoutMs?: number };
const rebinds = (run: Run, replacement?: Replacement) =>
	Boolean(replacement) && ((replacement!.model ?? run.model) !== run.model || (replacement!.thinking ?? run.thinking) !== run.thinking);

function beginResume(run: Run, restart: boolean, replacement?: Replacement) {
	if (!run.completion.settled) throw new Error(`${run.id} is still stopping; wait for completion before resuming.`);
	if (run.stopped && !restart) throw new Error(`${run.id} was explicitly stopped. Restart only at the user's request (steer with restart: true).`);
	admit();
	if (run.writer) {
		const clash = activeWriter(run.cwd, run);
		if (clash) throw new Error(`${clash.id} is already writing in ${run.cwd}; wait before resuming this child.`);
	}
	openTranscript(run); // Missing history is an error, never permission to start over.
	// A retained session stays bound to the offering it was opened with. Changing the record alone
	// sends the next segment to the old provider, so a new offering reopens from the transcript.
	const rebind = rebinds(run, replacement);
	const next: Run = { ...run, ...replacement, segment: run.segment + 1, stopped: false, acknowledged: false,
		// A new segment must not publish the prior segment's report while it is still running.
		output: "",
		status: "running", endedAt: undefined, error: undefined, revision: run.revision + 1,
		// A resume starts a fresh budget and report scope; persist both with the segment.
		segmentStartIdx: messagesOf(run).length,
		segmentFailedAttemptsBase: run.failedAttempts,
		segmentFailedAttempts: 0,
		segmentStartedAt: Date.now(),
		session: rebind ? undefined : run.session,
		completion: new RunCompletion<RunResult>() };
	saveRun(next);
	// A stale session must not block its replacement.
	if (rebind) void closeSession(run.session);
	Object.assign(run, next);
	changed();
}

/** Actual conversation after the inherited prefix, including streamed text and tool results. */
export function activityOf(run: Run): ChildActivity {
	if (run.activityCache?.revision === run.revision) return run.activityCache.items;
	let messages: any[];
	try { messages = messagesOf(run).slice(run.startIdx).filter((m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"); }
	catch (error) { return { messages: [], activeTools: run.activeTools, error: errorMessage(error) }; }
	const items = { messages, activeTools: run.activeTools,
		streaming: run.streamingMessage && !messages.includes(run.streamingMessage) ? run.streamingMessage : undefined };
	run.activityCache = { revision: run.revision, items };
	return items;
}

// Provider retries are not task work. Keep Pi's automatic retry loop from consuming an entire
// delegate segment before the child gets a chance to use its tools.
const MAX_PROVIDER_RETRIES = 3;
const MAX_PROVIDER_RETRY_MS = 120_000;
/** Pi's built-in tools. Each one a child may not have is left out of its session before any tool registers. */
export const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"];
/** The tools a run may have: its role's tools line, less what its depth withholds. */
export const allowlist = (run: Run) => toolAllowlist(run.tools, run.withheld);
const MAX_EXTENSION_ERRORS = 20;
/** An extension failure in a child, kept on the run once. The child runs on without that extension. */
function extensionError(run: Run, message: string) {
	const errors = run.extensionErrors ??= [];
	if (!errors.includes(message) && errors.length < MAX_EXTENSION_ERRORS) errors.push(message);
}

// --- The backend ------------------------------------------------------------------------------

/** The parent call a pi start or steer runs in: its context (session, model registry, UI) and its progress callback. */
export interface PiCall { ctx: ExtensionContext; onUpdate?: (update: any) => void }

/** The parent binding's part of the pi backend: what needs its extension API, model runtime or tool context. */
export interface PiBackendHooks {
	/** The attached parent. Throws when no parent is attached. */
	owner(): Owner;
	/** The attached parent's live model registry, mirrored into this binding's model runtime at each session open. */
	modelRegistry(): any;
	/** Whether this binding still serves the run's parent: a launch's progress goes to its delegate call only then. */
	serves(run: Run): boolean;
	/** Tie a run to this parent's session (the folder its extensions load from, its MCP tools): once, or anew with the call that starts it. */
	link(run: Run, ctx?: ExtensionContext): void;
	/** The resource loader of a run's session: its extensions, gated to its tools. */
	loader(run: Run, settingsManager: SettingsManager, reopen: boolean): DefaultResourceLoader;
	/** What a validated delegate call starts: its role, offering, trust, tools and prompt. A refusal is a DelegateError. */
	resolve(input: PiStartInput, call: PiCall, signal?: AbortSignal): Promise<PiRunSpec>;
	/** A steer's `model`: the offering it names in the parent's catalog (none when there is no such offering), and the reasoning level it names. */
	resolveModel(spec: string, ctx: ExtensionContext): { model: any; thinking?: string | undefined };
}

/** A new run as its parent's call resolved it (PiBackendHooks.resolve), before anything is recorded. */
export interface PiRunSpec {
	role: string;
	task: string;
	cwd: string;
	model: string;
	thinking: string;
	contextWindow?: number;
	modelPick?: string;
	systemPrompt: string;
	context: "fork" | "fresh";
	tools: string[];
	withheld?: string[];
	writer: boolean;
	timeoutMs: number;
	firstDeliverableMin?: number;
	depth: number;
	parentRunId?: string;
	runtime?: "oven";
	extensions?: string[];
	tui?: "pi" | "claude" | "amp";
	template?: Record<string, unknown>;
	taskPrefix?: string;
	modelOverride?: string;
	projectTrusted: boolean;
	projectTrustSource: TrustSource;
	/** The parent's conversation a forked child inherits, read when its preparation runs. */
	inherited?: () => any[];
}

/** A pi run as the backend contract names it. */
export const piView = (run: Run): PiRunView => ({ ...recordedView(run), backend: "pi" });

/** What a pi join never loses: its runs are in this process, so they settle or are stranded (piJoin). */
const PI_JOIN_LOST = "the pi runs";

/**
 * The pi backend over the lifecycle above. A run is this parent's when its owner key is the attached parent's; its
 * delegating children's runs belong to their own owners and bindings.
 */
export class PiBackend implements DelegateBackend<"pi"> {
	readonly name = "pi" as const;

	constructor(private readonly hooks: PiBackendHooks) {}

	/** This parent's run, or undefined when the ID is not a pi run it owns. */
	find(runId: string | undefined, ownerKey: string): Run | undefined {
		const run = runId ? runs.get(runId) : undefined;
		return run?.ownerKey === ownerKey ? run : undefined;
	}

	private get(runId: string): Run {
		const run = this.find(runId, this.hooks.owner().key);
		if (!run) throw new DelegateError("RUN_NOT_FOUND", `unknown runId ${runId}`, "runIds");
		return run;
	}

	capabilities(): BackendCapabilities { return PI_CAPABILITIES; }

	// Reload refreshes configuration for future session opens. Live children retain the runtime they already own:
	// each binding has its own, and replacing a binding must not mutate their provider state.
	private modelRuntime?: Promise<ModelRuntime>;
	private readonly mirrored = new Set<string>();
	/**
	 * This binding's model runtime, with the parent's live catalog mirrored in. Account and provider extensions
	 * register offerings in the parent's live catalog rather than models.json, and they register them whenever they
	 * please: at startup, on reload, or when the user switches accounts. Mirroring it at every child session open
	 * limits a child by the parent's providers, not by launch order.
	 */
	private async runtime(): Promise<ModelRuntime> {
		const runtime = await (this.modelRuntime ??= ModelRuntime.create());
		const registry = this.hooks.modelRegistry();
		const present = new Set<string>(registry.getRegisteredProviderIds());
		for (const id of present) {
			const native = registry.getRegisteredNativeProvider(id);
			if (native) runtime.registerNativeProvider(native);
			const config = registry.getRegisteredProviderConfig(id);
			if (config) runtime.registerProvider(id, config);
			this.mirrored.add(id);
		}
		for (const id of this.mirrored) {
			if (present.has(id)) continue;
			runtime.unregisterProvider(id); // The parent dropped it; a child must not keep serving it.
			this.mirrored.delete(id);
		}
		return runtime;
	}

	/** Open a run's session from its transcript and its saved configuration, unless it has one. Nothing runs. */
	async openSession(run: Run, onUpdate?: (u: any) => void, preparedLoader?: DefaultResourceLoader): Promise<void> {
		if (run.session) return;
		if (!statSync(run.cwd).isDirectory()) throw new Error(`Saved working directory is unavailable: ${run.cwd}`);
		const runtime = await this.runtime();
		const ref = splitModelRef(run.model);
		const model = ref && runtime.getModel(ref.provider, ref.id);
		if (!model) throw new Error(`Saved model is unavailable: ${run.model}. No fallback was selected \u2014 choose a replacement: delegate_ctl steer runId=${run.id} model=<provider/id[:thinking]>.`);
		// Without its own settings manager Pi trusts every project (SettingsManager.create defaults to trusted).
		const settingsManager = SettingsManager.create(run.cwd, AGENT_DIR, { projectTrusted: run.projectTrusted });
		this.hooks.link(run);
		const loader = preparedLoader ?? this.hooks.loader(run, settingsManager, true);
		if (!preparedLoader) await loader.reload();
		// An extension that failed to load is left out by Pi; the child runs without it, and its run says so.
		run.extensionErrors = [];
		for (const error of loader.getExtensions().errors) extensionError(run, `${error.path}: ${error.error}`);
		const manager = openTranscript(run);
		// A crash may have happened before the first prompt was appended. Preserve the original
		// brief before the explicit revival message rather than silently discarding the task.
		if (run.segment > 1 && !messagesOf(run).some((message, index) => index >= run.startIdx && message.role === "user")) {
			manager.appendMessage({ role: "user", content: [{ type: "text", text: run.task }], timestamp: run.startedAt });
		}
		// Extension tools the child may not have never register (gateExtensions). Pi's built-in tools are
		// not an extension's, so each one it may not have is excluded here, before any tool registers.
		const { allows } = allowlist(run);
		const { session } = await createAgentSession({
			cwd: run.cwd, agentDir: AGENT_DIR, settingsManager, model, thinkingLevel: run.thinking as any,
			excludeTools: PI_BUILTIN_TOOLS.filter((name) => !allows(name)), resourceLoader: loader,
			sessionManager: manager, modelRuntime: runtime,
		} as any);
		// A tool that reached the registry anyway, such as a built-in this Pi has and the list above does not know, is refused, never handed over.
		const leaked = session.getAllTools().filter((tool: any) => !allows(tool.name));
		if (leaked.length) {
			await closeSession(session);
			throw new Error(`This Pi gives a child tools pi-delegate cannot withhold: ${leaked.map((tool: any) => tool.name).join(", ")}.`);
		}
		run.session = session;
		saveRun(run);

		session.subscribe((ev: any) => {
			if (ev.type === "message_start" || ev.type === "message_update") {
				if (ev.message?.role === "assistant") run.streamingMessage = ev.message;
			}
			if (ev.type === "message_end") run.streamingMessage = undefined;
			// A queued steer drains at a turn boundary, an interrupt's as the next prompt: either starts a user message.
			if (ev.type === "message_start" && ev.message?.role === "user" && run.steers?.length) readSteers(run, textOf(ev.message.content, ""));
			if (ev.type === "auto_retry_start") {
				// Retry events can arrive before the failed assistant message is persisted;
				// retain the current-segment attribution for an ensuing timeout.
				run.segmentFailedAttempts++;
				const now = Date.now();
				const retryWall = run.providerRetryMs + (run.providerRetry ? Math.max(0, now - run.providerRetry.startedAt) : 0);
				if (run.providerRetry) {
					run.providerRetryMs = retryWall;
					run.providerRetry = undefined;
				}
				run.lastAttemptError = ev.errorMessage;
				if (ev.attempt > MAX_PROVIDER_RETRIES || retryWall + ev.delayMs > MAX_PROVIDER_RETRY_MS) {
					run.status = "error";
					run.error = `Provider retry ceiling exceeded after ${ev.attempt} retries and ${Math.round(retryWall / 1000)}s; last error: ${ev.errorMessage}`;
					finish(run, "error", run.error);
					void session.abort();
				} else {
					run.providerRetry = { attempt: ev.attempt, maxAttempts: Math.min(ev.maxAttempts, MAX_PROVIDER_RETRIES), delayMs: ev.delayMs, errorMessage: ev.errorMessage, startedAt: Date.now() };
				}
			}
			if (ev.type === "auto_retry_end" && run.providerRetry) {
				run.providerRetryMs += Math.max(0, Date.now() - run.providerRetry.startedAt);
				run.providerRetry = undefined;
			}
			if (ev.type === "tool_execution_start") {
				run.lastTool = ev.toolName;
				run.activeTools.set(ev.toolCallId, { name: ev.toolName, args: ev.args ?? {} });
				{ run.toolCalls.push({ name: ev.toolName, args: (ev.args ?? {}) as Record<string, unknown>, at: Date.now() }); if (run.toolCalls.length > MAX_TOOL_CALLS) run.toolCalls.shift(); }
				if (this.hooks.serves(run)) onUpdate?.({ content: [{ type: "text", text: `${run.id}: ${ev.toolName}` }], details: view(run) });
			}
			if (ev.type === "tool_execution_update") {
				const active = run.activeTools.get(ev.toolCallId);
				if (active) active.result = { ...ev.partialResult, isError: false };
			}
			if (ev.type === "tool_execution_end") run.activeTools.delete(ev.toolCallId);
			trackProgress(run, ev);
			run.revision++;
			if (ev.type === "message_end") {
				if (ev.message?.role === "assistant") {
					try { harvest(run); }
					catch (error) { run.status = "error"; run.error = `Cannot read child transcript: ${errorMessage(error)}`; void session.abort(); }
				}
				try { saveRun(run); }
				catch (error) { run.status = "error"; run.error = `Cannot save child state: ${errorMessage(error)}`; void session.abort(); }
				if (run.status === "running" && ev.message?.role === "assistant") {
					const text = textOf(ev.message.content, " ").trim();
					if (text) milestone(run, { kind: "note", text: text.slice(0, 500) });
				}
			}
			changed();
		});
		// Binding starts the child's extensions (session_start), its nested pi-delegate among them, which
		// attaches this child as its children's parent. It needs run.session set first: restored children may
		// report into it at once. With no UI bound, extensions get Pi's headless UI, as in print mode.
		await session.bindExtensions({ onError: (error: any) => extensionError(run, `${error.extensionPath}: ${error.event}: ${error.error}`) });
		// Pi declares its default tools and the extension tools that ask to be; a tool the role names is declared too, as `pi --tools` does.
		const named = session.getAllTools().filter((tool: any) => run.tools.includes(tool.name)).map((tool: any) => tool.name);
		session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), ...named])]);
	}

	/** Run one segment: open the session (after any preparation), send `task`, and settle the run with its outcome. */
	async launch(run: Run, task: string, onUpdate?: (u: any) => void, preparedLoader?: DefaultResourceLoader): Promise<void> {
		if (run.runtime === "oven") return launchOven(run, task);
		const sessionReady = (async () => {
			await run.preparing;
			run.preparing = undefined;
			await this.openSession(run, onUpdate, preparedLoader);
		})();
		run.ready = sessionReady;
		try {
			await sessionReady;
			if (run.status === "running") {
				milestone(run, { kind: "started", task: task.slice(0, 600) });
				run.dirtyBefore = snapshotDirty(run.cwd);
				beginSegment(run);
				for (let prompt: string | undefined = task; prompt !== undefined;) {
					await run.session.prompt(prompt, { preflightResult: (accepted: boolean) => {
						// Pi abort() cannot cancel prompt preflight while its agent is still idle.
						// Recheck at the SDK's dispatch boundary, before it starts the agent loop.
						if (accepted && run.status !== "running") throw new Error("Child stopped before prompt dispatch.");
					} });
					// An interrupting steer aborted that prompt (steerRun): its message is the next prompt, in this
					// segment and budget. The prompt returns only after Pi settled, so this one is not deferred.
					prompt = run.status === "running" ? interrupts.get(run.id) : undefined;
					interrupts.delete(run.id);
					if (prompt !== undefined) {
						run.turnStartedAt = run.streamingMessage = run.alerted = undefined;
						run.activeTools.clear();
						run.lastProgressAt = Date.now();
						run.revision++;
						changed();
						continue;
					}
					// Provider failures are assistant messages, not rejected prompt promises.
					const last = messagesOf(run).findLast((message) => message.role === "assistant");
					if (run.status === "running" && last?.stopReason === "error") throw new Error(last.errorMessage ?? "Child provider failed.");
				}
			}
			finish(run, run.status === "running" ? "complete" : run.status);
		} catch (e: any) {
			finish(run, run.status === "running" ? "error" : run.status, run.error ?? errorMessage(e));
		} finally { run.ready = undefined; run.preparing = undefined; interrupts.delete(run.id); }
	}

	/**
	 * Steer a run: a running one takes the message into its live turn (an oven slice into its running work), a
	 * settled one resumes in the background with a fresh segment, on `replacement`'s offering or budget when given.
	 * `interrupt` (a running in-process run only) aborts its current turn and sends the message as the next prompt.
	 */
	async steerRun(run: Run, message: string, restart = false, replacement?: Replacement, interrupt = false): Promise<void> {
		this.hooks.owner();
		if (run.foreign) throw ownedElsewhereError(run);
		if (interrupt) this.refuseInterrupt(run);
		if (run.status === "expired") throw new DelegateError("RUN_EXPIRED", run.error ?? `${run.id}: its oven slice expired; start a new run for more work.`);
		// A running oven slice takes the message into its running work, as a live session's steer does.
		if (run.runtime === "oven" && run.status === "running" && run.sliceId) {
			try { await steerLive(run, message); }
			catch (error) { if (error instanceof SliceExpired) throw new DelegateError("RUN_EXPIRED", expiredText(run, error)); throw error; }
			return;
		}
		if (run.status === "running") {
			await run.preparing;
			await run.ready;
			if (run.status === "running" && run.session) {
				// A live turn is already bound to its model. Never swap it underneath running work.
				if (replacement?.model) throw new Error(`${run.id} is running on ${run.model}; a different offering applies to its next segment. Wait for it or cancel it, then steer with model.`);
				if (replacement?.timeoutMs !== undefined) {
					// More time is the one change a live segment can take: it ends `timeoutMs` from now, re-armed at once.
					run.timeoutMs = Date.now() - run.segmentStartedAt + replacement.timeoutMs;
					run.extendRequest = undefined;
					armTimeout(run);
					saveRun(run);
					changed();
				}
				if (interrupt) {
					// launch() sees the message once the aborted prompt returns and sends it as the next prompt; the
					// run never settles in between. A second interrupt before then joins the first.
					const pending = interrupts.get(run.id);
					interrupts.set(run.id, pending === undefined ? message : `${pending}\n\n${message}`);
					// Abort ends the turn's model stream and signals its running tools. Not stopTree: the run goes on,
					// and its delegated children report into it.
					await run.session.abort();
					return;
				}
				await steerLive(run, message); return;
			}
		}
		// It settled while this steer waited for its session.
		if (interrupt) this.refuseInterrupt(run);
		const nested = childOwner(run);
		if (nested && rebinds(run, replacement)) {
			// A new offering reopens the session its own children report into.
			if (nested.busy?.()) throw new Error(`${run.id} has children of its own that have not settled; a different offering reopens its session and would interrupt them. Wait for them, then steer with model.`);
			await closeChildOwner(run);
		}
		// A settled oven run's slice may have expired since: the steer says so, and never makes a new slice. The check is a heartbeat.
		// Any other failure is the send's to report, as before.
		if (run.runtime === "oven" && run.sliceId) await ovenCall("expires", { slice: run.sliceId }).catch((error) => {
			if (!(error instanceof SliceExpired)) return;
			expireRun(run, error);
			throw new DelegateError("RUN_EXPIRED", run.error!);
		});
		beginResume(run, restart, replacement);
		const completion = run.completion;
		void this.launch(run, message).then(() => publish(completion));
	}

	/** An interrupt needs a turn to abort: a running in-process run's. A settled run resumes with a plain steer. */
	private refuseInterrupt(run: Run) {
		if (run.runtime === "oven") throw new DelegateError("INPUT_INVALID", `${run.id} runs as an oven slice; interrupt applies only to an in-process run. Steer without interrupt.`, "interrupt");
		if (run.status !== "running" || run.completion.settled) throw new DelegateError("INPUT_INVALID", `${run.id} is ${run.status}, so there is no turn to interrupt. Steer without interrupt to resume it.`, "interrupt");
	}

	async start(input: PiStartInput, signal?: AbortSignal, call?: PiCall): Promise<PiRunView> {
		if (!call) throw new DelegateError("INPUT_INVALID", "a pi run starts from its parent's delegate call");
		return piView(this.create(await this.hooks.resolve(input, call, signal), call));
	}

	/**
	 * Record a resolved run durably, then prepare and launch it in the background. Nothing awaits until the run is
	 * registered, so a start that checked the limit just before counts it.
	 */
	private create(spec: PiRunSpec, { ctx, onUpdate }: PiCall): Run {
		const owner = this.hooks.owner();
		const { inherited, ...fields } = spec;
		// Freeze the runtime inputs before advertising a run, including project instructions.
		// The record and session live with the parent's, never in the child's cwd: that is often a
		// workspace another tool needs clean (Werkit refuses to archive one holding ignored files).
		// Owner pointers hold absolute record paths, so restore finds them from the parent's side.
		const dir = storageDir(ctx.sessionManager.getCwd());
		const created = SessionManager.create(spec.cwd, dir);
		const sessionFile = created.getSessionFile()!;
		// Pi normally defers the first disk write until an assistant replies. Establish its own
		// header now so a crash before the first response still leaves a resumable identity.
		writeFileSync(sessionFile, `${JSON.stringify(created.getHeader())}\n`, { flag: "wx", mode: 0o600 });
		const manager = SessionManager.open(sessionFile);
		const id = newId(spec.role);
		const run: Run = {
			...fields,
			id, ownerKey: owner.key, recordPath: RunStore.recordPath(dir, id),
			segment: 1, stopped: false, acknowledged: false,
			contextFiles: [], appendSystemPrompt: [],
			sessionFile, sessionId: manager.getSessionId(),
			completion: new RunCompletion<RunResult>(),
			status: "running",
			startedAt: Date.now(), segmentStartedAt: Date.now(),
			turns: 0, failedAttempts: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			cost: 0,
			changedFiles: [],
			// Read from what the child's session offered, once it settles.
			droppedTools: [],
			output: "",
			// Fork context is materialized by the background preparation below. Until then the
			// durable child contains only its header and has no child messages to harvest.
			startIdx: 0,
			segmentStartIdx: 0,
			forkedMessages: spec.context === "fork" ? 0 : undefined,
			providerRetryMs: 0,
			segmentFailedAttempts: 0,
			segmentFailedAttemptsBase: 0,
			toolCalls: [],
			activeTools: new Map(),
			revision: 0,
			...processOwner(),
		};
		this.hooks.link(run, ctx);
		const loader = run.runtime === "oven" ? undefined : this.hooks.loader(run, SettingsManager.create(spec.cwd, AGENT_DIR, { projectTrusted: spec.projectTrusted }), false);
		saveRun(run);
		writeRecord(RunStore.recordPath(owner.dir, run.id), { version: 1, recordPath: run.recordPath });
		runs.set(run.id, run);
		changed();
		const completion = run.completion;
		// Preparation starts after the run is durable. A slow settings/package scan or a long
		// forked parent transcript must not turn an asynchronous delegate call into a blocked
		// parent turn. Yield once before the sync transcript copy so queued Intercom/follow-up
		// messages can be delivered before large history is materialized.
		if (loader) run.preparing = (async () => {
			await new Promise<void>((resolve) => setImmediate(resolve));
			this.hooks.owner();
			const messages = inherited?.() ?? [];
			for (let i = 0; i < messages.length; i++) {
				manager.appendMessage(messages[i]);
				if ((i + 1) % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
			}
			run.startIdx = messages.length;
			run.segmentStartIdx = messages.length;
			run.forkedMessages = spec.context === "fork" ? messages.length : undefined;
			await loader.reload();
			this.hooks.owner();
			run.contextFiles = loader.getAgentsFiles().agentsFiles;
			run.appendSystemPrompt = loader.getAppendSystemPrompt();
			saveRun(run);
			changed();
		})();
		void this.launch(run, spec.task, onUpdate, loader).then(() => publish(completion));
		return run;
	}

	/** delegate_ctl steer: `model` and `timeoutMs` apply to this and later segments; a running run can take only more time. */
	async steer(runId: string, input: SteerRequest, call?: PiCall): Promise<PiRunView> {
		const run = this.get(runId);
		let replacement: Replacement | undefined;
		if (input.model) {
			if (!call) throw new DelegateError("INPUT_INVALID", "a steer's model resolves in its parent's delegate_ctl call", "model");
			const { model, thinking } = this.hooks.resolveModel(input.model, call.ctx);
			if (!model) throw new Error(`model not found: ${input.model}`);
			// Keep the saved reasoning level unless this spec names one.
			replacement = { model: modelKey(model), thinking: thinking ?? run.thinking, contextWindow: model.contextWindow };
		}
		if (input.timeoutMs !== undefined) replacement = { ...replacement, timeoutMs: input.timeoutMs };
		// The model steered it: its completion wakes the model, whoever started it.
		if (run.userStarted) { run.userStarted = undefined; saveRun(run); }
		// Its receipt exists before the message can reach the session; an oven slice reports no message events.
		const receipt = run.runtime === "oven" ? undefined : noteSteer(run, input.message, input.interrupt);
		try { await this.steerRun(run, input.message, input.restart, replacement, input.interrupt); }
		catch (error) { if (receipt) run.steers = run.steers?.filter((r) => r !== receipt); throw error; }
		if (receipt && !run.foreign) { try { saveRun(run); } catch { /* the receipt stays in memory */ } }
		return piView(run);
	}

	/** Hold runs for one wait (piJoin): here, and in the tool layer's wait over both backends. */
	join(runIds: readonly string[]): Join<WaitRow> {
		const joined = runIds.map((id) => this.get(id));
		unwrap(requireAction(PI_CAPABILITIES, "wait"));
		return piJoin(joined);
	}

	async wait(request: WaitRequest, signal?: AbortSignal, interrupted?: () => boolean): Promise<WaitOutcome<PiRunView>> {
		const outcome = await joinRuns([this.join(request.runIds)], request.runIds, request.mode, {
			...(signal ? { signal } : {}), ...(interrupted ? { interrupted } : {}), ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}), lost: PI_JOIN_LOST,
		});
		return { reason: outcome.reason, settled: outcome.settled.map((row) => ({ ...row.details, backend: "pi" as const })), pending: outcome.pending.map((row) => row.id) };
	}

	/** The current report: a settled segment's own result, else the run as it stands. */
	async result(runId: string): Promise<PiRunView> {
		const run = this.get(runId);
		return run.completion.settled ? { ...finalResult(run).details, backend: "pi" } : piView(run);
	}

	async status(runIds?: readonly string[]): Promise<PiRunView[]> {
		const ownerKey = this.hooks.owner().key;
		return (runIds ? runIds.map((id) => this.get(id)) : [...runs.values()].filter((run) => run.ownerKey === ownerKey)).map(piView);
	}

	/** Stops the run and disables its automatic revival; its delegating subtree is cancelled with it. */
	async cancel(runId: string, _input: CancelRequest): Promise<PiRunView> {
		const run = this.get(runId);
		await cancelRun(run);
		return piView(run);
	}

	/** Unsupported: an in-process run holds no external session (PI_CAPABILITIES.close). */
	async close(runId: string, _input: CloseRequest): Promise<PiRunView> {
		const run = this.get(runId);
		unwrap(requireAction(run.runtime === "oven" ? OVEN_CAPABILITIES : PI_CAPABILITIES, "close"));
		return piView(run);
	}
}
