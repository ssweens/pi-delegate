# ADR 0001: One delegate surface over pi and acp backends

Status: Accepted, 2026-09-30. Todos 039 and 040. Amended 2026-09-30 for parking and revival (043), and 2026-10-01 for one Coordinator per Pi process. Contract: `src/backend.ts`.

## Context

pi-delegate runs in-process Pi children through `delegate`/`delegate_ctl`. pi-strings ran ACP workers (pi-acp, Amp, others) through 12 `op_*` tools and its own Coordinator. Commit 1dee4e8 moved that code into `src/acp/`. Two surfaces and two Coordinators would mean cross-package lookup, a double lock and version coupling.

## Decision

- One package and one Coordinator. `delegate` takes `backend: "pi" | "acp"`. Omitted means `pi`, today's behavior. An unknown backend fails. Nothing falls back from acp to pi.
- ACP-only fields (`agent`, `sessionId`, `executionEnvironment: local|orb`) fail on pi. `context` fails on acp. An opened session rejects `role` and `model`.
- A run keeps these apart: delegate run ID, one provider request ID per turn, native session ID (Amp `T-…`), delivery (`accepted|unknown`) and provider outcome. Accepted is not finished.
- Each run reports its capabilities. An unsupported action fails with `ACTION_UNSUPPORTED` and never becomes a different action.
- No Amp plugin bridge. Amp controls use native paths: steer is a native send, and cancel is ACP session cancel. 042 deleted the bridge module, its vendored Amp plugin, the `PI_STRINGS_AMP_BRIDGE_*` settings and the bridge tests.

| op_* | New home |
|---|---|
| spawn | `delegate backend:"acp"`. Create, or open with `sessionId`. The first turn is `task`. |
| send | First turn: `delegate`. Later turns: `delegate_ctl steer`. |
| steer, append | `delegate_ctl steer` as a native send. Shows as `## User`. Opened sessions are undecorated and never retried. |
| observe | `delegate_ctl status`/`result` with `observe: true` on an opened Amp run. One `amp threads export` per call, on demand. |
| status, list | `delegate_ctl status`. With no runId it lists. |
| wait | `delegate_ctl wait`, with any/all over several runs. A timeout never cancels. |
| result | `delegate_ctl result`. Keeps request IDs, delivery and the truncation flag. |
| cancel | `delegate_ctl cancel`. Cooperative, with grace. |
| cancel_remote | `delegate_ctl cancel` through ACP session cancel, for turns this run started. |
| close | New `delegate_ctl close`. Disposes created sessions. Only disconnects opened ones, never archives or deletes. |

No `op_*` tool survives (053).

## Parking and revival (043)

ACP runs are durable like pi runs. Each run's record (identity, origin, native session, turns with request IDs, delivery, outcome and output) is saved under the parent's `.agents/pi/subsessions/owners/<parent>/acp/` at every lifecycle step.

- On parent exit, a run is parked, not closed. Its session is released the way close releases it: a created session is closed without discarding it, and an opened one is disconnected. No agent process outlives the parent. A turn still running then ends as `PARENT_PROCESS_LOST` with delivery `unknown`.
- After a restart, `status`, `result` and `wait` read the record without starting a Coordinator.
- `steer` revives a parked run under the same run ID. An opened run reopens the same native ID, with an identity check. A created run goes through the Coordinator's owned resume, which needs the adapter's ACP `session/resume` or `session/load`. Without it, steer fails `RUN_NOT_RESUMABLE` and the record stays readable.
- A run whose owning process died is adopted parked. A run that another live Pi process owns is a read-only snapshot, and acting on it fails `RUN_OWNED_ELSEWHERE`. A run that cannot be recorded is released and fails `RUN_NOT_PERSISTED`.
- `delegate_ctl close` stays final: a closed run is never reopened.
- A created turn reports delivery `accepted` only when the provider reports completion, the same rule as opened turns.

## Consequences

- Lost: cancelling a turn someone else started in a shared Amp thread. Delegate can't see such turns without observing, so cancel acts only on this run's own turn; with none running it fails `WORKER_NOT_RUNNING`, and a turn started by someone else is never cancelled.
- Observation is on demand only, with no background polling. `amp threads export` is a full dump (about 0.5 s and 35 KB for 14 messages, measured 2026-09-30), so each call returns only messages after the last `messageId` returned. Turns this run starts stream live through `--execute --stream-json`.
- pi has no open-existing and no close. `sessionId` on pi fails `FIELD_REQUIRES_ACP` at validation; `close` on a pi run fails `ACTION_UNSUPPORTED`. Cancel covers it.
- Revival depends on the adapter. A created session on an adapter without ACP resume or load cannot continue after a restart; the caller starts a new run.
- `role` means a role name on pi and `read-only|writer` on acp. The field name is shared, the domain is not.
- An opened run may have no task. It is `idle` until it sends a turn, so it can observe without posting.
- One Coordinator per Pi process, each with its own state dir under `<agentDir>/pi-strings/proc/`, so ACP works in every Pi process at once (amended 2026-10-01; one machine-wide state lock had confined it to one). Writer-cwd and native-session exclusivity are machine-wide claims under `pi-strings/locks/`, and a run revived in another process adopts its worker from the dir that held it.
