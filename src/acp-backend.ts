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
 * Opened Amp runs can also be observed (todo 044, amp-observe.ts): status/result with observe reads
 * the thread through one `amp threads export`, on demand, and the cursor is saved with the record.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RequestRecord, SessionOrigin, StringsResponse, WorkerRecord, WorkerRole } from "./acp/domain/types.js";
import type { Coordinator } from "./acp/orchestration/coordinator.js";
import { acpAgents, acpCoordinator, existingAcpCoordinator } from "./acp/instance.js";
import {
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
	acpCapabilities,
	acpRunStatus,
	checkCancel,
	checkClose,
	requireAction,
	turnView,
} from "./backend.js";
import { type ObserveCursor, observationText, observeAmpThread } from "./amp-observe.js";
import { elapsed } from "./render.js";
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
	agent: string;
	origin: SessionOrigin;
	task?: string;
	cwd: string;
	role?: WorkerRole;
	model?: string;
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
}

type AcpRunFile = Omit<AcpRunRecord, "waiters" | "claimed" | "foreign" | "reviving" | "observing"> & { version: 1; backend: "acp"; savedAt: number };

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

function slug(agent: string): string {
	const s = agent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 11);
	return /^[a-z]/.test(s) ? s : `acp-${s}`.replace(/-+$/, "");
}

/** Coordinator failures keep their code. Messages name the run, not the internal worker. */
function coordinatorError(response: Extract<StringsResponse, { ok: false }>, run?: Pick<AcpRunRecord, "id" | "worker">): DelegateError {
	const message = run ? response.error.message.replaceAll(`Worker ${run.worker}`, run.id).replaceAll(run.worker, run.id) : response.error.message;
	return new DelegateError(response.error.code, message);
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
	const nativeSessionId = worker?.native?.id ?? handle?.agentSessionId;
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
		const { waiters: _waiters, claimed: _claimed, foreign: _foreign, reviving: _reviving, observing: _observing, ...record } = run;
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
			if (ownedElsewhere(run)) { run.foreign = true; restored.push(run); continue; }
			Object.assign(run, processOwner());
			if (run.closedAt === undefined && run.parkedAt === undefined) {
				// Its process ended without parking it: nothing holds its session now.
				run.parkedAt = savedAt;
				for (const request of run.last?.requests ?? []) {
					if (request.status !== "running") continue;
					request.status = "failed";
					request.finishedAt = new Date(savedAt).toISOString();
					request.failure = { code: "PARENT_PROCESS_LOST", message: "Pi exited before this request reached a terminal result.", retryable: request.delivery === undefined };
					if (request.delivery !== undefined) request.delivery = "unknown";
					run.interruptedTurn = request.id;
				}
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
		const agent = input.agent.trim().toLowerCase();
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
			if (input.executionEnvironment) run.executionEnvironment = input.executionEnvironment;
		}
		const coordinator = await acpCoordinator();
		const spawned = await coordinator.execute(spawn);
		if (!spawned.ok) throw coordinatorError(spawned, run);
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
		const timeoutMs = input.timeoutMs ?? run.timeoutMs;
		const coordinator = await acpCoordinator();
		if (run.parkedAt !== undefined) await this.revive(run, coordinator);
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
			const stale = coordinator.snapshot(run.worker).worker;
			if (stale && stale.status !== "idle") {
				const released = await coordinator.execute({ action: "close", name: run.worker, force: true });
				if (!released.ok) throw coordinatorError(released, run);
			}
			if (stale?.status !== "idle") {
				if (run.origin === "opened") await this.reopen(run, coordinator);
				else await this.resume(run, coordinator);
			}
			delete run.parkedAt;
			delete run.interruptedTurn;
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
				const end = (reason: WaitOutcome<AcpRunView>["reason"]): WaitOutcome<AcpRunView> => { join.claim(settled); return { reason, settled, pending: pending.map((v) => v.id) }; };
				if (request.mode === "any" ? settled.length > 0 : pending.length === 0) return end("settled");
				if (signal?.aborted) { aborted = true; throw new DOMException("Wait cancelled; the runs are unaffected.", "AbortError"); }
				if (interrupted?.()) return end("interrupted");
				const left = deadline - Date.now();
				if (left <= 0) return end("timeout");
				if (!(await join.next(pending, Math.min(WAIT_SLICE_MS, left)))) return end("lost");
			}
		} finally {
			join.release(aborted);
		}
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
		const worker = run.last?.worker;
		// The export reads the thread by ID; run it where the thread was verified, when that still exists.
		const cwd = [worker?.native?.cwd, run.open?.cwd, run.cwd].find((dir): dir is string => typeof dir === "string" && existsSync(dir)) ?? process.cwd();
		const { observation, cursor } = await observeAmpThread({ threadId, cwd, ...(run.observed ? { cursor: run.observed } : {}), maxBytes: worker?.profile.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES });
		if (cursor) { run.observed = cursor; this.saveQuietly(run); }
		return { ...view(run), observation };
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
		const cancelled = await coordinator.execute({ action: "cancel", name: run.worker, ...(input.reason ? { reason: input.reason } : {}) });
		this.saveQuietly(run);
		this.hooks.changed();
		if (!cancelled.ok) throw coordinatorError(cancelled, run);
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
				const coordinator = existingAcpCoordinator();
				if (coordinator?.snapshot(run.worker).worker) {
					const released = await coordinator.execute({ action: "close", name: run.worker, force: true });
					if (!released.ok) throw coordinatorError(released, run);
				}
				run.closedAt = Date.now();
				delete run.parkedAt;
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
				if (coordinator?.snapshot(run.worker).worker) await coordinator.execute({ action: "close", name: run.worker, force: true }).catch(() => undefined);
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

