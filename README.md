# pi-delegate

Install: `pi install npm:@ssweens/pi-delegate`, `pi install git:<repo>`, or `pi install ./pi-delegate`. The delegation tools, phased todo tool, `delegation` skill, and default roles all ship in the package — nothing is copied to `~/.agents`.

Requires Pi 0.99.1 or newer, below 0.100.0. Minimal delegation for pi: durable child runs, role files, fork context, steer, honest run log, and a stock-Pi phased todo list. Replaces pi-subagents (125 schema params, 14.8k lines, 11 tools in context) and pi-strings.

One tool pair, two backends:

- `backend: "pi"` (the default) runs an in-process Pi child.
- `backend: "acp"` runs an external ACP agent session: Pi, Amp, Codex, Claude or another agent in the ACPX registry. It can create a session or open an existing one by its native ID, such as an Amp `T-…` thread.

[Backends](#backends) has examples for both. [Backend limits](#backend-limits) says what each backend can and cannot do. [Migrating from pi-strings](#migrating-from-pi-strings) maps the old `op_*` tools. The design record is [ADR 0001](docs/adr/0001-delegate-backends.md).

## Tools

**`delegate({ backend?, role?, task?, model?, reason?, context?, cwd?, timeoutMs?, sync?, agent?, sessionId?, executionEnvironment?, mode? })`**
On the pi backend, `role` and `task` are required, and it runs `role` on `task` in its own in-process session (`createAgentSession`, no extensions/skills loaded — built-in tools only). Returns final report, changed files, turns, tokens, cost, run id, and the child's session file path. Refuses a second writing child in a `cwd` that already has one running. `agent`, `sessionId`, `executionEnvironment` and `mode` are ACP-only; see [Backends](#backends).

- `context: "fork"` (default) — child starts with the parent's conversation so far (`buildSessionContext` of the active branch, trailing unresolved tool call trimmed). No re-acquisition. Delegation records are left out of that inheritance — `delegate`/`delegate_ctl` calls, their results, and completion notices — so a child inherits the work rather than a pattern of handing it off; children have no delegation tools, and copies of those calls only produced confident re-delegation attempts and false "extension not loaded" diagnoses. A forked child is also told, in its own instructions, that the inherited conversation belongs to the agent that delegated to it: stripping the calls stops the mimicry, but the surrounding prose still reads as supervising a worker, and a child that adopts that voice inspects the job instead of doing it. When the parent's recent conversation is mostly orchestration, `fresh` with a complete brief remains the safer choice.
- `context: "fresh"` — adversarial/independent review.
- `model: "provider/id[:thinking]"` — tier switch at call time; no new role needed.
- Background by default — returns a run id at once. Do independent work, then use `delegate_ctl wait` when a dependency needs the result. Unjoined completion wakes the parent via `sendMessage(followUp, triggerTurn)`. `sync: true` remains an explicit option to join at launch.

**`delegate_ctl({ action: models|rate|approve|roles|status|result|wait|steer|cancel|close, runId?, runIds?, mode?, message?, model?, restart?, timeoutMs?, force?, discardPersistentState?, observe?, ratings? })`**
`status`, `result`, `wait`, `steer` and `cancel` work on runs of both backends. `close` is ACP-only. `wait` with `runIds` and `mode` joins several runs of either backend. The rest of this section covers `models` and `rate`.

`models` reports approved defaults per role, DRIFT against the live catalog (default unavailable · price changed · approval >30 days · new offerings · OpenRouter live price or expiration differs), your ratings cache, and the catalog across **all** enabled providers exactly as the registry reports it: one line per offering, `provider/id`, reasoning flag, context window, $/M in/out. Nothing is deduplicated, excluded, scoped, or ranked by price — the same weights on a subscription, a metered API, a local box, and a free tier are different offerings and the agent weighs them in the open.

For OpenRouter offerings it also fetches the public API (no key; 10-minute in-memory cache; 8 s timeout; on failure it says so and shows registry data):

- `GET /api/v1/models` once per call — appended per offering by exact id: live price where it differs from the registry (top-level pricing is what applies **right now** per the spec), every `pricing.overrides` entry rendered as stated — long-context tiers (`>272k prompt $4/15`) and UTC peak/off-peak windows (`mon…fri 06:00–10:00Z $0.3/1.2 ←now`) — with entries carrying unrecognized condition fields skipped and counted, per the spec; `request` cost when non-zero; expiration date; Artificial Analysis intelligence / coding / agentic indices.
- `GET /api/v1/models/{author}/{slug}/endpoints` for filtered OpenRouter candidates (first 12) — one line per provider endpoint: price, promotional `discount` (verified against sibling endpoints that the listed price already includes it; the undiscounted price is shown), quantization, non-zero status, 30-minute uptime, context, and the endpoint's own overrides (provider-specific off-peak).

Models live on OpenRouter but absent from the registry are listed separately (usable after adding to `models.json`). The default view lists offerings that have a rating (yours or AA), ordered by your rating then AA intelligence index; `message=<substring>` searches every offering and every provider of a candidate.

`rate` stores ratings the agent researched, keyed by exact `provider/id` (`[{model, score, source, note?}]`), in `~/.pi/agent/delegate-ratings.json`; reported stale after 14 days. Ratings appear on `models` lines.

## Backends

Ask in plain words. The agent turns the request into a `delegate` or `delegate_ctl` call. Each example shows a request and the call it becomes. `…` stands for text or IDs you supply.

### A Pi child

> "Have a scout map how sessions are stored. It does not need our conversation."

```json
{"role":"scout","task":"Map session storage\nOBJECTIVE …","context":"fresh"}
```

`backend` is omitted, so this runs on pi. `role` is a role name from `delegate_ctl roles`.

### An ACP worker

> "Ask Codex for a read-only review of src/backend.ts."

```json
{"backend":"acp","agent":"codex","role":"read-only","task":"Review src/backend.ts\n…"}
```

> "Let Claude fix the failing storage test in that worktree."

```json
{"backend":"acp","agent":"claude","role":"writer","task":"Fix the failing storage test\n…","cwd":"/abs/path/to/worktree"}
```

`agent` is required. `role` is `read-only` (the default) or `writer`, not a role name. `model`, when given, is the agent's own model ID. The session works in the parent's directory unless `cwd` names another. An ACP agent never receives your conversation, so `context` fails on acp.

### A new Amp thread, local or Orb

> "Start an Amp thread on this machine to profile the build."

```json
{"backend":"acp","agent":"amp","executionEnvironment":"local","task":"Profile the build\n…"}
```

> "Run it in an Orb instead."

```json
{"backend":"acp","agent":"amp","executionEnvironment":"orb","task":"Profile the build\n…"}
```

A new Amp thread needs `executionEnvironment`. Nothing picks local or Orb for you.

`mode` (Amp only) is Amp's agent mode: `low`, `medium`, `high`, `ultra` or a plugin mode, passed as `amp --mode` on every turn of the thread. `model` on Amp still selects one of the four built-in modes; pass one or the other, on `delegate` and on `steer` (a run created with `mode` refuses `model`). A profile's model gives way to a `mode`. The new thread is titled with the brief's first line. Once its T-ID is known, it is labeled `pi-delegate` plus the run's UUID without hyphens (Amp labels are at most 32 characters). A failed label is a note on the run, never a failure. The thread's cost is read with one `amp threads usage` once per settled turn, which the turn's `wait` result or wake-up reports, and by `status` and `result` with a `runId` unless the cached cost is current (a closed run, or a created run with no turn since). It is `unknown` until it is read; a failed read keeps the last cost and says when it was read.

### An existing Amp thread

> "Open T-… but don't post anything yet."

```json
{"backend":"acp","agent":"amp","sessionId":"T-…"}
```

With no `task`, the run is `idle`: it attaches and sends nothing. Steer it when you want to post:

> "Ask that thread to rerun the suite."

```json
{"action":"steer","runId":"amp-…","message":"Please rerun the suite and report any failures."}
```

The message goes in exactly as written, and Amp shows it as an ordinary `## User` message. To send a turn at once, put `task` in the `delegate` call. Opening rejects `role`, `model` and `mode`, because the thread keeps its own; it is never labeled or retitled. On open, `executionEnvironment` is only a hint that the provider's metadata must match.

### Wait across runs

> "Tell me when the scout or Codex finishes. Don't wait more than 10 minutes."

```json
{"action":"wait","runIds":["scout-…","codex-…"],"mode":"any","timeoutMs":600000}
```

`mode: "all"` (the default) waits for every run. `runIds` can mix pi and acp runs. A timeout ends the wait only; the runs keep going.

### Status, cancel and close

```json
{"action":"status","runId":"amp-…"}
{"action":"cancel","runId":"codex-…"}
{"action":"close","runId":"amp-…"}
```

`status` with no `runId` lists every run of both backends. Close each ACP run when you are done with it. Close is final.

### Observing an opened Amp thread

On an opened Amp run, `delegate_ctl status` or `result` with `observe: true` (and one `runId`) reads the thread: one `amp threads export` per call, returning only the messages after the last ones it showed. A plain `status` never reads the thread. Nothing polls in the background. Turns this run sends stream live.

## Backend limits

- **Authority.** On pi, `role` is a role name, and the role file sets its tools and instructions. On acp, `role` is `read-only` (the default) or `writer`, and ACPX permission policy enforces it. Some agents' own write tools can still reach outside `cwd`: see [ARCHITECTURE.md §4](docs/ARCHITECTURE.md#4-profiles-and-permissions). An opened session rejects `role` and `model` and keeps its native settings.
- **Identity.** Every run has a delegate run ID. An ACP run also has one provider request ID per turn and the provider's native session ID (`session.nativeSessionId`, such as an Amp `T-…`). The three are never interchangeable. A created session gets a worker contract appended to each prompt. An opened session gets your exact text, undecorated, and a turn sent to it is never retried.
- **Opening.** pi cannot open an existing session. On acp, opening needs an adapter that verifies native identity and can disconnect. Today the vendored Pi and Amp adapters do. Other agents fail `NATIVE_OPEN_UNSUPPORTED`.
- **Timeouts.** A `wait` timeout never cancels anything; the runs keep going. The `timeoutMs` on `delegate` or `steer` is the turn budget, which is different. On pi it aborts the child's segment. On a created ACP session it ends the turn as `timeout` (`TURN_TIMEOUT`) and the session becomes unusable: a later `steer` fails `RUN_UNUSABLE`; close the run and start a new one. On an opened session it only stops the local wait; the native turn keeps running.
- **Delivery.** Each ACP turn reports `delivery` and the provider outcome as separate fields. `delivery` is `accepted` only when the provider reports that the turn completed. Anything else (running, failed, cancelled, timed out, lost) is `unknown`. pi runs have no delivery field.
- **Cancellation.** On pi, `cancel` stops the child and turns off automatic revival. On acp, `cancel` sends ACP session cancel for the active turn this run started, with a grace period. It stops that turn, not the run, so you can steer again. The cancel result reports the cancelled turn; it does not also wake the parent. On an opened Amp thread, cancel acts only on a turn this run started; a turn someone else started is never cancelled. With no turn of this run active, cancel fails `WORKER_NOT_RUNNING`.
- **Steer.** On pi, steer queues into a running child or resumes a finished one. On acp, a running turn must finish or be cancelled first. `model` on steer is rejected on an opened session. `restart` is pi-only.
- **Close.** `close` is ACP-only; on pi it fails `ACTION_UNSUPPORTED`, so use `cancel`. Close refuses a run with an active turn unless `force: true`, which cancels the turn first. A created session is disposed; `discardPersistentState: true` also stops it from being resumable. An opened session is only disconnected. It is never cancelled, archived or deleted, and `discardPersistentState` fails `OPEN_OVERRIDE_FORBIDDEN`. Disconnecting an opened Pi session ends that local adapter process, so a turn still running there may stop with an unknown outcome.
- **Parent exit and restart.** pi children recover as [Reload and recovery](#reload-and-recovery) describes. ACP runs are *parked* when the parent exits: each session is released the way close releases it (a created one is closed but kept resumable, an opened one is disconnected), but the run is not closed. A turn still running at exit ends as `PARENT_PROCESS_LOST` with delivery `unknown`. After a restart, `status`, `result` and `wait` read the saved record without starting anything. `steer` revives the run: an opened run reopens the same native ID and checks its identity; a created run resumes only if its adapter supports ACP `session/resume` or `session/load`. Otherwise steer fails `RUN_NOT_RESUMABLE`. The record stays readable, so start a new run. A run that another live Pi process owns is read-only here (`RUN_OWNED_ELSEWHERE`).
- **Writers.** Each backend allows one writer per `cwd`, but the two backends check separately. Do not run a pi writer and an ACP writer in the same tree.

## Migrating from pi-strings

pi-strings and its `op_*` tools are retired. No `op_*` tool is registered. Use `delegate` and `delegate_ctl`:

| Old tool | Now |
|---|---|
| `op_spawn` | `delegate` with `backend: "acp"` and `agent`. The first turn is `task`. With `sessionId` it opens that native session, and `task` is optional. |
| `op_send` | First turn: `task` on `delegate`. Later turns: `delegate_ctl steer` with `message`. |
| `op_steer`, `op_append` | `delegate_ctl steer`, as a native send. Amp shows it as `## User`. Opened sessions get it undecorated and never retried. |
| `op_observe` | `delegate_ctl status` with `observe: true` on an opened Amp run. See [Observing an opened Amp thread](#observing-an-opened-amp-thread). |
| `op_status`, `op_list` | `delegate_ctl status`. With no `runId` it lists every run. |
| `op_wait` | `delegate_ctl wait`, with `runIds` and `mode` (`any` or `all`) for several runs. A timeout never cancels. |
| `op_result` | `delegate_ctl result`. It keeps each turn's request ID, delivery and truncation flag. |
| `op_cancel` | `delegate_ctl cancel`. Cooperative, with grace. |
| `op_cancel_remote` | `delegate_ctl cancel`, through ACP session cancel, for turns this run started. |
| `op_close` | `delegate_ctl close`. Disposes created sessions. Only disconnects opened ones. |

Field changes:

- Address a run by the `runId` that `delegate` returns, not by a worker `name`. Each turn's request ID is in the run's `turns`.
- `agent` is required. It no longer defaults to `pi`.
- `prompt` becomes `task` (first turn) or `message` (steer). `requestTimeoutMs` becomes `timeoutMs` on `delegate` or steer. `waitTimeoutMs` becomes `timeoutMs` on `wait`.
- `delegate` takes no `profile`, `tools` or `predecessorRequestId`, and `cancel` takes no `reason`. Choose tools with `role: "read-only"` or `"writer"`. Wait on runs by listing their `runIds`, not by `names` or `all`.

**The Amp plugin bridge is gone.** pi-strings once reached Amp through a project plugin and portal (`op_observe`, `op_append`, `op_steer`, `op_cancel_remote`). That bridge and its `PI_STRINGS_AMP_BRIDGE_*` settings are deleted. Every Amp control now takes a native path: steer is a native send, cancel is ACP session cancel, and observation is `amp threads export`. One thing is lost: cancelling a turn that someone else started in a shared thread. Cancel only ever acts on this run's own turn.

The ACP Coordinator still keeps its state under `~/.pi/agent/pi-strings/`. That directory name did not change.

## Phased todos

The `todo` tool and `/todo` command are owned by pi-delegate. They provide OMP-style phased tasks with immutable state transitions, session/branch restoration, an above-editor widget, compact/expanded tool rendering, and `TODO.md` import/export.

Todo state writes use the `pi_delegate.todo` session-entry namespace. Existing `pi_omp.todo` entries are read-only migration input, so installing or reloading pi-delegate does not discard an existing plan. Reminders are bounded and suppressed when the turn was aborted, the assistant is asking a question, a prior reminder is awaiting progress, or an unsettled delegate child will wake the parent.

## Waiting for an existing child

```json
{"action":"wait","runId":"<id returned by delegate>"}
```

`wait` joins that execution segment without polling, relaunching, or changing the child. It returns the final report and terminal status (`complete`, `error`, `timeout`, `cancelled`, or `interrupted`). Already finished? It returns the stored result immediately. `result` remains a nonblocking read of the current report.

- Cancelling a wait detaches only that waiter. The child keeps running and can still wake the parent. Use `cancel` to stop the child itself.
- Waiters attached at completion receive the result instead of a separate completion wake-up. Multiple waiters receive the same result. A late wait does not retract an earlier notification or send another one.
- `steer` always returns without waiting for the child to finish: it queues a correction on a running child or resumes a saved inactive child in the background. Use `wait` to join resumed work; otherwise completion wakes the parent. Cancelling the parent tool does not cancel the background child.
- A finished child resumed with `steer` gets a new completion; earlier returned results do not change. A child still stopping cannot resume until its execution settles.
- Recorded launch, control, and completion details are snapshots. Later worker activity does not mutate earlier tool results. The Agents frame remains live.
- Run IDs belong to their parent session. Reloading or reopening that same parent restores access to its children. `wait` joins a live child or returns its saved result; it never restarts work.

## While a child runs

Launching never blocks the parent's turn; joining does. A blocking join writes a live line into the transcript for as long as it lasts — `⏳ Waiting for scout-… · bash · 2m14s · abort to stop waiting; the child keeps running` — and the Agents frame adds `parent blocked in wait`. While that line is on screen, a prompt you type is queued as **Steering** because the parent's turn is busy, not because delegation is synchronous. Aborting the tool detaches the waiter and leaves the child running; the line gives way to the outcome when the child finishes. An async launch writes nothing, because nothing is waiting.

The parent is woken **once**, when a child finishes. There are deliberately no mid-run progress pings: an interrupt per tool call would spend a parent turn on information nobody asked for, and the human already watches live progress in the pinned Agents frame. Waiting is not the parent's work — it does other work, or `wait`s (blocking without polling), or takes a single `status` read:

```
running · worker-791ede7d · role worker · model … · 3 turns in 41s · tokens in 6, out 1.5k
session: …
now: bash · 12 tool calls so far · 47 min of its budget left
```

Failed requests are counted as attempts, not as turns of work, and reported on their own line: `2 provider attempts failed and were retried before this (last: terminated)`. Three turns and ten minutes for a one-line answer is a stalled provider, not a thoughtful child — and a timeout whose budget went to failed attempts says exactly that instead of suggesting a bigger budget. A run's wall clock, its turns, and its provider's failures stay distinguishable.

`timeoutMs` is that budget, 15 minutes by default, and it belongs to the current run segment. A child that needs hours must be launched with hours, or it is aborted mid-flight; a timeout says so, names the budget, and leaves the work in place — nothing is rolled back. `{"action":"steer","runId":"<id>","message":"…","timeoutMs":3600000}` re-arms a running child's budget immediately and persists it for later segments; a budget already spent is refused rather than applied as an instant kill.

A missing automatic continuation is a delivery problem to investigate, not a reason to make all launches synchronous. Check the parent transcript and Pi's `send_message` extension errors to distinguish child completion, notification delivery, and parent continuation.

## Reload and recovery

Children run inside Pi, not in detached runners. `/reload` replaces the extension binding and reconnects the Agents frame to the same live sessions. It does not restart or cancel their work.

Closing Pi or switching parent sessions interrupts active children. Reopening the same parent restores saved children without running them. After a crash, an unfinished child appears as `interrupted`; inspecting its transcript, reading its result, or waiting does not resume it. Inspect interrupted tool work before continuing: interruption does not undo side effects.

Send a message with `steer` to resume an inactive child under the same run ID and transcript. Revival uses the saved model, reasoning level, tool list, role instructions, project instructions, working directory, and timeout—not current role files or model defaults. Missing history is an error, not permission to start a replacement. Finished sessions evicted from memory can also revive this way.

An unavailable or exhausted saved model is also an error, and the choice of replacement is yours: `{"action":"steer","runId":"<id>","message":"...","model":"provider/id[:thinking]"}` revives that child on the offering you name, keeping its ID, transcript, tools, and instructions. The new offering applies from that segment on and is persisted, so later revivals use it; earlier segments keep the model they actually ran on, and the omitted reasoning level stays as saved. A running child refuses the switch—its turn is already bound to its model, so wait or `cancel` first. The agent proposes the replacement in conversation before calling this; nothing substitutes an offering on its own.

A model spec naming a provider resolves to that provider only. `openai-codex/x` never falls back to `openrouter/x`: same weights on another route differ in cost, limits, and serving, so an unavailable one is reported, not silently swapped.

An explicit `cancel` remains stopped across reloads and process restarts. The agent must have your request before using `steer` with `restart: true`. Typing a message in a stopped child's **Restart** editor is your direct restart request.

Completed results and interrupted executions are separate states. On reopen, an undelivered result is reported without rerunning the child. Delivery receipts in the parent transcript prevent replay of results already recorded there. A receipt establishes delivery, not that the parent finished acting on it.

One filesystem lease owns each parent's children. Opening the same parent in another Pi process cannot start a second child writer. After an abrupt crash, the lease expires within 10 seconds; retry opening the parent after that. Different parent sessions remain independent.

Recovery metadata is recorded for children launched by this version. Older transcript files remain readable but have no saved parent/runtime contract to revive.

## Which offerings a child can use

A child runs on the parent's catalog, including providers that extensions register at runtime — account switchers, gateways, subscription pools. Those registrations are mirrored into the child runtime each time a child session opens, so launch order does not decide what a child can run, and a provider registered after the first child still works. A provider the parent drops stops serving children that have to reopen their session; a session already in memory keeps the model it was built with. Nothing about those providers is copied into a child's saved record beyond the `provider/id` it ran on, so credentials stay with the parent's runtime.

## Model approval

A `delegate` call resolves its model as `model:` param → approved default for the role → role file → your current model, and runs. There is no dialog: proposing a non-default model is a conversation — the agent states offering, price, tradeoff, rating, asks, and launches on your answer. `delegate_ctl action=approve role= model= message=` records a default in `~/.pi/agent/delegate-models.json`; the skill forbids calling it without your explicit yes in the conversation. The file also snapshots the catalog so `models` can report drift and new offerings since approval.

## Watching children

One OMP-style **Agents** frame above the parent editor shows only running or stopping children. Each row shows the task title, role, current tool, and elapsed time. When a child settles, its row leaves the frame; when none remain active, the frame disappears. Finished rows do not return on reload. Put a short title on the first line of the delegation brief; the UI displays it without generating a summary.

- **Ctrl+J** focuses the active list, or opens finished-child history when no children are active. It never chooses a child for you. Ctrl+J is also one of Pi's default newline keys (`tui.input.newLine`: Shift+Enter, Ctrl+J), so this binding takes it over and Pi reports `Extension shortcut conflict: 'ctrl+j'` at startup. To keep the newline on other keys and silence the report, put `{ "tui.input.newLine": ["shift+enter"] }` in `~/.pi/agent/keybindings.json` and `/reload`.
- **↑↓** selects an active child; **Home/End** and **PgUp/PgDn** navigate longer lists. The frame shows at most four rows, scrolling internally. Active rows stay in dispatch order; selection stays on its child while that child remains active. If the last active row finishes while the list has focus, focus returns to the parent editor.
- **Enter** opens the selected child's conversation across the whole viewport. The parent display is hidden, not repeated behind a floating inspector.
- In the child view, type a message and press **Enter**. Running children receive a queued steer; saved inactive children resume in the same session. A stopped child shows **Restart**. **PgUp/PgDn** scrolls the conversation; **Ctrl+End** follows the latest output; **Ctrl+X** stops that child.
- **Esc** returns to the parent editor without stopping the child. Parent and child drafts are separate; returning preserves the parent draft and list selection.
- **`/agents`** opens an on-demand list of finished children, including failures, cancellations, and interrupted runs. Select a row with **↑↓**, then **Enter** to inspect it; **Esc** closes the list. History remains available while other children run. Removing a row from the pinned frame does not delete its session or prevent revival.

The child transcript uses Pi's own assistant/user message, built-in tool, and editor components—not a second text/JSON renderer. It opens at the newest output and follows streaming text and tool output. **PgUp** pauses following; **Ctrl+End** or paging back to the bottom resumes it. Tools start collapsed; Pi's **Ctrl+O** action expands/collapses them, and its thinking-toggle binding controls reasoning display. Markdown, code highlighting, errors, and tool results use the active Pi theme. Fullscreen mode also supports Pi's native click-to-expand tool results and mouse-wheel scrolling; regular mode leaves mouse handling to the terminal emulator. It does not launch a second writer against the child's session file. Opening a saved child reads its transcript without reviving it; sending a message revives it.

## Control-tool output

`delegate_ctl` results are drawn by Pi's standard tool shell — the same box, padding and success/error background as `read` or `bash` — rather than a bare text dump: a titled call line (`delegate_ctl roles 3`, `delegate_ctl wait scout-…`), output in tool colours, and a preview clipped by *visual* lines with `ctrl+o to expand`. The preview keeps the **head** of the report, because these reports lead with what matters — approved defaults, drift, counts — unlike a shell command whose tail is the interesting part.

Children are drawn the same way everywhere — pinned frame, `status`, completion record: a status glyph and bold title in the state's colour (accent while running, success, error, warning), the current tool in accent while it runs, then role, elapsed, turns, cost, failed attempts and changed files in descending emphasis. `status` without a run id lists one such row per child under a counted header.

`roles` renders one aligned row per role with the facts you choose by — context and reasoning level, the offering it will run on, whether it writes to your tree, how many tools it gets — and keeps each role's purpose and file path behind the expand. Role descriptions are written for the model and do not survive a column, so they are never clipped mid-sentence into one. `status` and `result` on a single child render the same compact outcome line the transcript already uses. The text handed to the model is unchanged and complete in every case; only the human's view is clipped.

## Reading a result

Every returned report is a run description followed by the child's own words, fenced so the two cannot be confused:

```
complete · worker-791ede7d · role worker · model anthropic/claude-sonnet-5:medium · context forked from 215 parent messages · 3 turns in 25s · tokens in 6, out 1.5k, cached 639.2k · $0.9446
session: /…/.agents/pi/subsessions/….jsonl
changed: src/thing.ts

----- worker-791ede7d reported, verbatim -----
STATUS: complete
…
----- end of report -----
```

The `session:` path is the child's full transcript; read it when a report looks wrong rather than guessing whether the wrapper is stale.

## Transcript records

Async launches have no duplicate status card or dispatch frame in the conversation. Each completed run segment produces one compact line: status glyph, task title, role, and elapsed time. Non-success statuses and unavailable-tool warnings stay visible on that line. **Ctrl+O** expands the full report, error, model, changed files, and session path. Joined waits and sync calls render their outcome directly rather than adding a completion message. Control-tool queries remain ordinary transcript records, not live dashboards.

## Run log

`~/.pi/agent/delegate-runs.jsonl` — one line per run: id, role, model, thinking, context, cwd, **task text**, status, tokens, cost, duration, changed files, dropped tools, error, first 2 KB of output. Child transcripts persist in the working directory the child ran in: `<cwd>/.agents/pi/subsessions/` — `tail -f` one to watch a child live. The full path is in every run-log row (`sessionFile`) and in the expanded outcome record. Each child also has an atomic JSON snapshot of its identity, runtime inputs, stop state, and result. Parent indexes and ownership leases live in the parent's working directory under `.agents/pi/subsessions/owners/`. ACP run records (identity, native session, turns with request IDs, delivery and output) are saved next to them under `owners/<parent>/acp/`. The directory gets a self-ignoring `.gitignore` (`*`) on creation, so transcripts never reach `git status` or a child's `git add -A`; it is scoped to that directory, so a repo can still track `.agents/` for agent definitions.

## In-process milestone events

Extensions in the **same parent Pi session** may subscribe to `pi.events.on("pi-delegate:milestone.v1", handler)`. Events have `{ version: 1, runId, segment, role, kind, at }` and one kind-specific payload: `started` has a bounded `task`, `note` has up to 500 characters of the child's completed assistant text, and `settled` has `status` and up to 20 changed paths. A note can arrive while the child is still running; the event bus does not start a parent model turn or add a child tool. Silent/tool-only children supply start and settlement, not an invented narrative. These events are **ephemeral**; the existing parent completion receipt and run log remain the durable facts. On reload, live children publish subsequent milestones to the newly attached parent extension. Cross-process peers need a separate transport such as pi-intercom; this event channel has no broker.

## Verification

From this package directory, use Node.js 22.19 or newer:

```sh
npm install
npm run check
```

`check` runs package-local strict TypeScript and `node:test` through `tsx`. No global SDK paths, model accounts, or credentials. Lifecycle tests use the actual Pi SDK and extension against a scripted loopback HTTP provider; only model responses are fixtures. They exercise runtime-only provider inheritance, live reload, fork persistence, wait/cancel/async revival, cancellation during SDK preflight, provider failures/timeouts, automatic idle/busy-parent wake-up, reload-gap delivery, ownership contention, cold inspection, and SIGKILL receipt recovery. Direct tool calls seed parent receipts at the return boundary; automatic notifications use Pi's real delivery path. Crash checks wait for the real 10-second ownership lease to expire.

Run the additional check when its boundary changes:

| Change | Check |
|---|---|
| Manifest, resources, dependencies, install layout | `npm run check:install` |
| Rendering, navigation, input, streaming, focus | `npm run smoke:tui` (requires tmux; regular and fullscreen Pi) |
| Completion, cancellation, delivery, persistence—or their assertions | Scoped mutation of the affected production behavior, after its baseline passes |
| Docs only | Check examples/resource paths; no terminal or model run required |

`check:install` packs the candidate, installs dependencies in an isolated extracted directory, runs the real `pi install`, and checks all tools, packaged roles, and the delegation skill. Pi links local directories without installing dependencies: run `npm install` in a local checkout first. npm/Git installs manage dependencies themselves. To check a published npm or Git source explicitly: `npm run check:install -- npm:@ssweens/pi-delegate@<version>` or `npm run check:install -- git:<repo>@<ref>`; that checks the named source, not uncommitted local changes.

`smoke:tui` runs actual Pi and actual built-in tools with the loopback provider in a private tmux server. It checks native tool disclosure, streaming/follow vs paused scrolling, narrow resize, separate drafts, history, same-ID revival, and finished-frame removal. It prints the temporary evidence directory containing text/ANSI terminal captures, traces, and sessions; it stops only its own tmux server. Parent model wake-up is disabled in this UI fixture and verified separately by lifecycle tests.

For independent review, give the reviewer these runnable commands and the affected contract. They execute the relevant checks rather than accepting an implementer's pass banner. Scope mutation to changed semantics and changed assertions; report survivors/timeouts/uncovered sites separately. No arbitrary score threshold, new role pipeline, or mandatory UI/install run on every edit.

## Not included, on purpose

Missions, lanes, watchdogs, acceptance protocols, preflight/supersession records, councils, schedules, intercom, worktree management. Use a brief, a slash command, or `bash` (`git worktree add`) — none of it belongs in a schema the model reads on every turn.
