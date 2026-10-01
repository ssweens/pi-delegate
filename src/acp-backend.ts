/**
 * The `acp` backend (todo 042): `delegate`/`delegate_ctl` over the process's one Coordinator.
 *
 * Each mapping is thin and keeps Coordinator semantics (043 hardens the lifecycle):
 * create = spawn + first send, open = spawn with sessionId (+ send when there is a task),
 * steer = send, wait = Coordinator wait (a timeout never cancels), cancel = cancel of a turn this
 * run started, close = close (dispose created, disconnect opened). A run is addressed by its
 * delegate run ID; the Coordinator worker name stays internal.
 */
import { randomUUID } from "node:crypto";
import type { RequestRecord, SessionOrigin, StringsResponse, WorkerRecord, WorkerRole } from "./acp/domain/types.js";
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
import { elapsed } from "./render.js";
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

/** What this backend records about a run. The Coordinator owns the session and its turns. */
interface AcpRunRecord {
	id: string;
	ownerKey: string;
	/** Coordinator worker name. Internal: never shown in text, never accepted from a caller. */
	worker: string;
	agent: string;
	origin: SessionOrigin;
	task?: string;
	cwd: string;
	role?: WorkerRole;
	model?: string;
	/** Per-turn budget from delegate; steer reuses it unless it passes its own. */
	timeoutMs?: number;
	startedAt: number;
	closedAt?: number;
	/** Last seen worker and turns, so a closed run (or a Coordinator not yet restored) still shows its session. */
	last?: { worker?: WorkerRecord; requests: RequestRecord[] };
	/** What each turn was sent, by request ID, for the child view. */
	prompts: Record<string, string>;
	/** Joined delegate_ctl waits. A turn that settles while one is joined reports to it instead of waking the parent. */
	waiters: number;
	/** Turns a joined wait already returned: their settlement was delivered, so they wake no one. */
	claimed: Set<string>;
}

// Process-wide like the pi runtime state: a /reload rebinds the tools, the runs stay.
const RUNS_KEY = Symbol.for("@ssweens/pi-delegate/acp-runs/1");
const registry = (): Map<string, AcpRunRecord> => {
	const g = globalThis as typeof globalThis & { [RUNS_KEY]?: Map<string, AcpRunRecord> };
	return g[RUNS_KEY] ??= new Map();
};

const WAIT_SLICE_MS = 1000;
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

function view(run: AcpRunRecord): AcpRunView {
	const live = existingAcpCoordinator()?.snapshot(run.worker);
	// A closed worker leaves the Coordinator, and a restored one may not be loaded yet: keep what was last seen.
	if (live?.worker) run.last = { worker: live.worker, requests: live.requests };
	else if (live?.requests.length) run.last = { ...run.last, requests: live.requests };
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
			...(worker?.native ? { executionEnvironment: worker.native.executionEnvironment, native: worker.native } : {}),
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
	if (latest?.failure) v.error = `${latest.failure.code}: ${latest.failure.message}`;
	return v;
}

