# Create or open native sessions through one provider interface

Status: Pi and Amp create/open paths are implemented through the common ACPX runtime. Amp native opening uses authenticated export metadata for executor, owner scope, cwd, and mode when available; `cwd` and `executionEnvironment` remain optional verification hints. Live account/executor and lifecycle proofs remain acceptance gates. Amp owns participant identity, presence, queueing, and cross-user attribution; those are not pi-strings acceptance gates. Arbitrary history-page/character limits are not part of the shared contract.
Tracked by [019](../../todos/019-complete-amp-participant-boundary.md) and [hub 018](../../todos/018-ready-amp-participant-coordination.md).

## Decision

Every agent integration must support creating a new session and opening an existing provider-native thread/session. Use the existing `op_*` surface and ACPX runtime. No separate Amp extension, package, tool family, or always-on plugin bridge.

Execution location and session origin are independent. Amp already exposes `execution-environment: local | orb`; opening an existing thread must preserve its executor, not reinterpret a supplied ID as a new Orb request.

A provider missing native opening is an implementation gap. Returning an honest unsupported error is necessary failure behavior, not completion of that provider's acceptance criteria. Custom ACP commands remain supported as a transport path; arbitrary unknown implementations cannot be claimed verified.

## Proposed public contract

Keep the tool names. Extend `op_spawn` with `sessionId`, meaning the exact provider-native ID. Omit it to create; supply it to open. Pi opening is implemented; other agents currently return `NATIVE_OPEN_UNSUPPORTED`:

```json
{"name":"research","agent":"amp","executionEnvironment":"orb"}
{"name":"existing-research","agent":"amp","sessionId":"T-<exact-id>"}
{"name":"existing-codex","agent":"codex","sessionId":"<exact-native-thread-id>","cwd":"<original-workspace>"}
```

- `executionEnvironment` applies to creation and must match an advertised provider option. Amp native opening may accept it as an explicit executor verification hint; other agents reject it on open. Do not assume other agents support Amp's values.
- Opening never falls back to creating, selecting latest, suffix matching, forking, or importing a transcript into a new thread.
- Replace the public adapter-level `resumeSessionId` with native `sessionId`; migrate callers/tests/docs in one cutover. Internal restoration of a coordinator-owned ACP handle remains distinct from first opening an external native session.
- Opening rejects explicit creation-time model, thinking, tool, or executor overrides. Ambient profile defaults must not be applied to the existing thread. Original local cwd must be resolved/verified; using Pi's current directory is not evidence that it is the thread's workspace.
- `op_status` and `op_list` report native identity separately from ACP/runtime identity, origin (`created` or `opened`), execution location when known, and the capabilities actually established. Unknown values remain unknown.
- `op_send`, `op_wait`, and `op_result` remain the common message/request interface. Opened sessions receive the requested text without `WORKER_CONTRACT` or acceptance-report decoration. The local request result is not automatically the shared thread's global completion state.
- `op_cancel` is an explicit stop request. `op_close` for an opened session disconnects local participation; it must not secretly invoke cancellation, archive, deletion, or backend `session/close` with stronger semantics. Existing owned-worker force-close behavior remains intact for created workers.

Opening an idle stored local session is not the same as attaching to the live terminal process that previously used it. Advertise these distinctions; do not promise concurrent participation from a `loadSession` method alone. Amp owns busy-thread and multiplayer behavior; pi-strings reports only its local observation and provider outcome.

## Internal changes required

### Admission and identity

Keep one Coordinator with explicit session origin/policy, not a second orchestration layer. The current owned-session provenance check must continue protecting owned-session restoration; external native opening needs a deliberate admission branch, not deletion of the check.

Scope native identity by provider and its relevant account/service/storage context. The current `Map<string, SessionProvenance>` is keyed only by an unqualified session ID and cannot represent this safely. Persist origin and native/adapter identity separately; reject conflicting opens and verify native identity before registering a successful open. An echoed request ID is not independent native identity evidence.

For remote executors, the local adapter launch cwd is not a local writable workspace for the Orb. Do not apply local cwd/worktree ownership checks as if they confined remote execution. For local sessions, preserve the original workspace and do not claim Pi's local lock excludes other native clients.

