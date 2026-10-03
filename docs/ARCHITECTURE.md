# Architecture and operational contract

This document covers the `acp` backend of `delegate`: the Coordinator, the ACPX runtime and the permission model under it. The public surface is `delegate`/`delegate_ctl`, described in the [README](../README.md) and decided in [ADR 0001](adr/0001-delegate-backends.md). The `pi` backend runs in-process children and is described in the README only.

## 1. Objective and boundary

The `acp` backend gives a Pi parent ACP agent sessions without PTY scraping or provider-specific orchestration. The production path has exactly one runtime port:

```text
Parent Pi -> delegate / delegate_ctl -> acp backend (src/acp-backend.ts)
          -> Coordinator (src/acp/orchestration/coordinator.ts)
          -> AcpxRuntimePort -> vendored ACPX runtime
                                ├─ vendored Pi ACP adapter
                                ├─ vendored Amp ACP adapter
                                └─ configured ACP agents
```

There is one Coordinator per Pi process (`src/acp/instance.ts`), with its own state dir (§6). Any number of Pi processes use ACP at once. The backend owns the delegate run: its run ID, its record, parking and revival, and the mapping to Coordinator actions. The Coordinator owns worker identity, request state, persistence, worktree admission, bounded evidence, deadlines and lifecycle actions. ACPX owns ACP process and session handling, normalized events, permissions, cancellation primitives and close.

## 2. Coordinator actions

The Coordinator is internal. Callers use `delegate`/`delegate_ctl`, and the backend maps each call to one Coordinator action. The Coordinator worker name never reaches the caller; a run is addressed by its delegate run ID.

| delegate call | Coordinator action |
|---|---|
| `delegate backend:"acp"` | `spawn`, then `send` when there is a `task` |
| `delegate_ctl steer` | `send` on the same worker (after `resume` when the run is parked) |
| `delegate_ctl wait` | `wait`. A wait deadline never cancels work. |
| `delegate_ctl status`, `result` | `status`, `result` |
| `delegate_ctl cancel` | `cancel` of a turn this run started |
| `delegate_ctl close` | `close`: dispose a created session, disconnect an opened one |

Responses carry `ok`, `action` and structured details. Errors carry a stable code, a message and retryability.

### `spawn`

`agent` is required on the delegate surface. Direct workers use safe read-only tools (`read`, `grep`, `find`, `ls`); `role: "writer"` selects the writer tool default. `cwd`, `model` and `executionEnvironment` apply to creation. A new Amp session needs `executionEnvironment` `local` or `orb`. `sessionId` opens an existing provider-native session instead of creating one: opening keeps native settings, rejects creation overrides, and does not decorate prompts or retry. Native opening verifies identity through the adapter. Today the vendored Pi and Amp adapters do this; other adapters fail `NATIVE_OPEN_UNSUPPORTED` until they advertise the same capability. Opening a stored Pi session starts a new local executor for that file. It does not attach to an already-running terminal process. Writers default to shared isolation (one live writer per canonical cwd). A failed spawn registers no half-created worker.

### `status`

The Coordinator reports origin, native identity and model choices when opened or inspected. Native ACP `configOptions` are parsed into model IDs, labels and descriptions. When an adapter omits discovery, a maintained catalog covers Claude aliases, known Codex IDs and Amp modes; the response marks it `source: fallback`, and provider rejection remains an explicit selection failure. `delegate_ctl models` without a run ID keeps the global pi offering catalog; with an ACP `runId` it returns the detailed per-agent catalog. One-run `status`/`result` show a compact `models:` line, one bounded Coordinator status read per call, never on render. Unsupported, failed or slow discovery on an agent without a fallback reads `models: unknown`; an opened session shows only its current model. On Claude, Codex and Amp, whose own IDs have no slash, a `model` with `/` is a pi `provider/id` and fails `INPUT_INVALID`; pi-acp (`provider/id`), OpenCode (`provider/model`) and the other agents pass it through. On an opened Amp run, `status` or `result` with `observe: true` reads the thread: one `amp threads export` per call, returning only messages after the persisted cursor (todo 044). A plain status never exports.

