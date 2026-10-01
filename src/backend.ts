/**
 * Backend-neutral delegation contract (todo 040, ADR docs/adr/0001-delegate-backends.md).
 *
 * Types and pure validation only. Nothing here runs a child or touches a Coordinator: 042 wires
 * `delegate`/`delegate_ctl` to a backend, 043 maps the lifecycle controls (acp-backend.ts).
 *
 * Rules this file pins:
 * - `backend` is "pi" (default, today's in-process children) or "acp" (Coordinator workers).
 *   An unknown backend fails. Nothing ever falls back from acp to pi.
 * - ACP-only fields are rejected on pi, and pi-only fields are rejected on acp, never ignored.
 * - A run keeps its delegate run ID, one provider request ID per turn, the native session ID,
 *   delivery and the provider outcome as separate fields. Accepted is not finished.
 * - An action a backend cannot do fails with ACTION_UNSUPPORTED. It never degrades to a different action.
 */
import type { NativeSessionDescription, RequestRecord, RuntimeHandle, SessionOrigin, UsageCost, WorkerRole } from "./acp/domain/types.js";
import type { RunView } from "./render.js";

// ---------------------------------------------------------------------------------------------
// Backend selection and inputs

export const BACKENDS = ["pi", "acp"] as const;
export type BackendName = (typeof BACKENDS)[number];
/** Omitting `backend` means pi, the current behavior. This is a default, not a fallback. */
export const DEFAULT_BACKEND: BackendName = "pi";

export const EXECUTION_ENVIRONMENTS = ["local", "orb"] as const;
export type ExecutionEnvironment = (typeof EXECUTION_ENVIRONMENTS)[number];

/** Accepted only with backend "acp". On pi each one is an error. */
export const ACP_ONLY_FIELDS = ["agent", "sessionId", "executionEnvironment", "mode"] as const;
/** Accepted only with backend "acp" and agent "amp". On any other agent each one is an error. */
export const AMP_ONLY_FIELDS = ["mode"] as const;
/** Accepted only with backend "pi". An ACP child cannot receive the parent conversation. */
export const PI_ONLY_FIELDS = ["context"] as const;
/** Opening an existing native session keeps its settings: these are creation-only (Coordinator rule). */
export const OPEN_FORBIDDEN_FIELDS = ["role", "model", "mode"] as const;

interface CommonStartInput {
	cwd?: string;
	/** Per-turn budget. On acp this is the request timeout of each turn. */
	timeoutMs?: number;
	sync?: boolean;
	reason?: string;
}

/** `delegate` on the pi backend: unchanged from today. */
export interface PiStartInput extends CommonStartInput {
	backend: "pi";
	/** A pi-delegate role name (delegate_ctl roles). */
	role: string;
	task: string;
	/** provider/id[:thinking] */
	model?: string;
	context?: "fork" | "fresh";
}

/** `delegate` on acp without `sessionId`: create a Coordinator worker and send `task` as its first turn. */
export interface AcpCreateInput extends CommonStartInput {
	backend: "acp";
	origin: Extract<SessionOrigin, "created">;
	agent: string;
	task: string;
	/** ACP worker permission role. Not a pi-delegate role name. The Coordinator defaults it to read-only. */
	role?: WorkerRole;
	/** The agent's own model ID. */
	model?: string;
	/** Where the session runs. Required for Amp: local or Orb is always an explicit choice, never an adapter default. */
	executionEnvironment?: ExecutionEnvironment;
	/** Amp only: its agent mode (low, medium, high, ultra or a plugin mode), `amp --mode` on every turn of the thread. */
	mode?: string;
}

/**
 * `delegate` on acp with `sessionId`: open an exact provider-native session (for example an Amp T-ID)
 * without taking ownership. `task`, when given, is sent as a native turn. Without it the run only
 * attaches, so status/result can observe the session without posting into it.
 */