### Runtime and adapters

Reuse ACPX's existing strict resume/load path. It already rejects a supplied unknown ID without creating a replacement, as proven with the subprocess fixture below. Persistent reconnect uses `same-session-only`; retain that policy on every recovery path.

Opening must not send creation session options, select a profile model, set Codex's default worker mode, or replay stale desired settings from another binding. The current `AcpxRuntimePort.ensureSession` does these things for owned workers and needs an explicit opening path.

Generic ACP capabilities establish resume/load availability, not necessarily arbitrary native-ID semantics. Most inspected adapters use native IDs directly; Amp has a separate S-to-T mapping. Put any translation or native lifecycle support in the provider adapter, surfaced through ACPX, rather than a parallel CLI coordinator.

### Lifecycle and shared work

ACPX `close` currently calls `cancel` first; with discard it may issue backend `session/close`. Add/verify a genuinely disconnect-only primitive before using it for opened sessions. Simply renaming `close` to `detach` would be incorrect.

Stopping an adapter process can itself affect a locally executing turn even when no cancel RPC is sent. Surface provider behavior and refuse to claim durable execution across disconnect without proof. In particular, idle-close evidence below does not prove active-turn survival.

For opened sessions, disable automatic prompt retry/model fallback and worker prompt decoration. A transport loss can leave delivery unknown; do not resend. A request deadline ends Pi's wait, not authority over other contributors. Record local observation/request outcome separately from provider work state. Shared result attribution belongs to Amp. Pi-strings must not infer it from the last assistant message or an idle snapshot.

### Persistence cutover

Update the stored schema, namespace keys, restart logic, and every caller together. Existing owned records need explicit origin handling; never infer that an unknown prior ID grants ownership. Do not silently reset corrupt or ambiguous state. Decide the concrete schema migration during the core slice, with tests proving old owned authority is not broadened.

## Provider coverage matrix

The vendored registry has **21 entries**, plus pi-strings' Amp override: **22 named integrations**. The README names Pi, Codex, OpenCode, Amp, and Claude as well-exercised. A registry entry is only a launch recipe, not native-open proof.

