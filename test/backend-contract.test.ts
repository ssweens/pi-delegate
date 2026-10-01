import assert from "node:assert/strict";
import { test } from "node:test";
import type { RequestRecord } from "../src/acp/domain/types.ts";
import {
	ACP_ONLY_FIELDS,
	acpCapabilities,
	acpRunStatus,
	type AcpRunView,
	type AcpStartInput,
	type AcpTurnView,
	type BackendCapabilities,
	checkCancel,
	checkClose,
	type DelegateBackend,
	type DelegateRunView,
	LIFECYCLE_ACTIONS,
	PI_CAPABILITIES,
	type PiStartInput,
	requireAction,
	selectBackend,
	turnView,
	validateStartInput,
	validateSteer,
} from "../src/backend.ts";

const errorOf = (result: { ok: boolean; error?: { code: string; field?: string } }) => {
	assert.equal(result.ok, false, "expected a contract error");
	return result.error!;
};

// --- backend selection --------------------------------------------------------------------

test("omitting backend selects pi, the current behavior", () => {
	assert.deepEqual(selectBackend({}), { ok: true, value: "pi" });
	const result = validateStartInput({ role: "scout", task: "look" });
	assert.deepEqual(result, { ok: true, value: { backend: "pi", role: "scout", task: "look" } });
});

test("an unknown backend fails instead of falling back", () => {
	for (const backend of ["ACP", "amp", "", null, 1]) {
		const error = errorOf(validateStartInput({ backend, role: "scout", task: "t", agent: "amp" }));
		assert.equal(error.code, "UNKNOWN_BACKEND");
		assert.equal(error.field, "backend");
	}
});

// --- pi backend --------------------------------------------------------------------------

test("pi rejects every ACP-only field, including when backend is omitted", () => {
	const values = { agent: "amp", sessionId: "T-123", executionEnvironment: "orb" } as const;
	for (const field of ACP_ONLY_FIELDS) {
		for (const backend of ["pi", undefined]) {
			const error = errorOf(validateStartInput({ backend, role: "scout", task: "t", [field]: values[field] }));
			assert.equal(error.code, "FIELD_REQUIRES_ACP");
			assert.equal(error.field, field);
		}
	}
});

test("pi keeps today's fields and requires a role name and a task", () => {
	const ok = validateStartInput({ backend: "pi", role: "worker", task: "do it", model: "openai/gpt-5:high", context: "fresh", cwd: "/repo", timeoutMs: 60_000, sync: true, reason: "cheap" });
	assert.deepEqual(ok, { ok: true, value: { backend: "pi", role: "worker", task: "do it", model: "openai/gpt-5:high", context: "fresh", cwd: "/repo", timeoutMs: 60_000, sync: true, reason: "cheap" } });
	assert.equal(errorOf(validateStartInput({ task: "t" })).field, "role");
	assert.equal(errorOf(validateStartInput({ role: "scout" })).field, "task");
	assert.equal(errorOf(validateStartInput({ role: "scout", task: "t", context: "shared" })).field, "context");
	assert.equal(errorOf(validateStartInput({ role: "scout", task: "t", timeoutMs: -1 })).field, "timeoutMs");
});

// --- acp backend -------------------------------------------------------------------------

test("acp create requires an explicit agent and a task, and never defaults to pi", () => {
	const ok = validateStartInput({ backend: "acp", agent: "amp", task: "fix it", role: "writer", model: "gpt-5", cwd: "/repo", executionEnvironment: "local" });
	assert.deepEqual(ok, { ok: true, value: { backend: "acp", origin: "created", agent: "amp", task: "fix it", role: "writer", model: "gpt-5", cwd: "/repo", executionEnvironment: "local" } });
	assert.equal(errorOf(validateStartInput({ backend: "acp", task: "t" })).field, "agent");
	assert.equal(errorOf(validateStartInput({ backend: "acp", agent: "pi" })).field, "task");
});