export interface AcpOpenInput extends CommonStartInput {
	backend: "acp";
	origin: Extract<SessionOrigin, "opened">;
	agent: string;
	sessionId: string;
	task?: string;
	/** Amp only: a verification hint. The provider's executor metadata decides. */
	executionEnvironment?: ExecutionEnvironment;
}

export type AcpStartInput = AcpCreateInput | AcpOpenInput;
export type StartInput = PiStartInput | AcpStartInput;
export type StartInputFor<B extends BackendName> = B extends "pi" ? PiStartInput : AcpStartInput;

/** delegate_ctl steer: the next turn on the same run, transcript and run ID. */
export interface SteerRequest {
	message: string;
	/** pi: provider/id[:thinking]. acp created: the agent's model ID. Rejected on opened sessions. */
	model?: string;
	timeoutMs?: number;
	/** pi only: restart an explicitly stopped child. */
	restart?: boolean;
}

/** delegate_ctl wait. A timeout ends the wait only. It never cancels a run. */
export interface WaitRequest {
	runIds: readonly string[];
	mode: "any" | "all";
	timeoutMs?: number;
}

export interface CancelRequest {
	reason?: string;
}

/** delegate_ctl close (new). */
export interface CloseRequest {
	/** Close a run that has an active turn: cancel it first, with grace. */
	force?: boolean;
	/** Created ACP sessions only. An opened session is only disconnected, never archived or deleted. */
	discardPersistentState?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Capabilities

export const LIFECYCLE_ACTIONS = ["create", "open", "steer", "wait", "result", "status", "cancel", "close", "observe"] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

export type Unsupported = { supported: false; reason: string };
export type Capability<Detail extends object = {}> = ({ supported: true; note?: string } & Detail) | Unsupported;
/** "run": cancel stops the whole run. "own-turns": only a turn this run started can be cancelled. */
export type CancelScope = "run" | "own-turns";
/** "dispose": end the session this run created. "disconnect": leave the native session as it is. */
export type CloseEffect = "dispose" | "disconnect";

/** What a backend can do for one run. Check it before acting; never substitute another action. */
export interface BackendCapabilities {
	backend: BackendName;
	create: Capability;
	open: Capability;
	steer: Capability;
	wait: Capability;
	result: Capability;
	status: Capability;
	cancel: Capability<{ scope: CancelScope }>;
	close: Capability<{ effect: CloseEffect }>;
	/** Seeing turns from other participants in a shared native session. */
	observe: Capability;
}

export const PI_CAPABILITIES: Readonly<BackendCapabilities> = {
	backend: "pi",
	create: { supported: true },
	open: { supported: false, reason: "pi runs are in-process children; there is no external session to open by sessionId" },
	steer: { supported: true, note: "queued into a running child, or resumes a finished one in the background" },
	wait: { supported: true },
	result: { supported: true },
	status: { supported: true },
	cancel: { supported: true, scope: "run", note: "stops the child and disables automatic revival" },
	close: { supported: false, reason: "an in-process run holds no external process or session; use cancel" },
	observe: { supported: false, reason: "an in-process child has no other participants" },
};

/** The capability report for one ACP run. Cancel never reaches a turn someone else started. */
export function acpCapabilities(run: { origin: SessionOrigin; agent: string }): BackendCapabilities {
	const opened = run.origin === "opened";
	const amp = run.agent.toLowerCase() === "amp";
	return {
		backend: "acp",
		create: { supported: true },
		open: { supported: true, note: "fails NATIVE_OPEN_UNSUPPORTED when the adapter cannot verify native identity and disconnect" },
		steer: opened
			? { supported: true, note: "native send, undecorated, never retried; a parked run first reopens the same native ID" }
			: { supported: true, note: "next turn on the same ACP session; a parked run is first resumed, which fails RUN_NOT_RESUMABLE unless the adapter supports session/resume or session/load" },
		wait: { supported: true },
		result: { supported: true },
		status: { supported: true },
		cancel: { supported: true, scope: "own-turns", note: "ACP session cancel, with grace" },
		close: opened ? { supported: true, effect: "disconnect" } : { supported: true, effect: "dispose" },
		observe: opened && amp
			? { supported: true, note: "on demand only: one `amp threads export` per status/result call, messages after the last messageId returned" }
			: { supported: false, reason: opened ? `no observation path for agent ${run.agent}` : "a created session has no other participants" },
	};
}

// ---------------------------------------------------------------------------------------------
// Run views: identity, turns and outcomes stay distinct

/** Run status as the delegate tools and renderer know it. */
export type RunStatus = RunView["status"];
/** An opened ACP run with no turn of its own yet is idle. */
export type AcpRunStatus = RunStatus | "idle";
export type Delivery = NonNullable<RequestRecord["delivery"]>;

/** One provider request, which is one ACP turn. A projection of the Coordinator's RequestRecord. */
export type AcpTurnView = { requestId: RequestRecord["id"]; delivery: Delivery } & Pick<
	RequestRecord,
	"status" | "providerOutcome" | "startedAt" | "finishedAt" | "truncated" | "failure" | "stopReason" | "usage" | "requestedModel"
>;

/** Where an ACP run's session lives. None of these IDs is the delegate run ID. */
export interface AcpSessionView {
	agent: string;
	origin: SessionOrigin;
	/** Coordinator worker name. Internal to the backend; callers address the run by its run ID. */
	worker: string;
	/** Provider-native session ID, for example an Amp T-ID. Equals handle.agentSessionId when known. */
	nativeSessionId?: string;
	executionEnvironment?: NativeSessionDescription["executionEnvironment"];
	handle: Pick<RuntimeHandle, "runtimeSessionName" | "acpxRecordId" | "backendSessionId" | "agentSessionId">;
	/** Opened sessions: what the provider reported when the run attached. Created Amp sessions: what the adapter reported once it learned the T-ID. */
	native?: NativeSessionDescription;
	/** Created Amp threads: the labels delegate added once the T-ID was known (`amp threads label`). Opened threads are never labeled. */
	labels?: string[];
}

/**
 * An Amp thread's display cost, from `amp threads usage <T-ID>` (todo 058). Refreshed only by
 * delegate_ctl status/result for one run, and cached here with when it was read. Without `cost`
 * it is unknown: no thread ID yet, or the command failed. It covers the whole thread, so an opened
 * thread's cost includes other participants' work.
 */
export interface AmpThreadUsage {
	cost?: UsageCost;
	/** When usage was last read (ms). */
	at: number;
	threadId?: string;
	/** Why the cost is unknown. */
	error?: string;
}

export interface AcpRunView {
	backend: "acp";
	/** The delegate run ID. */
	id: string;
	status: AcpRunStatus;
	task?: string;
	cwd: string;
	role?: WorkerRole;
	model?: string;
	/** Created Amp runs: the agent mode delegate was given. */
	mode?: string;
	startedAt: number;
	endedAt?: number;
	session: AcpSessionView;
	/** One entry per provider request, in send order. */
	turns: AcpTurnView[];
	/** The latest turn's output, and whether the Coordinator truncated it. */
	output: string;
	truncated: boolean;
	capabilities: BackendCapabilities;
	error?: string;
	/** Set once delegate_ctl close released the session (disposed or disconnected, per capabilities.close). Final. */
	closed?: true;
	/**
	 * Set while the run is parked: its parent exited (or that process died) and the session was
	 * released the way close releases it, without the run being closed. Its record stays readable,
	 * and steer reopens it. `interruptedTurn` is a turn that was still running at that moment.
	 */
	parked?: { at: number; interruptedTurn?: string };
	/** Owned by another live Pi process: a read-only snapshot here. */
	foreign?: { ownerPid: number; ownerHost: string };
	/** Present only when this status/result call asked to observe (opened Amp runs): what that one export showed. */
	observation?: AmpObservation;
	/** Amp runs: the thread's cost as last read. It fills the run's cost; absent means it was never read. */
	usage?: AmpThreadUsage;
	/** Side effects that failed without failing the run, such as labeling a created Amp thread. */
	notes?: string[];
}

// ---------------------------------------------------------------------------------------------
// Observation of an opened Amp thread (todo 044)

/** One thread message as the export reported it. A field the export did not carry is "unknown", never inferred. */
export interface ObservedMessage {
	/** Amp's messageId, as text. */
	messageId: string;
	/** "user" or "assistant" as Amp labels it. Amp may label tool results as user messages. */
	role: string;
	/** Who sent it. The export has no per-message author today, so this is "unknown" unless it carries one. */
	author: string;
	createdAt: string;
	/** Text blocks verbatim; other blocks as a [type] marker. */
	text: string;
	/** This message's text was cut to fit the output bound. */
	truncated?: true;
	/** The rest of a message an earlier observation cut: `text` starts where that one ended. */
	continued?: true;
}

/**
 * The result of one `amp threads export` for a status/result call.
 * - changed: messages after this run's cursor (possibly none, when only the thread version moved).
 * - unchanged: the thread's v and updatedAt match the last observation, which left nothing unread.
 * - unknown: the export failed or was unreadable. The cursor did not move. Nothing is inferred.
 */
export interface AmpObservation {
	threadId: string;
	/** When the export ran (ISO). */
	at: string;
	state: "changed" | "unchanged" | "unknown";
	/** The thread's version counter (export `v`), when present. */
	version?: number;
	updatedAt?: string;
	/** Messages after the last one this run was shown, oldest first. */
	messages: ObservedMessage[];
	/** Messages after these that the output bound left for the next observe. */
	remaining: number;
	/** The bound cut this observation short: either `remaining` > 0 or a message's text was cut. */
	truncated: boolean;
	/** The bound in bytes (the session's maxOutputBytes). */
	maxBytes: number;
	/** The saved cursor was not in this export, so messages are listed from the start of the thread. */
	cursorReset?: true;
	/** Why the state is unknown. */
	error?: string;
}

export type PiRunView = RunView & { backend: "pi" };
export type DelegateRunView = PiRunView | AcpRunView;
export type RunViewFor<B extends BackendName> = B extends "pi" ? PiRunView : AcpRunView;

export interface WaitOutcome<V> {
	/** settled: the mode is satisfied. timeout: runs keep going. interrupted: queued parent messages. lost: a run stopped without settling. */
	reason: "settled" | "timeout" | "interrupted" | "lost";
	settled: V[];
	pending: string[];
}

// ---------------------------------------------------------------------------------------------
// The backend interface

/**
 * Both backends implement this. The tool layer validates input with this module, picks the backend
 * by `backend` (start) or by the run's recorded backend (every other action), checks capabilities,
 * then calls exactly one method.
 */
export interface DelegateBackend<B extends BackendName = BackendName> {
	readonly name: B;
	/** For one run, or for a new run when omitted. */
	capabilities(run?: RunViewFor<B>): BackendCapabilities;
	/** Create a run, or (acp) open an existing native session, and send its first turn when there is a task. */
	start(input: StartInputFor<B>, signal?: AbortSignal): Promise<RunViewFor<B>>;
	/** Send the next turn on the same run. */
	steer(runId: string, input: SteerRequest): Promise<RunViewFor<B>>;
	/** Join runs. Never cancels them, including on timeout or abort. */
	wait(request: WaitRequest, signal?: AbortSignal): Promise<WaitOutcome<RunViewFor<B>>>;
	/** The current report without waiting. */
	result(runId: string): Promise<RunViewFor<B>>;
	/** The named runs, or every run this parent owns when runIds is omitted. */
	status(runIds?: readonly string[]): Promise<RunViewFor<B>[]>;
	/** Cooperative, with grace. Scope is in capabilities().cancel. */
	cancel(runId: string, input: CancelRequest): Promise<RunViewFor<B>>;
	/** Release the run's session. Effect is in capabilities().close. */
	close(runId: string, input: CloseRequest): Promise<RunViewFor<B>>;
}

// ---------------------------------------------------------------------------------------------
// Pure validation

export type ContractErrorCode =
	| "UNKNOWN_BACKEND"
	| "FIELD_REQUIRES_ACP"
	| "FIELD_NOT_ON_ACP"
	| "FIELD_REQUIRES_AMP"
	| "OPEN_OVERRIDE_FORBIDDEN"
	| "INPUT_INVALID"
	| "ACTION_UNSUPPORTED";

export interface ContractError {
	code: ContractErrorCode;
	message: string;
	field?: string;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: ContractError };

const fail = (code: ContractErrorCode, message: string, field?: string): { ok: false; error: ContractError } =>
	({ ok: false, error: field === undefined ? { code, message } : { code, message, field } });

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
/** An ACP agent name as the backend starts it. Validation and start both read it through this. */
export const acpAgentName = (agent: string): string => agent.trim().toLowerCase();
const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);

