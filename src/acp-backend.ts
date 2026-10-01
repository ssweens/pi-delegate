/**
 * The `acp` backend (todos 042, 043): `delegate`/`delegate_ctl` over the process's one Coordinator.
 *
 * Each mapping is thin and keeps Coordinator semantics: create = spawn + first send, open = spawn
 * with sessionId (+ send when there is a task), steer = send, wait = Coordinator wait (a timeout
 * never cancels), cancel = cancel of a turn this run started, close = close (dispose created,
 * disconnect opened). A run is addressed by its delegate run ID; the Coordinator worker name stays
 * internal.
 *
 * Runs are durable like pi runs (043). Each run's record (identity, origin, native session, turns
 * with request IDs, delivery, outcome and output) is saved under the parent's subsession directory
 * at every lifecycle step. On parent exit the run is parked: its session is released through the
 * Coordinator (a created session closed without discarding it, an opened one only disconnected), so
 * no process outlives the parent, and the record says parked, not closed. A later process restores
 * the record without starting anything; status and result read it. A steer reopens a parked run
 * under the same worker name: an opened run through the Coordinator's native-opening path with the
 * same native ID, a created run through the Coordinator's owned resume, which needs the adapter's
 * session/resume or session/load and fails RUN_NOT_RESUMABLE otherwise. delegate_ctl close is final.
 *
 * Each Pi process has its own Coordinator and state dir, and the record names the dir that holds
 * the run's worker. A run reopened in another process first has that Coordinator adopt the worker
 * from the recorded dir (its provenance and saved session); while the dir's process still holds
 * the worker, the run is RUN_OWNED_ELSEWHERE. A record without a dir predates per-process state:
 * its worker is in the legacy single dir.
 *
 * Opened Amp runs can also be observed (todo 044, amp-observe.ts): status/result with observe reads
 * the thread through one `amp threads export`, on demand, and the cursor is saved with the record.
 *
 * Amp extras (todo 058). A created Amp run takes Amp's agent mode (`amp --mode`) and titles its new
 * thread with the brief's first line. Once its T-ID is known (the Coordinator records it as the first
 * turn settles) the thread is labeled for the run, once, with `amp threads label`; a failed label is
 * a note, never a failed run. Opened threads are never labeled or retitled. For every Amp run, the
 * thread's cost is read with one `amp threads usage` once per settled turn (its wait or wake-up
 * reports it) and by delegate_ctl status/result with a runId unless the cached cost is current, and
 * cached on the record with its time; drawing a view never runs Amp.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RequestRecord, SessionOrigin, StringsResponse, WorkerRecord, WorkerRole } from "./acp/domain/types.js";
import type { Coordinator } from "./acp/orchestration/coordinator.js";
import { acpAgents, acpCoordinator, existingAcpCoordinator } from "./acp/instance.js";
import {
	type AcpModelsView,
	type AcpRunView,
	type AcpStartInput,
	type BackendCapabilities,
	type CancelRequest,
	type CloseRequest,
	type ContractError,
	type DelegateBackend,
	type SteerRequest,
	type Validated,
	type WaitOutcome,
	type WaitRequest,
	acpAgentName,
	acpCapabilities,
	acpRunStatus,
	checkCancel,
	checkClose,
	requireAction,
	turnView,
} from "./backend.js";
import { type ObserveCursor, observationText, observeAmpThread } from "./amp-observe.js";
import { AMP_LABEL, AMP_THREAD_ID, ampThreadLabel, ampThreadUsage, parseAmpCost, type AmpRun } from "./acp/runtime/amp-cli.js";
import type { AmpThreadUsage } from "./backend.js";
import { acpUsage, elapsed } from "./render.js";
import { ownedElsewhere, processOwner, readRecord, type RunOwner, writeRecord } from "./storage.js";
import type { ChildActivity } from "./transcript.js";

/** A failure the tool layer reports by code: a contract violation, or a Coordinator error passed through. */
export class DelegateError extends Error {
	constructor(readonly code: string, message: string, readonly field?: string) {
		super(message);
		this.name = "DelegateError";
	}
}

export function unwrap<T>(validated: Validated<T>): T {
	if (!validated.ok) throw contractError(validated.error);
	return validated.value;
}
function contractError(error: ContractError): DelegateError { return new DelegateError(error.code, error.message, error.field); }

/** What this backend records about a run. The Coordinator owns the live session and its turns. */
interface AcpRunRecord extends Partial<RunOwner> {
	id: string;
	ownerKey: string;
	/** Coordinator worker name. Internal: never shown in text, never accepted from a caller. Reused when a parked run is reopened. */
	worker: string;
	/** The Coordinator state dir that holds the worker: the dir of the process that last ran it. Absent on records older than per-process state. */
	stateDir?: string;
	agent: string;
	origin: SessionOrigin;
	task?: string;
	cwd: string;
	role?: WorkerRole;
	model?: string;
	/** Created Amp runs: Amp's agent mode, given at creation. */
	mode?: string;
	/** The provider-native session ID once known (an Amp T-ID), kept when the worker that reported it is gone. */
	nativeSessionId?: string;
	/** Created Amp runs: the one labeling of the thread, attempted once its T-ID was known. */
	labeled?: { at: number; labels: string[]; ok: boolean };
	/** Amp runs: the thread's cost as last read by status/result. */
	usage?: AmpThreadUsage;
	/** Side effects that failed without failing the run. */
	notes?: string[];
	/** Per-turn budget from delegate; steer reuses it unless it passes its own. */
	timeoutMs?: number;
	/** How an opened run was opened, so reopening it targets exactly that native session. */
	open?: { sessionId: string; cwd?: string; executionEnvironment?: string };
	/** Where a created run was told to execute (Amp: always explicit, local or orb). */
	executionEnvironment?: string;
	/** Opened Amp runs: where the last observation left off, so the next one returns only newer messages. */
	observed?: ObserveCursor;
	startedAt: number;
	closedAt?: number;
	/** The parent exited, or its process died, and the session was released. Steer reopens it. */
	parkedAt?: number;
	/** The turn that was still running when the run was parked. */
	interruptedTurn?: string;
	/** Its session may still be in the Coordinator's state: its process died, or parking could not release it. Steer and close release it there first. */
	unreleased?: true;
	/** Last seen worker and turns, so a closed or parked run (or a Coordinator not yet restored) still shows its session. */
	last?: { worker?: WorkerRecord; requests: RequestRecord[] };
	/** What each turn was sent, by request ID, for the child view. */
	prompts: Record<string, string>;
	// In-process only, never saved:
	/** Joined delegate_ctl waits. A turn that settles while one is joined reports to it instead of waking the parent. */
	waiters: number;
	/** Turns a joined wait already returned: their settlement was delivered, so they wake no one. */
	claimed: Set<string>;
	/** Owned by another live Pi process: read-only here, never written or released. */
	foreign?: true;
	/** A reopening in flight, so concurrent steers reopen once. */
	reviving?: Promise<void>;
	/** An observation in flight: observations of one run are serialized so each moves the cursor once. */
	observing?: Promise<unknown>;
	/** The label call in flight, so turns that settle around it label the thread once. */
	labeling?: Promise<void>;
	/** Amp runs: the cost read for a settled turn, so its watch and its waits read it once. */
	turnUsage?: { requestId: string; done: Promise<void> };
}

