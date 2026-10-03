# Native Amp participant boundary

Status: superseded proposal. The user clarified that every agent integration must support creating new sessions and opening existing provider-native threads/sessions through the same tool surface. Separate Amp extension/package and `amp_*` tool-family recommendations below are rejected, not awaiting approval. Replan around provider adapters and explicit session lifecycle semantics; Amp local/Orb execution is an independent configuration choice. The probe evidence below remains valid; native attachment and shared-thread guarantees remain unproven.
Replaced by [the unified native-opening contract](NATIVE_SESSION_OPENING.md), tracked by [019](../../todos/pi-delegate/019-complete-amp-participant-boundary.md) under [018](../../todos/pi-delegate/018-ready-amp-participant-coordination.md). Sections below record the rejected proposal and its probe evidence, not current implementation instructions.

## Context

An existing Orb thread is shared remote work, not a worker owned by Pi. `Coordinator.shutdown`, request deadlines, prompt decoration, and resume provenance implement owned-worker authority. Reusing that state machine would introduce cancellation and instruction authority the participant does not have. Keep the [ACP contract](ARCHITECTURE.md) unchanged.

The [research record](AMP_PARTICIPANT_COORDINATION.md) distinguishes documented interfaces from live proofs. Follow-up probes used Amp CLI `0.0.1790712063-gb89205` on 2026-09-29; the CLI updated since the earlier research. This decision is not a version compatibility guarantee.

## Proposed placement

Use a separate, opt-in participant extension entry point within the existing package, with its own native Amp module and `amp_*` tool namespace. Do not put participant state in `Coordinator`, wrap an Orb as an ACP session, or add native behavior to `AcpxRuntimePort`.

This avoids a new published package while separating lifecycle and registration from `op_*`. Keep the participant entry point out of the package's default `pi.extensions` manifest. Enable its exact file with `pi -e <path>` for one invocation, or with an `extensions` entry in project `.pi/settings.json` or user `~/.pi/agent/settings.json`. Installed Pi's complete `packages.md`, `settings.md`, `cli.md`, and `configuration.md` confirm explicit-file loading and project trust. Package resource filters only narrow declared resources; they cannot enable an undeclared entry point. No participant tools or processes load by default, and loading the entry point alone must not connect to any thread. Tool schemas remain undecided.

Alternative: a sibling package provides installation-level isolation at the cost of another package/build/release surface. User choice is still required. A shared owned/attached Coordinator is rejected because it conflates authority, not merely because it adds complexity.

## Required contract

- **Identity:** explicit native thread ID plus effective authenticated service/account. Saved-account listing is diagnostic, not proof of effective identity. `AMP_API_KEY` and `AMP_URL` can override defaults; account changes must invalidate the binding. No latest-thread fallback.
- **Read:** explicit bounded recent history and activity observations. Keep observation time, availability, and truncation separate from remote activity. An absent, stale, disconnected, or initially empty snapshot is unknown, not idle.
- **Lifecycle:** attach creates only a local reference; detach, timeout, reload, and shutdown dispose local passive resources only. No remote prompt, executor registration, wake, cancel, archive, visibility, or multiplayer change is authorized by attachment.
- **Contribution:** separate target/message authorization; visibly attributed text uses the user's account, not a fictional bot principal. Serialize only Pi's own submissions. No worker-contract suffix, automatic retry, or inferred task success from idle/exit code.
- **Delivery:** local operation state, message acceptance evidence, and remote activity are distinct. Uncorrelated streamed output is not an answer to Pi's message. Unknown delivery remains unknown until reconciled.
- **Handoff:** approve the destination and selected content; preserve source thread/message references. Sending a reference does not transfer files or commits.

## Native access evidence and unresolved prerequisites