function commonFields(raw: Record<string, unknown>): Validated<CommonStartInput> {
	const out: CommonStartInput = {};
	if (raw.cwd !== undefined) {
		if (!isNonEmptyString(raw.cwd)) return fail("INPUT_INVALID", "cwd must be a non-empty string", "cwd");
		out.cwd = raw.cwd;
	}
	if (raw.timeoutMs !== undefined) {
		if (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0) return fail("INPUT_INVALID", "timeoutMs must be a positive number", "timeoutMs");
		out.timeoutMs = raw.timeoutMs;
	}
	if (raw.sync !== undefined) {
		if (typeof raw.sync !== "boolean") return fail("INPUT_INVALID", "sync must be a boolean", "sync");
		out.sync = raw.sync;
	}
	if (raw.reason !== undefined) {
		if (typeof raw.reason !== "string") return fail("INPUT_INVALID", "reason must be a string", "reason");
		out.reason = raw.reason;
	}
	return { ok: true, value: out };
}

/** Read `backend`. Omitted means pi. Anything that is not exactly "pi" or "acp" is an error. */
export function selectBackend(raw: Record<string, unknown>): Validated<BackendName> {
	if (raw.backend === undefined) return { ok: true, value: DEFAULT_BACKEND };
	if (!isOneOf(BACKENDS, raw.backend)) return fail("UNKNOWN_BACKEND", `unknown backend ${JSON.stringify(raw.backend)}; use "pi" or "acp"`, "backend");
	return { ok: true, value: raw.backend };
}