type AcpRunFile = Omit<AcpRunRecord, "waiters" | "claimed" | "foreign" | "reviving" | "observing" | "labeling" | "turnUsage"> & { version: 1; backend: "acp"; savedAt: number };

// Process-wide like the pi runtime state: a /reload rebinds the tools, the runs stay.
const RUNS_KEY = Symbol.for("@ssweens/pi-delegate/acp-runs/1");
const registry = (): Map<string, AcpRunRecord> => {
	const g = globalThis as typeof globalThis & { [RUNS_KEY]?: Map<string, AcpRunRecord> };
	return g[RUNS_KEY] ??= new Map();
};

const WAIT_SLICE_MS = 1000;
/** The Coordinator's default profile bound, for a run whose worker profile was never seen. */
const DEFAULT_MAX_OUTPUT_BYTES = 256_000;
const WATCH_SLICE_MS = 60_000;
/** Bounds on the Amp CLI calls a run makes besides its turns: a slow Amp delays, never blocks, a status or a wake. */
const AMP_LABEL_TIMEOUT_MS = 15_000;
const AMP_USAGE_TIMEOUT_MS = 15_000;
/** Bound on the model read a status/result makes: a slow Coordinator makes the models unknown, never the status late. */
const MODELS_READ_TIMEOUT_MS = 3_000;
/** Every thread delegate creates carries this label, so leftover threads are easy to find. */
export const AMP_DELEGATE_LABEL = "pi-delegate";
/** Amp's own limit is 256 characters; a title is the brief's first line, not the brief. */
const AMP_TITLE_MAX = 120;

const isAmp = (run: Pick<AcpRunRecord, "agent">): boolean => run.agent === "amp";

/**
 * The label that names a run in Amp. Amp labels are at most 32 lowercase alphanumerics and hyphens,
 * so the 40-character run ID cannot be one: its UUID without hyphens (32 hex digits) names it exactly.
 */