| Probe | Observed result | Limit |
| --- | --- | --- |
| `amp account list` | One saved user identity observed; values omitted from this record | Does not establish stable per-call effective authentication |
| Current environment presence check | No `AMP_API_KEY` or `AMP_URL` override present | Not an account binding or race guarantee |
| `amp threads list --json --limit 3` | Three records; `id`, `title`, `updated`, `tree`, `messageCount` | No executor kind or account identity |
| Bounded `amp top --stream-jsonl` sample | Initial empty frame, then one thread; zero invalid JSON lines/stderr bytes; local process exited | Experimental activity snapshots, not history, Orb identity, or completion receipts |
| `threads markdown/export --help` | Entire conversation / full payload | No documented recent-message limit; slicing after download is not pagination |
| `threads raw --help` | Full actor data; internal users only | Not a supported integration fallback |
| `threads context --help` | Estimated input context | Not documented as bounded recent-message history |
| `orb system-metrics --help` | Historical metrics by exact ID/URL | Not current executor ownership or transcript evidence |
| `plugins exec --help` | Executes an explicit plugin path and event with JSON data | Does not document authenticated host initialization |
| Approved `plugins exec scripts/amp-host-capabilities.ts session.start --data '{}'` | Exit 0; service `https://ampcode.com`; user-present false; local host; lookup function exposed | No thread methods called; authentication and remote passivity not proven |

Installed Plugin API declarations expose `system.ampURL`, `system.user`, `threads.get(exactID).state.get()`, and `messages({ from: 'end', limit: 20 })`. The host's `system.executor` describes the plugin host, not an arbitrary target thread. A message-count bound does not bound message bytes; returned content still needs a byte limit. No standalone bounded-history path is proven yet.

A capped full export could bound our retained buffer for small owned threads, but still requests the full transcript, may fail for large threads, and has narrower permissions. It is not a substitute for the agreed shared-thread recent-history contract without an explicit scope decision.

## Capability experiment result and next gate

The user approved and we ran [the one-shot capability probe](../scripts/amp-host-capabilities.ts) outside Amp auto-load directories. A fixed-argv subprocess with a 15-second deadline and 64-KiB output cap exited normally: stdout 0 bytes, stderr 233 bytes, containing only the diagnostic marker. Report:

```json
{"probe":"pi-strings-amp-host-capabilities","serviceOrigin":"https://ampcode.com","authenticatedUserPresent":false,"hostExecutorKind":"local","threadLookupAvailable":true,"threadMethodsCalled":false}
```

The probe inspected properties and called only `amp.logger.log`. It did not invoke thread methods, register tools, create agents, install anything, or change settings. A subsequent process search found no matching probe or `amp top` observer. The presence check conflates null and undefined: earlier conversational wording that asserted specifically null was too strong. No conclusion about credential validity follows.

Fresh Astra review accepted the capability-only code and interpretation, with no findings; authenticated identity, thread access, and host passivity remain unproven. A Luna follow-up inspected the exact published `@ampcode/cli@0.0.1790712063-gb89205` tarball and found wrappers/prebuilt binaries, not readable host implementation. Official search returned no `plugins exec` host/auth documentation. Native binary reverse engineering was not attempted.

The standalone-host predicate remains unresolved, not passed. Next choose a supported authenticated host and obtain explicit approval for any host activation or plugin placement; identify an exact scratch Orb before reading thread data. That experiment must prove effective identity, bounded state/history, and unchanged target executor/activity using independent observation. A method named `get` or a clean process exit is insufficient.

A deployed bridge remains conditional todo 023. If host deployment is required before 020, explicitly revise and approve that prerequisite ordering instead of waiting for 022 or silently replacing recent history with metadata/full exports.

## Acceptance and stop conditions

Production implementation starts only after the decision is reviewed, user-approved, and landed through the repository's file-todo gate. The exact-Orb smoke requires a selected target. Sending requires a separately approved message. Multiplayer proof requires a second authorized contributor. These are distinct gates, not approvals inferred from general permission to proceed.

Stop on unavailable identity, unsupported bounded read, unproven host side effects, unavailable target, or missing authorization. Record the failed predicate and next required evidence. Keep the owned ACP tools and behavior unchanged.