test("acp rejects pi-only context and pi role names", () => {
	const context = errorOf(validateStartInput({ backend: "acp", agent: "amp", task: "t", context: "fork" }));
	assert.deepEqual([context.code, context.field], ["FIELD_NOT_ON_ACP", "context"]);
	const role = errorOf(validateStartInput({ backend: "acp", agent: "amp", task: "t", role: "scout" }));
	assert.deepEqual([role.code, role.field], ["INPUT_INVALID", "role"]);
});

test("executionEnvironment is local or orb", () => {
	const error = errorOf(validateStartInput({ backend: "acp", agent: "amp", task: "t", executionEnvironment: "cloud" }));
	assert.deepEqual([error.code, error.field], ["INPUT_INVALID", "executionEnvironment"]);
});

test("a new Amp session names local or orb; other agents and opening may omit it", () => {
	const missing = errorOf(validateStartInput({ backend: "acp", agent: "Amp", task: "t" }));
	assert.deepEqual([missing.code, missing.field], ["INPUT_INVALID", "executionEnvironment"]);
	assert.equal(validateStartInput({ backend: "acp", agent: "amp", task: "t", executionEnvironment: "orb" }).ok, true);
	assert.equal(validateStartInput({ backend: "acp", agent: "pi", task: "t" }).ok, true);
	assert.equal(validateStartInput({ backend: "acp", agent: "amp", sessionId: "T-019a" }).ok, true, "opening takes the executor Amp reports");
});

test("the agent name is normalized as the backend starts it: a padded Amp is Amp", () => {
	const padded = errorOf(validateStartInput({ backend: "acp", agent: "amp ", task: "t" }));
	assert.deepEqual([padded.code, padded.field], ["INPUT_INVALID", "executionEnvironment"]);
	const opened = validateStartInput({ backend: "acp", agent: " Amp", sessionId: "T-019a", executionEnvironment: "orb" });
	assert.deepEqual(opened, { ok: true, value: { backend: "acp", origin: "opened", agent: "amp", sessionId: "T-019a", executionEnvironment: "orb" } });
});

test("acp open-existing takes sessionId, keeps native settings and may skip the task", () => {
	const ok = validateStartInput({ backend: "acp", agent: "amp", sessionId: "T-019a", executionEnvironment: "orb" });
	assert.deepEqual(ok, { ok: true, value: { backend: "acp", origin: "opened", agent: "amp", sessionId: "T-019a", executionEnvironment: "orb" } });
	const withTask = validateStartInput({ backend: "acp", agent: "amp", sessionId: "T-019a", task: "next step" });
	assert.equal(withTask.ok && withTask.value.backend === "acp" && withTask.value.origin === "opened" && withTask.value.task, "next step");
	for (const field of ["role", "model"]) {
		const error = errorOf(validateStartInput({ backend: "acp", agent: "amp", sessionId: "T-019a", [field]: field === "role" ? "writer" : "gpt-5" }));
		assert.deepEqual([error.code, error.field], ["OPEN_OVERRIDE_FORBIDDEN", field]);
	}
	const hint = errorOf(validateStartInput({ backend: "acp", agent: "pi", sessionId: "abc", executionEnvironment: "local" }));
	assert.deepEqual([hint.code, hint.field], ["OPEN_OVERRIDE_FORBIDDEN", "executionEnvironment"]);
});

// --- capabilities --------------------------------------------------------------------------

test("every capability report covers every lifecycle action for both backends", () => {
	const reports = [PI_CAPABILITIES, acpCapabilities({ origin: "created", agent: "pi" }), acpCapabilities({ origin: "opened", agent: "amp" })];
	for (const report of reports) {
		for (const action of LIFECYCLE_ACTIONS) {
			const capability = report[action];
			assert.equal(typeof capability.supported, "boolean", `${report.backend} ${action}`);
			if (!capability.supported) assert.ok(capability.reason.length > 0, `${report.backend} ${action} needs a reason`);
		}
	}
});