/** Validate raw `delegate` parameters into a typed start input. Pure: no IO, no defaults beyond `backend`. */
export function validateStartInput(raw: Record<string, unknown>): Validated<StartInput> {
	const backend = selectBackend(raw);
	if (!backend.ok) return backend;
	const common = commonFields(raw);
	if (!common.ok) return common;

	if (backend.value === "pi") {
		for (const field of ACP_ONLY_FIELDS) {
			if (raw[field] !== undefined) return fail("FIELD_REQUIRES_ACP", `${field} is ACP-only; pass backend "acp" to use it`, field);
		}
		if (!isNonEmptyString(raw.role)) return fail("INPUT_INVALID", "role is required: a pi-delegate role name", "role");
		if (!isNonEmptyString(raw.task)) return fail("INPUT_INVALID", "task is required", "task");
		const value: PiStartInput = { backend: "pi", role: raw.role, task: raw.task, ...common.value };
		if (raw.model !== undefined) {
			if (!isNonEmptyString(raw.model)) return fail("INPUT_INVALID", "model must be a non-empty string", "model");
			value.model = raw.model;
		}
		if (raw.context !== undefined) {
			if (raw.context !== "fork" && raw.context !== "fresh") return fail("INPUT_INVALID", 'context must be "fork" or "fresh"', "context");
			value.context = raw.context;
		}
		return { ok: true, value };
	}

	for (const field of PI_ONLY_FIELDS) {
		if (raw[field] !== undefined) return fail("FIELD_NOT_ON_ACP", `${field} is pi-only; an ACP child cannot receive the parent conversation`, field);
	}
	if (!isNonEmptyString(raw.agent)) return fail("INPUT_INVALID", "agent is required with backend \"acp\"", "agent");
	const agent = acpAgentName(raw.agent);
	if (agent !== "amp") {
		for (const field of AMP_ONLY_FIELDS) {
			if (raw[field] !== undefined) return fail("FIELD_REQUIRES_AMP", `${field} is Amp-only; agent ${agent} has no ${field}`, field);
		}
	}
	let executionEnvironment: ExecutionEnvironment | undefined;
	if (raw.executionEnvironment !== undefined) {
		if (!isOneOf(EXECUTION_ENVIRONMENTS, raw.executionEnvironment)) return fail("INPUT_INVALID", 'executionEnvironment must be "local" or "orb"', "executionEnvironment");
		executionEnvironment = raw.executionEnvironment;
	}
	if (raw.task !== undefined && !isNonEmptyString(raw.task)) return fail("INPUT_INVALID", "task must be a non-empty string", "task");
	const task = raw.task as string | undefined;

	if (raw.sessionId !== undefined) {
		if (!isNonEmptyString(raw.sessionId)) return fail("INPUT_INVALID", "sessionId must be a non-empty string", "sessionId");
		for (const field of OPEN_FORBIDDEN_FIELDS) {
			if (raw[field] !== undefined) return fail("OPEN_OVERRIDE_FORBIDDEN", `opening keeps native settings; ${field} is creation-only`, field);
		}
		if (executionEnvironment && agent !== "amp") return fail("OPEN_OVERRIDE_FORBIDDEN", "only Amp accepts an executionEnvironment hint when opening a native session", "executionEnvironment");
		const value: AcpOpenInput = { backend: "acp", origin: "opened", agent, sessionId: raw.sessionId, ...common.value };
		if (task !== undefined) value.task = task;
		if (executionEnvironment) value.executionEnvironment = executionEnvironment;
		return { ok: true, value };
	}

	if (task === undefined) return fail("INPUT_INVALID", "task is required unless sessionId opens an existing session", "task");
	const value: AcpCreateInput = { backend: "acp", origin: "created", agent, task, ...common.value };
	if (raw.role !== undefined) {
		if (raw.role !== "read-only" && raw.role !== "writer") return fail("INPUT_INVALID", 'ACP role is "read-only" or "writer", not a pi-delegate role name', "role");
		value.role = raw.role;
	}
	if (raw.model !== undefined) {
		if (!isNonEmptyString(raw.model)) return fail("INPUT_INVALID", "model must be a non-empty string", "model");
		value.model = raw.model;
	}
	if (raw.mode !== undefined) {
		// `amp --mode` takes the value as its own argument: a value that reads as an option is refused.
		if (!isNonEmptyString(raw.mode) || raw.mode.trim().startsWith("-") || /[\r\n]/.test(raw.mode)) return fail("INPUT_INVALID", "mode must be an Amp mode name: low, medium, high, ultra or a plugin mode", "mode");
		// model on Amp selects the same mode from the advertised list; one field decides.
		if (value.model !== undefined) return fail("INPUT_INVALID", "on Amp, mode and model both select the agent mode; pass mode", "mode");
		value.mode = raw.mode.trim();
	}
	// Amp runs either on this machine or in an Orb; a new Amp session names which, never an adapter default.
	if (!executionEnvironment && agent === "amp") return fail("INPUT_INVALID", 'creating an Amp session needs executionEnvironment "local" or "orb"', "executionEnvironment");
	if (executionEnvironment) value.executionEnvironment = executionEnvironment;
	return { ok: true, value };
}