export function ampRunLabel(runId: string): string {
	const uuid = /([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(runId);
	const label = (uuid ? uuid.slice(1).join("") : runId).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 32);
	return AMP_LABEL.test(label) ? label : AMP_DELEGATE_LABEL;
}

/** The title of a thread delegate creates: the brief's first line, as the delegate tool asks briefs to start. */
export function ampThreadTitle(task: string): string | undefined {
	// Markdown markers go, so a title never reads as a CLI option (`--title -x`).
	const line = task.split("\n").map((text) => text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").replace(/^[\s#>*\-–—]+/, "").trim()).find(Boolean);
	if (!line) return undefined;
	return line.length > AMP_TITLE_MAX ? `${line.slice(0, AMP_TITLE_MAX - 1).trimEnd()}…` : line;
}

/** The run's Amp thread ID: an opened run's own, or the T-ID a created run's adapter reported. Never an ACP session ID. */
function ampThreadId(run: AcpRunRecord): string | undefined {
	const id = run.open?.sessionId ?? run.last?.worker?.native?.id ?? run.nativeSessionId;
	return id && AMP_THREAD_ID.test(id) ? id : undefined;
}

/** Where an Amp CLI call about this run's thread runs: the thread's own workspace, when it still exists. */
function ampCwd(run: AcpRunRecord): string {
	return [run.last?.worker?.native?.cwd, run.open?.cwd, run.cwd].find((dir): dir is string => typeof dir === "string" && existsSync(dir)) ?? process.cwd();
}

/** Why an Amp CLI call failed, in one line. */
function ampFailure(command: string, run: AmpRun | Error): string {
	if (run instanceof Error) return `${command} could not start: ${run.message}`;
	if (run.timedOut) return `${command} timed out`;
	return `${command} exited ${run.code ?? "by signal"}${run.stderr ? `: ${run.stderr.split("\n")[0]}` : ""}`;
}

function slug(agent: string): string {
	const s = agent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 11);
	return /^[a-z]/.test(s) ? s : `acp-${s}`.replace(/-+$/, "");
}

/** Coordinator failures keep their code. Messages name the run, not the internal worker. */
function coordinatorError(response: Extract<StringsResponse, { ok: false }>, run?: Pick<AcpRunRecord, "id" | "worker">): DelegateError {
	const message = run ? response.error.message.replaceAll(`Worker ${run.worker}`, run.id).replaceAll(run.worker, run.id) : response.error.message;
	return new DelegateError(response.error.code, message);
}

/** The Coordinator, after it loaded its state file. Until its first action, snapshot() cannot see a worker a dead process left there. */
async function loaded(coordinator: Coordinator, run: Pick<AcpRunRecord, "id" | "worker">): Promise<Coordinator> {
	const listed = await coordinator.execute({ action: "list" });
	if (!listed.ok) throw coordinatorError(listed, run);
	return coordinator;
}

/** Turns in send order: the saved ones, updated by what the Coordinator holds now. */
function mergeRequests(saved: readonly RequestRecord[], live: readonly RequestRecord[]): RequestRecord[] {
	const byId = new Map(saved.map((request) => [request.id, request]));
	for (const request of live) byId.set(request.id, request);
	return [...byId.values()];
}

function view(run: AcpRunRecord): AcpRunView {
	// A parked run's session was released; a Coordinator that holds its old turns still reports them.
	const live = run.foreign ? undefined : existingAcpCoordinator()?.snapshot(run.worker);
	if (live?.worker) run.last = { worker: live.worker, requests: mergeRequests(run.last?.requests ?? [], live.requests) };
	else if (live?.requests.length) run.last = { ...run.last, requests: mergeRequests(run.last?.requests ?? [], live.requests) };
	const worker = run.last?.worker;
	const requests = run.last?.requests ?? [];
	const turns = requests.map(turnView);
	const latest = requests.at(-1);
	const finishedAt = latest?.finishedAt ? Date.parse(latest.finishedAt) : undefined;
	const status = acpRunStatus(turns);
	const handle = worker?.handle;
	// A created Amp run learns its T-ID after creation; the record keeps it once seen. Any other created
	// session is named by the session ID its runtime holds from creation (Codex: its rollout's ID). An
	// Amp session's ACP session ID is never its thread's.
	const known = worker?.native?.id ?? (run.origin === "created" && !isAmp(run) ? handle?.agentSessionId ?? handle?.backendSessionId : undefined);
	if (known && run.nativeSessionId !== known) run.nativeSessionId = known;
	const nativeSessionId = worker?.native?.id ?? run.nativeSessionId ?? handle?.agentSessionId;
	const v: AcpRunView = {
		backend: "acp",
		id: run.id,
		status,
		cwd: worker?.cwd ?? run.cwd,
		startedAt: run.startedAt,
		session: {
			agent: run.agent,
			origin: run.origin,
			worker: run.worker,
			handle: {
				runtimeSessionName: handle?.runtimeSessionName ?? "",
				...(handle?.acpxRecordId ? { acpxRecordId: handle.acpxRecordId } : {}),
				...(handle?.backendSessionId ? { backendSessionId: handle.backendSessionId } : {}),
				...(handle?.agentSessionId ? { agentSessionId: handle.agentSessionId } : {}),
			},
			...(nativeSessionId ? { nativeSessionId } : {}),
			...(worker?.native ? { executionEnvironment: worker.native.executionEnvironment, native: worker.native }
				: run.executionEnvironment ? { executionEnvironment: run.executionEnvironment } : {}),
			...(run.labeled?.ok ? { labels: [...run.labeled.labels] } : {}),
		},
		turns,
		output: latest?.output ?? "",
		truncated: latest?.truncated ?? false,
		capabilities: acpCapabilities(run),
	};
	if (run.task !== undefined) v.task = run.task;
	if (run.role) v.role = run.role;
	const model = worker?.model ?? run.model;
	if (model) v.model = model;
	if (run.mode) v.mode = run.mode;
	if (run.usage) v.usage = { ...run.usage, ...(run.usage.cost ? { cost: { ...run.usage.cost } } : {}) };
	if (run.notes?.length) v.notes = [...run.notes];
	const endedAt = run.closedAt ?? (status === "running" || status === "idle" ? undefined : finishedAt);
	if (endedAt !== undefined) v.endedAt = endedAt;
	if (run.closedAt !== undefined) v.closed = true;
	else if (run.parkedAt !== undefined) v.parked = { at: run.parkedAt, ...(run.interruptedTurn ? { interruptedTurn: run.interruptedTurn } : {}) };
	if (run.foreign) v.foreign = { ownerPid: run.ownerPid ?? 0, ownerHost: run.ownerHost ?? "" };
	if (latest?.failure) v.error = `${latest.failure.code}: ${latest.failure.message}`;
	return v;
}

/** One wait's hold on its runs. While held, a turn that settles reports to the wait instead of waking the parent. */
export interface AcpJoin {
	views(): AcpRunView[];
	/** Block until a pending run's turn settles or `ms` passes. False when no Coordinator can report them (shut down, or another process owns them). */
	next(pending: readonly AcpRunView[], ms: number): Promise<boolean>;
	/** These settled runs were reported by the wait: they wake no one. */
	claim(settled: readonly AcpRunView[]): void;
	/** End the hold. With redeliver, a turn that settled during the wait but was never reported wakes the parent as usual. */
	release(redeliver: boolean): void;
}

export interface AcpBackendHooks {
	/** The attached parent's key. Throws when no parent is attached. */
	ownerKey(): string;
	/** Something a view shows changed: repaint the Agents frame. */
	changed(): void;
	/** A turn settled while no wait was joined to its run: wake that run's parent. */
	settled(view: AcpRunView, ownerKey: string): void;
	/** Where this parent's ACP run records live. */
	runDir(ownerKey: string): string;
}

const RESUME_REFUSALS = new Set(["RESUME_UNSUPPORTED", "RESUME_PROVENANCE_UNKNOWN"]);

export class AcpBackend implements DelegateBackend<"acp"> {
	readonly name = "acp" as const;

	constructor(private readonly hooks: AcpBackendHooks) {}

	/** This parent's run, or undefined when the ID is not an ACP run it owns. */
	find(runId: string | undefined, ownerKey: string): AcpRunRecord | undefined {
		const run = runId ? registry().get(runId) : undefined;
		return run && run.ownerKey === ownerKey ? run : undefined;
	}

	private get(runId: string): AcpRunRecord {
		const run = this.find(runId, this.hooks.ownerKey());
		if (!run) throw new DelegateError("RUN_NOT_FOUND", `unknown acp runId ${runId}`);
		return run;
	}

	/** A run another live process owns is read-only here: it can be read, never steered, cancelled or closed. */
	private writable(run: AcpRunRecord): void {
		if (run.foreign) throw new DelegateError("RUN_OWNED_ELSEWHERE", `${run.id} is owned by another live Pi process (pid ${run.ownerPid} on ${run.ownerHost}); it is read-only here. Use that session, or wait for it to exit.`);
	}

	owned(ownerKey: string): AcpRunView[] {
		return [...registry().values()].filter((run) => run.ownerKey === ownerKey).map(view);
	}

	// --- Durable records -----------------------------------------------------------------------

	private recordPath(run: Pick<AcpRunRecord, "id" | "ownerKey">): string {
		return join(this.hooks.runDir(run.ownerKey), `${encodeURIComponent(run.id)}.json`);
	}

	/** Save the run as last seen. Never writes a run another live process owns. */
	private save(run: AcpRunRecord): void {
		if (run.foreign) return;
		view(run);
		const { waiters: _waiters, claimed: _claimed, foreign: _foreign, reviving: _reviving, observing: _observing, labeling: _labeling, turnUsage: _turnUsage, ...record } = run;
		writeRecord(this.recordPath(run), { ...record, version: 1, backend: "acp", savedAt: Date.now() } satisfies AcpRunFile);
	}

	/** Background saves (a turn settling) must not fail the turn; the next lifecycle step saves again. */
	private saveQuietly(run: AcpRunRecord): void {
		try { this.save(run); } catch { /* the previous record stays; the next save retries */ }
	}

	/**
	 * Load a parent's saved runs without starting anything. A run whose owner process died is
	 * adopted and parked; a turn that was running then is lost, as the Coordinator records it.
	 * A run another live process owns is shown read-only. A corrupt record fails the attach.
	 */
	restore(ownerKey: string): void {
		const dir = this.hooks.runDir(ownerKey);
		if (!existsSync(dir)) return;
		const restored: AcpRunRecord[] = [];
		for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
			const path = join(dir, name);
			const record = readRecord<AcpRunFile>(path);
			if (!record || record.version !== 1 || record.backend !== "acp" || record.ownerKey !== ownerKey || typeof record.id !== "string" ||
				typeof record.worker !== "string" || typeof record.agent !== "string" || typeof record.cwd !== "string" || typeof record.startedAt !== "number" ||
				(record.origin !== "created" && record.origin !== "opened") || typeof record.prompts !== "object" || record.prompts === null) {
				throw new Error(`Cannot restore delegate metadata: ${path}`);
			}
			if (registry().has(record.id)) continue;
			const { version: _version, backend: _backend, savedAt, ...fields } = record;
			const run: AcpRunRecord = { ...fields, waiters: 0, claimed: new Set() };
			// An unreadable cursor only costs repetition: the next observation lists from the start.
			if (run.observed !== undefined && (typeof run.observed !== "object" || run.observed === null || typeof run.observed.remaining !== "number")) delete run.observed;
			// The same for a cached cost (read again on the next status) and the record of labeling.
			if (run.usage !== undefined && (typeof run.usage !== "object" || run.usage === null || typeof run.usage.at !== "number")) delete run.usage;
			if (run.labeled !== undefined && (typeof run.labeled !== "object" || run.labeled === null || !Array.isArray(run.labeled.labels))) delete run.labeled;
			if (run.notes !== undefined && (!Array.isArray(run.notes) || run.notes.some((note) => typeof note !== "string"))) delete run.notes;
			if (ownedElsewhere(run)) { run.foreign = true; restored.push(run); continue; }
			Object.assign(run, processOwner());
			if (run.closedAt === undefined && run.parkedAt === undefined) {
				// Its process ended without parking it: nothing released its session, and nothing holds it now.
				run.parkedAt = savedAt;
				run.unreleased = true;
			}
			// A turn still running in the record ended with the process that ran it, parked or not.
			for (const request of run.last?.requests ?? []) {
				if (request.status !== "running") continue;
				request.status = "failed";
				request.finishedAt = new Date(savedAt).toISOString();
				request.failure = { code: "PARENT_PROCESS_LOST", message: "Pi exited before this request reached a terminal result.", retryable: request.delivery === undefined };
				if (request.delivery !== undefined) request.delivery = "unknown";
				if (run.closedAt === undefined) run.interruptedTurn = request.id;
			}
			restored.push(run);
		}
		for (const run of restored) { registry().set(run.id, run); this.save(run); }
	}

	/** The run's turns as a conversation for the child view: each prompt sent, then the agent's output. */
	activity(runId: string): ChildActivity {
		const run = this.find(runId, this.hooks.ownerKey());
		if (!run) return { messages: [], activeTools: new Map() };
		view(run);
		const messages: any[] = [];
		for (const request of run.last?.requests ?? []) {
			const at = Date.parse(request.startedAt);
			const prompt = run.prompts[request.id];
			if (prompt !== undefined) messages.push({ role: "user", content: [{ type: "text", text: prompt }], timestamp: at });
			if (request.output || request.status !== "running") {
				messages.push({
					role: "assistant", content: request.output ? [{ type: "text", text: request.output }] : [],
					api: "acp", provider: run.agent, model: run.model ?? run.agent, timestamp: at,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: request.status === "cancelled" ? "aborted" : request.status === "failed" || request.status === "timed_out" ? "error" : "stop",
					...(request.failure ? { errorMessage: `${request.failure.code}: ${request.failure.message}` } : {}),
				});
			}
		}
		return { messages, activeTools: new Map() };
	}

	capabilities(run?: AcpRunView): BackendCapabilities {
		return acpCapabilities(run ? run.session : { origin: "created", agent: "" });
	}

	async start(input: AcpStartInput): Promise<AcpRunView> {
		const ownerKey = this.hooks.ownerKey();
		const agent = acpAgentName(input.agent);
		const known = acpAgents();
		if (known && !known.includes(agent)) throw new DelegateError("INPUT_INVALID", `unknown agent "${input.agent}"; known agents: ${known.join(", ")}`, "agent");
		unwrap(requireAction(acpCapabilities({ origin: input.origin, agent }), input.origin === "opened" ? "open" : "create"));
		const uuid = randomUUID();
		const run: AcpRunRecord = {
			id: `${slug(agent)}-${uuid}`, ownerKey, worker: `w-${uuid}`, agent, origin: input.origin,
			cwd: input.cwd ?? process.cwd(), startedAt: Date.now(), prompts: {}, waiters: 0, claimed: new Set(), ...processOwner(),
		};
		if (input.task !== undefined) run.task = input.task;
		if (input.timeoutMs !== undefined) run.timeoutMs = input.timeoutMs;
		const spawn: Record<string, unknown> & { action: string } = { action: "spawn", name: run.worker, agent };
		if (input.cwd !== undefined) spawn.cwd = input.cwd;
		if (input.executionEnvironment) spawn.executionEnvironment = input.executionEnvironment;
		if (input.origin === "opened") {
			spawn.sessionId = input.sessionId;
			run.open = { sessionId: input.sessionId, ...(input.cwd !== undefined ? { cwd: input.cwd } : {}), ...(input.executionEnvironment ? { executionEnvironment: input.executionEnvironment } : {}) };
		} else {
			if (input.role) { spawn.role = input.role; run.role = input.role; }
			if (input.model) { spawn.model = input.model; run.model = input.model; }
			if (input.mode) { spawn.mode = input.mode; run.mode = input.mode; }
			if (agent === "amp") { const title = ampThreadTitle(input.task); if (title) spawn.title = title; }
			if (input.executionEnvironment) run.executionEnvironment = input.executionEnvironment;
		}
		const coordinator = await acpCoordinator();
		const spawned = await coordinator.execute(spawn);
		if (!spawned.ok) throw coordinatorError(spawned, run);
		run.stateDir = coordinator.stateDir;
		run.last = coordinator.snapshot(run.worker);
		registry().set(run.id, run);
		if (input.task !== undefined) {
			const sent = await coordinator.execute({ action: "send", name: run.worker, prompt: input.task, ...(input.timeoutMs !== undefined ? { requestTimeoutMs: input.timeoutMs } : {}) });
			if (!sent.ok) {
				// The run never got its first turn: release the session instead of leaving a half-started run.
				registry().delete(run.id);
				await coordinator.execute({ action: "close", name: run.worker, force: true }).catch(() => undefined);
				throw coordinatorError(sent, run);
			}
			run.prompts[String(sent.details.requestId)] = input.task;
			this.watch(run, String(sent.details.requestId));
		}
		try { this.save(run); }
		catch (error) {
			// An unrecorded run could not be found again after a restart: refuse it rather than run it untracked.
			registry().delete(run.id);
			await coordinator.execute({ action: "close", name: run.worker, force: true }).catch(() => undefined);
			throw new DelegateError("RUN_NOT_PERSISTED", `${run.id} could not be recorded, so it was released: ${String(error)}`);
		}
		this.hooks.changed();
		return view(run);
	}

	async steer(runId: string, input: SteerRequest): Promise<AcpRunView> {
		const run = this.get(runId);
		this.writable(run);
		unwrap(requireAction(acpCapabilities(run), "steer"));
		if (run.closedAt !== undefined) throw new DelegateError("RUN_CLOSED", `${run.id} is closed; start a new run with delegate`);
		// On Amp, model selects the same agent mode: a run created with a mode keeps it, as creation refuses both.
		if (input.model !== undefined && run.mode !== undefined) throw new DelegateError("INPUT_INVALID", `on Amp, mode and model both select the agent mode; ${run.id} runs in mode ${run.mode} for every turn`, "model");
		const timeoutMs = input.timeoutMs ?? run.timeoutMs;
		const coordinator = await acpCoordinator();
		if (run.parkedAt !== undefined) await this.revive(run, coordinator);
		// A session a timeout or a lost transport left failed takes no more turns: say so, not "busy".
		if (coordinator.snapshot(run.worker).worker?.status === "failed") {
			const cause = view(run).turns.at(-1)?.failure?.code;
			const next = run.origin === "opened" ? "close it and open the session again with delegate sessionId" : "close it and start a new run with delegate";
			throw new DelegateError("RUN_UNUSABLE", `${run.id}'s session is unusable after its last turn${cause ? ` (${cause})` : ""}; ${next}`);
		}
		const sent = await coordinator.execute({
			action: "send", name: run.worker, prompt: input.message,
			...(input.model !== undefined ? { model: input.model } : {}),
			...(timeoutMs !== undefined ? { requestTimeoutMs: timeoutMs } : {}),
		});
		if (!sent.ok) throw coordinatorError(sent, run);
		if (input.model !== undefined) run.model = input.model;
		run.prompts[String(sent.details.requestId)] = input.message;
		this.watch(run, String(sent.details.requestId));
		this.saveQuietly(run);
		this.hooks.changed();
		return view(run);
	}

	/**
	 * Reopen a parked run under its worker name. Opened: the Coordinator's native-opening path with
	 * the same native ID, and the reopened session must still be the one recorded. Created: the
	 * Coordinator's owned resume. Either way nothing new is created in place of the old session.
	 */
	private async revive(run: AcpRunRecord, coordinator: Coordinator): Promise<void> {
		run.reviving ??= (async () => {
			// A process that died without parking can leave its worker in the Coordinator's state.
			// An idle one the Coordinator already reconnected is the session itself; anything else is released first.
			// One that lived in another process's state dir is adopted from there first; a live holder refuses it.
			if (run.stateDir !== (await loaded(coordinator, run)).stateDir) {
				const handle = run.last?.worker?.handle;
				const sessionId = run.origin === "created" ? handle?.backendSessionId ?? handle?.agentSessionId : undefined;
				const adopted = await coordinator.execute({ action: "adopt", name: run.worker, agent: run.agent, ...(run.stateDir ? { stateDir: run.stateDir } : {}), ...(sessionId ? { sessionId } : {}) });
				if (!adopted.ok) throw coordinatorError(adopted, run);
			}
			const stale = coordinator.snapshot(run.worker).worker;
			if (stale && stale.status !== "idle") {
				const released = await coordinator.execute({ action: "close", name: run.worker, force: true });
				if (!released.ok) throw coordinatorError(released, run);
			}
			if (stale?.status !== "idle") {
				if (run.origin === "opened") await this.reopen(run, coordinator);
				else await this.resume(run, coordinator);
			}
			run.stateDir = coordinator.stateDir;
			delete run.parkedAt;
			delete run.interruptedTurn;
			delete run.unreleased;
			this.save(run);
			this.hooks.changed();
		})().finally(() => { delete run.reviving; });
		await run.reviving;
	}

	private async reopen(run: AcpRunRecord, coordinator: Coordinator): Promise<void> {
		const recorded = run.last?.worker?.native;
		const open = run.open ?? (recorded ? { sessionId: recorded.id } : undefined);
		if (!open) throw new DelegateError("RUN_NOT_RESUMABLE", `${run.id} has no recorded native session ID to reopen; open it again with delegate sessionId`);
		const spawned = await coordinator.execute({
			action: "spawn", name: run.worker, agent: run.agent, sessionId: open.sessionId,
			...(open.cwd !== undefined ? { cwd: open.cwd } : {}),
			...(open.executionEnvironment ? { executionEnvironment: open.executionEnvironment } : {}),
		});
		if (!spawned.ok) throw coordinatorError(spawned, run);
		const native = coordinator.snapshot(run.worker).worker?.native;
		if (recorded && (!native || native.id !== recorded.id || native.scope !== recorded.scope || native.cwd !== recorded.cwd || native.executionEnvironment !== recorded.executionEnvironment)) {
			await coordinator.execute({ action: "close", name: run.worker }).catch(() => undefined);
			throw new DelegateError("SESSION_IDENTITY_CHANGED", `${run.id}: native session ${recorded.id} no longer has the storage scope, workspace or executor it was opened with; it was disconnected, not reopened.`);
		}
	}

	private async resume(run: AcpRunRecord, coordinator: Coordinator): Promise<void> {
		const worker = run.last?.worker;
		const sessionId = worker?.handle.backendSessionId ?? worker?.handle.agentSessionId;
		if (!worker || !sessionId) throw new DelegateError("RUN_NOT_RESUMABLE", `${run.id} has no recorded ACP session to resume; start a new run with delegate`);
		const resumed = await coordinator.execute({
			action: "resume", name: run.worker, agent: run.agent, sessionId, cwd: worker.cwd, role: worker.role, tools: worker.profile.tools,
			...(worker.model ? { model: worker.model } : {}),
		});
		if (resumed.ok) return;
		if (RESUME_REFUSALS.has(resumed.error.code)) {
			throw new DelegateError("RUN_NOT_RESUMABLE", `${run.id} cannot be reopened (${resumed.error.code}: ${resumed.error.message}). Its record stays readable; start a new run with delegate.`);
		}
		throw coordinatorError(resumed, run);
	}

	/** Hold runs for one wait. Used by wait here and by the tool layer's mixed-backend wait. */
	join(runIds: readonly string[]): AcpJoin {
		const runs = runIds.map((id) => this.get(id));
		for (const run of runs) unwrap(requireAction(acpCapabilities(run), "wait"));
		// The turns running when the wait began: if one settles and the wait never reports it, it still wakes the parent.
		const runningAtJoin = new Map(runs.flatMap((run) => { const v = view(run); const turn = v.turns.at(-1); return v.status === "running" && turn ? [[run.id, turn.requestId] as const] : []; }));
		for (const run of runs) run.waiters += 1;
		let released = false;
		return {
			views: () => runs.map(view),
			next: async (pending, ms) => {
				const coordinator = existingAcpCoordinator();
				const names = coordinator ? pending.filter((v) => coordinator.snapshot(v.session.worker).worker).map((v) => v.session.worker) : [];
				if (!coordinator || !names.length) return false;
				const waited = await coordinator.execute({ action: "wait", names, mode: "any", waitTimeoutMs: ms });
				if (!waited.ok) {
					if (waited.error.code === "COORDINATOR_SHUTTING_DOWN") return false;
					throw coordinatorError(waited);
				}
				return true;
			},
			claim: (settled) => {
				for (const v of settled) { const turn = v.turns.at(-1); if (turn) registry().get(v.id)?.claimed.add(turn.requestId); }
			},
			release: (redeliver) => {
				if (released) return;
				released = true;
				for (const run of runs) {
					run.waiters -= 1;
					const requestId = runningAtJoin.get(run.id);
					if (!redeliver || run.waiters > 0 || !requestId || run.claimed.has(requestId) || !registry().has(run.id)) continue;
					const current = view(run);
					if (current.status !== "running" && current.turns.at(-1)?.requestId === requestId) { run.claimed.add(requestId); this.hooks.settled(current, run.ownerKey); }
				}
			},
		};
	}

	/**
	 * Join runs until the mode is satisfied. A timeout, an abort or queued parent messages end the
	 * wait only: nothing is cancelled. Coordinator waits are sliced so those checks stay prompt.
	 * Every run a returned outcome reports as settled is delivered by it; an abort delivers nothing,
	 * so a turn that settled meanwhile wakes the parent as it would have without the wait.
	 */
	async wait(request: WaitRequest, signal?: AbortSignal, interrupted?: () => boolean): Promise<WaitOutcome<AcpRunView>> {
		const join = this.join(request.runIds);
		const deadline = request.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + request.timeoutMs;
		let aborted = false;
		try {
			for (;;) {
				const views = join.views();
				const settled = views.filter((v) => v.status !== "running");
				const pending = views.filter((v) => v.status === "running");
				const end = async (reason: WaitOutcome<AcpRunView>["reason"]): Promise<WaitOutcome<AcpRunView>> => {
					join.claim(settled);
					return { reason, settled: await this.withCosts(settled), pending: pending.map((v) => v.id) };
				};
				if (request.mode === "any" ? settled.length > 0 : pending.length === 0) return await end("settled");
				if (signal?.aborted) { aborted = true; throw new DOMException("Wait cancelled; the runs are unaffected.", "AbortError"); }
				if (interrupted?.()) return await end("interrupted");
				const left = deadline - Date.now();
				if (left <= 0) return await end("timeout");
				if (!(await join.next(pending, Math.min(WAIT_SLICE_MS, left)))) return await end("lost");
			}
		} finally {
			join.release(aborted);
		}
	}

	/** A wait's settled views, with each Amp run's thread cost read for its settled turn (once per turn). */
	async withCosts(settled: readonly AcpRunView[]): Promise<AcpRunView[]> {
		await Promise.all(settled.map((v) => { const run = registry().get(v.id); return run ? this.settledUsage(run) : undefined; }));
		return settled.map((v) => { const usage = registry().get(v.id)?.usage; return usage ? { ...v, usage: { ...usage, ...(usage.cost ? { cost: { ...usage.cost } } : {}) } } : v; });
	}

	async result(runId: string): Promise<AcpRunView> {
		const run = this.get(runId);
		unwrap(requireAction(acpCapabilities(run), "result"));
		return view(run);
	}

	/**
	 * Observe an opened Amp run's thread for one status/result call: one `amp threads export`, on
	 * demand, returning only the messages after the last one this run was shown. It needs no session,
	 * so a parked run is observed without reopening it. A failed export is an unknown observation,
	 * not an error, and leaves the cursor where it was.
	 */
	async observe(runId: string): Promise<AcpRunView> {
		const run = this.get(runId);
		unwrap(requireAction(acpCapabilities(run), "observe"));
		this.writable(run);
		if (run.closedAt !== undefined) throw new DelegateError("RUN_CLOSED", `${run.id} is closed, and its observation ended with it; open the thread again with delegate sessionId`);
		const next = (run.observing ?? Promise.resolve()).catch(() => undefined).then(() => this.observeOnce(run));
		run.observing = next;
		try { return await next; }
		finally { if (run.observing === next) delete run.observing; }
	}

	private async observeOnce(run: AcpRunRecord): Promise<AcpRunView> {
		const current = view(run);
		const threadId = run.open?.sessionId ?? current.session.nativeSessionId;
		if (!threadId) throw new DelegateError("RUN_NOT_OBSERVABLE", `${run.id} has no recorded native thread ID to observe`);
		// The export reads the thread by ID; run it where the thread was verified, when that still exists.
		const { observation, cursor } = await observeAmpThread({ threadId, cwd: ampCwd(run), ...(run.observed ? { cursor: run.observed } : {}), maxBytes: run.last?.worker?.profile.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES });
		if (cursor) { run.observed = cursor; this.saveQuietly(run); }
		return { ...view(run), observation };
	}

	/**
	 * Read an Amp run's thread cost: one `amp threads usage`, for delegate_ctl status/result with a
	 * runId, cached on the record with when it was read. Unavailable is unknown: no thread ID yet, or a
	 * failed or unreadable command. It never fails the request. A failed read keeps a cost read before
	 * and adds why the latest read failed. Other agents read nothing.
	 *
	 * A cached cost stands without a read once the run is closed, and on a created run while no turn
	 * ended since it was read: only this run drives that thread. An opened thread is shared, so other
	 * participants' work can change its cost between this run's turns; it is read every time.
	 */
	async refreshUsage(runId: string): Promise<void> {
		const run = this.get(runId);
		if (!isAmp(run)) return;
		// A read for the latest settled turn in flight is this read; the cache rule below then decides.
		await run.turnUsage?.done;
		await this.readUsage(run);
	}

	/**
	 * Amp runs: read the cost once per settled turn, from its watch or a wait, whichever comes first,
	 * so a wait result and a wake-up report the turn's cost. Bounded like every usage read; it never
	 * delays the turn's settlement in the Coordinator.
	 */
	private settledUsage(run: AcpRunRecord): Promise<void> {
		if (!isAmp(run) || run.foreign) return Promise.resolve();
		const latest = view(run).turns.at(-1);
		if (!latest || latest.status === "running") return Promise.resolve();
		if (run.turnUsage?.requestId !== latest.requestId) run.turnUsage = { requestId: latest.requestId, done: this.readUsage(run).catch(() => undefined) };
		return run.turnUsage.done;
	}

	private async readUsage(run: AcpRunRecord): Promise<void> {
		view(run);
		const cached = run.usage?.cost !== undefined && run.usage.error === undefined ? run.usage : undefined;
		const last = run.last?.requests.at(-1);
		const lastEnded = last && last.status !== "running" && last.finishedAt ? Date.parse(last.finishedAt) : undefined;
		if (cached && (run.closedAt !== undefined || (run.origin === "created" && lastEnded !== undefined && cached.at >= lastEnded))) return;
		const threadId = ampThreadId(run);
		const at = Date.now();
		const failed = (error: string): AmpThreadUsage => {
			const known = run.usage?.cost !== undefined && run.usage.threadId === threadId ? run.usage : undefined;
			return known ? { cost: { ...known.cost! }, at: known.at, threadId: known.threadId!, error } : { at, ...(threadId ? { threadId } : {}), error };
		};
		if (!threadId) { run.usage = failed("the Amp thread ID is not known yet"); this.saveQuietly(run); return; }
		const command = `amp threads usage ${threadId}`;
		const read = await ampThreadUsage(threadId, ampCwd(run), { timeoutMs: AMP_USAGE_TIMEOUT_MS }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
		// A park meanwhile owns the record now.
		if (registry().get(run.id) !== run) return;
		const amount = read instanceof Error || read.code !== 0 ? undefined : parseAmpCost(read.stdout.toString("utf8"));
		run.usage = amount !== undefined ? { cost: { amount, currency: "USD" }, at, threadId }
			: failed(read instanceof Error || read.code !== 0 ? ampFailure(command, read) : `${command} printed no Cost line`);
		this.saveQuietly(run);
	}

	/**
	 * Label a created Amp thread for its run, once, when its T-ID is first known: the run label and
	 * the delegate label. A failure is a note on the run. Opened threads are never touched.
	 */
	private labelThread(run: AcpRunRecord): Promise<void> {
		if (run.labeling) return run.labeling;
		if (run.origin !== "created" || !isAmp(run) || run.labeled || run.foreign) return Promise.resolve();
		view(run);
		const threadId = ampThreadId(run);
		if (!threadId) return Promise.resolve();
		const labels = [ampRunLabel(run.id), AMP_DELEGATE_LABEL];
		const command = `amp threads label ${threadId} ${labels.join(" ")}`;
		run.labeling = (async () => {
			const done = await ampThreadLabel(threadId, labels, ampCwd(run), { timeoutMs: AMP_LABEL_TIMEOUT_MS }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));
			const ok = !(done instanceof Error) && done.code === 0;
			run.labeled = { at: Date.now(), labels, ok };
			if (!ok) (run.notes ??= []).push(`labeling Amp thread ${threadId} failed (${ampFailure(command, done)}); the run is unaffected`);
		})().finally(() => { delete run.labeling; });
		return run.labeling;
	}

	/**
	 * The agent's current and available model IDs, for delegate_ctl status/result on one run: one
	 * Coordinator status, bounded. It never fails the request: unsupported, failed or slow discovery
	 * is unknown. Undefined when the run has no live session here (closed, parked, owned elsewhere),
	 * so there is nothing to ask. An opened session reports only its current model.
	 */
	async models(runId: string): Promise<AcpModelsView | undefined> {
		const run = this.get(runId);
		if (run.foreign || run.closedAt !== undefined || run.parkedAt !== undefined) return undefined;
		const coordinator = existingAcpCoordinator();
		const status = coordinator?.snapshot(run.worker).worker?.status;
		if (!coordinator || !status || status === "closing" || status === "closed") return undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const response = await Promise.race([
			coordinator.execute({ action: "status", name: run.worker }).catch((error: unknown) => error instanceof Error ? error : new Error(String(error))),
			new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), MODELS_READ_TIMEOUT_MS); }),
		]).finally(() => clearTimeout(timer));
		if (response === undefined) return { error: `model discovery did not answer within ${MODELS_READ_TIMEOUT_MS / 1000}s` };
		if (response instanceof Error) return { error: response.message };
		if (!response.ok) return { error: `${response.error.code}: ${response.error.message}` };
		const current = typeof response.details.currentModelId === "string" ? response.details.currentModelId : undefined;
		const available = Array.isArray(response.details.availableModelIds) ? response.details.availableModelIds.filter((id): id is string => typeof id === "string") : [];
		if (run.origin === "opened") return current ? { current } : { error: "the opened session does not report its model" };
		if (!current && !available.length) return { error: "the adapter reported no model IDs" };
		return { ...(current ? { current } : {}), available };
	}

	async status(runIds?: readonly string[]): Promise<AcpRunView[]> {
		if (!runIds) return this.owned(this.hooks.ownerKey());
		return runIds.map((id) => {
			const run = this.get(id);
			unwrap(requireAction(acpCapabilities(run), "status"));
			return view(run);
		});
	}

	async cancel(runId: string, input: CancelRequest): Promise<AcpRunView> {
		const run = this.get(runId);
		this.writable(run);
		const current = view(run);
		// Every turn this run can see is one it sent: a turn another participant started is not a request here.
		unwrap(checkCancel(current.capabilities, current.status === "running" ? "own" : "none"));
		if (current.status !== "running") throw new DelegateError("WORKER_NOT_RUNNING", `${run.id} has no active turn to cancel`);
		const coordinator = await acpCoordinator();
		// This parent asked for the turn's end and the cancel result reports it, so its settlement wakes no one, as a wait's claim does.
		const requestId = current.turns.at(-1)!.requestId;
		run.claimed.add(requestId);
		const cancelled = await coordinator.execute({ action: "cancel", name: run.worker, ...(input.reason ? { reason: input.reason } : {}) });
		this.saveQuietly(run);
		this.hooks.changed();
		if (!cancelled.ok) {
			// The cancel reports nothing: a turn that settled meanwhile still wakes the parent.
			run.claimed.delete(requestId);
			const after = view(run);
			if (after.status !== "running" && after.turns.at(-1)?.requestId === requestId && run.waiters === 0 && registry().get(run.id) === run) {
				run.claimed.add(requestId);
				this.hooks.settled(after, run.ownerKey);
			}
			throw coordinatorError(cancelled, run);
		}
		return view(run);
	}

	/** Final: a closed run is never reopened. A parked run's session was already released when it parked. */
	async close(runId: string, input: CloseRequest): Promise<AcpRunView> {
		const run = this.get(runId);
		if (run.closedAt !== undefined) return view(run);
		this.writable(run);
		unwrap(checkClose(acpCapabilities(run), input));
		if (run.parkedAt !== undefined) {
			// Discarding a created session's saved state needs the session back first; anything else needs no process at all.
			if (input.discardPersistentState === true) await this.revive(run, await acpCoordinator());
			else {
				// A session parking did not release is still in the Coordinator's state, and its next use would reconnect it.
				const coordinator = run.unreleased ? await loaded(await acpCoordinator(), run) : existingAcpCoordinator();
				// One in another process's state dir: refused while that process lives and holds it, as reviving it would be.
				// A dead holder's claims are already stale, and nothing loads its dir again.
				if (coordinator && run.unreleased && run.stateDir !== coordinator.stateDir) {
					const checked = await coordinator.execute({ action: "adopt", name: run.worker, agent: run.agent, ...(run.stateDir ? { stateDir: run.stateDir } : {}) });
					if (!checked.ok) throw coordinatorError(checked, run);
				}
				if (coordinator?.snapshot(run.worker).worker) {
					const released = await coordinator.execute({ action: "close", name: run.worker, force: true });
					if (!released.ok) throw coordinatorError(released, run);
				}
				run.closedAt = Date.now();
				delete run.parkedAt;
				delete run.unreleased;
				this.save(run);
				this.hooks.changed();
				return view(run);
			}
		}
		const coordinator = await acpCoordinator();
		view(run); // Keep the session as last seen: the Coordinator forgets a closed worker.
		const closed = await coordinator.execute({
			action: "close", name: run.worker,
			...(input.force !== undefined ? { force: input.force } : {}),
			...(input.discardPersistentState !== undefined ? { discardPersistentState: input.discardPersistentState } : {}),
		});
		if (!closed.ok) { this.saveQuietly(run); this.hooks.changed(); throw coordinatorError(closed, run); }
		run.closedAt = Date.now();
		this.save(run);
		this.hooks.changed();
		return view(run);
	}

	/**
	 * Parent exit: park every run this parent holds. Its session is released through the
	 * Coordinator, as close would (a created session closed without discarding it, so it stays
	 * resumable; an opened one only disconnected, its native work untouched), so nothing outlives
	 * the parent. The record is saved parked, its ownership released, and the run forgotten here.
	 */
	async closeOwner(ownerKey: string): Promise<void> {
		const coordinator = existingAcpCoordinator();
		for (const run of [...registry().values()]) {
			if (run.ownerKey !== ownerKey) continue;
			registry().delete(run.id);
			if (run.foreign) continue;
			if (run.closedAt === undefined && run.parkedAt === undefined) {
				const before = view(run);
				// Without a Coordinator that confirms the close, the session may still be in its state: steer or close releases it later.
				const held = coordinator ? await loaded(coordinator, run).then((c) => c.snapshot(run.worker).worker !== undefined, () => true) : true;
				const released = !held || (await coordinator?.execute({ action: "close", name: run.worker, force: true }).catch(() => undefined))?.ok === true;
				if (!released) run.unreleased = true;
				if (before.status === "running") { const turn = before.turns.at(-1); if (turn) run.interruptedTurn = turn.requestId; }
				run.parkedAt = Date.now();
			}
			delete run.ownerPid; delete run.ownerHost; delete run.ownerToken;
			this.saveQuietly(run);
		}
	}

	/** Report a turn's settlement once, to a joined wait or else to the parent. */
	private watch(run: AcpRunRecord, requestId: string): void {
		void (async () => {
			for (;;) {
				const coordinator = existingAcpCoordinator();
				if (!coordinator) return;
				const waited = await coordinator.execute({ action: "wait", requestId, waitTimeoutMs: WATCH_SLICE_MS });
				if (!waited.ok) return;
				if (!waited.details.timedOut) break;
			}
			if (!registry().has(run.id)) return;
			await Promise.all([this.labelThread(run).catch(() => undefined), this.settledUsage(run)]);
			// Labeling and the cost read can take seconds: a park meanwhile owns the record now.
			if (registry().get(run.id) !== run) return;
			this.saveQuietly(run);
			this.hooks.changed();
			const current = view(run);
			if (run.waiters > 0 || run.claimed.has(requestId) || current.turns.at(-1)?.requestId !== requestId) return;
			run.claimed.add(requestId);
			this.hooks.settled(current, run.ownerKey);
		})().catch(() => undefined);
	}
}