### `send`

`prompt` is required; the backend passes `task` or the steer `message`. An optional `model` is checked against the native or maintained catalog and selected before the turn through ACP's model control; unavailable IDs and provider selection failures fail explicitly. The selected `requestedModel` is kept in request provenance. `send` is accepted only for an idle worker and starts exactly one prompt turn. A later `send` after terminal completion continues the same persistent session. A second prompt is never submitted while a turn is active.

The Coordinator starts ACPX turns with timeout `0` and runs the turn deadline itself. On a created session's deadline it records `timed_out` (`TURN_TIMEOUT`), gates late output, attempts cooperative cancellation, closes the stream and runtime within bounded grace, and marks the worker failed and unusable until closed. On an opened session the deadline only stops local observation; the native turn keeps running.

Created-worker prompts are decorated with the worker contract plus the role and acceptance contracts for the profile's `kind` (oracle, finder, worker, or `free`, the default for direct workers). Opened sessions receive the exact prompt, including surrounding whitespace, and never retry or apply stall or turn-budget cancellation.

For profiles with `fallbackModels` and `maxAttempts > 1`, a retryable provider failure triggers a bounded retry on the same session with the fallback model. The request ID stays the same across retries. Non-retryable failures, cancellations and policy violations (stall, turn budget) are never retried.

A turn's delivery is `accepted` only when the provider reports that it completed. Any other outcome (failed, cancelled, transport loss) leaves delivery `unknown`, for created and opened turns alike.

### `wait` and `result`

`wait` takes a fixed snapshot of requests. Its own deadline returns control without cancelling work. `result` returns bounded progress or the authoritative terminal record. Terminal completion closes and drains the event stream, so an iterator that never ends cannot strand a request. Stream loss before the terminal result is a transport failure.

### `cancel` and `close`

Cancel is cooperative first and escalates after bounded grace; cancellation intent wins over a late normal result. The backend cancels only a turn this run started. Close may force cancellation, records cleanup failure as a failed unusable worker, and removes the worker only after successful cleanup. Repeated close attempts after a failure can retry cleanup. Close on an opened session only disconnects: it never cancels, archives or deletes the native session.

## 3. State machines and invariants

Worker:

```text
spawning -> idle -> running -> idle
    |         |       |        |
    +------> failed <-+        closing -> closed
```

A timed-out or failed worker does not become idle automatically. Request:

```text
created -> running -> completed
                  |-> cancelled
                  |-> timed_out
                  |-> failed
```

Each worker has zero or one active request. Each request has one terminal transition. Terminal status comes from the ACPX turn result, except coordinator-owned deadline/cancellation/transport transitions. Late events may be logged but cannot alter terminal output or status.

## 4. Profiles and permissions

A profile contains agent, role, kind (oracle/finder/worker/free), model/options, tools, deadline, cancellation grace, output bound, isolation mode, maxTurns, fallbackModels, and maxAttempts. `delegate` never names a profile: it creates direct workers, which resolve the same profile shape from `agent`, `role` and the default tools for that role. Named profiles remain a Coordinator feature. The coordinator appends a worker contract prohibiting recursive orchestration, unsafe git operations, package installation, and shared-environment changes. Role contracts and acceptance contracts are appended based on `kind`.

Permission enforcement is entirely native to ACPX:

- Every role uses ACPX `approve-reads` as its base mode.
- Read-only workers pass ACPX's native policy with `autoApprove: ["read", "search"]` and `defaultAction: "deny"`; writers pass native `defaultAction: "approve"` so explicit writer turns do not wait for an unavailable permission UI.
- The runtime sets ACPX `nonInteractivePermissions: "deny"` as the fallback for unpromptable requests.
- Pi additionally receives its validated `allowedTools` list through the vendored adapter command override.
- The backend does not implement provider-specific permission callbacks or custom permission matching.

`permissionMode` and `permissionPolicy` are ACPX choices, not a reimplementation. Profile tool lists, ACPX `cwd`, and provider-native sandbox behavior are not claimed as universal enforcement for arbitrary provider-native tools.