| Provider | Investigated artifact | Native opening evidence | Remaining gate |
| --- | --- | --- | --- |
| Pi | Vendored `PiAcpAgent`; real Pi CLI 0.99.1 | `findStoredSession` falls back to `findPiSession`; resolves an externally seeded native ID without prior adapter mapping. Real idle load/close probe below. | Preserve recorded settings/workspace; active-process collision and shutdown semantics; expose through Coordinator |
| Codex | `@agentclientprotocol/codex-acp@1.1.5` [published source][codex] | `CodexAcpClient.resumeSession/loadSession` calls `threadResume({threadId: request.sessionId})`; load reads that thread's history. ACP session ID and native thread ID coincide. | Live proof; resume supplies cwd/config/model-provider, so settings preservation is not automatic; native close unsubscribes whereas delete archives |
| Claude | `@agentclientprotocol/claude-agent-acp@0.60.0` [published source][claude] | `loadSession/resumeSession` call `getOrCreateSession`, which supplies SDK `resume: params.sessionId`; matching live fingerprint reuses the query. | Live unknown-ID/no-create proof and settings preservation; changed cwd/MCP fingerprint recreates the underlying query |
| OpenCode | 1.18.33, commit `51ef4be1d3c122f18fefb510dca8d778571f4f18` [service][opencode] | Load/resume first `session.get` exact native `sessionID`, then restore model/variant/mode via `session.load`; creation has a separate branch. Resume fetches 20 messages, load full history. | Live proof and active-turn/disconnect semantics; installed resolution is currently unpinned |
| Amp | Local `vendor/amp-acp` adapter using the Amp CLI's `threads continue T-...` path; upstream `amp-acp` remains source evidence [server][amp] | Common create path exposes local/Orb execution. Exact T-ID opening verifies authenticated export metadata for thread, owner scope, cwd, executor, and mode when available; no transcript replay. | Live account identity, metadata availability across local/Orb cases, active-turn/disconnect semantics, and bounded observation proof. Participant attribution remains Amp-owned. |
| Gemini | commit `38700b4b38bf387dafded6c97c3f190d084b49e9` [manager][gemini] | Load resolves persisted session via `SessionSelector`, resumes chat, and streams history. It reconstructs an executor, not a live terminal attachment. | Pin/test deployed version; original configuration and active-session behavior |
| Kimi | commit `9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82` [server][kimi] | Load/resume use `Session.find(work_dir, session_id)`; missing IDs reject. Load replays wire history; resume returns config. | Live proof; workdir/config preservation and concurrent ownership |
| Qwen | commit `ccea5f9fbebdc78ad2b4e929c0c4f8d5f6500f95` [ACP agent][qwen] | Actual CLI load/resume handlers resolve a persisted native ID and throw resource-not-found if absent, restore approval/model state, then register the session. | Live proof; normalization/alias handling; load may restore worktree/background-agent services, so it is not necessarily a passive read |
| OpenClaw | commit `202381532b2be841649946f79582316e06894fbc` [lifecycle][openclaw] | Resume maps ACP ID/native session key and calls `getExistingSnapshot` when no live mapping exists; load also supports ledger reconstruction. Close calls `cancelSessionWork`. | Verify native session-key routing and reject unintended reset metadata; load path is not equivalent to strict resume; live proof |
| cursor | Registry `cursor-agent acp` | Native-open semantics unverified | Primary-source/capability and live acceptance |
| copilot | Registry `copilot --acp --stdio` | Native-open semantics unverified | Primary-source/capability and live acceptance |
| droid | Registry `droid exec --output-format acp` | Native-open semantics unverified | Primary-source/capability and live acceptance |
| fast-agent | Registry `uvx fast-agent-mcp acp` | Native-open semantics unverified | Primary-source/capability and live acceptance |
| grok-build | Registry `grok agent stdio` | Native-open semantics unverified | Primary-source/capability and live acceptance |
| iflow | Registry `iflow --experimental-acp` | Native-open semantics unverified | Primary-source/capability and live acceptance |
| kilocode | Registry `npx -y @kilocode/cli acp` | Native-open semantics unverified | Primary-source/capability and live acceptance |
| kiro | Registry `kiro-cli-chat acp` | Native-open semantics unverified | Primary-source/capability and live acceptance |
| mux | Registry `npx -y mux@^0.28.0 acp` | Native-open semantics unverified | Primary-source/capability and live acceptance |
| pool | Registry `pool acp` | Native-open semantics unverified | Primary-source/capability and live acceptance |
| qoder | Registry `qodercli --acp` | Native-open semantics unverified | Primary-source/capability and live acceptance |
| trae | Registry `traecli acp serve` | Native-open semantics unverified | Primary-source/capability and live acceptance |
| zeroclaw | Registry `zeroclaw acp` | Native-open semantics unverified | Primary-source/capability and live acceptance |

The last 13 are **unverified**, not declared unsupported or removed from scope. Custom commands add an open-ended conformance surface beyond these 22. Source inspection proves code paths, not successful authenticated execution.

## Executed evidence

- `npm run check`: **96 pass, 19 skipped, 0 fail**. The skipped cases are live-provider/worktree gates. This is a pre-change baseline, not proof of the proposed API.
- Current `Coordinator.execute({action:'spawn', agent:'amp', resumeSessionId:<synthetic T-ID>})`: `RESUME_PROVENANCE_UNKNOWN`; adapter session calls **0**. Confirms the admission barrier without touching a real thread.
- Actual ACPX plus subprocess fixture, seeded outside coordinator: exact supplied fixture ID loads, provider state remains unchanged; unknown ID rejects and creates no provider session. No real provider or model was involved.
- `node scripts/probe-native-pi-opening.mjs`: uses the real Pi 0.99.1 process and vendored adapter with isolated HOME/config/state, synthetic transcript, no prompt. Exact reported backend ID and adapter mapping matched the seed; unknown ID returned Pi's exact `-32602` error with the requested ID in its error data; recursive inventory found one native session file after idle close.
- First Pi case had no thinking entry: original entries survived, but Pi appended `thinking_level_change: high`. Therefore the initial byte-identical-open predicate **failed**; native load is not universally a read-only operation.
- Second Pi case recorded `thinking_level_change: off`: original history and recorded setting survived, and the file was byte-identical after idle close. This narrower result proves that recorded setting on that fixture, not all model/tool settings or active-turn survival.
- [Earlier Amp capability-only probe](2026-09-29-AMP_PARTICIPANT_BOUNDARY.md) exposed lookup but no user identity. It did not prove authenticated reads and is not a selected production transport.