// ---------------------------------------------------------------------------------------------
// Text the parent model reads. Session evidence, no transport detail.

/** The run's session as the parent model reads it: created or opened, and its native ID once known. */
export function sessionLabel(v: AcpRunView): string {
	return `${v.session.origin === "opened" ? "opened native session" : "session"} ${v.session.nativeSessionId ?? "pending"}`;
}

function sessionText(v: AcpRunView): string {
	const text = v.session.executionEnvironment ? `${sessionLabel(v)} (${v.session.executionEnvironment})` : sessionLabel(v);
	return v.session.labels?.length ? `${text}, labeled ${v.session.labels.join(", ")}` : text;
}

function turnText(v: AcpRunView): string | undefined {
	const t = v.turns.at(-1);
	if (!t) return undefined;
	const cause = t.failure ? `, cause ${t.failure.code}` : t.stopReason && t.stopReason !== "end_turn" ? `, stop reason ${t.stopReason}` : "";
	return `turn ${t.requestId}: ${t.status}, delivery ${t.delivery}${t.providerOutcome ? `, provider outcome ${t.providerOutcome}` : ""}${cause}${t.truncated ? ", output truncated" : ""}`;
}

/** The agent's own model IDs, as one status/result read them. */
function modelsText(models: AcpModelsView): string {
	if (!models.current && !models.available?.length) return "models: unknown";
	if (!models.available) return `models: current ${models.current}`;
	return `models: current ${models.current ?? "unknown"}; available ${models.available.join(", ") || "none"}`;
}