function sessionText(v: AcpRunView): string {
	const id = v.session.nativeSessionId ?? "pending";
	const where = v.session.executionEnvironment ? ` (${v.session.executionEnvironment})` : "";
	return `${v.session.origin === "opened" ? "opened native session" : "session"} ${id}${where}`;
}

function turnText(v: AcpRunView): string | undefined {
	const t = v.turns.at(-1);
	if (!t) return undefined;
	const cause = t.failure ? `, cause ${t.failure.code}` : t.stopReason && t.stopReason !== "end_turn" ? `, stop reason ${t.stopReason}` : "";
	return `turn ${t.requestId}: ${t.status}, delivery ${t.delivery}${t.providerOutcome ? `, provider outcome ${t.providerOutcome}` : ""}${cause}${t.truncated ? ", output truncated" : ""}`;
}

export function acpSummary(v: AcpRunView): string {
	const dur = elapsed((v.endedAt ?? Date.now()) - v.startedAt);
	let tokensIn = 0, tokensOut = 0, cost = 0;
	for (const t of v.turns) {
		tokensIn += t.usage?.breakdown?.inputTokens ?? 0;
		tokensOut += t.usage?.breakdown?.outputTokens ?? 0;
		cost += t.usage?.cost?.amount ?? 0;
	}
	const head = [
		`${v.status} · ${v.id}`,
		`backend acp`,
		`agent ${v.session.agent}`,
		v.role ? `role ${v.role}` : "",
		v.model ? `model ${v.model}` : "",
		`${v.turns.length} turn${v.turns.length === 1 ? "" : "s"} in ${dur}`,
		tokensIn || tokensOut ? `tokens in ${tokensIn}, out ${tokensOut}` : "",
		cost ? `$${cost.toFixed(4)}` : "",
	].filter(Boolean).join(" · ");
	const lines = [head, sessionText(v)];
	const turn = turnText(v);
	if (turn) lines.push(turn);
	if (v.status === "idle") lines.push(v.session.origin === "opened" ? "idle: attached without sending a turn" : "idle");
	if (v.closed) lines.push(v.session.origin === "opened" ? "closed: disconnected; the native session is unchanged" : "closed: session disposed");
	if (v.parked) {
		const released = v.session.origin === "opened" ? "disconnected, the native session unchanged" : "its session closed and kept resumable";
		const reopen = v.session.origin === "opened" ? "steer reopens the same native session" : "steer resumes it";
		lines.push(`parked: the parent exited, ${released}; ${reopen}, close ends it${v.parked.interruptedTurn ? `. Turn ${v.parked.interruptedTurn} was still running then` : ""}`);
	}
	if (v.foreign) lines.push(`read-only: owned by another live Pi process (pid ${v.foreign.ownerPid} on ${v.foreign.ownerHost})`);
	if (v.error) lines.push(`error: ${v.error}`);
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