## Review and delivery slices

Fresh Codex-2 Astra review (`reviewer-610408d9-9283-4215-9fde-93a9aabe7cda`) accepted this implementation contract. Its probe finding was corrected: reject only the exact unknown-session error, not any exception, and inventory the full isolated native session tree. Parent reran the corrected real probe successfully; reviewer independently checked syntax/source, not live provider behavior. Active-turn disconnect, process disposal, and all-provider capabilities remain proof gates.

- [020](../../todos/020-ready-amp-readonly-participant.md): common contract/persistence/lifecycle plus native Pi vertical slice.
- [026](../../todos/026-ready-codex-native-opening.md), [027](../../todos/027-ready-claude-native-opening.md), [028](../../todos/028-ready-opencode-native-opening.md): Codex, Claude, OpenCode create/open/continue evidence.
- [029](../../todos/029-ready-amp-native-opening.md): Amp local/Orb creation and exact native opening/observation; [021](../../todos/021-ready-amp-approved-contribution.md) then proves an approved contribution.
- [030](../../todos/030-ready-remaining-native-provider-coverage.md): remaining17 provider delivery routes and bounded children; decision closure is not delivery of those providers.
- [022](../../todos/022-complete-amp-multiplayer-recovery.md) and [024](../../todos/024-ready-amp-evidence-handoff.md): multiplayer scope decision and evidence handoff. [023](../../todos/023-pending-amp-plugin-bridge.md) stays conditional on a demonstrated 029 gap and explicit user deployment approval.

019 closed in user-approved main-branch commit `382b9e9`; dependent020 and030 are authorized to start. Production implementation and live provider proofs are still outstanding.

## Proof required before claiming delivery

For every supported integration: create a native session independently, capture its canonical ID/settings/workspace, open it through the common tool, read/continue the same conversation, and demonstrate that an unknown ID cannot create another thread. Verify disconnect and explicit cancel independently. Run live tests only against authorized scratch work; never an arbitrary active team thread.

Core deterministic coverage must include scoped-ID collisions, existing owned restoration, no creation-setting replay on open/reconnect, imported history bounds, unsupported capability, native-ID mismatch, no silent fallback, ambiguous delivery, and shutdown races. All existing owned-worker tests must continue passing.

Amp additionally needs existing local and Orb cases, permission failure, active-turn/disconnect evidence, bounded observation, and cross-thread handoff evidence. Participant identity and shared activity remain provider-owned. A plugin is conditional only if an adapter capability cannot supply a required native function; placement/authentication requires an explicit decision before deployment.

[amp]: https://github.com/tao12345666333/amp-acp/blob/e35216d4fd3258445ac8b3ac5db7ef4ce3a40af9/src/server.ts
[codex]: https://unpkg.com/@agentclientprotocol/codex-acp@1.1.5/dist/index.js
[claude]: https://unpkg.com/@agentclientprotocol/claude-agent-acp@0.60.0/dist/acp-agent.js
[opencode]: https://github.com/anomalyco/opencode/blob/51ef4be1d3c122f18fefb510dca8d778571f4f18/packages/opencode/src/acp/service.ts
[gemini]: https://github.com/google-gemini/gemini-cli/blob/38700b4b38bf387dafded6c97c3f190d084b49e9/packages/cli/src/acp/acpSessionManager.ts
[kimi]: https://github.com/MoonshotAI/kimi-cli/blob/9ab1286b8fe4e6bcd116949a27ce5e0ac3389c82/src/kimi_cli/acp/server.py
[qwen]: https://github.com/QwenLM/qwen-code/blob/ccea5f9fbebdc78ad2b4e929c0c4f8d5f6500f95/packages/cli/src/acp-integration/acpAgent.ts
[openclaw]: https://github.com/openclaw/openclaw/blob/202381532b2be841649946f79582316e06894fbc/src/acp/translator.session-lifecycle.ts