export function acpSummary(v: AcpRunView): string {
	const dur = elapsed((v.endedAt ?? Date.now()) - v.startedAt);
	const { tokens: { input: tokensIn, output: tokensOut }, cost } = acpUsage(v);
	// An Amp run's cost is its thread's, as last read; never read or unreadable is unknown, not zero.
	const costText = v.session.agent === "amp"
		? v.usage?.cost?.amount !== undefined ? `$${v.usage.cost.amount.toFixed(2)} (Amp thread${v.usage.error ? `, last read at ${new Date(v.usage.at).toISOString()}; the latest read failed` : ""})` : "cost unknown"
		: cost ? `$${cost.toFixed(4)}` : "";
	const head = [
		`${v.status} · ${v.id}`,
		`backend acp`,
		`agent ${v.session.agent}`,
		v.role ? `role ${v.role}` : "",
		v.model ? `model ${v.model}` : "",
		v.mode ? `mode ${v.mode}` : "",
		`${v.turns.length} turn${v.turns.length === 1 ? "" : "s"} in ${dur}`,
		tokensIn || tokensOut ? `tokens in ${tokensIn}, out ${tokensOut}` : "",
		costText,
	].filter(Boolean).join(" · ");
	const lines = [head, sessionText(v)];
	const turn = turnText(v);
	if (turn) lines.push(turn);
	if (v.models) lines.push(modelsText(v.models));
	if (v.status === "idle") lines.push(v.session.origin === "opened" ? "idle: attached without sending a turn" : "idle");
	if (v.closed) lines.push(v.session.origin === "opened" ? "closed: disconnected; the native session is unchanged" : "closed: session disposed");
	if (v.parked) {
		const released = v.session.origin === "opened" ? "disconnected, the native session unchanged" : "its session closed and kept resumable";
		const reopen = v.session.origin === "opened" ? "steer reopens the same native session" : "steer resumes it";
		lines.push(`parked: the parent exited, ${released}; ${reopen}, close ends it${v.parked.interruptedTurn ? `. Turn ${v.parked.interruptedTurn} was still running then` : ""}`);
	}
	if (v.foreign) lines.push(`read-only: owned by another live Pi process (pid ${v.foreign.ownerPid} on ${v.foreign.ownerHost})`);
	if (v.error) lines.push(`error: ${v.error}`);
	for (const note of v.notes ?? []) lines.push(`note: ${note}`);
	return lines.join("\n");
}

/** The agent's words are quoted, never blended into this tool's own reporting. */
export function acpResultText(v: AcpRunView): string {
	const report = v.turns.length ? `${acpSummary(v)}\n\n----- ${v.id} reported, verbatim -----\n${v.output || "(the turn ended without output)"}\n----- end of report -----` : acpSummary(v);
	return v.observation ? `${report}\n\n${observationText(v.observation)}` : report;
}

/** delegate_ctl status text: the summary, and the observation when one was asked for. */
export function acpStatusText(v: AcpRunView): string {
	return v.observation ? `${acpSummary(v)}\n\n${observationText(v.observation)}` : acpSummary(v);
}