/** Fail explicitly when the backend cannot do `action` for this run. */
export function requireAction(capabilities: BackendCapabilities, action: LifecycleAction): Validated<Capability> {
	const capability: Capability = capabilities[action];
	if (!capability.supported) return fail("ACTION_UNSUPPORTED", `${action} is not supported on the ${capabilities.backend} backend: ${capability.reason}`);
	return { ok: true, value: capability };
}

/** Validate delegate_ctl steer for a run's backend and origin. */
export function validateSteer(run: { backend: BackendName; origin?: SessionOrigin }, raw: Record<string, unknown>): Validated<SteerRequest> {
	if (!isNonEmptyString(raw.message)) return fail("INPUT_INVALID", "steer requires message", "message");
	const value: SteerRequest = { message: raw.message };
	if (raw.restart !== undefined) {
		if (run.backend !== "pi") return fail("FIELD_NOT_ON_ACP", "restart is pi-only", "restart");
		if (typeof raw.restart !== "boolean") return fail("INPUT_INVALID", "restart must be a boolean", "restart");
		value.restart = raw.restart;
	}
	if (raw.model !== undefined) {
		if (run.backend === "acp" && run.origin === "opened") return fail("OPEN_OVERRIDE_FORBIDDEN", "an opened session keeps its native model", "model");
		if (!isNonEmptyString(raw.model)) return fail("INPUT_INVALID", "model must be a non-empty string", "model");
		value.model = raw.model;
	}
	if (raw.timeoutMs !== undefined) {
		if (typeof raw.timeoutMs !== "number" || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0) return fail("INPUT_INVALID", "timeoutMs must be a positive number", "timeoutMs");
		value.timeoutMs = raw.timeoutMs;
	}
	return { ok: true, value };
}