Provider-native write scoping is provider-specific and is **not enforced by ACPX params**:

- **Codex**: escapes via `codex-acp`, which hardcodes `projects.<cwd>.trust_level = "trusted"` (`CodexAcpClient.ts:498`); Codex's Guardian Review can then auto-approve an out-of-worktree `apply_patch` despite the forwarded workspace-write sandbox. Fix requires changing `codex-acp` (vendor plan: `vendor/codex-acp/README.md`).
- **Amp**: by default it can also write outside the worktree, but it **is** confinable via its permission plugin: the loose builtin rule is `allow apply_patch` (rule 121), and a higher-precedence user rule `reject …` overrides it. Precise "allow in-worktree / reject outside" is fragile because Amp's `apply_patch` emits absolute paths and the match condition is the free-text `diff` arg (`edit_file --path` scopes cleanly but Amp prefers `apply_patch`). `amp-acp` does not currently forward per-session permission rules.
- **OpenCode**: confined by its own `permission` config (e.g. `{ edit: "allow", external_directory: "deny" }`), which the boundary test injects.
- **Claude Code**: supported via ACPX's built-in `claude` registry entry (`npx @agentclientprotocol/claude-agent-acp@^0.64.2`); `agent: "claude"` resolves natively (no override needed). Requires Claude Code subscription access (org-enabled) or an `ANTHROPIC_API_KEY`.

  **Deep-dive (why Claude escapes, and why it is the one that is *ACP-confinable*):** Claude's native `Write`/`Edit` route through the SDK's `canUseTool` hook (in claude-agent-acp's `acp-agent.ts`), which forwards a real ACP `session/request_permission` to the host in the default (non-bypass) mode. So unlike Codex (Guardian Review) and Amp (`apply_patch`), Claude's write **goes through the ACP permission layer** — ACPX sees it and resolves it via its `permissionPolicy`. The escape happens only because the backend gives writers `permissionPolicy: { defaultAction: "approve" }`, and ACPX's `permissionPolicy` shapes (`defaultAction`/`autoApprove`) match by tool kind/name, **not by path** (`vendor/acpx/src/permissions.ts`). The worktree path is never examined.

  **Implication:** a **path-aware ACPX permission decision** (approve writes only within the worker `cwd`) would confine Claude without forking the provider — the only one of the three native writers where that's true. That would require path-based permission matching at the ACPX host layer (a deliberate step against the thin-proxy "no custom permission matching" stance), or a cwd-scoped policy. Currently not done; Claude's `real … permission boundary` E2E fails on the default approve policy.

`agent: "amp"` runs the vendored Amp adapter (`vendor/amp-acp`, built to `dist/amp-acp.js`), which drives the locally installed `amp` CLI. See [NATIVE_SESSION_OPENING.md](NATIVE_SESSION_OPENING.md) for its create and open paths.

### Turn budget and stall detection

`maxTurns` (default: none) approximates a turn budget by counting distinct tool invocations. ACPX can emit many lifecycle and input-streaming updates for one invocation; updates sharing a `toolCallId` count once. A worker exceeding its budget is cancelled and terminalized as `failed` with code `TURN_BUDGET_EXCEEDED`. Stall detection evaluates identified calls only when their completed update arrives, fingerprinting ACPX tool identity (`title`) plus a SHA-256 digest of stable final `rawInput` when available rather than provisional display text. Raw tool inputs do not cross the normalization boundary or enter request event logs. A worker issuing an identical completed call `STALL_THRESHOLD` (4) times under distinct call IDs is cancelled and terminalized as `failed` with code `STALLED`. Both are non-retryable policy violations.

## 5. Writer isolation

The backend never creates or removes worktrees implicitly. The default isolation mode is `shared`: the writer runs in the given `cwd` and one live writer per canonical cwd is enforced across every Pi process on the machine. A second ACP writer in the same cwd is rejected with `WRITER_CWD_OWNED`, naming the holder's PID when it is another process. This check covers ACP workers only; the pi backend checks its own writers separately.

`isolation: "worktree"` is opt-in compatibility mode. In that mode, `cwd` must be an existing linked worktree, differ from the parent checkout, and remain unowned by another live writer. Isolation is revalidated before each turn.

Future stronger isolation may use CoW (copy-on-write) temp copies of the repo rather than worktrees.

## 6. Persistence, parking and revival

Two layers persist state.

**Coordinator state.** Each Pi process's Coordinator has its own state dir, so ACP works in every Pi process at once. The home is `<agentDir>/pi-strings/`, where the agent dir is Pi's (`getAgentDir()`: `PI_CODING_AGENT_DIR`, else `~/.pi/agent`). `PI_AGENT_DIR` still overrides it. The directory kept its pre-merge name. User profiles are read from `<agentDir>/pi-strings.json`; `~/.pi/agent/pi-strings.json`, their old place, is deprecated and still read when the agent dir has none.

```text
proc/<pid>-<token>/                one process's state dir; <token> tells a reused PID from its earlier owner
  state.json                       worker registry and bounded request results
  owner.json                       the holding process: PID, host, token
  requests/<request-id>.ndjson     normalized event log
  acpx/                            ACPX session records
proc/<pid>-<token>.lock/           the dir's lease: one live process per state dir (COORDINATOR_OWNED names the holder)
locks/<hash>.json                  machine-wide claims (below)
```

The legacy single state dir, from before per-process state, is only read, to adopt from. It is where that Coordinator kept it: `<PI_AGENT_DIR, else ~/.pi/agent>/pi-strings/state.json`, which is the home above unless `PI_CODING_AGENT_DIR` moves Pi's agent dir.

A process reads only its own state dir at startup, so it never reconnects another process's workers. Dirs of exited processes are left in place: a parked run may still need the provenance in one. Nothing deletes them yet.

**Machine-wide claims.** What one Coordinator's in-memory checks enforced is also claimed across processes in `locks/`: one live writer per canonical cwd (`WRITER_CWD_OWNED`) and per linked worktree (`WRITER_WORKTREE_OWNED`), and one live binding per native session, opened or created (`SESSION_IN_USE`). A claim file names its holder's PID, host, token and state dir; proper-lockfile serializes its read-check-write for milliseconds; its lock is stale after 2 s and an attempt retries longer, so a process killed inside that window delays the claim, never blocks it. Workers in one process can share a claim (a shared writer and a worktree writer in one linked worktree both hold its cwd); the claim is released with the last of them. A claim is stale once its PID no longer runs, or its state dir lease is no longer fresh (a reused PID), and is then taken over at once. Claims are released on close, park and shutdown. A refusal names the holder's PID. Not covered: a created Amp run's T-ID, which is learned after creation, and ACP use by Pi processes still running a version from before per-process state.

**Adoption.** A parked run can come back in another process. Its record names the state dir that held its worker (`stateDir`). On steer, a Coordinator whose own dir differs first adopts the worker from that dir: it reads it without locking or changing it, and copies the created session's provenance and its ACPX session record. Then owned resume (created) or native opening (opened) proceeds as in one process. While the dir's process is alive and still holds the worker, adoption fails `RUN_OWNED_ELSEWHERE` with its PID, and so does closing a run whose park did not release it. An opened run takes nothing from the dir, so an unreadable one does not stop it. A record without `stateDir` predates per-process state; its worker is adopted from the legacy single dir, like a dead process's dir.

Directories are mode 0700 and files mode 0600. State is atomically replaced, locked and strictly schema-validated. Direct workers persist their validated tool list (and selected creation-time model) so restart reconstruction cannot broaden policy. The current version does not accept legacy `waiting` statuses or `questions`; such state returns `STATE_CORRUPT` rather than silently discarding authority data. Requests left running after parent loss become `PARENT_PROCESS_LOST`.

**Delegate run records (043).** The backend saves each ACP run's record under the parent's `.agents/pi/subsessions/owners/<parent>/acp/` at every lifecycle step: identity, origin, native session, turns with request IDs, delivery, outcome and output.

- On parent exit the run is parked, not closed. Its session is released through the Coordinator the way close releases it: a created session is closed without discarding it, and an opened one is disconnected. No agent process outlives the parent. The record says parked. A turn still running then ends as `PARENT_PROCESS_LOST` with delivery `unknown`.
- A later process restores the record without starting anything. `status`, `result` and `wait` read it without constructing a Coordinator.
- `steer` reopens a parked run under the same worker name. An opened run goes through the native-opening path with the same native ID and an identity check. A created run goes through the Coordinator's owned `resume`, which needs the adapter's ACP `session/resume` or `session/load`; otherwise steer fails `RUN_NOT_RESUMABLE` and the record stays readable.
- A run whose owning process died is adopted parked. A run that another live Pi process owns is a read-only snapshot (`RUN_OWNED_ELSEWHERE`). A run that cannot be recorded is released (`RUN_NOT_PERSISTED`).
- `delegate_ctl close` is final. A closed run is never reopened.

Shutdown rejects new work, lets an already-running action tail finish, and prevents queued mutating actions from creating untracked workers before runtime cleanup.

## 7. ACPX boundary

`vendor/acpx/` contains the auditable ACPX `0.13.0` source snapshot at commit `e91cc504` (PR #468). `npm run build` emits the runtime and declarations under `dist/acpx-runtime`; `src/acp/runtime/acpx-runtime.ts` imports that generated local module. The port normalizes ACPX events into local types, exposes `getStatus().models.currentModelId`/`availableModelIds`, and passes `timeoutMs: 0` both at runtime construction and turn start. Any ACPX upgrade requires contract tests for session continuity, model discovery/selection, event/result ordering, cancellation, close, permissions, and state compatibility.

The vendored Pi and Amp adapters are ACP executable adapters, not second runtime implementations. Agent processes share the parent's lifetime: a parked run's session is released, and a turn running at parent exit is not claimed durable.

## 8. Observability and failure table

Coordinator `status` exposes model discovery (`currentModelId`, `availableModelIds`, and native/fallback option metadata); its `list` and `result` expose worker/request status, IDs, timestamps, bounded output, event paths, model provenance, and diagnostics. `delegate_ctl models runId` is the detailed per-agent catalog; raw ACP tool payloads are not retained by the runtime facade. tmux is optional human observation only.

| Failure | Required behavior |
|---|---|
| Missing/invalid agent | Spawn fails without registering a worker |
| Model discovery unsupported | Coordinator uses a maintained per-agent fallback when available; otherwise `status` or a requested model fails explicitly with `MODEL_DISCOVERY_UNSUPPORTED` |
| Model unavailable | Spawn/send fails explicitly with `MODEL_UNAVAILABLE`; no turn starts |
| Model selection unsupported/fails | Requested spawn/send fails explicitly with `MODEL_SELECTION_UNSUPPORTED` or `MODEL_SELECTION_FAILED` |
| Provider error (retryable) | Request retries on fallback model if configured; otherwise `failed` with provider diagnostic |
| Provider error (non-retryable) | Request is `failed`; no retry |
| Stream loss before result | Request is `failed` transport; never inferred complete |
| Coordinator deadline | Request is `timed_out`; runtime cleanup is bounded; worker remains failed |
| Turn budget exceeded | Request is `failed` with `TURN_BUDGET_EXCEEDED`; no retry |
| Repeated identical tool call | Request is `failed` with `STALLED`; no retry |
| Ignored cancel | Escalate; request remains `cancelled` |
| Close rejection/timeout | Worker remains persisted as `failed`, never `closing` indefinitely |
| Parent loss | Active requests become `PARENT_PROCESS_LOST`; the delegate run is parked |
| Parked created run, adapter cannot resume | `steer` fails `RUN_NOT_RESUMABLE`; the record stays readable |
| Run owned by another live Pi process | Read-only snapshot; actions fail `RUN_OWNED_ELSEWHERE` |
| Writer cwd or native session held by another live Pi process | Spawn/open fails `WRITER_CWD_OWNED` or `SESSION_IN_USE`, naming that process's PID |
| Corrupt state | Return `STATE_CORRUPT`; do not reset silently |
| Output exceeds bound | Continue draining to private log; retain bounded summary |