export interface AcpBackendHooks {
	/** The attached parent's key. Throws when no parent is attached. */
	ownerKey(): string;
	/** Something a view shows changed: repaint the Agents frame. */
	changed(): void;
	/** A turn settled while no wait was joined to its run: wake that run's parent. */
	settled(view: AcpRunView, ownerKey: string): void;
}

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

	owned(ownerKey: string): AcpRunView[] {
		return [...registry().values()].filter((run) => run.ownerKey === ownerKey).map(view);
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
			cwd: input.cwd ?? process.cwd(), startedAt: Date.now(), prompts: {}, waiters: 0, claimed: new Set(),
		};
		if (input.task !== undefined) run.task = input.task;
		if (input.timeoutMs !== undefined) run.timeoutMs = input.timeoutMs;
		const spawn: Record<string, unknown> & { action: string } = { action: "spawn", name: run.worker, agent };
		if (input.cwd !== undefined) spawn.cwd = input.cwd;
		if (input.executionEnvironment) spawn.executionEnvironment = input.executionEnvironment;
		if (input.origin === "opened") spawn.sessionId = input.sessionId;
		else {
			if (input.role) { spawn.role = input.role; run.role = input.role; }
			if (input.model) { spawn.model = input.model; run.model = input.model; }
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
		this.hooks.changed();
		return view(run);
	}

	async steer(runId: string, input: SteerRequest): Promise<AcpRunView> {
		const run = this.get(runId);
		unwrap(requireAction(acpCapabilities(run), "steer"));
		if (run.closedAt !== undefined) throw new DelegateError("RUN_CLOSED", `${run.id} is closed; start a new run with delegate`);
		const timeoutMs = input.timeoutMs ?? run.timeoutMs;
		const coordinator = await acpCoordinator();
		const sent = await coordinator.execute({
			action: "send", name: run.worker, prompt: input.message,
			...(input.model !== undefined ? { model: input.model } : {}),
			...(timeoutMs !== undefined ? { requestTimeoutMs: timeoutMs } : {}),
		});
		if (!sent.ok) throw coordinatorError(sent, run);
		if (input.model !== undefined) run.model = input.model;
		run.prompts[String(sent.details.requestId)] = input.message;
		this.watch(run, String(sent.details.requestId));
		this.hooks.changed();
		return view(run);
	}

	/**
	 * Join runs until the mode is satisfied. A timeout, an abort or queued parent messages end the
	 * wait only: nothing is cancelled. Coordinator waits are sliced so those checks stay prompt.
	 */
	async wait(request: WaitRequest, signal?: AbortSignal, interrupted?: () => boolean): Promise<WaitOutcome<AcpRunView>> {
		const runs = request.runIds.map((id) => this.get(id));
		for (const run of runs) unwrap(requireAction(acpCapabilities(run), "wait"));
		const deadline = request.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + request.timeoutMs;
		for (const run of runs) run.waiters += 1;
		try {
			for (;;) {
				const views = runs.map(view);
				const settled = views.filter((v) => v.status !== "running");
				const pending = views.filter((v) => v.status === "running");
				if (request.mode === "any" ? settled.length > 0 : pending.length === 0) {
					for (const v of settled) { const turn = v.turns.at(-1); if (turn) registry().get(v.id)?.claimed.add(turn.requestId); }
					return { reason: "settled", settled, pending: pending.map((v) => v.id) };
				}
				if (signal?.aborted) throw new DOMException("Wait cancelled; the runs are unaffected.", "AbortError");
				if (interrupted?.()) return { reason: "interrupted", settled, pending: pending.map((v) => v.id) };
				const left = deadline - Date.now();
				if (left <= 0) return { reason: "timeout", settled, pending: pending.map((v) => v.id) };
				const coordinator = existingAcpCoordinator();
				if (!coordinator) return { reason: "lost", settled, pending: pending.map((v) => v.id) };
				const waited = await coordinator.execute({ action: "wait", names: pending.map((v) => v.session.worker), mode: "any", waitTimeoutMs: Math.min(WAIT_SLICE_MS, left) });
				if (!waited.ok) {
					if (waited.error.code === "COORDINATOR_SHUTTING_DOWN") return { reason: "lost", settled, pending: pending.map((v) => v.id) };
					throw coordinatorError(waited);
				}
			}
		} finally {
			for (const run of runs) run.waiters -= 1;
		}
	}

	async result(runId: string): Promise<AcpRunView> {
		const run = this.get(runId);
		unwrap(requireAction(acpCapabilities(run), "result"));
		return view(run);
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
		const current = view(run);
		// Every turn this run can see is one it sent: a turn another participant started is not a request here.
		unwrap(checkCancel(current.capabilities, current.status === "running" ? "own" : "none"));
		if (current.status !== "running") throw new DelegateError("WORKER_NOT_RUNNING", `${run.id} has no active turn to cancel`);
		const coordinator = await acpCoordinator();
		const cancelled = await coordinator.execute({ action: "cancel", name: run.worker, ...(input.reason ? { reason: input.reason } : {}) });
		this.hooks.changed();
		if (!cancelled.ok) throw coordinatorError(cancelled, run);
		return view(run);
	}

	async close(runId: string, input: CloseRequest): Promise<AcpRunView> {
		const run = this.get(runId);
		if (run.closedAt !== undefined) return view(run);
		unwrap(checkClose(acpCapabilities(run), input));
		const coordinator = await acpCoordinator();
		view(run); // Keep the session as last seen: the Coordinator forgets a closed worker.
		const closed = await coordinator.execute({
			action: "close", name: run.worker,
			...(input.force !== undefined ? { force: input.force } : {}),
			...(input.discardPersistentState !== undefined ? { discardPersistentState: input.discardPersistentState } : {}),
		});
		if (!closed.ok) { this.hooks.changed(); throw coordinatorError(closed, run); }
		run.closedAt = Date.now();
		this.hooks.changed();
		return view(run);
	}

	/** Parent exit: release every session this parent holds, then forget its runs. */
	async closeOwner(ownerKey: string): Promise<void> {
		const coordinator = existingAcpCoordinator();
		for (const run of [...registry().values()]) {
			if (run.ownerKey !== ownerKey) continue;
			if (coordinator && run.closedAt === undefined) await coordinator.execute({ action: "close", name: run.worker, force: true }).catch(() => undefined);
			registry().delete(run.id);
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
			this.hooks.changed();
			const current = view(run);
			if (!registry().has(run.id) || run.waiters > 0 || run.claimed.has(requestId) || current.turns.at(-1)?.requestId !== requestId) return;
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
	return `turn ${t.requestId}: ${t.status}, delivery ${t.delivery}${t.providerOutcome ? `, provider outcome ${t.providerOutcome}` : ""}${t.truncated ? ", output truncated" : ""}`;
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
	if (v.error) lines.push(`error: ${v.error}`);
	return lines.join("\n");
}

/** The agent's words are quoted, never blended into this tool's own reporting. */
export function acpResultText(v: AcpRunView): string {
	if (!v.turns.length) return acpSummary(v);
	return `${acpSummary(v)}\n\n----- ${v.id} reported, verbatim -----\n${v.output || "(the turn ended without output)"}\n----- end of report -----`;
}
