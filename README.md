# pi-delegate

Install from a local checkout with `pi install ./pi-delegate`. This private package is not published to npm. During the tether compatibility window, use this package instead of `pi-tether`; do not list both packages in Pi or Oven settings because both declare Path. The delegation tools, phased todo tool, `delegation` skill, and default roles all ship in the package. Nothing is copied to `~/.agents`.

Requires Pi 0.99.1 or newer, below 2.0.0. Minimal delegation for pi: durable child runs, role files, fork context, steer, honest run log, a stock-Pi phased todo list, Path's unified activity view, and an away recap after idle. Path's trail (the append-only index of waypoints into the transcript, mode `trail`) is documented in [`docs/trail.md`](docs/trail.md); the older work-graph modes are in [`docs/map-modes.md`](docs/map-modes.md). Replaces pi-subagents (125 schema params, 14.8k lines, 11 tools in context) and pi-strings.

One tool pair, three backends:

- `backend: "pi"` (the default) runs an in-process Pi child.
- `backend: "acp"` runs an external ACP agent session: Pi, Amp, Codex, Claude or another agent in the ACPX registry. It can create a session or open an existing one by its native ID, such as an Amp `T-…` thread.

- `backend: "process"` runs an ordinary OS command without an agent or model.

[Backends](#backends) has agent examples. [Background commands](#background-commands) covers processes. [Backend limits](#backend-limits) says what each backend can and cannot do. [Migrating from pi-strings](#migrating-from-pi-strings) maps the old `op_*` tools. The design record is [ADR 0001](docs/adr/0001-delegate-backends.md).

## Tools

**`delegate({ backend?, command?, role?, task?, model?, reason?, context?, cwd?, timeoutMs?, agent?, sessionId?, executionEnvironment?, mode? })`**
On the pi backend, `role` and `task` are required, and it runs `role` on `task` in its own in-process session (`createAgentSession`). The child re-binds its parent's already-loaded extensions and calls its parent's MCP tools, and gets their tools, limited to its role's [`tools`](#role-tools) line; skills, prompt templates and themes are not loaded. Returns final report, changed files, turns, tokens, cost, run id, and the child's session file path. Refuses a second writing child in a `cwd` that already has one running. `agent`, `sessionId`, `executionEnvironment` and `mode` are ACP-only; see [Backends](#backends).

- `context: "fork"` (default) — child starts with the parent's conversation so far (`buildSessionContext` of the active branch, trailing unresolved tool call trimmed). No re-acquisition. Delegation records are left out of that inheritance — `delegate`/`delegate_ctl` calls, their results, and completion notices — so a child inherits the work rather than a pattern of handing it off; copies of those calls only produced confident re-delegation attempts and false "extension not loaded" diagnoses. The records are left out for children that have the delegation tools too. A forked child is also told, in its own instructions, that the inherited conversation belongs to the agent that delegated to it: stripping the calls stops the mimicry, but the surrounding prose still reads as supervising a worker, and a child that adopts that voice inspects the job instead of doing it. When the parent's recent conversation is mostly orchestration, `fresh` with a complete brief remains the safer choice.
- `context: "fresh"` — adversarial/independent review.
- `model: "provider/id[:thinking]"` — tier switch at call time; no new role needed.
- Background handoff — records the run and returns its id before child resource preparation or model work. Do independent work; unjoined completion wakes the parent via `sendMessage(followUp, triggerTurn)`. Use `delegate_ctl wait` only when dependent work needs the result.

**`delegate_ctl({ action: models|deals|rate|approve|roles|status|result|wait|steer|cancel|close, runId?, runIds?, mode?, message?, model?, restart?, timeoutMs?, force?, discardPersistentState?, observe?, ratings? })`**
`status`, `result`, `wait`, and `cancel` work on all three backends. `steer` works on agent runs. `close` is ACP-only. `wait` with `runIds` and `mode` joins any mixture of pi, ACP, and process runs. The rest of this section covers `models` and `rate`.

`models` without a `runId` reports approved defaults per role, DRIFT against the live catalog (default unavailable · price changed · approval >30 days · new offerings · OpenRouter live price or expiration differs), your ratings cache, and the catalog across **all** enabled providers exactly as the registry reports it: one line per offering, `provider/id`, reasoning flag, context window, $/M in/out. Nothing is deduplicated, excluded, scoped, or ranked by price — the same weights on a subscription, a metered API, a local box, and a free tier are different offerings and the agent weighs them in the open.

`models` with an ACP `runId` instead lists that agent's selectable choices: current ID, each provider-advertised option's ID/name/description, and `source: native` or `source: fallback`. Native ACP config metadata wins. Claude's documented aliases (`default`, `best`, `fable`, `opus`, `sonnet`, `haiku`, long-context variants and `opusplan`), Codex's known IDs, and Amp's built-in modes remain maintained fallbacks when an adapter omits discovery; a provider still decides whether a fallback ID is accepted. One-run `status` and `result` include the same catalog in compact form.

For OpenRouter offerings it also fetches the public API (no key; 10-minute in-memory cache; 8 s timeout; on failure it says so and shows registry data):

- `GET /api/v1/models` once per call — appended per offering by exact id: live price where it differs from the registry (top-level pricing is what applies **right now** per the spec), every `pricing.overrides` entry rendered as stated — long-context tiers (`>272k prompt $4/15`) and UTC peak/off-peak windows (`mon…fri 06:00–10:00Z $0.3/1.2 ←now`) — with entries carrying unrecognized condition fields skipped and counted, per the spec; `request` cost when non-zero; expiration date; Artificial Analysis intelligence / coding / agentic indices.
- `GET /api/v1/models/{author}/{slug}/endpoints` for filtered OpenRouter candidates (first 12) — one line per provider endpoint: price, promotional `discount` (verified against sibling endpoints that the listed price already includes it; the undiscounted price is shown), quantization, non-zero status, 30-minute uptime, context, and the endpoint's own overrides (provider-specific off-peak).

Models live on OpenRouter but absent from the registry are listed separately (usable after adding to `models.json`). The default view lists offerings that have a rating (yours or AA), ordered by your rating then AA intelligence index; `message=<substring>` searches every offering and every provider of a candidate.

**`/deals [model substring]`** opens a keyboard-driven comparison sheet in Pi's TUI without an LLM turn. It leaves a compact, expandable result in the transcript when closed, excluded from model context; in non-TUI modes it saves the result directly. The agent can request the same data with `delegate_ctl {"action":"deals","message":"<substring>"}`. The optional substring limits the OpenRouter model IDs fetched. The sheet has four labeled tabs—**Provider discounts** (declared endpoint promotions), **Timed rates** (scheduled cheaper/peak windows), **Frontier value** (top 15% AA Intelligence), and **Light value** (next 35% AA Intelligence). It opens on the first populated tab and includes **all eligible rows** (one per discounted endpoint, one per model/provider schedule, one per value model), not a hard-coded shortlist. The transcript and agent text preview only the first 4/3/2/2 rows and report how many remain in the sheet.

In the sheet: **1–4** or **Tab/Shift+Tab** changes tabs; **↑↓**, **PgUp/PgDn**, **Home/End** move through rows; **/** filters by model, provider, or timing; **d** sorts by discount/off-peak saving percentage, **p** by basket cost, **i** by AA Intelligence, **c** by AA Coding, **n** by model (repeat a key to reverse); **Enter** opens the provider/timing explanation (scroll long details with **PgUp/PgDn**); **r** fetches fresh catalog and endpoints even during the ten-minute cache window; **Esc** closes and saves the displayed scan. The grid shows **USD per million** input/output, provider, declared endpoint discount or peak-saving %, and both AA scores (— if unavailable). It omits the repeated `openrouter/` display prefix and dollar symbols, rounds rates to two decimals (`<0.01` for a positive rate below a cent), and retains exact IDs and numeric prices in the saved data. On **Timed rates**, In/Out is the **cheaper scheduled rate**, not necessarily the current one; each row shows the active state and **next Off / Peak hours in Pacific** without opening details. Enter shows the current rate, exact offering ID, and all listed windows. Narrow terminals stack cells instead of hiding hours or scores. OpenRouter's declared endpoint discount is already reflected in its endpoint price; it is **not** a saving from the model-wide price and may require pinning that provider. Timed rows show **Peak / Off-peak / No rate** **at scan time** (not a live clock), the rate active then when listed, and the selected cheaper and peak windows in Pacific time (PDT/PST, including day and daylight-saving changes). The sheet shows the scan time in Pacific; **r** refreshes status before choosing near a window boundary. An unlisted state means none of the declared windows covers the scan time, not an inferred peak rate. Savings compare the selected cheaper window with that rate's highest-priced declared window.

Value compares a stated basket of 1M prompt + 250k completion tokens using **listed model prices, not discounted endpoint prices**; frontier means the top 15% of today's AA-Intelligence-scored, tool-capable text models with at least 128k context, and light means the top half below that frontier with at least 32k context. These are relative score bands, not a guarantee of task performance. Free, `:batch`, and per-request-priced models are excluded from the value ranking; promotional offers with missing AA scores remain visible. Non-healthy endpoints are omitted. The scan checks every eligible model's endpoints in batches of eight, caches successful responses for ten minutes unless refreshed, and reports lookup failures rather than claiming a complete promotion scan. Entries absent from Pi's available OpenRouter registry are labeled **not configured**. This action never switches or approves a model.

`rate` stores ratings the agent researched, keyed by exact `provider/id` (`[{model, score, source, note?}]`), in the `ratings` section of `~/.pi/agent/pi-delegate.json`; reported stale after 14 days. Ratings appear on `models` lines.

## Background commands

```json
{"backend":"process","command":"npm run build","task":"Build project","cwd":"/absolute/project"}
```

`delegate` returns immediately with a `process-…` runId, PID when spawned, and `outputFile`. `task` is an optional display title. Command bytes are preserved. Processes have no default execution deadline. A positive integer `timeoutMs` sets one, independently of the timeout on `delegate_ctl wait`.

Use `delegate_ctl status` or `result` to read without waiting, `wait` to join, and `cancel` to stop the owned command tree. A wait timeout or abort never stops the command. Unjoined completion wakes the parent once with status, exit code or signal, and output tail. A joined wait receives that completion instead.

Stdout and stderr share a private output file. Results include its path, the last 64 KiB, and a truncation flag. Nonzero exit, launch failure, cancellation, execution timeout, and lost-owner interruption remain distinct. Process calls reject agent fields, including `role`, `model`, `context`, `agent`, `sessionId`, `runtime`, `tui`, `mode`, and `firstDeliverableMin`. `steer`, `close`, and `models` with a process runId fail `ACTION_UNSUPPORTED`. There are no environment, PTY, stdin, or arbitrary-PID adoption options.

The Activity box keeps Agents unchanged and adds Processes with title, state, elapsed time, and exit code when known. Compact mode includes the process count. Use the existing list navigation to select a process. Its detail view shows command, cwd, PID, outputFile, and output tail. Ctrl+X stops it. No model, token, cost, thinking, or agent-health facts appear on process rows.

Commands survive turns and `/reload`. Quitting or replacing the parent session stops its owned commands. Reopening reads records without replay or PID adoption. A command whose owner was lost is `interrupted`, with an unknown outcome. Cleanup signals only owned child handles and verified descendants; cleanup failure is reported, not treated as success. This does not guarantee cleanup of every daemon.

## Roles

A role is a Markdown file with frontmatter. These directories are read in order, and a later file overrides an earlier one with the same `name`: the package's `roles/`, `~/.pi/agent/agents/`, `~/.agents/agents/`, and the project's `.pi/agents/` when the project is trusted. `delegate_ctl roles` lists what is loaded. It shows a role whose tools allow `delegate` but not `edit` or `write` as `delegates; can write via children`, because the children it starts can be writers. A role with no `tools` line shows as `every tool`.

```markdown
---
name: scout
description: Read-only recon of code the parent has not seen.
tools: read, grep, find, ls, bash
context: fresh
thinking: low
---

Instructions for the child.
```

`context` is `fork` (the default) or `fresh`. `model`, `thinking` and `timeoutMs` set the role's defaults. `tools` is described next.

`model` can list several models, most preferred first: `model: openrouter/big:high, local/small` or a YAML list. A `delegate` call that names no model, for a role with no approved default, runs on the first entry this session can use: it needs credentials, and with **Model picking** set to *First scoped* (the default) it must also be in Pi's scoped models (`--models`, or `enabledModels`) when a scope is set. The run's `status` and `result` say which entry it got and why each earlier one was skipped (`model picked: …`). When none is usable the call fails with `MODEL_UNAVAILABLE`, naming each reason; a role that lists models never quietly runs on your model instead. A single `model` entry is a pin, as before: it ignores the scope. `/delegate settings` → **Roles** shows what each role would run on right now.

### Role tools

A child gets what its parent gets. Its session runs the extensions the root session loaded (your agent directory's extensions, your installed packages, and the root project's extensions when the child's project is trusted), each bound to the child's own extension API. The modules are not imported again: the child's loader loads from the root session's folder, so Pi's per-folder factory cache hands it the factories the root already imported. Its MCP tools are the parent's (see [MCP servers](#mcp-servers)). Pi's `codemode` and `tool_search` extensions are not loaded in a child. A role's `tools` line limits which of the resulting tools the child gets:

```markdown
tools: read, grep, find, ls, bash, web_search, fetch_content, mcp__github__*
```

- **No `tools` line** gives the child every tool its session has: Pi's built-ins, every extension tool, every MCP tool, and `delegate` and `delegate_ctl`.
- **A `tools` line** is an allowlist of tool names. A name is a built-in (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`), an extension's tool (`todo`, `web_search`, `fetch_content`, `web_fetch`, `google`), an MCP tool (`mcp__<server>__<tool>`), or `delegate` or `delegate_ctl`. A trailing `*` matches every name that starts with the text before it: `mcp__github__*` is every tool of the `github` server, `web_*` every tool whose name starts with `web_`. Write MCP tool names as Pi does. Pi 1.0 writes a `-` in a server name as `_`, so the `ableton-mcp` server's tools are `mcp__ableton_mcp__*`.
- **A tool the child may not have is not registered in its session at all.** The model cannot call it.
- **A listed name that matches no tool** the child's session offered is reported when the run settles, as a tool the child could not have. An extension that is not installed, a misspelled tool, or a server that did not connect shows up this way.
- **Declared tools.** The child's model is told about Pi's default tools and the extension tools that ask to be declared, as in your session. A tool the role names exactly is declared too, as `pi --tools` does. The parent's MCP tools are direct tools in a child, whatever their exposure in the parent, so a child needs no `codemode` or `tool_search` to call them.
- **Writers.** A role whose tools allow `edit` or `write` is a writer, and so is a role with no `tools` line. One writer per `cwd` applies. An extension or MCP tool that edits files does not make a role a writer for that rule. Give a read-only role such a tool only on purpose.
- **`todo` is session-local.** Each in-process Pi child has its own session-backed list; it never reads or changes the parent's todos. The tool is available when the role's `tools` allowlist includes `todo`, or when the role has no allowlist. Automatic todo reminders remain root-only.

The parent's own pi-delegate is not loaded a second time in a child. The child runs its own copy, which provides `delegate` and `delegate_ctl` when its tools allow them.

Path normally ends with its parent session: quit archives its execution, reload only rebinds, and pause archives even detached work. Opt into persistence in **/path settings → Detached background** (also in /delegate settings), or save `path.detached: true` in pi-delegate settings. This explicit global setting uses `expires: "never"`; turn it off to restore the bounded lease. It is never inferred from runtime or owner attribution.

Path is the root parent's alone. No child runs it: an extension that brings it (this package installed, or pi-tether) is left out of every child's session, together with its `path` tool, `/path` command and shortcuts, so a child never follows, maps or advises on its own session. An ACP Pi worker skips it too, and an oven child gets only the extensions its role names.

### Extensions in a child

A child has no UI. Its extensions get Pi's headless UI, as in print mode: `ctx.hasUI` is false, `select`, `input` and `custom` return nothing, and `confirm` returns false. An extension that throws while loading is left out, and one whose event handler throws keeps running without that handler. In both cases the child still runs, and its status, result and completion list the failures under `extensions that failed in the child`.

Every extension runs in each child, and some do work there you may not want:

- An extension that launches a browser or a background process when a session starts does so in each child.
- An extension that asks before risky actions, such as a permission gate, gets no answer in a child and usually refuses.
- An extension that writes process-wide state, such as environment variables for an account, changes that state for the parent too, because a child runs in the parent's process.

Keep such tools away from a role with a `tools` line. To keep an extension out of children entirely, disable it in your settings.

### Nested delegation

A child whose tools allow `delegate` can start children of its own, and `delegate_ctl` lets it wait for, steer and cancel them. A role with no `tools` line has both. A role with a `tools` line has the ones it lists. List both for a coordinating role, such as a PR owner that starts its own verifiers:

```markdown
tools: read, grep, find, ls, bash, delegate, delegate_ctl
```

- **Depth cap.** The root parent is depth 0 and its children are depth 1. No child runs deeper than **Max depth** in `/delegate settings` (`maxDepth`, 1–8, default 3). A child at the limit gets neither `delegate` nor `delegate_ctl`, whatever its role lists: its instructions say it runs at the depth limit, and the delegation tools are not reported as dropped. A delegating child below the cap is told its depth and the cap. A `delegate` call that would still start a child deeper than the cap fails with `DEPTH_EXCEEDED`, and the error names the cap. A change applies to children started after it.
- **Same machinery.** A nested child is an ordinary pi run: the run log, ownership leases, revival, steer, and one writer per `cwd` across the whole tree. Its model resolves as `model:` → the role's approved default → the role file → the delegating child's model. Its catalog is mirrored from the delegating child's runtime, which is mirrored from the parent's. Its tools come from its own role, not from the delegating child's: a read-only coordinator can start a writer.
- **Forks.** Delegation records stay out of forked context at every depth. A child forked from a coordinator inherits its work, not its `delegate` calls, their results, its completion notices, or the prompt that revived it. A `codemode` call whose script calls `delegate` or `delegate_ctl` (`tools.delegate(…)`, `tools["delegate_ctl"]`) is left out too. A script that only mentions the word, such as `searchTools("delegate")`, stays, and so does one that builds the tool name at run time. Where the removed turns sat between two assistant messages, a one-word user turn, `Continue.`, takes their place, so user and assistant turns still alternate, as some providers (Bedrock's Converse API among them) require. Where removing an assistant turn that only delegated leaves two user turns in a row, they are merged into one user turn, in order. No assistant turn is invented, so the model is never shown words it did not say.
- **Project trust.** Every Pi child, nested or not, gets its trust for its `cwd` when it is started, and keeps it across revivals. Where its parent works, it is the parent's own decision. In another folder:
  1. Pi's saved decision for that folder (the nearest ancestor with an entry in Pi's `trust.json`) wins.
  2. Otherwise, when the parent is the root interactive session, pi-delegate asks you with Pi's own choices for that folder: **Trust**, **Trust parent folder**, **Trust (this session only)**, **Do not trust**, **Do not trust (this session only)**. The answer is saved exactly as Pi saves it and used. Agents often work in copy-on-write repo copies such as `~/.agents/projects/<slug>/copies/<name>/`: choose **Trust parent folder** once on the `copies` folder and later copies are trusted without a question. Dismissing the question counts as **Do not trust (this session only)**: the child is untrusted, nothing is saved, and the delegating session does not ask about that folder again. Aborting the `delegate` call while its question is open closes the question the same way and starts no child (the call fails `ABORTED`), and lets the next queued question be asked.
  3. Otherwise (a nested child, or a parent in print mode or another mode without a dialog UI), the child gets the delegating parent's own decision. That decision covers the folder's `.pi/agents` roles too: a trusted parent without a UI hands its trust to a child in an unrecorded folder, and a delegating child there loads that folder's roles. Record a decision for the folder in Pi's `trust.json` to avoid this.

  As in Pi, a folder with nothing trust-gated in it is never asked about; it gets the parent's decision. Trust-gated means what Pi gates (`.pi` settings, `mcp.json`, extensions, skills, prompts, themes, `SYSTEM.md`, `APPEND_SYSTEM.md`, and project `.agents/skills`) plus pi-delegate's own `.pi/agents` roles, which Pi does not know about. A folder whose only project resource is `.pi/agents` is asked about, so a repository cannot redefine a role such as `scout` with write tools, `delegate` or MCP tools under a trusted parent's trust. `defaultProjectTrust: "always"` or `"never"` in your global settings answers instead of you, as it does for Pi. An untrusted child reads nothing from `<cwd>/.pi`: not its settings, not its extensions, not its `mcp.json`, and, for a delegating child, not its `agents/`.

  A run's status, result and completion say its trust and why, as `project trusted (trust source: <source>)`, and its record keeps `projectTrustSource`. The sources: `parent` (it works where its parent does), `saved` (Pi's `trust.json`), `ungated` (nothing trust-gated in the folder), `setting` (`defaultProjectTrust`), `prompted` (your answer), `session` (an earlier session-only answer or dismissal), `dismissed`, `inherited` (no one could be asked), and `unknown` (a record from before 0.2.0).
- **Completion.** A delegating child should join each child it starts with `delegate_ctl wait` before its final report. A child that settles after that report revives the delegating child, with the child's report in its context, the way an unjoined completion wakes the root parent. The revival is a new segment, so the root parent is woken again when it ends. A delegating child that was cancelled or stopped, or whose last segment timed out, is not revived this way, and neither is one whose revival is refused (another writer holds its `cwd`, say): its owner gets a `delegate late report` notice instead, naming the run, the reason, and the report.
- **Lifetime.** A delegating child's children are bound to its session. Explicit parent exit cancels/releases the whole tree; reload only rebinds it. Cancelling a delegating child, or its timeout, cancels its unsettled children, theirs too, and closes its session; a restart reopens it. Reopening restores each level when its session opens again. A delegating child keeps its session while any of its children runs or has a report not yet delivered, and while its children run it refuses a `steer` with a different `model`. Once they are idle its session is retired like any other finished child's, and a revival restores its children from their records.
- **Visibility.** The root parent's `status` lists only its own children. The Agents frame shows the whole tree: a child's own runs, pi and ACP, are indented under it, and you can open, steer and stop them there like your own children, by the same rules. They stay listed until your next prompt even after that child's session closes (retired, cancelled, or reopened on another model): their transcripts stay readable, and steering one first reopens the child that started it, so the run is live again in its own owner, then steers it. An ACP run is read, steered and stopped through that child's own ACP backend, as its own `delegate_ctl` would. Every nested run is also in the run log, with `depth` and `parentRunId`, and in the delegating child's transcript.
- **Limits.** A nested child cannot `delegate_ctl approve` a model default, because only the root parent talks to the user. Its own `todo` tool follows its role's allowlist and stores state in that child's session.

### MCP servers

A child starts no MCP server. For each MCP tool its parent has (`mcp__<server>__<tool>`), it gets a proxy of the same name that calls the parent's tool, looked up by name at call time, so a server that reconnected in the parent is reached through its new connection. A nested child's proxies call its parent's proxies, down to the root session's servers. The role's `tools` line limits the proxies like any other tool.

- **What the parent has.** A child gets the MCP tools its parent has when the child's session opens. A server the parent has not connected yet, or a tool hidden in the parent, gives the child nothing. A parent tool with `direct` exposure must be active in the parent to be called.
- **Lifetime.** The servers are the parent's and live as long as the parent's session. A child's call fails with an error when the parent no longer offers the tool.

## Backends

Ask in plain words. The agent turns the request into a `delegate` or `delegate_ctl` call. Each example shows a request and the call it becomes. `…` stands for text or IDs you supply.

### A Pi child

> "Have a scout map how sessions are stored. It does not need our conversation."

```json
{"role":"scout","task":"Map session storage\nOBJECTIVE …","context":"fresh"}
```

`backend` is omitted, so this runs on pi. `role` is a role name from `delegate_ctl roles`.

### A Pi child in oven

> "Have the scout check the README, in the background, outside this session."

```json
{"role":"scout","task":"Check the README\nOBJECTIVE …","runtime":"oven"}
```

`runtime: "oven"` runs the child as an [oven](https://github.com/ssweens/oven) slice instead of in this process; a role's `runtime: oven` line makes it that role's default, and the call's `runtime` overrides it, as `model` does. The slice gets the role's instructions, model, `extensions` and `tools` and a copy-on-write copy of `cwd`, releases execution after each finite segment and on explicit parent quit, and never receives the conversation. The run keeps this tool's surface: run ID, `status`, `result`, `wait`, `steer` (sent into the slice) and `cancel` (archives execution), the run log and the completion notice. pi-delegate does not depend on oven, and the default in-process runtime needs nothing. A `runtime: "oven"` child calls oven's MCP tools on an oven that is already running (launchd keeps it on): `oven_create` with the role's configuration, then `oven_watch` until the slice settles (called again if it drops), `oven_send` for a later segment or a steer, and `oven_archive` to release execution or cancel. Each create and send carries a `requestId` fixed for the run and segment, so a retry never starts a second slice or turn. It posts to `OVEN_URL`, else `http://127.0.0.1:6836` (or the `port` in oven's `oven.json`), at `/mcp`, with the local token oven keeps in `${XDG_CONFIG_HOME:-~/.config}/oven/token` (or `OVEN_TOKEN`). When nothing answers, the run fails with a message that names the URL and says to run `oven start` or use the tray app; it never starts oven. A slice oven couldn't make fails the run with oven's reason code (for example `cwd_missing` or `model_unavailable`). oven brings Pi's credentials in by itself.

Oven creates carry `owner: { client: "pi-delegate", session: "<parent Pi session ID>" }`. Durable children, TUI children, and Path tracking and rebuild slices use the actual parent ID, not the child’s native session. This is attribution only; it does not change expiry or control rights.

#### Execution release and resumable history

Finite Durable and TUI segments persist their captured result before calling `oven_archive`. Completion waits for confirmed archive; an RPC failure or uncertain reply reports release uncertainty rather than cleanup success. A steer waits for pending release before sending the next segment. Archived slices retain their exact mapping, conversation/native session, copied workspace, results and owner. They leave `oven list` but remain in `oven list --all`. Reading history or retrying an earlier request does not wake or replay work. Explicit send/steer resumes that same context without re-cloning the workspace.

Non-detached creates use `expires: {idle: "1h"}, expiryAction: "archive"`. Only active execution is renewed every ten minutes; completed/restored history is never heartbeated just because its parent remembers it. After a crash and transport disconnection, lease expiry releases execution without deleting history. A lease-ended active segment becomes `interrupted`, resumable by steer—not permanently `RUN_EXPIRED`. Missing/deleted history remains an error and never causes a replacement create. Explicit parent quit cancels/releases owned work immediately; reload only rebinds it. Detached Path watchers deliberately use `expires: "never"` instead.

Creates require an Oven that echoes the requested expiry and `expiryAction: "archive"`. An incompatible provider is refused by URL, with archive/stop requested without retiring history. No automatic cleanup deletes native sessions or copied workspaces. Hop and other clients keep their own lifecycle policies.

### A Pi, Claude or Amp TUI child in oven

> "Have Claude review the parser in its own terminal, on Haiku."

```json
{"role":"reviewer","task":"Review src/parser.ts\n…","tui":"claude","model":"haiku"}
```

`tui: "pi" | "claude" | "amp"` runs the child as that agent's own TUI, hosted by oven as a `tui` slice; a role's `tui:` line makes it that role's default, and the call's `tui` overrides it. It implies `runtime: "oven"` (with `runtime: "in-process"` the call fails `INPUT_INVALID`). The role becomes the agent's oven template: a Pi child gets the role's top-level `model`, `thinking`, `tools` and its `pi:` section; Claude and Amp get only their own `claude:` / `amp:` sections, because the top-level fields are Pi's. Every agent gets the role's description and `env`. A role's `secrets:` names environment variables of this session: their values go to oven with the create, which hands them to the agent through a private file (never an argv or a record); a declared secret this session lacks fails the run before oven is called. Claude and Pi take the instructions as a system prompt; Amp takes none, so they lead the first message. `model` is passed to oven as the agent's own model name, without Pi's model resolution. The first segment is `oven_create` in a copy-on-write copy of `cwd`, later segments and steers are `oven_send` (which wakes the same agent session), `cancel` archives execution, and each segment waits with `oven_watch` until the agent settles, reads the answer from the agent's own session with `oven_result`, persists it and archives the slice. The output names the slice, its copy and `oven attach <slice>`, which explicitly resumes its terminal. Archive stops the native process but retains its session and copy in `oven list --all`. A steer's `model` does not change a tui child's agent model: the agent keeps the one it was created with.

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

Omit `mode` to return when the first run settles; pass `mode: "all"` when every result is required. `runIds` can mix pi and acp runs. A timeout ends the wait only; the runs keep going.

### Status, cancel and close

```json
{"action":"status","runId":"amp-…"}
{"action":"cancel","runId":"codex-…"}
{"action":"close","runId":"amp-…"}
```

`status` with no `runId` lists the parent's agent and process runs. Close each ACP run when you are done with it. Close is final.

### Observing an opened Amp thread

On an opened Amp run, `delegate_ctl status` or `result` with `observe: true` (and one `runId`) reads the thread: one `amp threads export` per call, returning only the messages after the last ones it showed. A plain `status` never reads the thread. Nothing polls in the background. Turns this run sends stream live.

## Backend limits

- **Processes.** Commands have no agent, model, session, or writer lock. They run with the parent's OS authority and are not confined to cwd. Coordinate commands that write files with any agents using that directory. See [Background commands](#background-commands) for deadlines, output, stop, and ownership rules.
- **Authority.** On pi, `role` is a role name, and the role file sets its tools and instructions. On acp, `role` is `read-only` (the default) or `writer`, and ACPX permission policy enforces it. Some agents' own write tools can still reach outside `cwd`: see [ARCHITECTURE.md §4](docs/ARCHITECTURE.md#4-profiles-and-permissions). An opened session rejects `role` and `model` and keeps its native settings.
- **Identity.** Every run has a delegate run ID. An ACP run also has one provider request ID per turn and the provider's native session ID (`session.nativeSessionId`, such as an Amp `T-…`). The three are never interchangeable. A created session gets a worker contract appended to each prompt. An opened session gets your exact text, undecorated, and a turn sent to it is never retried.
- **Opening.** pi cannot open an existing session. On acp, opening needs an adapter that verifies native identity and can disconnect. Today the vendored Pi and Amp adapters do. Other agents fail `NATIVE_OPEN_UNSUPPORTED`.
- **Timeouts.** A `wait` timeout never cancels anything; the runs keep going. The `timeoutMs` on `delegate` or `steer` is the turn budget, which is different. On pi it aborts the child's segment. On a created ACP session it ends the turn as `timeout` (`TURN_TIMEOUT`) and the session becomes unusable: a later `steer` fails `RUN_UNUSABLE`; close the run and start a new one. On an opened session it only stops the local wait; the native turn keeps running.
- **Delivery.** Each ACP turn reports `delivery` and the provider outcome as separate fields. `delivery` is `accepted` only when the provider reports that the turn completed. Anything else (running, failed, cancelled, timed out, lost) is `unknown`. pi runs have no delivery field.
- **Cancellation.** On pi, `cancel` stops the child and turns off automatic revival. On acp, `cancel` sends ACP session cancel for the active turn this run started, with a grace period. It stops that turn, not the run, so you can steer again. The cancel result reports the cancelled turn; it does not also wake the parent. On an opened Amp thread, cancel acts only on a turn this run started; a turn someone else started is never cancelled. With no turn of this run active, cancel fails `WORKER_NOT_RUNNING`.
- **Steer.** On pi, steer queues into a running child or resumes a finished one. On acp, a running turn must finish or be cancelled first. `model` on steer is rejected on an opened session. `restart` is pi-only.
- **Close.** `close` is ACP-only; on pi it fails `ACTION_UNSUPPORTED`, so use `cancel`. Close refuses a run with an active turn unless `force: true`, which cancels the turn first. A created session is disposed; `discardPersistentState: true` also stops it from being resumable. An opened session is only disconnected. It is never cancelled, archived or deleted, and `discardPersistentState` fails `OPEN_OVERRIDE_FORBIDDEN`. Disconnecting an opened Pi session ends that local adapter process, so a turn still running there may stop with an unknown outcome.
- **Parent exit and restart.** pi children recover as [Reload and recovery](#reload-and-recovery) describes. ACP runs are *parked* when the parent exits: each session is released the way close releases it (a created one is closed but kept resumable, an opened one is disconnected), but the run is not closed. A turn still running at exit ends as `PARENT_PROCESS_LOST` with delivery `unknown`. After a restart, `status`, `result` and `wait` read the saved record without starting anything. `steer` revives the run: an opened run reopens the same native ID and checks its identity; a created run resumes only if its adapter supports ACP `session/resume` or `session/load`. Otherwise steer fails `RUN_NOT_RESUMABLE`. The record stays readable, so start a new run. A run that another live Pi process owns is read-only here (`RUN_OWNED_ELSEWHERE`).
- **Writers.** Each agent backend allows one writer per `cwd`, but pi and ACP check separately. Do not run a pi writer and an ACP writer in the same tree.

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

The ACP Coordinator still keeps its state under `~/.pi/agent/pi-strings/` (each Pi process in its own `proc/` subdirectory). That directory name did not change.

## Phased todos

The `todo` tool and `/todo` command are owned by pi-delegate. They provide OMP-style phased tasks with immutable state transitions, session/branch restoration, an above-editor widget, compact/expanded tool rendering, and `TODO.md` import/export.

Todo state writes use the `pi_delegate.todo` session-entry namespace. Each in-process Pi child stores its todos in its own session; existing `pi_omp.todo` entries are read-only migration input. Automatic reminders are disabled by default and apply only to the root parent. Enable them with `/delegate settings` → **Todo reminders** or set `{"todo":{"reminders":true}}` in `~/.pi/agent/pi-delegate.json`. Reminders are capped at two per session and suppressed on abort, while the assistant is asking a question, while a child will wake the parent, and when the unchanged todo state was already reminded. Unrelated tool results do not re-arm a reminder; a todo-state change does.

## Away recap

After settled work has been idle for five minutes by default, `/recap` summarizes the current work in the shared Activity widget. It requires three user turns and two new messages since the last recap, an empty draft, and no active or pending parent or delegate work.

The side call has an approximate 2,000-token input budget, including the prompt, with up to 500 tokens for a task anchor. It uses Path\'s standing only when its saved trail covers the latest user request. Otherwise it uses the latest compaction or branch summary, or the opening request when no summary exists. Path remains optional. The rest of the packet contains the newest complete user/assistant exchanges in chronological order. Only an oversized anchor or newest exchange is clipped. Tool traffic and previous recaps are excluded. Recent explicit user corrections take precedence over older task state. Without Path or a saved summary, the opening-request fallback cannot retain every older decision.

Returning to the terminal, new input or work, model changes, and session changes cancel generation. A changed snapshot cannot publish a stale recap. The displayed recap remains capped at 40 words. Use `/recap test`, `/recap on|off`, `/recap status`, `/recap debug`, or `/recap 30s`/`/recap 5m` to control it. `/recap test` bypasses the idle and message-count gates, but still requires settled work. `/delegate settings` persists the enabled state and idle threshold in `pi-delegate.json`.

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

Closing Pi or switching parent sessions explicitly cancels/releases active children. Reopening the same parent restores saved children without running them. After a crash, an unfinished child appears as `interrupted`; inspecting its transcript, reading its result, or waiting does not resume it. Inspect interrupted tool work before continuing: interruption does not undo side effects.

Send a message with `steer` to resume an inactive child under the same run ID and transcript. Revival uses the saved model, reasoning level, tool list, role instructions, project instructions, working directory, and timeout—not current role files or model defaults. Missing history is an error, not permission to start a replacement. Genuinely idle in-process children dispose their sessions and extension resources while retaining transcripts; a delegating child with unsettled descendants or pending reports stays bound. These children reopen from the same transcript on steer.

An unavailable or exhausted saved model is also an error, and the choice of replacement is yours: `{"action":"steer","runId":"<id>","message":"...","model":"provider/id[:thinking]"}` revives that child on the offering you name, keeping its ID, transcript, tools, and instructions. The new offering applies from that segment on and is persisted, so later revivals use it; earlier segments keep the model they actually ran on, and the omitted reasoning level stays as saved. A running child refuses the switch—its turn is already bound to its model, so wait or `cancel` first. The agent proposes the replacement in conversation before calling this; nothing substitutes an offering on its own.

A model spec naming a provider resolves to that provider only. `openai-codex/x` never falls back to `openrouter/x`: same weights on another route differ in cost, limits, and serving, so an unavailable one is reported, not silently swapped.

An explicit `cancel` remains stopped across reloads and process restarts. The agent must have your request before using `steer` with `restart: true`. Typing a message in a stopped child's **Restart** editor is your direct restart request.

Completed results and interrupted executions are separate states. On reopen, an undelivered result is reported without rerunning the child. Delivery receipts in the parent transcript prevent replay of results already recorded there. A receipt establishes delivery, not that the parent finished acting on it.

Each run carries its own owner (process id, host and a per-process token); there is no parent-level lease. Opening the same parent in another Pi process shows the runs a live process still owns read-only there, and adopts the runs of a process that has exited. Different parent sessions remain independent.

Recovery metadata is recorded for children launched by this version. Older transcript files remain readable but have no saved parent/runtime contract to revive.

A run record from before 0.2.0 has no saved trust decision. It is revived untrusted, whatever its folder's trust is now, and its status, result, completion and `steer` reply say `project trust unknown for this record; treated as untrusted`. This is a change: before 0.2.0, pi-delegate gave every child Pi's default, a trusted project. To give it trust, start a new child in that folder.

## Which offerings a child can use

A child runs on the parent's catalog, including providers that extensions register at runtime — account switchers, gateways, subscription pools. Those registrations are mirrored into the child runtime each time a child session opens, so launch order does not decide what a child can run, and a provider registered after the first child still works. A provider the parent drops stops serving children that have to reopen their session; a session already in memory keeps the model it was built with. Nothing about those providers is copied into a child's saved record beyond the `provider/id` it ran on, so credentials stay with the parent's runtime.

## Model approval

A `delegate` call resolves its model as `model:` param → approved default for the role → the role file's model list (first usable entry, see [Roles](#roles)) → your current model, and runs. There is no dialog: proposing a non-default model is a conversation — the agent states offering, price, tradeoff, rating, asks, and launches on your answer. `delegate_ctl action=approve role= model= message=` records a default in the `defaults` section of `~/.pi/agent/pi-delegate.json`; the skill forbids calling it without your explicit yes in the conversation. That section also snapshots the catalog so `models` can report drift and new offerings since approval.

## Activity overview

**Ctrl+Shift+J** opens the existing full-screen Path view on **F5 Activity**. **F1 Overview**, **F2 Trail/Map**, **F3 Status**, and **F4 Settings** retain their contents and controls. Activity lists all current Agents with status and depth, every Todo phase and task with states and blockers, Path's overview, and the full latest Recap for the current branch. Completed, abandoned, and empty phases remain visible. Returning clears the widget's Recap but retains it in Activity. **↑↓**, **PgUp/PgDn**, and **Home/End** scroll Activity. **Esc** or **Ctrl+Shift+J** closes Activity without changing your draft. `/path` opens the original Path Overview without F5.

## Watching children

One OMP-style **Agents** frame above the parent editor shows the delegation tree: running and stopping children, the children they started indented beneath them (`└`), and the runs that settled since your last prompt, dimmed with their outcome. Each row shows the task title, role, the child's provider and model, current tool (or outcome), and elapsed time. The header counts them: `Agents · 2 active · 1 done`. The model column is dropped when the terminal is too narrow for it. A row with no model, such as an opened ACP session, leaves its cell blank but keeps the column's width, so the rows stay aligned. Your next prompt clears the settled rows; when no rows remain, the frame disappears. Finished rows do not return on reload. Put a short title on the first line of the delegation brief; the UI displays it without generating a summary.

- **←** at the very start of the editor's draft (an empty draft, or the cursor before its first character, with no completion menu open) moves into the list. Anywhere else ← moves the cursor as usual.
- **↑↓** selects a row; **Home/End** and **PgUp/PgDn** navigate longer lists. The frame shows at most four rows, scrolling internally. Rows stay in tree order; selection stays on its child while that child is listed. If the last row leaves while the list has focus, focus returns to the parent editor.
- **→** or **Enter** opens the selected child's conversation across the whole viewport. The parent display is hidden, not repeated behind a floating inspector.
- In the child view, type a message and press **Enter**. Running children receive a queued steer; saved inactive children resume in the same session. A stopped child shows **Restart**. **PgUp/PgDn** scrolls the conversation; **Ctrl+End** follows the latest output; **Ctrl+X** stops that child. **Esc** returns to the list, so ↑↓ and → walk from one child to the next.
- **←** or **Esc** in the list returns to the parent editor without stopping anything. Parent and child drafts are separate; returning preserves the parent draft and list selection.
- **Ctrl+J** also toggles the list, or opens finished-child history when nothing is listed. Ctrl+J is one of Pi's default newline keys (`tui.input.newLine`: Shift+Enter, Ctrl+J), so this binding takes it over and Pi reports `Extension shortcut conflict: 'ctrl+j'` at startup. To keep the newline on other keys and silence the report, put `{ "tui.input.newLine": ["shift+enter"] }` in `~/.pi/agent/keybindings.json` and `/reload`.
- **`/agents`** opens an on-demand list of finished children, including failures, cancellations, and interrupted runs. Select a row with **↑↓**, then **Enter** to inspect it; **Esc** closes the list. History remains available while other children run. Removing a row from the pinned frame does not delete its session or prevent revival.

The child transcript uses Pi's own assistant/user message, built-in tool, and editor components—not a second text/JSON renderer. It opens at the newest output and follows streaming text and tool output. **PgUp** pauses following; **Ctrl+End** or paging back to the bottom resumes it. Tools start collapsed; Pi's **Ctrl+O** action expands/collapses them, and its thinking-toggle binding controls reasoning display. Markdown, code highlighting, errors, and tool results use the active Pi theme. Fullscreen mode also supports Pi's native click-to-expand tool results and mouse-wheel scrolling; regular mode leaves mouse handling to the terminal emulator. It does not launch a second writer against the child's session file. Opening a saved child reads its transcript without reviving it; sending a message revives it.

## Settings

**`/delegate settings`** (or plain `/delegate`) opens every pi-delegate setting, Path's included, in one list in place of the editor, below the conversation, not in an overlay. It is Pi's own settings list (the one behind Pi's `/settings`): type to search, and the selected row's help shows under the list. Each row shows its value and is marked **●** when it differs from the default. **Enter** cycles an on/off row, or opens a row's choices, each with a one-line description and its own help; Path's model and decision model open Pi's model selector. Choosing saves to the relevant section of `~/.pi/agent/pi-delegate.json` at once. **Esc** steps back. `/path settings` shows Path's rows alone.

**`/path`** opens Path's view: **F1** Overview, **F2** Trail (Map in the map modes), **F3** Status, **F4** Settings (the same panel as `/path settings`). Keys: **R** refresh (the one run you start), **O** Path on/off, **C** copy, **B** on F3 Status to rebuild the map (map modes only), **Esc** back. `/path on` and `/path off` turn Path on or off, `/path refresh` runs the refresh from the editor, and `/path settings` opens its settings alone. In trail mode Path is a watcher with its own memory of the session: it reads what the session adds when an assistant turn ends, or when you write (within `--path-user-window-ms`, default two minutes), and answers each batch with one model call; a refresh asks it to revise the trail in one more ([docs/trail.md](docs/trail.md)).

| Row | Choices | Default |
| --- | --- | --- |
| Mode | **Opportunistic**: delegate for context isolation, parallel work, or a model-tier switch. **Orchestrator**: the main session hands every task to children in the background and stays free to talk; the instruction is part of its `delegate` tool's description (so turns that a completion starts carry it too), and its own `edit` and `write` calls are refused with a reminder to delegate. Children are not told. **Off**: the main session's `delegate` and `delegate_ctl` are taken out of its active tools (recorded in the session, so a restart or `/tree` brings back exactly those when the mode changes again); runs already started still report. | Opportunistic |
| Max depth | 1–8 (see [Nested delegation](#nested-delegation)) | 3 |
| Max running | No limit, 2, 4, 8, 16, 32, 64: unsettled runs of both backends at once, across the whole tree. A start or revival over the limit fails with `CONCURRENCY_LIMIT`; nothing is queued, and the agent can `wait` for one to finish. | 16 |
| Model picking | **First scoped** or **First available**, for role model lists (see [Roles](#roles)) | First scoped |
| Roles | Each role's models, what it would run on now, and its file. Read only. | |
| Path | Path's own settings panel, as `/path settings` opens it. | |
| Todo reminders | **Off** or **On**. When on, send a bounded follow-up after a turn ends with open todo items. The todo tool, command and widget work either way. | Off |
| Restore defaults | Resets delegation and todo rows; Path's settings, approved defaults and ratings are kept. | |

The mode applies from the main session's next turn, the limits and model picking from the next `delegate` call. No reload is needed.

**`/delegate fork:<role> <task>`** and **`/delegate fresh:<role> <task>`** start a child yourself, with or without this conversation; the command completes role names. It runs through the same path as the `delegate` tool. Its report is shown in the transcript and is in context for the next turn, but it does not start a model turn, unless the model has since steered that child. A child reaches MCP tools through this session's tool context, which pi-delegate only has once the model has called `delegate` or `delegate_ctl` in this session; until then the command warns that the child has no MCP tools.

Completions reach the parent at once. An idle parent is woken; a busy one, however long its run, reads the report at its next model request inside that run, as a steer, instead of only after the run ends. A `delegate_ctl wait` returns early while a report is on its way in. If you stop the run (Esc), Pi clears its queued messages; a report that had not reached the conversation yet is recorded then, shown and in context for your next prompt, without starting a turn.

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

Async launches have no duplicate status card or dispatch frame in the conversation. Each completed run segment produces one compact line: status glyph, task title, role, and elapsed time. Non-success statuses and unavailable-tool warnings stay visible on that line. **Ctrl+O** expands the full report, error, model, changed files, and session path. Joined waits render their outcome directly rather than adding a completion message. Control-tool queries remain ordinary transcript records, not live dashboards.

## Run log

`~/.pi/agent/delegate-runs.jsonl` — one line per run: id, role, model, thinking, context, cwd, **task text**, status, tokens, cost, duration, changed files, dropped tools, error, first 2 KB of output. A run also records its `depth`, and a run that a delegating child started records that child's run ID as `parentRunId`. Child transcripts persist in the working directory the child ran in: `<cwd>/.agents/pi/subsessions/` — `tail -f` one to watch a child live. The full path is in every run-log row (`sessionFile`) and in the expanded outcome record. Each child also has an atomic JSON snapshot of its identity, runtime inputs, stop state, and result. Parent indexes and ownership leases live in the parent's working directory under `.agents/pi/subsessions/owners/`. ACP run records (identity, native session, turns with request IDs, delivery and output) are saved next to them under `owners/<parent>/acp/`. The directory gets a self-ignoring `.gitignore` (`*`) on creation, so transcripts never reach `git status` or a child's `git add -A`; it is scoped to that directory, so a repo can still track `.agents/` for agent definitions.

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

`check:install` packs the local candidate, installs its dependencies in an isolated extracted directory, runs the real `pi install`, and checks all tools, packaged roles, and the delegation skill. Pi links local directories without installing dependencies. Run `npm install` in the local checkout first. This repository does not publish packages to npm.

`smoke:tui` runs actual Pi and actual built-in tools with the loopback provider in a private tmux server. It checks native tool disclosure, streaming/follow vs paused scrolling, narrow resize, separate drafts, history, same-ID revival, and finished-frame removal. It prints the temporary evidence directory containing text/ANSI terminal captures, traces, and sessions; it stops only its own tmux server. Parent model wake-up is disabled in this UI fixture and verified separately by lifecycle tests.

For independent review, give the reviewer these runnable commands and the affected contract. They execute the relevant checks rather than accepting an implementer's pass banner. Scope mutation to changed semantics and changed assertions; report survivors/timeouts/uncovered sites separately. No arbitrary score threshold, new role pipeline, or mandatory UI/install run on every edit.

## Not included, on purpose

Missions, lanes, watchdogs, acceptance protocols, preflight/supersession records, councils, schedules, intercom, worktree management. Use a brief, a slash command, or `bash` (`git worktree add`) — none of it belongs in a schema the model reads on every turn.