/** Cancel reaches only what the backend's scope allows. `activeTurn` says who started the turn that is running. */
export function checkCancel(capabilities: BackendCapabilities, activeTurn: "own" | "foreign" | "none"): Validated<Capability<{ scope: CancelScope }>> {
	const cancel = capabilities.cancel;
	if (!cancel.supported) return fail("ACTION_UNSUPPORTED", `cancel is not supported on the ${capabilities.backend} backend: ${cancel.reason}`);
	if (cancel.scope === "own-turns" && activeTurn === "foreign") return fail("ACTION_UNSUPPORTED", "cancelling a turn this run did not start is unsupported");
	return { ok: true, value: cancel };
}

/** Close never discards an opened session's state. */
export function checkClose(capabilities: BackendCapabilities, request: CloseRequest): Validated<Capability<{ effect: CloseEffect }>> {
	const close = capabilities.close;
	if (!close.supported) return fail("ACTION_UNSUPPORTED", `close is not supported on the ${capabilities.backend} backend: ${close.reason}`);
	if (close.effect === "disconnect" && request.discardPersistentState === true) return fail("OPEN_OVERRIDE_FORBIDDEN", "disconnect cannot discard a native session", "discardPersistentState");
	return { ok: true, value: close };
}

// ---------------------------------------------------------------------------------------------
// Pure projections