test("unsupported actions fail explicitly with the backend's reason", () => {
	const open = errorOf(requireAction(PI_CAPABILITIES, "open"));
	assert.equal(open.code, "ACTION_UNSUPPORTED");
	assert.equal(errorOf(requireAction(PI_CAPABILITIES, "close")).code, "ACTION_UNSUPPORTED");
	assert.equal(requireAction(PI_CAPABILITIES, "steer").ok, true);
	assert.equal(errorOf(requireAction(acpCapabilities({ origin: "created", agent: "amp" }), "observe")).code, "ACTION_UNSUPPORTED");
	assert.equal(requireAction(acpCapabilities({ origin: "opened", agent: "amp" }), "observe").ok, true);
});

test("ACP cancel covers only turns this run started", () => {
	const caps = acpCapabilities({ origin: "opened", agent: "amp" });
	assert.equal(checkCancel(caps, "own").ok, true);
	const foreign = errorOf(checkCancel(caps, "foreign"));
	assert.equal(foreign.code, "ACTION_UNSUPPORTED");
	assert.equal(checkCancel(PI_CAPABILITIES, "own").ok, true);
});

test("close disposes created ACP sessions and only disconnects opened ones", () => {
	const created = acpCapabilities({ origin: "created", agent: "pi" });
	const opened = acpCapabilities({ origin: "opened", agent: "amp" });
	assert.deepEqual(checkClose(created, { discardPersistentState: true }), { ok: true, value: created.close });
	assert.equal(created.close.supported && created.close.effect, "dispose");
	assert.equal(opened.close.supported && opened.close.effect, "disconnect");
	assert.equal(checkClose(opened, {}).ok, true);
	const discard = errorOf(checkClose(opened, { discardPersistentState: true }));
	assert.deepEqual([discard.code, discard.field], ["OPEN_OVERRIDE_FORBIDDEN", "discardPersistentState"]);
	assert.equal(errorOf(checkClose(PI_CAPABILITIES, {})).code, "ACTION_UNSUPPORTED");
});

test("steer validation follows the run's backend and origin", () => {
	assert.deepEqual(validateSteer({ backend: "pi" }, { message: "go", restart: true, model: "a/b" }), { ok: true, value: { message: "go", restart: true, model: "a/b" } });
	assert.equal(errorOf(validateSteer({ backend: "acp", origin: "created" }, { message: "go", restart: true })).code, "FIELD_NOT_ON_ACP");
	assert.equal(validateSteer({ backend: "acp", origin: "created" }, { message: "go", model: "gpt-5" }).ok, true);
	assert.equal(errorOf(validateSteer({ backend: "acp", origin: "opened" }, { message: "go", model: "gpt-5" })).code, "OPEN_OVERRIDE_FORBIDDEN");
	assert.equal(errorOf(validateSteer({ backend: "pi" }, {})).field, "message");
});

// --- result shape: identities and outcomes stay distinct ----------------------------------

const request = (over: Partial<RequestRecord>): RequestRecord => ({
	id: "req_1", workerName: "w-amp", status: "running", startedAt: "2026-09-30T10:00:00.000Z",
	output: "", truncated: false, eventPath: "/state/req_1.ndjson", ...over,
});

test("a turn with no recorded delivery is unknown, never accepted", () => {
	assert.equal(turnView(request({})).delivery, "unknown");
	assert.equal(turnView(request({ delivery: "accepted" })).delivery, "accepted");
	const done = turnView(request({ id: "req_2", status: "completed", delivery: "accepted", providerOutcome: "completed", finishedAt: "2026-09-30T10:01:00.000Z", truncated: true }));
	assert.deepEqual(done, { requestId: "req_2", delivery: "accepted", status: "completed", providerOutcome: "completed", startedAt: "2026-09-30T10:00:00.000Z", finishedAt: "2026-09-30T10:01:00.000Z", truncated: true });
	assert.equal("workerName" in done || "eventPath" in done || "output" in done, false, "Coordinator internals stay out of the view");
});