/** Project a Coordinator request. A missing delivery is "unknown", never "accepted". */
export function turnView(record: RequestRecord): AcpTurnView {
	const view: AcpTurnView = { requestId: record.id, delivery: record.delivery ?? "unknown", status: record.status, startedAt: record.startedAt, truncated: record.truncated };
	if (record.providerOutcome !== undefined) view.providerOutcome = record.providerOutcome;
	if (record.finishedAt !== undefined) view.finishedAt = record.finishedAt;
	if (record.failure !== undefined) view.failure = record.failure;
	if (record.stopReason !== undefined) view.stopReason = record.stopReason;
	if (record.usage !== undefined) view.usage = record.usage;
	if (record.requestedModel !== undefined) view.requestedModel = record.requestedModel;
	return view;
}

const REQUEST_TO_RUN: Record<RequestRecord["status"], RunStatus> = {
	running: "running",
	completed: "complete",
	cancelled: "cancelled",
	timed_out: "timeout",
	failed: "error",
};

/** Run status from the latest turn. Delivery does not finish a run: accepted and running is running. */
export function acpRunStatus(turns: readonly Pick<AcpTurnView, "status">[]): AcpRunStatus {
	const last = turns.at(-1);
	return last ? REQUEST_TO_RUN[last.status] : "idle";
}