test("accepted is not finished: run status follows the latest turn's status, not its delivery", () => {
	assert.equal(acpRunStatus([]), "idle");
	assert.equal(acpRunStatus([turnView(request({ delivery: "accepted" }))]), "running");
	assert.equal(acpRunStatus([turnView(request({ status: "completed", delivery: "accepted" })), turnView(request({ id: "req_2", delivery: "accepted" }))]), "running");
	const statuses = { completed: "complete", cancelled: "cancelled", timed_out: "timeout", failed: "error" } as const;
	for (const [status, run] of Object.entries(statuses)) {
		assert.equal(acpRunStatus([turnView(request({ status: status as RequestRecord["status"], delivery: "unknown" }))]), run);
	}
});

test("an ACP run view keeps run ID, request IDs, native ID, delivery and outcome apart", () => {
	const turns: AcpTurnView[] = [
		turnView(request({ id: "req_a", status: "completed", delivery: "accepted", providerOutcome: "completed" })),
		turnView(request({ id: "req_b", status: "failed", delivery: "unknown", failure: { code: "TRANSPORT", message: "lost", retryable: false } })),
	];
	const view: AcpRunView = {
		backend: "acp", id: "amp-7f3a", status: acpRunStatus(turns), task: "fix it", cwd: "/repo",
		startedAt: 1, session: {
			agent: "amp", origin: "opened", worker: "w-amp", nativeSessionId: "T-019a", executionEnvironment: "orb",
			handle: { runtimeSessionName: "pi-strings:w-amp", agentSessionId: "T-019a", acpxRecordId: "rec_1" },
		},
		turns, output: "", truncated: false, capabilities: acpCapabilities({ origin: "opened", agent: "amp" }),
	};
	const ids = [view.id, ...view.turns.map((t) => t.requestId), view.session.nativeSessionId];
	assert.equal(new Set(ids).size, ids.length);
	assert.deepEqual(view.turns.map((t) => [t.requestId, t.delivery, t.status, t.providerOutcome]), [
		["req_a", "accepted", "completed", "completed"],
		["req_b", "unknown", "failed", undefined],
	]);
	assert.equal(view.status, "error");
});

// --- compile-time pins (checked by `npm run typecheck`, inert at runtime) -----------------

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const pins: [
	Equals<AcpTurnView["delivery"], "accepted" | "unknown">,
	Equals<DelegateRunView["backend"], "pi" | "acp">,
	Equals<AcpStartInput["origin"], "created" | "opened">,
	Equals<keyof BackendCapabilities, "backend" | (typeof LIFECYCLE_ACTIONS)[number]>,
	Equals<Parameters<DelegateBackend<"pi">["start"]>[0], PiStartInput>,
	Equals<Parameters<DelegateBackend<"acp">["start"]>[0], AcpStartInput>,
	Equals<Awaited<ReturnType<DelegateBackend<"acp">["result"]>>, AcpRunView>,
] = [true, true, true, true, true, true, true];

test("compile-time pins hold", () => {
	assert.ok(pins.every(Boolean));
	// @ts-expect-error agent is ACP-only: a pi input cannot carry it.
	const piWithAgent: PiStartInput = { backend: "pi", role: "scout", task: "t", agent: "amp" };
	// @ts-expect-error opening keeps native settings: an open input has no model.
	const openWithModel: AcpStartInput = { backend: "acp", origin: "opened", agent: "amp", sessionId: "T-1", model: "gpt-5" };
	// @ts-expect-error a created ACP run needs a task.
	const createWithoutTask: AcpStartInput = { backend: "acp", origin: "created", agent: "amp" };
	assert.ok(piWithAgent && openWithModel && createWithoutTask);
});
